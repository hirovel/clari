// /settings:一屏所有开关,按用途分组,每行是名字、当前值、一句话、来源;Enter 翻值(布尔直接翻,
// 枚举与数字开编号选单,数字末行"type a value"把命令填进输入框);改完当场生效(能的都生效,
// 要重启的行尾写 next start)并写回配置 defaults。与 /set 的分工:/set 改这一会话的策略并记事件,
// /settings 改每一次会话的行为并写进文件。开关表在 src/settings.ts,这里只画与落地。
import { type Component, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Preset, ResultView } from "../src/config.js";
import {
  formatSetting,
  GROUP_ORDER,
  getSetting,
  parseSetting,
  SETTINGS,
  type SettingDef,
  type SettingLayers,
  settingDef,
  settingSource,
} from "../src/settings.js";
import { parsePreservation } from "./args.js";
import { c, G } from "./theme.js";
import type { TuiContext } from "./tui-context.js";

/** 会话里生效的值:能从运行时读到的读运行时,读不到的读配置层。 */
export function effectiveSetting(ctx: TuiContext, def: SettingDef): unknown {
  const layers = ctx.deps.settings?.settingLayers?.() ?? {};
  const fromLayers = () =>
    getSetting(layers.preset, def.key) ?? getSetting(layers.defaults, def.key) ?? def.builtin;
  switch (def.key) {
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
      return ctx.compaction.reserveTokens;
    case "facts.repeats":
    case "facts.slow":
    case "facts.date": {
      const f = ctx.agent.facts;
      const k = def.key.slice("facts.".length) as "repeats" | "slow" | "date";
      return f ? (f[k] ?? true) : true;
    }
    case "plan":
      return ctx.tools.some((t) => t.name === "plan") && !ctx.slots.disabledTools.has("plan");
    case "planReminder":
      return ctx.agent.planReminder ?? 8;
    case "tools.disable": {
      const off = [...ctx.slots.disabledTools].filter((n) => n !== "plan");
      return off.length > 0 ? off : undefined;
    }
    case "toolPrompts":
      return ctx.slots.toolPrompts.style ?? "explain";
    case "approve":
      return ctx.approval.mode;
    case "compaction":
      return ctx.slots.state.compaction ?? fromLayers();
    case "compactionTrigger":
      return ctx.compaction.trigger ?? "threshold";
    case "preservation":
      return ctx.slots.state.preservation ?? fromLayers();
    case "execution":
      return ctx.agent.slots.execution ?? "sequential";
    case "steering":
      return ctx.slots.state.steering ?? "step";
    case "effort":
      return ctx.agent.effort;
    default:
      return fromLayers();
  }
}

/** 一个开关的来源词。 */
export function sourceOf(ctx: TuiContext, def: SettingDef, effective: unknown): string {
  const layers: SettingLayers = ctx.deps.settings?.settingLayers?.() ?? {};
  return settingSource(def, effective, layers);
}

/**
 * 当场生效。返回说明(或 next start 的提示)。会话内能落的槽走已有的槽命令(记 session/slot)。
 */
export async function applySettingNow(
  ctx: TuiContext,
  def: SettingDef,
  value: unknown,
  slot: (name: string, value: string) => Promise<string>,
): Promise<string | undefined> {
  const { view } = ctx;
  switch (def.key) {
    case "fold":
      view.foldResults = value as boolean;
      ctx.redrawResults?.();
      return undefined;
    case "foldLines":
      view.foldLines = value as number;
      ctx.redrawResults?.();
      return undefined;
    case "foldSteps":
      view.foldSteps = value as number;
      return undefined;
    case "results":
      view.results = { ...view.results, ...((value as Record<string, ResultView>) ?? {}) };
      ctx.redrawResults?.();
      return undefined;
    case "notify":
      ctx.deps.notify = value as "unfocused" | "always" | "off";
      return undefined;
    case "compactionReserve":
      ctx.compaction.reserveTokens = value as number;
      ctx.updateStatus();
      return undefined;
    case "facts.repeats":
    case "facts.slow":
    case "facts.date": {
      const k = def.key.slice("facts.".length);
      ctx.agent.configure({ facts: { ...ctx.agent.facts, [k]: value as boolean } });
      return undefined;
    }
    case "planReminder":
      ctx.agent.configure({ planReminder: value as number });
      return undefined;
    case "plan": {
      const has = ctx.tools.some((t) => t.name === "plan");
      if (!has) return "the plan tool is not loaded in this session · next start";
      if (value) ctx.slots.disabledTools.delete("plan");
      else ctx.slots.disabledTools.add("plan");
      ctx.applyTools?.();
      return undefined;
    }
    case "tools.disable": {
      const names = (value as string[] | undefined) ?? [];
      const plan = ctx.slots.disabledTools.has("plan");
      ctx.slots.disabledTools.clear();
      for (const n of names) ctx.slots.disabledTools.add(n);
      if (plan) ctx.slots.disabledTools.add("plan");
      ctx.applyTools?.();
      return undefined;
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
      if (value === undefined) return undefined;
      parsePreservation(String(value));
      return slot("preservation", String(value));
    case "execution":
      return slot("execution", String(value));
    case "steering":
      return slot("steering", String(value));
    case "effort":
      return slot("effort", value === undefined ? "off" : String(value));
    default:
      return `takes effect at the next start`;
  }
}

export type SettingsRow = { def: SettingDef; group: boolean } | { group: true; name: string };

type Mode =
  | { kind: "list" }
  | {
      kind: "values";
      def: SettingDef;
      index: number;
      items: { label: string; value: unknown; note?: string }[];
    }
  | { kind: "map"; def: SettingDef; index: number; names: string[] }
  | { kind: "listItems"; def: SettingDef; index: number; items: string[] };

export type SettingsDeps = {
  ctx: TuiContext;
  /** 落一个值:当场生效并写回配置;返回一句说明。 */
  set: (def: SettingDef, value: unknown) => Promise<string>;
  /** 把打字形态填进输入框。 */
  fill: (text: string) => void;
  onClose: () => void;
  onChange: () => void;
};

/** 全屏的设置表。 */
export class SettingsView implements Component {
  private index = 0;
  private mode: Mode = { kind: "list" };
  private note: string | undefined;

  constructor(private deps: SettingsDeps) {}

  invalidate(): void {}

  private rows(): ({ kind: "group"; name: string } | { kind: "def"; def: SettingDef })[] {
    const out: ({ kind: "group"; name: string } | { kind: "def"; def: SettingDef })[] = [];
    for (const g of GROUP_ORDER) {
      const defs = SETTINGS.filter((s) => s.group === g);
      if (defs.length === 0) continue;
      out.push({ kind: "group", name: g });
      for (const def of defs) out.push({ kind: "def", def });
    }
    return out;
  }

  private defs(): SettingDef[] {
    return this.rows().flatMap((r) => (r.kind === "def" ? [r.def] : []));
  }

  /** 光标当前的开关。 */
  current(): SettingDef {
    return this.defs()[this.index] as SettingDef;
  }

  /** 定位到某个键(/settings key)。 */
  focus(key: string): boolean {
    const i = this.defs().findIndex((d) => d.key === key);
    if (i < 0) return false;
    this.index = i;
    return true;
  }

  private openValues(def: SettingDef): void {
    const { ctx } = this.deps;
    const cur = effectiveSetting(ctx, def);
    if (def.type === "bool") {
      void this.commit(def, !cur);
      return;
    }
    if (def.type === "map") {
      const names = ctx.tools.map((t) => t.name);
      this.mode = { kind: "map", def, index: 0, names };
      return;
    }
    if (def.type === "list") {
      const items = def.items
        ? [...def.items]
        : ctx.tools.filter((t) => t.name !== "plan").map((t) => t.name);
      this.mode = { kind: "listItems", def, index: 0, items };
      return;
    }
    const items: { label: string; value: unknown; note?: string }[] = (def.values ?? []).map(
      (v) => ({
        label: v.label,
        value: def.type === "number" ? Number(v.label) : v.label,
        ...(v.note && { note: v.note }),
      }),
    );
    if (def.type === "number" || def.type === "text") {
      if (def.builtin === undefined) items.push({ label: "none", value: undefined, note: "unset" });
      items.push({
        label: "type a value",
        value: Symbol.for("type"),
        note: `fills /settings ${def.key} into the input`,
      });
    }
    const at = items.findIndex((i) => String(i.value) === String(cur));
    this.mode = { kind: "values", def, index: at >= 0 ? at : 0, items };
  }

  private async commit(def: SettingDef, value: unknown): Promise<void> {
    this.note = await this.deps.set(def, value);
    this.mode = { kind: "list" };
    this.deps.onChange();
  }

  handleInput(data: string): void {
    const m = this.mode;
    if (m.kind === "list") {
      const n = this.defs().length;
      if (matchesKey(data, Key.escape) || data === "q") {
        this.deps.onClose();
        return;
      }
      if (matchesKey(data, Key.up)) this.index = Math.max(0, this.index - 1);
      else if (matchesKey(data, Key.down)) this.index = Math.min(n - 1, this.index + 1);
      else if (matchesKey(data, Key.pageUp)) this.index = Math.max(0, this.index - 10);
      else if (matchesKey(data, Key.pageDown)) this.index = Math.min(n - 1, this.index + 10);
      else if (matchesKey(data, Key.home)) this.index = 0;
      else if (matchesKey(data, Key.end)) this.index = n - 1;
      else if (matchesKey(data, Key.enter)) {
        this.note = undefined;
        this.openValues(this.current());
      }
      this.deps.onChange();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.mode = { kind: "list" };
      this.deps.onChange();
      return;
    }
    const len =
      m.kind === "values" ? m.items.length : m.kind === "map" ? m.names.length : m.items.length;
    if (matchesKey(data, Key.up)) m.index = Math.max(0, m.index - 1);
    else if (matchesKey(data, Key.down)) m.index = Math.min(len - 1, m.index + 1);
    else if (/^[1-9]$/.test(data) && Number(data) <= len) m.index = Number(data) - 1;
    else if (matchesKey(data, Key.enter)) {
      if (m.kind === "values") {
        const it = m.items[m.index];
        if (!it) return;
        if (it.value === Symbol.for("type")) {
          this.deps.fill(`/settings ${m.def.key} `);
          this.deps.onClose();
          return;
        }
        void this.commit(m.def, it.value);
        return;
      }
      if (m.kind === "listItems") {
        const name = m.items[m.index] as string;
        const cur = (
          (effectiveSetting(this.deps.ctx, m.def) as string[] | undefined) ?? []
        ).slice();
        const next = cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name];
        // 段列表按登记顺序;工具名按字母。
        const ordered = m.def.items ? m.def.items.filter((x) => next.includes(x)) : next.sort();
        void this.deps.set(m.def, ordered.length > 0 ? ordered : undefined).then((note) => {
          this.note = note;
          this.deps.onChange();
        });
        return;
      }
      if (m.kind === "map") {
        // 每个工具在四个可见度之间轮转。
        const name = m.names[m.index] as string;
        const cur = (effectiveSetting(this.deps.ctx, m.def) as Record<string, string>) ?? {};
        const values = (m.def.values ?? []).map((v) => v.label);
        const at = values.indexOf(cur[name] ?? "head");
        const nextValue = values[(at + 1) % values.length] as string;
        void this.deps.set(m.def, { ...cur, [name]: nextValue }).then((note) => {
          this.note = note;
          this.deps.onChange();
        });
        return;
      }
    }
    this.deps.onChange();
  }

  render(width: number): string[] {
    const inner = Math.max(20, width) - 2;
    const pad = (s: string) => ` ${truncateToWidth(s, inner, "…", true)} `;
    const rule = c.faint("─".repeat(inner));
    const { ctx } = this.deps;
    const m = this.mode;
    if (m.kind === "values") {
      const cur = effectiveSetting(ctx, m.def);
      const lines = [
        pad(
          `${c.bold(c.ink(m.def.key))}  ${c.soft(`now ${formatSetting(m.def, cur)} (${sourceOf(ctx, m.def, cur)})`)}  ${c.faint(m.def.note)}`,
        ),
      ];
      m.items.forEach((it, i) => {
        const label = `${i + 1}  ${it.label.padEnd(14)}`;
        lines.push(
          pad(
            i === m.index
              ? `  ${c.zhu(G.cursor)} ${c.bold(c.ink(label))} ${c.faint(it.note ?? "")}`
              : `    ${c.soft(label)} ${c.faint(it.note ?? "")}`,
          ),
        );
      });
      lines.push(pad(""));
      lines.push(
        pad(
          `${c.soft("If you do this")}  ${c.faint(`${m.def.scope === "now" ? "takes effect now" : "takes effect at the next start"} · written to config defaults.${m.def.key}`)}`,
        ),
      );
      lines.push(
        pad(rule),
        pad(c.faint(`↑↓ or 1–${Math.min(9, m.items.length)} choose · Enter set · Esc back`)),
      );
      return lines;
    }
    if (m.kind === "map" || m.kind === "listItems") {
      const cur = effectiveSetting(ctx, m.def);
      const names = m.kind === "map" ? m.names : m.items;
      const lines = [
        pad(
          `${c.bold(c.ink(m.def.key))}  ${c.soft(formatSetting(m.def, cur))}  ${c.faint(m.def.note)}`,
        ),
      ];
      names.forEach((name, i) => {
        let state: string;
        if (m.kind === "map")
          state = ((cur as Record<string, string> | undefined)?.[name] ?? "head").padEnd(6);
        else state = ((cur as string[] | undefined) ?? []).includes(name) ? "on " : "off";
        const label = `${i + 1}  ${name.padEnd(14)} ${state}`;
        lines.push(
          pad(
            i === m.index ? `  ${c.zhu(G.cursor)} ${c.bold(c.ink(label))}` : `    ${c.soft(label)}`,
          ),
        );
      });
      lines.push(pad(""));
      lines.push(
        pad(
          `${c.soft("If you do this")}  ${c.faint(`${m.kind === "map" ? "Enter cycles count · head · tail · all" : "Enter flips it"} · ${m.def.scope === "now" ? "takes effect now" : "takes effect at the next start"} · written to config defaults.${m.def.key}`)}`,
        ),
      );
      lines.push(
        pad(rule),
        pad(c.faint(`↑↓ or 1–${Math.min(9, names.length)} choose · Enter change · Esc back`)),
      );
      return lines;
    }
    const lines = [
      pad(
        `${c.bold(c.ink("Settings"))}  ${c.soft("every session · saved to the config file")}   ${c.faint("this session's strategy slots are in /set")}`,
      ),
      pad(rule),
    ];
    let k = 0;
    for (const r of this.rows()) {
      if (r.kind === "group") {
        lines.push(pad(c.faint(r.name)));
        continue;
      }
      const def = r.def;
      const value = effectiveSetting(ctx, def);
      const src = sourceOf(ctx, def, value);
      const shown = formatSetting(def, value);
      const selected = k === this.index;
      const noteWidth = Math.max(10, inner - 4 - 17 - 14 - 26);
      const body = `${def.key.padEnd(16)} ${truncateToWidth(shown, 13, "…").padEnd(13)} ${truncateToWidth(def.note, noteWidth, "…").padEnd(noteWidth)} ${src}${def.scope === "next start" ? " · next start" : ""}`;
      lines.push(
        pad(selected ? `  ${c.zhu(G.cursor)} ${c.bold(c.ink(body))}` : `    ${c.soft(body)}`),
      );
      k++;
    }
    lines.push(pad(rule));
    lines.push(
      pad(this.note ? c.soft(`  ${this.note}`) : c.faint("↑↓ move · Enter change · Esc close")),
    );
    return lines;
  }
}

/** 打字形态:/settings key value。返回一句说明或错误。 */
export function parseTyped(arg: string): { def: SettingDef; value: unknown } | string {
  const [key = "", ...rest] = arg.trim().split(/\s+/);
  const def = settingDef(key);
  if (!def) return `unknown setting ${key} · /settings lists them`;
  const text = rest.join(" ");
  if (!text) return `usage: /settings ${def.key} <value> · ${def.note}`;
  try {
    return { def, value: parseSetting(def, text) };
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
  const parts = [`${def.key} → ${formatSetting(def, value)}`];
  if (applied) parts.push(applied);
  else parts.push(def.scope === "now" ? "in effect now" : "takes effect at the next start");
  parts.push(saved ? "saved to config" : "not saved: no config here");
  return parts.join(" · ");
}

export type { Preset };
