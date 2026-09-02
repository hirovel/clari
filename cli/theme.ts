// 终端样式:零依赖 ANSI。色彩纪律沿用纸与刃:朱为唯一强调(工具与错误),泥金为次强调(元信息),
// 其余靠明暗层次,不用框线。
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

const enabled = !process.env.NO_COLOR && process.stdout.isTTY !== false;

function rgb(r: number, g: number, b: number): (s: string) => string {
  return (s) => (enabled ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : s);
}
function sgr(open: number, close: number): (s: string) => string {
  return (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}

export const c = {
  zhu: rgb(214, 96, 78), // 朱
  jin: rgb(201, 165, 78), // 泥金
  ink: rgb(232, 228, 220), // 正文
  soft: rgb(168, 162, 152), // 次要
  faint: rgb(118, 112, 104), // 最淡
  green: rgb(111, 174, 140),
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  italic: sgr(3, 23),
  underline: sgr(4, 24),
  strike: sgr(9, 29),
  inverse: sgr(7, 27),
};

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (t) => c.zhu(t),
  selectedText: (t) => c.bold(c.ink(t)),
  description: (t) => c.soft(t),
  scrollInfo: (t) => c.faint(t),
  noMatch: (t) => c.faint(t),
};

export const editorTheme: EditorTheme = {
  borderColor: (t) => c.faint(t),
  selectList: selectListTheme,
};

export const markdownTheme: MarkdownTheme = {
  heading: (t) => c.bold(c.ink(t)),
  link: (t) => c.underline(c.jin(t)),
  linkUrl: (t) => c.faint(t),
  code: (t) => c.jin(t),
  codeBlock: (t) => c.soft(t),
  codeBlockBorder: (t) => c.faint(t),
  quote: (t) => c.italic(c.soft(t)),
  quoteBorder: (t) => c.faint(t),
  hr: (t) => c.faint(t),
  listBullet: (t) => c.zhu(t),
  bold: (t) => c.bold(t),
  italic: (t) => c.italic(t),
  strikethrough: (t) => c.strike(t),
  underline: (t) => c.underline(t),
};
