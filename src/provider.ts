import type { StopReason, ToolCall, Usage } from "./events.js";
import type { Message } from "./messages.js";
import { ProviderError, parseRetryAfter } from "./providers/errors.js";
import { type RetryOptions, withRetry } from "./providers/retry.js";

/** 工具的对外描述(执行器在 tools.ts)。parameters 是 JSON Schema。 */
export type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type AssistantTurn = {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage?: Usage;
  /** thinking 模型的推理内容;带工具的多轮里 DeepSeek 要求原样回传。 */
  reasoning?: string;
};

export type CompleteOptions = {
  /** 流式增量只进 UI 不进日志(Q12):增量拼完即最终消息,日志只记完整事件。 */
  onDelta?: (textDelta: string) => void;
  onReasoning?: (reasoningDelta: string) => void;
  signal?: AbortSignal;
};

export interface Provider {
  readonly model: string;
  complete(messages: Message[], tools: ToolDef[], opts?: CompleteOptions): Promise<AssistantTurn>;
}

// ---------- OpenAI-compatible 适配器(Q4b:先接一家,DeepSeek 走此协议) ----------

/** OpenAI 兼容协议流式 chunk 的最小类型。只声明用到的字段,未声明的一律不读。 */
export type SseChunk = {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** DeepSeek 的缓存命中字段。 */
    prompt_cache_hit_tokens?: number;
    /** OpenAI 的缓存命中字段。 */
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
};

/** SSE 流的累积状态。做成纯数据 + 纯函数,流解析不碰网络即可测试。 */
export type StreamAcc = {
  text: string;
  reasoning: string;
  toolCalls: { id: string; name: string; argsJson: string }[];
  finishReason?: string;
  usage?: Usage;
};

export function newAcc(): StreamAcc {
  return { text: "", reasoning: "", toolCalls: [] };
}

/** 喂入一个已解析的 SSE chunk(data: 后面的 JSON 对象)。返回本 chunk 的文本增量。 */
export function feedChunk(acc: StreamAcc, chunk: SseChunk): string {
  const choice = chunk.choices?.[0];
  let delta = "";
  if (choice?.delta?.content) {
    delta = choice.delta.content;
    acc.text += delta;
  }
  if (choice?.delta?.reasoning_content) acc.reasoning += choice.delta.reasoning_content;
  for (const tc of choice?.delta?.tool_calls ?? []) {
    acc.toolCalls[tc.index] ??= { id: "", name: "", argsJson: "" };
    const slot = acc.toolCalls[tc.index] as StreamAcc["toolCalls"][number];
    if (tc.id) slot.id = tc.id;
    if (tc.function?.name) slot.name += tc.function.name;
    if (tc.function?.arguments) slot.argsJson += tc.function.arguments;
  }
  if (choice?.finish_reason) acc.finishReason = choice.finish_reason;
  if (chunk.usage) {
    const u = chunk.usage;
    // prompt_tokens 含缓存命中部分,直接作为"占用窗口的输入";缓存命中单列供展示。
    const cacheRead = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens;
    const reasoning = u.completion_tokens_details?.reasoning_tokens;
    acc.usage = {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      ...(cacheRead !== undefined && { cacheReadTokens: cacheRead }),
      ...(reasoning !== undefined && { reasoningTokens: reasoning }),
    };
  }
  return delta;
}

export function finishAcc(acc: StreamAcc, aborted: boolean): AssistantTurn {
  const toolCalls: ToolCall[] = acc.toolCalls.map((tc) => ({
    id: tc.id,
    name: tc.name,
    // 参数 JSON 解析失败不在这里报错:原样透传,让工具层校验并回喂模型(Q9)。
    args: safeParse(tc.argsJson),
  }));
  // length(Q26):调用保留在 turn 里 —— 循环需要逐个补错误应答,但绝不执行。
  const stopReason: StopReason = aborted
    ? "aborted"
    : acc.finishReason === "length"
      ? "length"
      : toolCalls.length > 0
        ? "tool"
        : "end";
  return {
    text: acc.text,
    toolCalls: aborted ? [] : toolCalls,
    stopReason,
    ...(acc.usage && { usage: acc.usage }),
    ...(acc.reasoning && { reasoning: acc.reasoning }),
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { __unparsed: s };
  }
}

/**
 * 内部消息 → OpenAI wire。reasoningField 给了(如 DeepSeek 的 reasoning_content)就在每条
 * assistant 消息上带出推理内容 —— 该家带工具的多轮要求每条都有,缺失即 400。
 */
export function toWire(m: Message, reasoningField?: string): Record<string, unknown> {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      return { role: "user", content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        ...(reasoningField && { [reasoningField]: m.reasoning ?? "" }),
        ...(m.toolCalls.length > 0 && {
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        }),
      };
    case "tool":
      return { role: "tool", tool_call_id: m.callId, content: m.content };
  }
}

export function openaiCompat(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningField?: string;
  retry?: RetryOptions;
}): Provider {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  return {
    model: opts.model,
    async complete(messages, tools, { onDelta, onReasoning, signal } = {}) {
      const body = {
        model: opts.model,
        messages: messages.map((m) => toWire(m, opts.reasoningField)),
        ...(tools.length > 0 && {
          tools: tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }),
        stream: true,
        stream_options: { include_usage: true },
      };

      return withRetry(
        async () => {
          const acc = newAcc();
          try {
            const res = await fetch(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${opts.apiKey}`,
              },
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
                const data = line.replace(/^data: ?/, "").trim();
                if (!data || !line.startsWith("data:") || data === "[DONE]") continue;
                const before = acc.reasoning.length;
                const delta = feedChunk(acc, JSON.parse(data) as SseChunk);
                if (delta && onDelta) onDelta(delta);
                if (onReasoning && acc.reasoning.length > before) {
                  onReasoning(acc.reasoning.slice(before));
                }
              }
            }
            if (!acc.finishReason) {
              // 没收到终止事件就结束 = 流被截断;尚未向 UI 吐字时可重试,吐过字就不能(会重复)。
              throw new ProviderError("stream ended without finish_reason", {
                retryable: !acc.text && !acc.reasoning,
              });
            }
            return finishAcc(acc, false);
          } catch (err) {
            // 打断(Q11):已流出的部分作为 aborted turn 返回,由循环记入日志,不丢真相。
            if (signal?.aborted) return finishAcc(acc, true);
            throw err;
          }
        },
        { ...opts.retry, ...(signal && { signal }) },
      );
    },
  };
}
