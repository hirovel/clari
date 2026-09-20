// 只读历史附件。失败是可见的证据缺口,不退回当前配置冒充旧请求。
import type { AgentEvent } from "../src/events.js";
import type { EventLog } from "../src/log.js";
import type { Message } from "../src/messages.js";
import type { ToolDef } from "../src/provider.js";
import { type ContentRef, Recording } from "../src/recording.js";

export type RecordedBody = { bytes?: number | undefined; read(): string };
export type RequestRecording = {
  bodies: string[];
  error?: string | undefined;
  unsaved?: boolean;
  input?: { messages: Message[]; tools: ToolDef[] };
  attempts?: { n: number; status?: number; state: string; response: string; body?: RecordedBody }[];
  outputs?: {
    name: string;
    original: string;
    model: string;
    state: string;
    source: string;
    body?: RecordedBody;
  }[];
};

export type RecordingSection = "input" | "received" | "wire" | "summary";

// 缓存只属于当前查看器;流式写入的 revision 不依赖是否新增内核事件。
export function recordingReader() {
  const cache = new Map<
    string,
    {
      events: readonly AgentEvent[];
      count: number;
      revision: number;
      value: RequestRecording | undefined;
    }
  >();
  return (log: EventLog, file: string, request: number, section?: RecordingSection) => {
    const key = `${file}:${request}:${section ?? "all"}`;
    const revision = log.recording?.revision ?? 0;
    const hit = cache.get(key);
    if (
      hit?.events === log.events &&
      hit.count === log.events.length &&
      hit.revision === revision &&
      !hit.value?.error
    )
      return hit.value;
    const value = readRequestRecording(file, log.events, request, section, log.recording);
    if (cache.size >= 4) cache.delete(cache.keys().next().value as string);
    cache.set(key, { events: log.events, count: log.events.length, revision, value });
    return value;
  };
}

export function readRequestRecording(
  file: string,
  events: readonly AgentEvent[],
  request: number,
  section?: RecordingSection,
  liveStore?: Recording,
): RequestRecording | undefined {
  const store = liveStore ?? new Recording(file);
  const errors: string[] = [];
  const gaps = new Map<string, number>();
  const withGap = (ref: ContentRef): ContentRef => {
    const missingFrom = ref.missingFrom ?? gaps.get(ref.file);
    return missingFrom === undefined ? ref : { ...ref, missingFrom };
  };
  const read = (value: unknown): string => {
    try {
      const ref = withGap(value as ContentRef);
      if (ref.missingFrom !== undefined)
        errors.push(
          `Recording gap: ${ref.label}; bytes from ${ref.missingFrom} were not captured. Available prefix shown.`,
        );
      return store.read(ref);
    } catch (error) {
      const message = `Missing or unreadable recording: ${(error as Error).message}`;
      errors.push(message);
      return message;
    }
  };
  const records = events.filter(
    (e): e is Extract<AgentEvent, { type: "ext/event" }> =>
      e.type === "ext/event" && e.source === "recording",
  );
  for (const record of records) {
    if (record.kind !== "body/gap") continue;
    const ref = record.payload.ref as ContentRef;
    if (typeof ref?.file === "string" && typeof ref.missingFrom === "number")
      gaps.set(ref.file, ref.missingFrom);
  }
  const input = records.find((e) => e.kind === "request/input" && e.payload.request === request);
  const starts = records.filter((e) => e.kind === "http/start" && e.payload.request === request);
  if (!input && !starts.length) return undefined;
  const result: RequestRecording = {
    bodies: [],
    attempts: [],
    outputs: [],
    get error() {
      return errors.length ? [...new Set(errors)].join("\n") : undefined;
    },
  };
  const body = (ref: ContentRef): RecordedBody => {
    ref = withGap(ref);
    if (ref.missingFrom !== undefined)
      errors.push(
        `Recording gap: ${ref.label}; bytes from ${ref.missingFrom} were not captured. Available prefix shown.`,
      );
    let content: string | undefined;
    return { bytes: ref.missingFrom ?? ref.bytes, read: () => (content ??= read(ref)) };
  };
  if (liveStore?.error) {
    result.unsaved = true;
    errors.push(
      `Recording not saved: ${liveStore.error}. Available in-memory content shown; work continues.`,
    );
  }
  if (input && section !== "received") {
    try {
      const parsed = JSON.parse(read(input.payload.input));
      if (!Array.isArray(parsed?.messages) || !Array.isArray(parsed?.tools))
        throw new Error("Invalid input");
      result.input = parsed;
    } catch {
      errors.push("Recorded adapter input is not readable JSON");
    }
  }
  for (const start of section === "input" ? [] : starts) {
    const n = start.payload.attempt as number;
    const matching = records.filter(
      (e) => e.payload.request === request && e.payload.attempt === n,
    );
    const status = matching.find((e) => e.kind === "http/response")?.payload.status as
      | number
      | undefined;
    const end = matching.find((e) => e.kind === "http/end");
    const state = end?.payload.state as string | undefined;
    if (!section || section === "wire") result.bodies.push(read(start.payload.sent));
    const responseBody = body({
      ...(start.payload.received as ContentRef),
      ...(typeof end?.payload.bytes === "number" && { bytes: end.payload.bytes }),
      ...(typeof end?.payload.missingFrom === "number" && {
        missingFrom: end.payload.missingFrom,
      }),
    });
    result.attempts?.push({
      n,
      ...(status !== undefined && { status }),
      state: state ?? "unfinished",
      response: !section ? responseBody.read() : "",
      ...(section === "received" && { body: responseBody }),
    });
  }
  const next = events.findIndex((e, i) => i > request && e.type === "request");
  const after = events.slice(request + 1, next < 0 ? events.length : next);
  for (const e of after) {
    if (e.type !== "ext/event" || e.source !== "recording" || e.kind !== "tool/output") continue;
    const callId = e.payload.callId;
    const returned = after.find((r) => r.type === "tool/result" && r.callId === callId);
    const finished = after.find(
      (r) =>
        r.type === "ext/event" &&
        r.source === "recording" &&
        r.kind === "tool/finished" &&
        r.payload.callId === callId,
    );
    const bytes = finished?.type === "ext/event" ? finished.payload.bytes : undefined;
    const source = after.find(
      (r) =>
        r.type === "ext/event" &&
        r.source === "recording" &&
        r.kind === "tool/output-source" &&
        r.payload.callId === callId,
    );
    const originalBody = body({
      ...(e.payload.output as ContentRef),
      ...(typeof bytes === "number" && { bytes }),
      ...(finished?.type === "ext/event" &&
        typeof finished.payload.missingFrom === "number" && {
          missingFrom: finished.payload.missingFrom,
        }),
    });
    result.outputs?.push({
      name: returned?.type === "tool/result" ? returned.name : String(callId),
      original: !section ? originalBody.read() : "",
      ...(section === "received" && { body: originalBody }),
      model: returned?.type === "tool/result" ? returned.content : "No model result recorded",
      state: returned
        ? "result recorded"
        : finished
          ? "tool finished; model result pending"
          : "unfinished",
      source: source?.type === "ext/event" ? String(source.payload.source) : "original output",
    });
  }
  return result;
}
