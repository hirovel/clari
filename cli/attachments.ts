// @文件引用:输入里 @路径 指向存在的文本文件时,把文件内容附在消息后面。
// 附上的内容就是用户消息的一部分:落盘、上屏、检视器里都完整可见,没有隐藏的注入。
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

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
    if (attachments.some((a) => a.path === path && !a.skipped)) continue;
    let size: number | undefined;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      size = stat.size;
      if (size > ATTACH_MAX_BYTES) {
        attachments.push({
          ref,
          path,
          bytes: size,
          skipped: `exceeds ${ATTACH_MAX_BYTES} bytes, not attached`,
        });
        continue;
      }
      // 同一份字节用于检查和正文,避免重复打开文件。
      const bytes = readFileSync(path);
      size = bytes.length;
      if (size > ATTACH_MAX_BYTES) {
        attachments.push({
          ref,
          path,
          bytes: size,
          skipped: `exceeds ${ATTACH_MAX_BYTES} bytes, not attached`,
        });
        continue;
      }
      if (bytes.subarray(0, 8192).includes(0)) {
        attachments.push({ ref, path, bytes: size, skipped: "binary file, not attached" });
        continue;
      }
      attachments.push({ ref, path, bytes: size });
      blocks.push(`<file name="${ref}">\n${bytes.toString("utf8")}\n</file>`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (size === undefined && (code === "ENOENT" || code === "ENOTDIR")) continue;
      attachments.push({
        ref,
        path,
        bytes: size ?? 0,
        skipped: `${(error as Error).message}; not attached`,
      });
    }
  }
  return {
    text: blocks.length > 0 ? `${text}\n\n${blocks.join("\n\n")}` : text,
    attachments,
  };
}
