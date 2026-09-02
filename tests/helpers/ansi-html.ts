// 把带 ANSI SGR 的终端行转成 HTML,用于在浏览器里预览 TUI 观感。只支持本项目用到的序列。
type Style = {
  fg: string | undefined;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  inverse: boolean;
};

const fresh = (): Style => ({
  fg: undefined,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  strike: false,
  inverse: false,
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function css(st: Style): string {
  const parts: string[] = [];
  if (st.fg) parts.push(`color:${st.fg}`);
  if (st.bold) parts.push("font-weight:700");
  if (st.dim) parts.push("opacity:.6");
  if (st.italic) parts.push("font-style:italic");
  if (st.underline) parts.push("text-decoration:underline");
  if (st.strike) parts.push("text-decoration:line-through");
  if (st.inverse) parts.push("background:#e8e4dc;color:#16150f");
  return parts.join(";");
}

export function ansiLineToHtml(line: string): string {
  let st = fresh();
  let out = "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 终端控制序列
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b_[^\x07]*\x07|\x1b\][^\x07]*\x07/g;
  let last = 0;
  for (const m of line.matchAll(re)) {
    const text = line.slice(last, m.index);
    if (text) out += `<span style="${css(st)}">${escapeHtml(text)}</span>`;
    last = (m.index ?? 0) + m[0].length;
    if (m[1] === undefined) continue; // 非 SGR 序列,忽略
    const codes = m[1] === "" ? [0] : m[1].split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) st = fresh();
      else if (code === 1) st.bold = true;
      else if (code === 2) st.dim = true;
      else if (code === 3) st.italic = true;
      else if (code === 4) st.underline = true;
      else if (code === 7) st.inverse = true;
      else if (code === 9) st.strike = true;
      else if (code === 22) {
        st.bold = false;
        st.dim = false;
      } else if (code === 23) st.italic = false;
      else if (code === 24) st.underline = false;
      else if (code === 27) st.inverse = false;
      else if (code === 29) st.strike = false;
      else if (code === 39) st.fg = undefined;
      else if (code === 38 && codes[i + 1] === 2) {
        st.fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      }
    }
  }
  const tail = line.slice(last);
  if (tail) out += `<span style="${css(st)}">${escapeHtml(tail)}</span>`;
  return out || "&nbsp;";
}

export function ansiToHtmlDocument(lines: string[], title = "TUI 预览"): string {
  const body = lines.map((l) => `<div class="l">${ansiLineToHtml(l)}</div>`).join("\n");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{margin:0;background:#16150f;color:#e8e4dc;font:15px/1.45 "Cascadia Code",Consolas,"Sarasa Mono SC",monospace;padding:24px}
.l{white-space:pre;min-height:1.45em}
</style></head><body>${body}</body></html>`;
}
