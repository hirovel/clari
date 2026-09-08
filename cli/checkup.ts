// 真实供应商跑过之后的对照:把内核发请求前的预测与供应商回来的实测摆在一起,再跑一组自动判据。
// 纯函数,输入是一份会话的事件数组(可选带上原始流旁路文件的覆盖情况),输出是表格行、判据与报告文本。
// 入口是 scripts/checkup.ts。判据里最要紧的是 A:没有编辑、丢弃或压缩时,上一次发出的整段消息必须是
// 这一次的前缀 —— 这是"内核不在最新消息之前插东西"在真实数据上的可证形态,也是缓存不被自己打断的保证。
import type { UsageTotals } from "../src/cost.js";
import { fmtCost } from "../src/cost.js";
import type { AgentEvent } from "../src/events.js";
import { deriveMessages, type Message } from "../src/messages.js";
import { predictedCache, unchangedPrefix } from "./cards.js";
import { collectCompactions, collectRequests } from "./inspector.js";
import { fmtMs, fmtTok } from "./inspector-format.js";

export type CheckupRow = {
  n: number;
  reason: string;
  model: string;
  msgs: number;
  /** 发送前的估算(与自动压缩检查同一口径,不含工具定义)。 */
  est: number;
  /** 供应商实测。 */
  inTok: number | undefined;
  cacheRead: number | undefined;
  cacheWrite: number | undefined;
  out: number | undefined;
  /** 发送前算的缓存命中上限:未变前缀的估算 token。 */
  predicted: number;
  /** 未变前缀的消息条数,与上一次发出的条数。 */
  keep: number;
  prevLen: number;
  /** 这一请求之前发生过编辑、丢弃或压缩:前缀本来就该断。 */
  changedBefore: boolean;
  latencyMs: number | undefined;
  retries: number;
  stop: string | undefined;
  error: string | undefined;
  /** 现在从日志重投出来的条数;与请求事件记的条数不同就说明日志重建不出当时发的东西。 */
  rebuilt: number;
  /** 随请求发出的工具名,逗号相接;估算差额按它分组。 */
  tools: string;
};

export type Check = {
  id: string;
  title: string;
  status: "pass" | "fail" | "skip";
  detail: string;
};

export type Checkup = {
  rows: CheckupRow[];
  checks: Check[];
  models: string[];
  requests: number;
  compactions: number;
  toolCalls: number;
  /** 会话跨越的分钟数。 */
  minutes: number;
};

export type TraceInfo = { lines: number; requests: number[] };

const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
};

export function analyze(events: readonly AgentEvent[], trace?: TraceInfo): Checkup {
  const records = collectRequests(events);
  const compactions = collectCompactions(events);
  const rows: CheckupRow[] = [];
  let lastSent: Message[] | undefined;
  for (const rec of records) {
    const messages = deriveMessages(events.slice(0, rec.index));
    const keep = unchangedPrefix(lastSent, messages);
    const usage = rec.response?.usage ?? rec.compaction?.usage;
    // 策略自己发的请求(摘要)不是纯投影:请求事件记了差异部分,按它重建。
    const body = rec.request.body;
    const rebuilt = body
      ? deriveMessages(events.slice(0, body.prefixEvents)).length + body.tail.length
      : messages.length;
    rows.push({
      n: rec.n,
      reason: rec.request.reason,
      model: rec.request.model,
      msgs: rec.request.messages,
      est: rec.request.estimatedTokens,
      inTok: usage?.inputTokens,
      cacheRead: usage?.cacheReadTokens,
      cacheWrite: usage?.cacheWriteTokens,
      out: usage?.outputTokens,
      predicted: lastSent ? predictedCache(lastSent, messages, keep) : 0,
      keep,
      prevLen: lastSent?.length ?? 0,
      changedBefore: rec.before.some(
        (e) => e.type === "context/edit" || e.type === "context/drop" || e.type === "compaction",
      ),
      latencyMs: rec.response?.latencyMs ?? rec.compaction?.latencyMs,
      retries: rec.retries.length,
      stop: rec.response?.stopReason,
      error: rec.error ? `${rec.error.kind ?? ""} ${rec.error.status ?? ""}`.trim() : undefined,
      rebuilt,
      tools: rec.request.tools.join(","),
    });
    // 与界面同一条规则:摘要请求不更新"上一次发出的消息"。
    if (rec.request.reason !== "compaction") lastSent = messages;
  }

  const checks: Check[] = [];
  const add = (id: string, title: string, status: Check["status"], detail: string) =>
    checks.push({ id, title, status, detail });

  // A 前缀不变量:没有编辑、丢弃或压缩时,上一次发出的整段消息必须是这一次的前缀。
  {
    const eligible = rows.filter((r) => r.prevLen > 0 && !r.changedBefore && r.reason === "turn");
    const broken = eligible.filter((r) => r.keep < r.prevLen);
    add(
      "A",
      "prefix invariant: nothing is inserted before the newest message",
      eligible.length === 0 ? "skip" : broken.length === 0 ? "pass" : "fail",
      eligible.length === 0
        ? "no consecutive plain turns to compare"
        : broken.length === 0
          ? `${eligible.length} turns kept the whole previous body as their prefix`
          : `requests ${broken.map((r) => `#${r.n} (kept ${r.keep} of ${r.prevLen})`).join(", ")} recomputed without an edit, drop or compaction`,
    );
  }

  // B 日志能重建发出去的东西:请求事件记的消息条数,必须等于现在从日志重投出来的条数。
  {
    const off = rows.filter((r) => r.rebuilt !== r.msgs);
    add(
      "B",
      "the log rebuilds the request that was sent",
      rows.length === 0 ? "skip" : off.length === 0 ? "pass" : "fail",
      rows.length === 0
        ? "no requests"
        : off.length === 0
          ? `${rows.length} requests rebuild to the same message count they were sent with`
          : `requests ${off.map((r) => `#${r.n} (sent ${r.msgs}, rebuilds to ${r.rebuilt})`).join(", ")} cannot be rebuilt from the log`,
    );
  }

  // C 估算口径:实测减估算的差主要是工具定义,同一套工具下应当稳定。
  {
    const groups = new Map<string, CheckupRow[]>();
    for (const r of rows) {
      if (r.inTok === undefined) continue;
      const g = groups.get(r.tools) ?? [];
      g.push(r);
      groups.set(r.tools, g);
    }
    const outliers: string[] = [];
    const notes: string[] = [];
    for (const [tools, g] of groups) {
      const m = median(g.map((r) => (r.inTok as number) - r.est));
      if (g.length < 3) {
        notes.push(
          `${g.length} request${g.length === 1 ? "" : "s"} with ${tools.split(",").filter(Boolean).length} tools: gap ≈${fmtTok(Math.round(m))} (too few to judge)`,
        );
        continue;
      }
      const count = tools.split(",").filter(Boolean).length;
      notes.push(`${g.length} requests with ${count} tools: gap ≈${fmtTok(Math.round(m))}`);
      for (const r of g) {
        const gap = (r.inTok as number) - r.est;
        if (Math.abs(gap - m) > Math.max(500, Math.abs(m) * 0.3)) {
          outliers.push(`#${r.n} (gap ${fmtTok(gap)} vs ≈${fmtTok(Math.round(m))})`);
        }
      }
    }
    add(
      "C",
      "token estimate: measured minus estimated is stable per tool set",
      groups.size === 0 ? "skip" : outliers.length === 0 ? "pass" : "fail",
      groups.size === 0
        ? "no usage reported"
        : `${notes.join(" · ")}${outliers.length > 0 ? ` · off: ${outliers.join(", ")}` : ""}`,
    );
  }

  // D 缓存:供应商报了命中数时,实测不该超过预测上限,且大多数步该拿到预测的一半以上。
  {
    const reported = rows.filter((r) => r.cacheRead !== undefined && r.predicted >= 1024);
    const over = reported.filter((r) => (r.cacheRead as number) > r.predicted * 1.25);
    const half = reported.filter((r) => (r.cacheRead as number) >= r.predicted * 0.5);
    const status: Check["status"] =
      reported.length === 0
        ? "skip"
        : over.length > 0
          ? "fail"
          : half.length / reported.length >= 0.7
            ? "pass"
            : "fail";
    add(
      "D",
      "prompt cache: measured hits track the prediction",
      status,
      reported.length === 0
        ? "the provider reported no cache reads on any request with a prefix over 1k"
        : over.length > 0
          ? `requests ${over.map((r) => `#${r.n}`).join(", ")} report more cache than the unchanged prefix can explain`
          : `${half.length} of ${reported.length} requests hit at least half of the prediction`,
    );
  }

  // E 压缩:压缩之后的下一次请求,发出的规模必须比压缩之前小。
  {
    const turns = records
      .filter((rec) => rec.request.reason !== "compaction")
      .map((rec) => ({ index: rec.index, row: rows.find((r) => r.n === rec.n) as CheckupRow }));
    const pairs: { before: CheckupRow; after: CheckupRow }[] = [];
    for (const cmp of compactions) {
      const before = [...turns].reverse().find((t) => t.index < cmp.index);
      const after = turns.find((t) => t.index > cmp.index);
      if (before && after) pairs.push({ before: before.row, after: after.row });
    }
    const bad = pairs.filter((p) => p.after.est >= p.before.est);
    add(
      "E",
      "compaction actually shrinks the next request",
      pairs.length === 0 ? "skip" : bad.length === 0 ? "pass" : "fail",
      pairs.length === 0
        ? "no compaction with a request on both sides"
        : pairs
            .map(
              (p) =>
                `${fmtTok(p.before.est)} → ${fmtTok(p.after.est)}${p.after.est >= p.before.est ? " (no drop)" : ""}`,
            )
            .join(" · "),
    );
  }

  // F 失败恢复:每次失败之后要么后来有成功的请求,要么它就是会话末尾。
  {
    const failed = rows.filter((r) => r.error);
    const unrecovered = failed.filter((r) => !rows.some((x) => x.n > r.n && x.stop && !x.error));
    add(
      "F",
      "every failed request either recovered or ended the session",
      failed.length === 0 ? "skip" : unrecovered.length === 0 ? "pass" : "fail",
      failed.length === 0
        ? "no request failed"
        : `${failed.length} failed (${[...new Set(failed.map((r) => r.error))].join(", ")})${unrecovered.length > 0 ? `, ${unrecovered.map((r) => `#${r.n}`).join(", ")} never recovered` : ""}`,
    );
  }

  // G 工具:错误率过高说明描述或参数形状有问题,不是模型的错。
  const toolResults = events.filter(
    (e): e is Extract<AgentEvent, { type: "tool/result" }> => e.type === "tool/result",
  );
  {
    const rate =
      toolResults.length === 0
        ? 0
        : toolResults.filter((e) => e.isError).length / toolResults.length;
    const byTool = new Map<string, { n: number; bad: number; ms: number[] }>();
    for (const e of toolResults) {
      const b = byTool.get(e.name) ?? { n: 0, bad: 0, ms: [] };
      b.n += 1;
      if (e.isError) b.bad += 1;
      if (e.durationMs !== undefined) b.ms.push(e.durationMs);
      byTool.set(e.name, b);
    }
    add(
      "G",
      "tool calls succeed",
      toolResults.length === 0 ? "skip" : rate <= 0.3 ? "pass" : "fail",
      toolResults.length === 0
        ? "no tool was called"
        : [...byTool]
            .map(
              ([name, b]) =>
                `${name} ${b.n}${b.bad > 0 ? ` (${b.bad} failed)` : ""}${b.ms.length > 0 ? ` ${fmtMs(Math.round(median(b.ms)))}` : ""}`,
            )
            .join(" · "),
    );
  }

  // H 思考回传:全文思考的模型,带工具调用的回复应当每条都带思考,缺了就是回传链断了。
  {
    const assistants = events.filter(
      (e): e is Extract<AgentEvent, { type: "assistant/message" }> =>
        e.type === "assistant/message",
    );
    const full = assistants.filter((e) => e.reasoningKind === "full");
    const withCalls = assistants.filter((e) => e.toolCalls.length > 0);
    const carried = withCalls.filter((e) => e.reasoning);
    const kinds = [...new Set(assistants.map((e) => e.reasoningKind ?? "none"))].join(", ");
    add(
      "H",
      "thinking is carried back on tool-calling replies",
      full.length === 0
        ? "skip"
        : withCalls.length === 0 || carried.length === withCalls.length
          ? "pass"
          : "fail",
      full.length === 0
        ? `no full thinking in this session (kinds: ${kinds})`
        : `${carried.length} of ${withCalls.length} tool-calling replies carry thinking · kinds: ${kinds}`,
    );
  }

  // I 原始流:开了 trace 就该有旁路文件,且覆盖每一次请求。
  add(
    "I",
    "raw stream recorded",
    trace === undefined ? "skip" : trace.requests.length >= records.length ? "pass" : "fail",
    trace === undefined
      ? "no trace sidecar next to this session; the UI writes one unless trace is off, one-shot mode never does"
      : `${trace.lines} lines covering ${trace.requests.length} of ${records.length} requests`,
  );

  const firstAt = events[0]?.at;
  const lastAt = events.at(-1)?.at;
  return {
    rows,
    checks,
    models: [...new Set(rows.map((r) => r.model))],
    requests: records.length,
    compactions: compactions.length,
    toolCalls: toolResults.length,
    minutes:
      firstAt && lastAt ? (new Date(lastAt).getTime() - new Date(firstAt).getTime()) / 60000 : 0,
  };
}

const pad = (s: string | number, n: number) => String(s).padStart(n);
const padEnd = (s: string | number, n: number) => String(s).padEnd(n);

/** 报告文本。不带颜色:这份输出是要贴回对话里看的。 */
export function reportLines(
  file: string,
  eventCount: number,
  c: Checkup,
  totals: UsageTotals,
): string[] {
  const out: string[] = [
    "",
    file,
    `${eventCount} events · ${c.requests} requests · ${c.compactions} compactions · ${c.toolCalls} tool calls · ${c.models.join(", ")} · ${c.minutes.toFixed(1)} min`,
    `${fmtTok(totals.inputTokens)} in (${fmtTok(totals.cacheReadTokens)} cached${totals.cacheWriteTokens > 0 ? `, ${fmtTok(totals.cacheWriteTokens)} written` : ""}) · ${fmtTok(totals.outputTokens)} out${totals.cost !== undefined ? ` · ${fmtCost(totals.cost)}` : " · no price configured"}`,
    "",
    "  #  reason          msgs    est  measured    gap   cache (predicted)  out  latency  stop",
    `  ${"─".repeat(88)}`,
  ];
  for (const r of c.rows) {
    const gap = r.inTok === undefined ? "—" : fmtTok(r.inTok - r.est);
    const cache =
      r.cacheRead === undefined
        ? `— (${fmtTok(r.predicted)})`
        : `${fmtTok(r.cacheRead)} (${fmtTok(r.predicted)})`;
    const prefix = r.prevLen > 0 && r.keep < r.prevLen ? `  prefix ${r.keep}/${r.prevLen}` : "";
    out.push(
      `  ${pad(r.n, 2)}  ${padEnd(r.reason, 14)} ${pad(r.msgs, 4)} ${pad(fmtTok(r.est), 6)} ${pad(r.inTok === undefined ? "—" : fmtTok(r.inTok), 9)} ${pad(gap, 6)} ${pad(cache, 19)} ${pad(r.out === undefined ? "—" : fmtTok(r.out), 4)} ${pad(fmtMs(r.latencyMs), 8)}  ${r.error ? `✗ ${r.error}` : (r.stop ?? "—")}${r.retries > 0 ? `  retries ${r.retries}` : ""}${prefix}`,
    );
  }
  out.push("");
  for (const k of c.checks) {
    out.push(
      `  ${k.status === "pass" ? "PASS" : k.status === "fail" ? "FAIL" : "····"}  ${k.id}  ${k.title}`,
    );
    out.push(`        ${k.detail}`);
  }
  const failed = c.checks.filter((k) => k.status === "fail").length;
  out.push(
    "",
    `${c.checks.filter((k) => k.status === "pass").length} passed · ${failed} failed · ${c.checks.filter((k) => k.status === "skip").length} not applicable`,
    "",
  );
  return out;
}
