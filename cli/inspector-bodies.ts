// 正文列表只拥有当前视图的选择与展开状态;记录读取、输入编辑、模型执行都不归它。
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Message } from "../src/messages.js";
import { unchangedPrefix } from "./cards.js";
import { firstLine, fmtMs, messageTokens, pctOf, roleLabel } from "./inspector-format.js";
import {
  messageBodyLines,
  type PromptSectionMeta,
  type RequestRecord,
} from "./inspector-requests.js";
import type { RecordedBody, RequestRecording } from "./session-records.js";
import { c } from "./theme.js";

export type BodyBlock = {
  divider?: string;
  id: string;
  title: string;
  meta: string;
  preview: string;
  lines: () => string[];
  version: unknown;
};

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

function wrapBodyLine(line: string, width: number): string[] {
  // 超长 ASCII 原文按列切片,避免逐字分词;Unicode/ANSI 继续使用终端的宽度规则。
  if (line.length > 4096 && /^[\x20-\x7e]+$/.test(line)) {
    const lines: string[] = [];
    for (let i = 0; i < line.length; i += width) lines.push(line.slice(i, i + width));
    return lines;
  }
  return wrapTextWithAnsi(line, width);
}

export function inputBlocks(
  messages: Message[],
  sections?: PromptSectionMeta[],
  previous?: Message[],
): BodyBlock[] {
  const total = messages.reduce((n, m) => n + messageTokens(m), 0);
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
    meta: `~${messageTokens(message)} text tok · ${pctOf(messageTokens(message), total)}${message.role === "user" && message.images?.length ? ` · ${message.images.length} image(s), tokens unestimated` : ""}${previous ? (i < keep ? " · unchanged prefix" : " · after prefix") : ""}${message.edited ? " · edited" : ""}`,
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
  if (rec.error)
    blocks.push(
      textBlock("error", `Request failed · HTTP ${rec.error.status ?? "unknown"}`, rec.error.error),
    );
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
    for (const call of reply.toolCalls)
      blocks.push(
        textBlock(
          `call-${call.id}`,
          `Call · ${call.name}`,
          JSON.stringify(call.args, null, 2),
          call.id,
        ),
      );
  }
  for (const [i, output] of (saved?.outputs ?? []).entries()) {
    blocks.push(
      recordedBlock(
        `original-${i}`,
        `${output.name} · original output`,
        output.body,
        output.original,
        `${output.source} · ${output.state}`,
      ),
    );
    blocks.push(
      textBlock(
        `model-${i}`,
        `${output.name} · model result`,
        output.model,
        "available to later requests",
      ),
    );
  }
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

export class BodyBrowser {
  private key = "";
  private selected = 0;
  private expanded = new Set<string>();
  private blocks: BodyBlock[] = [];
  private reveal = true;
  private formatted = new Map<string, { version: unknown; width: number; lines: string[] }>();

  set(key: string, blocks: BodyBlock[]): void {
    const selectedId = this.blocks[this.selected]?.id;
    if (key === this.key && selectedId) {
      const next = blocks.findIndex((block) => block.id === selectedId);
      if (next >= 0 && next !== this.selected) {
        this.selected = next;
        this.reveal = true;
      }
    }
    if (key !== this.key) {
      this.key = key;
      this.selected = 0;
      this.expanded.clear();
      this.formatted.clear();
      this.reveal = true;
    }
    this.blocks = blocks;
    this.selected = Math.max(0, Math.min(this.selected, blocks.length - 1));
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, Key.up)) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, Key.down))
      this.selected = Math.min(this.blocks.length - 1, this.selected + 1);
    else if (matchesKey(data, Key.home)) this.selected = 0;
    else if (matchesKey(data, Key.end)) this.selected = Math.max(0, this.blocks.length - 1);
    else if (matchesKey(data, Key.enter)) {
      const item = this.blocks[this.selected];
      if (item) {
        if (this.expanded.has(item.id)) this.expanded.delete(item.id);
        else this.expanded.add(item.id);
      }
    } else return false;
    this.reveal = true;
    return true;
  }

  render(width: number): {
    lines: string[];
    focus?: number;
    action: string;
    position: string;
    selected: string;
  } {
    const lines: string[] = [];
    let focus = 0;
    for (const [i, block] of this.blocks.entries()) {
      const selected = i === this.selected;
      const open = this.expanded.has(block.id);
      if (selected) focus = lines.length;
      if (block.divider)
        lines.push(c.faint(truncateToWidth(`── ${block.divider} ${"─".repeat(width)}`, width, "")));
      const title = `${selected ? "›" : " "} [${open ? "−" : "+"}] ${block.title}`;
      lines.push(
        selected
          ? c.jin(c.bold(truncateToWidth(title, width, "…")))
          : c.ink(truncateToWidth(title, width, "…")),
      );
      lines.push(c.soft(truncateToWidth(`    ${block.meta}`, width, "…")));
      if (open) {
        let cached = this.formatted.get(block.id);
        if (!cached || cached.version !== block.version || cached.width !== width) {
          cached = {
            version: block.version,
            width,
            lines: block
              .lines()
              .flatMap((line) => wrapBodyLine(line, Math.max(1, width - 4)).map((l) => `    ${l}`)),
          };
          this.formatted.set(block.id, cached);
        }
        for (const line of cached.lines) lines.push(line);
      } else lines.push(c.faint(truncateToWidth(`    ${block.preview || "(empty)"}`, width, "…")));
      lines.push("");
    }
    const reveal = this.reveal;
    this.reveal = false;
    return {
      lines,
      ...(reveal && { focus }),
      action: this.expanded.has(this.blocks[this.selected]?.id ?? "") ? "collapse" : "expand",
      position: `${this.blocks.length ? this.selected + 1 : 0}/${this.blocks.length} blocks`,
      selected: this.blocks[this.selected]?.title ?? "No block selected",
    };
  }
}
