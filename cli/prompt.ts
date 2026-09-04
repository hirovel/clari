// 系统提示词组装(Q51/Q66)。CLI 层的纯函数,内核不知道它:内核只收到最终字符串并存进 session/start。
// 段列表是数据不是字符串拼接:哪几段、什么顺序、放 system 还是首条 user 消息,都由配置或预设决定(Q66),
// 检视器与 /context 按段读取。
// 调查共识直接采用:项目指令文件按目录层级根在前、cwd 在后拼接;向上搜索止于 git 根;总预算加降级;替换与追加并存。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { release, type } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { clariHome, type PromptSectionName } from "../src/config.js";
import { splitMemory } from "./tools/memory.js";

export type PromptSection = {
  /** 段名,检视与文档用。 */
  name: string;
  text: string;
  /** 来源(文件路径等),只给人看。 */
  source?: string;
};

export const DEFAULT_SECTION_ORDER: PromptSectionName[] = [
  "role",
  "env",
  "instructions",
  "memory",
  "skills",
  "append",
];

export const SECTION_LABELS: Record<PromptSectionName, string> = {
  role: "Role and rules",
  env: "Environment",
  instructions: "Project instructions",
  memory: "Memory",
  skills: "Skills",
  append: "Appended",
};

/**
 * 技能(Q80):一个目录一个 SKILL.md。frontmatter 认四个字段:name、description、
 * disable-model-invocation(只许用户 /名 触发,不进系统提示词)、allowed-tools(用户触发的那一 turn 里这些工具免审批)、
 * argument-hint(补全提示)。正文按需进入上下文,不预先占 token。
 */
export type Skill = {
  name: string;
  description: string;
  /** SKILL.md 的路径。 */
  path: string;
  /** 技能目录;正文里的相对路径相对于它。 */
  dir: string;
  /** frontmatter 之后的正文。 */
  body: string;
  disableModelInvocation: boolean;
  allowedTools: string[];
  argumentHint?: string;
};

/** 解析 SKILL.md;没有 name 就用目录名。 */
export function parseSkill(path: string, raw: string): Skill {
  const dir = dirname(path);
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const field = (k: string) => m?.[1]?.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1]?.trim();
  const body = (m ? raw.slice(m[0].length) : raw).trim();
  const allowed = field("allowed-tools");
  const hint = field("argument-hint");
  return {
    name: field("name") || basename(dir),
    description: field("description") || "",
    path,
    dir,
    body,
    disableModelInvocation: /^(true|yes)$/i.test(field("disable-model-invocation") ?? ""),
    allowedTools: allowed ? allowed.split(/[\s,]+/).filter(Boolean) : [],
    ...(hint && { argumentHint: hint }),
  };
}

/**
 * 技能发现:用户级 ~/.clari/skills 与 ~/.claude/skills,项目级 <git 根>/.agents/skills 与 <git 根>/.claude/skills;
 * 每个目录下 <名>/SKILL.md;同名以先发现的为准。读 .claude/skills 是为了与 Claude Code 互通。
 */
export function discoverSkills(cwd: string, opts: { home?: string; root?: string } = {}): Skill[] {
  const home = opts.home ?? clariHome();
  const root = opts.root ?? findGitRoot(cwd) ?? resolve(cwd);
  // 用户级 .claude/skills 取 clari 用户目录的同级(~/.clari 与 ~/.claude 同在家目录);
  // 测试用临时 home(或 CLARI_HOME)时就不会漏到真机目录。
  const userClaude = join(dirname(home), ".claude", "skills");
  const dirs = [
    join(home, "skills"),
    userClaude,
    join(root, ".agents", "skills"),
    join(root, ".claude", "skills"),
  ];
  const byName = new Map<string, Skill>();
  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir).sort()) {
      const file = join(dir, name, "SKILL.md");
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      const s = parseSkill(file, readFileSync(file, "utf8"));
      if (!byName.has(s.name)) byName.set(s.name, s);
    }
  }
  return [...byName.values()];
}

/** 系统提示词里的技能清单:只放名字、描述、路径;只许用户触发的技能不列。 */
export function skillsSection(skills: Skill[]): PromptSection | undefined {
  const listed = skills.filter((s) => !s.disableModelInvocation);
  if (listed.length === 0) return undefined;
  const lines = listed.map((s) => `- ${s.name}: ${s.description || "(no description)"}  ${s.path}`);
  return {
    name: SECTION_LABELS.skills,
    text: `# Skills\nUse a skill when it matches the task: read its SKILL.md with the read tool first, then follow it. Relative paths inside a skill are relative to its directory.\n${lines.join("\n")}`,
    source: listed.map((s) => s.path).join(", "),
  };
}

/**
 * 用户触发技能:/名 参数 → 一条用户消息。正文里 $ARGUMENTS / $@ 是全部参数,$1..$9 是按空格切分的第 n 个。
 * 消息头一行说明来源与目录,模型据此解析相对路径;整条消息落盘上屏,与手打的一样。
 */
export function expandSkill(skill: Skill, argText: string): string {
  const args = [...argText.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? "",
  );
  const body = skill.body
    .replace(/\$ARGUMENTS|\$@/g, argText.trim())
    .replace(/\$(\d)/g, (_, n: string) => args[Number(n) - 1] ?? "");
  return `Skill "${skill.name}" (${skill.path}; relative paths are relative to ${skill.dir}):\n\n${body}`;
}

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
  const shell = env.SHELL ?? env.ComSpec ?? "unknown";
  const lines = [
    `working directory: ${resolve(cwd)}`,
    `os: ${type()} ${release()}`,
    `shell: ${shell}`,
    `date: ${now.toISOString().slice(0, 10)}`,
  ];
  if (opts.git !== false) {
    const root = findGitRoot(cwd);
    if (root) {
      const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const status = git(cwd, ["status", "--porcelain"]);
      lines.push(
        `git: repo root ${root}${branch ? `, branch ${branch}` : ""}${status === undefined ? "" : status ? ", uncommitted changes" : ", working tree clean"}`,
      );
    } else {
      lines.push("git: not in a repository");
    }
  }
  return { name: SECTION_LABELS.env, text: `# Environment\n${lines.join("\n")}` };
}

export type InstructionFile = {
  path: string;
  bytes: number;
  /** 超预算时被整份丢弃(先丢最宽泛的)。 */
  dropped?: boolean;
  /** 最具体的一份也超预算时被截到预算内。 */
  truncated?: boolean;
  /** 文件里记忆节的字节数(0 = 没有)。 */
  memoryBytes: number;
};

export type DiscoverOptions = {
  /** 全局指令文件所在目录;缺省 ~/.clari。 */
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
 * 每个文件里由工具写入的记忆节被拆出来单独成段(记忆是否注入由调用方决定,Q65 缺省关)。
 * 预算:超限先丢最宽泛的(列表最前面的),只剩最后一份仍超限就截它。
 */
export function discoverProjectInstructions(
  cwd: string,
  opts: DiscoverOptions = {},
): { section?: PromptSection; memory?: PromptSection; files: InstructionFile[] } {
  const filenames = opts.filenames ?? DEFAULT_INSTRUCTION_FILES;
  const budget = opts.budgetBytes ?? DEFAULT_INSTRUCTION_BUDGET;
  const home = opts.home ?? clariHome();
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

  const candidates: { path: string; content: string; memory: string | undefined }[] = [];
  const pick = (dir: string) => {
    for (const name of filenames) {
      const p = join(dir, name);
      if (existsSync(p) && statSync(p).isFile()) {
        const split = splitMemory(readFileSync(p, "utf8"));
        candidates.push({ path: p, content: split.rest, memory: split.memory });
        return;
      }
    }
  };
  pick(home);
  for (const d of dirs) if (d !== home) pick(d);

  const files: InstructionFile[] = candidates.map((c) => ({
    path: c.path,
    bytes: Buffer.byteLength(c.content, "utf8"),
    memoryBytes: c.memory ? Buffer.byteLength(c.memory, "utf8") : 0,
  }));
  const memories = candidates.filter((c) => c.memory).map((c) => `# Memory ${c.path}\n${c.memory}`);
  const memory: PromptSection | undefined =
    memories.length > 0
      ? {
          name: SECTION_LABELS.memory,
          text: memories.join("\n\n"),
          source: candidates
            .filter((c) => c.memory)
            .map((c) => c.path)
            .join(", "),
        }
      : undefined;

  const kept = candidates
    .filter((c) => c.content.trim())
    .map((c) => ({ ...c, meta: files.find((f) => f.path === c.path) as InstructionFile }));
  let total = kept.reduce((n, k) => n + k.meta.bytes, 0);
  while (total > budget && kept.length > 1) {
    const dropped = kept.shift() as (typeof kept)[number];
    dropped.meta.dropped = true;
    total -= dropped.meta.bytes;
  }
  const last = kept[0];
  if (last && kept.length === 1 && last.meta.bytes > budget) {
    last.content = `${Buffer.from(last.content, "utf8").subarray(0, budget).toString("utf8")}\n[truncated to ${budget} bytes]`;
    last.meta.truncated = true;
  }
  const out: { section?: PromptSection; memory?: PromptSection; files: InstructionFile[] } = {
    files,
    ...(memory && { memory }),
  };
  if (kept.length === 0) return out;
  const text = kept
    .map((k) => `# Project instructions ${k.path}\n${k.content.trim()}`)
    .join("\n\n");
  out.section = {
    name: SECTION_LABELS.instructions,
    text,
    source: kept.map((k) => k.path).join(", "),
  };
  return out;
}

export type BuildPromptOptions = {
  /** 角色与规则(固定段)。 */
  base: string;
  cwd: string;
  /** 整段替换:给了就只剩它(加追加段),不带环境与项目指令。 */
  replace?: string;
  /** 追加段,放在最后。 */
  append?: string;
  /** 要哪几段、什么顺序;缺省 角色 → 环境 → 项目指令 → 记忆 → 追加。 */
  sections?: PromptSectionName[];
  /** 记忆段是否注入(Q65 缺省关:没打开就连读都不读)。 */
  memory?: boolean;
  /** 项目指令与记忆放 system 还是首条 user 消息(Q66)。缺省 system。 */
  instructionsAs?: "system" | "user";
  discover?: DiscoverOptions;
  env?: { now?: Date; env?: NodeJS.ProcessEnv; git?: boolean };
};

export type BuiltPrompt = {
  /** 系统提示词全文。 */
  text: string;
  /** 进了系统提示词的段。 */
  sections: PromptSection[];
  /** 改放首条 user 消息的段(instructionsAs = user 时的项目指令与记忆)。 */
  preamble: PromptSection[];
  files: InstructionFile[];
};

export function buildSystemPrompt(opts: BuildPromptOptions): BuiltPrompt {
  if (opts.replace !== undefined) {
    const sections: PromptSection[] = [{ name: "Custom", text: opts.replace }];
    if (opts.append) sections.push({ name: SECTION_LABELS.append, text: opts.append });
    return { text: composeSystemPrompt(sections), sections, preamble: [], files: [] };
  }
  const order = opts.sections ?? DEFAULT_SECTION_ORDER;
  const project = discoverProjectInstructions(opts.cwd, opts.discover);
  // 技能段只在被点名时才去扫目录,不点名连磁盘都不碰。
  const skills = order.includes("skills")
    ? skillsSection(
        discoverSkills(opts.cwd, {
          ...(opts.discover?.home && { home: opts.discover.home }),
          ...(opts.discover?.root && { root: opts.discover.root }),
        }),
      )
    : undefined;
  const available: Partial<Record<PromptSectionName, PromptSection>> = {
    role: { name: SECTION_LABELS.role, text: opts.base },
    env: environmentSection(opts.cwd, opts.env),
    ...(project.section && { instructions: project.section }),
    ...(opts.memory && project.memory && { memory: project.memory }),
    ...(skills && { skills }),
    ...(opts.append && { append: { name: SECTION_LABELS.append, text: opts.append } }),
  };
  const toUser = opts.instructionsAs === "user";
  const sections: PromptSection[] = [];
  const preamble: PromptSection[] = [];
  for (const name of order) {
    const s = available[name];
    if (!s) continue;
    if (toUser && (name === "instructions" || name === "memory")) preamble.push(s);
    else sections.push(s);
  }
  return { text: composeSystemPrompt(sections), sections, preamble, files: project.files };
}
