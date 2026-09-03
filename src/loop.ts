import {
  type CompactionStrategy,
  contextTokens,
  estimateAfter,
  type PreservationPolicy,
} from "./compaction.js";
import { type AgentEvent, now, type ToolCall } from "./events.js";
import type { EventLog } from "./log.js";
import { deriveMessages, type Message } from "./messages.js";
import type { AssistantTurn, EffortLevel, Provider, ToolDef } from "./provider.js";
import { isContextOverflow, ProviderError } from "./providers/errors.js";
import { type Tool, validateArgs } from "./tools.js";

// ---------- 策略槽(Q27:全部是开放接口,内置实现无特权,自定义实现从外部注入) ----------

/** 终止策略(Q8):每个 step 结束后询问。返回 null 继续,返回字符串 = 停下的理由。 */
export type TerminationPolicy = (state: { steps: number }) => string | null;

/** pi 立场:不设上限,循环转到模型不再调工具为止。 */
export const untilIdle: TerminationPolicy = () => null;

/** Anthropic 立场:步数保底。 */
export function maxSteps(limit: number): TerminationPolicy {
  return ({ steps }) => (steps >= limit ? `已达步数上限 ${limit}` : null);
}

/** 插话策略(Q20):在给定边界要不要排空留言队列。 */
export type SteeringPolicy = (boundary: "step" | "turn") => boolean;

/** Claude Code / pi 谱系:步边界即注入(默认)。 */
export const steer: SteeringPolicy = () => true;

/** Codex 谱系:只在 turn 结束时投递。 */
export const queueToTurnEnd: SteeringPolicy = (boundary) => boundary === "turn";

/** 审批策略(Q23):执行每个工具调用前询问。false = 拒绝,以错误结果回喂。 */
export type ApprovePolicy = (call: ToolCall) => boolean | Promise<boolean>;

/** pi 立场:不弹确认,要隔离就跑容器(默认)。 */
export const allowAll: ApprovePolicy = () => true;

/**
 * 执行策略(Q10):sequential = 一批调用逐个跑(默认,行为最可预测);
 * parallel = 声明了并行安全的相邻调用同时跑(只读工具批量读取时省时间),其余仍逐个。
 * 结果按调用顺序落盘,两种策略下模型看到的序列一致。
 */
export type ExecutionPolicy = "sequential" | "parallel";

// ---------- runTurn(Q22 的纯函数层;Q13:换循环形态 = 用同一批原语另写一个函数) ----------

export type TurnOutcome = "idle" | "aborted" | { stopped: string };

export type TurnDeps = {
  log: EventLog;
  provider: Provider;
  tools: Tool[];
  slots?: {
    termination?: TerminationPolicy;
    steering?: SteeringPolicy;
    approve?: ApprovePolicy;
    execution?: ExecutionPolicy;
  };
  /** 排空留言队列,返回待注入的用户消息。注入时点由 steering 决定(Q20);边界告诉队列该放哪些。 */
  drainQueue?: (boundary: "step" | "turn") => string[];
  signal?: AbortSignal;
  onDelta?: (textDelta: string) => void;
  onReasoning?: (reasoningDelta: string) => void;
  /** 原始流逐行回调(trace)。不进日志:体量大且可由 provider 重放,由 CLI 决定是否写旁路文件。 */
  onRaw?: (line: string) => void;
  /** 强度级别(Q52)。给函数则每次请求前取值,会话中切换下一请求即生效。缺省不传。 */
  effort?: EffortLevel | (() => EffortLevel | undefined);
  /** 压缩配置(Q33):给了就启用自动触发与溢出恢复。 */
  compaction?: CompactionConfig;
};

export type CompactionConfig = {
  strategy: CompactionStrategy;
  window: number;
  /**
   * 阈值 = window − reserveTokens(绝对余量制)。
   * 余量的用途:装下一次模型输出 + 摘要调用的开销,不随窗口变大而变大。
   */
  reserveTokens?: number;
  preservation?: PreservationPolicy;
  auto?: boolean;
  /** 识别 provider 的上下文溢出错误。默认按常见错误文案匹配。 */
  isOverflow?: (err: Error) => boolean;
};

const DEFAULT_RESERVE = 32000;

const defaultIsOverflow = (err: Error): boolean => isContextOverflow(err);

/**
 * 给策略用的 provider 包装:策略每发一次模型请求,日志里就多一条 reason 为 compaction 的 request
 * (以及其间的 retry / request/error)。摘要请求把整段上下文发给了模型,和正常步一样必须可见(Q48)。
 * 响应不是 assistant/message —— 它不进投影;随后的 compaction 事件就是它的结果。
 */
export function recordingProvider(
  log: EventLog,
  provider: Provider,
  opts: { threshold?: number; onRaw?: (line: string) => void } = {},
): Provider {
  return {
    model: provider.model,
    ...(provider.wire && { wire: provider.wire.bind(provider) }),
    async complete(messages, tools, callOpts = {}) {
      log.append({
        type: "request",
        at: now(),
        model: provider.model,
        messages: messages.length,
        tools: tools.map((t) => t.name),
        estimatedTokens: contextTokens(log.events),
        ...(opts.threshold !== undefined && { threshold: opts.threshold }),
        reason: "compaction",
        body: describeRequestBody(log.events, messages),
      });
      try {
        return await provider.complete(messages, tools, {
          ...callOpts,
          ...(opts.onRaw && { onRaw: opts.onRaw }),
          onRetry: (info) => {
            callOpts.onRetry?.(info);
            logRetry(log, info);
          },
        });
      } catch (err) {
        logRequestError(log, err);
        throw err;
      }
    },
  };
}

/** 达到阈值时运行策略并落盘压缩事件。返回是否取得实际进展。 */
async function compactIfNeeded(
  deps: TurnDeps,
  cfg: CompactionConfig,
  force: boolean,
): Promise<boolean> {
  const threshold = cfg.window - (cfg.reserveTokens ?? DEFAULT_RESERVE);
  // 触发用实测优先的口径;进展门两边都用估算,口径一致才可比。
  if (!force && contextTokens(deps.log.events) <= threshold) return false;
  const before = estimateAfter(deps.log.events);
  const payload = await cfg.strategy({
    events: deps.log.events,
    window: cfg.window,
    targetTokens: threshold,
    provider: recordingProvider(deps.log, deps.provider, {
      threshold,
      ...(deps.onRaw && { onRaw: deps.onRaw }),
    }),
    ...(cfg.preservation && { preservation: cfg.preservation }),
    ...(deps.signal && { signal: deps.signal }),
  });
  if (!payload) return false;
  // 进展门:压缩必须真的变小,否则不落盘也不许重试。
  if (estimateAfter(deps.log.events, payload) >= before) return false;
  deps.log.append({ type: "compaction", at: now(), ...payload });
  return true;
}

const LENGTH_NOTICE = "未执行:响应被输出 token 上限截断,参数可能不完整。请重新发起这次工具调用。";

/**
 * 跑一个 turn:从当前日志出发,循环 step 直到无事可欠(模型不调工具且队列为空)、
 * 被打断、或终止策略叫停。所有状态变化都以事件落盘,函数本身不持有状态。
 */
export async function runTurn(deps: TurnDeps): Promise<TurnOutcome> {
  const { log, provider, tools, signal, onDelta, onReasoning } = deps;
  const termination = deps.slots?.termination ?? untilIdle;
  const steering = deps.slots?.steering ?? steer;
  const approve = deps.slots?.approve ?? allowAll;
  const execution = deps.slots?.execution ?? "sequential";
  const drainQueue = deps.drainQueue ?? (() => []);
  const defs: ToolDef[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  let steps = 0;

  let overflowRecovered = false;
  while (true) {
    // 自动压缩检查(Q33):每次模型请求前,占用超阈值即压。
    if (deps.compaction && deps.compaction.auto !== false) {
      await compactIfNeeded(deps, deps.compaction, false);
    }

    // 请求事件(Q48):正文不落盘,它就是此刻的投影;记下规模与口径,检视器按需原样重建。
    const messages = deriveMessages(log.events);
    const cfg = deps.compaction;
    const effort = typeof deps.effort === "function" ? deps.effort() : deps.effort;
    log.append({
      type: "request",
      at: now(),
      model: provider.model,
      messages: messages.length,
      tools: defs.map((d) => d.name),
      estimatedTokens: contextTokens(log.events),
      ...(cfg && { threshold: cfg.window - (cfg.reserveTokens ?? DEFAULT_RESERVE) }),
      reason: overflowRecovered ? "overflow-retry" : "turn",
      ...(effort && { effort }),
    });
    const startedAt = Date.now();

    let turn: AssistantTurn;
    try {
      turn = await provider.complete(messages, defs, {
        ...(onDelta && { onDelta }),
        ...(onReasoning && { onReasoning }),
        ...(signal && { signal }),
        ...(deps.onRaw && { onRaw: deps.onRaw }),
        ...(effort && { effort }),
        onRetry: (info) => logRetry(log, info),
      });
    } catch (err) {
      logRequestError(log, err);
      // 溢出恢复(Q33):压缩取得进展才许重试,且只重试一次。
      const overflow = cfg && (cfg.isOverflow ?? defaultIsOverflow)(err as Error);
      if (!overflow || overflowRecovered) throw err;
      overflowRecovered = true;
      const progressed = await compactIfNeeded(deps, cfg, true);
      if (!progressed) throw err;
      continue;
    }
    log.append({
      type: "assistant/message",
      at: now(),
      ...turn,
      latencyMs: Date.now() - startedAt,
    });
    steps += 1;

    if (turn.stopReason === "aborted") return "aborted";

    if (turn.stopReason === "length") {
      // Q26:截断响应的调用一个都不执行,逐个补错误应答(协议要求每个 call 有应答)。
      for (const call of turn.toolCalls) appendResult(log, call, LENGTH_NOTICE, true);
    } else if (turn.stopReason === "tool") {
      await executeCalls(turn.toolCalls, {
        log,
        tools,
        approve,
        execution,
        ...(signal && { signal }),
      });
      if (signal?.aborted) return "aborted";
    }

    // step 边界。审批等待发生在上面的执行阶段,此处才排队列 —— 留言永不落进确认窗口(Q20 硬规矩)。
    let injected = steering("step") ? inject(log, "step", drainQueue("step")) : 0;

    if (turn.stopReason === "end") {
      if (injected === 0 && steering("turn")) injected = inject(log, "turn", drainQueue("turn"));
      if (injected === 0) return "idle"; // 无事可欠,turn 结束
    }

    const reason = termination({ steps });
    if (reason !== null) {
      log.append({ type: "decision", at: now(), slot: "termination", steps, reason });
      return { stopped: reason };
    }
  }
}

/** 注入留言。决定先于内容落盘:检视器读到 decision 就知道随后几条 user/message 是插话而非新 turn。 */
function inject(log: EventLog, boundary: "step" | "turn", texts: string[]): number {
  if (texts.length === 0) return 0;
  log.append({ type: "decision", at: now(), slot: "steering", boundary, injected: texts.length });
  for (const text of texts) log.append({ type: "user/message", at: now(), text });
  return texts.length;
}

/**
 * 把一次请求的消息表示成"前缀投影 + 尾部":找最长的事件前缀,其投影是 messages 的前缀,
 * 剩下的消息原样记为 tail。正常步的 tail 为空;压缩摘要请求的 tail 是那条摘要指示。
 * 记这个而不是记全文,是为了不让日志膨胀成 O(n²),同时仍能逐字节重建。
 */
export function describeRequestBody(
  events: readonly AgentEvent[],
  messages: Message[],
): { prefixEvents: number; tail: Message[] } {
  const same = (a: Message, b: Message) => JSON.stringify(a) === JSON.stringify(b);
  for (let k = events.length; k >= 0; k--) {
    const derived = deriveMessages(events.slice(0, k));
    if (derived.length > messages.length) continue;
    if (derived.every((m, i) => same(m, messages[i] as Message))) {
      return { prefixEvents: k, tail: messages.slice(derived.length) };
    }
  }
  return { prefixEvents: 0, tail: messages };
}

function statusOf(err: unknown): number | undefined {
  return err instanceof ProviderError ? err.status : undefined;
}

function logRetry(log: EventLog, info: { attempt: number; delayMs: number; error: Error }): void {
  const status = statusOf(info.error);
  log.append({
    type: "retry",
    at: now(),
    attempt: info.attempt,
    delayMs: info.delayMs,
    error: info.error.message,
    ...(status !== undefined && { status }),
  });
}

function logRequestError(log: EventLog, err: unknown): void {
  const status = statusOf(err);
  log.append({
    type: "request/error",
    at: now(),
    error: (err as Error).message,
    ...(status !== undefined && { status }),
  });
}

function appendResult(
  log: EventLog,
  call: ToolCall,
  content: string,
  isError: boolean,
  durationMs?: number,
): void {
  log.append({
    type: "tool/result",
    at: now(),
    callId: call.id,
    name: call.name,
    content,
    isError,
    ...(durationMs !== undefined && { durationMs }),
  });
}

type Prepared =
  | { call: ToolCall; immediate: string }
  | { call: ToolCall; tool: Tool; args: unknown };

type Executed = { content: string; isError: boolean; durationMs: number };

async function runOne(
  p: Extract<Prepared, { tool: Tool }>,
  signal: AbortSignal,
): Promise<Executed> {
  const startedAt = Date.now();
  try {
    const content = await p.tool.execute(p.args as never, { signal, callId: p.call.id });
    return { content, isError: false, durationMs: Date.now() - startedAt };
  } catch (err) {
    // Q9:执行失败也是结果。打断导致的失败同样如实记录。
    return { content: (err as Error).message, isError: true, durationMs: Date.now() - startedAt };
  }
}

async function executeCalls(
  calls: ToolCall[],
  ctx: {
    log: EventLog;
    tools: Tool[];
    approve: ApprovePolicy;
    execution: ExecutionPolicy;
    signal?: AbortSignal;
  },
): Promise<void> {
  const signal = ctx.signal ?? new AbortController().signal;

  // 准备阶段永远按顺序:找工具、审批、校验。审批是人的决定,不能并发弹出。
  const prepare = async (call: ToolCall): Promise<Prepared> => {
    const tool = ctx.tools.find((t) => t.name === call.name);
    if (!tool) return { call, immediate: `未知工具 "${call.name}"。` };
    if (!(await ctx.approve(call))) return { call, immediate: "用户拒绝执行此调用。" };
    const checked = validateArgs(tool.parameters, call.args);
    if (!checked.ok) return { call, immediate: checked.error };
    return { call, tool, args: checked.value };
  };

  // 并行批:相邻的、都声明了并行安全的调用。结果等整批完成后按顺序落盘。
  let batch: Extract<Prepared, { tool: Tool }>[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const items = batch;
    batch = [];
    if (items.length > 1) {
      ctx.log.append({
        type: "decision",
        at: now(),
        slot: "execution",
        parallel: items.length,
        tools: items.map((p) => p.call.name),
      });
    }
    const results = await Promise.all(items.map((p) => runOne(p, signal)));
    items.forEach((p, i) => {
      const r = results[i] as Executed;
      appendResult(ctx.log, p.call, r.content, r.isError, r.durationMs);
    });
  };

  for (const call of calls) {
    // 打断后剩余调用不再执行,但必须逐个补应答(Q21)。
    if (signal.aborted) {
      await flush();
      appendResult(ctx.log, call, "已被用户打断,未执行。", true);
      continue;
    }
    const p = await prepare(call);
    if ("immediate" in p) {
      await flush();
      appendResult(ctx.log, call, p.immediate, true);
      continue;
    }
    const parallelSafe = ctx.execution === "parallel" && p.tool.concurrency === "parallel";
    if (!parallelSafe) await flush();
    batch.push(p);
    if (!parallelSafe) await flush();
  }
  await flush();
}
