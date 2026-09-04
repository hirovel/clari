// 检视器(Q49/Q60/Q62/Q63):对事件数组的几种投影,全部只读。
//   请求视图  一行一请求 → 七分区(概要 / 决策 / 发送 / 工具定义 / 线路 JSON / 接收 / 写入)
//   事件视图  内核维护的全部事件,逐条大小与可见性 → 原样 JSON
//   压缩对照  每次压缩:被覆盖的那一大段原文 ↔ 它变成的摘要,带 token 与压缩比
//   会话切换  s 键在主会话与子 agent 会话间轮换,以上三种视图作用在选中的数组上
// 行数爆炸由视口与按键控制,不靠删内容:任何一字节都能翻到。
// 请求正文按 deriveMessages(请求之前的事件) 原样重建,wire 层正文由 provider.wire 重建,与实际发送逐字节一致。
import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { estimateTokens } from "../src/context.js";
import type { AgentEvent } from "../src/events.js";
import {
  type Composition,
  compactionState,
  composeContext,
  deriveMessages,
  editState,
  type Message,
} from "../src/messages.js";
import { type Provider, parseEffort, type ToolDef } from "../src/provider.js";
import { c } from "./theme.js";

type RequestEvent = Extract<AgentEvent, { type: "request" }>;
type AssistantEvent = Extract<AgentEvent, { type: "assistant/message" }>;
type RetryEvent = Extract<AgentEvent, { type: "retry" }>;
type RequestErrorEvent = Extract<AgentEvent, { type: "request/error" }>;
type CompactionEvent = Extract<AgentEvent, { type: "compaction" }>;

export type RequestRecord = {
  /** 从 1 起的序号。 */
  n: number;
  /** request 事件在日志中的下标。请求正文 = deriveMessages(events.slice(0, index))。 */
  index: number;
  request: RequestEvent;
  response?: AssistantEvent;
  error?: RequestErrorEvent;
  /** 摘要请求(reason=compaction)的结果:随后落盘的压缩事件。 */
  compaction?: CompactionEvent;
  retries: RetryEvent[];
  /** 上一请求收尾之后、本请求发出之前发生的事:压缩、插话注入、终止、打断、切换模型。 */
  before: AgentEvent[];
};

/** 把事件流按请求切段。纯函数。 */
export function collectRequests(events: readonly AgentEvent[]): RequestRecord[] {
  const out: RequestRecord[] = [];
  let pending: AgentEvent[] = [];
  let current: RequestRecord | undefined;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (!e) continue;
    switch (e.type) {
      case "request":
        current = { n: out.length + 1, index: i, request: e, retries: [], before: pending };
        pending = [];
        out.push(current);
        break;
      case "retry":
        current?.retries.push(e);
        break;
      case "request/error":
        if (current && !current.response) current.error = e;
        break;
      case "assistant/message":
        if (current && !current.response && !current.error) current.response = e;
        break;
      case "compaction":
        // 既是摘要请求的结果,也是下一请求之前发生的决定。
        if (current?.request.reason === "compaction" && !current.compaction && !current.error) {
          current.compaction = e;
        }
        pending.push(e);
        break;
      case "decision":
      case "session/interrupt":
      case "session/model":
      case "session/slot":
      case "context/edit":
      case "context/drop":
        pending.push(e);
        break;
      default:
        break;
    }
  }
  return out;
}

export const SECTIONS = [
  "summary",
  "decisions",
  "sent",
  "tool defs",
  "wire JSON",
  "received",
  "written",
] as const;
export type Section = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const COMPACTION_SECTIONS = ["compare", "original", "summary", "cleared"] as const;
export type CompactionSection = 1 | 2 | 3 | 4;

/** 一个可检视的数组:主会话或某个子 agent 会话。 */
export type SessionSource = { name: string; events: readonly AgentEvent[] };

export type InspectorDeps = {
  /** 主会话的事件。 */
  events: () => readonly AgentEvent[];
  /** 全部会话(主 + 子)。不给则只有主会话。 */
  sessions?: () => SessionSource[];
  /** 主会话某次请求当时的 provider;拿不到就退回内核层视图。 */
  providerFor: (requestIndex: number) => Provider | undefined;
  /** 当前 provider:子会话或恢复的会话在模型名相同时用它重建线路正文。 */
  currentProvider?: () => Provider | undefined;
  tools: () => ToolDef[];
  /** 可用行数(终端高度)。 */
  rows: () => number;
  /** 主会话某请求的原始流(开了 trace 才有)。 */
  rawFor?: (requestIndex: number) => string[] | undefined;
  /** 上下文面板里选中一条消息并选了动作(Q83)。view 由检视器自己处理,其余交给界面落到命令上。 */
  onAction?: (action: ContextAction, row: CompositionRow) => void;
  onClose: () => void;
  requestRender: () => void;
};

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

function clock(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  return d.toTimeString().slice(0, 8);
}

function messageTokens(m: Message): number {
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

function roleLabel(m: Message): string {
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

function pctOf(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : "0%";
}

function indent(s: string, pad = "    "): string[] {
  return s.split("\n").map((l) => pad + l);
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? "";
}

// ---------- 请求列表 ----------

export function listRow(rec: RequestRecord, selected: boolean): string {
  const mark = selected ? c.zhu("▸") : " ";
  const head = `#${rec.n}`.padEnd(4);
  const model = rec.request.model;
  const sent = `${rec.request.messages} msgs  ≈${fmtTok(rec.request.estimatedTokens)}`;
  let tail: string;
  if (rec.response) {
    const u = rec.response.usage;
    const measured = u
      ? `→ ${fmtTok(u.inputTokens)}${u.cacheReadTokens !== undefined ? ` (cache ${fmtTok(u.cacheReadTokens)})` : ""}  +${fmtTok(u.outputTokens)}`
      : "→ no usage";
    tail = `${measured}  ${fmtMs(rec.response.latencyMs)}  ${rec.response.stopReason}`;
  } else if (rec.compaction) {
    const u = rec.compaction.usage;
    tail = `→ ${u ? `${fmtTok(u.inputTokens)}  +${fmtTok(u.outputTokens)}` : "no usage"}  ${fmtMs(rec.compaction.latencyMs)}  summary ${rec.compaction.summary?.length ?? 0} chars`;
  } else if (rec.error) {
    tail = c.zhu(`✗ ${rec.error.status ?? ""} ${firstLine(rec.error.error)}`.trim());
  } else {
    tail = rec.request.reason === "compaction" ? "… no result" : "… in progress";
  }
  const retry = rec.retries.length > 0 ? `  retries ${rec.retries.length}` : "";
  // 请求种类放在前面:一眼分出正常步、压缩摘要、溢出重发;行尾被截断也不丢这个信息。
  const kind =
    rec.request.reason === "overflow-retry"
      ? "overflow retry  "
      : rec.request.reason === "compaction"
        ? "compaction  "
        : "";
  const body = `${head} ${clock(rec.request.at)}  ${model}  ${kind}${sent}  ${tail}${retry}`;
  return `${mark} ${selected ? c.bold(c.ink(body)) : c.soft(body)}`;
}

// ---------- 请求详情的七个分区 ----------

export function summaryLines(rec: RequestRecord, messages: Message[]): string[] {
  const r = rec.request;
  const u = rec.response?.usage ?? rec.compaction?.usage;
  const total = messages.reduce((n, m) => n + messageTokens(m), 0);
  const row = (k: string, v: string) => `${c.soft(k.padEnd(12))} ${c.ink(v)}`;
  const REASONS = {
    turn: "turn",
    "overflow-retry": "resend after overflow compaction",
    compaction:
      "summary request from the compaction strategy (the context is sent in exchange for a summary)",
  } as const;
  const lines = [
    row("time", `${r.at}`),
    row("model", r.model),
    row("reason", REASONS[r.reason]),
    row("effort", r.effort ?? "not set (omitted; provider default)"),
    row(
      "sent",
      `${r.messages} messages · ${r.tools.length} tools · estimated ${r.estimatedTokens} tok`,
    ),
  ];
  if (rec.compaction?.strategy) lines.push(row("strategy", rec.compaction.strategy));
  if (r.threshold !== undefined) {
    const room = r.threshold - r.estimatedTokens;
    lines.push(
      row(
        "auto-compact",
        room > 0
          ? `threshold ${r.threshold}, ${room} tok to go (${pctOf(room, r.threshold)})`
          : `threshold ${r.threshold}, over by ${-room} tok; compaction should have run before sending`,
      ),
    );
  }
  if (u) {
    const drift = r.estimatedTokens > 0 ? u.inputTokens / r.estimatedTokens : 0;
    lines.push(
      row(
        "measured in",
        `${u.inputTokens} tok (${Math.round(drift * 100)}% of estimate)${u.cacheReadTokens !== undefined ? ` · cache hit ${u.cacheReadTokens} tok (${pctOf(u.cacheReadTokens, u.inputTokens)})` : ""}`,
      ),
    );
    lines.push(
      row(
        "measured out",
        `${u.outputTokens} tok${u.reasoningTokens !== undefined ? ` · reasoning ${u.reasoningTokens}` : ""}`,
      ),
    );
  }
  if (rec.response) {
    lines.push(row("stop reason", rec.response.stopReason));
    lines.push(row("latency", fmtMs(rec.response.latencyMs)));
    lines.push(row("tool calls", `${rec.response.toolCalls.length}`));
  }
  if (rec.error)
    lines.push(row("failed", c.zhu(`${rec.error.status ?? ""} ${rec.error.error}`.trim())));
  lines.push(row("retries", rec.retries.length === 0 ? "none" : `${rec.retries.length}`));
  lines.push("");
  lines.push(c.soft("share by role (estimated)"));
  const byRole = new Map<string, number>();
  for (const m of messages) {
    const k = m.role === "tool" ? `tool result ${m.name}` : m.role;
    byRole.set(k, (byRole.get(k) ?? 0) + messageTokens(m));
  }
  for (const [k, v] of [...byRole.entries()].sort((a, b) => b[1] - a[1])) {
    const bar = "█".repeat(Math.max(1, Math.round((v / Math.max(1, total)) * 24))).padEnd(24);
    lines.push(`${c.jin(bar)} ${pctOf(v, total).padStart(4)}  ${c.soft(`${v} tok · ${k}`)}`);
  }
  return lines;
}

export function decisionLines(rec: RequestRecord): string[] {
  const lines: string[] = [];
  const auto = rec.request.threshold;
  if (auto !== undefined) {
    lines.push(
      rec.request.estimatedTokens > auto
        ? `${c.jin("◇")} auto-compaction check: estimated ${rec.request.estimatedTokens} > threshold ${auto}, triggered`
        : `${c.faint("·")} auto-compaction check: estimated ${rec.request.estimatedTokens} ≤ threshold ${auto}, not triggered`,
    );
  } else {
    lines.push(`${c.faint("·")} no compaction configured, not checked`);
  }
  for (const e of rec.before) {
    switch (e.type) {
      case "compaction": {
        const parts: string[] = [];
        if (e.summary !== undefined)
          parts.push(`summary covers events ${e.coversFrom ?? 1}-${e.coversUpTo}`);
        if (e.cleared?.length) parts.push(`cleared ${e.cleared.length} tool results`);
        if (e.tokensBefore !== undefined) parts.push(`${e.tokensBefore} tok before`);
        if (e.usage)
          parts.push(`summary request ${e.usage.inputTokens}→${e.usage.outputTokens} tok`);
        lines.push(
          `${c.jin("◇")} compaction${e.strategy ? ` (${e.strategy})` : ""}: ${parts.join(", ")}`,
        );
        break;
      }
      case "decision":
        lines.push(
          e.slot === "steering"
            ? `${c.jin("◇")} steering injected ${e.injected} (${e.boundary} boundary)`
            : e.slot === "execution"
              ? `${c.jin("◇")} parallel execution of ${e.parallel} calls: ${e.tools.join(", ")}`
              : `${c.jin("◇")} termination stopped the loop at step ${e.steps}: ${e.reason}`,
        );
        break;
      case "session/interrupt":
        lines.push(`${c.zhu("◇")} interrupted by the user`);
        break;
      case "session/model":
        lines.push(`${c.jin("◇")} model switched to ${e.model}`);
        break;
      case "session/slot":
        lines.push(`${c.jin("◇")} slot ${e.slot} → ${e.value}`);
        break;
      case "context/edit":
        lines.push(
          `${c.zhu("◇")} the user edited event #${e.target}.${e.field} (${e.value.length} chars${e.note ? `; ${e.note}` : ""})`,
        );
        break;
      case "context/drop":
        lines.push(
          `${c.zhu("◇")} the user dropped event #${e.target}${e.note ? ` (${e.note})` : ""}`,
        );
        break;
      default:
        break;
    }
  }
  for (const r of rec.retries) {
    lines.push(
      `${c.zhu("◇")} retry ${r.attempt}: ${r.status ?? ""} ${firstLine(r.error)}, waited ${fmtMs(r.delayMs)}`,
    );
  }
  if (rec.error) lines.push(`${c.zhu("✗")} failed: ${rec.error.status ?? ""} ${rec.error.error}`);
  if (rec.response?.stopReason === "length")
    lines.push(
      `${c.jin("◇")} output truncated: tool calls in this step are not executed; the model is asked to resend`,
    );
  if (rec.response?.stopReason === "aborted")
    lines.push(`${c.zhu("◇")} response interrupted: the partial text is in the log`);
  lines.push("");
  lines.push(c.faint("Every decision the kernel made in this step. Nothing else happened."));
  return lines;
}

export type PromptSectionMeta = { name: string; source?: string; chars: number };

export function sentLines(
  messages: Message[],
  folded: boolean,
  sections?: PromptSectionMeta[],
): string[] {
  const total = messages.reduce((n, m) => n + messageTokens(m), 0);
  const lines: string[] = [
    c.faint(
      `${messages.length} messages, estimated ${total} tok. ${folded ? "bodies folded (f to unfold)" : "full bodies (f to fold)"}`,
    ),
    "",
  ];
  messages.forEach((m, i) => {
    const tok = messageTokens(m);
    lines.push(
      `${c.jin(`[${i + 1}] ${roleLabel(m)}`)}  ${c.soft(`${tok} tok · ${pctOf(tok, total)}`)}${m.edited ? c.jin("  ✎ edited (original in the events view)") : ""}`,
    );
    // 系统提示词按段拆开(Q51):角色、环境、项目指令各占多少。
    if (m.role === "system" && sections && sections.length > 0) {
      const chars = sections.reduce((n, s) => n + s.chars, 0);
      for (const s of sections) {
        lines.push(
          c.faint(
            `    ├ ${s.name}  ${Math.ceil(s.chars / 4)} tok · ${pctOf(s.chars, chars)}${s.source ? `  ${s.source}` : ""}`,
          ),
        );
      }
    }
    if (m.role === "assistant" && m.reasoning) {
      lines.push(
        ...(folded
          ? [c.faint(`    thinking ${firstLine(m.reasoning)}`)]
          : indent(m.reasoning).map((l) => c.faint(c.italic(l)))),
      );
    }
    if (m.content) {
      lines.push(
        ...(folded
          ? [c.ink(`    ${truncateToWidth(firstLine(m.content), 120, "…")}`)]
          : indent(m.content).map((l) => c.ink(l))),
      );
    }
    if (m.role === "assistant") {
      for (const tc of m.toolCalls) {
        const args = JSON.stringify(tc.args);
        lines.push(
          c.soft(
            `    ⚙ ${tc.name} ${folded ? truncateToWidth(args, 100, "…") : args}  ${c.faint(tc.id)}`,
          ),
        );
      }
    }
    lines.push("");
  });
  return lines;
}

export function toolLines(defs: ToolDef[]): string[] {
  if (defs.length === 0) return [c.faint("No tools were sent with this request.")];
  const lines: string[] = [
    c.faint(
      `${defs.length} tool definitions sent with the request, estimated ${defs.reduce((n, d) => n + estimateTokens(JSON.stringify(d)), 0)} tok.`,
    ),
    "",
  ];
  for (const d of defs) {
    lines.push(`${c.jin(d.name)}  ${c.soft(`${estimateTokens(JSON.stringify(d))} tok`)}`);
    lines.push(...indent(d.description || "(no description)").map((l) => c.ink(l)));
    lines.push(...indent(JSON.stringify(d.parameters, null, 2)).map((l) => c.faint(l)));
    lines.push("");
  }
  return lines;
}

export function wireLines(
  provider: Provider | undefined,
  messages: Message[],
  defs: ToolDef[],
  effort?: string,
): string[] {
  if (!provider?.wire) {
    return [
      c.faint(
        "This provider has no wire(); the wire body cannot be rebuilt. The sent section shows the kernel projection.",
      ),
    ];
  }
  const level = effort ? parseEffort(effort) : undefined;
  const body = provider.wire(messages, defs, level ? { effort: level } : {});
  const json = JSON.stringify(body, null, 2);
  return [
    c.faint(
      `Request body, byte-identical to what was sent (auth headers are not part of the body). ${json.length} chars.`,
    ),
    "",
    ...json.split("\n").map((l) => c.ink(l)),
  ];
}

export function receivedLines(rec: RequestRecord, raw: string[] | undefined): string[] {
  const lines: string[] = [];
  if (rec.error && !rec.response) {
    lines.push(`${c.zhu("✗")} ${rec.error.status ?? ""} ${rec.error.error}`);
  } else if (rec.compaction) {
    const k = rec.compaction;
    lines.push(
      `${c.soft("latency")} ${c.ink(fmtMs(k.latencyMs))}   ${c.soft("covers events")} ${c.ink(`${k.coversFrom ?? 1}-${k.coversUpTo}`)}`,
    );
    if (k.usage) lines.push(`${c.soft("usage")} ${c.ink(JSON.stringify(k.usage))}`);
    lines.push("");
    lines.push(c.jin("summary (enters later requests as one user message)"));
    lines.push(...indent(k.summary ?? "(none)").map((l) => c.ink(l)));
    lines.push("");
  } else if (!rec.response) {
    lines.push(
      c.faint(
        rec.request.reason === "compaction"
          ? "The summary request produced no compaction (no progress, or the safety valve stopped it)."
          : "No response yet.",
      ),
    );
  } else {
    const r = rec.response;
    lines.push(
      `${c.soft("stop reason")} ${c.ink(r.stopReason)}   ${c.soft("latency")} ${c.ink(fmtMs(r.latencyMs))}`,
    );
    if (r.usage) lines.push(`${c.soft("usage")} ${c.ink(JSON.stringify(r.usage))}`);
    lines.push("");
    if (r.reasoning) {
      lines.push(
        c.jin(
          r.reasoningKind === "summary"
            ? "thinking (summary: shown to people only; the model reads the opaque block; not editable)"
            : r.reasoningKind === "full"
              ? "thinking (full: echoed back to the model next turn; editable)"
              : "thinking",
        ),
      );
      lines.push(...indent(r.reasoning).map((l) => c.faint(c.italic(l))));
      lines.push("");
    }
    if (r.extras && Object.keys(r.extras).length > 0) {
      lines.push(c.jin("extras (provider metadata, not interpreted)"));
      lines.push(...indent(JSON.stringify(r.extras, null, 2)).map((l) => c.faint(l)));
      lines.push("");
    }
    if (r.opaque !== undefined) {
      const o = r.opaque as { kind?: string; blocks?: unknown[]; items?: unknown[] };
      const n = o.blocks?.length ?? o.items?.length ?? 0;
      lines.push(c.jin("opaque (private echo-back)"));
      lines.push(
        c.faint(
          `    ${o.kind ?? "unknown"} · ${n} items · ${JSON.stringify(r.opaque).length} chars · echoed back verbatim next turn, never interpreted; full JSON in the written section`,
        ),
      );
      lines.push("");
    }
    lines.push(c.jin("text"));
    lines.push(...(r.text ? indent(r.text).map((l) => c.ink(l)) : [c.faint("    (empty)")]));
    lines.push("");
    if (r.toolCalls.length > 0) {
      lines.push(c.jin(`tool calls ${r.toolCalls.length}`));
      for (const tc of r.toolCalls) {
        lines.push(`    ${c.zhu("⚙")} ${c.ink(tc.name)}  ${c.faint(tc.id)}`);
        lines.push(...indent(JSON.stringify(tc.args, null, 2), "      ").map((l) => c.soft(l)));
      }
      lines.push("");
    }
  }
  lines.push(c.jin("raw stream"));
  if (!raw)
    lines.push(
      c.faint(
        "    raw capture is off (--no-trace). Restart without it to record every line received.",
      ),
    );
  else if (raw.length === 0) lines.push(c.faint("    (empty)"));
  else {
    lines.push(c.faint(`    ${raw.length} lines`));
    lines.push(...raw.map((l) => c.faint(`    ${l}`)));
  }
  return lines;
}

// ---------- 请求正文重建与写入视图 ----------

/**
 * 某次请求实际发出的消息。正常步 = 请求之前全部事件的投影;
 * 策略自己发的请求(压缩摘要)记了 body:前缀投影 + 策略追加的尾部消息,同样逐字节可重建。
 */
export function messagesFor(events: readonly AgentEvent[], rec: RequestRecord): Message[] {
  const b = rec.request.body;
  if (b) return [...deriveMessages(events.slice(0, b.prefixEvents)), ...(b.tail as Message[])];
  return deriveMessages(events.slice(0, rec.index));
}

const PROJECTED = new Set(["session/start", "user/message", "assistant/message", "tool/result"]);
const SHAPES = new Set(["compaction", "context/edit", "context/drop"]);

function visibility(e: AgentEvent): string {
  if (PROJECTED.has(e.type)) return "model-visible";
  if (SHAPES.has(e.type)) return "shapes projection";
  return "people only";
}

function jsonLines(e: AgentEvent, pad: string): string[] {
  return JSON.stringify(e, null, 2)
    .split("\n")
    .map((l) => pad + l);
}

/** 第 7 分区:这次请求之后追加进日志的事件,原样 JSON。 */
export function writtenLines(
  events: readonly AgentEvent[],
  rec: RequestRecord,
  until: number,
): string[] {
  const lines: string[] = [
    c.faint(
      `Events appended after request #${rec.n} (indices ${rec.index + 1} to ${until - 1}), raw JSON. This is all the kernel remembers.`,
    ),
    "",
  ];
  if (until <= rec.index + 1) {
    lines.push(c.faint("(none yet)"));
    return lines;
  }
  for (let i = rec.index + 1; i < until; i++) {
    const e = events[i];
    if (!e) continue;
    lines.push(
      `${c.jin(`#${i}`)} ${c.ink(e.type)}  ${c.soft(`${JSON.stringify(e).length} chars · ${visibility(e)}`)}`,
    );
    lines.push(...jsonLines(e, "    ").map((l) => c.faint(l)));
    lines.push("");
  }
  return lines;
}

/** 事件视图的一行:下标、时间、类型、大小、可见性、压缩状态。 */
export function eventRow(events: readonly AgentEvent[], i: number, selected: boolean): string {
  const e = events[i];
  if (!e) return "";
  const state = compactionState(events);
  const ed = editState(events);
  let flag = "";
  if (ed.dropped.has(i)) flag = "  dropped";
  else if (ed.edits.has(i)) flag = `  edited (${Object.keys(ed.edits.get(i) ?? {}).join(",")})`;
  else if (e.type === "tool/result" && state.cleared.has(i)) flag = "  cleared → placeholder";
  else if (state.summary && i >= state.coversFrom && i < state.coversUpTo)
    flag = "  covered by summary";
  const size = JSON.stringify(e).length;
  const body = `${`#${i}`.padEnd(5)} ${clock(e.at)}  ${e.type.padEnd(18)} ${String(size).padStart(7)} chars  ${visibility(e)}${flag}`;
  const mark = selected ? c.zhu("▸") : " ";
  const tone = selected
    ? c.bold(c.ink(body))
    : PROJECTED.has(e.type)
      ? c.soft(body)
      : c.faint(body);
  return `${mark} ${tone}`;
}

/** 单条事件的原样 JSON 视图。 */
export function eventLines(events: readonly AgentEvent[], i: number): string[] {
  const e = events[i];
  if (!e) return [c.faint("(no such event)")];
  const state = compactionState(events);
  const ed = editState(events);
  const notes: string[] = [visibility(e)];
  if (ed.dropped.has(i)) notes.push("dropped from the projection (original kept here)");
  else if (ed.edits.has(i)) {
    notes.push(
      `field ${Object.keys(ed.edits.get(i) ?? {}).join(",")} replaced by the edited value in the projection (original kept here; see the later context/edit event)`,
    );
  } else if (e.type === "tool/result" && state.cleared.has(i)) {
    notes.push("replaced by a placeholder in the projection (original kept here)");
  } else if (state.summary && i >= state.coversFrom && i < state.coversUpTo) {
    notes.push("replaced by the summary in the projection (original kept here)");
  }
  return [
    c.faint(`${JSON.stringify(e).length} chars · ${notes.join(" · ")}`),
    "",
    ...jsonLines(e, "").map((l) => c.ink(l)),
  ];
}

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

// ---------- 组装视图(Q81):模型下一步会看到的每条消息从哪来、经过了什么、落在线路的第几条 ----------

export type CompositionRow = {
  /** 投影下标(从 1 起,与发送卡、/edit N 的编号不同:那是事件下标)。 */
  i: number;
  /** 来源事件下标。 */
  event: number;
  /** 线路正文里的下标;-1 = 不在数组里(顶层 system);undefined = provider 未实现映射。 */
  wire: number | undefined;
  message: Message;
  stages: string[];
};

export function compositionRows(
  events: readonly AgentEvent[],
  provider?: Provider,
): { rows: CompositionRow[]; omitted: Composition["omitted"] } {
  const comp = composeContext(events);
  const map = provider?.wireMap?.(comp.messages);
  const rows = comp.messages.map((message, k) => ({
    i: k + 1,
    event: comp.provenance[k]?.event ?? -1,
    wire: map ? map[k] : undefined,
    message,
    stages: comp.provenance[k]?.stages ?? [],
  }));
  return { rows, omitted: comp.omitted };
}

export function compositionRow(r: CompositionRow, selected: boolean): string {
  const m = r.message;
  const tok = messageTokens(m);
  const brief =
    m.role === "assistant" && !m.content && m.toolCalls.length > 0
      ? `⚙ ${m.toolCalls.map((t) => t.name).join(" ")}`
      : firstLine(m.content);
  const wire = r.wire === undefined ? "  ?" : r.wire < 0 ? "top" : String(r.wire).padStart(3);
  const stages = r.stages.length > 0 ? r.stages.join(" ") : "";
  const body = `${String(r.i).padStart(3)}  ${`#${r.event}`.padEnd(5)} ${wire}  ${roleLabel(m).padEnd(14)} ${String(tok).padStart(6)}  ${stages.padEnd(22)} ${truncateToWidth(brief, 60, "…")}`;
  const mark = selected ? c.zhu("▸") : " ";
  const tone = selected ? c.bold(c.ink(body)) : r.stages.length > 0 ? c.jin(body) : c.soft(body);
  return `${mark} ${tone}`;
}

/** 组装视图里一条消息的全文与来历。 */
export function compositionLines(events: readonly AgentEvent[], r: CompositionRow): string[] {
  const m = r.message;
  const src = events[r.event];
  const lines = [
    `${c.soft("projection".padEnd(12))} ${c.ink(`#${r.i} of ${composeContext(events).messages.length}`)}`,
    `${c.soft("source".padEnd(12))} ${c.ink(`event #${r.event} ${src?.type ?? ""}`)}`,
    `${c.soft("wire".padEnd(12))} ${c.ink(r.wire === undefined ? "provider has no wireMap" : r.wire < 0 ? "top-level field (system)" : `messages[${r.wire}]`)}`,
    `${c.soft("stages".padEnd(12))} ${c.ink(r.stages.length > 0 ? r.stages.join(" → ") : "projection only (verbatim from the event)")}`,
    `${c.soft("tokens".padEnd(12))} ${c.ink(`≈${messageTokens(m)}`)}`,
    "",
  ];
  if (m.role === "assistant" && m.reasoning) {
    lines.push(c.jin(`reasoning (${m.reasoningKind ?? "?"})`));
    lines.push(...indent(m.reasoning).map((l) => c.faint(c.italic(l))));
    lines.push("");
  }
  lines.push(c.jin("content"));
  lines.push(...(m.content ? indent(m.content).map((l) => c.ink(l)) : [c.faint("    (empty)")]));
  if (m.role === "assistant" && m.toolCalls.length > 0) {
    lines.push("");
    lines.push(c.jin(`tool calls ${m.toolCalls.length}`));
    for (const tc of m.toolCalls)
      lines.push(c.soft(`    ⚙ ${tc.name} ${JSON.stringify(tc.args)}  ${c.faint(tc.id)}`));
  }
  if (m.role === "assistant" && m.opaque !== undefined) {
    lines.push("");
    lines.push(
      c.faint(`opaque: ${(m.opaque as { kind?: string }).kind ?? "?"} · echoed back verbatim`),
    );
  }
  return lines;
}

// ---------- 上下文面板的动作(Q83):选中一条消息,Enter 列出能做什么,每项带后果 ----------

export type ContextAction =
  | "view"
  | "edit"
  | "edit-reasoning"
  | "compare"
  | "restore"
  | "drop"
  | "rewind"
  | "retry"
  | "fork";

export type ActionItem = { action: ContextAction; label: string; hint: string };

const EDITABLE = new Set(["user/message", "assistant/message", "tool/result", "session/start"]);

/** 这条消息能做的动作。不能做的不列:没编辑过就没有 compare/restore,最后一条没有 rewind。 */
export function actionsFor(
  events: readonly AgentEvent[],
  r: CompositionRow,
  total: number,
): ActionItem[] {
  const src = events[r.event];
  const edited = editState(events).edits.has(r.event);
  const out: ActionItem[] = [
    {
      action: "view",
      label: "View full message",
      hint: "content, thinking, tool calls, provenance",
    },
  ];
  if (src && EDITABLE.has(src.type))
    out.push({
      action: "edit",
      label: "Edit content",
      hint: "opens $EDITOR; the original stays in the event",
    });
  if (src?.type === "assistant/message" && src.reasoningKind === "full")
    out.push({
      action: "edit-reasoning",
      label: "Edit thinking",
      hint: "full thinking is echoed back, so this steers the model",
    });
  if (edited) {
    out.push({
      action: "compare",
      label: "Compare with original",
      hint: "line diff, original vs current",
    });
    out.push({
      action: "restore",
      label: "Restore original",
      hint: "recorded as another edit; nothing is deleted",
    });
  }
  if (src?.type === "user/message" || src?.type === "assistant/message")
    out.push({
      action: "drop",
      label: "Drop this message",
      hint: "assistant messages take their tool results with them",
    });
  if (r.i < total)
    out.push({
      action: "rewind",
      label: "Rewind to here",
      hint: `drop everything after #${r.event}`,
    });
  out.push({
    action: "retry",
    label: "Retry last step",
    hint: "drop the last reply and ask again, no new prompt",
  });
  out.push({
    action: "fork",
    label: "Fork here",
    hint: `copy events up to #${r.event} into a new session file`,
  });
  return out;
}

/** 做了这个动作会怎样:多少条重算、缓存从哪失效、Anthropic 丢几个思考块。随选择实时变。 */
export function consequenceOf(
  action: ContextAction,
  r: CompositionRow,
  rows: CompositionRow[],
  events: readonly AgentEvent[],
  provider?: Provider,
): string {
  const after = rows.filter((x) => x.i > r.i);
  const afterTok = after.reduce((s, x) => s + messageTokens(x.message), 0);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const anthropic = provider?.fields?.protocol.startsWith("anthropic") ?? false;
  const thinking = rows.filter(
    (x) => x.i >= r.i && x.message.role === "assistant" && x.message.opaque !== undefined,
  ).length;
  const fromHere = [
    after.length > 0
      ? `${plural(after.length, "message")} after #${r.event} recomputed (${fmtTok(afterTok)} tok)`
      : `nothing after #${r.event} to recompute`,
    `cache miss from #${r.event} on`,
    ...(anthropic && thinking > 0 ? [`Anthropic drops ${plural(thinking, "thinking block")}`] : []),
  ];
  switch (action) {
    case "view":
    case "compare":
      return "read-only · nothing changes";
    case "edit":
    case "edit-reasoning":
    case "restore":
      return [...fromHere, "Retry afterwards to see the effect"].join(" · ");
    case "drop": {
      const src = events[r.event];
      const calls = src?.type === "assistant/message" ? src.toolCalls.length : 0;
      return [
        `#${r.event} leaves the projection${calls > 0 ? ` with its ${plural(calls, "tool result")}` : ""}`,
        ...fromHere,
      ].join(" · ");
    }
    case "rewind":
      return `${plural(after.length, "message")} after #${r.event} leave the projection (${fmtTok(afterTok)} tok) · the next request starts from #${r.event} · nothing is deleted`;
    case "retry":
      return "drops the last assistant reply and its tool results · asks again from the current context · no new prompt";
    case "fork":
      return `copies the first ${r.event + 1} events into a new session file · this session is untouched`;
  }
}

// ---------- 组件 ----------

type Mode =
  | "list"
  | "detail"
  | "events"
  | "event"
  | "compactions"
  | "compaction"
  | "composition"
  | "actions"
  | "message";

export class RequestInspector implements Component {
  private mode: Mode = "list";
  private sessionIndex = 0;
  private selected = 0;
  private eventSelected = 0;
  private compactionSelected = 0;
  private section: Section = 1;
  private compactionSection: CompactionSection = 1;
  private scroll = 0;
  private folded = false;
  private lastViewport = 10;
  private recCache:
    | { events: readonly AgentEvent[]; len: number; recs: RequestRecord[] }
    | undefined;
  /** 已按宽度换行的分区内容缓存;键含会话与事件数,日志一变自然失效。生产级会话动辄上千事件,不能每个按键都重算。 */
  private lineCache = new Map<string, string[]>();

  constructor(private deps: InspectorDeps) {}

  /** 打开时回到主会话的请求列表并选中最新一条。 */
  reset(): void {
    this.mode = "list";
    this.section = 1;
    this.scroll = 0;
    this.selected = Math.max(0, this.records().length - 1);
  }

  /** 直接进入事件视图(/events)。 */
  showEvents(): void {
    this.mode = "events";
    this.scroll = 0;
    this.eventSelected = Math.max(0, this.events().length - 1);
  }

  /** 直接进入压缩对照(/compactions)。 */
  showCompactions(): void {
    this.mode = "compactions";
    this.scroll = 0;
    this.compactionSelected = Math.max(0, this.compactions().length - 1);
  }

  private messageSelected = 0;
  private actionSelected = 0;

  /** 直接定位到第 n 次请求的某个分区(/raw N → 接收分区)。没有该请求返回 false。 */
  showRequest(n: number, section: Section): boolean {
    const idx = this.records().findIndex((r) => r.n === n);
    if (idx < 0) return false;
    this.sessionIndex = 0;
    this.selected = idx;
    this.section = section;
    this.mode = "detail";
    this.scroll = 0;
    return true;
  }

  /** 直接进入组装视图(Ctrl+E / /context)。 */
  showComposition(): void {
    this.mode = "composition";
    this.scroll = 0;
    this.messageSelected = Math.max(0, this.composition().rows.length - 1);
  }

  composition(): ReturnType<typeof compositionRows> {
    return compositionRows(this.events(), this.deps.currentProvider?.());
  }

  get isDetail(): boolean {
    return this.mode === "detail";
  }

  get currentMode(): Mode {
    return this.mode;
  }

  get currentSession(): number {
    return this.sessionIndex;
  }

  sessions(): SessionSource[] {
    const list = this.deps.sessions?.() ?? [];
    return list.length > 0 ? list : [{ name: "main", events: this.deps.events() }];
  }

  /** 当前选中会话的事件数组。 */
  events(): readonly AgentEvent[] {
    const list = this.sessions();
    const s = list[Math.min(this.sessionIndex, list.length - 1)];
    return s ? s.events : this.deps.events();
  }

  records(): RequestRecord[] {
    const events = this.events();
    if (this.recCache?.events !== events || this.recCache.len !== events.length) {
      this.recCache = { events, len: events.length, recs: collectRequests(events) };
    }
    return this.recCache.recs;
  }

  compactions(): CompactionRecord[] {
    return collectCompactions(this.events());
  }

  invalidate(): void {
    this.lineCache.clear();
  }

  private switchSession(): void {
    const n = this.sessions().length;
    if (n <= 1) return;
    this.sessionIndex = (this.sessionIndex + 1) % n;
    this.selected = Math.max(0, this.records().length - 1);
    this.eventSelected = Math.max(0, this.events().length - 1);
    this.compactionSelected = Math.max(0, this.compactions().length - 1);
    this.scroll = 0;
  }

  handleInput(data: string): void {
    const recs = this.records();
    const events = this.events();
    const comps = this.compactions();
    const page = Math.max(1, this.lastViewport - 1);
    const tab = data === "\t";
    const clampSel = (v: number, len: number) => Math.min(Math.max(0, len - 1), Math.max(0, v));
    const scrollKeys = (): boolean => {
      if (matchesKey(data, Key.up) || data === "k") this.scroll = Math.max(0, this.scroll - 1);
      else if (matchesKey(data, Key.down) || data === "j") this.scroll += 1;
      else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - page);
      else if (matchesKey(data, Key.pageDown)) this.scroll += page;
      else if (matchesKey(data, Key.home) || data === "g") this.scroll = 0;
      else if (matchesKey(data, Key.end) || data === "G") this.scroll = Number.MAX_SAFE_INTEGER;
      else return false;
      return true;
    };
    switch (this.mode) {
      case "list":
        if (matchesKey(data, Key.escape) || data === "q") this.deps.onClose();
        else if (tab) this.showEvents();
        else if (data === "s") this.switchSession();
        else if (matchesKey(data, Key.up) || data === "k")
          this.selected = clampSel(this.selected - 1, recs.length);
        else if (matchesKey(data, Key.down) || data === "j")
          this.selected = clampSel(this.selected + 1, recs.length);
        else if (matchesKey(data, Key.home) || data === "g") this.selected = 0;
        else if (matchesKey(data, Key.end) || data === "G")
          this.selected = Math.max(0, recs.length - 1);
        else if (matchesKey(data, Key.enter) && recs.length > 0) {
          this.mode = "detail";
          this.scroll = 0;
        }
        break;
      case "detail":
        if (matchesKey(data, Key.escape) || data === "q") {
          this.mode = "list";
          this.scroll = 0;
        } else if (scrollKeys()) {
          // 已处理
        } else if (matchesKey(data, Key.left) || data === "h") this.switchSection(-1);
        else if (matchesKey(data, Key.right) || data === "l") this.switchSection(1);
        else if (/^[1-7]$/.test(data)) {
          this.section = Number(data) as Section;
          this.scroll = 0;
        } else if (data === "f") {
          this.folded = !this.folded;
          this.scroll = 0;
        } else if (data === "[" || data === "]") {
          this.selected = clampSel(this.selected + (data === "]" ? 1 : -1), recs.length);
          this.scroll = 0;
        }
        break;
      case "events":
        if (matchesKey(data, Key.escape) || data === "q") this.deps.onClose();
        else if (tab) this.showCompactions();
        else if (data === "s") this.switchSession();
        else if (matchesKey(data, Key.up) || data === "k")
          this.eventSelected = clampSel(this.eventSelected - 1, events.length);
        else if (matchesKey(data, Key.down) || data === "j")
          this.eventSelected = clampSel(this.eventSelected + 1, events.length);
        else if (matchesKey(data, Key.pageUp))
          this.eventSelected = clampSel(this.eventSelected - page, events.length);
        else if (matchesKey(data, Key.pageDown))
          this.eventSelected = clampSel(this.eventSelected + page, events.length);
        else if (matchesKey(data, Key.home) || data === "g") this.eventSelected = 0;
        else if (matchesKey(data, Key.end) || data === "G")
          this.eventSelected = Math.max(0, events.length - 1);
        else if (matchesKey(data, Key.enter) && events.length > 0) {
          this.mode = "event";
          this.scroll = 0;
        }
        break;
      case "event":
        if (matchesKey(data, Key.escape) || data === "q") {
          this.mode = "events";
          this.scroll = 0;
        } else if (scrollKeys()) {
          // 已处理
        } else if (data === "[" || data === "]") {
          this.eventSelected = clampSel(
            this.eventSelected + (data === "]" ? 1 : -1),
            events.length,
          );
          this.scroll = 0;
        }
        break;
      case "composition": {
        const rows = this.composition().rows;
        if (matchesKey(data, Key.escape) || data === "q") this.deps.onClose();
        else if (tab) {
          this.mode = "list";
          this.scroll = 0;
        } else if (data === "s") this.switchSession();
        else if (matchesKey(data, Key.up) || data === "k")
          this.messageSelected = clampSel(this.messageSelected - 1, rows.length);
        else if (matchesKey(data, Key.down) || data === "j")
          this.messageSelected = clampSel(this.messageSelected + 1, rows.length);
        else if (matchesKey(data, Key.pageUp))
          this.messageSelected = clampSel(this.messageSelected - page, rows.length);
        else if (matchesKey(data, Key.pageDown))
          this.messageSelected = clampSel(this.messageSelected + page, rows.length);
        else if (matchesKey(data, Key.home) || data === "g") this.messageSelected = 0;
        else if (matchesKey(data, Key.end) || data === "G")
          this.messageSelected = Math.max(0, rows.length - 1);
        else if (matchesKey(data, Key.enter) && rows.length > 0) {
          this.mode = "actions";
          this.actionSelected = 0;
        }
        break;
      }
      case "actions": {
        const rows = this.composition().rows;
        const r = rows[this.messageSelected];
        const items = r ? actionsFor(events, r, rows.length) : [];
        if (matchesKey(data, Key.escape) || data === "q") this.mode = "composition";
        else if (matchesKey(data, Key.up) || data === "k")
          this.actionSelected = clampSel(this.actionSelected - 1, items.length);
        else if (matchesKey(data, Key.down) || data === "j")
          this.actionSelected = clampSel(this.actionSelected + 1, items.length);
        else if (matchesKey(data, Key.enter) && r) {
          const item = items[this.actionSelected];
          if (item?.action === "view") {
            this.mode = "message";
            this.scroll = 0;
          } else if (item) {
            this.mode = "composition";
            this.deps.onAction?.(item.action, r);
          }
        }
        break;
      }
      case "message": {
        const rows = this.composition().rows;
        if (matchesKey(data, Key.escape) || data === "q") {
          this.mode = "composition";
          this.scroll = 0;
        } else if (scrollKeys()) {
          // 已处理
        } else if (data === "[" || data === "]") {
          this.messageSelected = clampSel(
            this.messageSelected + (data === "]" ? 1 : -1),
            rows.length,
          );
          this.scroll = 0;
        }
        break;
      }
      case "compactions":
        if (matchesKey(data, Key.escape) || data === "q") this.deps.onClose();
        else if (tab) this.showComposition();
        else if (data === "s") this.switchSession();
        else if (matchesKey(data, Key.up) || data === "k")
          this.compactionSelected = clampSel(this.compactionSelected - 1, comps.length);
        else if (matchesKey(data, Key.down) || data === "j")
          this.compactionSelected = clampSel(this.compactionSelected + 1, comps.length);
        else if (matchesKey(data, Key.home) || data === "g") this.compactionSelected = 0;
        else if (matchesKey(data, Key.end) || data === "G")
          this.compactionSelected = Math.max(0, comps.length - 1);
        else if (matchesKey(data, Key.enter) && comps.length > 0) {
          this.mode = "compaction";
          this.compactionSection = 1;
          this.scroll = 0;
        }
        break;
      case "compaction":
        if (matchesKey(data, Key.escape) || data === "q") {
          this.mode = "compactions";
          this.scroll = 0;
        } else if (scrollKeys()) {
          // 已处理
        } else if (/^[1-4]$/.test(data)) {
          this.compactionSection = Number(data) as CompactionSection;
          this.scroll = 0;
        } else if (matchesKey(data, Key.left) || data === "h") {
          this.compactionSection = (
            this.compactionSection === 1 ? 4 : this.compactionSection - 1
          ) as CompactionSection;
          this.scroll = 0;
        } else if (matchesKey(data, Key.right) || data === "l") {
          this.compactionSection = (
            this.compactionSection === 4 ? 1 : this.compactionSection + 1
          ) as CompactionSection;
          this.scroll = 0;
        } else if (data === "[" || data === "]") {
          this.compactionSelected = clampSel(
            this.compactionSelected + (data === "]" ? 1 : -1),
            comps.length,
          );
          this.scroll = 0;
        }
        break;
    }
    this.deps.requestRender();
  }

  private switchSection(step: number): void {
    const next = this.section + step;
    this.section = (next < 1 ? 7 : next > 7 ? 1 : next) as Section;
    this.scroll = 0;
  }

  private providerFor(requestIndex: number): Provider | undefined {
    if (this.sessionIndex === 0) return this.deps.providerFor(requestIndex);
    const e = this.events()[requestIndex];
    const cur = this.deps.currentProvider?.();
    return e?.type === "request" && cur && e.model === cur.model ? cur : undefined;
  }

  /** 当前分区的完整内容行(未按视口裁切),测试与预览用。 */
  sectionLines(rec: RequestRecord, section: Section): string[] {
    const events = this.events();
    const messages = messagesFor(events, rec);
    const defs = this.deps.tools().filter((d) => rec.request.tools.includes(d.name));
    switch (section) {
      case 1:
        return summaryLines(rec, messages);
      case 2:
        return decisionLines(rec);
      case 3: {
        const start = events.find((e) => e.type === "session/start");
        const sections = start?.type === "session/start" ? start.sections : undefined;
        return sentLines(messages, this.folded, sections);
      }
      case 4:
        return toolLines(defs);
      case 5:
        return wireLines(this.providerFor(rec.index), messages, defs, rec.request.effort);
      case 6:
        return receivedLines(
          rec,
          this.sessionIndex === 0 ? this.deps.rawFor?.(rec.index) : undefined,
        );
      case 7: {
        const recs = this.records();
        const next = recs.find((r) => r.index > rec.index);
        return writtenLines(events, rec, next ? next.index : events.length);
      }
    }
  }

  private cached(key: string, build: () => string[]): string[] {
    const hit = this.lineCache.get(key);
    if (hit) return hit;
    if (this.lineCache.size > 64) this.lineCache.clear();
    const lines = build();
    this.lineCache.set(key, lines);
    return lines;
  }

  /** 会话选择器:多于一个会话时显示在列表类视图的头部。 */
  private sessionLine(): string | undefined {
    const list = this.sessions();
    if (list.length <= 1) return undefined;
    const items = list.map((s, i) =>
      i === this.sessionIndex ? c.jin(`▸ ${s.name}`) : c.faint(`  ${s.name}`),
    );
    return `${items.join("   ")}   ${c.faint("s switch session")}`;
  }

  render(width: number): string[] {
    const w = Math.max(20, width);
    const inner = w - 2;
    const rows = Math.max(8, this.deps.rows());
    const events = this.events();
    const rule = c.faint("─".repeat(inner));
    const pad = (s: string) => ` ${truncateToWidth(s, inner, "…", true)} `;
    const fill = (body: string[], viewport: number) => {
      while (body.length < viewport) body.push(pad(""));
      return body;
    };
    const windowStart = (sel: number, total: number, viewport: number) =>
      Math.max(0, Math.min(sel - Math.floor(viewport / 2), total - viewport));
    const sessionLine = this.sessionLine();
    const withSession = (head: string[]) =>
      sessionLine ? [head[0] as string, pad(sessionLine), ...head.slice(1)] : head;
    const cacheKey = (k: string) => `${this.sessionIndex}:${events.length}:${inner}:${k}`;

    if (this.mode === "list") {
      const recs = this.records();
      const title = `${c.bold(c.jin("Requests"))}  ${c.soft(`${recs.length} requests`)}  ${c.faint("one line per API request · Tab: events · compactions · context")}`;
      const columns = c.faint(
        "  #    time      model  sent (msgs · est. tok)  → measured (cache)  +out  latency  stop",
      );
      const head = withSession([pad(title), pad(columns), pad(rule)]);
      const foot = [
        pad(rule),
        pad(c.faint("↑↓ select · Enter details · Tab next view · s session · Esc close")),
      ];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      let body: string[];
      if (recs.length === 0) body = [pad(c.faint("No requests yet. Send a message first."))];
      else {
        const start = windowStart(this.selected, recs.length, viewport);
        body = recs
          .slice(start, start + viewport)
          .map((r, i) => pad(listRow(r, start + i === this.selected)));
      }
      return [...head, ...fill(body, viewport), ...foot];
    }

    if (this.mode === "events") {
      const title = `${c.bold(c.jin("Events"))}  ${c.soft(`${events.length} events`)}  ${c.faint("this array is the whole kernel state; the screen, the requests and what the model sees are projections of it")}`;
      const columns = c.faint("  #     time      type                  size   visibility  state");
      const head = withSession([pad(title), pad(columns), pad(rule)]);
      const foot = [
        pad(rule),
        pad(c.faint("↑↓ select · Enter raw JSON · Tab compactions · s session · Esc close")),
      ];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      const start = windowStart(this.eventSelected, events.length, viewport);
      const body = this.cached(cacheKey(`events:${start}:${this.eventSelected}`), () =>
        events
          .slice(start, start + viewport)
          .map((_, i) => pad(eventRow(events, start + i, start + i === this.eventSelected))),
      ).slice();
      return [...head, ...fill(body, viewport), ...foot];
    }

    if (this.mode === "event") {
      const e = events[this.eventSelected];
      const title = `${c.bold(c.jin(`Event #${this.eventSelected}`))}  ${c.ink(e?.type ?? "")}  ${c.faint(e ? clock(e.at) : "")}  ${c.faint(`(${this.eventSelected + 1}/${events.length})`)}`;
      const head = [pad(title), pad(rule)];
      const content = this.cached(cacheKey(`event:${this.eventSelected}`), () =>
        eventLines(events, this.eventSelected).flatMap((l) => wrapTextWithAnsi(l, inner)),
      );
      return this.scrollable(
        head,
        content,
        "↑↓ scroll · PgUp/PgDn page · [ ] prev/next · Esc back",
        rows,
        pad,
        rule,
      );
    }

    if (this.mode === "compactions") {
      const comps = this.compactions();
      const title = `${c.bold(c.jin("Compactions"))}  ${c.soft(`${comps.length} compactions`)}  ${c.faint("what became what; the original always stays in the array")}`;
      const columns = c.faint(
        "  #    time      strategy  original (events · tok) → summary tok · ratio  cleared",
      );
      const head = withSession([pad(title), pad(columns), pad(rule)]);
      const foot = [
        pad(rule),
        pad(c.faint("↑↓ select · Enter details · Tab context · s session · Esc close")),
      ];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      let body: string[];
      if (comps.length === 0)
        body = [
          pad(
            c.faint(
              "No compactions yet. Come back after the context nears the threshold, or /compact.",
            ),
          ),
        ];
      else {
        const start = windowStart(this.compactionSelected, comps.length, viewport);
        body = comps
          .slice(start, start + viewport)
          .map((r, i) => pad(compactionRow(r, start + i === this.compactionSelected)));
      }
      return [...head, ...fill(body, viewport), ...foot];
    }

    if (this.mode === "composition") {
      const { rows: crows, omitted } = this.composition();
      const total = crows.reduce((s, r) => s + messageTokens(r.message), 0);
      const title = `${c.bold(c.jin("Context"))}  ${c.soft(`${crows.length} messages · ≈${total} tok`)}  ${c.faint("what the model sees on the next request · event # is what /edit and /drop take · Tab: requests")}`;
      const columns = c.faint(
        "    #  event wire  role            tokens  stages                 preview",
      );
      const om =
        omitted.length > 0
          ? c.faint(
              `  omitted: ${omitted.filter((o) => o.reason === "covered").length} covered by the summary · ${omitted.filter((o) => o.reason === "dropped").length} dropped`,
            )
          : c.faint("  nothing omitted");
      const head = withSession([pad(title), pad(columns), pad(rule)]);
      const foot = [
        pad(rule),
        pad(om),
        pad(c.faint("↑↓ select · Enter actions · Tab requests · s session · Esc close")),
      ];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      let body: string[];
      if (crows.length === 0) body = [pad(c.faint("no messages yet"))];
      else {
        const start = windowStart(this.messageSelected, crows.length, viewport);
        body = crows
          .slice(start, start + viewport)
          .map((r, i) => pad(compositionRow(r, start + i === this.messageSelected)));
      }
      return [...head, ...fill(body, viewport), ...foot];
    }

    if (this.mode === "actions") {
      const { rows: crows } = this.composition();
      const r = crows[this.messageSelected];
      if (!r) {
        this.mode = "composition";
        return this.render(width);
      }
      const items = actionsFor(events, r, crows.length);
      const sel = Math.min(this.actionSelected, items.length - 1);
      const m = r.message;
      const title = `${c.bold(c.jin(`Message #${r.i}`))}  ${c.ink(roleLabel(m))}  ${c.soft(`event #${r.event} · ≈${messageTokens(m)} tok${m.edited ? " · edited" : ""}`)}`;
      const head = [pad(title), pad(rule)];
      const previewSrc = m.content
        ? m.content.split("\n").slice(0, 6)
        : m.role === "assistant" && m.toolCalls.length > 0
          ? m.toolCalls.map((t) => `⚙ ${t.name} ${JSON.stringify(t.args)}`)
          : ["(empty)"];
      const chosen = items[sel] as ActionItem;
      const body = [
        ...previewSrc.map((l) => pad(c.faint(`  ${truncateToWidth(l, inner - 4, "…")}`))),
        pad(""),
        pad(c.soft("Actions")),
        ...items.map((it, i) =>
          pad(
            i === sel
              ? `  ${c.jin("▸")} ${c.bold(c.ink(it.label.padEnd(24)))} ${c.faint(it.hint)}`
              : `    ${c.soft(it.label.padEnd(24))} ${c.faint(it.hint)}`,
          ),
        ),
        pad(""),
        // 后果一行说不完就换行,不截断:这是面板存在的理由。
        ...wrapTextWithAnsi(
          `${c.soft("If you do this")}  ${c.faint(consequenceOf(chosen.action, r, crows, events, this.deps.currentProvider?.()))}`,
          inner,
        ).map(pad),
      ];
      const foot = [pad(rule), pad(c.faint("↑↓ move · Enter choose · Esc back"))];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      return [...head, ...fill(body.slice(0, viewport), viewport), ...foot];
    }

    if (this.mode === "message") {
      const { rows: crows } = this.composition();
      const r = crows[this.messageSelected];
      if (!r) {
        this.mode = "composition";
        return this.render(width);
      }
      const title = `${c.bold(c.jin(`Message #${r.i}`))}  ${c.ink(roleLabel(r.message))}  ${c.faint(`event #${r.event}`)}  ${c.faint(`(${this.messageSelected + 1}/${crows.length})`)}`;
      const head = [pad(title), pad(rule)];
      const content = this.cached(cacheKey(`message:${r.event}:${r.i}`), () =>
        compositionLines(events, r).flatMap((l) => wrapTextWithAnsi(l, inner)),
      );
      return this.scrollable(
        head,
        content,
        "↑↓ scroll · PgUp/PgDn page · [ ] prev/next message · Esc back",
        rows,
        pad,
        rule,
      );
    }

    if (this.mode === "compaction") {
      const comps = this.compactions();
      const rec = comps[this.compactionSelected];
      if (!rec) {
        this.mode = "compactions";
        return this.render(width);
      }
      const tabs = COMPACTION_SECTIONS.map((name, i) => {
        const n = i + 1;
        return n === this.compactionSection
          ? c.bold(c.jin(`[${n} ${name}]`))
          : c.soft(` ${n} ${name} `);
      }).join(" ");
      const title = `${c.bold(c.jin(`Compaction #${rec.n}`))}  ${c.ink(rec.event.strategy ?? "")}  ${c.faint(clock(rec.event.at))}  ${c.faint(`(${this.compactionSelected + 1}/${comps.length})`)}`;
      const head = [pad(title), pad(tabs), pad(rule)];
      const content = this.cached(
        cacheKey(`compaction:${rec.index}:${this.compactionSection}`),
        () =>
          compactionLines(events, rec, this.compactionSection).flatMap((l) =>
            wrapTextWithAnsi(l, inner),
          ),
      );
      return this.scrollable(
        head,
        content,
        "↑↓ scroll · PgUp/PgDn · ←→ 1-4 section · [ ] compaction · Esc back",
        rows,
        pad,
        rule,
      );
    }

    const recs = this.records();
    const rec = recs[this.selected];
    if (!rec) {
      this.mode = "list";
      return this.render(width);
    }
    const tabs = SECTIONS.map((name, i) => {
      const n = i + 1;
      return n === this.section ? c.bold(c.jin(`[${n} ${name}]`)) : c.soft(` ${n} ${name} `);
    }).join(" ");
    const title = `${c.bold(c.jin(`Request #${rec.n}`))}  ${c.ink(rec.request.model)}  ${c.faint(clock(rec.request.at))}  ${c.faint(`(${this.selected + 1}/${recs.length})`)}`;
    const head = [pad(title), pad(tabs), pad(rule)];
    const content = this.cached(
      cacheKey(`detail:${rec.index}:${this.section}:${this.folded}`),
      () => this.sectionLines(rec, this.section).flatMap((l) => wrapTextWithAnsi(l, inner)),
    );
    return this.scrollable(
      head,
      content,
      "↑↓ scroll · PgUp/PgDn · ←→ 1-7 section · [ ] request · f fold · Esc back",
      rows,
      pad,
      rule,
    );
  }

  /** 带位置提示的视口:头部固定,内容按 scroll 裁切,尾部显示第几行到第几行。 */
  private scrollable(
    head: string[],
    content: string[],
    hint: string,
    rows: number,
    pad: (s: string) => string,
    rule: string,
  ): string[] {
    const viewport = Math.max(1, rows - head.length - 2);
    this.lastViewport = viewport;
    const maxScroll = Math.max(0, content.length - viewport);
    this.scroll = Math.min(this.scroll, maxScroll);
    const slice = content.slice(this.scroll, this.scroll + viewport);
    while (slice.length < viewport) slice.push("");
    const pos =
      content.length <= viewport
        ? `${content.length} lines`
        : `lines ${this.scroll + 1}-${Math.min(content.length, this.scroll + viewport)} of ${content.length}`;
    // 位置在前:窄终端截断的是按键提示,不是"第几行"。
    const foot = [pad(rule), pad(`${c.soft(pos)}  ${c.faint(hint)}`)];
    return [...head, ...slice.map(pad), ...foot];
  }
}
