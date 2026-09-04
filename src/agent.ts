import { now } from "./events.js";
import type { EventLog } from "./log.js";
import { runTurn, type TurnDeps, type TurnOutcome } from "./loop.js";
import { editState } from "./messages.js";
import type { EffortLevel, Provider } from "./provider.js";
import type { Tool } from "./tools.js";

export type AgentOptions = {
  log: EventLog;
  provider: Provider;
  tools: Tool[];
  slots?: TurnDeps["slots"];
  compaction?: TurnDeps["compaction"];
  onDelta?: (textDelta: string) => void;
  onReasoning?: (reasoningDelta: string) => void;
  onRaw?: (line: string) => void;
  /** 强度级别(Q52),缺省不传;setEffort 会话中切换,下一请求生效。 */
  effort?: EffortLevel;
};

/** 留言的投递方式:steer = 下一个步边界就注入(缺省);followUp = 等模型把手头的事做完再给。 */
export type DeliverAs = "steer" | "followUp";

type Queued = { text: string; deliverAs: DeliverAs };

/**
 * Q22 的薄类层:持有留言队列与 AbortController,把 runTurn 串成会话。
 * 状态仍然只在事件日志里;这个类只管"正在跑的这一次"的运行时资源。
 */
export class Agent {
  private queue: Queued[] = [];
  private ac: AbortController | undefined;
  private active: Promise<TurnOutcome> | undefined;

  constructor(private opts: AgentOptions) {}

  get running(): boolean {
    return this.active !== undefined;
  }

  /** 等待注入的留言条数(UI 状态栏用)。 */
  get queued(): number {
    return this.queue.length;
  }

  get provider(): Provider {
    return this.opts.provider;
  }

  get effort(): EffortLevel | undefined {
    return this.opts.effort;
  }

  /** 切换强度级别;undefined = 恢复不传。每条 request 事件都记着当时的级别,不另记事件。 */
  setEffort(level: EffortLevel | undefined): void {
    if (level === undefined) delete this.opts.effort;
    else this.opts.effort = level;
  }

  /** 当前策略槽实现(界面显示用)。 */
  get slots(): NonNullable<TurnDeps["slots"]> {
    return this.opts.slots ?? {};
  }

  /**
   * 会话中切换一个策略槽(Q78):runTurn 开跑时取槽实现,所以下一次 turn 起生效。
   * undefined = 恢复内置缺省。事件(session/slot)由调用方记,因为只有调用方知道实现的名字。
   */
  setSlot<K extends keyof NonNullable<TurnDeps["slots"]>>(
    name: K,
    impl: NonNullable<TurnDeps["slots"]>[K] | undefined,
  ): void {
    const slots = { ...this.opts.slots };
    if (impl === undefined) delete slots[name];
    else slots[name] = impl;
    this.opts.slots = slots;
  }

  /** 会话中切换模型:下一次请求起生效;记一条只给人看的事件,审计时知道哪段由谁生成。 */
  setProvider(provider: Provider): void {
    this.opts.provider = provider;
    this.opts.log.append({ type: "session/model", at: now(), model: provider.model });
  }

  /**
   * 空闲时:入日志并开跑。运行中:进留言队列,注入时点由 steering 槽与投递方式共同决定(Q20):
   * steer 在步边界排空,followUp 只在 turn 边界(模型不再调工具时)排空。
   */
  async prompt(text: string, opts: { deliverAs?: DeliverAs } = {}): Promise<TurnOutcome> {
    const log = this.opts.log;
    if (this.active) {
      this.queue.push({ text, deliverAs: opts.deliverAs ?? "steer" });
      return this.active;
    }
    // 上次被打断遗留的留言先于新输入注入(Q20 硬规矩:队列不静默丢弃)。
    for (const leftover of this.queue.splice(0)) {
      log.append({ type: "user/message", at: now(), text: leftover.text });
    }
    log.append({ type: "user/message", at: now(), text });
    return this.run();
  }

  /**
   * 重跑一步(Q76):丢掉最后一条(仍在投影里的)助手消息及其工具结果,不加新用户消息,
   * 从当前投影再发一次请求。编辑上下文之后立刻看效果的入口。丢弃以 context/drop 事件落盘,原文不动。
   */
  async retry(): Promise<TurnOutcome> {
    if (this.active) throw new Error("cannot retry while running; interrupt first");
    const events = this.opts.log.events;
    const dropped = editState(events).dropped;
    let target = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === "assistant/message" && !dropped.has(i)) {
        target = i;
        break;
      }
    }
    if (target < 0) throw new Error("no assistant message to retry");
    this.opts.log.append({ type: "context/drop", at: now(), target, note: "retry" });
    return this.run();
  }

  private async run(): Promise<TurnOutcome> {
    const log = this.opts.log;
    this.ac = new AbortController();
    this.active = runTurn({
      log,
      provider: this.opts.provider,
      tools: this.opts.tools,
      signal: this.ac.signal,
      drainQueue: (boundary) => {
        const take = (q: Queued) => boundary === "turn" || q.deliverAs === "steer";
        const out = this.queue.filter(take).map((q) => q.text);
        this.queue = this.queue.filter((q) => !take(q));
        return out;
      },
      ...(this.opts.slots && { slots: this.opts.slots }),
      ...(this.opts.compaction && { compaction: this.opts.compaction }),
      ...(this.opts.onDelta && { onDelta: this.opts.onDelta }),
      ...(this.opts.onReasoning && { onReasoning: this.opts.onReasoning }),
      ...(this.opts.onRaw && { onRaw: this.opts.onRaw }),
      effort: () => this.opts.effort,
    });
    try {
      return await this.active;
    } finally {
      this.active = undefined;
      this.ac = undefined;
    }
  }

  /** 即时打断(Q11):interrupt 事件只给人看,模型看到的是打断的后果。 */
  interrupt(): void {
    if (!this.running) return;
    this.opts.log.append({ type: "session/interrupt", at: now() });
    this.ac?.abort();
  }
}
