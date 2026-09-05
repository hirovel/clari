// 输入:提交用户消息与 / 命令。命令表 COMMANDS 同时供补全与 /help 使用;分发在 command 里,
// 每条命令的实现是接 ctx 的小函数(列表类在下半部分,编辑类在 tui-edit,槽类在 tui-slots)。
import { existsSync, readFileSync } from "node:fs";
import type { DeliverAs } from "../src/agent.js";
import { contextBreakdown } from "../src/context.js";
import { fmtCost } from "../src/cost.js";
import { now } from "../src/events.js";
import { recordingProvider } from "../src/loop.js";
import { EFFORT_LEVELS, parseEffort } from "../src/provider.js";
import { expandFileRefs } from "./attachments.js";
import { SESSIONS_DIR } from "./bootstrap.js";
import { describeStatus } from "./mcp/bridge.js";
import { expandSkill } from "./prompt.js";
import { listSessions, sessionRows } from "./sessions.js";
import { expandTemplate } from "./templates.js";
import { c } from "./theme.js";
import { clearMemory, forgetMemory, memoryEntries } from "./tools/memory.js";
import type { TuiContext } from "./tui-context.js";
import {
  compareCommand,
  dropCommand,
  editCommand,
  editsList,
  forkCommand,
  restoreCommand,
  retryStep,
  rewindCommand,
} from "./tui-edit.js";
import { pct } from "./tui-format.js";
import { slotCommand, slotsList } from "./tui-slots.js";

export const COMMANDS = [
  {
    name: "inspect",
    description:
      "Inspector (Ctrl+R): every API request, what was sent, received, decided and written",
  },
  {
    name: "events",
    description: "Events view: the whole event array the kernel maintains, raw JSON per event",
  },
  {
    name: "compactions",
    description: "Compactions: which span of the original became which summary",
  },
  {
    name: "composition",
    description:
      "Context composition (Ctrl+E): every message the model sees next, its source event, stages, wire index",
  },
  { name: "context", description: "Context breakdown: tokens and share per part" },
  { name: "prompt", description: "System prompt sections: what they are, how big, where they sit" },
  {
    name: "memory",
    description:
      "Cross-session memory: /memory lists; /memory forget N removes one; /memory clear empties it",
  },
  {
    name: "compact",
    description: "Compact now, optionally with instructions: /compact keep the errors",
  },
  {
    name: "fork",
    description:
      "Fork the session: /fork copies up to the last user message; /fork N copies the first N events to a new file",
  },
  {
    name: "edit",
    description:
      "Edit the context: /edit N [text|reasoning|content|system] [new text]; without text the external editor opens. The original stays in the event",
  },
  {
    name: "drop",
    description:
      "Drop a message: /drop N [note]; an assistant message takes its tool results with it",
  },
  { name: "compare", description: "Compare an edited message with its original: /compare N" },
  {
    name: "restore",
    description: "Restore the original of an edited message: /restore N (recorded as another edit)",
  },
  {
    name: "rewind",
    description: "Rewind to a message: /rewind N drops every message after event N",
  },
  { name: "edits", description: "List every edit and drop in this session" },
  {
    name: "retry",
    description:
      "Retry the step: drop the last assistant reply and its tool results, then ask again with no new prompt",
  },
  { name: "slots", description: "Show every strategy slot and its current implementation" },
  {
    name: "tools",
    description: "Tool definitions sent with every request: name, tokens, concurrency, params",
  },
  { name: "raw", description: "Raw stream of request N as received, line by line: /raw N" },
  { name: "mcp", description: "MCP servers: transport, protocol era, tool count, last error" },
  {
    name: "sessions",
    description:
      "List recent session files (resume with --resume; prune with clari sessions prune)",
  },
  {
    name: "toolprompts",
    description:
      "Tool description style: /toolprompts guided|terse|strict; edit <tool> opens your editor; reset <tool>; save writes to config",
  },
  {
    name: "skills",
    description: "List skills: source, description size, model-invocable, allowed tools",
  },
  {
    name: "compaction",
    description: "Switch compaction strategy: /compaction llm|clear|pipeline|./x.mjs|off",
  },
  {
    name: "preservation",
    description: "How much recent context compaction keeps: /preservation tokens N | ratio R",
  },
  { name: "execution", description: "Tool execution: /execution sequential|parallel" },
  { name: "steering", description: "When queued messages are injected: /steering step|turn" },
  {
    name: "approve",
    description:
      "Tool approval: /approve all|ask|policy · allow <rule> · deny <rule> · forget <rule> · outside ask|allow|deny",
  },
  {
    name: "model",
    description: "Switch model: /model provider/model; without arguments lists the options",
  },
  {
    name: "models",
    description: "Ask the provider which models exist; flags configured ones that are gone",
  },
  {
    name: "fields",
    description:
      "What this protocol puts in a request, reads from a response, and knowingly ignores",
  },
  {
    name: "effort",
    description: "Effort level: /effort off|low|medium|high|xhigh|max; auto omits it",
  },
  {
    name: "key",
    description: "Set a provider key: /key deepseek sk-… (written to the config file)",
  },
  { name: "default", description: "Make the current model the default" },
  { name: "stop", description: "Interrupt the running turn" },
  { name: "help", description: "List commands" },
  { name: "quit", description: "Quit" },
];

// ---------- 提交 ----------

export async function submit(
  ctx: TuiContext,
  raw: string,
  opts: { deliverAs?: DeliverAs } = {},
): Promise<void> {
  const { agent, log } = ctx;
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
    if (typeof outcome === "object") ctx.note(c.jin(`◇ loop stopped: ${outcome.stopped}`));
  } catch (err) {
    // 请求层的失败已由 request/error 事件画成错误卡;这里只兜住循环之外的异常。
    if (log.events.at(-1)?.type !== "request/error") ctx.note(c.zhu(`✗ ${(err as Error).message}`));
  } finally {
    ctx.hideLoader();
    ctx.updateStatus();
  }
}

// ---------- 列表与查看 ----------

function helpText(ctx: TuiContext): string {
  return [
    ...COMMANDS.map((x) => `${c.jin(`/${x.name}`.padEnd(12))} ${c.soft(x.description)}`),
    ...ctx.templates.map(
      (t) => `${c.jin(`/${t.name}`.padEnd(12))} ${c.soft(`template: ${t.description}`)}`,
    ),
    c.faint(
      "Alt+Enter queues a message for after the current step · @path attaches a file · ? shortcuts",
    ),
  ].join("\n");
}

/** /tools:随请求发出的每个工具定义:名字、定义占的 token、并行安全、描述首行。 */
function toolsList(ctx: TuiContext): string {
  const defs = ctx.defs();
  const tokOf = (name: string) =>
    Math.ceil(JSON.stringify(defs.find((d) => d.name === name)).length / 4);
  const total = ctx.tools.reduce((s, t) => s + tokOf(t.name), 0);
  const rows = ctx.tools.map((t) => {
    const params = Object.keys(
      (t.parameters as { properties?: Record<string, unknown> }).properties ?? {},
    );
    return `  ${c.jin(t.name.padEnd(10))} ${c.soft(String(tokOf(t.name)).padStart(5))} ${c.faint("tok")}  ${c.faint((t.concurrency === "parallel" ? "parallel" : "sequential").padEnd(10))} ${c.ink(t.description.split("\n")[0]?.slice(0, 70) ?? "")}\n${" ".repeat(13)}${c.faint(`params: ${params.join(", ") || "(none)"}`)}`;
  });
  return [
    `${c.soft("Tools")} ${c.ink(`${ctx.tools.length}`)}  ${c.faint(`≈${total} tok of definitions sent with every request · style ${ctx.slots.state.toolPrompts} (/toolprompts) · full JSON in Ctrl+R → tool definitions`)}`,
    ...rows,
  ].join("\n");
}

/** /skills:每个技能的来源、描述占的 token、能否被模型调用、免审批工具。 */
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
    return `  ${c.jin(`/${s.name}`.padEnd(16))} ${c.ink(s.description || "(no description)")}\n${" ".repeat(19)}${c.faint(`${s.path} · listing ${desc} tok · body ${body} tok · ${flags}`)}`;
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
    `${c.soft("Sessions")} ${c.ink(`${list.length} most recent in ${dir}/`)}  ${c.faint("resume: clari --resume <file>; prune: clari sessions prune --older-than 30d --yes")}`,
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
      (s) => `  ${s.phase === "ready" ? c.green("✓") : c.zhu("✗")} ${c.ink(describeStatus(s))}`,
    ),
  ].join("\n");
}

/** /fields:当前适配器的三张字段表。数据是适配器自己维护的静态清单,与代码同步。 */
function renderFields(ctx: TuiContext): string {
  const f = ctx.agent.provider.fields;
  if (!f) return c.faint("this provider has no field table");
  const block = (title: string, rows: string[]) => [
    c.jin(title),
    ...rows.map((r) => `  ${c.soft("·")} ${c.ink(r)}`),
  ];
  return [
    `${c.soft("protocol")} ${c.ink(f.protocol)}  ${c.faint(`model ${ctx.model.info.model} · byte-exact body in Ctrl+R → wire JSON`)}`,
    ...block("sends", f.sends),
    ...block("reads", f.reads),
    ...block("known but ignored", f.ignores),
  ].join("\n");
}

/** /prompt:系统提示词的段构成与位置。数据来自 session/start,与模型看到的同源。 */
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
      `  ${c.jin(s.name.padEnd(8))} ${c.soft(`${String(Math.ceil(s.chars / 4)).padStart(6)} tok · ${pct(total > 0 ? s.chars / total : 0).padStart(4)}`)}${s.source ? c.faint(`  ${s.source}`) : ""}`,
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

/** /memory:列出、删一条、清空。记忆就是 AGENTS.md 里的一节,这里只是它的编辑入口。 */
function memoryCommand(ctx: TuiContext, arg: string): string {
  const memory = ctx.deps.memory;
  if (!memory) return c.faint("memory is off. Start with --memory or set prompt.memory: true");
  const files = [memory.project, memory.user].filter((f): f is string => !!f);
  const all = files.flatMap((file) =>
    (existsSync(file) ? memoryEntries(readFileSync(file, "utf8")) : []).map((text, i) => ({
      file,
      i: i + 1,
      text,
    })),
  );
  const [sub, ...restArgs] = arg.split(/\s+/).filter(Boolean);
  if (sub === "clear") {
    const n = files.reduce((acc, f) => acc + clearMemory(f), 0);
    return c.jin(`◇ cleared ${n} memories`);
  }
  if (sub === "forget") {
    const idx = Number(restArgs[0]);
    const target = all[idx - 1];
    if (!target) return c.zhu(`no entry ${restArgs[0] ?? "?"} (${all.length} total)`);
    const removed = forgetMemory(target.file, target.i);
    return c.jin(`◇ removed: ${removed}`);
  }
  if (all.length === 0) return c.faint(`no memories. files: ${files.join(", ")}`);
  const lines = [
    `${c.soft("Memory")} ${c.ink(`${all.length} entries`)}  ${c.faint("injected at the start of the next session · /memory forget N removes one")}`,
  ];
  all.forEach((m, k) => {
    lines.push(`  ${c.jin(String(k + 1).padStart(2))} ${c.ink(m.text)}  ${c.faint(m.file)}`);
  });
  return lines.join("\n");
}

/** /context:估算占用、实测、会话累计、各部分占比,系统提示词按段拆开。 */
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
      `${c.jin(bar)} ${pct(p.share).padStart(4)}  ${c.soft(`${p.tokens} tok · ${p.count} · ${p.label}`)}`,
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

// ---------- 模型、强度、key ----------

function switchModel(ctx: TuiContext, arg: string): void {
  const { deps, agent, model } = ctx;
  if (!deps.settings) {
    ctx.note(c.zhu("settings interface not configured"));
    return;
  }
  const current = `${model.info.providerName}/${model.info.model}`;
  if (!arg) {
    const models = deps.settings.listModels();
    ctx.note(
      `${c.soft("current")} ${c.ink(current)}\n${models
        .map((m) => (m === current ? c.jin(`  ▸ ${m}`) : c.faint(`    ${m}`)))
        .join("\n")}\n${c.faint("Usage: /model provider/model")}`,
    );
    return;
  }
  if (agent.running) {
    ctx.note(c.zhu("cannot switch models while running; press Esc first"));
    return;
  }
  try {
    const choice = deps.settings.switchModel(arg);
    agent.setProvider(choice.provider);
    model.info = { ...model.info, model: choice.model, providerName: choice.providerName };
    model.effortLevels = choice.effortLevels;
    model.contextWindow = choice.contextWindow;
    ctx.compaction.window = choice.contextWindow;
    ctx.updateHeader();
    ctx.updateStatus();
  } catch (err) {
    ctx.note(c.zhu(`✗ ${(err as Error).message}`));
  }
}

/** 强度级别:缺省不传;设了就记进每条 request 事件,下一请求生效。 */
function setEffort(ctx: TuiContext, arg: string): void {
  const { agent } = ctx;
  const levels = ctx.model.effortLevels;
  if (!arg) {
    const rows = EFFORT_LEVELS.map((l) => {
      const current = l === agent.effort;
      const unsupported = levels && !levels.includes(l);
      return `  ${current ? c.jin("▸") : " "} ${current ? c.jin(l) : c.soft(l)}${unsupported ? c.faint("  not declared by this model; clamped down when sending") : ""}`;
    });
    ctx.note(
      `${c.soft("Effort")} ${c.ink(agent.effort ?? "not set (omitted; provider default)")}\n${rows.join("\n")}\n${c.faint("Usage: /effort <level>; /effort auto omits it again")}`,
    );
    return;
  }
  if (arg === "auto") {
    agent.setEffort(undefined);
    ctx.note(c.jin("◇ effort omitted again"));
    ctx.updateStatus();
    return;
  }
  const level = parseEffort(arg);
  if (!level) {
    ctx.note(
      c.zhu(`unknown level "${arg}"`) + c.faint(`  options: ${EFFORT_LEVELS.join(" ")} auto`),
    );
    return;
  }
  agent.setEffort(level);
  const clamped =
    levels && !levels.includes(level)
      ? c.faint(`  this model declares ${levels.join("/")}; clamped down when sending`)
      : "";
  ctx.note(c.jin(`◇ effort set to ${level}; applies from the next request`) + clamped);
  ctx.updateStatus();
}

/** 向供应商查当前模型列表:配置里有、服务器没有的标出来,发现下线不靠猜。 */
async function listRemoteModels(ctx: TuiContext): Promise<void> {
  const p = ctx.agent.provider;
  const { providerName } = ctx.model.info;
  if (!p.listModels) {
    ctx.note(c.zhu("this provider cannot list models"));
    return;
  }
  ctx.showLoader("listing models");
  try {
    const remote = await p.listModels();
    const prefix = `${providerName}/`;
    const configured = (ctx.deps.settings?.listModels() ?? [])
      .filter((m) => m.startsWith(prefix))
      .map((m) => m.slice(prefix.length));
    const lines = [
      `${c.soft("provider")} ${c.ink(providerName)}  ${c.faint(`server ${remote.length} models · configured ${configured.length}`)}`,
    ];
    for (const m of configured) {
      lines.push(
        remote.includes(m)
          ? `  ${c.green("✓")} ${c.ink(m)}`
          : `  ${c.zhu("✗")} ${c.ink(m)}  ${c.zhu("not on the server; possibly retired")}`,
      );
    }
    const extra = remote.filter((m) => !configured.includes(m));
    if (extra.length > 0) {
      lines.push(c.faint("  on the server, not in config:"));
      for (const m of extra) lines.push(c.faint(`    · ${m}`));
    }
    ctx.note(lines.join("\n"));
  } catch (err) {
    ctx.note(c.zhu(`✗ listing failed: ${(err as Error).message}`));
  } finally {
    ctx.hideLoader();
    ctx.updateStatus();
  }
}

function setKey(ctx: TuiContext, arg: string): void {
  if (!ctx.deps.settings) {
    ctx.note(c.zhu("settings interface not configured"));
    return;
  }
  const [providerName, ...keyParts] = arg.split(/\s+/);
  const key = keyParts.join("");
  if (!providerName || !key) {
    ctx.note(c.faint("Usage: /key provider key   e.g. /key deepseek sk-xxxx"));
    return;
  }
  try {
    ctx.deps.settings.setKey(providerName, key);
    ctx.note(
      c.jin(`◇ key for ${providerName} written to the config file`) +
        c.faint("  /model to switch to that provider"),
    );
  } catch (err) {
    ctx.note(c.zhu(`✗ ${(err as Error).message}`));
  }
}

function setDefaultModel(ctx: TuiContext): void {
  if (!ctx.deps.settings) {
    ctx.note(c.zhu("settings interface not configured"));
    return;
  }
  const name = `${ctx.model.info.providerName}/${ctx.model.info.model}`;
  ctx.deps.settings.setDefault(name);
  ctx.note(c.jin(`◇ default model set to ${name}`));
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

/** /raw N:第 N 次请求的原始流,直接落到检视器接收分区。 */
function rawCommand(ctx: TuiContext, arg: string): void {
  const n = Number(arg);
  const count = ctx.req.count;
  if (!Number.isInteger(n) || n < 1) {
    ctx.note(
      c.faint(
        `Usage: /raw N  (1..${count}); raw capture is ${ctx.deps.trace ? "on" : "off (--no-trace)"}`,
      ),
    );
    return;
  }
  if (!ctx.inspector.view.showRequest(n, 6)) {
    ctx.note(c.zhu(`No request #${n} (${count} so far)`));
    return;
  }
  ctx.inspector.open({ keep: true });
  ctx.tui.requestRender();
}

/** 打开检视器并切到某个视图。 */
function openView(ctx: TuiContext, view: "events" | "compactions" | "composition"): void {
  ctx.inspector.open();
  const insp = ctx.inspector.view;
  if (view === "events") insp.showEvents();
  else if (view === "compactions") insp.showCompactions();
  else insp.showComposition();
  ctx.tui.requestRender();
}

// ---------- 分发 ----------

export async function command(ctx: TuiContext, text: string): Promise<void> {
  const [cmd = "", ...rest] = text.replace(/^\//, "").split(/\s+/);
  const arg = rest.join(" ").trim();
  const { note } = ctx;
  switch (cmd) {
    case "help":
      note(helpText(ctx));
      break;
    case "quit":
      ctx.stop();
      ctx.exit();
      break;
    case "stop":
      ctx.agent.interrupt();
      break;
    case "inspect":
      ctx.inspector.open();
      break;
    case "events":
    case "compactions":
    case "composition":
      openView(ctx, cmd);
      break;
    case "raw":
      rawCommand(ctx, arg);
      break;
    case "tools":
      note(toolsList(ctx));
      break;
    case "sessions":
      note(sessionsList(ctx));
      break;
    case "mcp":
      note(mcpList(ctx));
      break;
    case "context":
      note(renderContext(ctx));
      break;
    case "prompt":
      note(renderPrompt(ctx));
      break;
    case "memory":
      note(memoryCommand(ctx, arg));
      break;
    case "compact":
      await manualCompact(ctx, arg);
      break;
    case "fork":
      note(forkCommand(ctx, arg));
      break;
    case "edit":
      note(editCommand(ctx, arg));
      break;
    case "drop":
      note(dropCommand(ctx, arg));
      break;
    case "edits":
      note(editsList(ctx));
      break;
    case "compare":
      note(compareCommand(ctx, arg));
      break;
    case "restore":
      note(restoreCommand(ctx, arg));
      break;
    case "rewind":
      note(rewindCommand(ctx, arg));
      break;
    case "retry":
      await retryStep(ctx);
      break;
    case "compaction":
    case "preservation":
    case "execution":
    case "steering":
    case "approve":
      note(await slotCommand(ctx, cmd, arg));
      break;
    case "toolprompts":
      note(await slotCommand(ctx, "toolPrompts", arg));
      break;
    case "slots":
      note(slotsList(ctx));
      break;
    case "skills":
      note(skillsList(ctx));
      break;
    case "model":
      switchModel(ctx, arg);
      break;
    case "models":
      await listRemoteModels(ctx);
      break;
    case "fields":
      note(renderFields(ctx));
      break;
    case "effort":
      setEffort(ctx, arg);
      break;
    case "key":
      setKey(ctx, arg);
      break;
    case "default":
      setDefaultModel(ctx);
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
  ctx.note(c.zhu(`unknown command /${cmd}`) + c.faint("  /help lists commands"));
}
