// 会话文件的列表与清理(Q90):会话目录里每个 .jsonl 是一份事件数组,旁边可能有 .trace.jsonl(原始流)与 .mcp/(MCP 图片结果)。
// 列表只读首尾几个事件;清理按开始时间或保留条数,连同旁车文件一起删,不加 --yes 只打印计划。
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export type SessionSummary = {
  file: string;
  /** 不含目录的文件名。 */
  name: string;
  bytes: number;
  /** session/start 的时间;文件里没有就用 mtime。 */
  startedAt: string;
  model?: string;
  events: number;
  userMessages: number;
  requests: number;
  /** 最后一条用户消息的首行。 */
  lastUser?: string;
  /** 存在的旁车:trace / mcp。 */
  sidecars: string[];
  fork: boolean;
};

function sidecarsOf(file: string): string[] {
  const base = file.replace(/\.jsonl$/, "");
  const out: string[] = [];
  if (existsSync(`${base}.trace.jsonl`)) out.push(`${base}.trace.jsonl`);
  if (existsSync(`${base}.mcp`)) out.push(`${base}.mcp`);
  return out;
}

/** 读一份会话并概括;坏行跳过,不抛。 */
export function summarizeSession(file: string): SessionSummary {
  const st = statSync(file);
  const text = readFileSync(file, "utf8");
  let events = 0;
  let userMessages = 0;
  let requests = 0;
  let startedAt: string | undefined;
  let model: string | undefined;
  let lastUser: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; at?: string; model?: string; text?: string };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }
    events += 1;
    if (e.type === "session/start") {
      startedAt = startedAt ?? e.at;
      model = e.model ?? model;
    } else if (e.type === "session/model") model = e.model ?? model;
    else if (e.type === "user/message") {
      userMessages += 1;
      lastUser = (e.text ?? "").split("\n")[0]?.trim() || lastUser;
    } else if (e.type === "request") requests += 1;
  }
  const name = file.split(/[\\/]/).at(-1) ?? file;
  return {
    file,
    name,
    bytes: st.size,
    startedAt: startedAt ?? st.mtime.toISOString(),
    ...(model && { model }),
    events,
    userMessages,
    requests,
    ...(lastUser && { lastUser }),
    sidecars: sidecarsOf(file),
    fork: name.includes("-fork"),
  };
}

/** 目录里全部会话,新的在前。trace 文件不是会话。 */
export function listSessions(dir: string): SessionSummary[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") && !f.endsWith(".trace.jsonl"))
    .sort()
    .reverse()
    .map((f) => summarizeSession(join(dir, f)));
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 一行一会话:开始时间、模型、请求数、大小、旁车、最后一条用户消息。 */
export function sessionRows(list: SessionSummary[], width = 100): string[] {
  return list.map((s) => {
    const when = s.startedAt.slice(0, 16).replace("T", " ");
    const tags = [
      ...(s.fork ? ["fork"] : []),
      ...s.sidecars.map((p) => (p.endsWith(".mcp") ? "mcp" : "trace")),
    ];
    const head = `${when}  ${(s.model ?? "?").padEnd(24).slice(0, 24)} ${String(s.requests).padStart(4)} req ${fmtBytes(s.bytes).padStart(9)}${tags.length ? `  [${tags.join(" ")}]` : ""}`;
    const tail = s.lastUser ? `  ${s.lastUser}` : "";
    const line = `${head}${tail}`;
    return line.length > width ? `${line.slice(0, width - 1)}…` : line;
  });
}

export type PruneOptions = {
  /** 开始时间早于这么多天前的删。 */
  olderThanDays?: number;
  /** 只留最新的这么多份。 */
  keep?: number;
  /** false = 只算计划,不删。 */
  apply: boolean;
  now?: Date;
};

/** 选出要删的会话并(apply 时)连旁车一起删。两个条件都给时取并集。 */
export function pruneSessions(
  dir: string,
  opts: PruneOptions,
): { removed: SessionSummary[]; kept: number; bytes: number } {
  const all = listSessions(dir);
  const now = opts.now ?? new Date();
  const doomed = new Set<string>();
  if (opts.olderThanDays !== undefined) {
    const cutoff = now.getTime() - opts.olderThanDays * 86400000;
    for (const s of all) if (new Date(s.startedAt).getTime() < cutoff) doomed.add(s.file);
  }
  if (opts.keep !== undefined)
    for (const s of all.slice(Math.max(0, opts.keep))) doomed.add(s.file);
  const removed = all.filter((s) => doomed.has(s.file));
  let bytes = 0;
  for (const s of removed) {
    bytes += s.bytes;
    for (const side of s.sidecars) {
      try {
        bytes += statSync(side).size;
      } catch {}
    }
    if (opts.apply) {
      rmSync(s.file, { force: true });
      for (const side of s.sidecars) rmSync(side, { recursive: true, force: true });
    }
  }
  return { removed, kept: all.length - removed.length, bytes };
}

/** "30d" / "12h" / "90" (天) → 天数。 */
export function parseAge(s: string): number {
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*([dh]?)$/);
  if (!m)
    throw new Error(`--older-than takes a number of days like 30d (or hours like 12h), got "${s}"`);
  const n = Number(m[1]);
  return m[2] === "h" ? n / 24 : n;
}
