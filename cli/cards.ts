// 主屏的两张卡(可见性的核心):每次请求发出前一张"发送卡",响应回来一张"接收卡"。
// 发送卡回答"这次到底发了什么":参数、系统提示词、工具、相对上一次新增了哪些消息、合计;
// 接收卡回答"这次到底收到了什么":停止原因、耗时、实测用量与缓存命中、费用,然后是思考 / 文本 / 调用 / 回传物各块。
// 全部是纯函数,输入就是事件与投影;不重复已经在屏幕上的正文,只标结构与差异。
import { estimateTokens } from "../src/context.js";
import { costOf, fmtCost, type Price } from "../src/cost.js";
import type { AgentEvent } from "../src/events.js";
import type { Message } from "../src/messages.js";
import type { ToolDef } from "../src/provider.js";
import { fmtMs, fmtTok } from "./inspector.js";
import { c } from "./theme.js";

type RequestEvent = Extract<AgentEvent, { type: "request" }>;
type AssistantEvent = Extract<AgentEvent, { type: "assistant/message" }>;

/** 卡片的左缘。头行用泥金,内容行用淡色;不画框,靠这一道竖线分块。 */
export const BAR = "▎";
const head = (s: string) => `${c.jin(BAR)} ${c.bold(c.jin(s))}`;
const row = (label: string, s: string) => `${c.jin(BAR)} ${c.soft(label.padEnd(4))} ${c.faint(s)}`;

function firstLine(s: string, max = 56): string {
  const l = s.split("\n").find((x) => x.trim()) ?? "";
  return l.length > max ? `${l.slice(0, max)}…` : l;
}

function messageTokens(m: Message): number {
  const base = estimateTokens(m.content);
  return m.role === "assistant"
    ? base + m.toolCalls.reduce((n, tc) => n + estimateTokens(JSON.stringify(tc.args)) + 8, 0)
    : base;
}

/** 请求正文里除消息与工具之外的顶层参数,压成一行:布尔 true 只写键名,对象压成紧凑 JSON。 */
export function paramsLine(wire: unknown): string {
  if (!wire || typeof wire !== "object") return "(该 provider 未实现 wire,参数不可见)";
  // model 已在头行;消息与工具各有自己的行。
  const skip = new Set(["model", "messages", "input", "tools", "system", "instructions"]);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(wire as Record<string, unknown>)) {
    if (skip.has(k)) continue;
    if (v === true) parts.push(k);
    else if (v === null || typeof v !== "object") parts.push(`${k} ${String(v)}`);
    else {
      const j = JSON.stringify(v);
      parts.push(`${k} ${j.length > 60 ? `${j.slice(0, 60)}…` : j}`);
    }
  }
  return parts.join(" · ") || "(无)";
}

/** 相同前缀有多长:逐条比 JSON。缓存命中的上限就是它。 */
export function unchangedPrefix(prev: Message[] | undefined, cur: Message[]): number {
  if (!prev) return 0;
  let i = 0;
  while (i < prev.length && i < cur.length && JSON.stringify(prev[i]) === JSON.stringify(cur[i]))
    i++;
  return i;
}

export type SendCardInput = {
  n: number;
  request: RequestEvent;
  /** 这次实际发出的消息。 */
  messages: Message[];
  /** 上一次正常步发出的消息;没有就是第一次。 */
  previous?: Message[];
  /** provider.wire 的返回;没有就说明参数不可见。 */
  wire?: unknown;
  defs: ToolDef[];
  /** 系统提示词分段(来自 session/start)。 */
  sections?: { name: string; source?: string; chars: number }[];
  /** 工具集与上次相同。 */
  toolsUnchanged: boolean;
  /** 该 provider 在编辑点之后丢弃思考块(Anthropic)。 */
  dropsThinking?: boolean;
};

/** 发送卡算出的、给接收卡对照用的预计值。 */
export function predictedCache(previous: Message[] | undefined, messages: Message[]): number {
  const keep = unchangedPrefix(previous, messages);
  return messages.slice(0, keep).reduce((s, m) => s + messageTokens(m), 0);
}

export function sendCardLines(input: SendCardInput): string[] {
  const { n, request: r, messages, defs } = input;
  const kind =
    r.reason === "compaction"
      ? "压缩摘要请求"
      : r.reason === "overflow-retry"
        ? "溢出压缩后重发"
        : "正常步";
  const lines: string[] = [
    head(`发送 #${n}  ${r.model}  ${kind}${r.effort ? `  强度 ${r.effort}` : ""}`),
  ];
  lines.push(row("参数", paramsLine(input.wire)));

  const sys = messages.find((m) => m.role === "system");
  if (sys) {
    const secs = input.sections ?? [];
    const total = estimateTokens(sys.content);
    const detail =
      secs.length > 0
        ? secs
            .map(
              (s) =>
                `${s.name} ${fmtTok(Math.ceil(s.chars / 4))}${s.source ? `(${s.source.split(/[\\/]/).pop()})` : ""}`,
            )
            .join(" · ")
        : firstLine(sys.content);
    lines.push(row("系统", `${fmtTok(total)} tok${input.previous ? " 未变" : ""} · ${detail}`));
  }

  if (defs.length > 0) {
    const defTok = defs.reduce((s, d) => s + estimateTokens(JSON.stringify(d)), 0);
    lines.push(
      row(
        "工具",
        `${defs.length} 个 ${fmtTok(defTok)} tok${input.toolsUnchanged ? " 未变" : ""} · ${defs.map((d) => d.name).join(" ")}`,
      ),
    );
  }

  const keep = unchangedPrefix(input.previous, messages);
  const kept = messages.slice(0, keep);
  const fresh = messages.slice(keep);
  if (kept.length > 0) {
    const tok = kept.reduce((s, m) => s + messageTokens(m), 0);
    lines.push(
      row(
        "未变",
        `前 ${keep} 条 ${fmtTok(tok)} tok,与上次逐字节相同 → 预计缓存命中上限 ${fmtTok(tok)}`,
      ),
    );
  }
  // 编辑点(Q76):第一条改过的消息(编辑、丢弃后的摘要、清除占位)。之后的全部重算;Anthropic 还丢思考块。
  const firstEdited = messages.findIndex((m) => m.edited);
  if (firstEdited >= 0) {
    const after = messages.slice(firstEdited);
    const tok = after.reduce((s, m) => s + messageTokens(m), 0);
    const thinking = messages
      .slice(firstEdited)
      .filter((m) => m.role === "assistant" && m.opaque !== undefined).length;
    const what = messages[firstEdited];
    const label = what?.role === "tool" ? `tool ${what.name}` : (what?.role ?? "");
    lines.push(
      row(
        "编辑点",
        `[${firstEdited + 1}] ${label} 改过 → 从这里起 ${after.length} 条 ${fmtTok(tok)} tok 重算${input.dropsThinking && thinking > 0 ? `;之后 ${thinking} 条消息的思考块不再回传` : ""}`,
      ),
    );
  }
  const freshRows = fresh
    .map((m, i) => ({ m, idx: keep + i + 1 }))
    .filter(({ m }) => m.role !== "system");
  if (freshRows.length > 0) {
    const label = kept.length > 0 || input.previous ? "新增" : "消息";
    for (const { m, idx } of freshRows.slice(0, 6)) {
      const role = m.role === "tool" ? `tool ${m.name}${m.isError ? " ✗" : ""}` : m.role;
      const brief =
        m.role === "assistant" && !m.content && m.toolCalls.length > 0
          ? `⚙ ${m.toolCalls.map((t) => t.name).join(" ")}`
          : firstLine(m.content);
      lines.push(row(label, `[${idx}] ${role} ${fmtTok(messageTokens(m))} tok  ${brief}`));
    }
    if (freshRows.length > 6)
      lines.push(row("", `… 还有 ${freshRows.length - 6} 条,Ctrl+R → 发送分区看全部`));
  }

  const total = messages.reduce((s, m) => s + messageTokens(m), 0);
  const gate =
    r.threshold !== undefined
      ? r.estimatedTokens > r.threshold
        ? ` · 已超压缩阈值 ${fmtTok(r.threshold)}`
        : ` · 距压缩阈值还差 ${fmtTok(r.threshold - r.estimatedTokens)}`
      : "";
  lines.push(
    row(
      "合计",
      `${messages.length} 条消息 ≈${fmtTok(total)} tok(口径 ${fmtTok(r.estimatedTokens)})${gate}`,
    ),
  );
  return lines;
}

export type ReceiveHeadInput = {
  n: number;
  estimated: number;
  price?: Price;
  /** 响应事件;没有 = 还在等。 */
  response?: AssistantEvent;
  /** 压缩摘要请求的结果。 */
  compaction?: Extract<AgentEvent, { type: "compaction" }>;
  error?: string;
  /** 发送卡预计的缓存命中上限;有它就与实测并排。 */
  predictedCache?: number;
};

/** 接收卡的头行:一眼看到停止原因、耗时、实测用量、缓存命中率、费用。 */
export function receiveHead(input: ReceiveHeadInput): string {
  const { n } = input;
  if (input.error)
    return `${c.zhu(BAR)} ${c.bold(c.zhu(`接收 #${n}  ✗ ${firstLine(input.error, 80)}`))}`;
  const usageText = (u: AssistantEvent["usage"]) => {
    if (!u) return "无用量";
    // 预计与实测并排:实测明显低于预计,说明有别的东西在破坏前缀。
    const predicted =
      input.predictedCache !== undefined && input.predictedCache > 0
        ? `,预计≤${fmtTok(input.predictedCache)}`
        : "";
    const hit =
      u.cacheReadTokens !== undefined && u.inputTokens > 0
        ? `(缓存 ${fmtTok(u.cacheReadTokens)} · ${Math.round((u.cacheReadTokens / u.inputTokens) * 100)}%${predicted})`
        : "";
    const reasoning = u.reasoningTokens !== undefined ? ` · 推理 ${fmtTok(u.reasoningTokens)}` : "";
    const cost = input.price ? ` · ${fmtCost(costOf(u, input.price))}` : "";
    return `≈${fmtTok(input.estimated)} → 实测 ${fmtTok(u.inputTokens)}${hit} · +${fmtTok(u.outputTokens)}${reasoning}${cost}`;
  };
  if (input.response) {
    const e = input.response;
    return head(`接收 #${n}  ${e.stopReason}  ${fmtMs(e.latencyMs)}  ${usageText(e.usage)}`);
  }
  if (input.compaction) {
    const k = input.compaction;
    return head(
      `接收 #${n}  摘要 ${k.summary?.length ?? 0} 字  ${fmtMs(k.latencyMs)}  ${usageText(k.usage)}`,
    );
  }
  return `${c.jin(BAR)} ${c.soft(`接收 #${n}  等待响应…`)}`;
}

/** 响应里除思考与文本之外的块:调用、回传物。思考与文本由主屏各自的节点显示。 */
export function receiveBlockLines(e: AssistantEvent): string[] {
  const lines: string[] = [];
  if (e.opaque !== undefined) {
    const o = e.opaque as { kind?: string; blocks?: unknown[]; items?: unknown[] };
    const count = o.blocks?.length ?? o.items?.length ?? 0;
    lines.push(
      row(
        "回传",
        `${o.kind ?? "opaque"} ${count} 项 ${fmtTok(estimateTokens(JSON.stringify(e.opaque)))} tok · 下一轮原样送回,内核不解释`,
      ),
    );
  }
  return lines;
}

/** 思考块的标题:全文与摘要必须让人一眼分清,这决定了它能不能被编辑来引导模型。 */
export function reasoningTitle(kind: "full" | "summary" | undefined): string {
  if (kind === "summary") return "思考(摘要;模型读的正文在回传物里,改它无效)";
  if (kind === "full") return "思考(全文;下一轮原样回传,可编辑引导)";
  return "思考";
}

type RequestErrorEvent = Extract<AgentEvent, { type: "request/error" }>;

/**
 * 错误卡:一次请求最终失败时的四行。分类与状态码、供应商原话、下一步、原始响应体在哪。
 * 英文,与界面一致;原话原样,不转述。
 */
export function errorCardLines(
  e: RequestErrorEvent,
  ctx: { n: number; providerName?: string; model?: string; hint: string },
): string[] {
  const kind = e.kind ?? "unknown";
  const status = e.status !== undefined ? ` · HTTP ${e.status}` : "";
  const lines = [
    `${c.zhu(BAR)} ${c.bold(c.zhu(`Request #${ctx.n} failed`))}  ${c.soft(`${kind}${status}`)}`,
  ];
  if (e.provider) lines.push(row("provider", e.provider));
  else lines.push(row("error", firstLine(e.error, 120)));
  lines.push(row("next", ctx.hint));
  lines.push(
    row(
      "raw",
      e.body
        ? `${e.body.length} chars of response body saved · Ctrl+R → request #${ctx.n} → received`
        : `no response body (network or stream failure) · Ctrl+R → request #${ctx.n} → received`,
    ),
  );
  return lines;
}
