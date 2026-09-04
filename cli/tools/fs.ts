// 文件三工具:read / write / edit。内核对它们一无所知(Q2),从 CLI 层注入。
// read 的截断策略可换(Q28):默认保头,自定义策略经 createReadTool 注入。
// read 传目录即列举(Q88):目录列举工具在各家退场,并进 read 省一个工具名。
// 描述文案的写法(Q88):每条说清输出形状、硬限制、失败原因与该换哪个工具;不写行为以外的话。
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
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
      "Read a text file as numbered lines, or list a directory (one entry per line; directories end with /, files show their size). " +
      "Output past the limit is truncated and the note gives the offset to continue from; overlong lines are cut. " +
      "Use offset and limit to read only the part you need, and read several files in one turn when you know which ones. " +
      "Text only: binary files and images are refused.",
    parameters: Type.Object({
      path: Type.String({ description: "file or directory path, relative or absolute" }),
      offset: Type.Optional(Type.Number({ description: "starting line number, 1-based" })),
      limit: Type.Optional(Type.Number({ description: "maximum number of lines to return" })),
    }),
    concurrency: "parallel",
    async execute(args) {
      const path = resolve(args.path);
      const st = statSync(path);
      if (st.isDirectory()) return listDirectory(path);
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

/** 目录列举:目录在前并以 / 结尾,文件带字节数;空目录说明。 */
export function listDirectory(dir: string): string {
  const entries = readdirSync(dir)
    .map((name) => {
      const st = statSync(join(dir, name));
      return { name, dir: st.isDirectory(), size: st.size };
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  if (entries.length === 0) return "(empty directory)";
  return entries.map((e) => (e.dir ? `${e.name}/` : `${e.name}  ${e.size} B`)).join("\n");
}

/** 默认实例:保头截断 —— 文件开头是结构所在。 */
export const readTool = createReadTool();

export const writeTool = defineTool({
  name: "write",
  description:
    "Write a text file, replacing its contents; creates missing directories. " +
    "For a change inside an existing file use edit; write is for new files and full rewrites.",
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
    "Replace text in a file. oldText must match the file exactly, indentation included, and occur exactly once; " +
    "keep it as short as it can be while still unique. Set replaceAll to change every occurrence, e.g. for a rename. " +
    "When the exact match fails, one retry ignores trailing whitespace and quote style and the result says so. " +
    "No match or several matches fail with the reason.",
  parameters: Type.Object({
    path: Type.String({ description: "file path" }),
    oldText: Type.String({ description: "text to replace; must be unique unless replaceAll" }),
    newText: Type.String({ description: "replacement text" }),
    replaceAll: Type.Optional(Type.Boolean({ description: "replace every occurrence" })),
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
    if (args.replaceAll && count > 0) {
      const all = content.replaceAll(oldText, () => newText);
      if (all === content)
        throw new Error("replacement is identical to the original; nothing written.");
      writeFileSync(path, crlf ? all.replaceAll("\n", "\r\n") : all, "utf8");
      return `replaced ${count} occurrences in ${args.path}.`;
    }
    if (count > 1) {
      throw new Error(
        `oldText occurs ${count} times in ${args.path}, not unique. Provide more context, or set replaceAll to change every occurrence.`,
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
