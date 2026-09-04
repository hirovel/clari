import type { StopReason, ToolCall, Usage } from "./events.js";
import type { Message } from "./messages.js";
import { ProviderError, parseRetryAfter } from "./providers/errors.js";
import { type RetryOptions, withRetry } from "./providers/retry.js";
import { StreamStall, sseEvents } from "./providers/sse.js";

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
  /** 供应商返回的、不解释的元数据(响应 id、服务模型、原始停止原因等)。只给人看。 */
  extras?: Record<string, unknown>;
  /** thinking 模型的推理内容(可读文本);带工具的多轮里 DeepSeek 要求原样回传。 */
  reasoning?: string;
  /** reasoning 是模型读回去的全文,还是只给人看的摘要(正文在 opaque 里)。 */
  reasoningKind?: "full" | "summary";
  /**
   * 适配器私有回传物(Q53):必须在下一轮原样送回、内核不解释的东西。
   * Anthropic 是带签名的 thinking 块;适配器写、同一适配器读,内核只搬运。
   */
  opaque?: unknown;
};

// ---------- 强度级别(Q52) ----------

/** 统一级别。缺省不传:请求里不出现任何强度参数,各家用自己的默认。 */
export const EFFORT_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** 解析用户输入的级别名;minimal 是 OpenAI 遗留写法,归为 low。 */
export function parseEffort(s: string): EffortLevel | undefined {
  if (s === "minimal") return "low";
  return (EFFORT_LEVELS as readonly string[]).includes(s) ? (s as EffortLevel) : undefined;
}

/**
 * 模型声明了支持集合时,不支持的级别向下回退到最近的支持项;没有更低的就取最低。
 * 回退结果进入请求正文,检视器的线路分区能看到;调用方负责提示用户。
 */
export function clampEffort(level: EffortLevel, supported?: readonly EffortLevel[]): EffortLevel {
  if (!supported || supported.length === 0 || supported.includes(level)) return level;
  const idx = EFFORT_LEVELS.indexOf(level);
  for (let i = idx - 1; i >= 0; i--) {
    const l = EFFORT_LEVELS[i];
    if (l && supported.includes(l)) return l;
  }
  const lowest = [...supported].sort(
    (a, b) => EFFORT_LEVELS.indexOf(a) - EFFORT_LEVELS.indexOf(b),
  )[0];
  return lowest ?? level;
}

export type WireOptions = { effort?: EffortLevel };

export type CompleteOptions = {
  /** 流式增量只进 UI 不进日志(Q12):增量拼完即最终消息,日志只记完整事件。 */
  onDelta?: (textDelta: string) => void;
  onReasoning?: (reasoningDelta: string) => void;
  signal?: AbortSignal;
  /** 每次重试前回调(循环据此记 retry 事件)。 */
  onRetry?: (info: { attempt: number; delayMs: number; error: Error }) => void;
  /** 收到的每一行原始流(SSE 行,未解析)。透明度的最底层:开了 trace 就一字不漏。 */
  onRaw?: (line: string) => void;
  /** 本次请求的强度级别;缺省不传。 */
  effort?: EffortLevel;
};

/**
 * 字段清单:这个适配器往请求里放哪些字段、从响应里读哪些、明知存在但不读哪些。
 * 静态数据,与代码同步维护;界面 /fields 与文档都从这里取,不另写一份。
 */
export type FieldTable = {
  protocol: string;
  sends: string[];
  reads: string[];
  ignores: string[];
};

export interface Provider {
  readonly model: string;
  /** 字段清单(可选但建议实现):让"到底发了什么、读了什么"一条命令可查。 */
  readonly fields?: FieldTable;
  complete(messages: Message[], tools: ToolDef[], opts?: CompleteOptions): Promise<AssistantTurn>;
  /**
   * 给定消息与工具,返回将要发出的请求正文(不含鉴权头)。纯函数,与 complete 实际发送的逐字节一致。
   * 检视器用它把"模型到底收到了什么"展示到 wire 层;不实现的 provider 只能看到内核层的消息投影。
   */
  wire?(messages: Message[], tools: ToolDef[], opts?: WireOptions): unknown;
  /**
   * 投影下标 → 线路正文里的下标(Q81):第 i 条消息落在 wire 消息数组的第几条;-1 = 不在数组里(如抽到顶层的 system)。
   * Anthropic 合并连续工具结果、Responses 把一条助手消息拆成几项,组装视图据此标每条"落在哪"。
   */
  wireMap?(messages: Message[]): number[];
  /** 向供应商查询当前可用的模型名(GET /models)。发现模型下线与新模型靠这个,不靠猜(Q59)。 */
  listModels?(): Promise<string[]>;
}

/** 把 CompleteOptions 里的 onRetry 并进适配器自己的重试配置,两边都收到通知。 */
export function mergeRetry(
  base: RetryOptions | undefined,
  opts: Pick<CompleteOptions, "signal" | "onRetry">,
): RetryOptions {
  const onRetry: RetryOptions["onRetry"] = (info) => {
    base?.onRetry?.(info);
    opts.onRetry?.(info);
  };
  return { ...base, onRetry, ...(opts.signal && { signal: opts.signal }) };
}

/** 所有适配器共用的 GET /models:返回 data[].id。 */
export async function fetchModelIds(
  url: string,
  headers: Record<string, string>,
): Promise<string[]> {
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new ProviderError(`provider ${res.status}: ${await res.text()}`, { status: res.status });
  }
  const body = (await res.json()) as { data?: { id?: string }[] };
  return (body.data ?? [])
    .map((m) => m.id)
    .filter((id): id is string => typeof id === "string")
    .sort();
}

// ---------- OpenAI-compatible 适配器(Q4b:先接一家,DeepSeek 走此协议) ----------

/** 同一协议下的方言差异只体现在强度参数上(Q52)。 */
export type OpenAIDialect = "openai" | "deepseek";

/**
 * 强度 → 请求字段。openai:reasoning_effort 逐字直传,off 发 none。
 * deepseek:thinking 开关 + reasoning_effort 三档(low/high/max),medium 与 xhigh 按官方定义映射为 high。
 */
export function openaiEffortParams(
  level: EffortLevel | undefined,
  dialect: OpenAIDialect,
): Record<string, unknown> {
  if (level === undefined) return {};
  if (dialect === "deepseek") {
    if (level === "off") return { thinking: { type: "disabled" } };
    const mapped = level === "medium" || level === "xhigh" ? "high" : level;
    return { thinking: { type: "enabled" }, reasoning_effort: mapped };
  }
  return { reasoning_effort: level === "off" ? "none" : level };
}

/** OpenAI 兼容协议流式 chunk 的最小类型。只声明用到的字段,未声明的一律不读。 */
export type SseChunk = {
  id?: string;
  model?: string;
  system_fingerprint?: string | null;
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: {
        index?: number;
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
  /** 不解释的响应元数据(Q82)。 */
  extras: Record<string, unknown>;
};

export function newAcc(): StreamAcc {
  return { text: "", reasoning: "", toolCalls: [], extras: {} };
}

/** 喂入一个已解析的 SSE chunk(data: 后面的 JSON 对象)。返回本 chunk 的文本增量。 */
export function feedChunk(acc: StreamAcc, chunk: SseChunk): string {
  const choice = chunk.choices?.[0];
  let delta = "";
  // 元数据每个 chunk 都带,记一次即可;finish_reason 原文另存,内核归一后的 stopReason 是另一回事。
  if (chunk.id && acc.extras.id === undefined) acc.extras.id = chunk.id;
  if (chunk.model && acc.extras.model === undefined) acc.extras.model = chunk.model;
  if (chunk.system_fingerprint && acc.extras.system_fingerprint === undefined)
    acc.extras.system_fingerprint = chunk.system_fingerprint;
  if (choice?.finish_reason) acc.extras.finish_reason = choice.finish_reason;
  if (choice?.delta?.content) {
    delta = choice.delta.content;
    acc.text += delta;
  }
  if (choice?.delta?.reasoning_content) acc.reasoning += choice.delta.reasoning_content;
  for (const tc of choice?.delta?.tool_calls ?? []) {
    // 有些中转站不带 index(整段一次发完):带 id 的当新调用,不带的续写最后一个。
    const index =
      typeof tc.index === "number"
        ? tc.index
        : tc.id
          ? acc.toolCalls.length
          : Math.max(0, acc.toolCalls.length - 1);
    acc.toolCalls[index] ??= { id: "", name: "", argsJson: "" };
    const slot = acc.toolCalls[index] as StreamAcc["toolCalls"][number];
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
    // reasoning_content 是模型下一轮真正读回去的全文,不是摘要。
    ...(acc.reasoning && { reasoning: acc.reasoning, reasoningKind: "full" as const }),
    ...(Object.keys(acc.extras).length > 0 && { extras: acc.extras }),
  };
}

export const OPENAI_COMPAT_FIELDS: FieldTable = {
  protocol: "openai(chat completions)",
  sends: [
    "model · stream: true · stream_options.include_usage: true",
    "messages[].role / content(投影)",
    "messages[].reasoning_content:配置 reasoningField 时每条助手消息都带,取自事件 reasoning;没有就发空串",
    "messages[].tool_calls[{id, type: function, function{name, arguments}}]",
    "role: tool 的 tool_call_id + content",
    "tools[{type: function, function{name, description, parameters}}]",
    "reasoning_effort(openai 方言;off → none)/ thinking{type} + reasoning_effort(deepseek 方言)",
    "max_completion_tokens(openai 方言)/ max_tokens(其余):配置了 maxTokens 才发",
    "extraBody 里的任何键,逐字合并",
  ],
  reads: [
    "choices[0].delta.content → text",
    "choices[0].delta.reasoning_content → reasoning(全文,可编辑)",
    "choices[0].delta.tool_calls[{index, id, function{name, arguments}}] → toolCalls",
    "choices[0].finish_reason → stopReason(length → 截断)",
    "usage.prompt_tokens / completion_tokens → inputTokens / outputTokens",
    "usage.prompt_cache_hit_tokens 或 prompt_tokens_details.cached_tokens → cacheReadTokens",
    "usage.completion_tokens_details.reasoning_tokens → reasoningTokens",
    "id · model · system_fingerprint · finish_reason 原文 → extras(不解释,原样存)",
  ],
  ignores: [
    "choices[].delta.refusal、logprobs、created",
    "GPT 在此协议上不返回任何推理内容,只有 reasoning_tokens 一个数字;要看推理摘要用 openai-responses 协议",
  ],
};

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

export type OpenAICompatOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningField?: string;
  retry?: RetryOptions;
  dialect?: OpenAIDialect;
  /** 该模型支持的强度级别;请求了不支持的就向下回退。 */
  effortLevels?: EffortLevel[];
  /** 逐字合并进请求正文的字段(Q59 透传):API 新参数不必等代码。 */
  extraBody?: Record<string, unknown>;
  /** 附加请求头(如 beta 头)。 */
  extraHeaders?: Record<string, string>;
  /** 流停滞判定:连续这么久没有字节就断开重试;0 = 不限。缺省 90 秒。 */
  stallTimeoutMs?: number;
  /** 输出 token 上限;缺省不传,用服务端默认。openai 方言发 max_completion_tokens,其余发 max_tokens。 */
  maxTokens?: number;
};

/**
 * 请求级中止控制:用户的 signal 之外,停滞超时也要能撤销底层 fetch。
 * 返回的 signal 给 fetch;abort() 只由停滞调用,不会被误判成用户打断(调用方看的仍是用户的 signal)。
 */
export function linkedAbort(signal?: AbortSignal): AbortController {
  const ac = new AbortController();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  return ac;
}

/** 停滞发生在已经吐字之后就不能重试(会重复输出);之前可以。 */
export function stallToError(err: unknown, streamed: boolean): unknown {
  if (err instanceof StreamStall && streamed) {
    return new ProviderError(err.message, { retryable: false });
  }
  return err;
}

export function openaiCompat(opts: OpenAICompatOptions): Provider {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const dialect = opts.dialect ?? "openai";
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${opts.apiKey}`,
    ...opts.extraHeaders,
  };
  const wire = (messages: Message[], tools: ToolDef[], w: WireOptions = {}) => ({
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
    ...(opts.maxTokens !== undefined &&
      (dialect === "openai"
        ? { max_completion_tokens: opts.maxTokens }
        : { max_tokens: opts.maxTokens })),
    ...openaiEffortParams(w.effort && clampEffort(w.effort, opts.effortLevels), dialect),
    ...opts.extraBody,
  });
  return {
    model: opts.model,
    fields: OPENAI_COMPAT_FIELDS,
    wire,
    // chat completions 一条投影消息就是一条 wire 消息,顺序不变。
    wireMap: (messages) => messages.map((_, i) => i),
    listModels: () => fetchModelIds(`${baseUrl}/models`, headers),
    async complete(messages, tools, { onDelta, onReasoning, signal, onRetry, onRaw, effort } = {}) {
      const body = wire(messages, tools, effort ? { effort } : {});

      return withRetry(
        async () => {
          const acc = newAcc();
          const ac = linkedAbort(signal);
          try {
            const res = await fetch(`${baseUrl}/chat/completions`, {
              method: "POST",
              headers,
              body: JSON.stringify(body),
              signal: ac.signal,
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

            const events = sseEvents(res.body as AsyncIterable<Uint8Array>, {
              ...(onRaw && { onRaw }),
              ...(opts.stallTimeoutMs !== undefined && { stallTimeoutMs: opts.stallTimeoutMs }),
              onStall: () => ac.abort(),
            });
            for await (const chunk of events) {
              const before = acc.reasoning.length;
              const delta = feedChunk(acc, chunk as SseChunk);
              if (delta && onDelta) onDelta(delta);
              if (onReasoning && acc.reasoning.length > before) {
                onReasoning(acc.reasoning.slice(before));
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
            throw stallToError(err, Boolean(acc.text || acc.reasoning));
          }
        },
        mergeRetry(opts.retry, { ...(signal && { signal }), ...(onRetry && { onRetry }) }),
      );
    },
  };
}
