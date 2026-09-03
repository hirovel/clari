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
import { compactionState, deriveMessages, type Message } from "../src/messages.js";
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
        pending.push(e);
        break;
      default:
        break;
    }
  }
  return out;
}

export const SECTIONS = ["概要", "决策", "发送", "工具定义", "线路 JSON", "接收", "写入"] as const;
export type Section = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const COMPACTION_SECTIONS = ["对照", "原文", "摘要", "清除"] as const;
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
      return `tool:${m.name}${m.isError ? "(错误)" : ""}`;
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
  const sent = `${rec.request.messages} 条消息  ≈${fmtTok(rec.request.estimatedTokens)}`;
  let tail: string;
  if (rec.response) {
    const u = rec.response.usage;
    const measured = u
      ? `→ ${fmtTok(u.inputTokens)}${u.cacheReadTokens !== undefined ? `(缓存 ${fmtTok(u.cacheReadTokens)})` : ""}  +${fmtTok(u.outputTokens)}`
      : "→ 无用量";
    tail = `${measured}  ${fmtMs(rec.response.latencyMs)}  ${rec.response.stopReason}`;
  } else if (rec.compaction) {
    const u = rec.compaction.usage;
    tail = `→ ${u ? `${fmtTok(u.inputTokens)}  +${fmtTok(u.outputTokens)}` : "无用量"}  ${fmtMs(rec.compaction.latencyMs)}  摘要 ${rec.compaction.summary?.length ?? 0} 字`;
  } else if (rec.error) {
    tail = c.zhu(`✗ ${rec.error.status ?? ""} ${firstLine(rec.error.error)}`.trim());
  } else {
    tail = rec.request.reason === "compaction" ? "… 无结果" : "… 进行中";
  }
  const retry = rec.retries.length > 0 ? `  重试 ${rec.retries.length}` : "";
  // 请求种类放在前面:一眼分出正常步、压缩摘要、溢出重发;行尾被截断也不丢这个信息。
  const kind =
    rec.request.reason === "overflow-retry"
      ? "溢出重发  "
      : rec.request.reason === "compaction"
        ? "压缩  "
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
    turn: "正常步",
    "overflow-retry": "溢出压缩后的重发",
    compaction: "压缩策略的摘要请求(整段上下文发给模型换一份摘要)",
  } as const;
  const lines = [
    row("时间", `${r.at}`),
    row("模型", r.model),
    row("原因", REASONS[r.reason]),
    row("强度", r.effort ?? "未设置(不传,用供应商默认)"),
    row("发送", `${r.messages} 条消息 · ${r.tools.length} 个工具 · 估算 ${r.estimatedTokens} tok`),
  ];
  if (rec.compaction?.strategy) lines.push(row("策略", rec.compaction.strategy));
  if (r.threshold !== undefined) {
    const room = r.threshold - r.estimatedTokens;
    lines.push(
      row(
        "自动压缩",
        room > 0
          ? `阈值 ${r.threshold},还差 ${room} tok(${pctOf(room, r.threshold)})`
          : `阈值 ${r.threshold},已超 ${-room} tok,发送前应已压缩`,
      ),
    );
  }
  if (u) {
    const drift = r.estimatedTokens > 0 ? u.inputTokens / r.estimatedTokens : 0;
    lines.push(
      row(
        "实测输入",
        `${u.inputTokens} tok(估算的 ${Math.round(drift * 100)}%)${u.cacheReadTokens !== undefined ? ` · 缓存命中 ${u.cacheReadTokens} tok(${pctOf(u.cacheReadTokens, u.inputTokens)})` : ""}`,
      ),
    );
    lines.push(
      row(
        "实测输出",
        `${u.outputTokens} tok${u.reasoningTokens !== undefined ? ` · 其中推理 ${u.reasoningTokens}` : ""}`,
      ),
    );
  }
  if (rec.response) {
    lines.push(row("停止原因", rec.response.stopReason));
    lines.push(row("耗时", fmtMs(rec.response.latencyMs)));
    lines.push(row("工具调用", `${rec.response.toolCalls.length} 个`));
  }
  if (rec.error)
    lines.push(row("失败", c.zhu(`${rec.error.status ?? ""} ${rec.error.error}`.trim())));
  lines.push(row("重试", rec.retries.length === 0 ? "无" : `${rec.retries.length} 次`));
  lines.push("");
  lines.push(c.soft("各消息占比(按估算)"));
  const byRole = new Map<string, number>();
  for (const m of messages) {
    const k = m.role === "tool" ? `工具结果 ${m.name}` : m.role;
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
        ? `${c.jin("◇")} 自动压缩检查:估算 ${rec.request.estimatedTokens} > 阈值 ${auto},触发`
        : `${c.faint("·")} 自动压缩检查:估算 ${rec.request.estimatedTokens} ≤ 阈值 ${auto},未触发`,
    );
  } else {
    lines.push(`${c.faint("·")} 未配置压缩,不检查`);
  }
  for (const e of rec.before) {
    switch (e.type) {
      case "compaction": {
        const parts: string[] = [];
        if (e.summary !== undefined)
          parts.push(`摘要覆盖事件 ${e.coversFrom ?? 1}-${e.coversUpTo}`);
        if (e.cleared?.length) parts.push(`清除 ${e.cleared.length} 条工具结果`);
        if (e.tokensBefore !== undefined) parts.push(`压缩前 ${e.tokensBefore} tok`);
        if (e.usage) parts.push(`摘要请求 ${e.usage.inputTokens}→${e.usage.outputTokens} tok`);
        lines.push(`${c.jin("◇")} 压缩${e.strategy ? `(${e.strategy})` : ""}:${parts.join(",")}`);
        break;
      }
      case "decision":
        lines.push(
          e.slot === "steering"
            ? `${c.jin("◇")} 插话注入 ${e.injected} 条(${e.boundary} 边界)`
            : e.slot === "execution"
              ? `${c.jin("◇")} 并行执行 ${e.parallel} 个调用:${e.tools.join(", ")}`
              : `${c.jin("◇")} 终止策略叫停:第 ${e.steps} 步,${e.reason}`,
        );
        break;
      case "session/interrupt":
        lines.push(`${c.zhu("◇")} 用户打断`);
        break;
      case "session/model":
        lines.push(`${c.jin("◇")} 切换模型:${e.model}`);
        break;
      default:
        break;
    }
  }
  for (const r of rec.retries) {
    lines.push(
      `${c.zhu("◇")} 重试 ${r.attempt}:${r.status ?? ""} ${firstLine(r.error)},等待 ${fmtMs(r.delayMs)} 后再试`,
    );
  }
  if (rec.error) lines.push(`${c.zhu("✗")} 最终失败:${rec.error.status ?? ""} ${rec.error.error}`);
  if (rec.response?.stopReason === "length")
    lines.push(`${c.jin("◇")} 输出被截断:本步工具调用一律不执行,回喂重发指令`);
  if (rec.response?.stopReason === "aborted")
    lines.push(`${c.zhu("◇")} 响应被打断:半截文本已入日志`);
  lines.push("");
  lines.push(c.faint("以上是内核在这一步做过的全部决定。没列出的就没发生。"));
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
      `${messages.length} 条消息,估算 ${total} tok。${folded ? "已折叠正文(f 展开)" : "完整正文(f 折叠)"}`,
    ),
    "",
  ];
  messages.forEach((m, i) => {
    const tok = messageTokens(m);
    lines.push(
      `${c.jin(`[${i + 1}] ${roleLabel(m)}`)}  ${c.soft(`${tok} tok · ${pctOf(tok, total)}`)}`,
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
          ? [c.faint(`    思考 ${firstLine(m.reasoning)}`)]
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
  if (defs.length === 0) return [c.faint("本次请求未携带工具。")];
  const lines: string[] = [
    c.faint(
      `${defs.length} 个工具定义随请求发出,估算 ${defs.reduce((n, d) => n + estimateTokens(JSON.stringify(d)), 0)} tok。`,
    ),
    "",
  ];
  for (const d of defs) {
    lines.push(`${c.jin(d.name)}  ${c.soft(`${estimateTokens(JSON.stringify(d))} tok`)}`);
    lines.push(...indent(d.description || "(无描述)").map((l) => c.ink(l)));
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
    return [c.faint("该 provider 未实现 wire(),无法重建线路层正文;发送分区展示的是内核层投影。")];
  }
  const level = effort ? parseEffort(effort) : undefined;
  const body = provider.wire(messages, defs, level ? { effort: level } : {});
  const json = JSON.stringify(body, null, 2);
  return [
    c.faint(`请求正文,与实际发送逐字节一致(鉴权头不在正文内)。${json.length} 字符。`),
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
      `${c.soft("耗时")} ${c.ink(fmtMs(k.latencyMs))}   ${c.soft("覆盖事件")} ${c.ink(`${k.coversFrom ?? 1}-${k.coversUpTo}`)}`,
    );
    if (k.usage) lines.push(`${c.soft("用量")} ${c.ink(JSON.stringify(k.usage))}`);
    lines.push("");
    lines.push(c.jin("摘要(将作为一条 user 消息进入后续请求)"));
    lines.push(...indent(k.summary ?? "(无)").map((l) => c.ink(l)));
    lines.push("");
  } else if (!rec.response) {
    lines.push(
      c.faint(
        rec.request.reason === "compaction"
          ? "摘要请求没有产生压缩(策略判定无进展或被安全阀拦下)。"
          : "尚未收到响应。",
      ),
    );
  } else {
    const r = rec.response;
    lines.push(
      `${c.soft("停止原因")} ${c.ink(r.stopReason)}   ${c.soft("耗时")} ${c.ink(fmtMs(r.latencyMs))}`,
    );
    if (r.usage) lines.push(`${c.soft("用量")} ${c.ink(JSON.stringify(r.usage))}`);
    lines.push("");
    if (r.reasoning) {
      lines.push(c.jin("思考"));
      lines.push(...indent(r.reasoning).map((l) => c.faint(c.italic(l))));
      lines.push("");
    }
    lines.push(c.jin("文本"));
    lines.push(...(r.text ? indent(r.text).map((l) => c.ink(l)) : [c.faint("    (空)")]));
    lines.push("");
    if (r.toolCalls.length > 0) {
      lines.push(c.jin(`工具调用 ${r.toolCalls.length} 个`));
      for (const tc of r.toolCalls) {
        lines.push(`    ${c.zhu("⚙")} ${c.ink(tc.name)}  ${c.faint(tc.id)}`);
        lines.push(...indent(JSON.stringify(tc.args, null, 2), "      ").map((l) => c.soft(l)));
      }
      lines.push("");
    }
  }
  lines.push(c.jin("原始流"));
  if (!raw) lines.push(c.faint("    未开启 trace。启动加 --trace 即逐行记录收到的每一行 SSE。"));
  else if (raw.length === 0) lines.push(c.faint("    (空)"));
  else {
    lines.push(c.faint(`    ${raw.length} 行`));
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

function visibility(e: AgentEvent): string {
  return PROJECTED.has(e.type) ? "模型可见" : "只给人看";
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
      `请求 #${rec.n} 发出后追加进日志的事件(下标 ${rec.index + 1} 到 ${until - 1}),原样 JSON。内核记住的就是这些,没有别的。`,
    ),
    "",
  ];
  if (until <= rec.index + 1) {
    lines.push(c.faint("(尚无)"));
    return lines;
  }
  for (let i = rec.index + 1; i < until; i++) {
    const e = events[i];
    if (!e) continue;
    lines.push(
      `${c.jin(`#${i}`)} ${c.ink(e.type)}  ${c.soft(`${JSON.stringify(e).length} 字符 · ${visibility(e)}`)}`,
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
  let flag = "";
  if (e.type === "tool/result" && state.cleared.has(i)) flag = "  已清除→占位";
  else if (state.summary && i >= state.coversFrom && i < state.coversUpTo) flag = "  已被摘要覆盖";
  const size = JSON.stringify(e).length;
  const body = `${`#${i}`.padEnd(5)} ${clock(e.at)}  ${e.type.padEnd(18)} ${String(size).padStart(7)} 字符  ${visibility(e)}${flag}`;
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
  if (!e) return [c.faint("(无此事件)")];
  const state = compactionState(events);
  const notes: string[] = [visibility(e)];
  if (e.type === "tool/result" && state.cleared.has(i)) {
    notes.push("投影时已换成占位文本(原文仍在这里)");
  } else if (state.summary && i >= state.coversFrom && i < state.coversUpTo) {
    notes.push("投影时已被摘要取代(原文仍在这里)");
  }
  return [
    c.faint(`${JSON.stringify(e).length} 字符 · ${notes.join(" · ")}`),
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
      `原文 #${rec.covered[0]}–#${rec.covered.at(-1)}(${rec.covered.length} 条 · ${fmtTok(rec.coveredTokens)} tok)→ 摘要 ${fmtTok(rec.summaryTokens)} tok · 压成 ${ratio}%`,
    );
  }
  if (rec.cleared.length > 0) {
    parts.push(`清除 ${rec.cleared.length} 条工具结果(${fmtTok(rec.clearedTokens)} tok)`);
  }
  const body = `${`#${rec.n}`.padEnd(4)} ${clock(e.at)}  ${e.strategy ?? "未署名策略"}  ${parts.join("  ")}`;
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
        head(`tool:${e.name}${e.isError ? "(错误)" : ""}`),
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
      const lines = [row("时间", e.at), row("策略", e.strategy ?? "未署名")];
      if (rec.covered.length > 0) {
        const ratio = rec.coveredTokens > 0 ? rec.summaryTokens / rec.coveredTokens : 0;
        lines.push(
          row(
            "覆盖范围",
            `事件 #${e.coversFrom ?? 1} 到 #${(e.coversUpTo ?? 0) - 1},其中模型可见 ${rec.covered.length} 条`,
          ),
          row("原文", `${rec.coveredTokens} tok`),
          row("摘要", `${rec.summaryTokens} tok`),
          row("压缩比", `${Math.round(ratio * 100)}%(摘要 / 原文)`),
        );
      }
      if (rec.cleared.length > 0) {
        lines.push(
          row(
            "清除",
            `${rec.cleared.length} 条工具结果,共 ${rec.clearedTokens} tok,投影里换成占位文本`,
          ),
        );
      }
      if (e.tokensBefore !== undefined) lines.push(row("压缩前估算", `${e.tokensBefore} tok`));
      if (e.usage)
        lines.push(
          row(
            "摘要请求",
            `${e.usage.inputTokens}→${e.usage.outputTokens} tok · ${fmtMs(e.latencyMs)}`,
          ),
        );
      lines.push("");
      if (rec.covered.length > 0) {
        const max = Math.max(rec.coveredTokens, rec.summaryTokens, 1);
        const bar = (n: number) => "█".repeat(Math.max(1, Math.round((n / max) * 30))).padEnd(30);
        lines.push(
          `${c.soft("原文")} ${c.jin(bar(rec.coveredTokens))} ${c.faint(`${rec.coveredTokens} tok`)}`,
        );
        lines.push(
          `${c.soft("摘要")} ${c.jin(bar(rec.summaryTokens))} ${c.faint(`${rec.summaryTokens} tok`)}`,
        );
        lines.push("");
      }
      lines.push(
        c.faint(
          "原文一字未删,仍在数组里;被替换的只是投影。分区 2 看原文,3 看摘要,4 看被清除的工具结果。",
        ),
      );
      return lines;
    }
    case 2: {
      if (rec.covered.length === 0) return [c.faint("这次压缩没有摘要覆盖(只做了清除)。")];
      const lines = [
        c.faint(
          `被摘要取代的 ${rec.covered.length} 条模型可见事件,${rec.coveredTokens} tok,全文。`,
        ),
        "",
      ];
      for (const k of rec.covered) lines.push(...eventBodyLines(events, k));
      return lines;
    }
    case 3: {
      if (e.summary === undefined) return [c.faint("这次压缩没有摘要。")];
      return [
        c.faint(`摘要 ${rec.summaryTokens} tok,以一条 user 消息进入此后的每次请求。`),
        "",
        ...indent(e.summary, "").map((l) => c.ink(l)),
      ];
    }
    case 4: {
      if (rec.cleared.length === 0) return [c.faint("这次压缩没有清除工具结果。")];
      const lines = [
        c.faint(
          `被换成占位文本的 ${rec.cleared.length} 条工具结果,${rec.clearedTokens} tok,原文。`,
        ),
        "",
      ];
      for (const k of rec.cleared) lines.push(...eventBodyLines(events, k));
      return lines;
    }
  }
}

// ---------- 组件 ----------

type Mode = "list" | "detail" | "events" | "event" | "compactions" | "compaction";

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
    return list.length > 0 ? list : [{ name: "主会话", events: this.deps.events() }];
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
      case "compactions":
        if (matchesKey(data, Key.escape) || data === "q") this.deps.onClose();
        else if (tab) {
          this.mode = "list";
          this.scroll = 0;
        } else if (data === "s") this.switchSession();
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
    return `${items.join("   ")}   ${c.faint("s 切换会话")}`;
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
      const title = `${c.bold(c.jin("请求检视"))}  ${c.soft(`${recs.length} 次请求`)}  ${c.faint("Tab 事件视图 · 压缩对照")}`;
      const columns = c.faint(
        "  序号  时间      模型  发送(条数 · 估算 tok)  → 实测(缓存)  +输出  耗时  停止原因",
      );
      const head = withSession([pad(title), pad(columns), pad(rule)]);
      const foot = [
        pad(rule),
        pad(c.faint("↑↓ 选择 · Enter 详情 · Tab 切视图 · s 切会话 · Esc 关闭")),
      ];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      let body: string[];
      if (recs.length === 0) body = [pad(c.faint("尚无请求。发一条消息后再来。"))];
      else {
        const start = windowStart(this.selected, recs.length, viewport);
        body = recs
          .slice(start, start + viewport)
          .map((r, i) => pad(listRow(r, start + i === this.selected)));
      }
      return [...head, ...fill(body, viewport), ...foot];
    }

    if (this.mode === "events") {
      const title = `${c.bold(c.jin("事件日志"))}  ${c.soft(`${events.length} 条`)}  ${c.faint("内核维护的全部状态就是这个数组;屏幕、请求视图、模型看到的消息都是它的投影")}`;
      const columns = c.faint("  下标  时间      类型                  大小  可见性  压缩状态");
      const head = withSession([pad(title), pad(columns), pad(rule)]);
      const foot = [
        pad(rule),
        pad(c.faint("↑↓ 选择 · Enter 原样 JSON · Tab 压缩对照 · s 切会话 · Esc 关闭")),
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
      const title = `${c.bold(c.jin(`事件 #${this.eventSelected}`))}  ${c.ink(e?.type ?? "")}  ${c.faint(e ? clock(e.at) : "")}  ${c.faint(`(${this.eventSelected + 1}/${events.length})`)}`;
      const head = [pad(title), pad(rule)];
      const content = this.cached(cacheKey(`event:${this.eventSelected}`), () =>
        eventLines(events, this.eventSelected).flatMap((l) => wrapTextWithAnsi(l, inner)),
      );
      return this.scrollable(
        head,
        content,
        "↑↓ 滚动 · PgUp/PgDn 翻页 · [ ] 上下一条 · Esc 返回",
        rows,
        pad,
        rule,
      );
    }

    if (this.mode === "compactions") {
      const comps = this.compactions();
      const title = `${c.bold(c.jin("压缩对照"))}  ${c.soft(`${comps.length} 次压缩`)}  ${c.faint("哪一大段原文变成了什么;原文永远留在数组里")}`;
      const columns = c.faint(
        "  序号  时间      策略  原文范围(条数 · tok)→ 摘要 tok · 压缩比  清除",
      );
      const head = withSession([pad(title), pad(columns), pad(rule)]);
      const foot = [
        pad(rule),
        pad(c.faint("↑↓ 选择 · Enter 对照详情 · Tab 请求视图 · s 切会话 · Esc 关闭")),
      ];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      let body: string[];
      if (comps.length === 0)
        body = [pad(c.faint("尚无压缩。上下文接近阈值或 /compact 之后再来。"))];
      else {
        const start = windowStart(this.compactionSelected, comps.length, viewport);
        body = comps
          .slice(start, start + viewport)
          .map((r, i) => pad(compactionRow(r, start + i === this.compactionSelected)));
      }
      return [...head, ...fill(body, viewport), ...foot];
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
      const title = `${c.bold(c.jin(`压缩 #${rec.n}`))}  ${c.ink(rec.event.strategy ?? "")}  ${c.faint(clock(rec.event.at))}  ${c.faint(`(${this.compactionSelected + 1}/${comps.length})`)}`;
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
        "↑↓ 滚动 · PgUp/PgDn 翻页 · ←→ 或 1-4 切分区 · [ ] 切压缩 · Esc 返回",
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
    const title = `${c.bold(c.jin(`请求 #${rec.n}`))}  ${c.ink(rec.request.model)}  ${c.faint(clock(rec.request.at))}  ${c.faint(`(${this.selected + 1}/${recs.length})`)}`;
    const head = [pad(title), pad(tabs), pad(rule)];
    const content = this.cached(
      cacheKey(`detail:${rec.index}:${this.section}:${this.folded}`),
      () => this.sectionLines(rec, this.section).flatMap((l) => wrapTextWithAnsi(l, inner)),
    );
    return this.scrollable(
      head,
      content,
      "↑↓ 滚动 · PgUp/PgDn 翻页 · ←→ 或 1-7 切分区 · [ ] 切请求 · f 折叠正文 · Esc 返回",
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
        ? `${content.length} 行`
        : `第 ${this.scroll + 1}-${Math.min(content.length, this.scroll + viewport)} 行 / ${content.length}`;
    const foot = [pad(rule), pad(`${c.faint(hint)}  ${c.soft(pos)}`)];
    return [...head, ...slice.map(pad), ...foot];
  }
}
