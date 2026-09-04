// 提示词模板:一个 .md 文件就是一条斜杠命令。用户级在 ~/.clari/prompts,项目级在 <git 根>/.clari/prompts。
// 正文里 $ARGUMENTS / $@ 是全部参数,$1..$9 是按空格切分的第 n 个;可选 frontmatter 只认 description。
// 展开结果作为普通用户消息进日志,与手打的一样落盘、上屏。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { clariHome } from "../src/config.js";
import { findGitRoot } from "./prompt.js";

export type PromptTemplate = {
  name: string;
  description: string;
  body: string;
  path: string;
};

export function parseTemplate(path: string, raw: string): PromptTemplate {
  const name = basename(path).replace(/\.md$/i, "");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  let description = "";
  let body = raw;
  if (m) {
    body = raw.slice(m[0].length);
    const d = m[1]?.match(/^description:\s*(.+)$/m);
    if (d?.[1]) description = d[1].trim();
  }
  return { name, description: description || `模板 ${name}`, body: body.trim(), path };
}

/** 发现顺序:用户级 → 项目级;同名以项目级为准。 */
export function discoverTemplates(cwd = process.cwd(), home = clariHome()): PromptTemplate[] {
  const dirs = [join(home, "prompts")];
  const root = findGitRoot(cwd) ?? cwd;
  dirs.push(join(root, ".clari", "prompts"));
  const byName = new Map<string, PromptTemplate>();
  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!/\.md$/i.test(f)) continue;
      const p = join(dir, f);
      if (!statSync(p).isFile()) continue;
      const t = parseTemplate(p, readFileSync(p, "utf8"));
      byName.set(t.name, t);
    }
  }
  return [...byName.values()];
}

/** 参数切分:空格分隔,双引号或单引号包起来的算一个。 */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of s.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export function expandTemplate(t: PromptTemplate, argText: string): string {
  const args = splitArgs(argText);
  return t.body
    .replace(/\$ARGUMENTS|\$@/g, argText.trim())
    .replace(/\$(\d)/g, (_, n: string) => args[Number(n) - 1] ?? "");
}
