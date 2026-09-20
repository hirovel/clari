import { randomUUID } from "node:crypto";
import { now } from "./events.js";
import type { ImageInput } from "./images.js";
import type { EventLog } from "./log.js";
import { runTurn, type TurnDeps, type TurnOutcome } from "./loop.js";
import { editState } from "./messages.js";
import type { EffortLevel, Provider } from "./provider.js";
import type { Tool } from "./tools.js";

export type AgentOptions = {
  log: EventLog;
  provider: Provider;
  tools: Tool[] | (() => readonly Tool[]);
  slots?: TurnDeps["slots"];
  compaction?: TurnDeps["compaction"];
  onDelta?: (textDelta: string) => void;
  onReasoning?: (reasoningDelta: string) => void;
  onRaw?: (line: string) => void;
  onRequest?: (body: string) => void;
  /** 强度级别,缺省不传;setEffort 会话中切换,下一请求生效。 */
  effort?: EffortLevel;
  /** 这个 agent 的名字(子 agent 用);审批提示据此标明是谁在问。 */
  agent?: string;
  facts?: TurnDeps["facts"];
  planReminder?: number;
  pending?: readonly PendingInput[];
  onPendingChange?: (pending: readonly PendingInput[]) => void;
};

/** 留言的投递方式:steer = 下一个步边界就注入(缺省);followUp = 等模型把手头的事做完再给。 */
export type DeliverAs = "steer" | "followUp";

export type PendingInput = {
  id: string;
  text: string;
  deliverAs: DeliverAs;
  paused: boolean;
  images?: ImageInput[];
};

/**
 * 薄类层:持有留言队列与 AbortController,把 runTurn 串成会话。
 * 已投递内容在事件日志里;尚未投递的输入由宿主选择是否持久化。
 */
export class Agent {
  private queue: PendingInput[] = [];
  private ac: AbortController | undefined;
  private active: Promise<TurnOutcome> | undefined;

  constructor(private opts: AgentOptions) {
    this.queue = (opts.pending ?? []).map((item) => ({
      ...item,
      ...(item.images && { images: item.images.map((image) => ({ ...image })) }),
      paused: true,
    }));
  }

  get pending(): readonly PendingInput[] {
    return this.queue.map((item) => ({
      ...item,
      ...(item.images && { images: item.images.map((image) => ({ ...image })) }),
    }));
  }

  private changed(): void {
    this.opts.onPendingChange?.(this.pending);
  }

  removePending(id: string): void {
    this.queue = this.queue.filter((item) => item.id !== id);
    this.changed();
  }

  editPending(id: string, text: string): void {
    const item = this.queue.find((item) => item.id === id);
    if (!item) throw new Error("This input has already been delivered");
    if (!text.trim() && !item.images?.length) throw new Error("Input cannot be empty");
    item.text = text;
    this.changed();
  }

  async continuePending(): Promise<TurnOutcome | undefined> {
    if (!this.queue.length) return;
    for (const item of this.queue) item.paused = false;
    this.changed();
    if (this.active) return this.active;
    const first = this.queue[0];
    if (!first) return;
    this.opts.log.append({
      type: "user/message",
      at: now(),
      text: first.text,
      inputId: first.id,
      ...(first.images?.length && { images: first.images }),
    });
    this.queue.shift();
    this.changed();
    return this.run();
  }

  get running(): boolean {
    return this.active !== undefined;
  }

  async waitForIdle(): Promise<void> {
    await this.active;
  }

  /** 等待注入的留言条数(UI 状态栏用)。 */
  get queued(): number {
    return this.queue.length;
  }

  get provider(): Provider {
    return this.opts.provider;
  }

  get tools(): readonly Tool[] {
    return typeof this.opts.tools === "function" ? this.opts.tools() : this.opts.tools;
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
   * 会话中切换一个策略槽:runTurn 开跑时取槽实现,所以下一次 turn 起生效。
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
  /** 下一请求读取工具集;进行中的请求保留它发出时的工具版本。 */
  setTools(tools: AgentOptions["tools"]): void {
    this.opts.tools = tools;
  }

  /** 会话中改事实附注与计划复述的设置(/settings);下一次 turn 起生效。 */
  configure(next: { facts?: TurnDeps["facts"]; planReminder?: number }): void {
    if (next.facts !== undefined) this.opts.facts = next.facts;
    if (next.planReminder !== undefined) this.opts.planReminder = next.planReminder;
  }

  get facts(): TurnDeps["facts"] | undefined {
    return this.opts.facts;
  }

  get planReminder(): number | undefined {
    return this.opts.planReminder;
  }

  setProvider(provider: Provider): void {
    this.opts.provider = provider;
    this.opts.log.append({ type: "session/model", at: now(), model: provider.model });
  }

  /**
   * 空闲时:入日志并开跑。运行中:进留言队列,注入时点由 steering 槽与投递方式共同决定:
   * steer 在步边界排空,followUp 只在 turn 边界(模型不再调工具时)排空。
   */
  async prompt(
    text: string,
    opts: { deliverAs?: DeliverAs; inputId?: string; images?: ImageInput[] } = {},
  ): Promise<TurnOutcome> {
    const log = this.opts.log;
    if (this.active) {
      this.queue.push({
        id: opts.inputId ?? randomUUID(),
        text,
        deliverAs: opts.deliverAs ?? "steer",
        paused: false,
        ...(opts.images?.length && { images: structuredClone(opts.images) }),
      });
      this.changed();
      return this.active;
    }
    // 暂停内容必须手动继续;新输入不会夹带中断或恢复留下的消息。
    for (const leftover of this.queue.filter((item) => !item.paused)) {
      log.append({
        type: "user/message",
        at: now(),
        text: leftover.text,
        inputId: leftover.id,
        ...(leftover.images?.length && { images: leftover.images }),
      });
      this.queue = this.queue.filter((item) => item.id !== leftover.id);
    }
    this.changed();
    log.append({
      type: "user/message",
      at: now(),
      text,
      ...(opts.inputId && { inputId: opts.inputId }),
      ...(opts.images?.length && { images: structuredClone(opts.images) }),
    });
    return this.run();
  }

  /**
   * 重跑一步:丢掉最后一条(仍在投影里的)助手消息及其工具结果,不加新用户消息,
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
    const unsubscribe = log.subscribe((event) => {
      if (event.type !== "user/message" || !event.inputId) return;
      this.queue = this.queue.filter((item) => item.id !== event.inputId);
      this.changed();
    });
    this.active = runTurn({
      log,
      provider: this.opts.provider,
      tools: () => this.tools,
      signal: this.ac.signal,
      drainQueue: (boundary) => {
        const take = (q: PendingInput) =>
          !q.paused && (boundary === "turn" || q.deliverAs === "steer");
        const out = this.queue.filter(take).map((q) => ({
          text: q.text,
          inputId: q.id,
          ...(q.images?.length && { images: q.images }),
        }));
        return out;
      },
      ...(this.opts.slots && { slots: this.opts.slots }),
      ...(this.opts.compaction && { compaction: this.opts.compaction }),
      ...(this.opts.onDelta && { onDelta: this.opts.onDelta }),
      ...(this.opts.onReasoning && { onReasoning: this.opts.onReasoning }),
      ...(this.opts.onRaw && { onRaw: this.opts.onRaw }),
      ...(this.opts.onRequest && { onRequest: this.opts.onRequest }),
      effort: () => this.opts.effort,
      ...(this.opts.agent && { agent: this.opts.agent }),
      ...(this.opts.facts && { facts: this.opts.facts }),
      ...(this.opts.planReminder !== undefined && { planReminder: this.opts.planReminder }),
    }).finally(async () => {
      await log.checkpoint();
      unsubscribe();
      this.active = undefined;
      this.ac = undefined;
      this.changed();
    });
    return this.active;
  }

  /** 即时打断:interrupt 事件只给人看,模型看到的是打断的后果。 */
  interrupt(): void {
    if (!this.running) return;
    for (const item of this.queue) item.paused = true;
    try {
      this.changed();
      this.opts.log.append({ type: "session/interrupt", at: now() });
    } finally {
      // 保存或记录失败仍须投递取消,不能让 I/O 错误继续驱动正在执行的任务。
      this.ac?.abort();
    }
  }
}
