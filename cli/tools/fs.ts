// 文件三工具:read / write / edit。内核对它们一无所知(Q2),从 CLI 层注入。
// read 的截断策略可换(Q28):默认保头,自定义策略经 createReadTool 注入。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { defineTool } from "../../src/tools.js";
import { keepHead, type TruncationPolicy } from "./truncate.js";

export function createReadTool(opts: { truncate?: TruncationPolicy } = {}) {
  const truncate = opts.truncate ?? keepHead();
  return defineTool({
    name: "read",
    description:
      "读取文本文件。返回带行号的内容。超限时按截断策略保留一部分并注明,可用 offset/limit 分段读取。",
    parameters: Type.Object({
      path: Type.String({ description: "文件路径,相对或绝对" }),
      offset: Type.Optional(Type.Number({ description: "起始行号,从 1 开始" })),
      limit: Type.Optional(Type.Number({ description: "最多返回的行数" })),
    }),
    async execute(args) {
      const lines = readFileSync(resolve(args.path), "utf8").split("\n");
      const start = Math.max(1, args.offset ?? 1);
      const slice = lines.slice(start - 1, args.limit ? start - 1 + args.limit : undefined);
      const numbered = slice.map((l, i) => `${start + i}\t${l}`).join("\n");
      const t = truncate(numbered);
      if (!t.truncated) return t.text;
      return `${t.text}\n[${t.note ?? "已截断"};文件共 ${lines.length} 行,用 offset/limit 分段读取其余部分]`;
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

export const editTool = defineTool({
  name: "edit",
  description: "对文件做一处精确替换。oldText 必须在文件中出现且仅出现一次,否则报错并说明原因。",
  parameters: Type.Object({
    path: Type.String({ description: "文件路径" }),
    oldText: Type.String({ description: "要被替换的原文,必须唯一" }),
    newText: Type.String({ description: "替换后的文本" }),
  }),
  async execute(args) {
    const path = resolve(args.path);
    const content = readFileSync(path, "utf8");
    const count = content.split(args.oldText).length - 1;
    if (count === 0) throw new Error(`oldText 在 ${args.path} 中不存在,请先 read 确认原文。`);
    if (count > 1) {
      throw new Error(`oldText 在 ${args.path} 中出现 ${count} 次,不唯一。请提供更长的上下文。`);
    }
    writeFileSync(path, content.replace(args.oldText, args.newText), "utf8");
    return `已替换 ${args.path} 中的一处文本。`;
  },
});
