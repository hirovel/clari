// 呈现:UI 是事件流的订阅者。每条事件到屏幕的映射都在 render 里;历史回放与新事件走同一个函数。
// 这里还有子 agent 视图、流式回复与思考的增量绘制、折叠/展开两个显示开关。
import { type Component, Container, Markdown, Spacer } from "@earendil-works/pi-tui";
import type { AgentEvent } from "../src/events.js";
import { type Composition, composeContext, type Message } from "../src/messages.js";
import { parseEffort } from "../src/provider.js";
import { classifyError, type ErrorKind, hintFor } from "../src/providers/errors.js";
import type { ChildInfo } from "../src/subagent.js";
import {
  callLine,
  cont,
  errorCardLines,
  GUTTER,
  paramsLine,
  predictedCache,
  rawRow,
  receiveBlockLines,
  receiveHead,
  resultLines,
  sendCardLines,
  unchangedPrefix,
} from "./cards.js";
import { renderExtEvent } from "./ext-events.js";
import { fmtMs, fmtTok, messagesFor } from "./inspector.js";
import { c, G, markdownTheme } from "./theme.js";
import { Block } from "./tui-block.js";
import {
  CHILD_TAIL,
  type ChildMode,
  GUIDE,
  type ResultRecord,
  type TuiContext,
} from "./tui-context.js";
import { formatArgs, toolCallDetail } from "./tui-format.js";

/** 工具结果的屏幕文本。折叠只是显示状态,内容原封不动留在节点里。 */
export function resultText(ctx: TuiContext, r: ResultRecord): string {
  return resultLines(r, { folded: ctx.view.foldResults, head: ctx.view.foldLines }).join("\n");
}

/**
 * 带标签的 Markdown:标签占标签沟,正文从内容列起,首行与标签同一行。
 * 流式回复与回放都用它;setText 换正文,标签不动。
 */
export class LabeledMarkdown implements Component {
  private readonly md: Markdown;

  constructor(
    private readonly label: string,
    text = "",
  ) {
    this.md = new Markdown(text, 0, 0, markdownTheme, { color: c.ink });
  }

  setText(text: string): void {
    this.md.setText(text);
  }

  invalidate(): void {
    this.md.invalidate();
  }

  render(width: number): string[] {
    const inner = Math.max(10, width - GUTTER - 4);
    const lines = this.md.render(inner);
    const first = ` ${c.faint(this.label.padEnd(GUTTER))}  `;
    const rest = ` ${" ".repeat(GUTTER)}  `;
    return lines.map((l, i) => (i === 0 ? first : rest) + l);
  }
}

/** Ctrl+O:父的工具结果折叠/展开;子 agent 块在 尾窗 → 全部 → 仅进度 间轮换。 */
export function toggleFold(ctx: TuiContext): void {
  const v = ctx.view;
  v.foldResults = !v.foldResults;
  for (const r of v.resultNodes) r.node.setText(resultText(ctx, r));
  const order: ChildMode[] = ["tail", "all", "progress"];
  v.childMode = order[(order.indexOf(v.childMode) + 1) % order.length] as ChildMode;
  for (const view of ctx.children.views) view.refresh();
  const kids =
    ctx.children.views.length > 0
      ? `; sub-agents: ${v.childMode === "tail" ? "tail" : v.childMode === "all" ? "all" : "progress only"}`
      : "";
  ctx.note(
    c.faint(`· tool results ${v.foldResults ? "folded (Ctrl+O to unfold)" : "unfolded"}${kids}`),
  );
}

export function toggleReasoning(ctx: TuiContext): void {
  const v = ctx.view;
  v.showReasoning = !v.showReasoning;
  for (const r of v.reasoningNodes) r.node.setText(ctx.renderReasoning(r.text, r.kind));
  if (v.reasoningView) v.reasoningView.setText(ctx.renderReasoning(v.reasoningBuffer));
  ctx.note(
    c.faint(v.showReasoning ? "· thinking expanded" : "· thinking collapsed to one line (Ctrl+T)"),
  );
}

/** 流式回复正文:一行 reply 标签,正文缩进到标签沟的内容列,Markdown 照常渲染。 */
export function streamDelta(ctx: TuiContext, d: string): void {
  const v = ctx.view;
  if (!v.streaming) {
    v.streaming = new LabeledMarkdown("reply");
    ctx.transcript.addChild(v.streaming);
  }
  v.streamBuffer += d;
  v.streaming.setText(v.streamBuffer);
  ctx.tui.requestRender();
}

/** 推理内容不隐藏:thinking 模型的思考过程以淡字实时呈现。 */
export function streamReasoning(ctx: TuiContext, d: string): void {
  const v = ctx.view;
  if (!v.reasoningView) {
    v.reasoningView = new Block("");
    ctx.transcript.addChild(v.reasoningView);
  }
  v.reasoningBuffer += d;
  v.reasoningView.setText(ctx.renderReasoning(v.reasoningBuffer));
  ctx.tui.requestRender();
}

/** 更新某次请求的接收卡头行;n 是它的请求序号。 */
export function setReceiveHead(
  ctx: TuiContext,
  requestIndex: number,
  n: number,
  fill: Partial<Parameters<typeof receiveHead>[0]>,
): void {
  const node = ctx.req.receiveHeads.get(requestIndex);
  const req = ctx.log.events[requestIndex];
  if (!node || req?.type !== "request") return;
  const price = ctx.priceFor(req.model);
  const predicted = ctx.req.predictedAt.get(requestIndex);
  node.setText(
    receiveHead({
      n,
      estimated: req.estimatedTokens,
      ...(price && { price }),
      ...(predicted !== undefined && { predictedCache: predicted }),
      ...fill,
    }),
  );
}

// ---------- 子 agent 视图 ----------

export class ChildView {
  readonly block = new Container();
  private readonly progress = new Block("");
  private readonly body = new Block("");
  private readonly lines: string[] = [];
  private steps = 0;
  private toolsUsed = 0;
  private tokens = 0;
  private readonly startedAt = Date.now();
  private finishedAt: number | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(
    private readonly ctx: TuiContext,
    readonly info: ChildInfo,
  ) {
    this.block.addChild(this.progress);
    this.block.addChild(this.body);
    // 起始事件(继承的父上下文、任务简报)不重画:父屏幕上已经有它们;只画子自己产生的。
    // 结束即退订:续聊在同一日志上再跑,新事件归新的视图,旧视图定格。
    this.unsubscribe = info.log.subscribe((e) => {
      this.absorb(e);
      this.refresh();
    });
    this.timer = setInterval(() => this.refresh(), 1000);
    this.refresh();
  }

  get running(): boolean {
    return this.finishedAt === undefined;
  }

  private absorb(e: AgentEvent): void {
    if (e.type === "assistant/message") {
      this.steps += 1;
      if (e.usage) this.tokens = e.usage.inputTokens;
    }
    if (e.type === "tool/result") this.toolsUsed += 1;
    this.lines.push(...childEventLines(e).map((l) => GUIDE + l));
  }

  finish(): void {
    this.finishedAt = Date.now();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.refresh();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  refresh(): void {
    const mode = this.ctx.view.childMode;
    const elapsed = fmtMs((this.finishedAt ?? Date.now()) - this.startedAt);
    const stats = `step ${this.steps} · ${this.toolsUsed} tool calls · ${elapsed}${this.tokens ? ` · ${fmtTok(this.tokens)} tok` : ""}`;
    const who = `${this.info.id}${this.info.type !== "default" ? ` ${this.info.type}` : ""}${this.info.resumed ? " resumed" : ""}`;
    const status = this.info.state.status;
    const head = this.running
      ? `${c.zhu("●")} ${c.soft(`${who} · running · ${stats}`)}`
      : status === "completed"
        ? `${c.soft(G.ok)} ${c.soft(`${who} · done · ${stats}`)}`
        : status === "stopped"
          ? `${c.soft(G.note)} ${c.soft(`${who} · stopped (${this.info.state.reason ?? "termination policy"}) · resumable · ${stats}`)}`
          : `${c.zhu("✗")} ${c.soft(`${who} · partial · ${stats}`)}`;
    this.progress.setText(GUIDE + head);
    let body: string;
    if (mode === "progress" || (!this.running && mode !== "all")) {
      body =
        GUIDE +
        c.faint(
          `sub-session ${this.lines.length} lines · Ctrl+O to expand${this.info.log.path ? ` · ${this.info.log.path}` : ""}`,
        );
    } else if (mode === "all") {
      body = this.lines.length > 0 ? this.lines.join("\n") : GUIDE + c.faint("(no output yet)");
    } else {
      const tail = this.lines.slice(-CHILD_TAIL);
      const more =
        this.lines.length > CHILD_TAIL
          ? [GUIDE + c.faint(`… ${this.lines.length} lines in the sub-session · Ctrl+O for all`)]
          : [];
      body = [...tail, ...more].join("\n") || GUIDE + c.faint("(no output yet)");
    }
    this.body.setText(body);
    this.ctx.tui.requestRender();
  }
}

/** 子 agent 开跑时由 task 工具通知:挂到对应调用行下面的槽,没有槽就接在末尾。 */
export function attachChild(ctx: TuiContext, child: ChildInfo): void {
  const view = new ChildView(ctx, child);
  ctx.children.views.push(view);
  const slot = child.callId ? ctx.children.slots.get(child.callId) : undefined;
  if (slot) slot.addChild(view.block);
  else ctx.transcript.addChild(view.block);
  ctx.updateStatus();
}

/** 子 agent 事件的屏幕行(不含引导线),与主屏同一套记号:› » ✓ ✗ ·。 */
export function childEventLines(e: AgentEvent): string[] {
  switch (e.type) {
    case "user/message":
      return [`${c.zhu(G.you)} ${c.ink(e.text)}`];
    case "assistant/message": {
      const lines: string[] = [];
      if (e.reasoning)
        lines.push(
          ...e.reasoning
            .trim()
            .split("\n")
            .map((l) => c.faint(c.italic(l))),
        );
      if (e.text)
        lines.push(
          ...e.text
            .trim()
            .split("\n")
            .map((l) => c.ink(l)),
        );
      for (const tc of e.toolCalls) {
        lines.push(`${c.zhu(G.call)} ${c.bold(c.ink(tc.name))}  ${c.soft(formatArgs(tc.args))}`);
      }
      if (e.stopReason === "aborted") lines.push(c.faint("— interrupted —"));
      return lines;
    }
    case "tool/result": {
      const mark = e.isError ? c.zhu(G.err) : c.soft(G.ok);
      const body = e.content.trim().split("\n");
      const meta = [
        ...(body.length > 1 ? [`${body.length} lines`] : []),
        ...(e.durationMs !== undefined ? [fmtMs(e.durationMs)] : []),
      ];
      return [
        `${mark} ${c.soft(e.name)}${meta.length ? c.faint(`  ${meta.join(" · ")}`) : ""}`,
        ...body.map((l) => (e.isError ? c.soft(`  ${l}`) : c.faint(`  ${l}`))),
      ];
    }
    case "retry":
      return [c.faint(`· retry ${e.attempt}: ${e.status ?? ""} ${e.error.split("\n")[0]}`)];
    case "request/error":
      return [c.zhu(`✗ request failed: ${e.error.split("\n")[0]}`)];
    case "compaction":
      return [c.jin(`≈ compacted${e.strategy ? ` (${e.strategy})` : ""}`)];
    default:
      return [];
  }
}

// ---------- 主屏:一条事件一段屏幕 ----------

function renderUser(ctx: TuiContext, text: string): void {
  if (ctx.view.firstRun) {
    ctx.transcript.removeChild(ctx.view.firstRun);
    ctx.view.firstRun = undefined;
  }
  // 用户消息:朱色 › 起头,正文加粗,整块一条底带;续行缩到 › 之后。
  ctx.transcript.addChild(new Spacer(1));
  ctx.transcript.addChild(new Block(`${c.zhu(G.you)} ${c.bold(c.ink(text))}`, { bg: c.band }));
}

function renderAssistant(
  ctx: TuiContext,
  e: Extract<AgentEvent, { type: "assistant/message" }>,
): void {
  const { view: v, transcript, req } = ctx;
  // 接收卡头行:停止原因、耗时、实测用量、缓存命中率、费用。
  setReceiveHead(ctx, req.lastTurnIndex, req.count, { response: e });
  if (v.reasoningView) {
    if (e.reasoning) {
      v.reasoningView.setText(ctx.renderReasoning(e.reasoning, e.reasoningKind));
      v.reasoningNodes.push({
        node: v.reasoningView,
        text: e.reasoning,
        ...(e.reasoningKind && { kind: e.reasoningKind }),
      });
    } else transcript.removeChild(v.reasoningView);
    v.reasoningView = undefined;
    v.reasoningBuffer = "";
  } else if (e.reasoning) {
    const node = new Block(ctx.renderReasoning(e.reasoning, e.reasoningKind));
    v.reasoningNodes.push({
      node,
      text: e.reasoning,
      ...(e.reasoningKind && { kind: e.reasoningKind }),
    });
    transcript.addChild(node);
  }
  if (v.streaming) {
    if (e.text) v.streaming.setText(e.text);
    else transcript.removeChild(v.streaming);
    v.streaming = undefined;
    v.streamBuffer = "";
  } else if (e.text) {
    transcript.addChild(new LabeledMarkdown("reply", e.text));
  }
  if (e.usage) v.lastUsage = e.usage;
  for (const tc of e.toolCalls) {
    transcript.addChild(new Block(callLine(tc.name, formatArgs(tc.args))));
    // edit/write 的改动内容直接可见:diff 从参数算出,不进日志。续行缩进到内容列。
    const detail = toolCallDetail(tc.name, tc.args);
    if (detail) {
      transcript.addChild(
        new Block(
          detail
            .split("\n")
            .map((l) => cont(l))
            .join("\n"),
        ),
      );
    }
    // task 调用行下面留一个槽,子 agent 开跑时把它的块挂进来。
    if (tc.name === "task") {
      const slot = new Container();
      ctx.children.slots.set(tc.id, slot);
      transcript.addChild(slot);
    }
  }
  // 响应里除思考与文本之外的块:私有回传物(签名思考块、加密推理项)。
  for (const l of receiveBlockLines(e)) transcript.addChild(new Block(l));
  // 原始流缺省开:每张接收卡尾行说明收了几行、去哪看。
  if (ctx.deps.trace) {
    const raw = req.rawAt.get(req.lastTurnIndex);
    if (raw) transcript.addChild(new Block(rawRow(raw.length, req.count)));
  }
  if (e.stopReason === "aborted") ctx.note(c.faint("— interrupted —"));
  if (e.stopReason === "length")
    ctx.note(c.zhu("· output truncated; the model was asked to resend"));
}

function renderToolResult(ctx: TuiContext, e: Extract<AgentEvent, { type: "tool/result" }>): void {
  // 默认完整显示,不折叠;Ctrl+O 切换折叠,内容仍在节点里。
  const rec: ResultRecord = {
    name: e.name,
    content: e.content,
    isError: e.isError,
    ...(e.durationMs !== undefined && { durationMs: e.durationMs }),
  };
  const node = new Block(resultText(ctx, rec));
  ctx.view.resultNodes.push({ node, ...rec });
  ctx.transcript.addChild(node);
  const child = ctx.children.views.find((v) => v.info.callId === e.callId && v.running);
  if (child) child.finish();
}

/**
 * 发送卡(可见性的核心):这次实际发出的消息(正常步 = 之前事件的投影;摘要请求 = 记录的 body),
 * 与上一次正常步比出"未变 / 新增",参数来自 provider.wire,与线路正文同源。
 */
function renderRequest(ctx: TuiContext, e: Extract<AgentEvent, { type: "request" }>): void {
  const { log, agent, req, transcript } = ctx;
  req.count += 1;
  req.lastIndex = log.events.length - 1;
  req.providersAt.set(req.lastIndex, agent.provider);
  // 来历:正常步的正文就是之前事件的投影,每条都能对回事件号;摘要请求的正文由策略记的 body 重建,没有来历。
  // 一次投影同时给消息与来历,不再算两遍。
  let messages: Message[];
  let provenance: Composition["provenance"] | undefined;
  if (e.body) {
    messages = messagesFor(log.events, {
      index: req.lastIndex,
      request: e,
      n: req.count,
      retries: [],
      before: [],
    });
  } else {
    const comp = composeContext(log.events, req.lastIndex);
    messages = comp.messages;
    provenance = comp.provenance;
  }
  const activeDefs = ctx.defs().filter((d) => e.tools.includes(d.name));
  const level = e.effort ? parseEffort(e.effort) : undefined;
  const wire = agent.provider.wire?.(messages, activeDefs, level ? { effort: level } : {});
  const start = log.events.find((x) => x.type === "session/start");
  const toolSig = JSON.stringify(activeDefs);
  transcript.addChild(new Spacer(1));
  const cardLines = sendCardLines({
    n: req.count,
    request: e,
    messages,
    ...(req.lastSent && { previous: req.lastSent }),
    ...(wire !== undefined && { wire }),
    ...(req.lastParams !== undefined && { previousParams: req.lastParams }),
    defs: activeDefs,
    ...(start?.type === "session/start" && start.sections && { sections: start.sections }),
    ...(provenance && { provenance }),
    width: Math.max(24, ctx.deps.terminal.columns - 52),
    toolsUnchanged: toolSig === req.lastToolSig,
    // 回放历史:不是最后一次的请求卡马上会折成两行,只画那两行。
    collapsed: req.lastIndex < req.finalRequestIndex,
    dropsThinking: agent.provider.fields?.protocol.startsWith("anthropic") ?? false,
  });
  // 旧的 Request 卡折成两行(头 + changed,):当步的信息在新卡上,全文永远在检视器。
  if (req.lastCard) req.lastCard.node.setText(req.lastCard.lines.slice(0, 2).join("\n"));
  const cardNode = new Block(cardLines.join("\n"));
  req.lastCard = { node: cardNode, lines: cardLines };
  transcript.addChild(cardNode);
  req.predictedAt.set(
    req.lastIndex,
    predictedCache(req.lastSent, messages, unchangedPrefix(req.lastSent, messages)),
  );
  req.lastToolSig = toolSig;
  req.lastParams = paramsLine(wire);
  if (e.reason === "compaction") req.lastCompactionIndex = req.lastIndex;
  else {
    req.lastTurnIndex = req.lastIndex;
    req.lastSent = messages;
  }
  // 接收卡头行先占位,响应到了再填。思考与正文节点随后接在它下面。
  const headNode = new Block("");
  req.receiveHeads.set(req.lastIndex, headNode);
  transcript.addChild(headNode);
  setReceiveHead(ctx, req.lastIndex, req.count, {});
}

function renderRequestError(
  ctx: TuiContext,
  e: Extract<AgentEvent, { type: "request/error" }>,
): void {
  // 接收卡头行标成失败,下面画错误卡:分类、供应商原话、下一步、原始体在哪。
  const { req, log } = ctx;
  const info = ctx.model.info;
  const request = log.events[req.lastIndex];
  const kind = (e.kind ?? classifyError(new Error(e.error))) as ErrorKind;
  // 头行只写分类与状态码;原话与下一步在错误卡里,不重复。
  setReceiveHead(ctx, req.lastIndex, req.count, {
    error: `${kind}${e.status !== undefined ? ` · HTTP ${e.status}` : ""}`,
  });
  const lines = errorCardLines(e, {
    n: req.count,
    providerName: info.providerName,
    ...(request?.type === "request" && { model: request.model }),
    hint: hintFor(kind, { providerName: info.providerName, model: info.model }),
  });
  ctx.transcript.addChild(new Block(lines.join("\n")));
}

function renderCompaction(ctx: TuiContext, e: Extract<AgentEvent, { type: "compaction" }>): void {
  const { req, log } = ctx;
  if (e.usage) {
    const n = log.events
      .slice(0, req.lastCompactionIndex + 1)
      .filter((x) => x.type === "request").length;
    setReceiveHead(ctx, req.lastCompactionIndex, n, { compaction: e });
  }
  const parts: string[] = [];
  if (e.summary !== undefined)
    parts.push(`summary covers events ${e.coversFrom ?? 1}-${e.coversUpTo}`);
  if (e.cleared?.length) parts.push(`cleared ${e.cleared.length} tool results`);
  const cost = e.usage
    ? `  summary request · ${fmtTok(e.usage.inputTokens)}→${fmtTok(e.usage.outputTokens)} tok · ${fmtMs(e.latencyMs)}`
    : "";
  const who = e.strategy ? ` (${e.strategy})` : "";
  ctx.note(
    `${c.jin(`≈ compacted${who}: ${parts.join(", ")}`)}${c.faint(`${cost}  /compactions to compare original and summary`)}`,
  );
}

/** 一条事件 → 屏幕。历史回放与实时订阅都走这里。 */
export function render(ctx: TuiContext, e: AgentEvent): void {
  ctx.usage.add(e);
  switch (e.type) {
    case "user/message":
      renderUser(ctx, e.text);
      break;
    case "assistant/message":
      renderAssistant(ctx, e);
      break;
    case "tool/result":
      renderToolResult(ctx, e);
      break;
    case "request":
      renderRequest(ctx, e);
      break;
    case "retry":
      ctx.note(
        c.faint(
          `· retry ${e.attempt}: ${e.status ?? ""} ${e.error.split("\n")[0]}, next attempt in ${fmtMs(e.delayMs)}`,
        ),
      );
      break;
    case "decision":
      if (e.slot === "steering")
        ctx.note(c.faint(`· steering: injected ${e.injected} (${e.boundary} boundary)`));
      if (e.slot === "execution")
        ctx.note(c.faint(`· parallel: ${e.parallel} calls at once: ${e.tools.join(", ")}`));
      break;
    case "request/error":
      renderRequestError(ctx, e);
      break;
    case "compaction":
      renderCompaction(ctx, e);
      break;
    case "session/model":
      ctx.note(c.soft(`· model switched to ${e.model}`));
      break;
    case "session/slot":
      // 恢复会话时把历史切换也画出来;当前会话里 slotCommand 已经打过确认行,这里只补状态。
      ctx.slots.state[e.slot] = e.value;
      break;
    case "session/recovered":
      ctx.note(
        c.soft(
          `· recovered: dropped ${e.droppedBytes} bytes of a half-written line at the end of the log (the process died mid-write)`,
        ),
      );
      break;
    case "ext/event": {
      const r = renderExtEvent(e);
      if (r) ctx.note(c[r.tone](r.text));
      break;
    }
    case "session/interrupt":
    case "session/start":
      break;
  }
  ctx.updateStatus();
}
