// Anthropic Messages API 适配器:第二个 provider,同时是对内部消息抽象(Q4)的验证。
// 与 OpenAI 兼容适配器的差异全部封在这里:工具结果是 user 消息里的内容块、system 是顶层字段、
// 流式事件按内容块下标分发。内核其余部分一行不改。
import type { StopReason, ToolCall, Usage } from "../events.js";
import type { Message } from "../messages.js";
import type { AssistantTurn, Provider, ToolDef } from "../provider.js";

/** 流式事件的最小类型,只声明用到的字段。 */
export type AnthropicEvent =
  | { type: "message_start"; message: { usage?: { input_tokens?: number } } }
  | {
      type: "content_block_start";
      index: number;
      content_block:
        | { type: "text" }
        | { type: "tool_use"; id: string; name: string }
        | { type: string };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason?: string | null };
      usage?: { output_tokens?: number };
    }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };

export type AnthropicAcc = {
  text: string;
  blocks: Map<number, { id: string; name: string; argsJson: string }>;
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
};

export function newAnthropicAcc(): AnthropicAcc {
  return { text: "", blocks: new Map() };
}

/** 喂入一个已解析的事件,返回本事件的文本增量。纯函数,不碰网络。 */
export function feedAnthropicEvent(acc: AnthropicAcc, ev: AnthropicEvent): string {
  switch (ev.type) {
    case "message_start": {
      const input = ev.message.usage?.input_tokens;
      if (input !== undefined) acc.inputTokens = input;
      return "";
    }
    case "content_block_start":
      if (ev.content_block.type === "tool_use") {
        const b = ev.content_block as { id: string; name: string };
        acc.blocks.set(ev.index, { id: b.id, name: b.name, argsJson: "" });
      }
      return "";
    case "content_block_delta": {
      const d = ev.delta;
      if (d.type === "text_delta") {
        const text = (d as { text: string }).text;
        acc.text += text;
        return text;
      }
      if (d.type === "input_json_delta") {
        const slot = acc.blocks.get(ev.index);
        if (slot) slot.argsJson += (d as { partial_json: string }).partial_json;
      }
      return "";
    }
    case "message_delta":
      if (ev.delta.stop_reason) acc.stopReason = ev.delta.stop_reason;
      if (ev.usage?.output_tokens !== undefined) acc.outputTokens = ev.usage.output_tokens;
      return "";
    case "error":
      acc.error = `${ev.error.type}: ${ev.error.message}`;
      return "";
    default:
      return "";
  }
}

export function finishAnthropicAcc(acc: AnthropicAcc, aborted: boolean): AssistantTurn {
  const toolCalls: ToolCall[] = [...acc.blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, b]) => ({ id: b.id, name: b.name, args: safeParse(b.argsJson) }));
  const stopReason: StopReason = aborted
    ? "aborted"
    : acc.stopReason === "max_tokens"
      ? "length"
      : toolCalls.length > 0
        ? "tool"
        : "end";
  const usage: Usage | undefined =
    acc.inputTokens !== undefined || acc.outputTokens !== undefined
      ? { inputTokens: acc.inputTokens ?? 0, outputTokens: acc.outputTokens ?? 0 }
      : undefined;
  return {
    text: acc.text,
    toolCalls: aborted ? [] : toolCalls,
    stopReason,
    ...(usage && { usage }),
  };
}

function safeParse(s: string): unknown {
  if (!s.trim()) return {};
  try {
    return JSON.parse(s);
  } catch {
    return { __unparsed: s };
  }
}

type WireBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/**
 * 内部消息 → Anthropic wire。两处结构差异:system 抽到顶层;连续的工具结果合并进同一条 user 消息
 * (协议要求紧随 assistant 的那条 user 消息包含其全部 tool_use 的应答)。
 */
export function toAnthropicWire(messages: Message[]): {
  system: string | undefined;
  messages: { role: "user" | "assistant"; content: WireBlock[] }[];
} {
  let system: string | undefined;
  const out: { role: "user" | "assistant"; content: WireBlock[] }[] = [];
  for (const m of messages) {
    switch (m.role) {
      case "system":
        system = system ? `${system}\n\n${m.content}` : m.content;
        break;
      case "user":
        out.push({ role: "user", content: [{ type: "text", text: m.content || "(空)" }] });
        break;
      case "assistant": {
        const content: WireBlock[] = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls) {
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
        }
        if (content.length === 0) content.push({ type: "text", text: "(空)" });
        out.push({ role: "assistant", content });
        break;
      }
      case "tool": {
        const block: WireBlock = {
          type: "tool_result",
          tool_use_id: m.callId,
          content: m.content,
          ...(m.isError && { is_error: true }),
        };
        const last = out.at(-1);
        if (last?.role === "user" && last.content.every((b) => b.type === "tool_result")) {
          last.content.push(block);
        } else {
          out.push({ role: "user", content: [block] });
        }
        break;
      }
    }
  }
  return { system, messages: out };
}

export function anthropic(opts: {
  baseUrl?: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
}): Provider {
  const baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  return {
    model: opts.model,
    async complete(messages: Message[], tools: ToolDef[], { onDelta, signal } = {}) {
      const wire = toAnthropicWire(messages);
      const body = {
        model: opts.model,
        max_tokens: opts.maxTokens ?? 8192,
        ...(wire.system && { system: wire.system }),
        messages: wire.messages,
        ...(tools.length > 0 && {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          })),
        }),
        stream: true,
      };

      const acc = newAnthropicAcc();
      try {
        const res = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
          signal: signal ?? null,
        });
        if (!res.ok || !res.body) {
          throw new Error(`provider ${res.status}: ${await res.text()}`);
        }
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const bytes of res.body) {
          buffer += decoder.decode(bytes as Uint8Array, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data) continue;
            const delta = feedAnthropicEvent(acc, JSON.parse(data) as AnthropicEvent);
            if (delta && onDelta) onDelta(delta);
          }
        }
        if (acc.error) throw new Error(`provider stream error: ${acc.error}`);
        return finishAnthropicAcc(acc, false);
      } catch (err) {
        if (signal?.aborted) return finishAnthropicAcc(acc, true);
        throw err;
      }
    },
  };
}
