// Anthropic Messages API 适配器:第二个 provider,同时是对内部消息抽象(Q4)的验证。
// 与 OpenAI 兼容适配器的差异全部封在这里:工具结果是 user 消息里的内容块、system 是顶层字段、
// 流式事件按内容块下标分发、thinking 块带签名必须原样回传(Q53)。内核其余部分一行不改。
import type { StopReason, ToolCall, Usage } from "../events.js";
import type { Message } from "../messages.js";
import {
  type AssistantTurn,
  clampEffort,
  type EffortLevel,
  fetchModelIds,
  mergeRetry,
  type Provider,
  type ToolDef,
  type WireOptions,
} from "../provider.js";
import { ProviderError, parseRetryAfter } from "./errors.js";
import { type RetryOptions, withRetry } from "./retry.js";

/** 流式事件的最小类型,只声明用到的字段。 */
export type AnthropicEvent =
  | {
      type: "message_start";
      message: {
        usage?: {
          input_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
        };
      };
    }
  | {
      type: "content_block_start";
      index: number;
      content_block:
        | { type: "text" }
        | { type: "tool_use"; id: string; name: string }
        | { type: "thinking" }
        | { type: "redacted_thinking"; data: string }
        | { type: string };
    }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "signature_delta"; signature: string }
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

/** 模型的思考块,签名绑定前缀,回传时一字不能改。 */
export type ThinkingBlock =
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

/** 存进 assistant/message.opaque 的形态。带模型名:签名跨模型无效,换模型后丢弃。 */
export type AnthropicOpaque = {
  kind: "anthropic-thinking";
  model: string;
  blocks: ThinkingBlock[];
};

export function isAnthropicOpaque(x: unknown): x is AnthropicOpaque {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { kind?: unknown }).kind === "anthropic-thinking" &&
    Array.isArray((x as { blocks?: unknown }).blocks)
  );
}

export type AnthropicAcc = {
  text: string;
  blocks: Map<number, { id: string; name: string; argsJson: string }>;
  thinking: Map<number, ThinkingBlock>;
  stopReason?: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  error?: string;
};

export function newAnthropicAcc(): AnthropicAcc {
  return { text: "", blocks: new Map(), thinking: new Map() };
}

/** 已累积的思考文本(给人看的那份)。 */
export function thinkingText(acc: AnthropicAcc): string {
  return [...acc.thinking.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, b]) => (b.type === "thinking" ? b.thinking : ""))
    .join("");
}

/** 喂入一个已解析的事件,返回本事件的文本增量。纯函数,不碰网络。 */
export function feedAnthropicEvent(acc: AnthropicAcc, ev: AnthropicEvent): string {
  switch (ev.type) {
    case "message_start": {
      // Anthropic 的 input_tokens 不含缓存部分;占用窗口的是三者之和。
      const u = ev.message.usage;
      if (
        u &&
        (u.input_tokens ?? u.cache_read_input_tokens ?? u.cache_creation_input_tokens) !== undefined
      ) {
        acc.inputTokens =
          (u.input_tokens ?? 0) +
          (u.cache_creation_input_tokens ?? 0) +
          (u.cache_read_input_tokens ?? 0);
        if (u.cache_read_input_tokens !== undefined)
          acc.cacheReadTokens = u.cache_read_input_tokens;
      }
      return "";
    }
    case "content_block_start": {
      const b = ev.content_block;
      if (b.type === "tool_use") {
        const t = b as { id: string; name: string };
        acc.blocks.set(ev.index, { id: t.id, name: t.name, argsJson: "" });
      } else if (b.type === "thinking") {
        acc.thinking.set(ev.index, { type: "thinking", thinking: "", signature: "" });
      } else if (b.type === "redacted_thinking") {
        acc.thinking.set(ev.index, {
          type: "redacted_thinking",
          data: (b as { data: string }).data,
        });
      }
      return "";
    }
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
      if (d.type === "thinking_delta" || d.type === "signature_delta") {
        const slot = acc.thinking.get(ev.index);
        if (slot?.type === "thinking") {
          if (d.type === "thinking_delta") slot.thinking += (d as { thinking: string }).thinking;
          else slot.signature = (d as { signature: string }).signature;
        }
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

export function finishAnthropicAcc(acc: AnthropicAcc, aborted: boolean, model = ""): AssistantTurn {
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
      ? {
          inputTokens: acc.inputTokens ?? 0,
          outputTokens: acc.outputTokens ?? 0,
          ...(acc.cacheReadTokens !== undefined && { cacheReadTokens: acc.cacheReadTokens }),
        }
      : undefined;
  const reasoning = thinkingText(acc);
  // 打断的半截思考块没有签名,回传必 400,只留可读文本。
  const blocks = aborted
    ? []
    : [...acc.thinking.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
  return {
    text: acc.text,
    toolCalls: aborted ? [] : toolCalls,
    stopReason,
    ...(usage && { usage }),
    ...(reasoning && { reasoning }),
    ...(blocks.length > 0 && {
      opaque: { kind: "anthropic-thinking", model, blocks } satisfies AnthropicOpaque,
    }),
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
  | ThinkingBlock
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

/**
 * 内部消息 → Anthropic wire。结构差异:system 抽到顶层;连续的工具结果合并进同一条 user 消息
 * (协议要求紧随 assistant 的那条 user 消息包含其全部 tool_use 的应答);
 * assistant 的 thinking 块放在内容之首原样回传,只回传同一模型产生的(签名跨模型无效)。
 */
export function toAnthropicWire(
  messages: Message[],
  opts: { model?: string } = {},
): {
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
        if (isAnthropicOpaque(m.opaque) && (!opts.model || m.opaque.model === opts.model)) {
          content.push(...m.opaque.blocks);
        }
        if (m.content) content.push({ type: "text", text: m.content });
        for (const tc of m.toolCalls) {
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
        }
        if (!m.content && m.toolCalls.length === 0) content.push({ type: "text", text: "(空)" });
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

/** adaptive:4.7+ 与 5 系,effort 直传;budget:4.6 及更早,按级别给 budget_tokens。 */
export type ThinkingMode = "adaptive" | "budget";

const BUDGETS: Record<Exclude<EffortLevel, "off">, number> = {
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32000,
  max: 32000,
};

/** 强度 → 请求字段(Q52)。缺省不传;off 发 disabled(不可关的模型会 400,由用户配置 effortLevels 排除 off)。 */
export function anthropicEffortParams(
  level: EffortLevel | undefined,
  mode: ThinkingMode,
  maxTokens: number,
): Record<string, unknown> {
  if (level === undefined) return {};
  if (level === "off") return { thinking: { type: "disabled" } };
  if (mode === "budget") {
    // budget_tokens 须 ≥ 1024 且 < max_tokens。
    const budget = Math.max(1024, Math.min(BUDGETS[level], maxTokens - 1));
    return { thinking: { type: "enabled", budget_tokens: budget } };
  }
  return { thinking: { type: "adaptive" }, output_config: { effort: level } };
}

export type AnthropicOptions = {
  baseUrl?: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  retry?: RetryOptions;
  thinkingMode?: ThinkingMode;
  effortLevels?: EffortLevel[];
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
};

export function anthropic(opts: AnthropicOptions): Provider {
  const baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const maxTokens = opts.maxTokens ?? 8192;
  const headers = {
    "content-type": "application/json",
    "x-api-key": opts.apiKey,
    "anthropic-version": "2023-06-01",
    ...opts.extraHeaders,
  };
  const wire = (messages: Message[], tools: ToolDef[], w: WireOptions = {}) => {
    const body = toAnthropicWire(messages, { model: opts.model });
    return {
      model: opts.model,
      max_tokens: maxTokens,
      ...(body.system && { system: body.system }),
      messages: body.messages,
      ...(tools.length > 0 && {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters,
        })),
      }),
      stream: true,
      ...anthropicEffortParams(
        w.effort && clampEffort(w.effort, opts.effortLevels),
        opts.thinkingMode ?? "adaptive",
        maxTokens,
      ),
      ...opts.extraBody,
    };
  };
  return {
    model: opts.model,
    wire,
    listModels: () => fetchModelIds(`${baseUrl}/v1/models`, headers),
    async complete(
      messages: Message[],
      tools: ToolDef[],
      { onDelta, onReasoning, signal, onRetry, onRaw, effort } = {},
    ) {
      const body = wire(messages, tools, effort ? { effort } : {});

      return withRetry(
        async () => {
          const acc = newAnthropicAcc();
          try {
            const res = await fetch(`${baseUrl}/v1/messages`, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: signal ?? null,
            });
            if (!res.ok || !res.body) {
              const text = await res.text();
              const retryAfterMs = parseRetryAfter(res.headers);
              throw new ProviderError(`provider ${res.status}: ${text}`, {
                status: res.status,
                body: text,
                ...(retryAfterMs !== undefined && { retryAfterMs }),
              });
            }
            const decoder = new TextDecoder();
            let buffer = "";
            for await (const bytes of res.body) {
              buffer += decoder.decode(bytes as Uint8Array, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop() ?? "";
              for (const line of lines) {
                if (onRaw && line.trim()) onRaw(line);
                if (!line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (!data) continue;
                const before = thinkingText(acc).length;
                const delta = feedAnthropicEvent(acc, JSON.parse(data) as AnthropicEvent);
                if (delta && onDelta) onDelta(delta);
                if (onReasoning) {
                  const now = thinkingText(acc);
                  if (now.length > before) onReasoning(now.slice(before));
                }
              }
            }
            if (acc.error) {
              // HTTP 200 之后流内报错(如 overloaded_error):尚未吐字时可重试。
              throw new ProviderError(`provider stream error: ${acc.error}`, {
                retryable: !acc.text && /overloaded|api_error|rate_limit/i.test(acc.error),
                body: acc.error,
              });
            }
            if (!acc.stopReason) {
              throw new ProviderError("stream ended without message_delta", {
                retryable: !acc.text,
              });
            }
            return finishAnthropicAcc(acc, false, opts.model);
          } catch (err) {
            if (signal?.aborted) return finishAnthropicAcc(acc, true, opts.model);
            throw err;
          }
        },
        mergeRetry(opts.retry, { ...(signal && { signal }), ...(onRetry && { onRetry }) }),
      );
    },
  };
}
