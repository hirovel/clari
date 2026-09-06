// 命令面板(Ctrl+K):一个模糊搜索框统一命令、模型、技能、模板、登录。
// 与 / 补全并存:补全是"我知道要敲什么",面板是"我忘了叫什么"。不画框;↑↓ 选,Enter 定,Esc 关。
import { type Component, fuzzyFilter, Key, matchesKey } from "@earendil-works/pi-tui";
import { c } from "./theme.js";

export type PaletteKind = "command" | "model" | "skill" | "template" | "login";

export type PaletteItem = {
  kind: PaletteKind;
  label: string;
  note?: string;
  /** 选中后做什么。 */
  run(): void;
};

const KIND_TAG: Record<PaletteKind, string> = {
  command: "cmd",
  model: "model",
  skill: "skill",
  template: "tmpl",
  login: "login",
};

/** 最多显示的行数;超出的按匹配质量截掉,再敲几个字就能缩小。 */
export const PALETTE_ROWS = 10;

export class Palette implements Component {
  private query = "";
  private index = 0;

  constructor(
    private readonly items: PaletteItem[],
    private readonly onClose: () => void,
    private readonly onChange: () => void = () => {},
  ) {}

  invalidate(): void {}

  /** 当前匹配的行(按质量排序,取前 PALETTE_ROWS 条)。 */
  matches(): PaletteItem[] {
    const q = this.query.trim();
    const all = q ? fuzzyFilter(this.items, q, (i) => `${i.label} ${i.note ?? ""}`) : this.items;
    return all.slice(0, PALETTE_ROWS);
  }

  render(): string[] {
    const rows = this.matches();
    const width = Math.max(0, ...rows.map((r) => r.label.length));
    const lines = [
      `${c.bold(c.ink("Command palette"))}  ${c.faint("commands, models, skills, templates, login")}`,
      `  ${c.zhu("›")} ${c.ink(this.query)}${c.faint("▏")}`,
      ...rows.map((r, i) => {
        const cursor = i === this.index ? c.ink("▸") : " ";
        const label = r.label.padEnd(width);
        const text = i === this.index ? c.bold(c.ink(label)) : c.ink(label);
        return `  ${cursor} ${text}  ${c.faint(KIND_TAG[r.kind].padEnd(5))}${r.note ? `  ${c.faint(r.note)}` : ""}`;
      }),
      ...(rows.length === 0 ? [c.faint("  no match")] : []),
      c.faint("  type to filter · ↑↓ choose · Enter run · Esc close"),
    ];
    return lines;
  }

  handleInput(data: string): void {
    const rows = this.matches();
    if (matchesKey(data, Key.escape)) {
      this.onClose();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const row = rows[this.index];
      this.onClose();
      row?.run();
      return;
    }
    if (data === "\x1b[A") this.index = rows.length ? (this.index + rows.length - 1) % rows.length : 0;
    else if (data === "\x1b[B") this.index = rows.length ? (this.index + 1) % rows.length : 0;
    else if (data === "\x7f" || data === "\b") {
      this.query = this.query.slice(0, -1);
      this.index = 0;
    } else if (!data.startsWith("\x1b") && data >= " ") {
      this.query += data;
      this.index = 0;
    }
    this.onChange();
  }
}
