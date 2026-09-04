// HTML → 可读 markdown(Q86):fetch 工具的缺省转换器。只做字符串扫描,不建 DOM,零依赖。
// 取 <main> / <article>(没有就 <body>),去掉 script / style / nav / header / footer / aside,
// 标题、段落、嵌套列表、链接、粗斜体、行内代码、带语言的代码块、带分隔行的表格、实体解码、空白折叠。
// 没有正文评分:新闻站与论坛页会带上导航与评论;要 Readability 品质的用 fetch.convert 槽换。

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  middot: "·",
  bull: "•",
  times: "×",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[body.toLowerCase()] ?? m;
  });
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

function removeBlocks(html: string, tags: string[]): string {
  let out = html;
  for (const t of tags) {
    out = out.replace(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*?<\\/${t}\\s*>`, "gi"), "");
  }
  return out;
}

/** 取一对标签之间的内容(第一处)。 */
function inner(html: string, tag: string): string | undefined {
  const m = html.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "i"));
  return m?.[1];
}

function absolute(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** 私用区占位符:摘出来的块先存起来,最后放回,正文里不会撞上。 */
const HOLD = "";
const hold = (i: number) => `${HOLD}${i}${HOLD}`;

/** 粗斜体与行内代码。先于 stripTags,所以标记留在文本里。 */
function inlineMarks(s: string): string {
  return s
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, body: string) => {
      const t = stripTags(body);
      return t.trim() ? `\`${t}\`` : "";
    })
    .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)\s*>/gi, (_, body: string) => {
      const t = body.trim();
      return t ? `**${t}**` : "";
    })
    .replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)\s*>/gi, (_, body: string) => {
      const t = body.trim();
      return t ? `*${t}*` : "";
    });
}

/** 单元格里的行内内容:去标签、解实体、折空白、竖线转义。 */
function cellText(s: string): string {
  return decodeEntities(stripTags(inlineMarks(s)))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\|/g, "\\|");
}

/** <table> → markdown 表格:第一行之后补分隔行(markdown 要求有表头行)。 */
function tableToMarkdown(table: string): string {
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((m) => m[1] as string);
  const lines: string[] = [];
  let sep = false;
  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)].map((m) =>
      cellText(m[1] as string),
    );
    if (cells.length === 0) continue;
    lines.push(`| ${cells.join(" | ")} |`);
    if (!sep) {
      lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
      sep = true;
    }
  }
  return lines.join("\n");
}

/** 嵌套列表:按 ul/ol 深度缩进,ol 用数字。 */
function listsToMarkdown(s: string): string {
  const stack: { ordered: boolean; n: number }[] = [];
  return s.replace(/<(\/?)(ul|ol|li)\b[^>]*>/gi, (_, close: string, tag: string) => {
    const t = tag.toLowerCase();
    if (t === "ul" || t === "ol") {
      if (close) {
        stack.pop();
        return stack.length === 0 ? "\n" : "";
      }
      stack.push({ ordered: t === "ol", n: 0 });
      return stack.length === 1 ? "\n" : "";
    }
    if (close) return "";
    const top = stack[stack.length - 1] ?? { ordered: false, n: 0 };
    top.n += 1;
    const indent = "  ".repeat(Math.max(0, stack.length - 1));
    return `\n${indent}${top.ordered ? `${top.n}. ` : "- "}`;
  });
}

/** HTML → markdown 文本。 */
export function htmlToText(html: string, url = ""): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  s = removeBlocks(s, ["script", "style", "noscript", "svg", "template", "iframe"]);
  const title = inner(s, "title")?.trim();
  const main = inner(s, "main") ?? inner(s, "article");
  s = main ?? removeBlocks(inner(s, "body") ?? s, ["nav", "header", "footer", "aside"]);

  const held: string[] = [];
  // 代码块先摘出来:里面的空白与尖括号都要原样保留;<code class="language-x"> 的语言写进围栏。
  s = s.replace(
    /<pre\b[^>]*>\s*(?:<code\b([^>]*)>)?([\s\S]*?)(?:<\/code\s*>)?\s*<\/pre\s*>/gi,
    (_, attrs: string | undefined, body: string) => {
      const lang = attrs?.match(/(?:language|lang)-([\w+-]+)/i)?.[1] ?? "";
      const code = decodeEntities(stripTags(body)).replace(/^\n+|\n+$/g, "");
      held.push(`\n\`\`\`${lang}\n${code}\n\`\`\`\n`);
      return hold(held.length - 1);
    },
  );
  // 表格整块转换。
  s = s.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, (t) => {
    held.push(`\n${tableToMarkdown(t)}\n`);
    return hold(held.length - 1);
  });

  s = listsToMarkdown(s);
  s = inlineMarks(s)
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<(?:p|div|section|blockquote|figure|dl|dt|dd)\b[^>]*>/gi, "\n")
    .replace(/<\/(?:p|div|section|blockquote|figure|dl|dt|dd)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    .replace(
      /<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi,
      (_, href: string, body: string) => {
        const text = stripTags(body).replace(/\s+/g, " ").trim();
        if (!text) return "";
        const abs = absolute(href, url);
        return abs.startsWith("javascript:") || abs === text ? text : `[${text}](${abs})`;
      },
    )
    .replace(/<img\b[^>]*alt\s*=\s*["']([^"']*)["'][^>]*>/gi, (_, alt: string) =>
      alt.trim() ? `[image: ${alt.trim()}]` : "",
    )
    .replace(/<img\b[^>]*>/gi, "");

  s = decodeEntities(stripTags(s));
  // 空白折叠:行尾空白去掉,行内多空格并一;列表行保留前导缩进。
  s = s
    .split("\n")
    .map((l) => {
      const m = l.match(/^([ \t ]*)(.*)$/);
      const lead = m?.[1] ?? "";
      const rest = (m?.[2] ?? "").replace(/[ \t ]+/g, " ").trim();
      const isList = /^(?:- |\d+\. )/.test(rest);
      return isList ? `${" ".repeat(Math.floor(lead.length / 2) * 2)}${rest}` : rest;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  s = s.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, "g"), (_, i: string) => held[Number(i)] ?? "");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return title ? `title: ${decodeEntities(title)}\n\n${s}` : s;
}
