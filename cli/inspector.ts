// 请求检视器(Q49):按"一次 API 请求"组织的完全透明视图。
// 列表层一行一请求;详情层六个分区(概要 / 决策 / 发送 / 工具定义 / 线路 JSON / 接收),
// 每个分区在视口内滚动。行数爆炸由视口与按键控制,不靠删内容:任何一字节都能翻到。
// 数据全部来自事件日志的纯函数投影;请求正文按 deriveMessages(请求之前的事件) 原样重建,
// wire 层正文由 provider.wire 重建,与实际发送逐字节一致。
import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { estimateTokens } from "../src/context.js";
import type { AgentEvent } from "../src/events.js";
import { deriveMessages, type Message } from "../src/messages.js";
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

export const SECTIONS = ["概要", "决策", "发送", "工具定义", "线路 JSON", "接收"] as const;
export type Section = 1 | 2 | 3 | 4 | 5 | 6;

export type InspectorDeps = {
  events: () => readonly AgentEvent[];
  /** 发出该请求时用的 provider(会话中可能切换过模型);拿不到就退回内核层视图。 */
  providerFor: (requestIndex: number) => Provider | undefined;
  tools: () => ToolDef[];
  /** 可用行数(终端高度)。 */
  rows: () => number;
  /** 该请求的原始流(开了 trace 才有)。 */
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

// ---------- 列表 ----------

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
  const reason =
    rec.request.reason === "overflow-retry"
      ? "  溢出重发"
      : rec.request.reason === "compaction"
        ? "  压缩"
        : "";
  const body = `${head} ${clock(rec.request.at)}  ${model}  ${sent}  ${tail}${retry}${reason}`;
  return `${mark} ${selected ? c.bold(c.ink(body)) : c.soft(body)}`;
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? "";
}

// ---------- 六个分区 ----------

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
        lines.push(`${c.jin("◇")} 压缩:${parts.join(",")}`);
        break;
      }
      case "decision":
        lines.push(
          e.slot === "steering"
            ? `${c.jin("◇")} 插话注入 ${e.injected} 条(${e.boundary} 边界)`
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

export function sentLines(messages: Message[], folded: boolean): string[] {
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

// ---------- 组件 ----------

export class RequestInspector implements Component {
  private mode: "list" | "detail" = "list";
  private selected = 0;
  private section: Section = 1;
  private scroll = 0;
  private folded = false;
  private lastViewport = 10;

  constructor(private deps: InspectorDeps) {}

  /** 打开时回到列表并选中最新一条。 */
  reset(): void {
    this.mode = "list";
    this.section = 1;
    this.scroll = 0;
    this.selected = Math.max(0, this.records().length - 1);
  }

  get isDetail(): boolean {
    return this.mode === "detail";
  }

  records(): RequestRecord[] {
    return collectRequests(this.deps.events());
  }

  invalidate(): void {}

  handleInput(data: string): void {
    const recs = this.records();
    if (this.mode === "list") {
      if (matchesKey(data, Key.escape) || data === "q") this.deps.onClose();
      else if (matchesKey(data, Key.up) || data === "k")
        this.selected = Math.max(0, this.selected - 1);
      else if (matchesKey(data, Key.down) || data === "j")
        this.selected = Math.min(Math.max(0, recs.length - 1), this.selected + 1);
      else if (matchesKey(data, Key.home) || data === "g") this.selected = 0;
      else if (matchesKey(data, Key.end) || data === "G")
        this.selected = Math.max(0, recs.length - 1);
      else if (matchesKey(data, Key.enter) && recs.length > 0) {
        this.mode = "detail";
        this.scroll = 0;
      }
    } else {
      const page = Math.max(1, this.lastViewport - 1);
      if (matchesKey(data, Key.escape) || data === "q") {
        this.mode = "list";
        this.scroll = 0;
      } else if (matchesKey(data, Key.up) || data === "k")
        this.scroll = Math.max(0, this.scroll - 1);
      else if (matchesKey(data, Key.down) || data === "j") this.scroll += 1;
      else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - page);
      else if (matchesKey(data, Key.pageDown)) this.scroll += page;
      else if (matchesKey(data, Key.home) || data === "g") this.scroll = 0;
      else if (matchesKey(data, Key.end) || data === "G") this.scroll = Number.MAX_SAFE_INTEGER;
      else if (matchesKey(data, Key.left) || data === "h") this.switchSection(-1);
      else if (matchesKey(data, Key.right) || data === "l") this.switchSection(1);
      else if (/^[1-6]$/.test(data)) {
        this.section = Number(data) as Section;
        this.scroll = 0;
      } else if (data === "f") {
        this.folded = !this.folded;
        this.scroll = 0;
      } else if (data === "[" || data === "]") {
        // 不离开详情页切换请求。
        const step = data === "]" ? 1 : -1;
        this.selected = Math.min(Math.max(0, recs.length - 1), Math.max(0, this.selected + step));
        this.scroll = 0;
      }
    }
    this.deps.requestRender();
  }

  private switchSection(step: number): void {
    const next = this.section + step;
    this.section = (next < 1 ? 6 : next > 6 ? 1 : next) as Section;
    this.scroll = 0;
  }

  /** 当前分区的完整内容行(未按视口裁切),测试与预览用。 */
  sectionLines(rec: RequestRecord, section: Section): string[] {
    const events = this.deps.events();
    const messages = deriveMessages(events.slice(0, rec.index));
    const defs = this.deps.tools().filter((d) => rec.request.tools.includes(d.name));
    switch (section) {
      case 1:
        return summaryLines(rec, messages);
      case 2:
        return decisionLines(rec);
      case 3:
        return sentLines(messages, this.folded);
      case 4:
        return toolLines(defs);
      case 5:
        return wireLines(this.deps.providerFor(rec.index), messages, defs, rec.request.effort);
      case 6:
        return receivedLines(rec, this.deps.rawFor?.(rec.index));
    }
  }

  render(width: number): string[] {
    const w = Math.max(20, width);
    const inner = w - 2;
    const rows = Math.max(8, this.deps.rows());
    const recs = this.records();
    const rule = c.faint("─".repeat(inner));
    const pad = (s: string) => ` ${truncateToWidth(s, inner, "…", true)} `;

    if (this.mode === "list") {
      const title = `${c.bold(c.jin("请求检视"))}  ${c.soft(`${recs.length} 次请求`)}`;
      const columns = c.faint(
        "  序号  时间      模型  发送(条数 · 估算 tok)  → 实测(缓存)  +输出  耗时  停止原因",
      );
      const head = [pad(title), pad(columns), pad(rule)];
      const foot = [pad(rule), pad(c.faint("↑↓ 选择 · Enter 详情 · Esc 关闭"))];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      let body: string[];
      if (recs.length === 0) body = [pad(c.faint("尚无请求。发一条消息后再来。"))];
      else {
        // 让选中行始终可见。
        const start = Math.max(
          0,
          Math.min(this.selected - Math.floor(viewport / 2), recs.length - viewport),
        );
        body = recs
          .slice(start, start + viewport)
          .map((r, i) => pad(listRow(r, start + i === this.selected)));
      }
      while (body.length < viewport) body.push(pad(""));
      return [...head, ...body, ...foot];
    }

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
    const content = this.sectionLines(rec, this.section).flatMap((l) => wrapTextWithAnsi(l, inner));
    const footHint =
      "↑↓ 滚动 · PgUp/PgDn 翻页 · ←→ 或 1-6 切分区 · [ ] 切请求 · f 折叠正文 · Esc 返回";
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
    const foot = [pad(rule), pad(`${c.faint(footHint)}  ${c.soft(pos)}`)];
    return [...head, ...slice.map(pad), ...foot];
  }
}
