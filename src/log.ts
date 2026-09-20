import type { AgentEvent } from "./events.js";
import { Recording } from "./recording.js";

// JSON 快照已与调用方解耦;冻结其对象和数组,读者不能悄悄修改历史。
function seal<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) seal(child);
    Object.freeze(value);
  }
  return value;
}

/** 一份追加式事实数组。编辑通过事件改变投影;文件格式与恢复完全归 Recording。 */
export class EventLog {
  private entries: AgentEvent[] = [];
  private listeners = new Set<(e: AgentEvent) => void>();
  readonly recording?: Recording;

  constructor(filePath?: string) {
    if (filePath) {
      this.recording = new Recording(filePath);
      this.recording.onGap = (ref) =>
        this.append({
          type: "ext/event",
          at: new Date().toISOString(),
          source: "recording",
          kind: "body/gap",
          payload: { ref },
        });
    }
  }

  get events(): readonly AgentEvent[] {
    return this.entries;
  }

  get path(): string | undefined {
    return this.recording?.journal;
  }

  append(e: AgentEvent): void {
    // 内存与磁盘使用同一份 JSON 内容,原始对象的后续变化不会改写已捕获事实。
    const json = JSON.stringify(e);
    const snapshot = seal(JSON.parse(json) as AgentEvent);
    this.recording?.appendEvent(json);
    this.entries.push(snapshot);
    for (const fn of this.listeners) {
      try {
        fn(snapshot);
      } catch (err) {
        // 观察者错误交给宿主,不能打断写入队列或其余观察者。
        queueMicrotask(() => {
          throw err;
        });
      }
    }
  }

  async checkpoint(signal?: AbortSignal): Promise<void> {
    await this.recording?.checkpoint(signal);
  }

  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  static load(filePath: string, opts: { attach?: boolean } = {}): EventLog {
    const log = new EventLog(opts.attach ? filePath : undefined);
    const events = (log.recording ?? new Recording(filePath)).loadEvents(opts.attach);
    for (const event of events) log.entries.push(seal(event));
    return log;
  }
}
