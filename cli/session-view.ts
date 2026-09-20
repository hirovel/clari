// 延续组装工作台的行式布局:来源、值和操作分开,长列表不挤走底部动作。
import {
  type Component,
  Editor,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { unresolvedCalls } from "../src/recovery.js";
import {
  formatSetting,
  getSetting,
  parseSetting,
  type SettingDef,
  setSetting,
} from "../src/settings.js";
import { type SessionSetup, WORK_SETTINGS } from "./session-setup.js";
import { c, editorTheme } from "./theme.js";
import type { TuiContext } from "./tui-context.js";
import { printableInput } from "./tui-format.js";

export type ExitState = {
  phase: "stopping" | "cleanup";
  force: () => void;
  failure?: string;
  retry?: () => void;
  error?: string;
};

/** 退出期间保持独立焦点,只展示日志能证明的状态,不推断外部任务已停止。 */
export function exitReview(ctx: TuiContext, state: ExitState): Component {
  let offset = 0;
  let page = 1;
  let total = 0;
  return {
    invalidate() {},
    render(width) {
      const inner = Math.max(1, width - 4);
      const calls = unresolvedCalls(ctx.log.events).filter(
        (item) => !item.recovery && !item.result,
      );
      const body = [
        ...(state.failure
          ? [
              "A fatal error stopped this session. No new work can be submitted.",
              state.failure.split("\n")[0] ?? state.failure,
              "Exit code: 70",
              "",
            ]
          : []),
        ...(state.error ? [`Cannot exit: ${state.error}`, ""] : []),
        ...[ctx.log, ...ctx.children.views.map((v) => v.info.log)].flatMap((log) =>
          log.recording?.error
            ? [
                `Saving failed: ${log.recording.error}`,
                "Waiting to save session records. Ctrl+S retries; force exit may lose unsaved data.",
                "",
              ]
            : [],
        ),
        state.phase === "cleanup"
          ? "Waiting for extensions and connections to release resources."
          : "Cancellation requested. Waiting for the current turn to finish.",
        "",
        ...(calls.length
          ? [
              "Calls without results",
              ...calls.map(({ call }) => `${call.name} · ${call.id}\n${JSON.stringify(call.args)}`),
            ]
          : [
              state.phase === "stopping"
                ? "No tool results pending; waiting for the model or turn to settle."
                : "The turn has ended.",
            ]),
        "",
        ctx.deps.inputs?.saving
          ? "Input saving on · drafts and queued messages will be saved."
          : "Input saving off · unsaved inputs will be lost.",
        "Force exit ends clari. External work may continue. Missing results stay unknown; unrecorded output may be lost.",
        ...(state.failure
          ? ["", "Failure details", state.failure, "", `Session log: ${ctx.model.info.sessionFile}`]
          : []),
      ].flatMap((line) => wrapTextWithAnsi(line, inner));
      total = body.length;
      page = Math.max(1, ctx.deps.terminal.rows - (state.retry ? 6 : 5));
      offset = Math.min(offset, Math.max(0, total - page));
      const visible = body.slice(offset, offset + page);
      const title = `${state.failure ? "Fatal error" : "Exiting"} · ${state.phase === "stopping" ? "stopping work" : "releasing resources"}`;
      return [
        ` ${state.failure ? c.zhu(c.bold(title)) : c.bold(title)}`,
        "",
        ...visible.map((line) => ` ${c.soft(line)}`),
        // 占满退出工作区,避免露出已无法使用的历史操作提示;动作固定在底部。
        ...Array<string>(Math.max(0, page - visible.length)).fill(""),
        "",
        ...(state.retry ? [` ${c.jin("r retry saving and continue shutdown")}`] : []),
        ` ${c.jin(state.error ? "f retry force exit" : "f force exit")} ${c.faint(`· PgUp/PgDn scroll · ${Math.min(offset + page, total)}/${total}`)}`,
      ];
    },
    handleInput(data) {
      if (data === "f") state.force();
      else if (data === "r") state.retry?.();
      else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - page);
      else if (matchesKey(data, Key.pageDown))
        offset = Math.min(Math.max(0, total - page), offset + page);
      ctx.tui.requestRender();
    },
  };
}

/** 队列只在明确继续时恢复投递;编辑使用主输入框同一套多行编辑器。 */
export class PendingInputsView implements Component {
  private selected: string | undefined;
  private editing: { id: string; editor: Editor } | undefined;
  private message = "";
  constructor(
    private readonly ctx: TuiContext,
    private readonly resume: () => void,
  ) {}
  invalidate(): void {
    this.editing?.editor.invalidate();
  }
  render(width: number): string[] {
    const items = this.ctx.agent.pending;
    if (!items.some((p) => p.id === this.selected)) this.selected = items[0]?.id;
    const inner = Math.max(1, width - 2);
    const line = (text: string) => ` ${truncateToWidth(text, inner)}`;
    const paused = items.filter((p) => p.paused).length;
    const header = [
      line(c.bold("Pending inputs")),
      line(
        c.faint(
          `${paused} paused · ${items.length - paused} queued · local saving ${this.ctx.deps.inputs?.saving ? "on" : "off"}`,
        ),
      ),
      "",
    ];
    if (this.editing)
      return [
        ...header,
        line("Edit message · delivery mode stays the same"),
        ...this.editing.editor.render(width),
        line(c.zhu(this.message)),
        line(c.faint("Enter save · Shift+Enter newline · Esc cancel edit")),
      ];
    const page = Math.max(1, Math.floor((this.ctx.deps.terminal.rows - 10) / 2));
    const index = Math.max(
      0,
      items.findIndex((p) => p.id === this.selected),
    );
    const start = Math.max(0, index - page + 1);
    const selected = items[index];
    const preview = selected
      ? wrapTextWithAnsi(selected.text.replace(/\t/g, "  "), inner).slice(0, page)
      : [];
    return [
      ...header,
      ...(items.length
        ? items
            .slice(start, start + page)
            .map((p, offset) =>
              line(
                (p.id === this.selected ? c.ink : c.faint)(
                  `${p.id === this.selected ? "›" : " "} ${start + offset + 1}. [${p.paused ? "paused" : "queued"}] ${p.deliverAs === "followUp" ? "follow-up" : "steering"}${p.images?.length ? ` · ${p.images.length} image(s)` : ""} · ${p.text.split("\n")[0]}`,
                ),
              ),
            )
        : [line("No pending messages.")]),
      "",
      ...preview.map(line),
      "",
      ...wrapTextWithAnsi(
        this.ctx.deps.inputs?.error
          ? `Not saved: ${this.ctx.deps.inputs.error}`
          : this.message ||
              (!items.length
                ? "Your draft stays in the main input. Esc returns to it."
                : paused
                  ? "Paused messages wait for your explicit continuation."
                  : "Queued messages follow the current delivery policy."),
        inner,
      )
        .slice(0, 2)
        .map((s) => line(this.ctx.deps.inputs?.error ? c.zhu(s) : c.soft(s))),
      ...(items.length
        ? [line(c.faint("↑↓ select · Enter edit · d remove · c continue all"))]
        : []),
      line(c.faint("s retry saving · Esc back")),
    ];
  }
  handleInput(data: string): void {
    try {
      if (this.editing) {
        if (matchesKey(data, Key.escape)) {
          this.editing = undefined;
          this.message = "";
        } else this.editing.editor.handleInput(data);
      } else if (matchesKey(data, Key.escape)) this.ctx.dialog.close();
      else if (data === "s") {
        this.ctx.deps.inputs?.flush();
        this.message = this.ctx.deps.inputs?.saving
          ? "Saved locally."
          : "Local saving is off. Change saveInputs in /settings.";
      } else if (data === "c") this.resume();
      else {
        const items = this.ctx.agent.pending;
        const index = items.findIndex((p) => p.id === this.selected);
        if (matchesKey(data, Key.up)) this.selected = items[Math.max(0, index - 1)]?.id;
        else if (matchesKey(data, Key.down))
          this.selected = items[Math.min(items.length - 1, index + 1)]?.id;
        else if (data === "d" && this.selected) {
          this.ctx.agent.removePending(this.selected);
          this.message = "Message removed.";
        } else if (matchesKey(data, Key.enter)) {
          const item = items.find((p) => p.id === this.selected);
          if (item) {
            const editor = new Editor(this.ctx.tui, editorTheme, { paddingX: 1 });
            editor.focused = true;
            editor.setText(item.text);
            editor.onSubmit = (text) => {
              this.ctx.agent.editPending(item.id, text);
              this.editing = undefined;
              this.message = "Message updated.";
            };
            this.editing = { id: item.id, editor };
            this.message = "";
          }
        }
      }
    } catch (error) {
      this.message = (error as Error).message;
    }
    this.ctx.tui.requestRender();
  }
}

export class SessionSetupReview implements Component {
  private setup: SessionSetup;
  private index = 0;
  private editing: string | undefined;
  private error = "";
  private page = 1;
  private readonly edited = new Set<string>();
  private readonly fields: SettingDef[] = [
    ...WORK_SETTINGS,
    {
      key: "extensions",
      group: "tools",
      type: "list",
      builtin: [],
      scope: "next start",
      note: "Extension module paths",
    },
    {
      key: "approval",
      group: "strategy",
      type: "text",
      builtin: {},
      scope: "now",
      note: "Approval rules as JSON; used when approve is policy",
    },
  ];
  constructor(
    setup: SessionSetup,
    private readonly missing: string[],
    private readonly rows: () => number,
    private readonly done: (value?: SessionSetup) => void,
    private readonly change: () => void,
  ) {
    this.setup = structuredClone(setup);
  }
  invalidate(): void {}
  render(width: number): string[] {
    const inner = Math.max(1, width - 4);
    this.page = Math.max(1, this.rows() - 8);
    const start = Math.max(0, this.index - this.page + 1);
    const selected = this.fields[this.index] as SettingDef;
    const lines = this.fields.slice(start, start + this.page).map((field, offset) => {
      const source = this.edited.has(field.key)
        ? "edited"
        : this.missing.includes(field.key)
          ? "defaults"
          : "selected";
      const value = getSetting(this.setup.values, field.key);
      const line = `${start + offset === this.index ? "›" : " "} [${source}] ${field.key}: ${field.key === "approval" ? (value === undefined ? "not set (inactive)" : JSON.stringify(value)) : formatSetting(field, value)}`;
      return ` ${truncateToWidth(start + offset === this.index ? c.ink(line) : c.faint(line), inner)}`;
    });
    let editLine = `${selected.key} > ${this.editing ?? ""}▏`;
    if (this.editing !== undefined) {
      const chars = [...editLine];
      while (chars.length && visibleWidth(chars.join("")) > inner - 1) chars.shift();
      editLine = chars.length < [...editLine].length ? `…${chars.join("")}` : editLine;
    }
    return [
      c.bold(" Review session setup"),
      ` ${c.faint(this.missing.length ? `${this.missing.length} missing values proposed from saved defaults` : "Review or adjust before continuing")}`,
      "",
      ...lines,
      "",
      ` ${truncateToWidth(this.editing !== undefined ? editLine : selected.note, inner)}`,
      ` ${truncateToWidth(this.error ? c.zhu(this.error) : c.faint(this.editing !== undefined ? "Enter apply · Esc cancel edit" : "↑↓ select · Enter edit · c continue · Esc back"), inner)}`,
    ];
  }
  handleInput(data: string): void {
    const field = this.fields[this.index] as SettingDef;
    if (this.editing !== undefined) {
      if (matchesKey(data, Key.escape)) {
        this.editing = undefined;
        this.error = "";
      } else if (matchesKey(data, Key.enter)) {
        try {
          const value =
            field.key === "approval" ? JSON.parse(this.editing) : parseSetting(field, this.editing);
          if (
            field.key === "approval" &&
            (!value || typeof value !== "object" || Array.isArray(value))
          )
            throw new Error("Approval rules must be a JSON object");
          this.setup.values = setSetting(
            this.setup.values,
            field.key,
            value ?? (field.type === "list" ? [] : null),
          );
          this.editing = undefined;
          this.error = "";
          this.edited.add(field.key);
        } catch (error) {
          this.error = (error as Error).message;
        }
      } else if (matchesKey(data, Key.ctrl("u"))) this.editing = "";
      else if (matchesKey(data, Key.backspace))
        this.editing = [...this.editing].slice(0, -1).join("");
      else this.editing += printableInput(data);
    } else if (matchesKey(data, Key.escape)) this.done();
    else if (data === "c") this.done(this.setup);
    else if (matchesKey(data, Key.up)) this.index = Math.max(0, this.index - 1);
    else if (matchesKey(data, Key.down))
      this.index = Math.min(this.fields.length - 1, this.index + 1);
    else if (matchesKey(data, Key.pageUp)) this.index = Math.max(0, this.index - this.page);
    else if (matchesKey(data, Key.pageDown))
      this.index = Math.min(this.fields.length - 1, this.index + this.page);
    else if (matchesKey(data, Key.enter)) {
      const value = getSetting(this.setup.values, field.key);
      this.editing =
        field.key === "approval"
          ? JSON.stringify(value ?? {})
          : value === undefined || value === null
            ? "none"
            : Array.isArray(value)
              ? value.join(" ")
              : String(value);
      this.error = field.values ? `Options: ${field.values.map((v) => v.label).join(" / ")}` : "";
    }
    this.change();
  }
}

export function sessionChoice(
  title: string,
  choices: { label: string; note?: string }[],
  rows: () => number,
  done: (label?: string) => void,
  change: () => void,
): Component {
  let index = 0;
  return {
    invalidate() {},
    render(width) {
      const inner = Math.max(1, width - 4);
      const page = Math.max(1, rows() - 7);
      const start = Math.max(0, index - page + 1);
      return [
        ` ${truncateToWidth(c.bold(title), inner)}`,
        "",
        ...choices
          .slice(start, start + page)
          .map(
            (choice, i) =>
              ` ${truncateToWidth(`${start + i === index ? "›" : " "} ${start + i + 1}. ${choice.label}`, inner)}`,
          ),
        "",
        ...wrapTextWithAnsi(choices[index]?.note ?? "", inner)
          .slice(0, 2)
          .map((line) => ` ${c.faint(line)}`),
        ` ${c.faint("↑↓ choose · Enter select · Esc back")}`,
      ];
    },
    handleInput(data) {
      if (matchesKey(data, Key.escape)) done();
      else if (matchesKey(data, Key.enter)) done(choices[index]?.label);
      else if (matchesKey(data, Key.up)) index = Math.max(0, index - 1);
      else if (matchesKey(data, Key.down)) index = Math.min(choices.length - 1, index + 1);
      else if (/^[1-9]$/.test(data) && Number(data) <= choices.length) index = Number(data) - 1;
      change();
    },
  };
}

export function textReview(
  title: string,
  text: string,
  rows: () => number,
  close: () => void,
  change: () => void,
): Component {
  let offset = 0;
  let page = 1;
  let total = 0;
  return {
    invalidate() {},
    render(width) {
      const inner = Math.max(1, width - 4);
      const lines = text.split("\n").flatMap((line) => wrapTextWithAnsi(line, inner));
      total = lines.length;
      page = Math.max(1, rows() - 4);
      offset = Math.min(offset, Math.max(0, total - page));
      return [
        ` ${truncateToWidth(c.bold(title), inner)}`,
        "",
        ...lines.slice(offset, offset + page).map((line) => ` ${line}`),
        ` ${c.faint(`PgUp/PgDn scroll · Esc back · ${Math.min(offset + page, total)}/${total}`)}`,
      ];
    },
    handleInput(data) {
      if (matchesKey(data, Key.escape)) close();
      else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - page);
      else if (matchesKey(data, Key.pageDown))
        offset = Math.min(Math.max(0, total - page), offset + page);
      else if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
      else if (matchesKey(data, Key.down)) offset = Math.min(Math.max(0, total - page), offset + 1);
      change();
    },
  };
}
