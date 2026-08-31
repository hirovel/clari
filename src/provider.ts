import type { StopReason, ToolCall, Usage } from "./events.js";
import type { Message } from "./messages.js";

/** 工具的对外描述(执行器在 tools.ts,D2)。parameters 是 JSON Schema。 */
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
};

export type CompleteOptions = {
  /** 流式增量只进 UI 不进日志(Q12):增量拼完即最终消息,日志只记完整事件。 */
  onDelta?: (textDelta: string) => void;
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
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
};

/** SSE 流的累积状态。做成纯数据 + 纯函数,流解析不碰网络即可测试。 */
export type StreamAcc = {
  text: string;
  toolCalls: { id: string; name: string; argsJson: string }[];
  finishReason?: string;
  usage?: Usage;
};

export function newAcc(): StreamAcc {
  return { text: "", toolCalls: [] };
}

/** 喂入一个已解析的 SSE chunk(data: 后面的 JSON 对象)。返回本 chunk 的文本增量。 */
export function feedChunk(acc: StreamAcc, chunk: SseChunk): string {
  const choice = chunk.choices?.[0];
  let delta = "";
  if (choice?.delta?.content) {
    delta = choice.delta.content;
    acc.text += delta;
  }
  for (const tc of choice?.delta?.tool_calls ?? []) {
    acc.toolCalls[tc.index] ??= { id: "", name: "", argsJson: "" };
    const slot = acc.toolCalls[tc.index] as StreamAcc["toolCalls"][number];
    if (tc.id) slot.id = tc.id;
    if (tc.function?.name) slot.name += tc.function.name;
    if (tc.function?.arguments) slot.argsJson += tc.function.arguments;
  }
  if (choice?.finish_reason) acc.finishReason = choice.finish_reason;
  if (chunk.usage) {
    acc.usage = {
      inputTokens: chunk.usage.prompt_tokens ?? 0,
      outputTokens: chunk.usage.completion_tokens ?? 0,
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
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { __unparsed: s };
  }
}

function toWire(m: Message): Record<string, unknown> {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      return { role: "user", content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
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

export function openaiCompat(opts: { baseUrl: string; apiKey: string; model: string }): Provider {
  return {
    model: opts.model,
    async complete(messages, tools, { onDelta, signal } = {}) {
      const body = {
        model: opts.model,
        messages: messages.map(toWire),
        ...(tools.length > 0 && {
          tools: tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }),
        stream: true,
        stream_options: { include_usage: true },
      };

      const acc = newAcc();
      try {
        const res = await fetch(`${opts.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${opts.apiKey}`,
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
            const data = line.replace(/^data: ?/, "").trim();
            if (!data || !line.startsWith("data:") || data === "[DONE]") continue;
            const delta = feedChunk(acc, JSON.parse(data) as SseChunk);
            if (delta && onDelta) onDelta(delta);
          }
        }
        return finishAcc(acc, false);
      } catch (err) {
        // 打断(Q11):已流出的部分作为 aborted turn 返回,由循环记入日志,不丢真相。
        if (signal?.aborted) return finishAcc(acc, true);
        throw err;
      }
    },
  };
}
