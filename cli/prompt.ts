// 系统提示词组装(Q51)。CLI 层的纯函数,内核不知道它:内核只收到最终字符串并存进 session/start。
// 段列表是数据不是字符串拼接,检视器与 preset 都能按段读取。
// 调查共识直接采用:项目指令文件按目录层级根在前、cwd 在后拼接;向上搜索止于 git 根;总预算加降级;替换与追加并存。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, release, type } from "node:os";
import { dirname, join, resolve } from "node:path";

export type PromptSection = {
  /** 段名,检视与文档用。 */
  name: string;
  text: string;
  /** 来源(文件路径等),只给人看。 */
  source?: string;
};

/** 非空段以空行相接;段内文本原样。 */
export function composeSystemPrompt(sections: PromptSection[]): string {
  return sections
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

/** 从 dir 向上找含 .git 的目录;找不到返回 undefined。 */
export function findGitRoot(dir: string): string | undefined {
  let cur = resolve(dir);
  while (true) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    cur = parent;
  }
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

/** 环境块:cwd、OS、shell、日期、git 分支与是否干净。字段都是事实,不含规则。 */
export function environmentSection(
  cwd: string,
  opts: { now?: Date; env?: NodeJS.ProcessEnv; git?: boolean } = {},
): PromptSection {
  const now = opts.now ?? new Date();
  const env = opts.env ?? process.env;
  const shell = env.SHELL ?? env.ComSpec ?? "未知";
  const lines = [
    `工作目录:${resolve(cwd)}`,
    `操作系统:${type()} ${release()}`,
    `shell:${shell}`,
    `日期:${now.toISOString().slice(0, 10)}`,
  ];
  if (opts.git !== false) {
    const root = findGitRoot(cwd);
    if (root) {
      const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const status = git(cwd, ["status", "--porcelain"]);
      lines.push(
        `git:仓库根 ${root}${branch ? `,分支 ${branch}` : ""}${status === undefined ? "" : status ? ",有未提交改动" : ",工作区干净"}`,
      );
    } else {
      lines.push("git:不在仓库内");
    }
  }
  return { name: "环境", text: `# 环境\n${lines.join("\n")}` };
}

export type InstructionFile = {
  path: string;
  bytes: number;
  /** 超预算时被整份丢弃(先丢最宽泛的)。 */
  dropped?: boolean;
  /** 最具体的一份也超预算时被截到预算内。 */
  truncated?: boolean;
};

export type DiscoverOptions = {
  /** 全局指令文件所在目录;缺省 ~/.agent-kernel。 */
  home?: string;
  /** 总预算(字节),缺省 32 KiB。 */
  budgetBytes?: number;
  /** 每目录按此顺序取第一个存在的。 */
  filenames?: string[];
  /** 向上搜索的边界;缺省 git 根,不在仓库内则只看 cwd。 */
  root?: string;
};

export const DEFAULT_INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];
export const DEFAULT_INSTRUCTION_BUDGET = 32 * 1024;

/**
 * 发现项目指令文件:全局 → git 根 → … → cwd,每目录取一个。
 * 预算:超限先丢最宽泛的(靶列表最前面的),只剩最后一份仍超限就截它。
 */
export function discoverProjectInstructions(
  cwd: string,
  opts: DiscoverOptions = {},
): { section?: PromptSection; files: InstructionFile[] } {
  const filenames = opts.filenames ?? DEFAULT_INSTRUCTION_FILES;
  const budget = opts.budgetBytes ?? DEFAULT_INSTRUCTION_BUDGET;
  const home = opts.home ?? join(homedir(), ".agent-kernel");
  const start = resolve(cwd);
  const root = opts.root ? resolve(opts.root) : (findGitRoot(start) ?? start);

  const dirs: string[] = [];
  let cur = start;
  while (true) {
    dirs.unshift(cur);
    if (cur === root) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  const candidates: { path: string; content: string }[] = [];
  const pick = (dir: string) => {
    for (const name of filenames) {
      const p = join(dir, name);
      if (existsSync(p) && statSync(p).isFile()) {
        candidates.push({ path: p, content: readFileSync(p, "utf8") });
        return;
      }
    }
  };
  pick(home);
  for (const d of dirs) if (d !== home) pick(d);

  const files: InstructionFile[] = candidates.map((c) => ({
    path: c.path,
    bytes: Buffer.byteLength(c.content, "utf8"),
  }));
  const kept = candidates.map((c, i) => ({ ...c, meta: files[i] as InstructionFile }));
  let total = kept.reduce((n, k) => n + k.meta.bytes, 0);
  while (total > budget && kept.length > 1) {
    const dropped = kept.shift() as (typeof kept)[number];
    dropped.meta.dropped = true;
    total -= dropped.meta.bytes;
  }
  const last = kept[0];
  if (last && kept.length === 1 && last.meta.bytes > budget) {
    last.content = `${Buffer.from(last.content, "utf8").subarray(0, budget).toString("utf8")}\n[已截断至 ${budget} 字节]`;
    last.meta.truncated = true;
  }
  if (kept.length === 0) return { files };
  const text = kept.map((k) => `# 项目指令 ${k.path}\n${k.content.trim()}`).join("\n\n");
  return {
    section: { name: "项目指令", text, source: kept.map((k) => k.path).join(", ") },
    files,
  };
}

export type BuildPromptOptions = {
  /** 角色与规则(固定段)。 */
  base: string;
  cwd: string;
  /** 整段替换:给了就只剩它(加追加段),不带环境与项目指令。 */
  replace?: string;
  /** 追加段,放在最后。 */
  append?: string;
  discover?: DiscoverOptions;
  env?: { now?: Date; env?: NodeJS.ProcessEnv; git?: boolean };
};

/** 缺省顺序:角色与规则 → 环境 → 项目指令 → 追加。 */
export function buildSystemPrompt(opts: BuildPromptOptions): {
  text: string;
  sections: PromptSection[];
  files: InstructionFile[];
} {
  if (opts.replace !== undefined) {
    const sections: PromptSection[] = [{ name: "自定义", text: opts.replace }];
    if (opts.append) sections.push({ name: "追加", text: opts.append });
    return { text: composeSystemPrompt(sections), sections, files: [] };
  }
  const project = discoverProjectInstructions(opts.cwd, opts.discover);
  const sections: PromptSection[] = [
    { name: "角色与规则", text: opts.base },
    environmentSection(opts.cwd, opts.env),
  ];
  if (project.section) sections.push(project.section);
  if (opts.append) sections.push({ name: "追加", text: opts.append });
  return { text: composeSystemPrompt(sections), sections, files: project.files };
}
