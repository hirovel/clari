// 只读三工具(Q56):grep / glob / ls。内核不知道它们,从 CLI 层注入。
// 立场取自 pi:模型在这些工具名上被训练过,给工具即给"先搜后读"的引导,不必写提示词规则。
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Type } from "@sinclair/typebox";
import { defineTool } from "../../src/tools.js";
import { capLineLength } from "./truncate.js";

/** 遍历时跳过的目录:与各家一致,不进版本库或不属于源码的东西。 */
export const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".preview", "sessions"]);

/** 递归列出 root 下的文件(相对路径,正斜杠)。 */
export function walkFiles(root: string, opts: { maxFiles?: number } = {}): string[] {
  const out: string[] = [];
  const max = opts.maxFiles ?? 20000;
  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (out.length >= max) return;
      const full = join(dir, name);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) visit(full);
      } else if (st.isFile()) {
        out.push(relative(root, full).split(sep).join("/"));
      }
    }
  };
  visit(root);
  return out;
}

/** glob → 正则:** 匹配任意层级,* 匹配单段内任意字符,? 匹配单字符。 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") i++;
        re += "(?:.*/)?";
      } else re += "[^/]*";
    } else if (ch === "?") re += "[^/]";
    else if (/[.+^${}()|[\]\\]/.test(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(`^${re}$`);
}

export type GrepMatch = { file: string; line: number; text: string };

/** JS 实现的逐文件正则搜索;rg 不在时的回退。 */
export function grepFiles(
  root: string,
  pattern: RegExp,
  opts: { glob?: string; maxResults?: number } = {},
): { matches: GrepMatch[]; truncated: boolean; scanned: number } {
  const max = opts.maxResults ?? 200;
  const filter = opts.glob ? globToRegExp(opts.glob) : undefined;
  const matches: GrepMatch[] = [];
  let scanned = 0;
  const rootStat = statSync(root);
  const files = rootStat.isFile() ? [""] : walkFiles(root);
  for (const rel of files) {
    const full = rel ? join(root, rel) : root;
    if (filter && rel && !filter.test(rel) && !filter.test(rel.split("/").at(-1) ?? "")) continue;
    let content: string;
    try {
      content = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (content.includes("\0")) continue; // 含 NUL 视为二进制,不搜
    scanned++;
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] as string;
      pattern.lastIndex = 0;
      if (pattern.test(l)) {
        matches.push({ file: rel || root, line: i + 1, text: l });
        if (matches.length >= max) return { matches, truncated: true, scanned };
      }
    }
  }
  return { matches, truncated: false, scanned };
}

const capLine = capLineLength(500);

export function createGrepTool(opts: { useRipgrep?: boolean; maxResults?: number } = {}) {
  const maxResults = opts.maxResults ?? 200;
  return defineTool({
    name: "grep",
    description:
      "在目录或文件里按正则搜索,返回 路径:行号:内容。用它定位再用 read 读上下文。" +
      "结果最多 200 条,单行截到 500 字符。",
    parameters: Type.Object({
      pattern: Type.String({ description: "正则表达式(JS 语法)" }),
      path: Type.Optional(Type.String({ description: "搜索的目录或文件,缺省当前目录" })),
      glob: Type.Optional(Type.String({ description: "只搜匹配的文件名,如 *.ts 或 src/**/*.ts" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "忽略大小写" })),
    }),
    concurrency: "parallel",
    async execute(args) {
      const root = resolve(args.path ?? ".");
      const rootIsFile = statSync(root).isFile();
      // 给模型的路径 = 用户给的 path + 相对于它的文件路径,原样可再喂给 read;path 缺省或为 . 时不加前缀。
      const given = (args.path ?? ".").split(sep).join("/").replace(/\/+$/, "");
      const base = rootIsFile ? "" : given === "." || given === "" ? "" : given;
      const withBase = (file: string) => (base ? `${base}/${file}` : file);
      const useRg = opts.useRipgrep ?? true;
      if (useRg) {
        // 以搜索根为 cwd,rg 输出的路径天然相对于它。
        const rg = spawnSync(
          "rg",
          [
            "--line-number",
            "--no-heading",
            "--color",
            "never",
            "--max-count",
            String(maxResults),
            ...(args.ignoreCase ? ["-i"] : []),
            ...(args.glob ? ["-g", args.glob] : []),
            "-e",
            args.pattern,
            ...(rootIsFile ? [basename(root)] : []),
          ],
          { cwd: rootIsFile ? dirname(root) : root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
        );
        if (!rg.error) {
          if (rg.status === 1) return "(无匹配)";
          if (rg.status === 0) {
            const lines = rg.stdout
              .trimEnd()
              .split(/\r?\n/)
              .map((l) => {
                const file = l.split(":")[0] ?? "";
                const rel = rootIsFile ? given : file.split(sep).join("/");
                return withBase(rel) + l.slice(file.length);
              });
            const shown = lines.slice(0, maxResults);
            const tail =
              lines.length > maxResults
                ? `\n[只显示前 ${maxResults} 条,共 ${lines.length}+ 条,请缩小范围]`
                : "";
            return capLine(shown.join("\n")) + tail;
          }
          // 其它状态码(正则错误等)落到 JS 实现,拿到一致的报错文案。
        }
      }
      const re = new RegExp(args.pattern, args.ignoreCase ? "i" : "");
      const r = grepFiles(root, re, {
        ...(args.glob && { glob: args.glob }),
        maxResults,
      });
      if (r.matches.length === 0) return `(无匹配;扫描 ${r.scanned} 个文件)`;
      const body = r.matches
        .map((m) => `${rootIsFile ? given : withBase(m.file)}:${m.line}:${m.text}`)
        .join("\n");
      return (
        capLine(body) + (r.truncated ? `\n[只显示前 ${maxResults} 条,还有更多,请缩小范围]` : "")
      );
    },
  });
}

export const grepTool = createGrepTool();

export const globTool = defineTool({
  name: "glob",
  description: "按通配模式列出文件,如 src/**/*.ts。返回相对路径,最多 500 条。",
  parameters: Type.Object({
    pattern: Type.String({ description: "通配模式:** 任意层级,* 单段,? 单字符" }),
    path: Type.Optional(Type.String({ description: "起始目录,缺省当前目录" })),
  }),
  concurrency: "parallel",
  async execute(args) {
    const root = resolve(args.path ?? ".");
    const re = globToRegExp(args.pattern);
    const all = walkFiles(root).filter((f) => re.test(f));
    if (all.length === 0) return "(无匹配)";
    const shown = all.slice(0, 500);
    return shown.join("\n") + (all.length > 500 ? `\n[只显示前 500 条,共 ${all.length} 条]` : "");
  },
});

export const lsTool = defineTool({
  name: "ls",
  description: "列出目录内容:目录带 /,文件带大小。",
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "目录,缺省当前目录" })),
  }),
  concurrency: "parallel",
  async execute(args) {
    const dir = resolve(args.path ?? ".");
    const entries = readdirSync(dir)
      .map((name) => {
        const st = statSync(join(dir, name));
        return { name, dir: st.isDirectory(), size: st.size };
      })
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    if (entries.length === 0) return "(空目录)";
    return entries.map((e) => (e.dir ? `${e.name}/` : `${e.name}  ${e.size} B`)).join("\n");
  },
});
