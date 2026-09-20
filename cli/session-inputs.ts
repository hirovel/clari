// 待发送内容是会话的工作状态,不是模型上下文。快照只存最新值,投递凭日志中的 inputId 去重。
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { PendingInput } from "../src/agent.js";
import type { AgentEvent } from "../src/events.js";
import type { ImageInput } from "../src/images.js";

type InputSnapshot = {
  draft: { id: string; text: string; images?: ImageInput[] };
  pending: PendingInput[];
};

function validImages(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.every(
        (image) =>
          image &&
          ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType) &&
          typeof image.data === "string" &&
          image.data.length > 0 &&
          image.data.length % 4 === 0 &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(image.data) &&
          (image.name === undefined || typeof image.name === "string"),
      ))
  );
}

export class SessionInputs {
  private state: InputSnapshot = { draft: { id: randomUUID(), text: "" }, pending: [] };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private onError: ((error: Error) => void) | undefined;
  private readonly file: string;
  error: string | undefined;
  constructor(
    sessionFile: string,
    private enabled: boolean,
  ) {
    this.file = `${sessionFile.replace(/\.jsonl$/, "")}.inputs.json`;
    if (!enabled) this.configure(false);
  }
  read(events: readonly AgentEvent[]): InputSnapshot {
    if (this.enabled && !this.dirty && existsSync(this.file)) {
      const data: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      const s = data as InputSnapshot;
      if (
        !s?.draft ||
        typeof s.draft.id !== "string" ||
        typeof s.draft.text !== "string" ||
        !validImages(s.draft.images) ||
        !Array.isArray(s.pending) ||
        s.pending.some(
          (p) =>
            !p ||
            typeof p.id !== "string" ||
            typeof p.text !== "string" ||
            !validImages(p.images) ||
            !["steer", "followUp"].includes(p.deliverAs),
        )
      )
        throw new Error(`Invalid saved input: ${this.file}`);
      this.state = s;
    } else if (this.enabled && !this.dirty) {
      this.state = { draft: { id: randomUUID(), text: "" }, pending: [] };
    }
    const delivered = new Set(
      events.flatMap((e) => (e.type === "user/message" && e.inputId ? [e.inputId] : [])),
    );
    this.state.pending = this.state.pending.filter((p) => !delivered.has(p.id));
    if (
      delivered.has(this.state.draft.id) ||
      this.state.pending.some((p) => p.id === this.state.draft.id)
    )
      this.state.draft = { id: randomUUID(), text: "" };
    return structuredClone(this.state);
  }
  bind(onError: (error: Error) => void): void {
    this.onError = onError;
  }
  get draftId(): string {
    return this.state.draft.id;
  }
  get saving(): boolean {
    return this.enabled;
  }
  setDraft(text: string, images: ImageInput[] = []): void {
    const current = this.state.draft.images ?? [];
    if (
      text === this.state.draft.text &&
      images.length === current.length &&
      images.every(
        (image, i) =>
          image.name === current[i]?.name &&
          image.mimeType === current[i]?.mimeType &&
          image.data === current[i]?.data,
      )
    )
      return;
    if (!this.state.draft.text && !this.state.draft.images?.length)
      this.state.draft.id = randomUUID();
    this.state.draft.text = text;
    this.state.draft.images = images.map((image) => ({ ...image }));
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.saveQuietly(), 200);
  }
  setPending(pending: readonly PendingInput[]): void {
    this.state.pending = pending.map((p) => ({
      ...p,
      ...(p.images && { images: p.images.map((image) => ({ ...image })) }),
    }));
    if (pending.some((p) => p.id === this.state.draft.id))
      this.state.draft = { id: randomUUID(), text: "" };
    this.dirty = true;
    this.saveQuietly();
  }
  configure(enabled: boolean): void {
    // 关闭保存也移除旧快照,避免下次启动恢复已经失效的输入。
    if (!enabled) rmSync(this.file, { force: true });
    const previous = this.enabled;
    this.enabled = enabled;
    this.dirty = true;
    try {
      this.flush();
      this.error = undefined;
    } catch (error) {
      this.enabled = previous;
      throw error;
    }
  }
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty || !this.enabled) return;
    const temp = `${this.file}.tmp`;
    try {
      if (!this.state.draft.text && !this.state.draft.images?.length && !this.state.pending.length)
        rmSync(this.file, { force: true });
      else {
        writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
        renameSync(temp, this.file);
      }
      this.dirty = false;
      this.error = undefined;
    } catch (error) {
      this.error = (error as Error).message;
      throw error;
    } finally {
      rmSync(temp, { force: true });
    }
  }
  private saveQuietly(): void {
    const previous = this.error;
    try {
      this.flush();
    } catch (error) {
      if (this.error !== previous) this.onError?.(error as Error);
    }
  }
  detach(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.onError = undefined;
  }
}
