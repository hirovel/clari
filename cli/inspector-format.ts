import { eventTokens, messageTokens as tokensOf } from "../src/context.js";
import type { Usage } from "../src/events.js";
import type { Message } from "../src/messages.js";

// ---------- 纯格式化 ----------

export function fmtTok(n: number | undefined): string {
  if (n === undefined) return "—";
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function clock(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toTimeString().slice(0, 8);
}

/** 检视器口径:消息大小含思考文本。 */
export function messageTokens(m: Message): number {
  return tokensOf(m, { withReasoning: true });
}

export { eventTokens };

export function roleLabel(m: Message): string {
  switch (m.role) {
    case "system":
      return "system";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
      return `tool:${m.name}${m.isError ? " ✗" : ""}`;
  }
}

export function pctOf(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : "0%";
}

/** API 只报告总量,比例尺不代表具体消息或文本位置。缺失不是零命中。 */
export function cacheUsageLines(usage: Usage | undefined, width = 60): string[] {
  const hit = usage?.cacheReadTokens;
  if (hit === undefined) return ["Cache hit: not reported"];
  const total = usage?.inputTokens ?? 0;
  if (!Number.isFinite(hit) || !Number.isFinite(total) || hit < 0 || total <= 0 || hit > total)
    return ["Cache hit: unavailable (inconsistent or empty usage)"];
  const cells = Math.max(4, Math.min(24, width - 12));
  const filled = Math.round((hit / total) * cells);
  return [
    `Cache hit: ${((hit / total) * 100).toFixed(1)}% · ${hit}/${total} input tok`,
    `hit ${"━".repeat(filled)}${"┄".repeat(cells - filled)} other`,
    "API token share; exact text spans not reported.",
  ];
}

export function indent(s: string, pad = "    "): string[] {
  return s.split("\n").map((l) => pad + l);
}

export function firstLine(s: string): string {
  return s.split("\n")[0] ?? "";
}
