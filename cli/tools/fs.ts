// 文件三工具:read / write / edit。内核对它们一无所知(Q2),从 CLI 层注入。
// read 的截断策略可换(Q28):默认保头,自定义策略经 createReadTool 注入。
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { defineTool } from "../../src/tools.js";
import { capLineLength, keepHead, type TruncationPolicy } from "./truncate.js";

/** 单次整读的文件大小上限:再大就要求分段,不把整个文件拉进内存。 */
export const MAX_READ_BYTES = 20 * 1024 * 1024;

/** 头部采样里出现 NUL 即视为二进制;文本文件不会有它。 */
export function looksBinary(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

export function createReadTool(opts: { truncate?: TruncationPolicy; maxLineChars?: number } = {}) {
  // 保头+分页是全行业共识(Q29 调查:pi/Claude Code/opencode/Cline 现行版一致,保尾无一家)。
  const truncate = opts.truncate ?? keepHead();
  const capLine = capLineLength(opts.maxLineChars ?? 2000);
  return defineTool({
    name: "read",
    description:
      "读取文本文件。返回带行号的内容。超限时按截断策略保留一部分并注明续读 offset;" +
      "超长行截断到固定字符数。",
    parameters: Type.Object({
      path: Type.String({ description: "文件路径,相对或绝对" }),
      offset: Type.Optional(Type.Number({ description: "起始行号,从 1 开始" })),
      limit: Type.Optional(Type.Number({ description: "最多返回的行数" })),
    }),
    concurrency: "parallel",
    async execute(args) {
      const path = resolve(args.path);
      const st = statSync(path);
      if (st.isDirectory()) throw new Error(`${args.path} 是目录,用 ls 或 glob 列出内容。`);
      if (st.size > MAX_READ_BYTES) {
        throw new Error(
          `文件 ${Math.round(st.size / 1024 / 1024)} MB,超过单次读取上限 ${MAX_READ_BYTES / 1024 / 1024} MB。用 bash 的 head/sed/grep 取需要的部分。`,
        );
      }
      if (st.size > 0 && looksBinary(path)) {
        throw new Error(`${args.path} 是二进制文件(${st.size} 字节),read 只读文本。`);
      }
      const lines = capLine(readFileSync(path, "utf8")).split("\n");
      const start = Math.max(1, args.offset ?? 1);
      const slice = lines.slice(start - 1, args.limit ? start - 1 + args.limit : undefined);
      const numbered = slice.map((l, i) => `${start + i}\t${l}`).join("\n");
      const t = truncate(numbered);
      if (!t.truncated) return t.text;
      const shown = t.text.split("\n").length;
      return `${t.text}\n[${t.note ?? "已截断"};文件共 ${lines.length} 行,用 offset=${start + shown} 继续]`;
    },
  });
}

/** 默认实例:保头截断 —— 文件开头是结构所在。 */
export const readTool = createReadTool();

export const writeTool = defineTool({
  name: "write",
  description: "写入文本文件,整体覆盖。目录不存在时自动创建。",
  parameters: Type.Object({
    path: Type.String({ description: "文件路径" }),
    content: Type.String({ description: "完整的文件内容" }),
  }),
  async execute(args) {
    const path = resolve(args.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, args.content, "utf8");
    return `已写入 ${Buffer.byteLength(args.content, "utf8")} 字节到 ${args.path}`;
  },
});

/** 归一化一行用于宽松匹配:去行尾空白,弯引号与长破折号换成 ASCII,特殊空格换成普通空格。 */
export function normalizeLine(line: string): string {
  return line
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/[  -​  　]/g, " ")
    .replace(/\s+$/, "");
}

/**
 * 精确匹配失败后的宽松匹配:按行归一化后找唯一的连续行窗口。命中时只替换这几行,
 * 文件其余部分一字不动。返回 undefined = 也没匹配到;抛错 = 匹配到多处。
 */
export function fuzzyReplace(
  content: string,
  oldText: string,
  newText: string,
): { next: string; line: number } | undefined {
  const lines = content.split("\n");
  const target = oldText.split("\n").map(normalizeLine);
  // 去掉 oldText 首尾的空行,模型常多带一行。
  while (target.length > 0 && target[0] === "") target.shift();
  while (target.length > 0 && target.at(-1) === "") target.pop();
  if (target.length === 0) return undefined;
  const norm = lines.map(normalizeLine);
  const hits: number[] = [];
  for (let i = 0; i + target.length <= norm.length; i++) {
    let ok = true;
    for (let k = 0; k < target.length; k++) {
      if (norm[i + k] !== target[k]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  if (hits.length === 0) return undefined;
  if (hits.length > 1) throw new Error(`宽松匹配到 ${hits.length} 处,不唯一。请提供更长的上下文。`);
  const at = hits[0] as number;
  const replacement = newText.split("\n");
  const next = [...lines.slice(0, at), ...replacement, ...lines.slice(at + target.length)].join(
    "\n",
  );
  return { next, line: at + 1 };
}

export const editTool = defineTool({
  name: "edit",
  description:
    "对文件做一处精确替换。oldText 必须在文件中出现且仅出现一次,否则报错并说明原因。" +
    "精确匹配失败时会忽略行尾空白与引号样式再试一次,命中会在结果里说明。",
  parameters: Type.Object({
    path: Type.String({ description: "文件路径" }),
    oldText: Type.String({ description: "要被替换的原文,必须唯一" }),
    newText: Type.String({ description: "替换后的文本" }),
  }),
  async execute(args) {
    const path = resolve(args.path);
    const raw = readFileSync(path, "utf8");
    // 换行风格:文件是 CRLF 时按 LF 匹配、按 CRLF 写回;模型给的原文里不必带 \r。
    const crlf = raw.includes("\r\n");
    const content = crlf ? raw.replaceAll("\r\n", "\n") : raw;
    const oldText = args.oldText.replaceAll("\r\n", "\n");
    const newText = args.newText.replaceAll("\r\n", "\n");
    if (!oldText) throw new Error("oldText 不能为空。");
    const count = content.split(oldText).length - 1;
    if (count > 1) {
      throw new Error(`oldText 在 ${args.path} 中出现 ${count} 次,不唯一。请提供更长的上下文。`);
    }
    let next: string;
    let note = "";
    if (count === 1) {
      next = content.replace(oldText, () => newText);
    } else {
      const fuzzy = fuzzyReplace(content, oldText, newText);
      if (!fuzzy) throw new Error(`oldText 在 ${args.path} 中不存在,请先 read 确认原文。`);
      next = fuzzy.next;
      note = `(精确匹配失败,按忽略行尾空白与引号样式的宽松匹配命中第 ${fuzzy.line} 行)`;
    }
    if (next === content) throw new Error("替换后内容与原文相同,未写入。");
    writeFileSync(path, crlf ? next.replaceAll("\n", "\r\n") : next, "utf8");
    return `已替换 ${args.path} 中的一处文本。${note}`;
  },
});
