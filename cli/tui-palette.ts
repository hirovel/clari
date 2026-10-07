// 命令面板(Ctrl+K):一个模糊搜索框统一命令、模型、技能、模板、登录。
// 与 / 补全并存:补全是"我知道要敲什么",面板是"我忘了叫什么"。不画框;↑↓ 选,Enter 定,Esc 关。
import {
  type Component,
  fuzzyFilter,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { c, G, selectedText } from "./theme.js";
import { printableInput } from "./tui-format.js";

export type PaletteKind =
  | "command"
  | "model"
  | "skill"
  | "template"
  | "login"
  | "setting"
  | "session";

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
  setting: "set",
  session: "session",
};

/** 只限制可见行,不能删掉用户仍可浏览的匹配结果。 */
const PALETTE_ROWS = 10;

export class Palette implements Component {
  private query = "";
  private index = 0;
  private detailOffset = 0;
  private detailPage = 1;
  private detailTotal = 0;

  constructor(
    private readonly items: PaletteItem[],
    private readonly onClose: () => void,
    private readonly onChange: () => void = () => {},
    private readonly height: () => number = () => 24,
    private readonly options: { heading?: string; action?: string } = {},
  ) {}

  invalidate(): void {}

  /** 当前匹配的行,按质量排序,导航保留全部结果。 */
  matches(): PaletteItem[] {
    const q = this.query.trim();
    if (!q) return this.items;
    const text = (item: PaletteItem) => `${item.label} ${item.note ?? ""}`;
    const normalized = q.toLowerCase();
    const exact = (item: PaletteItem) => text(item).toLowerCase().includes(normalized);
    // 连续命中的名称优先,避免路径与时间的零散字符盖过完整搜索文字。
    return fuzzyFilter(this.items, q, text).sort((a, b) => Number(exact(b)) - Number(exact(a)));
  }

  render(width = 80): string[] {
    const rows = this.matches();
    const height = Math.max(1, this.height() - 2);
    const inner = Math.max(1, width - 2);
    const selected = rows[this.index];
    const line = (text: string) => truncateToWidth(text, width);
    const wrap = (text: string) =>
      text.split("\n").flatMap((part) => wrapTextWithAnsi(part, inner));
    const action = `Enter ${this.options.action ?? "run"}`;
    const hint = `type to filter · ↑↓ choose · ${action} · Esc close`;
    const hints = wrap(height < 12 ? `↑↓ choose · ${action} · Esc close` : hint);
    if (height < 7 + hints.length)
      return [line(selected?.label ?? "No match"), line(`${action} · Esc close`)].slice(0, height);
    const details = selected
      ? wrap([selected.label, selected.note].filter(Boolean).join("\n"))
      : [];
    this.detailTotal = details.length;
    const bodyHeight = Math.max(2, height - 5 - hints.length);
    const page = Math.min(PALETTE_ROWS, Math.max(1, Math.floor((bodyHeight * 2) / 3)));
    this.detailPage = Math.max(1, bodyHeight - Math.min(page, Math.max(1, rows.length)));
    this.detailOffset = Math.min(this.detailOffset, Math.max(0, details.length - this.detailPage));
    const start = Math.max(0, Math.min(this.index - Math.floor(page / 2), rows.length - page));
    const visible = rows.slice(start, start + page);
    const labelWidth = Math.max(0, ...visible.map((row) => visibleWidth(row.label)));
    return [
      line(c.bold(c.ink(this.options.heading ?? "Command palette"))),
      line(`  ${c.zhu("›")} ${c.ink(this.query)}${c.faint("▏")}`),
      ...visible.map((r, offset) => {
        const i = start + offset;
        const cursor = i === this.index ? selectedText(G.cursor) : " ";
        const label = r.label + " ".repeat(Math.max(0, labelWidth - visibleWidth(r.label)));
        const text = i === this.index ? selectedText(label) : c.ink(label);
        return line(
          `  ${cursor} ${text}  ${c.faint(KIND_TAG[r.kind])}${r.note ? `  ${c.faint(r.note.replace(/\s+/g, " "))}` : ""}`,
        );
      }),
      ...(rows.length === 0 ? [line(c.faint("  no match"))] : []),
      line(
        c.faint(
          `Selected ${rows.length ? this.index + 1 : 0}/${rows.length}${this.query ? ` · ${this.items.length} total` : ""}`,
        ),
      ),
      "",
      ...details
        .slice(this.detailOffset, this.detailOffset + this.detailPage)
        .map((part) => ` ${part}`),
      ...hints.map((part) => ` ${c.faint(part)}`),
      line(
        c.faint(
          `PgUp/PgDn details · ${Math.min(this.detailOffset + this.detailPage, this.detailTotal)}/${this.detailTotal}`,
        ),
      ),
    ];
  }

  handleInput(data: string): void {
    const rows = this.matches();
    const previousIndex = this.index;
    const previousQuery = this.query;
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
    if (matchesKey(data, Key.up))
      this.index = rows.length ? (this.index + rows.length - 1) % rows.length : 0;
    else if (matchesKey(data, Key.down))
      this.index = rows.length ? (this.index + 1) % rows.length : 0;
    else if (matchesKey(data, Key.pageUp))
      this.detailOffset = Math.max(0, this.detailOffset - this.detailPage);
    else if (matchesKey(data, Key.pageDown))
      this.detailOffset = Math.min(
        Math.max(0, this.detailTotal - this.detailPage),
        this.detailOffset + this.detailPage,
      );
    else if (matchesKey(data, Key.backspace) || data === "\b") {
      this.query = Array.from(this.query).slice(0, -1).join("");
      this.index = 0;
    } else if (!data.startsWith("\x1b") || data.startsWith("\x1b[200~")) {
      this.query += printableInput(data);
      this.index = 0;
    }
    if (this.index !== previousIndex || this.query !== previousQuery) this.detailOffset = 0;
    this.onChange();
  }
}
