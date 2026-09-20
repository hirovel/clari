// 主屏的文本块:和 pi-tui 的 Text 一样是多行文本,只多两件事:续行悬挂缩进,以及可选的不折行截断。
// 标记列版式里正文从第 2 列起,pi-tui 的换行会把折下来的部分顶回第 0 列;
// 这里按每行的形态算出缩进列(记号行 2,子 agent 引导行 4,其余照前导空格),折行后补齐。
// 截断模式给代码与工具输出:折行的代码比截断的更难读,超宽的行切到宽度并以 … 收尾。
// 可选底色:整行铺满到终端宽度。
import {
  type Component,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { PROMPT_MARK } from "./terminal-extras.js";
import { c } from "./theme.js";

const GUIDE_PLAIN = "  ┆ ";
/** 行首记号:用户、调用、结果、思考与说明、上下文变化、编辑、失败、折起的步、光标。续行缩到记号之后。 */
const MARK = /^[›»└✓✗≈✎≡▸◇?●•·] /;

/** 一行的悬挂缩进列数。 */
export function hangingIndent(plain: string): number {
  if (plain.startsWith(GUIDE_PLAIN)) return GUIDE_PLAIN.length;
  const leading = plain.length - plain.trimStart().length;
  if (leading > 0) return leading;
  if (MARK.test(plain)) return 2;
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
    private readonly opts: { bg?: (s: string) => string; padX?: number; truncate?: boolean } = {},
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
        // 提示标记(OSC 133;A)要在整行最前面,备用屏按它跳步;剥下来,折行后再贴回首行。
        const marked = raw.startsWith(PROMPT_MARK);
        const body = marked ? raw.slice(PROMPT_MARK.length) : raw;
        const rows = this.opts.truncate
          ? [truncateToWidth(body, inner, "…")]
          : hangLine(body, inner);
        rows.forEach((l, i) => {
          const line = margin + l;
          const pad = " ".repeat(Math.max(0, width - visibleWidth(line)));
          const full = this.opts.bg ? this.opts.bg(line + pad) : line + pad;
          out.push(marked && i === 0 ? PROMPT_MARK + full : full);
        });
      }
    }
    this.cachedWidth = width;
    this.cachedText = this.text;
    this.cachedLines = out;
    return out;
  }
}
