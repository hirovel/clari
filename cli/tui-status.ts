// 运行界面的固定状态与输入提示。只投影已有事件与状态,不改变 Agent 的执行策略。
import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { contextTokens } from "../src/compaction.js";
import { fmtCostApprox } from "../src/cost.js";
import type { AgentEvent } from "../src/events.js";
import { shortcutLines } from "./cards.js";
import { fmtTok } from "./inspector.js";
import { c, G } from "./theme.js";
import type { TuiContext } from "./tui-context.js";

/** 按优先级取完整片段;次要信息放不下就留在检视器,不截出半个操作。 */
function fitParts(parts: string[], width: number): string {
  let out = "";
  for (const part of parts.filter((part) => visibleWidth(part) > 0)) {
    const next = out ? `${out} · ${part}` : part;
    if (visibleWidth(next) <= width) out = next;
    else if (!out) out = truncateToWidth(part, width, "…");
  }
  return out;
}

export class RuntimeStatus implements Component {
  private phase = "Ready";
  private work: string | undefined;
  private outcome: "failed" | "interrupted" | undefined;
  private pending = new Map<string, string>();
  private unknown = 0;
  constructor(private readonly context: () => TuiContext) {}

  begin(message: string): void {
    this.work = message;
    this.phase = message === "thinking" ? "Waiting for model" : message;
    this.outcome = undefined;
    this.pending.clear();
    this.unknown = 0;
  }
  end(): void {
    this.work = undefined;
  }

  observe(e: AgentEvent): void {
    switch (e.type) {
      case "user/message":
        this.outcome = undefined;
        break;
      case "request":
        this.unknown = 0;
        this.phase = e.reason === "compaction" ? "Compacting context" : "Waiting for model";
        this.pending.clear();
        this.outcome = undefined;
        break;
      case "assistant/message":
        this.pending = new Map(e.toolCalls.map((t) => [t.id, t.name]));
        if (e.stopReason === "aborted") this.outcome = "interrupted";
        break;
      case "tool/result":
        this.pending.delete(e.callId);
        if (e.outcome === "unknown") this.unknown++;
        break;
      case "retry":
        this.phase = `Retry ${e.attempt} · waiting ${Math.ceil(e.delayMs / 1000)}s`;
        break;
      case "request/error":
        this.outcome = "failed";
        break;
      case "session/interrupt":
        this.outcome = "interrupted";
        break;
      case "tool/unresolved":
        this.unknown++;
        break;
    }
  }

  invalidate(): void {}
  render(width: number): string[] {
    const ctx = this.context();
    const { agent, view } = ctx;
    const inner = Math.max(1, width - 2);
    const unsaved = [ctx.log, ...ctx.children.views.map((v) => v.info.log)].find(
      (log) => log.recording?.error,
    );
    const busy = agent.running || this.work !== undefined;
    let label = "Ready";
    if (!busy && this.unknown)
      label = `${this.outcome === "interrupted" ? "Interrupted · " : ""}${this.unknown} tool ${this.unknown === 1 ? "result" : "results"} unknown`;
    else if (this.outcome === "failed") label = "Request failed";
    else if (this.outcome === "interrupted") label = agent.running ? "Interrupting" : "Interrupted";
    else if (ctx.approval.prompt) label = "Waiting for approval";
    else if (busy) {
      const names = [...new Set(this.pending.values())];
      label = names.length
        ? `Tools · ${names.join(", ")} (${this.pending.size} pending)`
        : view.streaming
          ? "Receiving reply"
          : view.reasoningView
            ? "Receiving thinking"
            : this.phase;
    }
    const urgent = Boolean(this.outcome === "failed" || ctx.approval.prompt);
    const mark = busy ? G.running : G.idle;
    const state = (urgent ? c.zhu : busy ? c.ink : c.soft)(`${mark} ${label}`);
    const elapsed =
      busy && view.turnStartedAt !== undefined
        ? `${Math.round((Date.now() - view.turnStartedAt) / 1000)}s`
        : "";
    const children = ctx.children.views.filter((v) => v.running).length;
    const selected =
      view.selectedStep !== undefined
        ? `step ${view.selectedStep + 1}/${ctx.steps.length}`
        : ctx.scroll && !ctx.scroll.isFollowingEnd
          ? "Reading history"
          : "";
    const first = fitParts(
      [
        state,
        !busy && this.unknown ? c.jin("/session recovery") : "",
        c.soft(selected),
        agent.queued
          ? c.jin(
              `${agent.pending.filter((p) => p.paused).length} paused · ${agent.pending.filter((p) => !p.paused).length} queued`,
            )
          : "",
        ctx.deps.inputs?.error ? c.zhu("Inputs not saved") : "",
        elapsed ? c.faint(elapsed) : "",
        children ? c.faint(`${children} sub-agents running`) : "",
        this.outcome === "failed" ? c.soft("/edit retry · /raw") : "",
      ],
      inner,
    );
    const total = ctx.usage.totals();
    let context = "Context · no requests yet";
    if (view.lastUsage || ctx.req.count > 0) {
      const used = contextTokens(ctx.log.events);
      const threshold = Math.max(1, ctx.threshold());
      const trigger = ctx.compaction.trigger ?? "threshold";
      // 带用量基准仍是估算;窗口与压缩触发点是两件事,不把手动模式写成自动倒计时。
      context = `Context ~${fmtTok(used)}/${fmtTok(ctx.model.contextWindow)}`;
      context +=
        trigger === "threshold"
          ? ` · auto-compact ~${fmtTok(threshold)}`
          : trigger === "manual"
            ? " · compact manual"
            : ` · remind ~${fmtTok(threshold)}`;
      if (used >= threshold && trigger !== "threshold") context += " · /compact";
    }
    const pulse =
      view.pulse.length > 1
        ? view.pulse
            .map((ratio) => "▁▂▃▄▅▆▇█"[Math.min(7, Math.max(0, Math.round(ratio * 7)))])
            .join("")
        : "";
    const second = fitParts(
      [
        c.faint(context),
        total.cost !== undefined ? c.soft(fmtCostApprox(total.cost)) : "",
        agent.effort ? c.faint(`effort ${agent.effort}`) : "",
        total.requests
          ? c.faint(`this session ↑${fmtTok(total.inputTokens)} ↓${fmtTok(total.outputTokens)}`)
          : "",
        total.cacheReadTokens ? c.faint(`cache ${fmtTok(total.cacheReadTokens)}`) : "",
        c.faint(pulse),
      ],
      inner,
    );
    const gaps = [ctx.log, ...ctx.children.views.map((v) => v.info.log)].reduce(
      (n, log) =>
        n +
        log.events.filter(
          (e) => e.type === "ext/event" && e.source === "recording" && e.kind === "body/gap",
        ).length,
      0,
    );
    const saving = unsaved
      ? "Not saved · work continues · auto retry / Ctrl+S"
      : gaps
        ? `${gaps} recording gap(s) · inspect for details`
        : undefined;
    return [` ${first}`, ` ${saving ? c.zhu(truncateToWidth(saving, inner, "…")) : second}`];
  }
}

/** 每次渲染读编辑器状态,提示与 Enter 的真实行为保持一致。 */
export class InputHints implements Component {
  constructor(private readonly context: () => TuiContext) {}
  invalidate(): void {}
  render(width: number): string[] {
    const ctx = this.context();
    const text = ctx.editor.getText();
    const history =
      ctx.view.selectedStep !== undefined || (ctx.scroll && !ctx.scroll.isFollowingEnd);
    let parts: string[];
    if (ctx.editor.isShowingAutocomplete()) parts = ["↑↓ choose", "Tab complete", "Esc dismiss"];
    else if (history && !text && !ctx.draftImages.length)
      parts = [
        "Esc return live",
        !text && ctx.view.selectedStep !== undefined ? "Enter fold/unfold" : "",
        "PgUp/PgDn steps",
      ];
    else if (text.startsWith("/")) parts = ["Enter run command", "Ctrl+K palette"];
    else if (ctx.agent.running) {
      const boundary = ctx.slots.state.steering === "turn" ? "after turn" : "next step";
      parts = ["Esc interrupt", `Enter ${boundary}`, "Alt+Enter follow-up"];
    } else
      parts = [
        "Enter send",
        ctx.agent.queued || ctx.deps.inputs?.error ? "/session inputs" : "Ctrl+K palette",
        "Ctrl+R requests",
        "/help",
      ];
    const attachments = ctx.inputReading
      ? "Reading clipboard…"
      : ctx.draftImages.length
        ? `${ctx.draftImages.length} image(s) attached · Alt+I inspect/remove · Enter sends`
        : "";
    return [
      ...(attachments ? [` ${c.jin(truncateToWidth(attachments, Math.max(1, width - 2)))}`] : []),
      ` ${c.faint(fitParts(parts, Math.max(1, width - 2)))}`,
    ];
  }
}

/** 帮助占用独立焦点,不把反复查看的说明追加到工作记录。 */
export function openShortcutHelp(ctx: TuiContext): void {
  let offset = 0;
  let page = 1;
  let length = 0;
  const help: Component = {
    invalidate() {},
    render(width) {
      const inner = Math.max(1, width - 4);
      const lines = shortcutLines()
        .slice(1)
        .flatMap((line) => wrapTextWithAnsi(line, inner));
      page = Math.max(1, ctx.deps.terminal.rows - 5);
      length = lines.length;
      offset = Math.min(offset, Math.max(0, length - page));
      return [
        c.bold(c.ink(" Shortcuts")),
        "",
        ...lines.slice(offset, offset + page).map((line) => ` ${line}`),
        "",
        c.faint(` ↑↓ scroll · Esc close · ${Math.min(length, offset + page)}/${length}`),
      ];
    },
    handleInput(data) {
      if (matchesKey(data, Key.escape)) ctx.dialog.close();
      else {
        if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
        if (matchesKey(data, "down")) offset = Math.min(Math.max(0, length - page), offset + 1);
        if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - page);
        if (matchesKey(data, "pageDown"))
          offset = Math.min(Math.max(0, length - page), offset + page);
        ctx.tui.requestRender();
      }
    },
  };
  ctx.dialog.open(help);
}
