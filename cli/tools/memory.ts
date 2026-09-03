// 跨会话记忆(Q65):载体是通用标准 AGENTS.md 里一个由工具写入的节,别的工具也能读。
// 写入只走显式 remember 工具;读取在会话开始随项目指令进系统提示词(--memory 打开时);
// 预算硬上限,超限报错不静默截断。没有隐藏目录,没有向量库。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "@sinclair/typebox";
import { defineTool } from "../../src/tools.js";

export const MEMORY_HEADING = "## 记忆(agent 写入)";
export const MEMORY_MAX_LINES = 200;
export const MEMORY_MAX_BYTES = 8 * 1024;
export const MEMORY_KINDS = ["偏好", "纠正", "项目事实", "参考"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** 把文件拆成"人写的部分"与"记忆节正文"(不含标题)。记忆节从标题起到下一个二级标题或文件尾。 */
export function splitMemory(content: string): { rest: string; memory: string | undefined } {
  const lines = content.split("\n");
  const start = lines.findIndex((l) => l.trim() === MEMORY_HEADING);
  if (start < 0) return { rest: content, memory: undefined };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const memory = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  const rest = [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim();
  return { rest, memory: memory || undefined };
}

/** 记忆条目:记忆节里以 "- " 开头的行。 */
export function memoryEntries(content: string): string[] {
  const { memory } = splitMemory(content);
  if (!memory) return [];
  return memory
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
}

function readOrEmpty(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function writeWithMemory(file: string, rest: string, entries: string[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const block =
    entries.length > 0 ? `${MEMORY_HEADING}\n${entries.map((e) => `- ${e}`).join("\n")}\n` : "";
  const head = rest.trim();
  writeFileSync(file, `${head ? `${head}\n\n` : ""}${block}`, "utf8");
}

/** 追加一条记忆;超预算就抛错,由调用方(模型)先精简。 */
export function appendMemory(
  file: string,
  kind: MemoryKind,
  text: string,
  now = new Date(),
): { entries: number } {
  const oneLine = text.replace(/\s*\n\s*/g, " ").trim();
  if (!oneLine) throw new Error("记忆内容为空");
  const { rest } = splitMemory(readOrEmpty(file));
  const entries = memoryEntries(readOrEmpty(file));
  const next = [...entries, `[${kind}] ${now.toISOString().slice(0, 10)} ${oneLine}`];
  const bytes = Buffer.byteLength(next.join("\n"), "utf8");
  if (next.length > MEMORY_MAX_LINES || bytes > MEMORY_MAX_BYTES) {
    throw new Error(
      `记忆已达上限(${MEMORY_MAX_LINES} 条 / ${MEMORY_MAX_BYTES} 字节),先用 /memory forget 精简再记。当前 ${entries.length} 条。`,
    );
  }
  writeWithMemory(file, rest, next);
  return { entries: next.length };
}

/** 删除第 n 条(从 1 起),返回被删的内容。 */
export function forgetMemory(file: string, n: number): string {
  const content = readOrEmpty(file);
  const entries = memoryEntries(content);
  const target = entries[n - 1];
  if (target === undefined) throw new Error(`没有第 ${n} 条记忆(共 ${entries.length} 条)`);
  writeWithMemory(
    file,
    splitMemory(content).rest,
    entries.filter((_, i) => i !== n - 1),
  );
  return target;
}

export function clearMemory(file: string): number {
  const content = readOrEmpty(file);
  const count = memoryEntries(content).length;
  if (count > 0) writeWithMemory(file, splitMemory(content).rest, []);
  return count;
}

export type MemoryFiles = {
  /** 项目级:git 根(或 cwd)下的 AGENTS.md。 */
  project?: string;
  /** 用户级:~/.agent-kernel/AGENTS.md。 */
  user: string;
};

export function createRememberTool(files: MemoryFiles) {
  const scopes = files.project ? (["project", "user"] as const) : (["user"] as const);
  return defineTool({
    name: "remember",
    description:
      "把一条值得跨会话记住的事写进 AGENTS.md 的记忆节(下次会话开始时随项目指令读入)。" +
      "只记从代码推导不出、且用户会希望你下次仍记得的:用户偏好、被纠正过的做法、项目事实、参考链接。" +
      `一行一条,不记对话过程。上限 ${MEMORY_MAX_LINES} 条。`,
    parameters: Type.Object({
      text: Type.String({ description: "一句话,单行" }),
      kind: Type.Union(
        MEMORY_KINDS.map((k) => Type.Literal(k)),
        { description: "偏好 | 纠正 | 项目事实 | 参考" },
      ),
      scope: Type.Optional(
        Type.Union(
          scopes.map((s) => Type.Literal(s)),
          { description: "project = 本项目的 AGENTS.md(缺省);user = 跨项目的用户级文件" },
        ),
      ),
    }),
    async execute(args) {
      const scope = args.scope ?? (files.project ? "project" : "user");
      const file = scope === "project" && files.project ? files.project : files.user;
      const r = appendMemory(file, args.kind, args.text);
      return `已记入 ${file}(第 ${r.entries} 条),下次会话开始生效。`;
    },
  });
}
