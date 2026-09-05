import { estimateTokens } from "../src/context.js";
import type { AgentEvent } from "../src/events.js";
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

export function messageTokens(m: Message): number {
  switch (m.role) {
    case "assistant":
      return (
        estimateTokens(m.content) +
        estimateTokens(m.reasoning ?? "") +
        m.toolCalls.reduce((n, tc) => n + estimateTokens(JSON.stringify(tc.args)) + 8, 0)
      );
    default:
      return estimateTokens(m.content);
  }
}

/** 单条事件里模型可见文本的估算 token(压缩对照用同一口径)。 */
export function eventTokens(e: AgentEvent): number {
  switch (e.type) {
    case "session/start":
      return estimateTokens(e.system);
    case "user/message":
      return estimateTokens(e.text);
    case "assistant/message":
      return (
        estimateTokens(e.text) +
        e.toolCalls.reduce((n, tc) => n + estimateTokens(JSON.stringify(tc.args)) + 8, 0)
      );
    case "tool/result":
      return estimateTokens(e.content);
    default:
      return 0;
  }
}

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

export function indent(s: string, pad = "    "): string[] {
  return s.split("\n").map((l) => pad + l);
}

export function firstLine(s: string): string {
  return s.split("\n")[0] ?? "";
}
