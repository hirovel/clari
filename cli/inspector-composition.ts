// 组装视图与上下文面板的动作:模型下一步会看到的每条消息从哪来、经过了什么、落在线路的第几条;
// 选中一条消息能做什么,每项带后果。
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { AgentEvent } from "../src/events.js";
import { type Composition, composeContext, editState, type Message } from "../src/messages.js";
import type { Provider } from "../src/provider.js";
import { firstLine, fmtTok, indent, messageTokens, roleLabel } from "./inspector-format.js";
import { c } from "./theme.js";

// ---------- 组装视图:模型下一步会看到的每条消息从哪来、经过了什么、落在线路的第几条 ----------

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
      ? `» ${m.toolCalls.map((t) => t.name).join(" ")}`
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
    lines.push(c.bold(c.soft(`reasoning (${m.reasoningKind ?? "?"})`)));
    lines.push(...indent(m.reasoning).map((l) => c.faint(c.italic(l))));
    lines.push("");
  }
  lines.push(c.bold(c.soft("content")));
  lines.push(...(m.content ? indent(m.content).map((l) => c.ink(l)) : [c.faint("    (empty)")]));
  if (m.role === "assistant" && m.toolCalls.length > 0) {
    lines.push("");
    lines.push(c.bold(c.soft(`tool calls ${m.toolCalls.length}`)));
    for (const tc of m.toolCalls)
      lines.push(c.soft(`    » ${tc.name} ${JSON.stringify(tc.args)}  ${c.faint(tc.id)}`));
  }
  if (m.role === "assistant" && m.opaque !== undefined) {
    lines.push("");
    lines.push(
      c.faint(`opaque: ${(m.opaque as { kind?: string }).kind ?? "?"} · echoed back verbatim`),
    );
  }
  return lines;
}

// ---------- 上下文面板的动作:选中一条消息,Enter 列出能做什么,每项带后果 ----------

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
    `input changes from #${r.event} on; cache impact unconfirmed`,
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
