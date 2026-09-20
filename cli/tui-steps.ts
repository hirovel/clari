// 账簿:每次请求是一步,一步一个容器。最新几步全开,更早的自动折成一行账目(停止原因、调用、用量、缓存命中率、回复首行);
// PgUp / PgDn 在步之间移动光标并把那一步滚到视野顶,Enter 展开或折起,Esc 放开光标。
// 折叠只换屏幕上的节点,原节点留在内存里,展开就是放回去;日志一个字不动。
// 费用不在这一行:它是算出来的,放在状态行的累计与检视器里。
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { AgentEvent } from "../src/events.js";
import { firstLine } from "./cards.js";
import { fmtTok } from "./inspector.js";
import { c, G } from "./theme.js";
import { Block } from "./tui-block.js";
import type { StepView, TuiContext } from "./tui-context.js";
import { formatArgs } from "./tui-format.js";

/** 缺省保持展开的最新步数;配置 foldSteps,0 = 从不自动折。 */
export const FOLD_STEPS = 3;

/** 开一步:新容器挂到根上,之后的节点都进它。 */
export function beginStep(ctx: TuiContext, n: number, requestIndex: number): StepView {
  const block = new Container();
  const step: StepView = {
    n,
    requestIndex,
    block,
    nodes: [],
    summary: new Block(""),
    folded: false,
    pinned: false,
  };
  ctx.steps.push(step);
  ctx.root.addChild(block);
  ctx.transcript = block;
  return step;
}

/** 一步的账目:从它的 request 事件读到下一次 request 之前。 */
export function stepSummary(ctx: TuiContext, step: StepView): string {
  const events = ctx.log.events;
  const req = events[step.requestIndex];
  let stop = "";
  let calls = 0;
  let firstCall = "";
  let input = 0;
  let output = 0;
  let cacheRead: number | undefined;
  let reply = "";
  let failed: string | undefined;
  let compacted = false;
  for (let i = step.requestIndex + 1; i < events.length; i++) {
    const e = events[i] as AgentEvent;
    if (e.type === "request") break;
    if (e.type === "assistant/message") {
      stop = e.stopReason;
      calls += e.toolCalls.length;
      const tc = e.toolCalls[0];
      if (tc && !firstCall)
        firstCall = `${G.call} ${tc.name} ${firstLine(stripTerminalSequences(formatArgs(tc.args)), 40)}`;
      if (e.usage) {
        input += e.usage.inputTokens;
        output += e.usage.outputTokens;
        if (e.usage.cacheReadTokens !== undefined)
          cacheRead = (cacheRead ?? 0) + e.usage.cacheReadTokens;
      }
      if (e.text && !reply) reply = firstLine(e.text, 50);
    } else if (e.type === "request/error") failed = e.kind ?? "error";
    else if (e.type === "compaction") compacted = true;
  }
  const kind = req?.type === "request" && req.reason === "compaction" ? "compaction" : stop || "…";
  const parts = [
    failed ? c.zhu(`✗ ${failed}`) : kind,
    ...(calls > 1 ? [`${calls} calls`] : []),
    ...(input > 0 ? [`↑${fmtTok(input)} ↓${fmtTok(output)}`] : []),
    ...(cacheRead !== undefined && input > 0
      ? [`cache ${Math.round((cacheRead / input) * 100)}%`]
      : []),
    ...(compacted ? ["≈ compacted"] : []),
    ...(reply ? [reply] : firstCall ? [firstCall] : []),
  ];
  return parts.join(" · ");
}

function summaryText(ctx: TuiContext, step: StepView, selected: boolean): string {
  const head = `#${step.n}`;
  const body = stepSummary(ctx, step);
  return selected
    ? `${c.ink(G.cursor)} ${c.bold(c.ink(head))}  ${c.ink(body)}`
    : `${c.faint(G.fold)} ${c.soft(head)}  ${c.faint(body)}`;
}

export function foldStep(ctx: TuiContext, step: StepView): void {
  if (step.folded) return;
  step.nodes = [...step.block.children];
  step.block.clear();
  step.summary.setText(summaryText(ctx, step, ctx.view.selectedStep === ctx.steps.indexOf(step)));
  step.block.addChild(step.summary);
  step.folded = true;
  ctx.tui.requestRender();
}

export function unfoldStep(ctx: TuiContext, step: StepView): void {
  if (!step.folded) return;
  step.block.clear();
  for (const n of step.nodes) step.block.addChild(n);
  step.nodes = [];
  step.folded = false;
  ctx.tui.requestRender();
}

/** 新的一步开始时,把最新 keep 步之外的自动折起;用户手动展开过的(pinned)不再折。 */
export function autoFold(ctx: TuiContext): void {
  const keep = ctx.view.foldSteps;
  if (keep <= 0) return;
  const older = ctx.steps.slice(0, Math.max(0, ctx.steps.length - keep));
  for (const s of older) if (!s.folded && !s.pinned) foldStep(ctx, s);
}

/** 重画所有折起的账目行(选中态变了、价格变了)。 */
export function refreshSummaries(ctx: TuiContext): void {
  ctx.steps.forEach((s, i) => {
    if (s.folded) s.summary.setText(summaryText(ctx, s, ctx.view.selectedStep === i));
  });
}

/** 光标移一步(delta ±1);没有光标时 PgUp 从最后一步起,PgDn 从第一步起。 */
export function selectStep(ctx: TuiContext, delta: 1 | -1): StepView | undefined {
  const n = ctx.steps.length;
  if (n === 0) return undefined;
  const cur = ctx.view.selectedStep;
  let next: number;
  if (cur === undefined) next = delta < 0 ? n - 1 : 0;
  else next = Math.min(n - 1, Math.max(0, cur + delta));
  ctx.view.selectedStep = next;
  refreshSummaries(ctx);
  scrollToStep(ctx, ctx.steps[next] as StepView);
  ctx.updateStatus();
  return ctx.steps[next];
}

export function clearStepSelection(ctx: TuiContext): boolean {
  if (ctx.view.selectedStep === undefined) return false;
  ctx.view.selectedStep = undefined;
  refreshSummaries(ctx);
  ctx.updateStatus();
  return true;
}

/** Enter:折起的展开(记为 pinned,之后不再自动折),展开的折起。 */
export function toggleSelectedStep(ctx: TuiContext): boolean {
  const i = ctx.view.selectedStep;
  const step = i === undefined ? undefined : ctx.steps[i];
  if (!step) return false;
  if (step.folded) {
    unfoldStep(ctx, step);
    step.pinned = true;
  } else {
    foldStep(ctx, step);
    step.pinned = false;
  }
  scrollToStep(ctx, step);
  return true;
}

/** 备用屏:把这一步滚到视野顶。偏移 = 根上它之前所有节点的渲染高度之和。主屏没有滚动,只有光标。 */
export function scrollToStep(ctx: TuiContext, step: StepView): void {
  const scroll = ctx.scroll;
  if (!scroll) return;
  const width = scroll.getContentWidth(ctx.deps.terminal.columns);
  let offset = 0;
  for (const child of ctx.root.children) {
    if (child === step.block) break;
    offset += child.render(width).length;
  }
  scroll.scrollTo(offset, { disableFollow: true });
  ctx.tui.requestRender();
}
