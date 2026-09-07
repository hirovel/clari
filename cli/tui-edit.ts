// 编辑上下文:改的是投影,不是历史。每个动作都是追加一条 context/edit 或 context/drop 事件,
// 原文永远留在数组里。/edit /drop /compare /restore /rewind /retry /edits /fork,以及上下文面板的动作菜单。
import { now } from "../src/events.js";
import { editState } from "../src/messages.js";
import { forkSession, SESSIONS_DIR } from "./bootstrap.js";
import { editInExternalEditor } from "./editor.js";
import type { CompositionRow, ContextAction } from "./inspector.js";
import { c } from "./theme.js";
import type { TuiContext } from "./tui-context.js";
import { toolCallDetail } from "./tui-format.js";

type EditField = "text" | "reasoning" | "content" | "system";

const BUSY = "cannot edit while running; press Esc first";

/** 目标事件允许改哪些字段,以及各字段当前(投影里)的值。 */
function editable(
  ctx: TuiContext,
  target: number,
): { fields: EditField[]; current: (f: EditField) => string } | string {
  const { log } = ctx;
  const e = log.events[target];
  if (!e) return `no event #${target} (${log.events.length} events; Ctrl+E shows event numbers)`;
  const cur = editState(log.events).edits.get(target) ?? {};
  switch (e.type) {
    case "assistant/message":
      return {
        fields: ["text", "reasoning"],
        current: (f) =>
          f === "reasoning" ? (cur.reasoning ?? e.reasoning ?? "") : (cur.text ?? e.text),
      };
    case "user/message":
      return { fields: ["content"], current: () => cur.content ?? e.text };
    case "tool/result":
      return { fields: ["content"], current: () => cur.content ?? e.content };
    case "session/start":
      return { fields: ["system"], current: () => cur.system ?? e.system };
    default:
      return `event #${target} is ${e.type}; it never reaches the model, nothing to edit`;
  }
}

/** 编辑的后果,保存时一并打印:缓存前缀失效、回传物丢弃、Anthropic 之后思考块全丢。 */
function editConsequences(ctx: TuiContext, target: number): string[] {
  const out = [
    `the prefix from event #${target} on differs from the last request; cache hits will drop`,
  ];
  const e = ctx.log.events[target];
  if (e?.type === "assistant/message" && e.opaque !== undefined)
    out.push("this message's opaque block is no longer sent");
  if (ctx.agent.provider.fields?.protocol.startsWith("anthropic")) {
    out.push(
      "Anthropic thinking signatures bind the prefix: thinking blocks after this point are no longer echoed back",
    );
  }
  return out;
}

const consequenceLines = (ctx: TuiContext, target: number) =>
  editConsequences(ctx, target).map((s) => c.faint(`  · ${s}`));

export function editCommand(ctx: TuiContext, arg: string): string {
  const { log, agent } = ctx;
  if (agent.running) return c.zhu(BUSY);
  const m = arg.match(/^(\d+)(?:\s+(text|reasoning|content|system))?(?:\s+([\s\S]+))?$/);
  if (!m)
    return c.faint(
      "Usage: /edit N [text|reasoning|content|system] [new text]; without text the external editor opens",
    );
  const target = Number(m[1]);
  const spec = editable(ctx, target);
  if (typeof spec === "string") return c.zhu(spec);
  const field = (m[2] as EditField | undefined) ?? (spec.fields[0] as EditField);
  if (!spec.fields.includes(field)) {
    return c.zhu(`event #${target} has no field ${field}; editable: ${spec.fields.join(" / ")}`);
  }
  const e = log.events[target];
  if (field === "reasoning" && e?.type === "assistant/message" && e.reasoningKind !== "full") {
    return c.zhu(
      `event #${target} thinking is ${e.reasoningKind === "summary" ? "a summary" : "of unknown kind"}: the model reads the opaque block, so editing it changes nothing. To steer, append a message, or use a model that echoes full thinking (DeepSeek)`,
    );
  }
  let value = m[3]?.trim();
  if (!value) {
    // 长文本走外部编辑器:先让出终端,编辑器退出后再接管。
    ctx.tui.stop();
    const next = editInExternalEditor(spec.current(field), {
      suffix: field === "reasoning" ? ".txt" : ".md",
    });
    ctx.tui.start();
    if (next === undefined) return c.faint("· unchanged, cancelled");
    value = next;
  }
  log.append({ type: "context/edit", at: now(), target, field, value });
  return [
    c.soft(`· edited event #${target}.${field} (${value.length} chars)`),
    ...consequenceLines(ctx, target),
    c.faint(
      "  · the original stays in the event; Ctrl+E shows the projection, the events view shows context/edit",
    ),
  ].join("\n");
}

export function dropCommand(ctx: TuiContext, arg: string): string {
  const { log, agent } = ctx;
  if (agent.running) return c.zhu(BUSY);
  const m = arg.match(/^(\d+)(?:\s+([\s\S]+))?$/);
  if (!m) return c.faint("Usage: /drop N [note]");
  const target = Number(m[1]);
  const e = log.events[target];
  if (!e) return c.zhu(`no event #${target}`);
  if (e.type !== "user/message" && e.type !== "assistant/message") {
    return c.zhu(
      `only user or assistant messages can be dropped (with their tool results); #${target} is ${e.type}`,
    );
  }
  const note = m[2]?.trim();
  log.append({ type: "context/drop", at: now(), target, ...(note && { note }) });
  const withResults =
    e.type === "assistant/message" && e.toolCalls.length > 0
      ? ` with its ${e.toolCalls.length} tool results`
      : "";
  return [
    c.soft(`· dropped event #${target}${withResults}`),
    ...consequenceLines(ctx, target),
  ].join("\n");
}

/** 某事件在投影里可改的主字段与它的原值。 */
export function originalOf(
  ctx: TuiContext,
  target: number,
): { field: EditField; value: string } | undefined {
  const e = ctx.log.events[target];
  switch (e?.type) {
    case "assistant/message":
      return { field: "text", value: e.text };
    case "user/message":
      return { field: "content", value: e.text };
    case "tool/result":
      return { field: "content", value: e.content };
    case "session/start":
      return { field: "system", value: e.system };
    default:
      return undefined;
  }
}

/** 某字段的原值:reasoning 单独取,其余是主字段。 */
function originalValue(ctx: TuiContext, target: number, field: string): string {
  const e = ctx.log.events[target];
  if (field === "reasoning" && e?.type === "assistant/message") return e.reasoning ?? "";
  return originalOf(ctx, target)?.value ?? "";
}

/** /compare N:编辑过的字段,原文与现值的行级 diff。 */
export function compareCommand(ctx: TuiContext, arg: string): string {
  const target = Number(arg);
  if (!Number.isInteger(target) || !originalOf(ctx, target))
    return c.faint("Usage: /compare N  (an edited user, assistant, tool-result or system event)");
  const cur = editState(ctx.log.events).edits.get(target) ?? {};
  const fields = Object.entries(cur).filter(([, v]) => typeof v === "string") as [string, string][];
  if (fields.length === 0) return c.faint(`event #${target} has no edits; nothing to compare`);
  const out: string[] = [];
  for (const [field, value] of fields) {
    const before = originalValue(ctx, target, field);
    out.push(
      c.soft(
        `· #${target}.${field}  original ${before.length} chars → current ${value.length} chars`,
      ),
    );
    out.push(
      (toolCallDetail("edit", { oldText: before, newText: value }) || c.faint("(identical)"))
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
    );
  }
  return out.join("\n");
}

/** /restore N:把编辑过的字段改回原值。记成又一次编辑;事件数组只增不删。 */
export function restoreCommand(ctx: TuiContext, arg: string): string {
  const { log, agent } = ctx;
  if (agent.running) return c.zhu(BUSY);
  const target = Number(arg);
  if (!Number.isInteger(target) || !originalOf(ctx, target)) return c.faint("Usage: /restore N");
  const cur = editState(log.events).edits.get(target) ?? {};
  const fields = Object.keys(cur) as EditField[];
  if (fields.length === 0) return c.faint(`event #${target} has no edits; nothing to restore`);
  for (const field of fields) {
    log.append({
      type: "context/edit",
      at: now(),
      target,
      field,
      value: originalValue(ctx, target, field),
      note: "restore",
    });
  }
  return [
    c.soft(
      `· restored event #${target} (${fields.join(", ")}) · recorded as another edit, nothing deleted`,
    ),
    ...consequenceLines(ctx, target),
  ].join("\n");
}

/** /rewind N:丢弃事件 N 之后的每条用户与助手消息(工具结果随调用一起走)。下一请求从 N 起。 */
export function rewindCommand(ctx: TuiContext, arg: string): string {
  const { log, agent } = ctx;
  if (agent.running) return c.zhu(BUSY);
  const target = Number(arg);
  if (!Number.isInteger(target) || !log.events[target])
    return c.faint("Usage: /rewind N  (drops every message after event N)");
  const dropped = editState(log.events).dropped;
  const victims = log.events
    .map((e, i) => ({ e, i }))
    .filter(
      ({ e, i }) =>
        i > target &&
        (e.type === "user/message" || e.type === "assistant/message") &&
        !dropped.has(i),
    );
  if (victims.length === 0) return c.faint(`nothing after event #${target} to drop`);
  for (const { i } of victims)
    log.append({ type: "context/drop", at: now(), target: i, note: `rewind to #${target}` });
  return [
    c.soft(
      `· rewound to event #${target}: dropped ${victims.length} message${victims.length === 1 ? "" : "s"} after it (tool results go with their calls)`,
    ),
    c.faint(
      "  · nothing is deleted; the next request starts from here · /retry asks again, or type a new message",
    ),
  ].join("\n");
}

/** /retry:编辑之后立刻看效果。丢弃以事件落盘,发送卡会标出编辑点。 */
export async function retryStep(ctx: TuiContext): Promise<void> {
  const { agent } = ctx;
  if (agent.running) {
    ctx.note(c.zhu("cannot retry while running; press Esc first"));
    return;
  }
  ctx.showLoader("retrying");
  try {
    const pending = agent.retry();
    ctx.updateStatus();
    const outcome = await pending;
    if (typeof outcome === "object") ctx.note(c.soft(`· loop stopped: ${outcome.stopped}`));
  } catch (err) {
    ctx.note(c.zhu(`✗ ${(err as Error).message}`));
  } finally {
    ctx.hideLoader();
    ctx.updateStatus();
  }
}

export function editsList(ctx: TuiContext): string {
  const rows = ctx.log.events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e.type === "context/edit" || e.type === "context/drop");
  if (rows.length === 0)
    return c.faint("No edits. /edit N changes a message, /edit drop N drops one");
  return rows
    .map(({ e, i }) =>
      e.type === "context/edit"
        ? `  ${c.ink(`#${i}`)} ${c.ink(`edit #${e.target}.${e.field}`)} ${c.faint(`${e.value.length} chars ${e.at.slice(11, 19)}`)}`
        : `  ${c.ink(`#${i}`)} ${c.ink(`drop #${(e as { target: number }).target}`)} ${c.faint(e.at.slice(11, 19))}`,
    )
    .join("\n");
}

/** /fork:复制事件前缀到新文件。事件即真相,分叉就是复制前缀,原文件不动。 */
export function forkCommand(ctx: TuiContext, arg: string): string {
  const { log } = ctx;
  let upTo: number;
  if (arg) {
    upTo = Number(arg);
    if (!Number.isInteger(upTo) || upTo < 1)
      return c.zhu("Usage: /fork or /fork N (first N events)");
  } else {
    const lastUser = [...log.events].reverse().findIndex((e) => e.type === "user/message");
    upTo = lastUser < 0 ? log.events.length : log.events.length - 1 - lastUser;
    if (upTo < 1) return c.faint("nothing to fork yet");
  }
  const r = forkSession(log.events, upTo, ctx.deps.sessionsDir ?? SESSIONS_DIR);
  return `${c.soft(`· forked: first ${r.events} events → ${r.file}`)}\n${c.faint(`  pnpm tui -- --resume ${r.file}   continues from there; this session is untouched`)}`;
}

/** 上下文面板(Ctrl+E)里选中一条消息后的动作:全部落到已有命令上,面板只是入口。 */
export async function contextAction(
  ctx: TuiContext,
  action: ContextAction,
  row: CompositionRow,
): Promise<void> {
  if (action === "view") return;
  ctx.inspector.close();
  const target = row.event;
  switch (action) {
    case "edit":
      ctx.note(editCommand(ctx, `${target} ${originalOf(ctx, target)?.field ?? "content"}`));
      break;
    case "edit-reasoning":
      ctx.note(editCommand(ctx, `${target} reasoning`));
      break;
    case "compare":
      ctx.note(compareCommand(ctx, String(target)));
      break;
    case "restore":
      ctx.note(restoreCommand(ctx, String(target)));
      break;
    case "drop":
      ctx.note(dropCommand(ctx, String(target)));
      break;
    case "rewind":
      ctx.note(rewindCommand(ctx, String(target)));
      break;
    case "retry":
      await retryStep(ctx);
      break;
    case "fork":
      ctx.note(forkCommand(ctx, String(target + 1)));
      break;
  }
}
