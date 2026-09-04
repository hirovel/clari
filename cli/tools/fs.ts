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
      "Read a text file. Returns numbered lines. When the output exceeds the limit, a truncation policy keeps part of it and notes the offset to continue from; " +
      "overlong lines are cut to a fixed character count.",
    parameters: Type.Object({
      path: Type.String({ description: "file path, relative or absolute" }),
      offset: Type.Optional(Type.Number({ description: "starting line number, 1-based" })),
      limit: Type.Optional(Type.Number({ description: "maximum number of lines to return" })),
    }),
    concurrency: "parallel",
    async execute(args) {
      const path = resolve(args.path);
      const st = statSync(path);
      if (st.isDirectory())
        throw new Error(`${args.path} is a directory; use ls or glob to list it.`);
      if (st.size > MAX_READ_BYTES) {
        throw new Error(
          `file is ${Math.round(st.size / 1024 / 1024)} MB, exceeds the single-read limit of ${MAX_READ_BYTES / 1024 / 1024} MB. Use bash head/sed/grep to take the part you need.`,
        );
      }
      if (st.size > 0 && looksBinary(path)) {
        throw new Error(
          `${args.path} is a binary file (${st.size} bytes); read only handles text.`,
        );
      }
      const lines = capLine(readFileSync(path, "utf8")).split("\n");
      const start = Math.max(1, args.offset ?? 1);
      const slice = lines.slice(start - 1, args.limit ? start - 1 + args.limit : undefined);
      const numbered = slice.map((l, i) => `${start + i}\t${l}`).join("\n");
      const t = truncate(numbered);
      if (!t.truncated) return t.text;
      const shown = t.text.split("\n").length;
      return `${t.text}\n[${t.note ?? "truncated"}; file has ${lines.length} lines, continue with offset=${start + shown}]`;
    },
  });
}

/** 默认实例:保头截断 —— 文件开头是结构所在。 */
export const readTool = createReadTool();

export const writeTool = defineTool({
  name: "write",
  description: "Write a text file, replacing its contents. Creates missing directories.",
  parameters: Type.Object({
    path: Type.String({ description: "file path" }),
    content: Type.String({ description: "complete file content" }),
  }),
  async execute(args) {
    const path = resolve(args.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, args.content, "utf8");
    return `wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${args.path}`;
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
  if (hits.length > 1) {
    throw new Error(`fuzzy match hit ${hits.length} places, not unique. Provide more context.`);
  }
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
    "Make one exact replacement in a file. oldText must occur exactly once in the file; otherwise the call fails and says why. " +
    "If the exact match fails, it retries ignoring trailing whitespace and quote style; a fuzzy hit is noted in the result.",
  parameters: Type.Object({
    path: Type.String({ description: "file path" }),
    oldText: Type.String({ description: "original text to replace; must be unique" }),
    newText: Type.String({ description: "replacement text" }),
  }),
  async execute(args) {
    const path = resolve(args.path);
    const raw = readFileSync(path, "utf8");
    // 换行风格:文件是 CRLF 时按 LF 匹配、按 CRLF 写回;模型给的原文里不必带 \r。
    const crlf = raw.includes("\r\n");
    const content = crlf ? raw.replaceAll("\r\n", "\n") : raw;
    const oldText = args.oldText.replaceAll("\r\n", "\n");
    const newText = args.newText.replaceAll("\r\n", "\n");
    if (!oldText) throw new Error("oldText must not be empty.");
    const count = content.split(oldText).length - 1;
    if (count > 1) {
      throw new Error(
        `oldText occurs ${count} times in ${args.path}, not unique. Provide more context.`,
      );
    }
    let next: string;
    let note = "";
    if (count === 1) {
      next = content.replace(oldText, () => newText);
    } else {
      const fuzzy = fuzzyReplace(content, oldText, newText);
      if (!fuzzy) {
        throw new Error(`oldText not found in ${args.path}; read the file first to confirm it.`);
      }
      next = fuzzy.next;
      note = ` (exact match failed; fuzzy match ignoring trailing whitespace and quote style hit line ${fuzzy.line})`;
    }
    if (next === content)
      throw new Error("replacement is identical to the original; nothing written.");
    writeFileSync(path, crlf ? next.replaceAll("\n", "\r\n") : next, "utf8");
    return `replaced one occurrence in ${args.path}.${note}`;
  },
});
