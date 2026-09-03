// @文件引用:输入里 @路径 指向存在的文本文件时,把文件内容附在消息后面。
// 附上的内容就是用户消息的一部分:落盘、上屏、检视器里都完整可见,没有隐藏的注入。
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { looksBinary } from "./tools/fs.js";

export const ATTACH_MAX_BYTES = 50 * 1024;

export type Attachment = { ref: string; path: string; bytes: number; skipped?: string };

/** 找出文本里的 @引用并读取;返回展开后的文本与每个引用的处理结果。 */
export function expandFileRefs(
  text: string,
  cwd = process.cwd(),
): { text: string; attachments: Attachment[] } {
  const attachments: Attachment[] = [];
  const blocks: string[] = [];
  const re = /(^|\s)@([^\s@"'`<>]+)/g;
  for (const m of text.matchAll(re)) {
    const ref = m[2] as string;
    const path = resolve(cwd, ref);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const size = statSync(path).size;
    if (size > ATTACH_MAX_BYTES) {
      attachments.push({ ref, path, bytes: size, skipped: `超过 ${ATTACH_MAX_BYTES} 字节,未附上` });
      continue;
    }
    if (size > 0 && looksBinary(path)) {
      attachments.push({ ref, path, bytes: size, skipped: "二进制文件,未附上" });
      continue;
    }
    if (attachments.some((a) => a.path === path && !a.skipped)) continue;
    attachments.push({ ref, path, bytes: size });
    blocks.push(`<file name="${ref}">\n${readFileSync(path, "utf8")}\n</file>`);
  }
  return {
    text: blocks.length > 0 ? `${text}\n\n${blocks.join("\n\n")}` : text,
    attachments,
  };
}
