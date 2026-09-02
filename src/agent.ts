import { now } from "./events.js";
import type { EventLog } from "./log.js";
import { runTurn, type TurnDeps, type TurnOutcome } from "./loop.js";
import type { Provider } from "./provider.js";
import type { Tool } from "./tools.js";

export type AgentOptions = {
  log: EventLog;
  provider: Provider;
  tools: Tool[];
  slots?: TurnDeps["slots"];
  compaction?: TurnDeps["compaction"];
  onDelta?: (textDelta: string) => void;
};

/**
 * Q22 的薄类层:持有留言队列与 AbortController,把 runTurn 串成会话。
 * 状态仍然只在事件日志里;这个类只管"正在跑的这一次"的运行时资源。
 */
export class Agent {
  private queue: string[] = [];
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

  /** 空闲时:入日志并开跑。运行中:进留言队列,注入时点由 steering 槽决定(Q20)。 */
  async prompt(text: string): Promise<TurnOutcome> {
    const log = this.opts.log;
    if (this.active) {
      this.queue.push(text);
      return this.active;
    }
    // 上次被打断遗留的留言先于新输入注入(Q20 硬规矩:队列不静默丢弃)。
    for (const leftover of this.queue.splice(0)) {
      log.append({ type: "user/message", at: now(), text: leftover });
    }
    log.append({ type: "user/message", at: now(), text });

    this.ac = new AbortController();
    this.active = runTurn({
      log,
      provider: this.opts.provider,
      tools: this.opts.tools,
      signal: this.ac.signal,
      drainQueue: () => this.queue.splice(0),
      ...(this.opts.slots && { slots: this.opts.slots }),
      ...(this.opts.compaction && { compaction: this.opts.compaction }),
      ...(this.opts.onDelta && { onDelta: this.opts.onDelta }),
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
