// 虚拟终端:实现 pi-tui 的 Terminal 接口,把输出喂进 xterm 无头模拟器,还原成屏幕文本。
// 让 TUI 的整条渲染管线(组件 → 差分渲染 → ANSI → 终端状态)在没有 TTY 的环境里可验证。
import type { Terminal as PiTerminal } from "@earendil-works/pi-tui";
import * as headless from "@xterm/headless";

// 该包是 CJS/UMD 发行,ESM 下具名导出可能挂在 default 上,两种形态都接住。
const XTerm: typeof headless.Terminal = (
  (headless as unknown as { default?: typeof headless }).default ?? headless
).Terminal;

export class VirtualTerminal implements PiTerminal {
  private xterm: headless.Terminal;
  private onInput: ((data: string) => void) | undefined;
  private pending: Promise<void>[] = [];
  /** 原始 ANSI 输出,供 HTML 预览。 */
  readonly raw: string[] = [];

  constructor(
    private cols = 100,
    private rowCount = 40,
  ) {
    this.xterm = new XTerm({ cols, rows: rowCount, allowProposedApi: true });
  }

  start(onInput: (data: string) => void): void {
    this.onInput = onInput;
  }
  stop(): void {}
  drainInput(): Promise<void> {
    return Promise.resolve();
  }
  write(data: string): void {
    this.raw.push(data);
    this.pending.push(new Promise<void>((r) => this.xterm.write(data, r)));
  }
  get columns(): number {
    return this.cols;
  }
  get rows(): number {
    return this.rowCount;
  }
  get kittyProtocolActive(): boolean {
    return false;
  }
  moveBy(lines: number): void {
    if (lines < 0) this.write(`\x1b[${-lines}A`);
    else if (lines > 0) this.write(`\x1b[${lines}B`);
  }
  hideCursor(): void {
    this.write("\x1b[?25l");
  }
  showCursor(): void {
    this.write("\x1b[?25h");
  }
  clearLine(): void {
    this.write("\x1b[2K");
  }
  clearFromCursor(): void {
    this.write("\x1b[0J");
  }
  clearScreen(): void {
    this.write("\x1b[2J\x1b[H");
  }
  setTitle(): void {}
  setProgress(): void {}

  /** 模拟按键输入。 */
  feed(data: string): void {
    this.onInput?.(data);
  }

  /** 等待模拟器消化全部输出,返回可见屏幕文本(去尾部空行)。 */
  async screen(): Promise<string[]> {
    await Promise.all(this.pending);
    this.pending = [];
    const buf = this.xterm.buffer.active;
    const lines: string[] = [];
    for (let y = 0; y < buf.length; y++) {
      lines.push(buf.getLine(y)?.translateToString(true) ?? "");
    }
    while (lines.length > 0 && lines.at(-1)?.trim() === "") lines.pop();
    return lines;
  }
}

/** 去掉 ANSI 序列,便于内容断言。 */
export function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 终端控制序列
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b_[^\x07]*\x07|\x1b\][^\x07]*\x07/g, "");
}
