import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentEvent } from "./events.js";

/**
 * append-only 事件日志。三条纪律:
 * 1. 只能 append,永不改写 —— 压缩/视图变换都发生在投影层,历史不可变。
 * 2. 落盘用 JSONL 同步追加:进程崩溃最多丢正在写的一行,已写的行永远完整。
 * 3. 订阅是只读通道(观察与干预分离):UI/统计只许看,不许改。
 */
export class EventLog {
  readonly events: AgentEvent[] = [];
  private listeners = new Set<(e: AgentEvent) => void>();

  constructor(private filePath?: string) {
    if (filePath) mkdirSync(dirname(filePath), { recursive: true });
  }

  append(e: AgentEvent): void {
    this.events.push(e);
    if (this.filePath) appendFileSync(this.filePath, JSON.stringify(e) + "\n");
    for (const fn of this.listeners) fn(e);
  }

  /** 只读订阅。返回退订函数。 */
  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 从 JSONL 文件重建日志(回放的入口)。不挂文件 = 纯内存回放。 */
  static load(filePath: string): EventLog {
    const log = new EventLog();
    const raw = readFileSync(filePath, "utf8");
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]?.trim();
      if (!trimmed) continue;
      try {
        log.events.push(JSON.parse(trimmed) as AgentEvent);
      } catch (err) {
        // 损坏的行要能定位。历史是唯一真相,静默跳过等于篡改。
        throw new Error(`事件日志损坏 ${filePath}:${i + 1}: ${(err as Error).message}`);
      }
    }
    return log;
  }
}
