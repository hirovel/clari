// 只保存可序列化工作配置。连接、凭据、界面偏好都不从历史恢复。
import type { Preset } from "../src/config.js";
import { type AgentEvent, now } from "../src/events.js";
import type { EventLog } from "../src/log.js";
import { getSetting, SETTINGS, setSetting } from "../src/settings.js";
import { SETUP_SECTIONS, setupSnapshot } from "../src/setup.js";
import type { TuiContext } from "./tui-context.js";
import { effectiveSetting } from "./tui-settings.js";

export const DISPLAY_KEYS = new Set([
  "saveInputs",
  "screen",
  "fold",
  "foldLines",
  "foldSteps",
  "results",
  "notify",
]);
export const WORK_SETTINGS = SETUP_SECTIONS.flatMap((section) =>
  section.keys.flatMap((key) => {
    const def = SETTINGS.find((item) => item.key === key);
    return def && !DISPLAY_KEYS.has(key) ? [def] : [];
  }),
);
export type SessionSetup = {
  values: Preset;
  tools: string[];
  descriptions?: Record<string, string>;
};

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

export function recordSessionSetup(log: EventLog, setup: SessionSetup): void {
  let values: Preset = { ...setup.values };
  for (const key of DISPLAY_KEYS) values = setSetting(values, key, undefined);
  const payload = { ...setup, values };
  const previous = [...log.events]
    .reverse()
    .find((e) => e.type === "ext/event" && e.source === "setup" && e.kind === "snapshot");
  if (
    previous?.type === "ext/event" &&
    JSON.stringify(previous.payload) === JSON.stringify(payload)
  )
    return;
  log.append({ type: "ext/event", at: now(), source: "setup", kind: "snapshot", payload });
}

export function restoreSessionSetup(
  events: readonly AgentEvent[],
  defaults: Preset,
): { setup: SessionSetup; missing: string[] } {
  let values: Preset = {};
  let tools: string[] = [];
  let descriptions: Record<string, string> | undefined;
  for (const event of events) {
    if (event.type === "ext/event" && event.source === "setup") {
      if (event.kind === "snapshot") {
        const stored = event.payload as SessionSetup;
        values = structuredClone(stored.values ?? {});
        tools = [...(stored.tools ?? [])];
        descriptions = stored.descriptions;
      } else if (
        event.kind === "setting" &&
        event.payload.scope === "session" &&
        typeof event.payload.key === "string"
      ) {
        values = setSetting(values, event.payload.key, event.payload.value ?? null);
      }
    } else if (event.type === "session/start" || event.type === "session/model") {
      values = setSetting(values, "model", event.model);
    } else if (event.type === "session/slot") {
      const { slot, value } = event;
      if (slot === "execution" || slot === "steering") values = setSetting(values, slot, value);
      else if (slot === "compaction") {
        const [strategy, trigger] = value.split(" · trigger ");
        values = setSetting(values, "compaction", strategy);
        if (trigger) values = setSetting(values, "compactionTrigger", trigger);
      } else if (slot === "tools")
        values = setSetting(
          values,
          "tools.disable",
          value === "all" ? [] : value.replace(/^off: /, "").split(" "),
        );
      else if (slot === "preservation") {
        const match = value.match(/^(keepRecentTokens|keepRatio)\(([\d.]+)\)$/);
        if (match)
          values = setSetting(
            values,
            slot,
            `${match[1] === "keepRatio" ? "ratio" : "tokens"} ${match[2]}`,
          );
      } else if (slot === "approve" && (value === "all" || value === "ask"))
        values = setSetting(values, slot, value);
    }
  }
  const missing = WORK_SETTINGS.filter((def) => getSetting(values, def.key) === undefined).map(
    (def) => def.key,
  );
  for (const key of missing) values = setSetting(values, key, getSetting(defaults, key) ?? null);
  // 老日志未记录外部扩展清单时也必须让用户看到补全来源。
  if (values.extensions === undefined) {
    missing.push("extensions");
    values.extensions = [...(defaults.extensions ?? [])];
  }
  if (values.approve === "policy" && values.approval === undefined) {
    missing.push("approval");
    if (defaults.approval) values.approval = structuredClone(defaults.approval);
  }
  return { setup: { values, tools, ...(descriptions && { descriptions }) }, missing };
}

export function withCurrentDisplay(values: Preset, current: Preset): Preset {
  for (const key of DISPLAY_KEYS) values = setSetting(values, key, getSetting(current, key));
  return values;
}
