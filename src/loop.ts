import { type CompactionStrategy, estimateAfter, type PreservationPolicy } from "./compaction.js";
import { now, type ToolCall } from "./events.js";
import type { EventLog } from "./log.js";
import { deriveMessages } from "./messages.js";
import type { AssistantTurn, Provider, ToolDef } from "./provider.js";
import { isContextOverflow } from "./providers/errors.js";
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
  };
  /** 排空留言队列,返回待注入的用户消息。注入时点由 steering 决定(Q20)。 */
  drainQueue?: () => string[];
  signal?: AbortSignal;
  onDelta?: (textDelta: string) => void;
  onReasoning?: (reasoningDelta: string) => void;
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

/** 达到阈值时运行策略并落盘压缩事件。返回是否取得实际进展。 */
async function compactIfNeeded(
  deps: TurnDeps,
  cfg: CompactionConfig,
  force: boolean,
): Promise<boolean> {
  const threshold = cfg.window - (cfg.reserveTokens ?? DEFAULT_RESERVE);
  const before = estimateAfter(deps.log.events);
  if (!force && before <= threshold) return false;
  const payload = await cfg.strategy({
    events: deps.log.events,
    window: cfg.window,
    targetTokens: threshold,
    provider: deps.provider,
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

    let turn: AssistantTurn;
    try {
      turn = await provider.complete(deriveMessages(log.events), defs, {
        ...(onDelta && { onDelta }),
        ...(onReasoning && { onReasoning }),
        ...(signal && { signal }),
      });
    } catch (err) {
      // 溢出恢复(Q33):压缩取得进展才许重试,且只重试一次。
      const cfg = deps.compaction;
      const overflow = cfg && (cfg.isOverflow ?? defaultIsOverflow)(err as Error);
      if (!overflow || overflowRecovered) throw err;
      overflowRecovered = true;
      const progressed = await compactIfNeeded(deps, cfg, true);
      if (!progressed) throw err;
      continue;
    }
    log.append({ type: "assistant/message", at: now(), ...turn });
    steps += 1;

    if (turn.stopReason === "aborted") return "aborted";

    if (turn.stopReason === "length") {
      // Q26:截断响应的调用一个都不执行,逐个补错误应答(协议要求每个 call 有应答)。
      for (const call of turn.toolCalls) appendResult(log, call, LENGTH_NOTICE, true);
    } else if (turn.stopReason === "tool") {
      await executeCalls(turn.toolCalls, { log, tools, approve, ...(signal && { signal }) });
      if (signal?.aborted) return "aborted";
    }

    // step 边界。审批等待发生在上面的执行阶段,此处才排队列 —— 留言永不落进确认窗口(Q20 硬规矩)。
    let injected = steering("step") ? inject(log, drainQueue()) : 0;

    if (turn.stopReason === "end") {
      if (injected === 0 && steering("turn")) injected = inject(log, drainQueue());
      if (injected === 0) return "idle"; // 无事可欠,turn 结束
    }

    const reason = termination({ steps });
    if (reason !== null) return { stopped: reason };
  }
}

function inject(log: EventLog, texts: string[]): number {
  for (const text of texts) log.append({ type: "user/message", at: now(), text });
  return texts.length;
}

function appendResult(log: EventLog, call: ToolCall, content: string, isError: boolean): void {
  log.append({
    type: "tool/result",
    at: now(),
    callId: call.id,
    name: call.name,
    content,
    isError,
  });
}

async function executeCalls(
  calls: ToolCall[],
  ctx: {
    log: EventLog;
    tools: Tool[];
    approve: ApprovePolicy;
    signal?: AbortSignal;
  },
): Promise<void> {
  // 串行执行(Q10)。打断后剩余调用不再执行,但必须逐个补应答(Q21)。
  for (const call of calls) {
    if (ctx.signal?.aborted) {
      appendResult(ctx.log, call, "已被用户打断,未执行。", true);
      continue;
    }
    const tool = ctx.tools.find((t) => t.name === call.name);
    if (!tool) {
      appendResult(ctx.log, call, `未知工具 "${call.name}"。`, true);
      continue;
    }
    if (!(await ctx.approve(call))) {
      appendResult(ctx.log, call, "用户拒绝执行此调用。", true);
      continue;
    }
    const checked = validateArgs(tool.parameters, call.args);
    if (!checked.ok) {
      appendResult(ctx.log, call, checked.error, true);
      continue;
    }
    try {
      const signal = ctx.signal ?? new AbortController().signal;
      const content = await tool.execute(checked.value as never, { signal });
      appendResult(ctx.log, call, content, false);
    } catch (err) {
      // Q9:执行失败也是结果。打断导致的失败同样如实记录。
      appendResult(ctx.log, call, (err as Error).message, true);
    }
  }
}
