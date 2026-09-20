import type { SessionSetup } from "./session-setup.js";
// 设置的读写语义与终端布局分离。运行值来自现有状态;保存值来自配置;变化进入事件日志。

import { keepRecentTokens } from "../src/compaction.js";
import type { Preset, ResultView, SkillsConfig } from "../src/config.js";
import { now } from "../src/events.js";
import { DEFAULT_PLAN_REMINDER } from "../src/plan.js";
import {
  formatSetting,
  getSetting,
  parseSetting,
  SETTINGS,
  type SettingDef,
  type SettingLayers,
  settingDef,
  settingSource,
} from "../src/settings.js";
import { configuredValue, type SetupScope, sameSetting, setupSnapshot } from "../src/setup.js";
import { parsePreservation } from "./args.js";
import { DEFAULT_RESULT_VIEWS } from "./cards.js";
import { automaticSkills, skillsSection } from "./prompt.js";
import { replaceSystemSection } from "./prompt-sections.js";
import { applyToolPrompts } from "./tool-prompts.js";
import { createSkillTool, skillCatalog } from "./tools/skill.js";
import type { TuiContext } from "./tui-context.js";

export function effectiveSetting(ctx: TuiContext, def: SettingDef): unknown {
  const initial = () => getSetting(ctx.setupInitial, def.key) ?? def.builtin;
  if (def.key.startsWith("prompt.skills.")) {
    for (let i = ctx.log.events.length - 1; i >= 0; i--) {
      const e = ctx.log.events[i];
      if (
        e?.type === "ext/event" &&
        e.source === "setup" &&
        e.kind === "setting" &&
        e.payload.scope === "session" &&
        e.payload.key === def.key
      )
        return e.payload.value;
    }
    return initial();
  }
  switch (def.key) {
    case "saveInputs":
      return ctx.deps.inputs?.saving ?? ctx.deps.saveInputs ?? true;
    case "model":
      return `${ctx.model.info.providerName}/${ctx.model.info.model}`;
    case "mcpReconnect":
      return ctx.deps.mcpReconnect ?? [];
    case "screen":
      return ctx.deps.screen ?? "alt";
    case "fold":
      return ctx.view.foldResults;
    case "foldLines":
      return ctx.view.foldLines;
    case "foldSteps":
      return ctx.view.foldSteps;
    case "results":
      return ctx.view.results;
    case "notify":
      return ctx.deps.notify ?? "unfocused";
    case "compactionReserve":
      return ctx.compaction.reserveTokens ?? def.builtin;
    case "facts.repeats":
    case "facts.slow":
    case "facts.date": {
      const key = def.key.slice(6) as "repeats" | "slow" | "date";
      return ctx.agent.facts?.[key] ?? true;
    }
    case "plan":
      return ctx.tools.some((t) => t.name === "plan") && !ctx.slots.disabledTools.has("plan");
    case "planReminder":
      return ctx.agent.planReminder ?? DEFAULT_PLAN_REMINDER;
    case "tools.disable": {
      const off = [...ctx.slots.disabledTools].filter((n) => n !== "plan");
      return off.length > 0 ? off : undefined;
    }
    case "toolPrompts":
      return ctx.slots.toolPrompts.style ?? "explain";
    case "approve":
      return ctx.approval.mode;
    case "compaction":
      return ctx.slots.state.compaction ?? initial();
    case "compactionTrigger":
      return ctx.compaction.trigger ?? "threshold";
    case "preservation":
      return ctx.slots.state.preservation || undefined;
    case "execution":
      return ctx.agent.slots.execution ?? "sequential";
    case "steering":
      return ctx.slots.state.steering ?? "step";
    case "effort":
      return ctx.agent.effort;
    default:
      return initial();
  }
}

export function sourceOf(ctx: TuiContext, def: SettingDef, effective: unknown): string {
  for (let i = ctx.log.events.length - 1; i >= 0; i--) {
    const e = ctx.log.events[i];
    if (
      e?.type === "ext/event" &&
      e.source === "setup" &&
      e.kind === "setting" &&
      e.payload.key === def.key &&
      e.payload.scope === "session"
    ) {
      if (sameSetting(e.payload.value, effective)) return "recorded change in this session";
      break;
    }
  }
  const layers: SettingLayers = ctx.deps.settings?.settingLayers?.() ?? {};
  const source = settingSource(def, effective, layers);
  // 值相同不证明来源:显式参数也可能恰好等于默认值。
  return source === "flag" ? "runtime value; source not recorded" : `matches ${source}`;
}

export function setupRead(ctx: TuiContext, def: SettingDef, scope: SetupScope): unknown {
  if (def.key === "model" && scope === "defaults")
    return (
      getSetting(ctx.deps.settings?.settingLayers?.().defaults, "model") ??
      ctx.deps.settings?.defaultModel?.()
    );
  return scope === "session"
    ? effectiveSetting(ctx, def)
    : configuredValue(def, ctx.deps.settings?.settingLayers?.().defaults);
}

const SLOT_SETTINGS = new Set([
  "model",
  "approve",
  "compaction",
  "compactionTrigger",
  "preservation",
  "execution",
  "steering",
  "toolPrompts",
]);
const DISPLAY_SETTINGS = new Set(["fold", "foldLines", "foldSteps", "results", "notify"]);

export function settingTiming(ctx: TuiContext, def: SettingDef, scope: SetupScope): string {
  if (scope === "defaults") return "Saved for future starts; this session stays unchanged.";
  if (def.key === "saveInputs")
    return "Changes local input saving now. Turning off removes the saved snapshot, keeping inputs in memory.";
  if (def.key === "mcpReconnect") return "Applies when the next session connection is prepared.";
  if (def.scope === "next start")
    return "Requires a restart. Switch to Saved defaults to change it.";
  if (def.key === "plan" && !ctx.tools.some((t) => t.name === "plan"))
    return "Plan tool is not loaded. Enable it in Saved defaults and restart.";
  if (ctx.agent.running && SLOT_SETTINGS.has(def.key))
    return "This strategy cannot change mid-turn. Wait, or close setup and press Esc to interrupt.";
  if (DISPLAY_SETTINGS.has(def.key)) return "Changes the interface immediately.";
  if (def.key === "effort") return "Used by the next model request.";
  if (def.key.startsWith("prompt.skills."))
    return "Used by the next request. Loaded instructions stay in history. New files are discovered at session startup.";
  if (["compaction", "compactionTrigger", "compactionReserve", "preservation"].includes(def.key))
    return "Used by the next compaction check; existing history stays unchanged.";
  return "Used by the next turn. An in-flight request keeps its current settings.";
}

/** 实际修改运行状态;调用前由 changeSetting 验证作用域和生效条件。 */
export async function applySettingNow(
  ctx: TuiContext,
  def: SettingDef,
  value: unknown,
  slot: (name: string, value: string) => Promise<string>,
): Promise<string | undefined> {
  const { view } = ctx;
  switch (def.key) {
    case "prompt.skills.mode":
    case "prompt.skills.include":
    case "prompt.skills.load": {
      const read = (key: string) =>
        key === def.key ? value : effectiveSetting(ctx, settingDef(key) as SettingDef);
      const config: SkillsConfig = {
        mode: read("prompt.skills.mode") as "manual" | "auto",
        include: read("prompt.skills.include") as "all" | string[],
        load: read("prompt.skills.load") as "read" | "tool",
      };
      const catalog = automaticSkills(ctx.skills, config);
      const existing = ctx.tools.find((t) => t.name === "skill");
      if (config.load === "tool" && catalog.length && existing && !skillCatalog(existing))
        throw new Error(
          "An extension owns the skill tool. Choose read loading or remove that extension first.",
        );
      const tools = ctx.tools.filter((t) => !skillCatalog(t));
      if (config.load === "tool" && catalog.length) {
        const tool = createSkillTool(catalog);
        applyToolPrompts([tool], ctx.slots.toolPrompts);
        tools.push(tool);
      }
      const edit = replaceSystemSection(
        ctx.log.events,
        "Skills",
        skillsSection(ctx.skills, config),
      );
      if (edit) ctx.log.append(edit);
      ctx.tools.splice(0, ctx.tools.length, ...tools);
      ctx.applyTools?.();
      return;
    }
    case "saveInputs":
      ctx.deps.inputs?.configure(value as boolean);
      ctx.deps.saveInputs = value as boolean;
      return;
    case "mcpReconnect":
      ctx.deps.mcpReconnect = value as string[];
      break;
    case "model": {
      const name = value ?? ctx.deps.settings?.defaultModel?.();
      if (!name)
        throw new Error("No default model is configured. Choose a model or use /login first.");
      return slot("model", String(name));
    }
    case "fold":
      view.foldResults = value as boolean;
      ctx.redrawResults?.();
      return;
    case "foldLines":
      view.foldLines = value as number;
      ctx.redrawResults?.();
      return;
    case "foldSteps":
      view.foldSteps = value as number;
      return;
    case "results":
      view.results = { ...DEFAULT_RESULT_VIEWS, ...((value as Record<string, ResultView>) ?? {}) };
      ctx.redrawResults?.();
      return;
    case "notify":
      ctx.deps.notify = value as "unfocused" | "always" | "off";
      return;
    case "compactionReserve":
      ctx.compaction.reserveTokens = value as number;
      ctx.updateStatus();
      return;
    case "facts.repeats":
    case "facts.slow":
    case "facts.date":
      ctx.agent.configure({ facts: { ...ctx.agent.facts, [def.key.slice(6)]: value as boolean } });
      return;
    case "planReminder":
      ctx.agent.configure({ planReminder: value as number });
      return;
    case "plan":
      if (!ctx.tools.some((t) => t.name === "plan"))
        throw new Error(
          "the plan tool is not loaded in this session; enable it in Saved defaults and restart",
        );
      if (value) ctx.slots.disabledTools.delete("plan");
      else ctx.slots.disabledTools.add("plan");
      ctx.applyTools?.();
      return;
    case "tools.disable": {
      const plan = ctx.slots.disabledTools.has("plan");
      ctx.slots.disabledTools.clear();
      for (const name of (value as string[] | undefined) ?? []) ctx.slots.disabledTools.add(name);
      if (plan) ctx.slots.disabledTools.add("plan");
      ctx.applyTools?.();
      return;
    }
    case "toolPrompts":
      return slot("toolprompts", String(value));
    case "approve":
      return slot("approve", String(value));
    case "compaction":
      return slot("compaction", String(value));
    case "compactionTrigger":
      return slot("trigger", String(value));
    case "preservation":
      if (value === undefined) {
        ctx.compaction.preservation = keepRecentTokens(Math.min(20000, ctx.compaction.window / 4));
        ctx.slots.state.preservation = "";
        return;
      }
      parsePreservation(String(value));
      return slot("preservation", String(value));
    case "execution":
      return slot("execution", String(value));
    case "steering":
      return slot("steering", String(value));
    case "effort":
      return slot("effort", value === undefined ? "auto" : String(value));
    default:
      return "takes effect at the next start";
  }
}

export type SettingChange = { ok: boolean; message: string };

function validate(def: SettingDef, value: unknown): void {
  if (
    def.key === "prompt.skills.include" &&
    value !== "all" &&
    (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !name.trim()))
  )
    throw new Error("prompt.skills.include takes all or a list of skill names.");
  if (value === undefined) {
    if (def.builtin !== undefined)
      throw new Error(`${def.key} needs a value; choose its recommended value to reset it.`);
    return;
  }
  if (def.type === "bool" && typeof value !== "boolean")
    throw new Error(`${def.key} takes on or off`);
  if (def.type === "number") parseSetting(def, String(value));
  if (def.type === "enum") parseSetting(def, String(value));
  if (def.key === "preservation") parsePreservation(String(value));
}

/** session 只改运行态;defaults 先可靠落盘;both 保留已有打字命令的应用并保存语义。 */
export async function changeSetting(
  ctx: TuiContext,
  def: SettingDef,
  value: unknown,
  scope: SetupScope | "both",
  slot: (name: string, value: string) => Promise<string>,
): Promise<SettingChange> {
  try {
    validate(def, value);
    const save = ctx.deps.settings?.saveSetting;
    if (scope === "defaults") {
      if (!save)
        throw new Error(
          "Saving is not available here. Use This session to make a temporary change.",
        );
      await save(def.key, value);
      ctx.log.append({
        type: "ext/event",
        at: now(),
        source: "setup",
        kind: "setting",
        payload: { key: def.key, value, scope: "defaults" },
      });
      const layers = ctx.deps.settings?.settingLayers?.();
      const overridden = getSetting(layers?.preset, def.key) !== undefined;
      return {
        ok: true,
        message: `${def.key} → ${formatSetting(def, value)} · saved for future starts; this session unchanged${overridden ? ` · preset ${layers?.presetName ?? ""} still overrides defaults` : ""}`,
      };
    }
    if (def.scope === "next start") {
      if (scope === "session") throw new Error(settingTiming(ctx, def, "session"));
      if (!save)
        throw new Error("This setting requires a restart, and saving is not available here.");
      await save(def.key, value);
      return { ok: true, message: describeChange(def, value, undefined, true) };
    }
    if (ctx.agent.running && SLOT_SETTINGS.has(def.key))
      throw new Error(settingTiming(ctx, def, "session"));
    const applied = await applySettingNow(ctx, def, value ?? def.builtin, slot);
    // 老槽函数把错误返回成文案;设置入口必须识别失败,不能继续保存或显示成功。
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 槽返回的终端文案需要先去掉 SGR。
    const plain = (applied ?? "").replace(/\u001b\[[0-9;]*m/g, "");
    if (/^(✗|Cannot |cannot |unknown |Usage:)/.test(plain)) throw new Error(plain);
    ctx.log.append({
      type: "ext/event",
      at: now(),
      source: "setup",
      kind: "setting",
      payload: { key: def.key, value, scope: "session" },
    });
    ctx.persistSetup();
    if (scope === "both" && save) {
      try {
        await save(def.key, value);
      } catch (err) {
        return {
          ok: false,
          message: `${def.key} changed for this session, but was not saved: ${(err as Error).message}. Retry saving in Saved defaults.`,
        };
      }
    }
    return {
      ok: true,
      message: `${def.key} → ${formatSetting(def, value)} · ${settingTiming(ctx, def, "session")}${scope === "both" ? (save ? " · saved to config" : " · not saved: no config here") : " · this session only"}`,
    };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

export function parseTyped(arg: string): { def: SettingDef; value: unknown } | string {
  const [key = "", ...rest] = arg.trim().split(/\s+/);
  const def = settingDef(key);
  if (!def) return `unknown setting ${key} · /settings lists them`;
  if (rest.length === 0) return `usage: /settings ${def.key} <value> · ${def.note}`;
  try {
    return { def, value: parseSetting(def, rest.join(" ")) };
  } catch (err) {
    return (err as Error).message;
  }
}

export function describeChange(
  def: SettingDef,
  value: unknown,
  applied: string | undefined,
  saved: boolean,
): string {
  return [
    `${def.key} → ${formatSetting(def, value)}`,
    applied || (def.scope === "now" ? "in effect now" : "takes effect at the next start"),
    saved ? "saved to config" : "not saved: no config here",
  ].join(" · ");
}

export type { Preset };

export function captureSessionSetup(ctx: TuiContext): SessionSetup {
  const values = setupSnapshot(SETTINGS, (def) => effectiveSetting(ctx, def));
  values.extensions = [...(ctx.setupInitial.extensions ?? [])];
  values.approval = structuredClone(ctx.approval.cfg);
  if (ctx.setupInitial.systemPromptFile)
    values.systemPromptFile = ctx.setupInitial.systemPromptFile;
  if (ctx.setupInitial.appendSystemPromptFile)
    values.appendSystemPromptFile = ctx.setupInitial.appendSystemPromptFile;
  return {
    values,
    tools: ctx.defs().map((tool) => tool.name),
    descriptions: structuredClone(ctx.slots.toolPrompts.descriptions ?? {}),
  };
}
