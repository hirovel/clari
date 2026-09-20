// 只保存可序列化工作配置。连接、凭据、界面偏好都不从历史恢复。
import type { Preset } from "../src/config.js";
import { type AgentEvent, now } from "../src/events.js";
import type { EventLog } from "../src/log.js";
import { getSetting, SETTINGS, setSetting } from "../src/settings.js";

export const DISPLAY_KEYS = new Set([
  "saveInputs",
  "screen",
  "fold",
  "foldLines",
  "foldSteps",
  "results",
  "notify",
]);
export const WORK_SETTINGS = SETTINGS.filter((def) => !DISPLAY_KEYS.has(def.key));
export type SessionSetup = {
  values: Preset;
  tools: string[];
  descriptions?: Record<string, string>;
};

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
      else if (slot === "compaction" || slot === "compactionTrigger")
        values = setSetting(values, slot, value);
      else if (slot === "tools")
        values = setSetting(
          values,
          "tools.disable",
          value === "all" ? [] : value.replace(/^off: /, "").split(" "),
        );
      else if (slot === "preservation") values = setSetting(values, slot, value || null);
      else if (slot === "approve" && (value === "all" || value === "ask"))
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
