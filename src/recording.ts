// 一个会话的有序写入与正文附件。失败保留待写数据;重试固定字节位置,不重复追加或执行外部操作。
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AgentEvent } from "./events.js";

export type ContentRef = { file: string; label: string; bytes?: number; missingFrom?: number };
type Write = { file: string; data: Buffer; offset?: number; written: number; truncate?: number };

export class Recording {
  private queue: Write[] = [];
  private dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();
  private rawPending = 0;
  private disposed = false;
  revision = 0;
  gaps = 0;
  onGap?: (ref: ContentRef) => void;
  error: string | undefined;
  readonly directory: string;
  constructor(
    readonly journal: string,
    private readonly bufferBytes = 64 * 1024 * 1024,
  ) {
    this.directory = `${journal.replace(/\.jsonl$/, "")}.records`;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }

  // EventLog 交付单个已序列化快照;分隔、修复和字节操作只属于此模块。
  appendEvent(json: string): void {
    this.append(this.journal, `${json}\n`);
  }

  loadEvents(repair = false): AgentEvent[] {
    const bytes = readFileSync(this.journal);
    const events: AgentEvent[] = [];
    let line = 0;
    for (let start = 0; start < bytes.length; ) {
      line++;
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      const text = bytes.subarray(start, end).toString("utf8").trim();
      let value: unknown;
      if (text) {
        try {
          value = JSON.parse(text);
        } catch (error) {
          if (bytes.subarray(end).toString("utf8").trim())
            throw new Error(
              `corrupt event log ${this.journal}:${line}: ${(error as Error).message}`,
            );
          const recovered: AgentEvent = {
            type: "session/recovered",
            at: new Date().toISOString(),
            droppedBytes: end - start,
            preview: text.slice(0, 80),
          };
          if (repair) {
            // 只裁去无法解析的尾部,原历史字节不重写;失败与追加共用同一个有序队列。
            this.append(this.journal, "", start);
            this.appendEvent(JSON.stringify(recovered));
          }
          events.push(recovered);
          return events;
        }
        if (
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          typeof (value as AgentEvent).type !== "string" ||
          typeof (value as AgentEvent).at !== "string"
        )
          throw new Error(`Invalid event record ${this.journal}:${line}`);
        events.push(value as AgentEvent);
      }
      start = end + 1;
    }
    // 完整末行缺分隔符时只补换行;只读打开从不排入修复。
    if (repair && bytes.length && bytes.at(-1) !== 10) this.append(this.journal, "\n");
    return events;
  }

  private append(file: string, data: string | Uint8Array, truncate?: number): boolean {
    const raw = file !== this.journal;
    const size = Buffer.byteLength(data);
    if (raw && this.rawPending + size > this.bufferBytes) return false;
    this.queue.push({
      file,
      data: Buffer.from(data),
      written: 0,
      ...(truncate !== undefined && { truncate, offset: truncate }),
    });
    if (raw) this.rawPending += size;
    this.revision++;
    if (!this.error) this.flush(false);
    this.schedule();
    return true;
  }

  private schedule(): void {
    if (!this.disposed && !this.timer && (this.queue.length || this.dirty.size)) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
        this.schedule();
      }, 1000);
      this.timer.unref();
    }
  }

  open(label: string): {
    ref: ContentRef;
    readonly bytes: number;
    write: (data: string | Uint8Array) => void;
  } {
    const ref: ContentRef = { file: `${randomUUID()}.body`, label };
    const file = join(this.directory, ref.file);
    this.append(file, "");
    let bytes = 0;
    return {
      ref,
      get bytes() {
        return bytes;
      },
      write: (data) => {
        const start = bytes;
        bytes += Buffer.byteLength(data);
        // 一个正文发生缺口后不拼接后半段,避免把不连续字节伪装成完整 JSON/SSE。
        if (ref.missingFrom !== undefined) return;
        if (!this.append(file, data)) {
          ref.missingFrom = start;
          this.gaps++;
          this.onGap?.({ ...ref });
          this.revision++;
          this.notify();
        }
      },
    };
  }

  // 保存失败是状态,不能成为模型或工具继续执行的门槛。
  flush(durable = true): void {
    const before = this.error;
    try {
      while (this.queue.length) {
        const op = this.queue[0] as Write;
        mkdirSync(dirname(op.file), { recursive: true });
        let fd: number | undefined;
        try {
          fd = openSync(op.file, existsSync(op.file) ? "r+" : "w+");
          const stat = fstatSync(fd);
          if (!stat.isFile()) throw new Error(`Recording path is not a file: ${op.file}`);
          if (op.truncate !== undefined) {
            ftruncateSync(fd, op.truncate);
            delete op.truncate;
          }
          op.offset ??= stat.size;
          while (op.written < op.data.length) {
            const n = writeSync(
              fd,
              op.data,
              op.written,
              op.data.length - op.written,
              op.offset + op.written,
            );
            if (!n) throw new Error("Recording write made no progress");
            op.written += n;
          }
          this.dirty.add(op.file);
          this.queue.shift();
          if (op.file !== this.journal) this.rawPending -= op.data.length;
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      }
      if (durable) {
        for (const file of this.dirty) {
          const fd = openSync(file, "r+");
          try {
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          this.dirty.delete(file);
        }
      }
      if (durable) this.error = undefined;
    } catch (error) {
      this.error = (error as Error).message;
    }
    if (durable && !this.error && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (before !== this.error) {
      this.revision++;
      this.notify();
    }
    this.schedule();
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* 状态观察者不能影响保存队列。 */
      }
    }
  }

  async checkpoint(signal?: AbortSignal): Promise<void> {
    if (!this.error) this.flush();
    signal?.throwIfAborted();
  }

  read(ref: ContentRef): string {
    return this.readBytes(ref).toString("utf8");
  }

  private readBytes(ref: ContentRef): Buffer {
    if (!/^[a-f0-9-]+\.body$/.test(ref.file)) throw new Error("Invalid recording reference");
    const file = join(this.directory, ref.file);
    const pending = this.queue.filter((op) => op.file === file);
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch (error) {
      if (!pending.length) throw error;
      bytes = Buffer.alloc(0);
    }
    if (pending.length) {
      let size = bytes.length;
      const offsets = pending.map((op) => {
        const offset = op.offset ?? size;
        size = Math.max(size, offset + op.data.length);
        return offset;
      });
      const merged = Buffer.alloc(size);
      bytes.copy(merged);
      pending.forEach((op, i) => {
        op.data.copy(merged, offsets[i]);
      });
      bytes = merged;
    }
    const expected = ref.missingFrom ?? ref.bytes;
    if (expected !== undefined && bytes.length !== expected)
      throw new Error(
        `Recording size mismatch: ${ref.file}, expected ${expected}, found ${bytes.length}`,
      );
    return bytes;
  }

  /** 新分叉只复制继承事件引用的正文;不读取无关文件,不改事件中的引用或下标。 */
  copyAttachments(events: readonly AgentEvent[], source?: Recording): void {
    const refs = new Map<string, ContentRef>();
    for (const event of events) {
      if (event.type !== "ext/event" || event.source !== "recording") continue;
      for (const key of ["input", "sent", "received", "output"]) {
        const ref = event.payload[key] as ContentRef | undefined;
        if (ref) refs.set(ref.file, ref);
      }
    }
    if (refs.size && !source)
      throw new Error("Forking recorded history requires its source recording");
    for (const ref of refs.values()) source?.copy(ref, this);
    this.flush();
    if (this.error) throw new Error(this.error);
  }

  copy(ref: ContentRef, target: Recording): void {
    // 活跃会话写盘失败时仍可复制已收到的内存字节,不等待原目录恢复。
    const data = this.readBytes(ref);
    const file = join(target.directory, ref.file);
    if (!data.length) target.append(file, data);
    // 复制健康磁盘上的大正文不应撞上故障缓冲上限;写不进去时明确失败。
    const chunk = Math.max(1, Math.min(64 * 1024, target.bufferBytes));
    for (let offset = 0; offset < data.length; offset += chunk) {
      if (!target.append(file, data.subarray(offset, offset + chunk)))
        throw new Error(`Recording copy buffer full: ${ref.file}`);
      if (target.error) throw new Error(target.error);
    }
  }
}
