// 终端样式:零依赖 ANSI。
//
// 调色板是莫兰迪调子,用 OKLCH 推导(2026-09-06),规则写在这里,值由规则算出:
//   底(只给预览用,真实底色是用户终端的)L .215 C .006 H 70,带灰的暖黑。
//   墨三阶 ink / soft / faint:L .90 / .75 / .61 等距,色度 ≤ .014 偏暖;faint 对底 4.6:1,对纯黑 5.1:1,过 WCAG AA。
//   两个强调色:朱(赭红 H 28,L .66 C .10)是刀,只给工具动作与错误;泥金(燕麦沙 H 80,L .76 C .065)只给品牌与"变化"。
//   朱比金重一档(不严格等明度):主强调色要有分量,严格等明度会发灰。
//   绿(豆绿 H 135,L .74 C .05)只给 diff 增行的前景;成功记号 ✓ 用墨色,静成功、响失败。
//   三处底色都从底推:底带 = 底 +.06 L;diff 增/删 = 底 +.10 L 带色相。
// 不画框,不用竖线;层次靠明暗,不靠颜色种类。
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "@earendil-works/pi-tui";

// FORCE_COLOR 强制开(离线预览/测试用);NO_COLOR 强制关;否则跟随是否为 TTY。
const enabled = process.env.FORCE_COLOR
  ? true
  : !process.env.NO_COLOR && process.stdout.isTTY !== false;

function rgb(r: number, g: number, b: number): (s: string) => string {
  return (s) => (enabled ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : s);
}
function sgr(open: number, close: number): (s: string) => string {
  return (s) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);
}
function bg(r: number, g: number, b: number): (s: string) => string {
  return (s) => (enabled ? `\x1b[48;2;${r};${g};${b}m${s}\x1b[49m` : s);
}

export const c = {
  zhu: rgb(200, 122, 112), // 朱:赭红 #c87a70
  jin: rgb(199, 173, 130), // 泥金:燕麦沙 #c7ad82
  ink: rgb(226, 221, 213), // 正文 #e2ddd5
  soft: rgb(179, 173, 164), // 次要 #b3ada4
  faint: rgb(136, 130, 122), // 最淡 #88827a
  green: rgb(158, 178, 147), // 豆绿 #9eb293,只给 diff 增行
  /** 朱印呼吸的四个相位:同色相,明度 .66 → .58 → .50 → .58,两秒一息。 */
  seal: [rgb(200, 122, 112), rgb(172, 103, 94), rgb(144, 84, 76), rgb(172, 103, 94)],
  // 底色只有三处:用户消息的底带,diff 的增删行。其余全靠前景明暗。
  band: bg(42, 39, 35),
  addBg: bg(40, 52, 38),
  delBg: bg(64, 42, 38),
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  italic: sgr(3, 23),
  underline: sgr(4, 24),
  strike: sgr(9, 29),
  inverse: sgr(7, 27),
};

/**
 * 记号表:一套笔画系,不混几何与装饰字符。
 * 你 › · 调用 » · 结果正文 └ · 成功 ✓(墨色)· 失败 ✗(朱)· 提示 · · 压缩 ≈(泥金)· 光标 ▸ · 引导 ┆ · 印 ▪
 */
export const G = {
  you: "›",
  call: "»",
  body: "└",
  ok: "✓",
  err: "✗",
  note: "·",
  compact: "≈",
  cursor: "▸",
  guide: "┆",
  seal: "▪",
  running: "●",
  idle: "○",
  ask: "?",
} as const;

export const selectListTheme: SelectListTheme = {
  selectedPrefix: (t) => c.ink(t),
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
  link: (t) => c.underline(c.ink(t)),
  linkUrl: (t) => c.faint(t),
  code: (t) => c.band(c.ink(t)),
  codeBlock: (t) => c.soft(t),
  codeBlockBorder: (t) => c.faint(t),
  quote: (t) => c.italic(c.soft(t)),
  quoteBorder: (t) => c.faint(t),
  hr: (t) => c.faint(t),
  listBullet: (t) => c.soft(t),
  bold: (t) => c.bold(t),
  italic: (t) => c.italic(t),
  strikethrough: (t) => c.strike(t),
  underline: (t) => c.underline(t),
};
