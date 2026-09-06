// 主屏的两张卡(可见性的核心):每次请求发出前一张 Request 卡,响应回来一张 Response 卡。
// Request 卡回答"这次到底发了什么":先说变了什么(新增、编辑、摘要,以及代价),再列参数、系统提示词、工具、
// 每一条消息(事件号、角色、token、状态、首行),最后是离自动压缩还有多远;
// Response 卡回答"这次到底收到了什么":停止原因、耗时、费用、实测用量与缓存命中、思考、调用、回传物、元数据、原始流。
// 版式是一条 9 列的标签沟:标签淡色靠左,内容从第 12 列起;续行缩进到内容列。不画框,不用竖线。
// 记号优先于颜色:+ 新增、✎ 编辑、≈ 摘要或清除、· 未变;红色只留给错误。
// 全部是纯函数,输入就是事件与投影;不重复已经在屏幕上的正文,只标结构与差异。
import { messageTokens as estimateMessageTokens, estimateTokens } from "../src/context.js";
import { costOf, fmtCost, type Price } from "../src/cost.js";
import type { AgentEvent } from "../src/events.js";
import type { Message } from "../src/messages.js";
import type { ToolDef } from "../src/provider.js";
import { fmtMs, fmtTok } from "./inspector.js";
import { gutter, shortLabel } from "./layout.js";
import { c, G } from "./theme.js";

type RequestEvent = Extract<AgentEvent, { type: "request" }>;
type AssistantEvent = Extract<AgentEvent, { type: "assistant/message" }>;

/** 标签沟宽度:标签占 9 列,再空两格,内容从第 12 列起。 */
export { GUTTER } from "./layout.js";
/** 一行:标签 + 内容。窄屏下标签沟缩窄、标签用短形。 */
export const g = (label: string, body: string): string =>
  `${c.faint(shortLabel(label).padEnd(gutter()))}  ${body}`;
/** 续行:缩进到内容列。 */
export const cont = (body: string): string => `${" ".repeat(gutter())}  ${body}`;

export function firstLine(s: string, max = 60): string {
  const l =
    s
      .split("\n")
      .find((x) => x.trim())
      ?.trim() ?? "";
  return l.length > max ? `${l.slice(0, max)}…` : l;
}

// 消息对象在一次投影里是固定的,按对象记住 token 数与 JSON 形态:
// 发送卡对同一条消息要算好几次,长会话回放时这两处是二次方的主项(重构块 4)。
const tokenMemo = new WeakMap<Message, number>();
const keyMemo = new WeakMap<Message, string>();

function messageTokens(m: Message): number {
  const hit = tokenMemo.get(m);
  if (hit !== undefined) return hit;
  const n = estimateMessageTokens(m);
  tokenMemo.set(m, n);
  return n;
}

/** 消息的比较键:JSON 全文,按对象缓存;两次投影里内容相同的消息键相同。 */
function messageKey(m: Message): string {
  const hit = keyMemo.get(m);
  if (hit !== undefined) return hit;
  const k = JSON.stringify(m);
  keyMemo.set(m, k);
  return k;
}

/** 请求正文里除消息与工具之外的顶层参数,压成一行:布尔 true 只写键名,对象压成紧凑 JSON。 */
export function paramsLine(wire: unknown): string {
  if (!wire || typeof wire !== "object") return "(provider has no wire(); parameters not visible)";
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
  return parts.join(" · ") || "(none)";
}

/** 相同前缀有多长:逐条比 JSON(按对象缓存)。缓存命中的上限就是它。 */
export function unchangedPrefix(prev: Message[] | undefined, cur: Message[]): number {
  if (!prev) return 0;
  let i = 0;
  while (i < prev.length && i < cur.length) {
    const a = prev[i] as Message;
    const b = cur[i] as Message;
    if (a !== b && messageKey(a) !== messageKey(b)) break;
    i++;
  }
  return i;
}

function tokensOf(messages: Message[], upTo = messages.length): number {
  let s = 0;
  for (let i = 0; i < upTo && i < messages.length; i++) s += messageTokens(messages[i] as Message);
  return s;
}

/** 发送卡算出的、给接收卡对照用的预计值。keep 已算过就传进来。 */
export function predictedCache(
  previous: Message[] | undefined,
  messages: Message[],
  keep = unchangedPrefix(previous, messages),
): number {
  return tokensOf(messages, keep);
}

export type MessageState = "same" | "new" | "edited" | "summary" | "cleared";

export type MessageRow = {
  /** 显示的编号:有来历时是事件号(/edit /drop 用的那个),否则是投影序号。 */
  idx: number;
  role: string;
  tok: number;
  state: MessageState;
  preview: string;
};

export function roleWord(m: Message): string {
  return m.role === "tool" ? `tool ${m.name}${m.isError ? " ✗" : ""}` : m.role;
}

const previewMemo = new WeakMap<Message, string>();

export function previewOf(m: Message): string {
  const hit = previewMemo.get(m);
  if (hit !== undefined) return hit;
  const p = previewOfFresh(m);
  previewMemo.set(m, p);
  return p;
}

function previewOfFresh(m: Message): string {
  return m.role === "assistant" && !m.content && m.toolCalls.length > 0
    ? `» ${m.toolCalls.map((t) => t.name).join(" ")}`
    : firstLine(m.content);
}

/** 每条消息相对上一次请求的状态:前缀相同就是 same;之后按来历判摘要、清除、编辑,其余是新增。 */
export type MessageMark = { idx: number; state: MessageState };

/** 每条消息的编号与状态:changed 行只需要这两项,折叠的旧卡不必再算角色、token 与预览。 */
export function messageMarks(
  messages: Message[],
  previous: Message[] | undefined,
  provenance?: { event: number; stages: string[] }[],
  keep = unchangedPrefix(previous, messages),
): MessageMark[] {
  return messages.map((m, i) => {
    const stages = provenance?.[i]?.stages ?? [];
    let state: MessageState = "new";
    if (i < keep) state = "same";
    else if (stages.some((s) => s.startsWith("summary"))) state = "summary";
    else if (stages.includes("cleared")) state = "cleared";
    else if (stages.some((s) => s.startsWith("edited")) || m.edited) state = "edited";
    return { idx: provenance?.[i]?.event ?? i + 1, state };
  });
}

export function messageRows(
  messages: Message[],
  previous: Message[] | undefined,
  provenance?: { event: number; stages: string[] }[],
  keep = unchangedPrefix(previous, messages),
): MessageRow[] {
  return messageMarks(messages, previous, provenance, keep).map((mark, i) => {
    const m = messages[i] as Message;
    return { ...mark, role: roleWord(m), tok: messageTokens(m), preview: previewOf(m) };
  });
}

const GLYPH: Record<MessageState, string> = {
  same: "·",
  new: "+",
  edited: "✎",
  summary: "≈",
  cleared: "≈",
};

export function messageRowLine(r: MessageRow, width = 60): string {
  const glyph = r.state === "same" ? c.faint(GLYPH[r.state]) : c.jin(GLYPH[r.state]);
  const state = r.state === "same" ? c.faint(r.state.padEnd(7)) : c.jin(r.state.padEnd(7));
  const body = `${String(r.idx).padStart(3)}  ${r.role.padEnd(10)} ${fmtTok(r.tok).padStart(5)}  `;
  const preview = firstLine(r.preview, width);
  return r.state === "same"
    ? `${glyph} ${c.faint(body)}${state}  ${c.faint(preview)}`
    : `${glyph} ${c.soft(body)}${state}  ${c.soft(preview)}`;
}

/** 消息表:连续超过 3 条未变的折成一行;新增、编辑、摘要永不折叠。 */
export function messageTableLines(rows: MessageRow[], width = 60): string[] {
  const out: string[] = [];
  let run: MessageRow[] = [];
  const flush = () => {
    if (run.length > 3) {
      const first = run[0] as MessageRow;
      const last = run[run.length - 1] as MessageRow;
      const mid = run.slice(1, -1);
      out.push(
        cont(messageRowLine(first, width)),
        cont(
          c.faint(
            `  …  ${mid.length} unchanged · ${fmtTok(mid.reduce((s, m) => s + m.tok, 0))} tok`,
          ),
        ),
        cont(messageRowLine(last, width)),
      );
    } else out.push(...run.map((m) => cont(messageRowLine(m, width))));
    run = [];
  };
  for (const r of rows) {
    if (r.state === "same") run.push(r);
    else {
      flush();
      out.push(cont(messageRowLine(r, width)));
    }
  }
  flush();
  return out;
}

export type SendCardInput = {
  n: number;
  request: RequestEvent;
  /** 这次实际发出的消息。 */
  messages: Message[];
  /** 每条消息的来历(来源事件号与阶段);摘要请求的正文没有。 */
  provenance?: { event: number; stages: string[] }[];
  /** 上一次正常步发出的消息;没有就是第一次。 */
  previous?: Message[];
  /** provider.wire 的返回;没有就说明参数不可见。 */
  wire?: unknown;
  /** 上一次请求的参数行(paramsLine 的结果);相同就折进 same 行。 */
  previousParams?: string;
  defs: ToolDef[];
  /** 系统提示词分段(来自 session/start)。 */
  sections?: { name: string; source?: string; chars: number }[];
  /** 工具集与上次相同。 */
  toolsUnchanged: boolean;
  /** 该 provider 在编辑点之后丢弃思考块(Anthropic)。 */
  dropsThinking?: boolean;
  /** 消息首行的可用宽度。 */
  width?: number;
  /**
   * 只要头两行(头 + changed):回放历史时,除最后一次之外的 Request 卡一画出来就会被折成两行,
   * 参数、系统段、工具与消息表算了也不显示。
   */
  collapsed?: boolean;
};

export function requestKind(r: RequestEvent): string {
  return r.reason === "compaction"
    ? "compaction summary"
    : r.reason === "overflow-retry"
      ? "overflow retry"
      : "turn";
}

/** "changed" 行:一次请求相对上一次变了什么,以及那要付出什么。永远是 Request 卡的第一行。 */
export function changedLine(
  input: SendCardInput,
  rows: MessageMark[],
  keep = unchangedPrefix(input.previous, input.messages),
): string {
  const { messages } = input;
  const total = tokensOf(messages);
  if (!input.previous) {
    return `${c.jin("first request")} · ${messages.length} messages  ${c.faint("→ nothing to compare with yet")}`;
  }
  const cache = tokensOf(messages, keep);
  const changed = rows.filter((r) => r.state !== "same");
  const count = (state: MessageState) => changed.filter((r) => r.state === state);
  const parts: string[] = [];
  const news = count("new");
  if (news.length > 0) parts.push(c.jin(`+${news.length} new`));
  const edited = count("edited");
  if (edited.length > 0)
    parts.push(c.jin(`${edited.length} edited (${edited.map((r) => `#${r.idx}`).join(", ")})`));
  const summary = count("summary");
  if (summary.length > 0)
    parts.push(c.jin(`${summary.length} summary (${summary.map((r) => `#${r.idx}`).join(", ")})`));
  const cleared = count("cleared");
  if (cleared.length > 0) parts.push(c.jin(`${cleared.length} cleared`));
  // 编辑点之后的思考块:Anthropic 的签名绑定前缀,改过之后的思考块不再回传。
  const firstEdited = messages.findIndex((m) => m.edited);
  const thinking =
    input.dropsThinking && firstEdited >= 0
      ? messages.slice(firstEdited).filter((m) => m.role === "assistant" && m.opaque !== undefined)
          .length
      : 0;
  const recomputed = messages.length - keep;
  const tail = [
    recomputed > 0 ? `${recomputed} recomputed` : "nothing recomputed",
    `cache ≤${fmtTok(cache)} of ${fmtTok(total)}`,
    ...(thinking > 0 ? [`${thinking} thinking block${thinking > 1 ? "s" : ""} dropped`] : []),
  ].join(" · ");
  const head = parts.length > 0 ? parts.join(c.faint(" · ")) : c.faint("nothing changed");
  return `${head}  ${c.faint(`→ ${tail}`)}`;
}

export function sendCardLines(input: SendCardInput): string[] {
  const { n, request: r, messages, defs } = input;
  const width = input.width ?? 60;
  const lines: string[] = [
    `${c.soft(`Request #${n}`)}   ${c.faint(`${r.model} · ${requestKind(r)}${r.effort ? ` · effort ${r.effort}` : ""}`)}`,
  ];
  // 相同前缀只算一次,行表、changed 行、预计缓存都用它。
  const keep = unchangedPrefix(input.previous, messages);
  if (input.collapsed) {
    lines.push(
      g(
        "changed",
        changedLine(input, messageMarks(messages, input.previous, input.provenance, keep), keep),
      ),
    );
    return lines;
  }
  const rows = messageRows(messages, input.previous, input.provenance, keep);
  lines.push(g("changed", changedLine(input, rows, keep)));

  // params / system / tools 一轮之后基本不变:没变的不再逐行印,合成一行 same。第一次请求全印。
  const params = paramsLine(input.wire);
  const sameParams = input.previous !== undefined && input.previousParams === params;
  if (!sameParams) lines.push(g("params", c.faint(params)));

  const sys = messages.find((m) => m.role === "system");
  const prevSys = input.previous?.find((m) => m.role === "system");
  const sameSystem = sys !== undefined && prevSys !== undefined && prevSys.content === sys.content;
  if (sys && !sameSystem) {
    const secs = input.sections ?? [];
    const total = estimateTokens(sys.content);
    const detail =
      secs.length > 0
        ? secs.map((s) => `${s.name} ${fmtTok(Math.ceil(s.chars / 4))}`).join(" · ")
        : firstLine(sys.content, width);
    lines.push(
      g(
        "system",
        c.faint([`${fmtTok(total)} tok`, ...(prevSys ? ["changed"] : []), detail].join(" · ")),
      ),
    );
  }

  const sameTools = input.previous !== undefined && input.toolsUnchanged && defs.length > 0;
  if (defs.length > 0 && !sameTools) {
    const defTok = defs.reduce((s, d) => s + estimateTokens(JSON.stringify(d)), 0);
    lines.push(
      g(
        "tools",
        c.faint(
          [
            `${defs.length}`,
            `${fmtTok(defTok)} tok`,
            ...(input.previous ? ["changed"] : []),
            defs.map((d) => d.name).join(" "),
          ].join(" · "),
        ),
      ),
    );
  }

  const same = [
    ...(sameParams ? ["params"] : []),
    ...(sameSystem ? ["system"] : []),
    ...(sameTools ? ["tools"] : []),
  ];
  if (same.length > 0)
    lines.push(g("same", c.faint(`${same.join(" · ")} · as in the previous request`)));

  const total = tokensOf(messages);
  lines.push(
    g(
      "messages",
      c.faint(`${messages.length} · ≈${fmtTok(total)} tok · Ctrl+E to inspect or edit`),
    ),
  );
  lines.push(...messageTableLines(rows, width));

  if (r.threshold !== undefined) {
    const room = r.threshold - r.estimatedTokens;
    lines.push(
      g(
        "limit",
        room > 0
          ? c.faint(`${fmtTok(room)} tok until the compaction threshold (${fmtTok(r.threshold)})`)
          : c.zhu(`over the auto-compaction threshold by ${fmtTok(-room)} tok`),
      ),
    );
  } else lines.push(g("limit", c.faint("no compaction configured")));
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

/** usage 段:实测用量、缓存命中率与预计的对照;接在 Response 头行后面,不再单独一行。 */
function usageText(input: ReceiveHeadInput, u: AssistantEvent["usage"]): string {
  if (!u) return "no usage reported by the provider";
  // 预计与实测并排:实测明显低于预计,说明有别的东西在破坏前缀。
  const inner = [`estimated ≈${fmtTok(input.estimated)}`];
  if (u.cacheReadTokens !== undefined && u.inputTokens > 0) {
    inner.push(
      `cache ${fmtTok(u.cacheReadTokens)} · ${Math.round((u.cacheReadTokens / u.inputTokens) * 100)}%`,
    );
    if (input.predictedCache !== undefined && input.predictedCache > 0)
      inner.push(`expected ≤${fmtTok(input.predictedCache)}`);
  }
  const parts = [
    `in ${fmtTok(u.inputTokens)} (${inner.join(" · ")})`,
    `out +${fmtTok(u.outputTokens)}`,
    ...(u.reasoningTokens !== undefined ? [`reasoning ${fmtTok(u.reasoningTokens)}`] : []),
    ...(u.cacheWriteTokens !== undefined ? [`cache write ${fmtTok(u.cacheWriteTokens)}`] : []),
  ];
  return parts.join(" · ");
}

/** 接收卡的头,一行:停止原因、耗时、费用,接实测用量、缓存命中率与预计的对照。宽度不够时按悬挂缩进折行。 */
export function receiveHead(input: ReceiveHeadInput): string {
  const { n } = input;
  const title = (tail: string) => `${c.soft(`Response #${n}`)}   ${c.faint(tail)}`;
  if (input.error)
    return `${c.zhu(`Response #${n}`)}   ${c.zhu(`✗ ${firstLine(input.error, 80)}`)}`;
  if (input.response) {
    const e = input.response;
    const cost = input.price && e.usage ? [fmtCost(costOf(e.usage, input.price))] : [];
    return title(
      [e.stopReason, fmtMs(e.latencyMs), ...cost, usageText(input, e.usage)].join(" · "),
    );
  }
  if (input.compaction) {
    const k = input.compaction;
    const cost = input.price && k.usage ? [fmtCost(costOf(k.usage, input.price))] : [];
    return title(
      [
        `summary ${k.summary?.length ?? 0} chars`,
        fmtMs(k.latencyMs),
        ...cost,
        usageText(input, k.usage),
      ].join(" · "),
    );
  }
  return `${c.soft(`Response #${n}`)}   ${c.faint("waiting…")}`;
}

/** 响应里除思考、文本、调用之外的块:回传物、供应商元数据。 */
export function receiveBlockLines(e: AssistantEvent): string[] {
  const lines: string[] = [];
  if (e.opaque !== undefined) {
    const o = e.opaque as { kind?: string; blocks?: unknown[]; items?: unknown[] };
    const count = o.blocks?.length ?? o.items?.length ?? 0;
    lines.push(
      g(
        "opaque",
        c.faint(
          `${o.kind ?? "opaque"} · ${count} block${count === 1 ? "" : "s"} · ${fmtTok(estimateTokens(JSON.stringify(e.opaque)))} tok · echoed back verbatim, never interpreted`,
        ),
      ),
    );
  }
  // 供应商元数据:不解释,原样列出;与内核归一后的 stopReason 并排,两者不一致就能看见。
  if (e.extras && Object.keys(e.extras).length > 0) {
    lines.push(
      g(
        "extras",
        c.faint(
          Object.entries(e.extras)
            .map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join(" · "),
        ),
      ),
    );
  }
  return lines;
}

/** 接收卡尾行:这次响应的原始流有几行、去哪看。有它就永远能对照"解析出来的"与"收到的"。 */
export function rawRow(lineCount: number, n: number): string {
  return g("raw", c.faint(`${lineCount} lines as received · /raw ${n}`));
}

/** 思考块的种类说明:全文与摘要必须让人一眼分清,这决定了它能不能被编辑来引导模型。 */
export function thinkingKind(kind: "full" | "summary" | undefined): string {
  if (kind === "summary")
    return "summary · the model reads the opaque block, editing this has no effect";
  if (kind === "full") return "full · echoed back next turn · editable with /edit N reasoning";
  return "kind unknown";
}

/** 思考行:缺省折成一行(首行 + 种类 + 行数),Ctrl+T 展开成全文。 */
export function thinkingLines(
  text: string,
  kind: "full" | "summary" | undefined,
  expanded: boolean,
  width = 80,
): string[] {
  const body = text.trim();
  const all = body ? body.split("\n") : [];
  const kindWord = kind ?? "?";
  if (!expanded) {
    return [
      g(
        "thinking",
        `${c.faint(c.italic(firstLine(body, width)))}  ${c.faint(`(${kindWord} · ${all.length} line${all.length === 1 ? "" : "s"} · Ctrl+T)`)}`,
      ),
    ];
  }
  return [
    g("thinking", c.faint(`(${thinkingKind(kind)})`)),
    ...all.map((l) => cont(c.faint(c.italic(l)))),
  ];
}

/** 调用行:» 朱色(工具是朱的),名字加粗,参数次要色。 */
export function callLine(name: string, args: string): string {
  return g("call", `${c.zhu(G.call)} ${c.bold(c.ink(name))}  ${c.soft(args)}`);
}

/**
 * 工具结果:一行头(✓/✗、名字、行数、耗时),正文首行带 └,其余缩到它后面;
 * 折叠时只留前 head 行,尾行说明还有多少与怎么展开。
 */
export function resultLines(
  r: { name: string; content: string; isError: boolean; durationMs?: number },
  opts: { folded: boolean; head: number },
): string[] {
  // 静成功、响失败:✓ 是墨色,只有 ✗ 用朱。
  const mark = r.isError ? c.zhu(G.err) : c.soft(G.ok);
  const trimmed = r.content.trim();
  const all = trimmed ? trimmed.split("\n") : [];
  const meta = [
    ...(all.length > 1 ? [`${all.length} lines`] : []),
    ...(r.durationMs !== undefined ? [fmtMs(r.durationMs)] : []),
    ...(r.isError ? ["error"] : []),
  ];
  const lines = [
    g(
      "result",
      `${mark} ${c.soft(r.name)}${meta.length > 0 ? c.faint(`  ${meta.join(" · ")}`) : ""}`,
    ),
  ];
  const tone = r.isError ? c.soft : c.faint;
  const body = (l: string, i: number) => cont(`${i === 0 ? c.faint("└") : " "} ${tone(l)}`);
  if (all.length === 0) lines.push(cont(`${c.faint("└")} ${c.faint("(no output)")}`));
  else if (opts.folded && all.length > opts.head + 1) {
    lines.push(...all.slice(0, opts.head).map(body));
    lines.push(cont(`  ${c.soft(`… +${all.length - opts.head} lines · Ctrl+O`)}`));
  } else lines.push(...all.map(body));
  return lines;
}

type RequestErrorEvent = Extract<AgentEvent, { type: "request/error" }>;

/**
 * 错误卡:一次请求最终失败时的四行。分类与状态码、供应商原话、下一步、原始响应体在哪。
 * 原话原样,不转述。
 */
export function errorCardLines(
  e: RequestErrorEvent,
  ctx: { n: number; providerName?: string; model?: string; hint: string },
): string[] {
  const kind = e.kind ?? "unknown";
  const status = e.status !== undefined ? ` · HTTP ${e.status}` : "";
  const lines = [`${c.bold(c.zhu(`Request #${ctx.n} failed`))}   ${c.soft(`${kind}${status}`)}`];
  if (e.provider) lines.push(g("provider", c.ink(e.provider)));
  else lines.push(g("error", c.ink(firstLine(e.error, 120))));
  lines.push(g("next", c.ink(ctx.hint)));
  lines.push(
    g(
      "raw",
      c.faint(
        e.body
          ? `${e.body.length} chars of response body saved · /raw ${ctx.n}`
          : `no response body (network or stream failure) · /raw ${ctx.n}`,
      ),
    ),
  );
  return lines;
}

/** 首屏:新用户输入任何东西之前看到的。五个动词,一行一个,加一条可以直接试的提示。 */
export function firstRunLines(): string[] {
  return [
    c.soft("Everything the model sees, and everything the kernel decides, is one append-only log."),
    c.soft("This screen is a projection of it. So is every request."),
    "",
    g(
      "type",
      c.faint("a message and press Enter · Alt+Enter queues it for after the current step"),
    ),
    g("watch", c.faint("each step shows what was sent and what changed, then what came back")),
    g(
      "inspect",
      c.faint("Ctrl+R  requests · events · compactions · context   Ctrl+E  context panel"),
    ),
    g(
      "change",
      c.faint(
        "context panel: edit · drop · rewind · retry · fork · all recorded, nothing destroyed",
      ),
    ),
    g("more", c.faint("/help commands · ? shortcuts · /fields what this protocol sends and reads")),
    "",
    `${c.faint("Try:")} ${c.soft("What's in this directory? Read the README.")}`,
  ];
}

/** ? 键:全部快捷键,一屏说完。 */
export function shortcutLines(): string[] {
  const k = (key: string, what: string) => `  ${c.ink(key.padEnd(12))} ${c.soft(what)}`;
  return [
    c.soft("Shortcuts"),
    k("Enter", "send · Alt+Enter queue for after the current step · Shift+Enter new line"),
    k("Esc", "interrupt the running turn"),
    k("Ctrl+K", "command palette: commands, models, skills, templates, login"),
    k("Ctrl+G", "write the message in $EDITOR"),
    k("Ctrl+↑ ↓", "jump one step up or down · PgUp PgDn scroll · Ctrl+Shift+F search"),
    k("Ctrl+R", "inspector: requests · Tab cycles events · compactions · context"),
    k("Ctrl+E", "context panel: every message the model sees next; Enter on a row for actions"),
    k("Ctrl+O", "fold or unfold tool results (and cycle sub-agent views)"),
    k("Ctrl+T", "expand or collapse thinking"),
    k("Ctrl+C", "quit"),
    k("@path", "attach a file to the message"),
    k("/help", "all commands"),
  ];
}
