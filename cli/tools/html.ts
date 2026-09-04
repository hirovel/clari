// HTML → 可读文本(Q86):fetch 工具的缺省转换器。只做字符串扫描,不建 DOM,零依赖。
// 取 <main> / <article>(没有就 <body>),去掉 script / style / nav / header / footer / aside,
// 标题、段落、列表、链接、代码块、简单表格各保留一种 markdown 形态,实体解码,空白折叠。
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

/** HTML → 文本。 */
export function htmlToText(html: string, url = ""): string {
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  s = removeBlocks(s, ["script", "style", "noscript", "svg", "template", "iframe"]);
  const title = inner(s, "title")?.trim();
  const main = inner(s, "main") ?? inner(s, "article");
  s = main ?? removeBlocks(inner(s, "body") ?? s, ["nav", "header", "footer", "aside"]);

  // 代码块先摘出来:里面的空白与尖括号都要原样保留。
  const pres: string[] = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, body: string) => {
    pres.push(decodeEntities(stripTags(body)).replace(/^\n+|\n+$/g, ""));
    // 占位符用私用区字符包起来,正文里不会撞上。
    return `PRE${pres.length - 1}`;
  });

  s = s
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<\/tr\s*>/gi, " |\n")
    .replace(/<(?:p|div|section|blockquote|ul|ol|table|tr|figure|dl|dt|dd)\b[^>]*>/gi, "\n")
    .replace(/<\/(?:p|div|section|blockquote|ul|ol|table|tr|figure|dl|dt|dd)\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li\s*>/gi, "")
    .replace(/<(?:td|th)\b[^>]*>/gi, " | ")
    .replace(/<\/(?:td|th)\s*>/gi, "")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_, body: string) => `\`${stripTags(body)}\``)
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
  // 空白折叠:行内多空格并一,行首尾空白去掉,三个以上换行并成两个。
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  s = s.replace(/PRE(\d+)/g, (_, i: string) => `\n\`\`\`\n${pres[Number(i)] ?? ""}\n\`\`\`\n`);
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return title ? `title: ${decodeEntities(title)}\n\n${s}` : s;
}
