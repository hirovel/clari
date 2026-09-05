import { estimateTokens } from "../src/context.js";
import type { AgentEvent } from "../src/events.js";
import { clock, eventTokens, fmtMs, fmtTok, indent } from "./inspector-format.js";
import { PROJECTED } from "./inspector-requests.js";
import { c } from "./theme.js";

type CompactionEvent = Extract<AgentEvent, { type: "compaction" }>;

export const COMPACTION_SECTIONS = ["compare", "original", "summary", "cleared"] as const;
export type CompactionSection = 1 | 2 | 3 | 4;

// ---------- 压缩对照(Q63):哪一大段变成了什么 ----------

export type CompactionRecord = {
  n: number;
  /** compaction 事件的下标。 */
  index: number;
  event: CompactionEvent;
  /** 被摘要覆盖的、模型可见的事件下标。 */
  covered: number[];
  coveredTokens: number;
  summaryTokens: number;
  /** 被清除的工具结果下标。 */
  cleared: number[];
  clearedTokens: number;
};

/** 把每次压缩与它覆盖的原文配对。原文永远留在数组里,这里只是把对应关系算出来。 */
export function collectCompactions(events: readonly AgentEvent[]): CompactionRecord[] {
  const out: CompactionRecord[] = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e?.type !== "compaction") continue;
    const covered: number[] = [];
    if (e.summary !== undefined) {
      const from = e.coversFrom ?? 1;
      const upTo = e.coversUpTo ?? 0;
      for (let k = from; k < upTo; k++) {
        const x = events[k];
        if (x && PROJECTED.has(x.type)) covered.push(k);
      }
    }
    const cleared = (e.cleared ?? []).filter((k) => events[k]?.type === "tool/result");
    const tokensOf = (idx: number[]) =>
      idx.reduce((n, k) => {
        const x = events[k];
        return n + (x ? eventTokens(x) : 0);
      }, 0);
    out.push({
      n: out.length + 1,
      index: i,
      event: e,
      covered,
      coveredTokens: tokensOf(covered),
      summaryTokens: e.summary ? estimateTokens(e.summary) : 0,
      cleared,
      clearedTokens: tokensOf(cleared),
    });
  }
  return out;
}

export function compactionRow(rec: CompactionRecord, selected: boolean): string {
  const e = rec.event;
  const parts: string[] = [];
  if (rec.covered.length > 0) {
    const ratio =
      rec.coveredTokens > 0 ? Math.round((rec.summaryTokens / rec.coveredTokens) * 100) : 0;
    parts.push(
      `original #${rec.covered[0]}–#${rec.covered.at(-1)} (${rec.covered.length} events · ${fmtTok(rec.coveredTokens)} tok) → summary ${fmtTok(rec.summaryTokens)} tok · ${ratio}%`,
    );
  }
  if (rec.cleared.length > 0) {
    parts.push(`cleared ${rec.cleared.length} tool results (${fmtTok(rec.clearedTokens)} tok)`);
  }
  const body = `${`#${rec.n}`.padEnd(4)} ${clock(e.at)}  ${e.strategy ?? "unnamed strategy"}  ${parts.join("  ")}`;
  return `${selected ? c.zhu("▸") : " "} ${selected ? c.bold(c.ink(body)) : c.soft(body)}`;
}

function eventBodyLines(events: readonly AgentEvent[], i: number): string[] {
  const e = events[i];
  if (!e) return [];
  const head = (label: string) =>
    `${c.jin(`#${i}`)} ${c.ink(label)}  ${c.soft(`${eventTokens(e)} tok`)}`;
  switch (e.type) {
    case "user/message":
      return [head("user"), ...indent(e.text).map((l) => c.ink(l)), ""];
    case "assistant/message": {
      const lines = [head("assistant")];
      if (e.reasoning) lines.push(...indent(e.reasoning).map((l) => c.faint(c.italic(l))));
      if (e.text) lines.push(...indent(e.text).map((l) => c.ink(l)));
      for (const tc of e.toolCalls) {
        lines.push(c.soft(`    ⚙ ${tc.name} ${JSON.stringify(tc.args)}`));
      }
      lines.push("");
      return lines;
    }
    case "tool/result":
      return [
        head(`tool:${e.name}${e.isError ? " ✗" : ""}`),
        ...indent(e.content).map((l) => c.faint(l)),
        "",
      ];
    case "session/start":
      return [head("system"), ...indent(e.system).map((l) => c.ink(l)), ""];
    default:
      return [];
  }
}

export function compactionLines(
  events: readonly AgentEvent[],
  rec: CompactionRecord,
  section: CompactionSection,
): string[] {
  const e = rec.event;
  switch (section) {
    case 1: {
      const row = (k: string, v: string) => `${c.soft(k.padEnd(12))} ${c.ink(v)}`;
      const lines = [row("time", e.at), row("strategy", e.strategy ?? "unnamed")];
      if (rec.covered.length > 0) {
        const ratio = rec.coveredTokens > 0 ? rec.summaryTokens / rec.coveredTokens : 0;
        lines.push(
          row(
            "covers",
            `events #${e.coversFrom ?? 1} to #${(e.coversUpTo ?? 0) - 1}, ${rec.covered.length} model-visible`,
          ),
          row("original", `${rec.coveredTokens} tok`),
          row("summary", `${rec.summaryTokens} tok`),
          row("ratio", `${Math.round(ratio * 100)}% (summary / original)`),
        );
      }
      if (rec.cleared.length > 0) {
        lines.push(
          row(
            "cleared",
            `${rec.cleared.length} tool results, ${rec.clearedTokens} tok, replaced by placeholders in the projection`,
          ),
        );
      }
      if (e.tokensBefore !== undefined) lines.push(row("before", `${e.tokensBefore} tok`));
      if (e.usage)
        lines.push(
          row(
            "summary request",
            `${e.usage.inputTokens}→${e.usage.outputTokens} tok · ${fmtMs(e.latencyMs)}`,
          ),
        );
      lines.push("");
      if (rec.covered.length > 0) {
        const max = Math.max(rec.coveredTokens, rec.summaryTokens, 1);
        const bar = (n: number) => "█".repeat(Math.max(1, Math.round((n / max) * 30))).padEnd(30);
        lines.push(
          `${c.soft("original")} ${c.jin(bar(rec.coveredTokens))} ${c.faint(`${rec.coveredTokens} tok`)}`,
        );
        lines.push(
          `${c.soft("summary ")} ${c.jin(bar(rec.summaryTokens))} ${c.faint(`${rec.summaryTokens} tok`)}`,
        );
        lines.push("");
      }
      lines.push(
        c.faint(
          "Nothing was deleted; the original is still in the array. Only the projection changed. Section 2 original, 3 summary, 4 cleared tool results.",
        ),
      );
      return lines;
    }
    case 2: {
      if (rec.covered.length === 0)
        return [c.faint("This compaction has no summary (clear only).")];
      const lines = [
        c.faint(
          `The ${rec.covered.length} model-visible events the summary replaced, ${rec.coveredTokens} tok, in full.`,
        ),
        "",
      ];
      for (const k of rec.covered) lines.push(...eventBodyLines(events, k));
      return lines;
    }
    case 3: {
      if (e.summary === undefined) return [c.faint("This compaction has no summary.")];
      return [
        c.faint(
          `Summary, ${rec.summaryTokens} tok; enters every later request as one user message.`,
        ),
        "",
        ...indent(e.summary, "").map((l) => c.ink(l)),
      ];
    }
    case 4: {
      if (rec.cleared.length === 0) return [c.faint("This compaction cleared no tool results.")];
      const lines = [
        c.faint(
          `The ${rec.cleared.length} tool results replaced by placeholders, ${rec.clearedTokens} tok, original text.`,
        ),
        "",
      ];
      for (const k of rec.cleared) lines.push(...eventBodyLines(events, k));
      return lines;
    }
  }
}
