// 输入:提交用户消息与 / 命令。十三个命令,次级选项不打字,选:无参数的命令弹选单,一层层选到落地。
// 打字形态(/set approve ask)仍然认,给脚本、测试与熟手,帮助里不列。
// 命令表 COMMANDS 同时供补全、面板与 /help 使用;分发在 command 里,每条命令的实现是接 ctx 的小函数
// (查看类在下半部分,编辑类在 tui-edit,槽类在 tui-slots,选单在 tui-menu)。
import { existsSync, readFileSync } from "node:fs";
import type { DeliverAs } from "../src/agent.js";
import type { ModelConfig } from "../src/config.js";
import { contextBreakdown } from "../src/context.js";
import { fmtCost } from "../src/cost.js";
import { now } from "../src/events.js";
import { recordingProvider } from "../src/loop.js";
import { EFFORT_LEVELS, parseEffort } from "../src/provider.js";
import { expandFileRefs } from "./attachments.js";
import { SESSIONS_DIR } from "./bootstrap.js";
import { firstLine, thesisLines } from "./cards.js";
import { describeStatus } from "./mcp/bridge.js";
import { expandSkill } from "./prompt.js";
import { describeInferred } from "./registry.js";
import { forkSession, listSessions, sessionRows } from "./sessions.js";
import { expandTemplate } from "./templates.js";
import { copySequence } from "./terminal-extras.js";
import { c } from "./theme.js";
import { clearMemory, forgetMemory, memoryEntries } from "./tools/memory.js";
import type { TuiContext } from "./tui-context.js";
import {
  compareCommand,
  dropCommand,
  editCommand,
  editsList,
  restoreCommand,
  retryStep,
  rewindCommand,
} from "./tui-edit.js";
import { pct } from "./tui-format.js";
import { LoginDialog, type PickRow } from "./tui-login.js";
import { choose, confirm, title, valueRows } from "./tui-menu.js";
import { Palette, type PaletteItem } from "./tui-palette.js";
import { slotCommand, slotsList } from "./tui-slots.js";

export type Command = {
  name: string;
  description: string;
  /** 有次级选项:无参数时弹选单。 */
  picks?: boolean;
};

export const COMMANDS: Command[] = [
  { name: "help", description: "Commands and keys on one screen" },
  {
    name: "inspect",
    description: "Look inside: requests, events, context, usage, prompt, tools, slots, sessions",
    picks: true,
  },
  {
    name: "set",
    description: "Change a slot: approval, compaction, execution, steering, effort, tool prompts",
    picks: true,
  },
  {
    name: "edit",
    description:
      "Edit the context: pick a message, then view, edit, compare, restore, drop, rewind",
    picks: true,
  },
  { name: "model", description: "Switch model; the list can ask the provider", picks: true },
  {
    name: "login",
    description: "Add a provider key: pick the provider, paste, checked, saved",
    picks: true,
  },
  { name: "tools", description: "Turn tools on or off for this session", picks: true },
  { name: "session", description: "New session, fork from here, resume another", picks: true },
  { name: "memory", description: "Cross-session memory: show, forget one, clear", picks: true },
  { name: "compact", description: "Compact the context now; words after it are instructions" },
  { name: "copy", description: "Copy the last reply or one of its code blocks", picks: true },
  { name: "stop", description: "Interrupt the running turn (Esc does the same)" },
  { name: "quit", description: "Quit (Ctrl+C does the same)" },
];

// ---------- 提交 ----------

export async function submit(
  ctx: TuiContext,
  raw: string,
  opts: { deliverAs?: DeliverAs } = {},
): Promise<void> {
  const { agent, log } = ctx;
  if (ctx.model.info.providerName === "none") {
    ctx.note(c.zhu("no provider yet: add an API key first"));
    openLogin(ctx, {});
    return;
  }
  // @路径 展开成消息里的 <file> 块:附上的就是发出的,落盘上屏都完整。
  const expanded = expandFileRefs(raw);
  for (const a of expanded.attachments) {
    ctx.note(
      a.skipped
        ? c.zhu(`· @${a.ref}: ${a.skipped}`)
        : c.faint(`· attached @${a.ref} (${a.bytes} bytes)`),
    );
  }
  const text = expanded.text;
  if (agent.running) {
    void agent.prompt(text, opts);
    ctx.note(
      c.faint(
        opts.deliverAs === "followUp"
          ? "· queued for after the current step"
          : "· queued as steering: injected at the next step boundary",
      ),
    );
    ctx.updateStatus();
    return;
  }
  ctx.showLoader("thinking");
  try {
    // prompt() 同步执行到首个 await 时已把 running 置位;此处刷新状态栏才能显示"运行中"。
    const pending = agent.prompt(text);
    ctx.updateStatus();
    const outcome = await pending;
    if (typeof outcome === "object") ctx.note(c.soft(`· loop stopped: ${outcome.stopped}`));
  } catch (err) {
    // 请求层的失败已由 request/error 事件画成错误行;这里只兜住循环之外的异常。
    if (log.events.at(-1)?.type !== "request/error") ctx.note(c.zhu(`✗ ${(err as Error).message}`));
  } finally {
    ctx.hideLoader();
    ctx.updateStatus();
  }
}

// ---------- 帮助 ----------

function helpText(ctx: TuiContext): string {
  const row = (name: string, what: string) => `  ${c.ink(name.padEnd(10))} ${c.soft(what)}`;
  return [
    ...thesisLines(),
    "",
    c.soft("Commands") + c.faint("  a command with choices opens a list; ↑↓ Enter Esc"),
    ...COMMANDS.map((x) => row(`/${x.name}`, x.description)),
    ...(ctx.templates.length > 0 ? [c.soft("Templates")] : []),
    ...ctx.templates.map((t) => row(`/${t.name}`, t.description)),
    ...(ctx.skills.length > 0 ? [c.soft("Skills")] : []),
    ...ctx.skills.map((s) => row(`/${s.name}`, s.description || "(no description)")),
    c.soft("Keys"),
    row("Ctrl+K", "search everything: commands, models, skills, templates"),
    row("Ctrl+R", "inspector · Ctrl+E context · Ctrl+O results · Ctrl+T thinking"),
    row("PgUp PgDn", "step cursor · Enter fold or unfold · Esc release"),
    row("Alt+Enter", "queue a message for after the current step · @path attaches a file"),
    row("?", "every key"),
  ].join("\n");
}

// ---------- 查看(/inspect) ----------

function toolsList(ctx: TuiContext): string {
  // 关掉的工具也要算 token(它不在 defs() 里),按工具自己的定义算。
  const tokOf = (name: string) => {
    const t = ctx.tools.find((x) => x.name === name);
    return t
      ? Math.ceil(
          JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })
            .length / 4,
        )
      : 0;
  };
  const off = ctx.slots.disabledTools;
  const total = ctx.tools.filter((t) => !off.has(t.name)).reduce((s, t) => s + tokOf(t.name), 0);
  const rows = ctx.tools.map((t) => {
    const params = Object.keys(
      (t.parameters as { properties?: Record<string, unknown> }).properties ?? {},
    );
    const state = off.has(t.name) ? c.zhu("off       ") : c.faint("on        ");
    return `  ${c.ink(t.name.padEnd(10))} ${c.soft(String(tokOf(t.name)).padStart(5))} ${c.faint("tok")}  ${state} ${c.faint((t.concurrency === "parallel" ? "parallel" : "sequential").padEnd(10))} ${c.ink(t.description.split("\n")[0]?.slice(0, 60) ?? "")}\n${" ".repeat(13)}${c.faint(`params: ${params.join(", ") || "(none)"}`)}`;
  });
  return [
    `${c.soft("Tools")} ${c.ink(`${ctx.tools.length - off.size} on`)}  ${c.faint(`≈${total} tok of definitions sent with every request · level ${ctx.slots.state.toolPrompts} (/set) · /tools switches · full JSON in Ctrl+R → tool definitions`)}`,
    ...rows,
  ].join("\n");
}

function skillsList(ctx: TuiContext): string {
  const { skills } = ctx;
  if (skills.length === 0) {
    return c.faint(
      "No skills. Put <name>/SKILL.md under ~/.clari/skills, ~/.claude/skills, <repo>/.agents/skills or <repo>/.claude/skills.",
    );
  }
  const rows = skills.map((s) => {
    const desc = Math.ceil(s.description.length / 4);
    const body = Math.ceil(s.body.length / 4);
    const flags = [
      s.disableModelInvocation ? "user-only" : "model + user",
      ...(s.allowedTools.length ? [`allowed-tools: ${s.allowedTools.join(" ")}`] : []),
      ...(s.argumentHint ? [`args: ${s.argumentHint}`] : []),
    ].join(" · ");
    return `  ${c.ink(`/${s.name}`.padEnd(16))} ${c.ink(s.description || "(no description)")}\n${" ".repeat(19)}${c.faint(`${s.path} · listing ${desc} tok · body ${body} tok · ${flags}`)}`;
  });
  return [
    `${c.soft("Skills")} ${c.ink(`${skills.length}`)}  ${c.faint("/<name> args to run one now; the model picks from the system prompt list (or the skill tool when skills.load = tool)")}`,
    ...rows,
  ].join("\n");
}

function sessionsList(ctx: TuiContext): string {
  const dir = ctx.deps.sessionsDir ?? SESSIONS_DIR;
  const list = listSessions(dir).slice(0, 15);
  if (list.length === 0) return c.faint(`No sessions in ${dir}/.`);
  return [
    `${c.soft("Sessions")} ${c.ink(`${list.length} most recent in ${dir}/`)}  ${c.faint("/session resumes or forks; prune: clari sessions prune --older-than 30d --yes")}`,
    ...sessionRows(list).map((l) => `  ${c.ink(l)}`),
  ].join("\n");
}

function mcpList(ctx: TuiContext): string {
  const list = ctx.deps.mcp?.statuses() ?? [];
  if (list.length === 0)
    return c.faint(
      "No MCP servers. Configure mcp.servers in ~/.clari/config.json or mcpServers in ./.mcp.json.",
    );
  return [
    `${c.soft("MCP")} ${c.ink(`${list.length} servers`)}  ${c.faint("tools are named mcp__<server>__<tool>; approval rules mcp:<server>:<tool>; every RPC is an ext/event with source mcp")}`,
    ...list.map(
      (s) => `  ${s.phase === "ready" ? c.soft("✓") : c.zhu("✗")} ${c.ink(describeStatus(s))}`,
    ),
  ].join("\n");
}

/** 当前适配器的三张字段表。数据是适配器自己维护的静态清单,与代码同步。 */
function renderFields(ctx: TuiContext): string {
  const f = ctx.agent.provider.fields;
  if (!f) return c.faint("this provider has no field table");
  const block = (head: string, rows: string[]) => [
    c.bold(c.ink(head)),
    ...rows.map((r) => `  ${c.soft("·")} ${c.ink(r)}`),
  ];
  return [
    `${c.soft("protocol")} ${c.ink(f.protocol)}  ${c.faint(`model ${ctx.model.info.model} · byte-exact body in Ctrl+R → wire JSON`)}`,
    ...block("sends", f.sends),
    ...block("reads", f.reads),
    ...block("known but ignored", f.ignores),
  ].join("\n");
}

/** 系统提示词的段构成与位置。数据来自 session/start,与模型看到的同源。 */
function renderPrompt(ctx: TuiContext): string {
  const { log } = ctx;
  const start = log.events.find((e) => e.type === "session/start");
  if (start?.type !== "session/start") return c.faint("no session yet");
  const sections = start.sections ?? [];
  const total = sections.reduce((n, s) => n + s.chars, 0);
  const lines = [
    `${c.soft("System prompt")}  ${c.ink(`${sections.length} sections · ≈${Math.ceil(start.system.length / 4)} tok`)}`,
  ];
  for (const s of sections) {
    lines.push(
      `  ${c.ink(s.name.padEnd(8))} ${c.soft(`${String(Math.ceil(s.chars / 4)).padStart(6)} tok · ${pct(total > 0 ? s.chars / total : 0).padStart(4)}`)}${s.source ? c.faint(`  ${s.source}`) : ""}`,
    );
  }
  const preamble = log.events[1];
  if (
    preamble?.type === "user/message" &&
    start.sections?.every((s) => !/instruction|指令/i.test(s.name))
  ) {
    lines.push(
      c.faint(
        "  project instructions and memory are in the first user message (--instructions-as user); see the first › line above",
      ),
    );
  }
  lines.push(
    c.faint(
      `  memory: ${ctx.deps.memory ? "on (remember tool available)" : "off (--memory enables it; the memory section of AGENTS.md is not injected)"}  · full text in Ctrl+R → sent`,
    ),
  );
  return lines.join("\n");
}

export function renderContext(ctx: TuiContext): string {
  const { log } = ctx;
  const b = contextBreakdown(log.events, ctx.model.contextWindow);
  const lines = [
    `${c.soft("Context")}  ${c.ink(`estimated ${b.estimatedTokens} tok`)} ${c.faint(`/ window ${b.window} · ${pct(b.usedShare)}`)}`,
  ];
  if (b.measuredTokens !== undefined)
    lines.push(c.faint(`last request measured ${b.measuredTokens} tok in`));
  const totals = ctx.usage.totals();
  if (totals.requests > 0) {
    lines.push(
      c.faint(
        `session total: ${totals.requests} requests · in ${totals.inputTokens} · out ${totals.outputTokens} · cache read ${totals.cacheReadTokens} · cache write ${totals.cacheWriteTokens}${totals.cost !== undefined ? ` · cost ${fmtCost(totals.cost)}` : " · no price configured (models[].price)"}`,
      ),
    );
  }
  for (const p of b.parts) {
    const bar = "█".repeat(Math.max(1, Math.round(p.share * 24))).padEnd(24);
    lines.push(
      `${c.faint(bar)} ${pct(p.share).padStart(4)}  ${c.soft(`${p.tokens} tok · ${p.count} · ${p.label}`)}`,
    );
  }
  const start = log.events.find((e) => e.type === "session/start");
  const sections = start?.type === "session/start" ? start.sections : undefined;
  if (sections && sections.length > 0) {
    const total = sections.reduce((n, s) => n + s.chars, 0);
    lines.push(c.soft("System prompt sections"));
    for (const s of sections) {
      const tok = Math.ceil(s.chars / 4);
      lines.push(
        c.faint(
          `  ├ ${s.name.padEnd(8)} ${String(tok).padStart(6)} tok · ${pct(total > 0 ? s.chars / total : 0).padStart(4)}${s.source ? `  ${s.source}` : ""}`,
        ),
      );
    }
  }
  return lines.join("\n");
}

/** 打开检视器并切到某个视图。 */
function openView(ctx: TuiContext, view: "requests" | "events" | "compactions" | "context"): void {
  ctx.inspector.open();
  const insp = ctx.inspector.view;
  if (view === "events") insp.showEvents();
  else if (view === "compactions") insp.showCompactions();
  else if (view === "context") insp.showComposition();
  ctx.tui.requestRender();
}

/** 第 N 次请求的原始流,直接落到检视器接收分区。 */
function showRaw(ctx: TuiContext, n: number): void {
  if (!ctx.inspector.view.showRequest(n, 6)) {
    ctx.note(c.zhu(`No request #${n} (${ctx.req.count} so far)`));
    return;
  }
  ctx.inspector.open({ keep: true });
  ctx.tui.requestRender();
}

const INSPECT_SECTIONS = [
  "requests",
  "events",
  "context",
  "usage",
  "compactions",
  "prompt",
  "tools",
  "slots",
  "skills",
  "mcp",
  "fields",
  "edits",
  "sessions",
  "raw",
] as const;
type InspectSection = (typeof INSPECT_SECTIONS)[number];

function isInspectSection(s: string): s is InspectSection {
  return (INSPECT_SECTIONS as readonly string[]).includes(s);
}

async function inspectSection(ctx: TuiContext, section: InspectSection, arg = ""): Promise<void> {
  const { note, log } = ctx;
  switch (section) {
    case "requests":
      openView(ctx, "requests");
      break;
    case "events":
    case "compactions":
    case "context":
      openView(ctx, section);
      break;
    case "usage":
      note(renderContext(ctx));
      break;
    case "prompt":
      note(renderPrompt(ctx));
      break;
    case "tools":
      note(toolsList(ctx));
      break;
    case "slots":
      note(slotsList(ctx));
      break;
    case "skills":
      note(skillsList(ctx));
      break;
    case "mcp":
      note(mcpList(ctx));
      break;
    case "fields":
      note(renderFields(ctx));
      break;
    case "edits":
      note(editsList(ctx));
      break;
    case "sessions":
      note(sessionsList(ctx));
      break;
    case "raw": {
      const n = Number(arg);
      if (Number.isInteger(n) && n >= 1) {
        showRaw(ctx, n);
        break;
      }
      if (ctx.req.count === 0) {
        note(c.faint("no requests yet"));
        break;
      }
      // 选一次请求:编号、模型、停止原因。
      const rows: PickRow[] = [];
      let k = 0;
      for (let i = 0; i < log.events.length; i++) {
        const e = log.events[i];
        if (e?.type !== "request") continue;
        k += 1;
        const reply = log.events
          .slice(i + 1)
          .find((x) => x.type === "assistant/message" || x.type === "request/error");
        const what =
          reply?.type === "assistant/message"
            ? `${reply.stopReason} · ${firstLine(reply.text || reply.toolCalls.map((t) => `» ${t.name}`).join(" "), 40)}`
            : reply?.type === "request/error"
              ? `✗ ${reply.kind ?? "error"}`
              : "…";
        rows.push({ label: `#${k}`, note: `${e.reason} · ${e.model} · ${what}` });
      }
      const picked = await choose(
        ctx,
        title(
          "Raw stream",
          `pick a request; raw capture is ${ctx.deps.trace ? "on" : "off (--no-trace)"}`,
        ),
        rows.reverse(),
      );
      if (picked) showRaw(ctx, Number(picked.row.label.slice(1)));
      break;
    }
  }
}

/** /inspect:选一个分区。行注写它是什么、现在有多少。 */
async function inspectCommand(ctx: TuiContext, arg: string): Promise<void> {
  const [section = "", rest = ""] = arg.split(/\s+/, 2);
  if (section) {
    if (isInspectSection(section)) await inspectSection(ctx, section, rest);
    else ctx.note(c.zhu(`unknown section ${section}`) + c.faint(`  ${INSPECT_SECTIONS.join(" ")}`));
    return;
  }
  const { log } = ctx;
  const count = (t: string) => log.events.filter((e) => e.type === t).length;
  const edits = count("context/edit") + count("context/drop");
  const rows: PickRow[] = [
    { label: "requests", note: `every request as sent and received · ${ctx.req.count} · Ctrl+R` },
    { label: "context", note: `every message the model sees next, with actions · Ctrl+E` },
    { label: "usage", note: "tokens per part, the session total, the window" },
    { label: "events", note: `the whole event array, one JSON per event · ${log.events.length}` },
    { label: "compactions", note: `which span became which summary · ${count("compaction")}` },
    { label: "edits", note: `edits and drops in this session · ${edits}` },
    { label: "prompt", note: "system prompt sections and where they come from" },
    {
      label: "tools",
      note: `tool definitions and their token cost · ${ctx.tools.length - ctx.slots.disabledTools.size} on`,
    },
    { label: "slots", note: "every strategy slot and its current value" },
    { label: "skills", note: `skills found · ${ctx.skills.length}` },
    { label: "mcp", note: `MCP servers · ${ctx.deps.mcp?.statuses().length ?? 0}` },
    { label: "fields", note: "what this protocol sends, reads and knowingly ignores" },
    { label: "sessions", note: "recent session files" },
    { label: "raw", note: "the raw stream of one request, as received" },
  ];
  const picked = await choose(ctx, title("Inspect", "what do you want to see"), rows);
  if (picked && isInspectSection(picked.row.label)) await inspectSection(ctx, picked.row.label);
}

// ---------- 槽(/set) ----------

const SLOTS = [
  "approve",
  "compaction",
  "trigger",
  "preservation",
  "execution",
  "steering",
  "effort",
  "toolprompts",
] as const;
type SlotName = (typeof SLOTS)[number];

function isSlotName(s: string): s is SlotName {
  return (SLOTS as readonly string[]).includes(s);
}

/** 一个槽的可选值与说明。 */
function slotValues(ctx: TuiContext, slot: SlotName): { label: string; note?: string }[] {
  switch (slot) {
    case "approve":
      return [
        { label: "all", note: "never ask; run every tool call" },
        { label: "ask", note: "ask before every tool call" },
        { label: "policy", note: "rules decide; ask only where the rules say so" },
      ];
    case "compaction":
      return [
        { label: "llm", note: "the model writes a summary of the older part" },
        { label: "clear", note: "drop old tool results, keep the conversation" },
        { label: "pipeline", note: "clear first, then summarise" },
      ];
    case "trigger":
      return [
        { label: "threshold", note: "compact automatically past the threshold" },
        { label: "manual", note: "only on /compact; overflow still compacts once" },
        { label: "remind", note: "never automatically; the status line says when you are past it" },
      ];
    case "preservation":
      return [
        { label: "tokens 20000", note: "keep the most recent 20k tokens verbatim" },
        { label: "tokens 50000", note: "keep the most recent 50k tokens verbatim" },
        { label: "ratio 0.3", note: "keep the most recent 30% of the window" },
        { label: "ratio 0.5", note: "keep the most recent 50% of the window" },
      ];
    case "execution":
      return [
        { label: "sequential", note: "one tool call at a time" },
        { label: "parallel", note: "adjacent read-only calls run together" },
      ];
    case "steering":
      return [
        { label: "step", note: "a queued message is injected at the next step" },
        { label: "turn", note: "only once the model stops calling tools" },
      ];
    case "effort": {
      const levels = ctx.model.effortLevels;
      return [
        { label: "auto", note: "omit the parameter; the provider decides" },
        ...EFFORT_LEVELS.map((l) => ({
          label: l,
          ...(levels &&
            !levels.includes(l) && { note: "not declared by this model; clamped down" }),
        })),
      ];
    }
    case "toolprompts":
      return [
        { label: "brief", note: "core only: what the tool does and its limits" },
        { label: "explain", note: "core plus guidance on when to use which" },
        { label: "rules", note: "explain plus ALWAYS / NEVER rules" },
        { label: "save", note: "write the level and your edits to the config" },
        { label: "edit", note: "edit one tool's description in your editor" },
        { label: "reset", note: "drop your edit of one tool's description" },
      ];
  }
}

function slotCurrent(ctx: TuiContext, slot: SlotName): string {
  const st = ctx.slots.state;
  switch (slot) {
    case "approve":
      return ctx.approval.mode;
    case "compaction":
      return st.compaction?.split(" · ")[0] ?? "llm";
    case "trigger":
      return ctx.compaction.trigger ?? "threshold";
    case "preservation":
      return st.preservation ?? "";
    case "execution":
      return st.execution ?? "sequential";
    case "steering":
      return st.steering ?? "step";
    case "effort":
      return ctx.agent.effort ?? "auto";
    case "toolprompts":
      return ctx.slots.toolPrompts.style ?? "explain";
  }
}

/** 把一个槽设成一个值;打字形态与选单都走这里。返回要打到屏幕上的文本。 */
async function applySlot(ctx: TuiContext, slot: SlotName, value: string): Promise<string> {
  switch (slot) {
    case "effort":
      return setEffort(ctx, value);
    case "trigger":
      return slotCommand(ctx, "compaction", value);
    case "toolprompts":
      return slotCommand(ctx, "toolPrompts", value);
    default:
      return slotCommand(ctx, slot, value);
  }
}

/** /set:选槽 → 选值。审批的规则与工具描述编辑各多一层。 */
async function setCommand(ctx: TuiContext, arg: string): Promise<void> {
  const [slot = "", ...rest] = arg.split(/\s+/);
  const value = rest.join(" ").trim();
  if (slot) {
    if (!isSlotName(slot)) {
      ctx.note(c.zhu(`unknown slot ${slot}`) + c.faint(`  ${SLOTS.join(" ")}`));
      return;
    }
    if (value) {
      ctx.note(await applySlot(ctx, slot, value));
      return;
    }
  }
  let chosen: SlotName | undefined = isSlotName(slot) ? slot : undefined;
  if (!chosen) {
    const rows: PickRow[] = SLOTS.map((s) => ({
      label: s,
      note: `${slotCurrent(ctx, s)} · ${SLOT_NOTES[s]}`,
    }));
    const picked = await choose(
      ctx,
      title("Set", "pick a slot; the value in each row is the current one"),
      rows,
    );
    if (!picked || !isSlotName(picked.row.label)) return;
    chosen = picked.row.label;
  }
  if (chosen === "approve") return approveMenu(ctx);
  const values = slotValues(ctx, chosen);
  const picked = await choose(
    ctx,
    title(chosen, `now ${slotCurrent(ctx, chosen)} · ${SLOT_NOTES[chosen]}`),
    valueRows(values, slotCurrent(ctx, chosen)),
  );
  if (!picked) return;
  const v = picked.row.label;
  if (chosen === "toolprompts" && (v === "edit" || v === "reset")) {
    const edited = new Set(Object.keys(ctx.slots.toolPrompts.descriptions ?? {}));
    const tools = ctx.tools.filter((t) => v === "edit" || edited.has(t.name));
    if (tools.length === 0) {
      ctx.note(c.faint("· no edited descriptions"));
      return;
    }
    const t = await choose(
      ctx,
      title(`${v} description`, v === "edit" ? "opens your editor" : "drops your edit"),
      tools.map((x) => ({
        label: x.name,
        note: `${edited.has(x.name) ? "edited · " : ""}${firstLine(x.description, 50)}`,
      })),
    );
    if (t) ctx.note(await applySlot(ctx, chosen, `${v} ${t.row.label}`));
    return;
  }
  ctx.note(await applySlot(ctx, chosen, v));
}

const SLOT_NOTES: Record<SlotName, string> = {
  approve: "whether tool calls ask you first",
  compaction: "how the older context is shrunk",
  trigger: "when compaction runs",
  preservation: "how much recent context compaction keeps",
  execution: "one tool call at a time or read-only ones together",
  steering: "when a queued message reaches the model",
  effort: "reasoning effort sent with each request",
  toolprompts: "how much of each tool description the model sees",
};

/** 审批槽的选单:模式、规则(增删)、cwd 之外。规则本身要打字,选中后填进输入框。 */
async function approveMenu(ctx: TuiContext): Promise<void> {
  const a = ctx.approval;
  const rules = [
    ...(a.cfg.allow ?? []).map((r) => `allow ${r}`),
    ...(a.cfg.deny ?? []).map((r) => `deny ${r}`),
  ];
  const rows: PickRow[] = [
    ...valueRows(slotValues(ctx, "approve"), a.mode),
    { label: "allow a rule", note: "type it: tool or tool:pattern, e.g. bash:git *" },
    { label: "deny a rule", note: "type it: tool or tool:pattern, e.g. edit:src/**" },
    ...(rules.length > 0 ? [{ label: "forget a rule", note: `${rules.length} rules` }] : []),
    {
      label: "outside cwd",
      note: `now ${a.cfg.outsideCwd ?? "ask"} · paths outside the working directory`,
    },
  ];
  const picked = await choose(ctx, title("approve", `now ${a.mode} · ${SLOT_NOTES.approve}`), rows);
  if (!picked) return;
  const v = picked.row.label;
  if (v === "allow a rule" || v === "deny a rule") {
    ctx.editor.setText(`/set approve ${v.split(" ")[0]} `);
    ctx.note(c.faint("· type the rule after the command and press Enter"));
    ctx.tui.requestRender();
    return;
  }
  if (v === "forget a rule") {
    const r = await choose(
      ctx,
      title("forget", "the rule stops applying"),
      rules.map((x) => ({ label: x })),
    );
    if (r)
      ctx.note(
        await applySlot(ctx, "approve", `forget ${r.row.label.replace(/^(allow|deny) /, "")}`),
      );
    return;
  }
  if (v === "outside cwd") {
    const o = await choose(
      ctx,
      title("outside cwd", "tool calls that touch paths outside the working directory"),
      valueRows(
        [
          { label: "ask", note: "ask you" },
          { label: "allow", note: "run" },
          { label: "deny", note: "refuse" },
        ],
        a.cfg.outsideCwd ?? "ask",
      ),
    );
    if (o) ctx.note(await applySlot(ctx, "approve", `outside ${o.row.label}`));
    return;
  }
  ctx.note(await applySlot(ctx, "approve", v));
}

/** 强度级别:缺省不传;设了就记进每条 request 事件,下一请求生效。 */
function setEffort(ctx: TuiContext, arg: string): string {
  const { agent } = ctx;
  const levels = ctx.model.effortLevels;
  if (arg === "auto") {
    agent.setEffort(undefined);
    ctx.updateStatus();
    return c.soft("· effort omitted again");
  }
  const level = parseEffort(arg);
  if (!level)
    return c.zhu(`unknown level "${arg}"`) + c.faint(`  options: ${EFFORT_LEVELS.join(" ")} auto`);
  agent.setEffort(level);
  const clamped =
    levels && !levels.includes(level)
      ? c.faint(` · this model declares ${levels.join("/")}; clamped down when sending`)
      : "";
  ctx.updateStatus();
  return c.soft(`· effort ${level} from the next request`) + clamped;
}

// ---------- 编辑(/edit) ----------

async function editDispatch(ctx: TuiContext, arg: string): Promise<void> {
  const [sub = "", ...rest] = arg.split(/\s+/);
  const restArg = rest.join(" ").trim();
  const { note } = ctx;
  if (!sub) {
    const picked = await choose(
      ctx,
      title("Edit", "the context is yours to change; the original stays in the log"),
      [
        {
          label: "context",
          note: "pick a message, then view, edit, compare, restore, drop or rewind · Ctrl+E",
        },
        {
          label: "retry",
          note: "drop the last reply and its tool results, ask again with no new prompt",
        },
        { label: "list", note: "edits and drops so far" },
      ],
    );
    if (!picked) return;
    await editDispatch(ctx, picked.row.label);
    return;
  }
  if (/^\d+$/.test(sub)) {
    note(editCommand(ctx, arg));
    return;
  }
  switch (sub) {
    case "context":
      openView(ctx, "context");
      break;
    case "retry":
      await retryStep(ctx);
      break;
    case "list":
      note(editsList(ctx));
      break;
    case "drop":
      note(dropCommand(ctx, restArg));
      break;
    case "compare":
      note(compareCommand(ctx, restArg));
      break;
    case "restore":
      note(restoreCommand(ctx, restArg));
      break;
    case "rewind":
      note(rewindCommand(ctx, restArg));
      break;
    default:
      note(
        c.zhu(`unknown edit action ${sub}`) +
          c.faint("  context · retry · list · N · drop N · compare N · restore N · rewind N"),
      );
  }
}

// ---------- 模型与登录 ----------

/** 切到 供应商/模型;setDefault 为真时同时写为缺省。返回是否成功。 */
function useModel(ctx: TuiContext, name: string, setDefault: boolean): boolean {
  const { deps, agent, model } = ctx;
  if (!deps.settings) {
    ctx.note(c.zhu("settings interface not configured"));
    return false;
  }
  if (agent.running) {
    ctx.note(c.zhu("cannot switch models while running; press Esc first"));
    return false;
  }
  try {
    const choice = deps.settings.switchModel(name);
    agent.setProvider(choice.provider);
    model.info = {
      ...model.info,
      model: choice.model,
      providerName: choice.providerName,
      contextWindow: choice.contextWindow,
      ...(choice.capabilitySource && { capabilitySource: choice.capabilitySource }),
    };
    model.effortLevels = choice.effortLevels;
    model.contextWindow = choice.contextWindow;
    ctx.compaction.window = choice.contextWindow;
    ctx.updateHeader();
    ctx.updateStatus();
    if (setDefault) {
      deps.settings.setDefault(`${choice.providerName}/${choice.model}`);
      ctx.note(c.soft(`· default model set to ${choice.providerName}/${choice.model}`));
    }
    return true;
  } catch (err) {
    ctx.note(c.zhu(`✗ ${(err as Error).message}`));
    return false;
  }
}

const ASK_PROVIDER = "ask the provider";

/** /model:无参数弹列表(末行可向供应商要清单);/model 名 直接切;/model default 把当前设为缺省;/model list 问供应商。 */
async function modelCommand(ctx: TuiContext, arg: string): Promise<void> {
  const { deps, model } = ctx;
  if (arg === "list") return listRemoteModels(ctx);
  if (!deps.settings) {
    ctx.note(c.zhu("settings interface not configured"));
    return;
  }
  if (arg === "default") {
    const name = `${model.info.providerName}/${model.info.model}`;
    deps.settings.setDefault(name);
    ctx.note(c.soft(`· default model set to ${name}`));
    return;
  }
  if (arg) {
    useModel(ctx, arg, false);
    return;
  }
  const current = `${model.info.providerName}/${model.info.model}`;
  const rows: PickRow[] = deps.settings.listModels().map((m) => ({
    label: m,
    ...(m === current && { current: true, note: "current" }),
  }));
  rows.push({
    label: ASK_PROVIDER,
    note: `${model.info.providerName} lists what it serves; new ones get added to the config`,
  });
  const picked = await choose(
    ctx,
    title("Model", "configured models"),
    rows,
    "↑↓ choose · Enter switch · d switch and make it the default · Esc back",
  );
  if (!picked) return;
  if (picked.row.label === ASK_PROVIDER) return listRemoteModels(ctx);
  useModel(ctx, picked.row.label, picked.key === "d");
}

/** 向供应商查当前模型列表,配置里有、服务器没有的标出来;然后列表选。 */
async function listRemoteModels(ctx: TuiContext): Promise<void> {
  const p = ctx.agent.provider;
  const { providerName, model: currentModel } = ctx.model.info;
  if (providerName === "none") {
    openLogin(ctx, {});
    return;
  }
  if (!p.listModels) {
    ctx.note(c.zhu("this provider cannot list models"));
    return;
  }
  ctx.showLoader("listing models");
  let remote: string[];
  try {
    remote = await p.listModels();
  } catch (err) {
    ctx.note(c.zhu(`✗ listing failed: ${(err as Error).message}`));
    return;
  } finally {
    ctx.hideLoader();
    ctx.updateStatus();
  }
  const prefix = `${providerName}/`;
  const configured = (ctx.deps.settings?.listModels() ?? [])
    .filter((m) => m.startsWith(prefix))
    .map((m) => m.slice(prefix.length));
  const s = ctx.deps.settings;
  const rows: PickRow[] = [];
  for (const m of configured) {
    const note = (await s?.capabilityNote?.(providerName, m)) ?? "";
    rows.push({
      label: m,
      ...(m === currentModel && { current: true }),
      note: remote.includes(m)
        ? [m === currentModel ? "current" : "", note].filter(Boolean).join(" · ")
        : `${c.zhu("✗")} not on the server; possibly retired${note ? ` · ${note}` : ""}`,
    });
  }
  // 服务器上有、配置里没有的:能力数据从 models.dev 补,补不到抄最像的,再不行假设;选中即写进配置。
  const inferred = new Map<string, ModelConfig>();
  for (const m of remote) {
    if (configured.includes(m)) continue;
    if (s?.describeModel && s.addModel) {
      const d = await s.describeModel(providerName, m);
      inferred.set(m, d.model);
      rows.push({ label: m, note: `not in config · ${describeInferred(d)}` });
    } else rows.push({ label: m, note: "not in config", disabled: true });
  }
  const picked = await choose(
    ctx,
    `${c.bold(c.ink("Models"))}  ${c.soft(providerName)}  ${c.faint(`server ${remote.length} · configured ${configured.length}`)}`,
    rows,
    "↑↓ choose · Enter switch · d switch and make it the default · Esc back",
  );
  if (!picked) return;
  const add = inferred.get(picked.row.label);
  if (add && s?.addModel) {
    s.addModel(providerName, add);
    ctx.note(
      c.soft(
        `· ${providerName}/${picked.row.label} added to the config (${picked.row.note?.replace(/^not in config · /, "") ?? ""})`,
      ),
    );
  }
  useModel(ctx, `${providerName}/${picked.row.label}`, picked.key === "d");
}

export function openLogin(ctx: TuiContext, opts: { intro?: string; provider?: string }): void {
  const s = ctx.deps.settings;
  if (!s?.providers || !s.verifyKey) {
    ctx.note(c.zhu("settings interface not configured"));
    return;
  }
  const settings = s;
  const dialog = new LoginDialog(
    {
      providers: () => settings.providers?.() ?? [],
      verifyKey: (p, k) => settings.verifyKey?.(p, k) ?? Promise.resolve([]),
      ...(settings.describeModel && { describeModel: settings.describeModel }),
      ...(settings.addModel && {
        addModel: (p: string, m: ModelConfig) => {
          settings.addModel?.(p, m);
          ctx.note(c.soft(`· ${p}/${m.name} added to the config`));
        },
      }),
      setKey: (p, k) => {
        settings.setKey(p, k);
        ctx.note(c.soft(`· key for ${p} saved to the credentials file`));
      },
      useModel: (name, setDefault) => {
        useModel(ctx, name, setDefault);
      },
      onDone: () => ctx.dialog.close(),
      onChange: () => ctx.tui.requestRender(),
    },
    opts,
  );
  ctx.dialog.open(dialog);
}

// ---------- 工具集(/tools) ----------

/** 把开关落到 agent:关掉的工具不随请求发出。记一条 session/slot。 */
export function applyTools(ctx: TuiContext): void {
  const off = ctx.slots.disabledTools;
  ctx.agent.setTools(ctx.tools.filter((t) => !off.has(t.name)));
  const value = off.size === 0 ? "all" : `off: ${[...off].join(" ")}`;
  ctx.slots.state.tools = value;
  ctx.log.append({ type: "session/slot", at: now(), slot: "tools", value });
}

async function toolsCommand(ctx: TuiContext, arg: string): Promise<void> {
  const off = ctx.slots.disabledTools;
  const [sub = "", ...names] = arg.split(/\s+/).filter(Boolean);
  const known = (n: string) => ctx.tools.some((t) => t.name === n);
  if (sub === "on" || sub === "off" || sub === "only") {
    const bad = names.filter((n) => !known(n));
    if (bad.length > 0 || names.length === 0) {
      ctx.note(
        c.zhu(`no tool named ${bad[0] ?? "?"}`) +
          c.faint(`  tools: ${ctx.tools.map((t) => t.name).join(" ")}`),
      );
      return;
    }
    if (sub === "only") {
      off.clear();
      for (const t of ctx.tools) if (!names.includes(t.name)) off.add(t.name);
    } else for (const n of names) sub === "on" ? off.delete(n) : off.add(n);
    applyTools(ctx);
    ctx.note(c.soft(`· tools ${ctx.slots.state.tools}; applies from the next request`));
    return;
  }
  if (sub) {
    ctx.note(
      c.zhu(`unknown tools action ${sub}`) + c.faint("  on <tool> · off <tool> · only <tools>"),
    );
    return;
  }
  const tokOf = (name: string) => {
    const t = ctx.tools.find((x) => x.name === name);
    return t
      ? Math.ceil(
          JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })
            .length / 4,
        )
      : 0;
  };
  while (true) {
    const rows: PickRow[] = ctx.tools.map((t) => ({
      label: t.name,
      note: `${off.has(t.name) ? c.zhu("off") : "on "} · ${tokOf(t.name)} tok · ${firstLine(t.description, 50)}`,
    }));
    const picked = await choose(
      ctx,
      title("Tools", `${ctx.tools.length - off.size} of ${ctx.tools.length} on · Enter flips one`),
      rows,
      "↑↓ or 1–9 choose · Enter on/off · Esc done",
    );
    if (!picked) break;
    const n = picked.row.label;
    if (off.has(n)) off.delete(n);
    else off.add(n);
    applyTools(ctx);
  }
  ctx.note(c.soft(`· tools ${ctx.slots.state.tools ?? "all"}; applies from the next request`));
}

// ---------- 会话(/session) ----------

async function sessionCommand(ctx: TuiContext, arg: string): Promise<void> {
  const sw = ctx.deps.switchSession;
  const [sub = "", ...rest] = arg.split(/\s+/);
  const restArg = rest.join(" ").trim();
  const need = (): boolean => {
    if (!sw) ctx.note(c.faint("· switching sessions is not available here"));
    return !!sw;
  };
  const running = (): boolean => {
    if (ctx.agent.running) ctx.note(c.zhu("cannot switch sessions while running; press Esc first"));
    return ctx.agent.running;
  };
  const lastUser = () => {
    const events = ctx.log.events;
    // 复制到最后一条用户消息之前:分叉出去的会话从那个提问重新开始。
    for (let i = events.length - 1; i >= 0; i--)
      if (events[i]?.type === "user/message") return Math.max(1, i);
    return events.length;
  };
  switch (sub) {
    case "": {
      const picked = await choose(ctx, title("Session", ctx.deps.info.sessionFile), [
        { label: "new", note: "a fresh log with the same model and config" },
        {
          label: "fork",
          note: "copy this session up to the last message into a new file and continue there",
        },
        { label: "resume", note: "pick a recent session file" },
        { label: "list", note: "recent session files" },
      ]);
      if (picked) await sessionCommand(ctx, picked.row.label);
      return;
    }
    case "new":
      if (!need() || running()) return;
      sw?.({ kind: "new" });
      return;
    case "fork": {
      // 分叉就是复制前缀到一个新文件;有入口支持就接着切过去,没有(无头、测试)就只留下文件。
      if (running()) return;
      const n = restArg ? Number(restArg) : lastUser();
      if (!Number.isInteger(n) || n < 1) {
        ctx.note(c.zhu("Usage: /session fork [N]  (N = how many events to copy)"));
        return;
      }
      const forked = forkSession(ctx.log.events, n, ctx.deps.sessionsDir ?? SESSIONS_DIR);
      ctx.note(c.soft(`· forked: first ${forked.events} events → ${forked.file}`));
      sw?.({ kind: "resume", file: forked.file });
      return;
    }
    case "resume": {
      if (!need() || running()) return;
      if (restArg) {
        sw?.({ kind: "resume", file: restArg });
        return;
      }
      const dir = ctx.deps.sessionsDir ?? SESSIONS_DIR;
      const list = listSessions(dir)
        .filter((s) => s.file !== ctx.deps.info.sessionFile)
        .slice(0, 15);
      if (list.length === 0) {
        ctx.note(c.faint(`No other sessions in ${dir}/.`));
        return;
      }
      const rows = sessionRows(list).map((line, i) => ({ label: list[i]?.file ?? "", note: line }));
      const picked = await choose(ctx, title("Resume", "recent sessions, newest first"), rows);
      if (picked) sw?.({ kind: "resume", file: picked.row.label });
      return;
    }
    case "list":
      ctx.note(sessionsList(ctx));
      return;
    default:
      ctx.note(
        c.zhu(`unknown session action ${sub}`) + c.faint("  new · fork [N] · resume [file] · list"),
      );
  }
}

// ---------- 记忆(/memory) ----------

function memoryState(ctx: TuiContext) {
  const memory = ctx.deps.memory;
  if (!memory) return undefined;
  const files = [memory.project, memory.user].filter((f): f is string => !!f);
  const all = files.flatMap((file) =>
    (existsSync(file) ? memoryEntries(readFileSync(file, "utf8")) : []).map((text, i) => ({
      file,
      i: i + 1,
      text,
    })),
  );
  return { files, all };
}

function memoryList(ctx: TuiContext): string {
  const m = memoryState(ctx);
  if (!m) return c.faint("memory is off. Start with --memory or set prompt.memory: true");
  if (m.all.length === 0) return c.faint(`no memories. files: ${m.files.join(", ")}`);
  const lines = [
    `${c.soft("Memory")} ${c.ink(`${m.all.length} entries`)}  ${c.faint("injected at the start of the next session")}`,
  ];
  m.all.forEach((x, k) => {
    lines.push(`  ${c.ink(String(k + 1).padStart(2))} ${c.ink(x.text)}  ${c.faint(x.file)}`);
  });
  return lines.join("\n");
}

async function memoryCommand(
  ctx: TuiContext,
  arg: string,
  opts: { ask?: boolean } = {},
): Promise<void> {
  const m = memoryState(ctx);
  if (!m) {
    ctx.note(memoryList(ctx));
    return;
  }
  const [sub = "", ...rest] = arg.split(/\s+/).filter(Boolean);
  const { note } = ctx;
  switch (sub) {
    case "": {
      const picked = await choose(
        ctx,
        title("Memory", `${m.all.length} entries · ${m.files.join(", ")}`),
        [
          { label: "show", note: "list every entry" },
          { label: "forget", note: "pick one entry to remove" },
          { label: "clear", note: "remove every entry (asks first)" },
        ],
      );
      if (picked) await memoryCommand(ctx, picked.row.label, { ask: true });
      return;
    }
    case "show":
      note(memoryList(ctx));
      return;
    case "clear": {
      // 选单里来的问一句;打字 /memory clear 是明说的,不问。
      if (
        opts.ask &&
        !(await confirm(ctx, `remove all ${m.all.length} memories?`, "clear the memory files"))
      )
        return;
      const n = m.files.reduce((acc, f) => acc + clearMemory(f), 0);
      note(c.soft(`· cleared ${n} memories`));
      return;
    }
    case "forget": {
      let idx = Number(rest[0]);
      if (!rest[0]) {
        if (m.all.length === 0) {
          note(c.faint("no memories"));
          return;
        }
        const picked = await choose(
          ctx,
          title("Forget", "the entry is removed from its file"),
          m.all.map((x, k) => ({ label: String(k + 1), note: `${x.text}  ${x.file}` })),
        );
        if (!picked) return;
        idx = Number(picked.row.label);
      }
      const target = m.all[idx - 1];
      if (!target) {
        note(c.zhu(`no entry ${rest[0] ?? "?"} (${m.all.length} total)`));
        return;
      }
      note(c.soft(`· removed: ${forgetMemory(target.file, target.i)}`));
      return;
    }
    default:
      note(c.zhu(`unknown memory action ${sub}`) + c.faint("  show · forget [N] · clear"));
  }
}

// ---------- 复制与压缩 ----------

/** 上一条回复里的围栏代码块正文(不含围栏行)。 */
export function codeBlocks(text: string): string[] {
  const out: string[] = [];
  const re = /^```[^\n]*\n([\s\S]*?)^```/gm;
  for (const m of text.matchAll(re)) out.push((m[1] ?? "").replace(/\n$/, ""));
  return out;
}

/** /copy [N]:上一条回复,或它的第 N 个代码块;没给 N 而有代码块时选。写进系统剪贴板(OSC 52)。 */
async function copyCommand(ctx: TuiContext, arg: string): Promise<void> {
  const last = [...ctx.log.events].reverse().find((e) => e.type === "assistant/message" && e.text);
  if (last?.type !== "assistant/message") {
    ctx.note(c.zhu("nothing to copy yet"));
    return;
  }
  const blocks = codeBlocks(last.text);
  let n: number | undefined;
  if (arg.trim()) {
    n = Number(arg.trim());
    if (!Number.isInteger(n) || n < 1 || n > blocks.length) {
      ctx.note(
        c.zhu(
          `the last reply has ${blocks.length} code block${blocks.length === 1 ? "" : "s"}; /copy N with N in that range`,
        ),
      );
      return;
    }
  } else if (blocks.length > 0) {
    const picked = await choose(ctx, title("Copy", "to the clipboard"), [
      { label: "reply", note: `the whole reply · ${last.text.length} chars` },
      ...blocks.map((b, i) => ({
        label: `block ${i + 1}`,
        note: `${firstLine(b, 50)} · ${b.length} chars`,
      })),
    ]);
    if (!picked) return;
    if (picked.row.label !== "reply") n = Number(picked.row.label.slice(6));
  }
  const text = n === undefined ? last.text : (blocks[n - 1] as string);
  ctx.deps.terminal.write(copySequence(text));
  ctx.note(
    c.faint(
      `· copied ${n === undefined ? "the last reply" : `code block ${n}`} (${text.length} chars) to the clipboard`,
    ),
  );
}

async function manualCompact(ctx: TuiContext, instructions: string): Promise<void> {
  const { log, agent, compaction } = ctx;
  ctx.showLoader("compacting");
  try {
    const payload = await compaction.strategy({
      events: log.events,
      window: ctx.model.contextWindow,
      targetTokens: ctx.threshold(),
      provider: recordingProvider(log, agent.provider, {
        threshold: ctx.threshold(),
        onRaw: ctx.onRaw,
      }),
      ...(instructions && { instructions }),
    });
    if (!payload) ctx.note(c.faint("compaction skipped: nothing to do or not enough progress"));
    else log.append({ type: "compaction", at: now(), ...payload });
  } catch (err) {
    ctx.note(c.zhu(`✗ compaction failed: ${(err as Error).message}`));
  } finally {
    ctx.hideLoader();
    ctx.updateStatus();
  }
}

// ---------- 面板 ----------

/** Ctrl+K:命令面板。条目来自命令表、配置里的模型、技能、模板、每个供应商的登录。 */
export function openPalette(ctx: TuiContext): void {
  const items: PaletteItem[] = [];
  const fill = (text: string) => {
    ctx.editor.setText(text);
    ctx.tui.requestRender();
  };
  for (const cmd of COMMANDS) {
    items.push({
      kind: "command",
      label: `/${cmd.name}`,
      note: cmd.description,
      run: () => {
        if (cmd.name === "compact") fill("/compact ");
        else void command(ctx, `/${cmd.name}`);
      },
    });
  }
  const s = ctx.deps.settings;
  for (const name of s?.listModels() ?? []) {
    const current = name === `${ctx.model.info.providerName}/${ctx.model.info.model}`;
    items.push({
      kind: "model",
      label: name,
      ...(current && { note: "current" }),
      run: () => {
        useModel(ctx, name, false);
      },
    });
  }
  for (const p of s?.providers?.() ?? []) {
    items.push({
      kind: "login",
      label: `login ${p.name}`,
      note: p.keySource ? `key set (${p.keySource})` : "key missing",
      run: () => openLogin(ctx, { provider: p.name }),
    });
  }
  for (const sk of ctx.skills) {
    items.push({
      kind: "skill",
      label: `/${sk.name}`,
      note: sk.description,
      run: () => fill(`/${sk.name} `),
    });
  }
  for (const t of ctx.templates) {
    items.push({
      kind: "template",
      label: `/${t.name}`,
      note: t.description,
      run: () => fill(`/${t.name} `),
    });
  }
  const palette = new Palette(
    items,
    () => ctx.dialog.close(),
    () => ctx.tui.requestRender(),
  );
  ctx.dialog.open(palette);
}

// ---------- 分发 ----------

/**
 * 一条命令。弹了选单就返回(选单里的后续在后台走完),没弹的等做完;调用方与测试都不必等人来选。
 */
export async function command(ctx: TuiContext, text: string): Promise<void> {
  // 先挂信号再分发:选单可能在分发的同步段里就打开。
  const opened = new Promise<void>((resolve) => {
    ctx.dialog.onOpen = resolve;
  });
  const flow = dispatch(ctx, text);
  flow.catch((err: unknown) => ctx.note(c.zhu(`✗ ${(err as Error).message}`)));
  try {
    await Promise.race([flow, opened]);
  } finally {
    ctx.dialog.onOpen = undefined;
  }
}

async function dispatch(ctx: TuiContext, text: string): Promise<void> {
  const [cmd = "", ...rest] = text.replace(/^\//, "").split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "help":
      ctx.note(helpText(ctx));
      break;
    case "quit":
      ctx.stop();
      ctx.exit();
      break;
    case "stop":
      ctx.agent.interrupt();
      break;
    case "inspect":
      await inspectCommand(ctx, arg);
      break;
    case "set":
      await setCommand(ctx, arg);
      break;
    case "edit":
      await editDispatch(ctx, arg);
      break;
    case "model":
      await modelCommand(ctx, arg);
      break;
    case "login":
      openLogin(ctx, arg ? { provider: arg } : {});
      break;
    case "tools":
      await toolsCommand(ctx, arg);
      break;
    case "session":
      await sessionCommand(ctx, arg);
      break;
    case "memory":
      await memoryCommand(ctx, arg);
      break;
    case "compact":
      await manualCompact(ctx, arg);
      break;
    case "copy":
      await copyCommand(ctx, arg);
      break;
    default:
      await userDefined(ctx, cmd, arg);
  }
}

/** 提示词模板与技能:/名 参数 → 一条用户消息。技能的 allowed-tools 在这一 turn 免审批。 */
async function userDefined(ctx: TuiContext, cmd: string, arg: string): Promise<void> {
  const t = ctx.templates.find((x) => x.name === cmd);
  if (t) {
    ctx.note(c.faint(`· template /${t.name}  ${t.path}`));
    await submit(ctx, expandTemplate(t, arg));
    return;
  }
  const sk = ctx.skills.find((x) => x.name === cmd);
  if (sk) {
    ctx.note(
      c.faint(
        `· skill /${sk.name}  ${sk.path}${sk.allowedTools.length ? `  allowed-tools: ${sk.allowedTools.join(" ")}` : ""}`,
      ),
    );
    const allow = ctx.approval.skillAllow;
    for (const name of sk.allowedTools) allow.add(name);
    try {
      await submit(ctx, expandSkill(sk, arg));
    } finally {
      allow.clear();
    }
    return;
  }
  ctx.note(
    c.zhu(`unknown command /${cmd}`) +
      c.faint("  /help lists the commands · Ctrl+K searches everything"),
  );
}
