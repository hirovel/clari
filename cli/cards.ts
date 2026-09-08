// 主屏的文字:直印的对话流。原则是"安静的流,响的变化":用户消息、回复、调用、结果直接印,记账不进正文;
// 只有上下文发生了别的工具看不见的事(前缀被重算、压缩、消息被编辑、缓存命中率掉、窗口是假设值)才多出一行说明。
// 版式:两列标记列(› 用户,» 调用,└ 结果,· 思考与说明,≈ 上下文变化,✎ 编辑,✗ 失败,≡ 折起的步),
// 正文从第 2 列起,续行缩到标记之后。不画框,不用竖线,没有标签词。
// 全部是纯函数,输入就是事件与投影。

import type { ResultView } from "../src/config.js";
import { messageTokens as estimateMessageTokens } from "../src/context.js";
import type { AgentEvent } from "../src/events.js";
import type { Message } from "../src/messages.js";
import { fmtMs, fmtTok } from "./inspector-format.js";
import { fmtWindow } from "./registry.js";
import { c, G } from "./theme.js";

type RequestEvent = Extract<AgentEvent, { type: "request" }>;
type Usage = NonNullable<Extract<AgentEvent, { type: "assistant/message" }>["usage"]>;

export function firstLine(s: string, max = 60): string {
  const l =
    s
      .split("\n")
      .find((x) => x.trim())
      ?.trim() ?? "";
  return l.length > max ? `${l.slice(0, max)}…` : l;
}

// 消息对象在一次投影里是固定的,按对象记住 token 数与 JSON 形态:
// 同一条消息要算好几次,长会话回放时这两处是二次方的主项。
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

/** 发出前算出的缓存命中上限(相同前缀的 token),响应回来与实测对照。keep 已算过就传进来。 */
export function predictedCache(
  previous: Message[] | undefined,
  messages: Message[],
  keep = unchangedPrefix(previous, messages),
): number {
  return tokensOf(messages, keep);
}

export type MessageState = "same" | "new" | "edited" | "summary" | "cleared";

/** 每条消息相对上一次请求的状态与编号(有来历时是事件号,否则是投影序号)。 */
export type MessageMark = { idx: number; state: MessageState };

/** 前缀相同就是 same;之后按来历判摘要、清除、编辑,其余是新增。 */
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

/** 用户消息:› 起头,正文加粗;续行缩到 › 之后。 */
export function userLine(text: string): string {
  return `${c.zhu(G.you)} ${c.bold(c.ink(text))}`;
}

export type ChangeInput = {
  n: number;
  request: RequestEvent;
  /** 这次实际发出的消息。 */
  messages: Message[];
  /** 每条消息的来历(来源事件号与阶段);摘要请求的正文没有。 */
  provenance?: { event: number; stages: string[] }[];
  /** 上一次正常步发出的消息;没有就是第一次。 */
  previous?: Message[];
  /** 该 provider 在编辑点之后丢弃思考块(Anthropic)。 */
  dropsThinking?: boolean;
  /** 窗口数据的出处(config / models.dev / assumed)。 */
  limitSource?: string;
  contextWindow?: number;
};

/**
 * 变化说明:一次请求相对上一次,有没有别的工具看不见的事。有就是一行(或两行),没有就不印。
 * 印的情形:摘要请求、溢出重试、消息被编辑、上下文被压缩、前缀被重算、思考块被丢弃、第一次请求时窗口是假设值。
 * 每次都印的东西不是信息,是噪声;正常追加一条用户消息不算变化。
 */
export function changeNote(input: ChangeInput): string | undefined {
  const { request: r, messages } = input;
  const note = (sign: string, head: string, tail?: string) =>
    `${sign} ${head}${tail ? `  ${c.faint(tail)}` : ""}`;
  if (r.reason === "compaction")
    return note(
      c.jin(G.compact),
      c.faint(`summary request · ${messages.length} messages · ≈${fmtTok(tokensOf(messages))} tok`),
    );
  if (r.reason === "overflow-retry")
    return note(
      c.jin(G.compact),
      c.faint("overflow retry · the context was trimmed and sent again"),
    );
  const lines: string[] = [];
  if (input.n === 1 && input.limitSource === "assumed")
    lines.push(
      note(
        c.zhu(G.ask),
        c.faint(
          `context window assumed ${fmtWindow(input.contextWindow ?? 0)} · set contextWindow in the config to be sure`,
        ),
      ),
    );
  if (!input.previous) return lines[0];
  const keep = unchangedPrefix(input.previous, messages);
  const marks = messageMarks(messages, input.previous, input.provenance, keep);
  const count = (s: MessageState) => marks.filter((m) => m.state === s);
  const edited = count("edited");
  const summary = count("summary");
  const cleared = count("cleared");
  const parts: string[] = [];
  if (edited.length > 0)
    parts.push(`${edited.length} edited (${edited.map((m) => `#${m.idx}`).join(", ")})`);
  if (summary.length > 0 || cleared.length > 0)
    parts.push(
      `compacted · ${summary.length} summary${cleared.length > 0 ? ` · ${cleared.length} cleared` : ""}`,
    );
  // 前缀断了:上次发过的某条消息变了或没了,而上面两种来历都解释不了。
  if (keep < input.previous.length && parts.length === 0)
    parts.push(`prefix recomputed from #${marks[keep]?.idx ?? keep + 1}`);
  // 编辑点之后的思考块:签名绑定前缀,改过之后的思考块不再回传。
  const firstEdited = messages.findIndex((m) => m.edited);
  const thinking =
    input.dropsThinking && firstEdited >= 0
      ? messages.slice(firstEdited).filter((m) => m.role === "assistant" && m.opaque !== undefined)
          .length
      : 0;
  if (thinking > 0) parts.push(`${thinking} thinking block${thinking > 1 ? "s" : ""} dropped`);
  if (parts.length === 0) return lines[0];
  const recomputed = messages.length - keep;
  lines.push(
    note(
      edited.length > 0 ? c.jin(G.edited) : c.jin(G.compact),
      c.jin(parts.join(" · ")),
      `→ ${recomputed} recomputed · cache ≤${fmtTok(tokensOf(messages, keep))} of ${fmtTok(tokensOf(messages))} · Ctrl+E`,
    ),
  );
  return lines.join("\n");
}

/** 供应商通常不缓存太短的前缀;预计命中不到这个数就不评判命中率。 */
const CACHE_MIN_TOKENS = 1024;

/**
 * 缓存说明:实测命中率明显低于预计时印一行;正常时不印。
 * 消息表没变而缓存没中,说明请求里消息之外的什么变了(参数、工具定义、系统提示词)。
 */
export function cacheNote(u: Usage, predicted: number | undefined): string | undefined {
  if (u.cacheReadTokens === undefined || u.inputTokens <= 0) return undefined;
  if (predicted === undefined || predicted < CACHE_MIN_TOKENS) return undefined;
  const ratio = u.cacheReadTokens / u.inputTokens;
  if (ratio >= 0.5) return undefined;
  return `${c.jin(G.compact)} ${c.faint(
    `cache ${Math.round(ratio * 100)}% · ${fmtTok(u.cacheReadTokens)} of ${fmtTok(u.inputTokens)} hit · expected ≤${fmtTok(predicted)}`,
  )}`;
}

/** 思考块的种类说明:全文与摘要必须让人一眼分清,这决定了它能不能被编辑来引导模型。 */
export function thinkingKind(kind: "full" | "summary" | undefined): string {
  if (kind === "summary")
    return "summary · the model reads the opaque block, editing this has no effect";
  if (kind === "full") return "full · echoed back next turn · editable with /edit N reasoning";
  return "kind unknown";
}

/** 思考:缺省一行淡斜体首句,多于一行或被截断时带 (N lines · Ctrl+T);Ctrl+T 展开成全文。 */
export function thinkingLines(
  text: string,
  kind: "full" | "summary" | undefined,
  expanded: boolean,
  width = 80,
): string[] {
  const body = text.trim();
  const all = body ? body.split("\n") : [];
  const sign = c.faint(G.note);
  if (!expanded) {
    const first = firstLine(body, width);
    const more =
      all.length > 1 || first.endsWith("…")
        ? `  ${c.faint(`(${all.length} line${all.length === 1 ? "" : "s"} · Ctrl+T)`)}`
        : "";
    return [`${sign} ${c.faint(c.italic(first))}${more}`];
  }
  return [
    `${sign} ${c.faint(`(${thinkingKind(kind)})`)}`,
    ...all.map((l) => `  ${c.faint(c.italic(l))}`),
  ];
}

/** 调用行:» 朱色(工具是朱的),名字加粗,参数次要色。 */
export function callLine(name: string, args: string): string {
  return `${c.zhu(G.call)} ${c.bold(c.ink(name))}  ${c.soft(args)}`;
}

/** 缺省的结果可见度:模型读过的原文不必再看(read/edit/write/glob/grep 只报行数),命令看尾部,其余看头部。 */
export const DEFAULT_RESULT_VIEWS: Record<string, ResultView> = {
  read: "count",
  edit: "count",
  write: "count",
  glob: "count",
  grep: "count",
  bash: "tail",
};

export function resultView(views: Record<string, ResultView>, name: string): ResultView {
  return views[name] ?? "head";
}

/** 出错的结果至少给这么多行:错误必须看得见。 */
const ERROR_LINES = 20;

/**
 * 工具结果:一行头(└ ✓/✗、名字、行数、耗时),正文缩到正文列。
 * 折叠按可见度:count 只有头;head 前 N 行;tail 后 N 行;all 全部。出错的结果不按 count 折。
 */
export function resultLines(
  r: { name: string; content: string; isError: boolean; durationMs?: number },
  opts: { folded: boolean; head: number; view: ResultView },
): string[] {
  // 静成功、响失败:✓ 是次要色,只有 ✗ 用朱。
  const mark = r.isError ? c.zhu(G.err) : c.soft(G.ok);
  const trimmed = r.content.trim();
  const all = trimmed ? trimmed.split("\n") : [];
  const meta = [
    all.length > 0 ? `${all.length} line${all.length === 1 ? "" : "s"}` : "no output",
    ...(r.durationMs !== undefined ? [fmtMs(r.durationMs)] : []),
    ...(r.isError ? ["error"] : []),
  ];
  const lines = [`${c.faint(G.body)} ${mark} ${c.soft(r.name)}${c.faint(`  ${meta.join(" · ")}`)}`];
  if (all.length === 0) return lines;
  const tone = r.isError ? c.soft : c.faint;
  const body = (l: string) => `  ${tone(l)}`;
  const more = (n: number, where: string) => `  ${c.soft(`… +${n} lines${where} · Ctrl+O`)}`;
  const view = r.isError ? "head" : opts.view;
  const head = r.isError ? Math.max(opts.head, ERROR_LINES) : opts.head;
  const limit = view === "count" ? 0 : head;
  if (!opts.folded || view === "all" || all.length <= limit) {
    lines.push(...all.map(body));
    return lines;
  }
  if (view === "count") return lines;
  if (view === "tail") {
    lines.push(more(all.length - head, " above"));
    lines.push(...all.slice(-head).map(body));
  } else {
    lines.push(...all.slice(0, head).map(body));
    lines.push(more(all.length - head, ""));
  }
  return lines;
}

type RequestErrorEvent = Extract<AgentEvent, { type: "request/error" }>;

/**
 * 请求失败:四行。分类与状态码、供应商原话、下一步、原始响应体在哪。原话原样,不转述。
 */
export function errorCardLines(
  e: RequestErrorEvent,
  ctx: { n: number; providerName?: string; model?: string; hint: string },
): string[] {
  const kind = e.kind ?? "unknown";
  const status = e.status !== undefined ? ` · HTTP ${e.status}` : "";
  return [
    `${c.zhu(G.err)} ${c.bold(c.zhu(`request #${ctx.n} failed`))}  ${c.soft(`${kind}${status}`)}`,
    `  ${c.ink(e.provider ?? firstLine(e.error, 120))}`,
    `  ${c.soft("next")}  ${c.ink(ctx.hint)}`,
    `  ${c.faint(
      e.body
        ? `${e.body.length} chars of response body saved · /raw ${ctx.n}`
        : `no response body (network or stream failure) · /raw ${ctx.n}`,
    )}`,
  ];
}

/**
 * 首屏:新用户输入任何东西之前看到的。一行,像输入框的占位符;说明都在 ? 与 /help 后面。
 */
export function firstRunLines(): string[] {
  return [
    c.faint("Ask anything · @path attaches a file · / commands · Ctrl+K palette · ? shortcuts"),
  ];
}

/** 论点两句:/help 的开头。 */
export function thesisLines(): string[] {
  return [
    c.soft("Everything the model sees, and everything the kernel decides, is one append-only log."),
    c.soft("This screen is a projection of it. So is every request."),
  ];
}

/** ? 键:全部快捷键,一屏说完。 */
export function shortcutLines(): string[] {
  const k = (key: string, what: string) => `  ${c.ink(key.padEnd(12))} ${c.soft(what)}`;
  return [
    c.soft("Shortcuts"),
    k("Enter", "send · Alt+Enter queue for after the current step · Shift+Enter new line"),
    k("Esc", "interrupt the running turn · release the step cursor"),
    k("Ctrl+K", "command palette: commands, models, skills, templates, login"),
    k("Ctrl+G", "write the message in $EDITOR"),
    k("PgUp PgDn", "step cursor · Enter folds or unfolds the step · Ctrl+↑ ↓ jump between prompts"),
    k(
      "Ctrl+E",
      "context: every message the model sees next, with tokens and state; Enter on a row for actions",
    ),
    k("Ctrl+R", "inspector: each request as sent and received · Tab cycles events · compactions"),
    k("Ctrl+O", "unfold or fold tool results (and cycle sub-agent views)"),
    k("Ctrl+T", "expand or collapse thinking"),
    k("Ctrl+C", "quit"),
    k("@path", "attach a file to the message"),
    k("/help", "all commands"),
  ];
}
