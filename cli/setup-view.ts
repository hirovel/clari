// 组装工作台:有限高度的导航、说明和编辑状态。不执行 Agent 策略,所有写入都走设置控制器。
import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Preset } from "../src/config.js";
import {
  defaultPreset,
  formatSetting,
  parseSetting,
  SETTINGS,
  type SettingDef,
  setSetting,
  settingDef,
} from "../src/settings.js";
import {
  configuredValue,
  SETUP_SECTIONS,
  type SetupScope,
  sameSetting,
  setupGuide,
  setupSnapshot,
  setupValue,
} from "../src/setup.js";
import { c, G } from "./theme.js";
import type { TuiContext } from "./tui-context.js";
import { printableInput } from "./tui-format.js";
import { type SettingChange, settingTiming, setupRead, sourceOf } from "./tui-settings.js";

type Choice = { label: string; value: unknown; note?: string };
type BrowsingMode =
  | { kind: "browse" }
  | { kind: "choices"; def: SettingDef; items: Choice[] }
  | { kind: "members"; def: SettingDef; names: string[] };
type Mode =
  | BrowsingMode
  | { kind: "text"; def?: SettingDef; text: string; purpose: "value" | "save" }
  | { kind: "restore"; def: SettingDef }
  | { kind: "info"; def: SettingDef; offset: number; from: BrowsingMode; index: number }
  | { kind: "presets" }
  | { kind: "presetReview"; name: string; values: Preset; offset: number };

type Row = { title: string; value?: string; note?: string; def?: SettingDef; run: () => void };
export type SetupViewDeps = {
  ctx: TuiContext;
  set(def: SettingDef, value: unknown, scope: SetupScope): Promise<SettingChange>;
  open(command: string): void;
  onClose(): void;
  onChange(): void;
};

export class SetupView implements Component {
  private scope: SetupScope = "session";
  private section: number | undefined;
  private index = 0;
  private returnIndex = 0;
  private mode: Mode = { kind: "browse" };
  private query = "";
  private searching = false;
  private notice: SettingChange | undefined;
  private busy = false;

  constructor(private readonly deps: SetupViewDeps) {}
  invalidate(): void {}

  focus(key: string): boolean {
    const section = SETUP_SECTIONS.findIndex((s) => s.keys.includes(key));
    if (section < 0) return false;
    this.section = section;
    this.index = SETUP_SECTIONS[section]?.keys.indexOf(key) ?? 0;
    this.mode = { kind: "browse" };
    return true;
  }

  private read(def: SettingDef): unknown {
    return setupRead(this.deps.ctx, def, this.scope);
  }

  private skillNote(name: string): string {
    if (!name) return "New installations join automatically on the next start.";
    const skill = this.deps.ctx.skills.find((s) => s.name === name);
    return skill
      ? `${skill.description || "No description"}\n${skill.path}${skill.disableModelInvocation ? "\nMarked disable-model-invocation by the skill author." : ""}`
      : "Not discovered. The saved name is kept for future starts.";
  }
  private value(def: SettingDef): string {
    if (def.key === "tools.disable") {
      const disabled = (this.read(def) as string[] | undefined) ?? [];
      const count = this.deps.ctx.tools.filter(
        (t) => t.name !== "plan" && !disabled.includes(t.name),
      ).length;
      return `${count} available`;
    }
    return setupValue(def, this.read(def));
  }

  private settingRow(def: SettingDef): Row {
    return { title: setupGuide(def).title, value: this.value(def), def, run: () => this.edit(def) };
  }

  private summary(i: number): string {
    const section = SETUP_SECTIONS[i];
    if (!section) return "";
    const { ctx } = this.deps;
    if (section.id === "model")
      return String(this.read(settingDef("model") as SettingDef) ?? "Configured default");
    if (section.id === "tools" && this.scope === "session")
      return `${ctx.defs().length} tools loaded`;
    const key = section.keys[0];
    const def = key ? settingDef(key) : undefined;
    return def ? this.value(def) : "";
  }

  private rows(): Row[] {
    const { ctx } = this.deps;
    const m = this.mode;
    if (m.kind === "choices")
      return m.items.map((item) => ({
        title: item.label,
        value: sameSetting(item.value, this.read(m.def))
          ? this.scope === "session"
            ? "Current"
            : "Saved"
          : sameSetting(item.value, m.def.builtin)
            ? "Recommended"
            : "",
        ...(item.note && { note: item.note }),
        run: () => {
          void this.commit(m.def, item.value, true);
        },
      }));
    if (m.kind === "members") {
      const current = this.read(m.def);
      const skillRange = m.def.key === "prompt.skills.include";
      return m.names.map((name) => {
        const skill = skillRange ? ctx.skills.find((s) => s.name === name) : undefined;
        const manualOnly = skill?.disableModelInvocation;
        const all = skillRange && name === "";
        const listed =
          (skillRange && current === "all") || (Array.isArray(current) && current.includes(name));
        const enabled = m.def.key === "tools.disable" ? !listed : listed;
        return {
          title: all ? "All (including new skills)" : name,
          value:
            m.def.type === "map"
              ? ((current as Record<string, string> | undefined)?.[name] ?? "head")
              : manualOnly
                ? "Manual only"
                : all
                  ? current === "all"
                    ? "[x]"
                    : "[ ]"
                  : enabled
                    ? "Enabled [x]"
                    : "Disabled [ ]",
          ...(skillRange && { note: this.skillNote(name) }),
          run: () => {
            if (manualOnly) {
              this.notice = {
                ok: false,
                message: "This skill is marked manual-only. Use /name to invoke it.",
              };
              return;
            }
            if (all) {
              void this.commit(m.def, current === "all" ? [] : "all", false);
              return;
            }
            if (m.def.type === "map") {
              const values = m.def.values?.map((v) => v.label) ?? [];
              const old = (current as Record<string, string> | undefined)?.[name] ?? "head";
              void this.commit(
                m.def,
                {
                  ...((current as Record<string, string>) ?? {}),
                  [name]: values[(values.indexOf(old) + 1) % values.length],
                },
                false,
              );
            } else {
              const old =
                skillRange && current === "all"
                  ? ctx.skills.filter((s) => !s.disableModelInvocation).map((s) => s.name)
                  : ((current as string[] | undefined) ?? []);
              const next = listed ? old.filter((v) => v !== name) : [...old, name];
              // 保持用户既有的段顺序;重新启用的段追加到尾部。空列表就是空列表,不能恢复成缺省全开。
              void this.commit(m.def, next, false);
            }
          },
        };
      });
    }
    if (m.kind === "presets")
      return [
        {
          title: "Recommended",
          value: "Built-in starting point",
          run: () => this.reviewPreset("recommended", defaultPreset()),
        },
        ...(ctx.deps.settings?.listPresets?.() ?? []).map((p) => ({
          title: p.name,
          value: "Custom preset",
          run: () => this.reviewPreset(p.name, p.values),
        })),
      ];
    if (m.kind === "presetReview" || m.kind === "restore")
      return [
        {
          title: m.kind === "restore" ? "Restore recommended value" : "Use for saved defaults",
          run: () => {
            if (m.kind === "restore") void this.commit(m.def, structuredClone(m.def.builtin), true);
            else
              void this.run(async () => {
                if (!ctx.deps.settings?.usePreset)
                  throw new Error("Loading presets is not available here.");
                await ctx.deps.settings.usePreset(m.name);
                this.scope = "defaults";
                this.mode = { kind: "browse" };
                this.section = undefined;
                this.index = 0;
                return {
                  ok: true,
                  message: `${m.name} saved as defaults. Restart to use it; this session is unchanged. Explicit flags and --preset still take priority.`,
                };
              });
          },
        },
      ];
    if (m.kind === "text") return [];
    if (m.kind === "info") return [];
    if (this.searching || this.query) {
      const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean);
      return SETTINGS.filter((def) =>
        terms.every((term) =>
          `${def.key} ${setupGuide(def).title} ${def.note}`.toLowerCase().includes(term),
        ),
      ).map((def) => this.settingRow(def));
    }
    if (this.section === undefined)
      return [
        ...SETUP_SECTIONS.map((section, i) => ({
          title: section.title,
          value: this.summary(i),
          note: section.description,
          run: () => {
            this.section = i;
            this.index = 0;
          },
        })),
        {
          title: "Save as preset",
          value: this.scope === "session" ? "From this session" : "From saved defaults",
          run: () => this.startText("save"),
        },
        {
          title: "Load preset",
          value: "For future starts",
          run: () => {
            this.mode = { kind: "presets" };
            this.index = 0;
          },
        },
      ];
    const section = SETUP_SECTIONS[this.section];
    if (!section) return [];
    return [
      ...section.keys.flatMap((key) => {
        const def = settingDef(key);
        return def ? [this.settingRow(def)] : [];
      }),
      ...(section.action
        ? [
            {
              title: section.action.label,
              value: "Current session",
              run: () => {
                this.deps.onClose();
                this.deps.open(section.action?.command ?? "/settings");
              },
            },
          ]
        : []),
    ];
  }

  private edit(def: SettingDef): void {
    this.returnIndex = this.index;
    this.notice = undefined;
    if (this.scope === "session" && def.scope === "next start") {
      this.notice = { ok: false, message: settingTiming(this.deps.ctx, def, this.scope) };
      return;
    }
    this.index = 0;
    if (def.type === "list" || def.type === "map") {
      const configured =
        def.type === "map"
          ? Object.keys((this.read(def) ?? {}) as object)
          : Array.isArray(this.read(def))
            ? (this.read(def) as string[])
            : [];
      const names =
        def.key === "prompt.skills.include"
          ? ["", ...new Set([...this.deps.ctx.skills.map((s) => s.name), ...configured])]
          : def.key === "mcpReconnect"
            ? [
                ...new Set([
                  ...(this.deps.ctx.deps.mcp?.statuses().map((server) => server.name) ?? []),
                  ...configured,
                ]),
              ]
            : def.items
              ? [...def.items]
              : [
                  ...new Set([
                    ...this.deps.ctx.tools
                      .filter((t) => def.key !== "tools.disable" || t.name !== "plan")
                      .map((t) => t.name),
                    ...configured,
                  ]),
                ];
      this.mode = { kind: "members", def, names };
      return;
    }
    const values =
      def.key === "model"
        ? (this.deps.ctx.deps.settings?.listModels() ?? []).map((label) => ({
            label,
            note: "Configured model",
          }))
        : (def.values ?? []);
    const items: Choice[] = values.map((v) => {
      const value =
        def.type === "bool" ? v.label === "on" : def.type === "number" ? Number(v.label) : v.label;
      return { label: setupValue(def, value), value, ...(v.note && { note: v.note }) };
    });
    if (def.builtin === undefined)
      items.unshift({
        label: setupValue(def, undefined),
        value: undefined,
        note: "Use the built-in starting point",
      });
    const cur = this.read(def);
    if (!items.some((item) => sameSetting(item.value, cur)))
      items.unshift({ label: setupValue(def, cur), value: cur, note: "Your current value" });
    this.index = Math.max(
      0,
      items.findIndex((item) => sameSetting(item.value, cur)),
    );
    this.mode = { kind: "choices", def, items };
  }

  private startText(purpose: "value" | "save", def?: SettingDef): void {
    this.notice = undefined;
    this.mode = {
      kind: "text",
      purpose,
      ...(def && { def }),
      text: purpose === "value" && def ? String(this.read(def) ?? "") : "",
    };
  }

  private reviewPreset(name: string, values: Preset): void {
    this.mode = { kind: "presetReview", name, values, offset: 0 };
    this.index = 0;
  }

  private async run(action: () => Promise<SettingChange>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.deps.onChange();
    try {
      this.notice = await action();
    } catch (err) {
      this.notice = { ok: false, message: (err as Error).message };
    } finally {
      this.busy = false;
      this.deps.onChange();
    }
  }

  private async commit(def: SettingDef, value: unknown, back: boolean): Promise<void> {
    const scope = this.scope;
    await this.run(async () => {
      const result = await this.deps.set(def, value, scope);
      if (result.ok && back) {
        this.mode = { kind: "browse" };
        this.index = this.returnIndex;
      }
      return result;
    });
  }

  private submitText(): void {
    const m = this.mode;
    if (m.kind !== "text") return;
    if (m.purpose === "value" && m.def) {
      try {
        void this.commit(m.def, parseSetting(m.def, m.text), true);
      } catch (err) {
        this.notice = { ok: false, message: (err as Error).message };
      }
      return;
    }
    void this.run(async () => {
      const name = m.text.trim();
      const settings = this.deps.ctx.deps.settings;
      if (!settings?.savePreset) throw new Error("Saving presets is not available here.");
      const values = setupSnapshot(SETTINGS, (def) => this.read(def));
      // 模型只记录名字;凭据始终留在登录入口。
      const model =
        this.scope === "session"
          ? `${this.deps.ctx.model.info.providerName}/${this.deps.ctx.model.info.model}`
          : settings.settingLayers?.().defaults?.model;
      if (model && !model.startsWith("none/")) values.model = model;
      else if (String(values.model).startsWith("none/")) values.model = null;
      await settings.savePreset(name, values);
      this.mode = { kind: "browse" };
      this.section = undefined;
      this.index = 7;
      return {
        ok: true,
        message: `Preset ${name} saved. Load it here for future starts, or launch clari --preset ${name}.`,
      };
    });
  }

  handleInput(data: string): void {
    if (this.busy) return;
    const m = this.mode;
    if (matchesKey(data, Key.escape)) {
      this.notice = undefined;
      if (m.kind === "info") {
        this.mode = m.from;
        this.index = m.index;
      } else if (m.kind !== "browse") {
        this.mode = { kind: "browse" };
        this.index = this.returnIndex;
      } else if (this.searching || this.query) {
        this.searching = false;
        this.query = "";
        this.index = 0;
      } else if (this.section !== undefined) {
        this.index = this.section;
        this.section = undefined;
      } else this.deps.onClose();
      this.deps.onChange();
      return;
    }
    if (m.kind === "text") {
      if (matchesKey(data, Key.enter)) this.submitText();
      else if (data === "\x7f" || data === "\b") m.text = Array.from(m.text).slice(0, -1).join("");
      else if (matchesKey(data, Key.ctrl("u"))) m.text = "";
      else m.text += printableInput(data);
      this.deps.onChange();
      return;
    }
    if (m.kind === "info") {
      if (matchesKey(data, Key.up)) m.offset = Math.max(0, m.offset - 1);
      else if (matchesKey(data, Key.down)) m.offset += 1;
      else if (matchesKey(data, Key.pageDown)) m.offset += 6;
      else if (matchesKey(data, Key.pageUp)) m.offset = Math.max(0, m.offset - 6);
      this.deps.onChange();
      return;
    }
    if (
      m.kind === "presetReview" &&
      (matchesKey(data, Key.up) ||
        matchesKey(data, Key.down) ||
        matchesKey(data, Key.pageUp) ||
        matchesKey(data, Key.pageDown))
    ) {
      const delta = matchesKey(data, Key.up)
        ? -1
        : matchesKey(data, Key.pageUp)
          ? -6
          : matchesKey(data, Key.pageDown)
            ? 6
            : 1;
      m.offset = Math.max(0, m.offset + delta);
      this.deps.onChange();
      return;
    }
    if (matchesKey(data, Key.tab) && m.kind === "browse") {
      this.scope = this.scope === "session" ? "defaults" : "session";
      this.notice = undefined;
    } else if (m.kind === "browse" && data === "/") {
      this.searching = true;
      this.query = "";
      this.index = 0;
    } else if (
      this.searching &&
      m.kind === "browse" &&
      !matchesKey(data, Key.enter) &&
      !matchesKey(data, Key.up) &&
      !matchesKey(data, Key.down)
    ) {
      if (data === "\x7f" || data === "\b")
        this.query = Array.from(this.query).slice(0, -1).join("");
      else this.query += printableInput(data);
      this.index = 0;
    } else if (
      (data === "e" || data === "E") &&
      m.kind === "choices" &&
      ["number", "text"].includes(m.def.type)
    )
      this.startText("value", m.def);
    else if (
      (data === "i" || data === "I") &&
      !this.searching &&
      (m.kind === "browse" || m.kind === "choices" || m.kind === "members")
    ) {
      const def = "def" in m ? m.def : this.rows()[this.index]?.def;
      if (def) {
        this.returnIndex = m.kind === "browse" ? this.index : this.returnIndex;
        this.mode = { kind: "info", def, offset: 0, from: m, index: this.index };
      }
    } else if (
      (data === "r" || data === "R") &&
      m.kind === "browse" &&
      this.rows()[this.index]?.def
    ) {
      this.returnIndex = this.index;
      this.mode = { kind: "restore", def: this.rows()[this.index]?.def as SettingDef };
      this.index = 0;
    } else {
      const rows = this.rows();
      if (matchesKey(data, Key.up)) this.index = Math.max(0, this.index - 1);
      else if (matchesKey(data, Key.down))
        this.index = Math.min(Math.max(0, rows.length - 1), this.index + 1);
      else if (matchesKey(data, Key.home)) this.index = 0;
      else if (matchesKey(data, Key.end)) this.index = Math.max(0, rows.length - 1);
      else if (matchesKey(data, Key.pageUp)) this.index = Math.max(0, this.index - 6);
      else if (matchesKey(data, Key.pageDown))
        this.index = Math.min(Math.max(0, rows.length - 1), this.index + 6);
      else if (/^[1-9]$/.test(data) && rows.length >= Number(data)) this.index = Number(data) - 1;
      else if (matchesKey(data, Key.enter)) rows[this.index]?.run();
    }
    this.deps.onChange();
  }

  private detail(row: Row | undefined, compact = false): string[] {
    const m = this.mode;
    const { ctx } = this.deps;
    const def = "def" in m ? m.def : row?.def;
    if (def) {
      const guide = setupGuide(def);
      const current = setupRead(ctx, def, "session");
      const saved = setupRead(ctx, def, "defaults");
      const browsing = m.kind === "info" ? m.from : m;
      const index = m.kind === "info" ? m.index : this.index;
      const choice = browsing.kind === "choices" ? browsing.items[index] : undefined;
      const memberName = browsing.kind === "members" ? browsing.names[index] : undefined;
      const member = memberName === "" ? "All (including new skills)" : memberName;
      const memberNote =
        memberName !== undefined && def.key === "prompt.skills.include"
          ? this.skillNote(memberName)
          : undefined;
      const valueText = (value: unknown) => {
        const label = setupValue(def, value);
        const raw = formatSetting(def, value);
        return compact || label === raw ? label : `${label} (${raw})`;
      };
      const state = [
        c.soft(`Current: ${valueText(current)}`),
        c.soft(`Saved default: ${valueText(saved)}`),
      ];
      const skillPlacement = !def.key.startsWith("prompt.skills.")
        ? []
        : setupRead(ctx, settingDef("prompt.skills.mode") as SettingDef, this.scope) !== "auto"
          ? [
              "Manual mode: no catalog added; range inactive.",
              "/name sends instructions + request as a user message.",
            ]
          : setupRead(ctx, settingDef("prompt.skills.load") as SettingDef, this.scope) === "tool"
            ? [
                "Catalog target: skill tool definition, not system.",
                "Names + descriptions; instructions arrive in its result.",
              ]
            : [
                "Catalog target: system prompt / Skills section.",
                "Names + descriptions + paths; instructions arrive in a read result.",
              ];
      // 完整说明与紧凑预览使用同一候选;进入详情只保存临时导航位置。
      return [
        ...(choice
          ? [
              c.bold(c.jin("Highlighted choice")),
              c.ink(choice.label),
              c.soft(choice.note ?? guide.effect),
            ]
          : member
            ? [c.bold(c.jin("Highlighted item")), c.ink(member)]
            : [c.bold(c.ink(guide.title))]),
        ...(!choice && !member ? state : []),
        ...skillPlacement.map((line) => c.jin(line)),
        ...(memberNote ? [c.soft(memberNote)] : []),
        c.jin(`Applies: ${settingTiming(ctx, def, this.scope)}`),
        ...(choice || member ? [c.faint("── Current state ──"), ...state] : []),
        ...(!compact
          ? [
              "",
              c.faint(`Current value: ${sourceOf(ctx, def, current)}`),
              c.faint(`Key: ${def.key}`),
              "",
              c.bold(c.ink("Effect & tradeoff")),
              c.soft(guide.effect),
              "",
              c.soft(`Recommended: ${setupValue(def, def.builtin)}`),
              c.faint(guide.reason),
              ...(guide.example ? ["", c.bold(c.ink("Example")), c.soft(guide.example)] : []),
            ]
          : choice
            ? []
            : ["", c.soft(guide.effect)]),
      ];
    }
    if (m.kind === "presetReview") {
      const target = (def: SettingDef) =>
        configuredValue(def, m.values) ??
        (def.key === "model" ? ctx.deps.settings?.defaultModel?.() : undefined);
      const changed = SETTINGS.filter(
        (def) => !sameSetting(setupRead(ctx, def, "defaults"), target(def)),
      );
      let additional = m.values;
      for (const def of SETTINGS) additional = setSetting(additional, def.key, undefined);
      return [
        c.bold(c.ink(`Load ${m.name}`)),
        "",
        c.soft(`${changed.length} registered settings differ from saved defaults.`),
        c.soft(
          "Replaces registered defaults with this preset over the built-in starting values. Other saved configuration is retained. This session stays unchanged.",
        ),
        "",
        ...changed.map((def) =>
          c.soft(`${setupGuide(def).title}: ${setupValue(def, target(def))}`),
        ),
        ...(Object.keys(additional).length
          ? ["", c.soft(`Additional preset configuration: ${JSON.stringify(additional)}`)]
          : []),
        "",
        c.faint("Restart to use it. Explicit flags and --preset still take priority."),
      ];
    }
    if (m.kind === "presets")
      return [
        c.bold(c.ink("Reusable setups")),
        "",
        c.soft("Choose a preset to review its changes before replacing saved defaults."),
        "",
        c.faint(
          "The current session keeps its model and settings. Presets contain configuration, never API keys.",
        ),
        ...((ctx.deps.settings?.listPresets?.().length ?? 0) === 0
          ? ["", c.soft("No custom presets yet. Save one from the overview.")]
          : []),
      ];
    if (m.kind === "text")
      return [
        c.bold(c.ink("Save your setup")),
        "",
        c.soft(
          `Capture ${this.scope === "session" ? "current settings and the current model" : "saved default settings"} as a named preset.`,
        ),
        c.faint("Use letters, digits, hyphens or underscores. Existing names are not overwritten."),
        "",
        c.faint(
          "Saves the registered settings and model name. Provider connections, custom extension code and credentials remain configured separately.",
        ),
      ];
    if (this.section === undefined && this.index < SETUP_SECTIONS.length) {
      const section = SETUP_SECTIONS[this.index];
      return [
        c.bold(c.ink(section?.title ?? "Agent setup")),
        "",
        c.soft(section?.description ?? ""),
        "",
        ...(section?.keys ?? []).flatMap((key) => {
          const d = settingDef(key);
          return d ? [c.soft(`${setupGuide(d).title}: ${this.value(d)}`)] : [];
        }),
        "",
        c.faint(
          "Enter to inspect and change this part. Each setting explains its effect and recommended starting value.",
        ),
      ];
    }
    return [
      c.bold(c.ink(row?.title ?? "Agent setup")),
      "",
      c.soft(
        "Start with the built-in recommendations, then replace the parts that fit your work differently.",
      ),
      "",
      c.faint(
        "Tab switches between this session and saved defaults. Saving defaults does not change an in-flight task.",
      ),
      "",
      c.faint("/ searches every setting. R on a setting previews restoring its recommendation."),
    ];
  }

  render(width: number): string[] {
    const { ctx } = this.deps;
    const height = Math.max(8, ctx.deps.terminal.rows - 2);
    const inner = Math.max(1, width - 4);
    const pad = (line: string) => truncateToWidth(`  ${line}`, Math.max(1, width), "", true);
    const wrap = (lines: string[], w: number) =>
      lines.flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, w)) : [""]));
    const rows = this.rows();
    this.index = Math.max(0, Math.min(this.index, Math.max(0, rows.length - 1)));
    const m = this.mode;
    const section = this.section === undefined ? undefined : SETUP_SECTIONS[this.section];
    const trail = this.searching
      ? "Search"
      : m.kind === "presets" || m.kind === "presetReview"
        ? "Presets"
        : "def" in m && m.def
          ? setupGuide(m.def).title
          : section?.title;
    const head = [
      pad(
        `${c.bold(c.ink("Agent setup"))}${trail ? c.soft(` / ${trail}`) : c.faint("  /settings")}`,
      ),
      pad(
        m.kind === "presets" || m.kind === "presetReview"
          ? c.jin("Saved defaults · preview only until you confirm")
          : `${this.scope === "session" ? c.bold(c.jin("[This session]")) : c.soft("This session")}   ${this.scope === "defaults" ? c.bold(c.jin("[Saved defaults]")) : c.soft("Saved defaults")}  ${m.kind === "browse" ? c.faint("Tab to switch") : ""}`,
      ),
      pad(
        c.faint(
          this.scope === "session" && m.kind !== "presets" && m.kind !== "presetReview"
            ? `${ctx.model.info.model} · ${ctx.agent.running ? "Running" : "Idle"} · temporary changes`
            : "Future starts only · current session stays unchanged",
        ),
      ),
      pad(c.faint("─".repeat(inner))),
    ];
    if (this.searching) head.push(pad(`${c.soft("Search / ")}${c.ink(this.query)}${c.jin("▏")}`));
    if (m.kind === "text")
      head.push(
        pad(
          `${c.soft(m.purpose === "save" ? "Preset name: " : "Value: ")}${c.ink(m.text)}${c.jin("▏")}`,
        ),
      );
    const hint =
      m.kind === "text"
        ? "Enter save · Ctrl+U clear · Esc back"
        : m.kind === "info"
          ? "↑↓ scroll · PgUp/PgDn · Esc back"
          : m.kind === "presetReview"
            ? "↑↓ scroll review · Enter use defaults · Esc cancel"
            : m.kind === "choices"
              ? `↑↓ choose · Enter apply${["number", "text"].includes(m.def.type) ? " · E custom" : ""} · I details · Esc back`
              : m.kind === "members"
                ? `↑↓ move · Enter ${m.def.type === "map" ? "cycle" : "toggle"} · I details · Esc back`
                : m.kind === "browse"
                  ? `↑↓ move · Enter open · / search${rows[this.index]?.def ? " · R restore · I details" : ""} · Esc back`
                  : "↑↓ move · Enter select · Esc back";
    const notice = this.notice
      ? wrap([`${this.notice.ok ? "✓" : "!"} ${this.notice.message}`], inner)
          .slice(0, 3)
          .map((l) => pad(this.notice?.ok ? c.soft(l) : c.zhu(l)))
      : [];
    const footer = [
      ...notice,
      pad(c.faint("─".repeat(inner))),
      ...wrap([this.busy ? "Applying…" : hint], inner).map((line) => pad(c.faint(line))),
    ];
    const room = Math.max(1, height - head.length - footer.length);
    if (m.kind === "info") {
      const info = wrap(this.detail(undefined), inner);
      m.offset = Math.max(0, Math.min(m.offset, Math.max(0, info.length - room)));
      return [...head, ...info.slice(m.offset, m.offset + room).map(pad), ...footer];
    }
    const wide = width >= 100 && m.kind !== "text";
    const listWidth = wide ? Math.floor(inner * 0.45) : inner;
    const activeDef = "def" in m ? m.def : rows[this.index]?.def;
    const details = wrap(
      this.detail(rows[this.index], !wide),
      wide ? inner - listWidth - 3 : inner,
    );
    if (m.kind === "presetReview") {
      const available = wide ? room : Math.max(1, room - 2);
      m.offset = Math.min(m.offset, Math.max(0, details.length - available));
      details.splice(0, m.offset);
    }
    const capacity = wide
      ? room
      : m.kind === "text"
        ? 0
        : Math.min(
            Math.max(1, Math.floor(room * (activeDef ? 0.3 : 0.55))),
            Math.max(rows.length, 1),
          );
    const visible = Math.max(1, capacity - (rows.length > capacity ? 1 : 0));
    const start = Math.max(
      0,
      Math.min(this.index - Math.floor(visible / 2), rows.length - visible),
    );
    const list = rows.slice(start, start + visible).map((row, offset) => {
      const selected = start + offset === this.index;
      const titleWidth = Math.max(8, Math.min(29, Math.floor(listWidth * 0.58)));
      const title = truncateToWidth(row.title, titleWidth, "…", true);
      const value = row.value ? ` ${row.value}` : "";
      const line = `${selected ? G.cursor : " "} ${title}${value}`;
      return truncateToWidth(selected ? c.bold(c.ink(line)) : c.soft(line), listWidth, "…", true);
    });
    if (rows.length === 0 && m.kind !== "text")
      list.push(c.soft("No matching settings. Esc clears the search."));
    if (rows.length > visible)
      list.push(
        c.faint(
          `${start + 1}–${Math.min(rows.length, start + visible)} of ${rows.length} · PgUp/PgDn`,
        ),
      );
    const body: string[] = [];
    const clippedDetails = (available: number) => {
      const lines = details.slice(0, available);
      if (activeDef && details.length > available && available > 0)
        lines[available - 1] = c.faint("… I: full details");
      return lines;
    };
    if (wide) {
      const shown = clippedDetails(room);
      for (let i = 0; i < room; i++)
        body.push(
          pad(
            `${truncateToWidth(list[i] ?? "", listWidth, "", true)} ${c.faint("│")} ${shown[i] ?? ""}`,
          ),
        );
    } else {
      const content =
        m.kind === "text"
          ? details
          : [
              ...list,
              c.faint("─".repeat(inner)),
              ...clippedDetails(Math.max(0, room - list.length - 1)),
            ];
      for (let i = 0; i < room; i++) body.push(pad(content[i] ?? ""));
    }
    return [...head, ...body, ...footer].slice(0, height);
  }
}
