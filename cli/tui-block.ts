// 主屏的文本块:和 pi-tui 的 Text 一样是多行文本,只多一件事,续行悬挂缩进。
// 标签沟版式里正文从第 12 列起,pi-tui 的换行会把折下来的部分顶回第 0 列;
// 这里按每行的形态算出缩进列(标签行 11,子 agent 引导行 4,记号行 2,其余照前导空格),折行后补齐。
// 可选底色:用户消息的底带,整行铺满到终端宽度。
import {
  type Component,
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { GUTTER } from "./cards.js";
import { c } from "./theme.js";

const GUIDE_PLAIN = "  ┆ ";
/** 行首记号:用户消息、调用、结果、提示。续行缩到记号之后。 */
const MARK = /^[›⚙✓✗◇?●•·] /;

/** 一行的悬挂缩进列数。 */
export function hangingIndent(plain: string): number {
  if (plain.startsWith(GUIDE_PLAIN)) return GUIDE_PLAIN.length;
  const leading = plain.length - plain.trimStart().length;
  if (leading > 0) return leading;
  if (MARK.test(plain)) return 2;
  // 标签行:前 9 列是标签,紧接两个空格,正文从第 12 列起。
  if (plain.length > GUTTER + 2 && plain.slice(GUTTER, GUTTER + 2) === "  " && plain[0] !== " ")
    return GUTTER + 2;
  return 0;
}

/** 把一行折到 width 列以内,续行补悬挂缩进。 */
export function hangLine(line: string, width: number): string[] {
  if (visibleWidth(line) <= width) return [line];
  const plain = stripTerminalSequences(line);
  const indent = Math.min(hangingIndent(plain), Math.max(0, width - 10));
  const head = sliceByColumn(line, 0, indent);
  const body = sliceByColumn(line, indent, Number.MAX_SAFE_INTEGER);
  const wrapped = wrapTextWithAnsi(body, Math.max(1, width - indent));
  const prefix = plain.startsWith(GUIDE_PLAIN)
    ? `  ${c.faint("┆")} ${" ".repeat(Math.max(0, indent - GUIDE_PLAIN.length))}`
    : " ".repeat(indent);
  return [head + (wrapped[0] ?? ""), ...wrapped.slice(1).map((w) => prefix + w)];
}

export class Block implements Component {
  private text: string;
  private cachedWidth = -1;
  private cachedText = "";
  private cachedLines: string[] = [];

  constructor(
    text = "",
    private readonly opts: { bg?: (s: string) => string; padX?: number } = {},
  ) {
    this.text = text;
  }

  setText(text: string): void {
    this.text = text;
  }

  invalidate(): void {
    this.cachedWidth = -1;
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedText === this.text) return this.cachedLines;
    const padX = this.opts.padX ?? 1;
    const inner = Math.max(1, width - padX * 2);
    const margin = " ".repeat(padX);
    const out: string[] = [];
    if (this.text.trim()) {
      for (const raw of this.text.replace(/\t/g, "   ").split("\n")) {
        for (const l of hangLine(raw, inner)) {
          const line = margin + l;
          const pad = " ".repeat(Math.max(0, width - visibleWidth(line)));
          out.push(this.opts.bg ? this.opts.bg(line + pad) : line + pad);
        }
      }
    }
    this.cachedWidth = width;
    this.cachedText = this.text;
    this.cachedLines = out;
    return out;
  }
}

/** 一行两端:左边状态,右边用量;放不下时右边先让。 */
export class SplitLine implements Component {
  private left = "";
  private right = "";

  set(left: string, right: string): void {
    this.left = left;
    this.right = right;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const l = visibleWidth(this.left);
    const r = visibleWidth(this.right);
    if (l + 2 + r <= inner) return [` ${this.left}${" ".repeat(inner - l - r)}${this.right} `];
    return [` ${this.left} `];
  }
}
