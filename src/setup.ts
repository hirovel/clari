// Agent 组成的说明数据。终端与未来客户端共用;不执行策略,不保存另一份运行状态。
import type { Preset } from "./config.js";
import { defaultPreset, getSetting, SETTINGS, type SettingDef, setSetting } from "./settings.js";

export type SetupSection = {
  id: string;
  title: string;
  description: string;
  keys: readonly string[];
  action?: { label: string; command: string };
};

export const SETUP_SECTIONS: readonly SetupSection[] = [
  {
    id: "model",
    title: "Model",
    description: "The model that reasons and chooses actions.",
    keys: ["model", "effort"],
    action: { label: "Manage provider login", command: "/login" },
  },
  {
    id: "instructions",
    title: "Instructions & memory",
    description: "What the model is told before the conversation.",
    keys: [
      "prompt.sections",
      "prompt.instructionsAs",
      "prompt.memory",
      "prompt.skills.mode",
      "prompt.skills.include",
      "prompt.skills.load",
    ],
    action: { label: "Inspect current context", command: "/inspect context" },
  },
  {
    id: "tools",
    title: "Tools & delegation",
    description: "What the model can do, and how each tool is described.",
    keys: ["tools.disable", "toolPrompts", "plan", "subagent", "mcpReconnect"],
    action: { label: "Inspect tool definitions", command: "/inspect tools" },
  },
  {
    id: "context",
    title: "Context management",
    description: "When history is shortened and what is preserved.",
    keys: ["compaction", "compactionTrigger", "compactionReserve", "preservation", "planReminder"],
    action: { label: "Open context workbench", command: "/inspect context" },
  },
  {
    id: "execution",
    title: "Execution & control",
    description: "How calls run, when you can steer, and when approval is needed.",
    keys: [
      "approve",
      "execution",
      "steering",
      "maxSteps",
      "facts.repeats",
      "facts.slow",
      "facts.date",
    ],
    action: { label: "Inspect approval rules", command: "/set approve" },
  },
  {
    id: "display",
    title: "Display & notifications",
    description: "How work appears on screen. These choices do not change model context.",
    keys: ["screen", "fold", "foldLines", "foldSteps", "results", "notify"],
  },
  {
    id: "recording",
    title: "Drafts & input saving",
    description: "Save unsent work locally. API and tool recording is separate and stays enabled.",
    keys: ["saveInputs"],
    action: { label: "Open request inspector", command: "/inspect requests" },
  },
];

type Guide = { title: string; effect: string; reason: string; example?: string };
export const SETUP_GUIDE: Readonly<Record<string, Guide>> = {
  saveInputs: {
    title: "Save unsent inputs",
    effect:
      "Keeps the latest draft and pending messages beside the session. Restoring never sends them. Turning this off removes the saved snapshot; inputs remain in this process.",
    reason: "Keep work across switches and restarts. Turn off to keep unsent text only in memory.",
  },
  mcpReconnect: {
    title: "Reconnect MCP servers",
    effect: "Listed servers get a new connection at the next session switch.",
    reason:
      "Reuse avoids startup delays. Reconnect when a server should not keep connection state across sessions.",
  },
  model: {
    title: "Model",
    effect:
      "Selects a configured provider/model. Current-session changes wait until the agent is idle. Saved defaults apply on the next start.",
    reason:
      "Use your configured default model as the starting point. Capabilities and tradeoffs differ by model; switch here to compare on your work.",
  },
  effort: {
    title: "Reasoning effort",
    effect:
      "Requests a reasoning level from the selected model. Supported levels depend on that model.",
    reason:
      "Leave effort unset to use the model's default. More effort can cost more time and tokens; quality must be compared on your tasks.",
  },
  "prompt.sections": {
    title: "Prompt sections",
    effect:
      "Selects the sections assembled at startup. Inspect current context to edit the prompt already in this session.",
    reason:
      "Include the available sections so project instructions and discovered skills are visible. Memory still needs its own switch.",
  },
  "prompt.instructionsAs": {
    title: "Instruction placement",
    effect:
      "Places project instructions and memory in the system prompt or the first user message at startup.",
    reason:
      "System placement keeps persistent instructions together. Choose user placement when your model or workflow needs it.",
  },
  "prompt.memory": {
    title: "Cross-session memory",
    effect: "Loads the memory section of AGENTS.md and offers the remember tool at startup.",
    reason:
      "Off until you choose to carry model-written notes between sessions. Existing project instructions are still read.",
  },
  "prompt.skills.mode": {
    title: "Skill invocation",
    effect:
      "Manual: /name sends instructions and your request as a user message. Auto: offers a catalog in the system prompt (read) or the skill tool definition (tool).",
    reason:
      "Manual keeps requests smaller and choices explicit. Auto saves prompting but adds descriptions and selection work. This is not a file access restriction.",
    example:
      "Manual: /review check this patch. Auto: ask to review the patch; the model decides whether to load review.",
  },
  "prompt.skills.include": {
    title: "Automatic skill range",
    effect:
      "All includes skills discovered on future starts. Unchecking an item saves specific names. This range is inactive in Manual mode.",
    reason:
      "All needs less maintenance. A smaller range uses less context. Skills marked manual-only remain manual.",
    example:
      '"include": "all" follows new installations. "include": ["review", "research"] fixes the offered names. [] offers none.',
  },
  "prompt.skills.load": {
    example:
      "Read: system lists review, its description and SKILL.md path; read returns the file. Tool: the skill definition lists review and its description; skill(name=review) returns the instructions.",
    title: "Skill loading",
    effect:
      "Read puts names, descriptions and paths in the system prompt's Skills section. Tool puts names and descriptions in the skill tool definition. Instructions enter context only when loaded, as a tool result.",
    reason:
      "Read uses the existing file tool. The dedicated tool is an alternative when you want a distinct skill call.",
  },
  "tools.disable": {
    title: "Available tools",
    effect:
      "Enabled tools are offered to the model. Disabling a tool removes its definition from future turns.",
    reason:
      "Keep the loaded tools available. Disable capabilities you do not want the model to use or spend context describing.",
  },
  toolPrompts: {
    title: "Tool descriptions",
    effect:
      "Brief sends the core description; explain adds guidance; rules adds explicit behavioral rules.",
    reason:
      "Explain balances instructions with definition size. This is a starting point, not a measured optimum for every model.",
  },
  plan: {
    title: "Plan tool",
    effect:
      "Lets the model write a checklist. Making the tool available does not force the model to plan.",
    reason:
      "A visible checklist helps you follow longer work. You can remove the tool and its prompt cost.",
  },
  subagent: {
    title: "Delegation",
    effect: "Loads the task tool at startup so the model can delegate to child agents.",
    reason:
      "Off initially. Delegation adds model calls and coordination; enable it when your task benefits from independent work.",
  },
  compaction: {
    example:
      "A command returned 2,000 lines. Clear replaces old output in model context with a placeholder; the original remains in the session. Summary uses a model call to condense older history.",
    title: "Compaction method",
    effect:
      "Summary replaces older history in context with model-written text. Clear replaces old tool output with placeholders. Pipeline clears first, then summarizes if needed. Original events remain available.",
    reason:
      "Summary can retain intent beyond raw tool output, but is lossy. Inspect the original and summary to judge what survived.",
  },
  compactionTrigger: {
    title: "Compaction trigger",
    effect:
      "Automatic runs past the threshold. Manual waits for /compact. Remind shows a notice. Overflow recovery can compact in all three modes.",
    reason:
      "Automatic keeps long conversations moving without requiring you to watch the budget. Manual gives you direct timing control.",
  },
  compactionReserve: {
    title: "Context reserve",
    effect:
      "Reserves tokens before the context limit. The trigger never falls below half the window. This is an estimate, not a tokenizer guarantee.",
    reason:
      "32,000 tokens leave room for output and summarization. Smaller windows cap the reserve at half their size.",
  },
  preservation: {
    example:
      "tokens 20000 keeps a recent tail of about 20,000 tokens. ratio 0.3 keeps about 30% of the conversation token estimate. The cut moves to keep tool calls and results together.",
    title: "Recent history",
    effect:
      "Keeps a recent tail verbatim during summarization, with tool calls and their results kept together.",
    reason:
      "Automatic uses the smaller of 20,000 tokens and a quarter of the model window. A fixed budget or ratio gives you direct control.",
  },
  planReminder: {
    title: "Stale-plan reminder",
    effect:
      "After this many steps without a plan update, appends the open plan to model context. Zero disables this reminder. Recovery after compaction is separate.",
    reason:
      "Off by default: an unchanged plan is not evidence that the model forgot it. Enable a cadence when you find it useful.",
  },
  approve: {
    title: "Tool approval",
    effect:
      "Allow all runs tools without asking. Ask confirms every call. Policy uses your configured allow and deny rules.",
    reason:
      "Allow all preserves the existing default. It gives tools permission to change files and execute commands; choose a mode appropriate to your workspace.",
  },
  execution: {
    title: "Tool scheduling",
    effect:
      "Sequential runs calls one at a time. Parallel groups adjacent calls declared safe to run together; results keep their original order.",
    reason:
      "Sequential makes ordering straightforward. Parallel can reduce time for independent reads.",
  },
  steering: {
    example:
      "While the model is reading files, send 'Do not edit yet'. Step delivers it after the tool batch; turn waits until the model finishes calling tools. Neither undoes work already performed.",
    title: "Message delivery",
    effect:
      "Step delivers your queued message after a tool batch. Turn waits until the model stops calling tools.",
    reason:
      "Step lets you redirect ongoing work earlier. Turn lets the current chain finish first.",
  },
  maxSteps: {
    title: "Turn step limit",
    effect:
      "Caps model steps in a turn. Unset leaves the model free to continue until it stops calling tools or you interrupt.",
    reason: "No arbitrary limit by default. Set one when you want a bounded run.",
  },
  "facts.repeats": {
    title: "Repeated-error note",
    effect:
      "Adds a factual note to a tool result when the same arguments failed earlier in this session.",
    reason: "Expose prior failure evidence without choosing the model's next action.",
  },
  "facts.slow": {
    title: "Slow-call note",
    effect:
      "Adds timing information when a call exceeds 30 seconds and five times the session median for that tool.",
    reason: "Make unusual latency visible. The threshold is heuristic and can be disabled.",
  },
  "facts.date": {
    title: "Date-change note",
    effect: "Appends a date update before the next request when the calendar date changes.",
    reason: "Keep time-sensitive context current without rewriting the cached prefix.",
  },
  screen: {
    title: "Terminal screen",
    effect:
      "Alternate screen uses Clari's own scrolling. Main screen keeps terminal scrollback. Changes require a restart.",
    reason: "Alternate screen keeps navigation and selection inside the workspace.",
  },
  fold: {
    example:
      "Fold a 200-line tool result to a short screen preview. This setting does not shorten what is sent to the model; expand the block to read the recorded result.",
    title: "Fold tool output",
    effect: "Collapses tool output on screen. The model still receives the full tool result.",
    reason: "Keep the conversation readable; expand output whenever you need it.",
  },
  foldLines: {
    title: "Output preview lines",
    effect: "Sets how many lines a folded tool result shows.",
    reason: "Five lines give a short preview without filling the conversation.",
  },
  foldSteps: {
    title: "Expanded recent steps",
    effect: "Older requests fold to one line. Zero keeps all steps expanded.",
    reason: "Keep the newest three steps open while preserving access to earlier work.",
  },
  results: {
    title: "Tool output previews",
    effect:
      "Chooses count, first lines, last lines, or full output per tool. Errors remain visible. This changes the screen only.",
    reason:
      "File tools show counts, shell output shows its tail, and other tools show their first lines.",
  },
  notify: {
    title: "Desktop notifications",
    effect:
      "Controls notifications when a turn ends or approval is needed. Delivery depends on your terminal.",
    reason:
      "Notify only while unfocused so Clari can call you back without interrupting active work.",
  },
};

export type SetupScope = "session" | "defaults";
export function setupGuide(def: SettingDef): Guide {
  return (
    SETUP_GUIDE[def.key] ?? {
      title: def.key,
      effect: def.note,
      reason: "Use the built-in starting value, or choose your own.",
    }
  );
}

/** 展示名称只用于 UI;配置与命令仍使用同一组稳定的键和值。 */
export function setupValue(def: SettingDef, value: unknown): string {
  if (def.key === "model" && value === undefined) return "Configured default";
  if (def.key === "planReminder" && value === 0) return "Off";
  if (def.key === "maxSteps" && value === undefined) return "No limit";
  if (def.key === "preservation" && value === undefined) return "Automatic";
  if (def.key === "effort" && value === undefined) return "Model default";
  if (def.key === "prompt.skills.include" && value === "all") return "All (including new skills)";
  if (def.key === "approve")
    return (
      ({ all: "Allow all", ask: "Ask every time", policy: "Use rules" } as Record<string, string>)[
        String(value)
      ] ?? String(value)
    );
  const labels: Record<string, Record<string, string>> = {
    "prompt.skills.mode": { manual: "Manual", auto: "Automatic" },
    compaction: {
      llm: "Model summary",
      clear: "Clear tool results",
      pipeline: "Clear then summarize",
    },
    compactionTrigger: { threshold: "Automatic", manual: "Manual", remind: "Notify only" },
    execution: { sequential: "One at a time", parallel: "Parallel safe calls" },
    steering: { step: "After each step", turn: "After the turn" },
    toolPrompts: { brief: "Brief", explain: "With guidance", rules: "With strict rules" },
    screen: { alt: "Alternate screen", main: "Terminal scrollback" },
  };
  if (labels[def.key]?.[String(value)]) return labels[def.key]?.[String(value)] as string;
  if (def.type === "bool") return value ? "On" : "Off";
  if (def.type === "list")
    return `${Array.isArray(value) ? value.length : 0} ${def.key === "tools.disable" ? "disabled" : "selected"}`;
  if (def.type === "map") return `${Object.keys((value ?? {}) as object).length} custom previews`;
  return value === undefined ? "Automatic" : String(value);
}

export function sameSetting(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 合并预设只处理对象结构,不执行它;空数组和 false 必须覆盖原值。 */
export function mergeSetup(base: Preset, next: Preset): Preset {
  const merge = (
    a: Record<string, unknown>,
    b: Record<string, unknown>,
  ): Record<string, unknown> => {
    const out = { ...a };
    for (const [key, value] of Object.entries(b)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) continue;
      out[key] =
        value && typeof value === "object" && !Array.isArray(value)
          ? merge((a[key] as Record<string, unknown>) ?? {}, value as Record<string, unknown>)
          : structuredClone(value);
    }
    return out;
  };
  return merge(base as Record<string, unknown>, next as Record<string, unknown>) as Preset;
}

/** 只保存登记的设置,避免把供应商连接信息或凭据混进方案。 */
export function setupSnapshot(
  defs: readonly SettingDef[],
  read: (def: SettingDef) => unknown,
): Preset {
  let preset: Preset = {};
  for (const def of defs) {
    const value = read(def);
    // JSON 会丢弃 undefined;快照要保留“无限制/自动”,不能在下次启动继承后来改的 defaults。
    preset = setSetting(
      preset,
      def.key,
      structuredClone(value ?? (def.type === "list" ? [] : null)),
    );
  }
  return preset;
}

/** 方案替换登记的设置,未纳入组装界面的配置细节继续保留。 */
export function replaceSetup(base: Preset | undefined, values: Preset): Preset {
  let remaining = base ?? {};
  for (const def of SETTINGS) remaining = setSetting(remaining, def.key, undefined);
  return mergeSetup(remaining, mergeSetup(defaultPreset(), values));
}

export function configuredValue(def: SettingDef, defaults: Preset | undefined): unknown {
  return getSetting(defaults, def.key) ?? def.builtin;
}
