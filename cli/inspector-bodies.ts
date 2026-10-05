// 请求正文格式器:将输入、响应和已读取的证据转成内容块;选择与展开归正文浏览模块。
import type { Message } from "../src/messages.js";
import type { BodyBlock } from "./body-browser.js";
import { unchangedPrefix } from "./cards.js";
import { firstLine, fmtMs, messageTokens, pctOf, roleLabel } from "./inspector-format.js";
import {
  messageBodyLines,
  type PromptSectionMeta,
  type RequestRecord,
} from "./inspector-requests.js";
import type { RecordedBody, RequestRecording } from "./session-records.js";

function visible(text: string): string {
  return text.replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 原文控制字符是数据,不能交给终端执行。
    /[\u0000-\u0008\u000b-\u001f\u007f]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function textBlock(id: string, title: string, text: string, meta = ""): BodyBlock {
  let preview = firstLine(visible(text.slice(0, 512)));
  if (text.length < 4096 && (text.startsWith("{") || text.startsWith("["))) {
    try {
      preview = visible(JSON.stringify(JSON.parse(text)));
    } catch {
      /* 不是 JSON 时保留实际首行。 */
    }
  }
  return {
    id,
    title,
    meta: `${text.length} chars${meta ? ` · ${meta}` : ""}`,
    preview,
    version: text,
    lines: () => visible(text).split("\n"),
  };
}

export function recordingErrorBlock(error: string): BodyBlock {
  return textBlock("recording-error", "Recording unavailable or damaged", error);
}

function recordedBlock(
  id: string,
  title: string,
  body: RecordedBody | undefined,
  text: string,
  meta: string,
): BodyBlock {
  if (!body) return textBlock(id, title, text, meta);
  return {
    id,
    title,
    meta: `${body.bytes === undefined ? "streaming bytes" : `${body.bytes} bytes`} · ${meta}`,
    preview: "Enter to read captured body",
    version: body,
    lines: () => visible(body.read()).split("\n"),
  };
}

export function inputBlocks(
  messages: Message[],
  sections?: PromptSectionMeta[],
  previous?: Message[],
): BodyBlock[] {
  const tokens = messages.map(messageTokens);
  const total = tokens.reduce((n, size) => n + size, 0);
  const keep = unchangedPrefix(previous, messages);
  return messages.map((message, i) => ({
    ...(i === 0 && {
      divider: previous
        ? keep > 0
          ? "Same message prefix"
          : "Changed input from here"
        : "First input",
    }),
    ...(previous &&
      keep > 0 &&
      i === keep && {
        divider: keep === previous.length ? "Added since previous input" : "Changed tail from here",
      }),
    id: `message-${i}`,
    version: message,
    title: `${i + 1}. ${roleLabel(message)}`,
    meta: `~${tokens[i]} text tok · ${pctOf(tokens[i] as number, total)}${message.role === "user" && message.images?.length ? ` · ${message.images.length} image(s), tokens unestimated` : ""}${previous ? (i < keep ? " · unchanged prefix" : " · after prefix") : ""}${message.edited ? " · edited" : ""}`,
    preview:
      firstLine(visible(message.content.slice(0, 512))) ||
      (message.role === "assistant" ? `${message.toolCalls.length} tool calls` : "(empty)"),
    // 共用消息格式器,不再维护另一套思考、opaque、工具参数的正文格式。
    lines: () =>
      messageBodyLines(
        {
          ...message,
          content: visible(message.content),
          ...(message.role === "assistant" &&
            message.reasoning && { reasoning: visible(message.reasoning) }),
        },
        false,
        sections,
      ),
  }));
}

export function receivedBlocks(rec: RequestRecord, saved?: RequestRecording): BodyBlock[] {
  const blocks: BodyBlock[] = [];
  if (rec.error) {
    const detail = rec.error.status !== undefined ? `HTTP ${rec.error.status}` : rec.error.kind;
    blocks.push(
      textBlock("error", `Request failed${detail ? ` · ${detail}` : ""}`, rec.error.error),
    );
  }
  if (rec.compaction)
    blocks.push(
      textBlock(
        "summary",
        "Compaction summary",
        rec.compaction.summary ?? "(none)",
        "available to later requests",
      ),
    );
  const reply = rec.response;
  if (reply) {
    if (reply.text || !reply.toolCalls.length)
      blocks.push(
        textBlock(
          "reply",
          "Reply",
          reply.text || "(empty)",
          `${reply.stopReason} · ${fmtMs(reply.latencyMs)}`,
        ),
      );
  }
  // 模型结果来自事件;附件仅补充原始输出,没有附件不能隐藏拒绝或校验错误。
  const outputs = new Map((saved?.outputs ?? []).map((output) => [output.callId, output]));
  const results = new Map(rec.results.map((result) => [result.callId, result]));
  const addOriginal = (
    output: NonNullable<RequestRecording["outputs"]>[number],
    group?: BodyBlock["group"],
  ) => {
    blocks.push({
      ...recordedBlock(
        `original-${output.callId}`,
        group ? "Original output" : `${output.name} · original output`,
        output.body,
        output.original,
        `${output.source} · ${output.state}`,
      ),
      ...(group && { group }),
    });
  };
  const addEvidence = (callId: string, group?: BodyBlock["group"]) => {
    const output = outputs.get(callId);
    if (output) {
      addOriginal(output, group);
      outputs.delete(callId);
    }
    const result = results.get(callId);
    if (!result) return;
    const outcome =
      result.outcome === "unknown" ? "outcome unknown" : result.isError ? "error" : "success";
    blocks.push({
      ...textBlock(
        `model-${result.callId}`,
        `${group ? "Result for model" : `${result.name} · model result`} · ${outcome}`,
        result.content,
        `${result.callId} · ${outcome} · available to later requests`,
      ),
      ...(group && { group }),
    });
    results.delete(callId);
  };
  for (const call of reply?.toolCalls ?? []) {
    const args =
      call.args && typeof call.args === "object"
        ? (call.args as Record<string, unknown>)
        : undefined;
    const target =
      typeof args?.path === "string"
        ? args.path
        : typeof args?.command === "string"
          ? args.command
          : "";
    // 摘要只保留末两段目录,完整路径和命令仍在展开的参数原文中。
    const displayTarget =
      typeof args?.path === "string"
        ? args.path
            .split(/[\\/]/)
            .slice(-2)
            .join(args.path.includes("\\") ? "\\" : "/")
        : target;
    const group = {
      id: call.id,
      title: firstLine(visible(`${call.name}${displayTarget ? ` · ${displayTarget}` : ""}`)),
      ...(typeof args?.path === "string" && {
        compactTitle: firstLine(visible(`${call.name} · ${args.path.split(/[\\/]/).at(-1)}`)),
      }),
    };
    const block = textBlock(
      `call-${call.id}`,
      "Arguments",
      JSON.stringify(call.args, null, 2),
      call.id,
    );
    // 缺失说明先于规模和调用ID,窄屏截短也不能把它隐藏。
    if (!results.has(call.id)) block.meta = `result not recorded · ${block.meta}`;
    blocks.push({
      ...block,
      group,
      preview: Object.keys(args ?? {}).join(" · ") || "(no arguments)",
    });
    addEvidence(call.id, group);
  }
  // 记录不完整时仍显示未匹配证据,不因缺少对应调用而删掉结果。
  for (const callId of results.keys()) addEvidence(callId);
  for (const output of outputs.values()) addOriginal(output);
  for (const attempt of saved?.attempts ?? [])
    blocks.push(
      recordedBlock(
        `http-${attempt.n}`,
        `HTTP attempt ${attempt.n} · ${attempt.status ?? "no response"}`,
        attempt.body,
        attempt.response,
        `capture ${attempt.state}`,
      ),
    );
  const usage = reply?.usage ?? rec.compaction?.usage;
  if (usage)
    blocks.push(
      textBlock(
        "usage",
        "Usage · reported by provider",
        JSON.stringify(usage, null, 2),
        `${usage.inputTokens} input · ${usage.outputTokens} output tokens`,
      ),
    );
  if (!saved?.attempts?.length)
    blocks.push(
      textBlock(
        "capture-unavailable",
        "No HTTP response captured",
        "No saved HTTP response is available for this request. Parsed events are not the original HTTP body.",
      ),
    );
  if (reply?.reasoning)
    blocks.push(
      textBlock(
        "reasoning",
        reply.reasoningKind === "summary" ? "Thinking summary · display only" : "Thinking text",
        reply.reasoning,
      ),
    );
  if (reply?.opaque !== undefined)
    blocks.push(
      textBlock(
        "opaque",
        "Provider state · retained for adapter",
        JSON.stringify(reply.opaque, null, 2),
      ),
    );
  if (reply?.extras && Object.keys(reply.extras).length)
    blocks.push(textBlock("metadata", "Provider metadata", JSON.stringify(reply.extras, null, 2)));
  if (saved?.error) blocks.unshift(recordingErrorBlock(saved.error));
  return blocks;
}
