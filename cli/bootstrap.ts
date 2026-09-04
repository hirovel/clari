// 两个入口(tui.ts 交互、run.ts 一次性)共用的组装:参数、配置、模型、工具、压缩、会话文件、系统提示词。
// 只做拼装,不含界面。
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CompactionStrategy,
  clearToolResults,
  llmSummarize,
  pipeline,
} from "../src/compaction.js";
import {
  clariHome,
  createProvider,
  DEFAULT_CONFIG_PATH,
  type KernelConfig,
  loadConfig,
  modelNames,
  type PromptSectionName,
  resolveApiKey,
  resolveModel,
  setApiKey,
  setDefaultModel,
} from "../src/config.js";
import { type AgentEvent, now } from "../src/events.js";
import { EventLog } from "../src/log.js";
import type { CompactionConfig, ExecutionPolicy, TurnDeps } from "../src/loop.js";
import { EFFORT_LEVELS, type EffortLevel, parseEffort } from "../src/provider.js";
import { type ChildInfo, createTaskTool } from "../src/subagent.js";
import type { Tool } from "../src/tools.js";
import {
  buildSystemPrompt,
  type DiscoverOptions,
  findGitRoot,
  type PromptSection,
  type Skill,
} from "./prompt.js";
import { bashTool } from "./tools/bash.js";
import { editTool, readTool, writeTool } from "./tools/fs.js";
import { createRememberTool, type MemoryFiles } from "./tools/memory.js";
import { globTool, grepTool, lsTool } from "./tools/search.js";
import { createSkillTool } from "./tools/skill.js";
import type { ModelChoice, TuiSettings } from "./tui-app.js";

export const BASE_PROMPT =
  "你是一个在用户机器上工作的编程助手。工作目录即当前目录。" +
  "优先用 grep/glob 定位、read 读取、edit 做精确修改,用 bash 执行命令。回答简洁。";
export const RESERVE = 32000;
export const SESSIONS_DIR = "sessions";
export const PROMPT_SECTION_NAMES: PromptSectionName[] = [
  "role",
  "env",
  "instructions",
  "memory",
  "skills",
  "append",
];

export type CommonArgs = {
  model?: string;
  effort?: EffortLevel;
  /** 内置名 llm | clear | pipeline,或一个导出 CompactionStrategy 的模块路径(.mjs/.js/.ts)。 */
  compaction: string;
  subagent: boolean;
  trace: boolean;
  fold: boolean;
  /** 恢复指定会话文件。 */
  resume?: string;
  /** 恢复最近一次会话。 */
  continue: boolean;
  systemPromptFile?: string;
  appendSystemPromptFile?: string;
  maxSteps?: number;
  json: boolean;
  help: boolean;
  /** 审批槽(Q23/Q64):all = 不弹确认(缺省,pi 立场);ask = 每个工具调用在界面里问一次。 */
  approve: "all" | "ask";
  /** 预设名(Q15):从配置 presets 取缺省参数;显式给的参数优先。 */
  preset?: string;
  /** 跨会话记忆(Q65):缺省关。 */
  memory?: boolean;
  /** 系统提示词的段与顺序(Q66)。 */
  promptSections?: PromptSectionName[];
  /** 项目指令与记忆放 system 还是首条 user 消息(Q66)。 */
  instructionsAs?: "system" | "user";
  /** 技能两个旋钮(Q80),来自配置或预设:清单放 system 还是不放;模型触发时 read 还是 skill 工具。 */
  skillsList?: "system" | "none";
  skillsLoad?: "read" | "tool";
  /** 执行槽(Q10):sequential 缺省;parallel = 并行安全的相邻只读调用同时跑。 */
  execution?: ExecutionPolicy;
  /** 扩展模块路径(可多个):default 导出一个函数,返回要加的工具与槽实现。 */
  extensions: string[];
  /** 一次性模式:把每条事件以 JSON 行写到 stdout(事件流输出)。 */
  events: boolean;
  /** 非选项参数(一次性模式的任务文本)。 */
  rest: string[];
  /** 这几项有内置缺省值,记下是否显式给过,预设才知道能不能覆盖。 */
  compactionExplicit?: boolean;
  approveExplicit?: boolean;
  subagentExplicit?: boolean;
};

export function parseCommonArgs(argv: string[]): CommonArgs {
  const out: CommonArgs = {
    compaction: "llm",
    subagent: false,
    trace: true,
    fold: false,
    continue: false,
    json: false,
    help: false,
    approve: "all",
    extensions: [],
    events: false,
    rest: [],
  };
  const takeValue = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined) throw new Error(`${name} 需要一个值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    switch (a) {
      case "--model":
        out.model = takeValue(i++, a);
        break;
      case "--effort": {
        const v = takeValue(i++, a);
        const level = parseEffort(v);
        if (!level) throw new Error(`未知强度级别 "${v}",可选:${EFFORT_LEVELS.join(" ")}`);
        out.effort = level;
        break;
      }
      case "--compaction":
        out.compaction = takeValue(i++, a);
        out.compactionExplicit = true;
        break;
      case "--resume":
        out.resume = takeValue(i++, a);
        break;
      case "--continue":
        out.continue = true;
        break;
      case "--system-prompt":
        out.systemPromptFile = takeValue(i++, a);
        break;
      case "--append-system-prompt":
        out.appendSystemPromptFile = takeValue(i++, a);
        break;
      case "--max-steps":
        out.maxSteps = Number(takeValue(i++, a));
        break;
      case "--subagent":
        out.subagent = true;
        out.subagentExplicit = true;
        break;
      case "--trace":
        out.trace = true;
        break;
      case "--no-trace":
        out.trace = false;
        break;
      case "--fold":
        out.fold = true;
        break;
      case "--json":
        out.json = true;
        break;
      case "--approve": {
        const v = takeValue(i++, a);
        if (v !== "all" && v !== "ask") throw new Error(`--approve 只接受 all 或 ask,收到 "${v}"`);
        out.approve = v;
        out.approveExplicit = true;
        break;
      }
      case "--help":
      case "-h":
        out.help = true;
        break;
      case "--preset":
        out.preset = takeValue(i++, a);
        break;
      case "--memory":
        out.memory = true;
        break;
      case "--no-memory":
        out.memory = false;
        break;
      case "--prompt-sections": {
        const v = takeValue(i++, a);
        const names = v
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean);
        for (const n of names) {
          if (!PROMPT_SECTION_NAMES.includes(n as PromptSectionName)) {
            throw new Error(`未知提示词段 "${n}",可选:${PROMPT_SECTION_NAMES.join(" ")}`);
          }
        }
        out.promptSections = names as PromptSectionName[];
        break;
      }
      case "--instructions-as": {
        const v = takeValue(i++, a);
        if (v !== "system" && v !== "user")
          throw new Error(`--instructions-as 只接受 system 或 user`);
        out.instructionsAs = v;
        break;
      }
      case "--execution": {
        const v = takeValue(i++, a);
        if (v !== "sequential" && v !== "parallel")
          throw new Error(`--execution 只接受 sequential 或 parallel,收到 "${v}"`);
        out.execution = v;
        break;
      }
      case "--extension":
        out.extensions.push(takeValue(i++, a));
        break;
      case "--events":
        out.events = true;
        break;
      case "-p":
      case "--prompt":
        out.rest.push(takeValue(i++, a));
        break;
      default:
        if (a.startsWith("--")) throw new Error(`未知参数 ${a}`);
        out.rest.push(a);
    }
  }
  return out;
}

export const USAGE = `用法
  pnpm tui  [-- 选项]                  交互界面
  pnpm once -- "任务" [选项]           一次性模式:跑一个 turn 就退出,stdout 是回复
  pnpm replay <会话.jsonl> [--request N] [--compaction N [--json]] [--messages]

选项
  --model 供应商/模型            缺省用配置里的 default
  --effort off|low|medium|high|xhigh|max   缺省不传,用供应商默认
  --compaction llm|clear|pipeline|./策略.mjs   缺省 llm
  --resume <会话文件> | --continue   恢复会话并沿用同一文件
  --system-prompt <文件> | --append-system-prompt <文件>
  --approve all|ask              ask = 每个工具调用弹一行确认(仅界面);缺省 all
  --preset 名                    用配置里 presets.名 的一组参数;显式参数仍优先
  --memory | --no-memory         跨会话记忆(AGENTS.md 里的记忆节 + remember 工具);缺省关
  --prompt-sections role,env,instructions,memory,skills,append   系统提示词要哪几段、什么顺序
  --instructions-as system|user  项目指令与记忆放 system(缺省)还是首条 user 消息
  --execution sequential|parallel  工具执行槽:缺省逐个;parallel = 相邻只读调用同时跑
  --extension <模块.mjs>         装载扩展模块(可多次):加工具、换槽实现
  --max-steps N                  终止保底(缺省不设上限)
  --subagent                     装上 task 工具(子 agent)
  --no-trace                     不记录原始流(缺省逐行记录收到的每一行,写 <会话>.trace.jsonl,/raw N 查看)
  --fold                         工具结果初始折叠(Ctrl+O 切换)
  --json                         一次性模式输出结构化结果
  --events                       一次性模式把每条事件以 JSON 行写到 stdout
  -h, --help

配置
  ${DEFAULT_CONFIG_PATH}
  环境变量 CLARI_CONFIG 可改路径;key 走 apiKeyEnv 指向的环境变量,或界面里 /key 供应商 密钥
  会话文件缺省在 ./sessions/;配置 sessionsDir 或环境变量 CLARI_SESSIONS 可改
  提示词模板 ~/.clari/prompts/*.md 与 <git 根>/.clari/prompts/*.md,界面里 /名 参数
  技能 ~/.clari/skills/<名>/SKILL.md 与 <git 根>/.agents/skills/<名>/SKILL.md,进系统提示词的技能段`;

export type Bootstrap = {
  config: KernelConfig;
  configCreated: boolean;
  choose(name?: string): ModelChoice;
  settings: TuiSettings;
  /** 把预设与配置缺省并进参数(Q15/Q66):显式参数 > 预设 > 配置 prompt 缺省 > 内置缺省。 */
  resolve(args: CommonArgs): CommonArgs;
};

export function applyPreset(args: CommonArgs, config: KernelConfig): CommonArgs {
  const out: CommonArgs = { ...args };
  const preset = args.preset ? config.presets?.[args.preset] : undefined;
  if (args.preset && !preset) {
    throw new Error(
      `配置里没有预设 "${args.preset}",可选:${Object.keys(config.presets ?? {}).join(" ") || "(无)"}`,
    );
  }
  if (preset) {
    if (out.model === undefined && preset.model) out.model = preset.model;
    if (out.effort === undefined && preset.effort) {
      const level = parseEffort(preset.effort);
      if (!level) throw new Error(`预设 ${args.preset} 的 effort "${preset.effort}" 不合法`);
      out.effort = level;
    }
    if (!args.compactionExplicit && preset.compaction) out.compaction = preset.compaction;
    if (!args.approveExplicit && preset.approve) out.approve = preset.approve;
    if (out.systemPromptFile === undefined && preset.systemPromptFile) {
      out.systemPromptFile = preset.systemPromptFile;
    }
    if (out.appendSystemPromptFile === undefined && preset.appendSystemPromptFile) {
      out.appendSystemPromptFile = preset.appendSystemPromptFile;
    }
    if (!args.subagentExplicit && preset.subagent !== undefined) out.subagent = preset.subagent;
    if (out.maxSteps === undefined && preset.maxSteps !== undefined) out.maxSteps = preset.maxSteps;
    if (out.execution === undefined && preset.execution) out.execution = preset.execution;
    if (out.extensions.length === 0 && preset.extensions) out.extensions = [...preset.extensions];
  }
  const prompt = { ...config.prompt, ...preset?.prompt };
  if (out.memory === undefined && prompt.memory !== undefined) out.memory = prompt.memory;
  if (out.promptSections === undefined && prompt.sections) out.promptSections = prompt.sections;
  if (out.instructionsAs === undefined && prompt.instructionsAs) {
    out.instructionsAs = prompt.instructionsAs;
  }
  const skills = { ...config.prompt?.skills, ...preset?.prompt?.skills };
  if (skills.list) out.skillsList = skills.list;
  if (skills.load) out.skillsLoad = skills.load;
  return out;
}

export function bootstrap(): Bootstrap {
  const loaded = loadConfig();
  let config = loaded.config;
  const choose = (name?: string): ModelChoice => {
    const r = resolveModel(config, name);
    const apiKey = resolveApiKey(r.providerName, r.provider);
    return {
      provider: createProvider(r, apiKey),
      model: r.model,
      providerName: r.providerName,
      contextWindow: r.contextWindow,
      ...(r.effortLevels && { effortLevels: r.effortLevels }),
      ...(r.price && { price: r.price }),
    };
  };
  const settings: TuiSettings = {
    priceFor: (model) => {
      try {
        return resolveModel(config, model).price;
      } catch {
        return undefined;
      }
    },
    listModels: () =>
      Object.entries(config.providers).flatMap(([pn, p]) => modelNames(p).map((m) => `${pn}/${m}`)),
    switchModel: (name) => choose(name),
    setKey: (providerName, key) => {
      config = setApiKey(config, providerName, key);
    },
    setDefault: (model) => {
      config = setDefaultModel(config, model);
    },
  };
  return {
    get config() {
      return config;
    },
    configCreated: loaded.created,
    choose,
    settings,
    resolve: (args) => applyPreset(args, config),
  };
}

export const BUILTIN_STRATEGIES: Record<string, () => CompactionStrategy> = {
  llm: () => llmSummarize(),
  clear: () => clearToolResults(),
  pipeline: () => pipeline(clearToolResults(), llmSummarize()),
};

/**
 * 压缩策略:内置名,或外部模块路径(扩展点)。模块用 default 导出一个 CompactionStrategy 函数,
 * 例如 `export default async (input) => ({ cleared: [...], strategy: "我的策略" })`。
 * 这样对比新策略不必改仓库代码:`pnpm once -- "任务" --compaction ./my-strategy.mjs --json`。
 */
export async function loadCompactionStrategy(name: string): Promise<CompactionStrategy> {
  const builtin = BUILTIN_STRATEGIES[name];
  if (builtin) return builtin();
  if (/[\\/]|\.(m?js|ts)$/.test(name)) {
    const mod = (await import(pathToFileURL(resolve(name)).href)) as {
      default?: unknown;
      strategy?: unknown;
    };
    const fn = mod.default ?? mod.strategy;
    if (typeof fn !== "function") {
      throw new Error(`压缩策略模块 ${name} 必须 default 导出一个函数`);
    }
    return fn as CompactionStrategy;
  }
  throw new Error(
    `未知压缩策略 "${name}",可选:${Object.keys(BUILTIN_STRATEGIES).join(" ")},或模块路径`,
  );
}

export async function buildCompaction(
  name: string,
  window: number,
  reserveTokens = RESERVE,
): Promise<CompactionConfig> {
  return { strategy: await loadCompactionStrategy(name), window, reserveTokens };
}

/** 记忆文件(Q65):项目级 = git 根(或 cwd)的 AGENTS.md;用户级 = ~/.clari/AGENTS.md。 */
export function memoryFiles(cwd = process.cwd(), home = clariHome()): MemoryFiles {
  const projectRoot = findGitRoot(cwd) ?? resolve(cwd);
  return { project: join(projectRoot, "AGENTS.md"), user: join(home, "AGENTS.md") };
}

export function buildTools(
  log: EventLog,
  choice: ModelChoice,
  compaction: CompactionConfig,
  subagent: boolean,
  onChild?: (child: ChildInfo) => void,
  memory?: MemoryFiles,
  /** skills.load = tool 时给:装一个 skill 工具,模型点名即拿到正文。 */
  skills?: Skill[],
): Tool[] {
  const base: Tool[] = [readTool, writeTool, editTool, bashTool, grepTool, globTool, lsTool];
  if (memory) base.push(createRememberTool(memory));
  if (skills?.some((s) => !s.disableModelInvocation)) base.push(createSkillTool(skills));
  if (!subagent) return base;
  return [
    ...base,
    createTaskTool({
      parent: log,
      provider: choice.provider,
      tools: base,
      compaction,
      ...(onChild && { onChild }),
    }),
  ];
}

/** 会话目录:环境变量 CLARI_SESSIONS > 配置 sessionsDir > ./sessions。 */
export function sessionsDir(config?: Pick<KernelConfig, "sessionsDir">): string {
  return process.env.CLARI_SESSIONS?.trim() || config?.sessionsDir || SESSIONS_DIR;
}

/** 最近一次会话文件(按文件名排序,文件名即时间戳)。 */
export function latestSession(dir = SESSIONS_DIR): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") && !f.endsWith(".trace.jsonl"))
    .sort();
  const last = files.at(-1);
  return last ? join(dir, last) : undefined;
}

export function newSessionPath(dir = SESSIONS_DIR, suffix = ""): string {
  return join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}${suffix}.jsonl`);
}

/**
 * 打开会话(Q54):新建,或恢复并沿用同一文件继续追加。
 * 恢复时不重算系统提示词,日志里那份是唯一真相。
 */
export function openSession(
  args: Pick<CommonArgs, "resume" | "continue">,
  dir = SESSIONS_DIR,
): {
  log: EventLog;
  sessionFile: string;
  resumed: boolean;
} {
  const target = args.resume ?? (args.continue ? latestSession(dir) : undefined);
  if (target) {
    if (!existsSync(target)) throw new Error(`会话文件不存在:${target}`);
    return { log: EventLog.load(target, { attach: true }), sessionFile: target, resumed: true };
  }
  if (args.continue) throw new Error(`${dir}/ 下没有可恢复的会话`);
  const sessionFile = newSessionPath(dir);
  return { log: new EventLog(sessionFile), sessionFile, resumed: false };
}

/**
 * 分叉会话:把前 upTo 条事件复制成一个新文件。事件即真相,分叉就是复制前缀;
 * 原文件一字不动,新文件用 --resume 打开就从那个时点继续。
 */
export function forkSession(
  events: readonly AgentEvent[],
  upTo: number,
  dir = SESSIONS_DIR,
): { file: string; events: number } {
  const n = Math.max(1, Math.min(upTo, events.length));
  const file = newSessionPath(dir, "-fork");
  const log = new EventLog(file);
  for (const e of events.slice(0, n)) log.append(e);
  return { file, events: n };
}

/** 扩展模块的返回形态:要加的工具、要换的槽实现、要订阅事件的回调。都可选。 */
export type Extension = {
  tools?: Tool[];
  slots?: TurnDeps["slots"];
  onEvent?: (e: AgentEvent) => void;
};

/**
 * 装载扩展模块(Q27 的外部注入):default 导出 `(ctx) => Extension`,ctx 里有工作目录与事件日志。
 * 多个模块按顺序合并,后者的槽覆盖前者;工具重名以后者为准。
 */
export async function loadExtensions(
  paths: string[],
  ctx: { cwd: string; log: EventLog },
): Promise<Extension> {
  const merged: Extension = { tools: [], slots: {} };
  for (const p of paths) {
    const mod = (await import(pathToFileURL(resolve(p)).href)) as { default?: unknown };
    if (typeof mod.default !== "function") {
      throw new Error(
        `扩展模块 ${p} 必须 default 导出一个函数 (ctx) => ({ tools?, slots?, onEvent? })`,
      );
    }
    const ext = (await (mod.default as (c: typeof ctx) => Extension | Promise<Extension>)(
      ctx,
    )) as Extension;
    for (const t of ext.tools ?? []) {
      merged.tools = [...(merged.tools ?? []).filter((x) => x.name !== t.name), t];
    }
    merged.slots = { ...merged.slots, ...ext.slots };
    if (ext.onEvent) ctx.log.subscribe(ext.onEvent);
  }
  return merged;
}

/** 系统提示词(Q51):--system-prompt 整段替换,--append-system-prompt 追加;否则 角色 → 环境 → 项目指令。 */
type PromptArgs = Pick<
  CommonArgs,
  | "systemPromptFile"
  | "appendSystemPromptFile"
  | "memory"
  | "promptSections"
  | "instructionsAs"
  | "skillsList"
>;

const meta = (s: PromptSection) => ({
  name: s.name,
  ...(s.source && { source: s.source }),
  chars: s.text.length,
});

export function systemPromptFor(
  args: PromptArgs,
  cwd = process.cwd(),
  /** 发现目录的覆盖(测试用:临时的用户目录与仓库根)。 */
  discover?: DiscoverOptions,
): {
  text: string;
  sections: { name: string; source?: string; chars: number }[];
  /** 改放首条 user 消息的段(--instructions-as user)。 */
  preamble: { name: string; text: string }[];
} {
  const read = (p: string | undefined) => (p ? readFileSync(p, "utf8") : undefined);
  const replace = read(args.systemPromptFile);
  const append = read(args.appendSystemPromptFile);
  const built = buildSystemPrompt({
    base: BASE_PROMPT,
    cwd,
    ...(discover && { discover }),
    ...(replace !== undefined && { replace }),
    ...(append !== undefined && { append }),
    ...(args.promptSections && { sections: args.promptSections }),
    memory: args.memory ?? false,
    ...(args.instructionsAs && { instructionsAs: args.instructionsAs }),
    // skills.list = none:技能清单不进系统提示词,只许用户 /名 触发。
    ...(args.skillsList === "none" && {
      sections: (args.promptSections ?? PROMPT_SECTION_NAMES).filter((s) => s !== "skills"),
    }),
  });
  return {
    text: built.text,
    sections: built.sections.map(meta),
    preamble: built.preamble.map((s) => ({ name: s.name, text: s.text })),
  };
}

/**
 * 开始会话:新建时落 session/start(系统提示词与分段构成);恢复时沿用日志里的系统提示词,
 * 只在当前模型与日志最后记录的不同时追加 session/model。两个入口共用,界面层不再碰 session/start。
 */
export function beginSession(
  args: Pick<CommonArgs, "resume" | "continue"> & PromptArgs,
  choice: Pick<ModelChoice, "model">,
  cwd = process.cwd(),
  dir = SESSIONS_DIR,
): { log: EventLog; sessionFile: string; resumed: boolean } {
  const s = openSession(args, dir);
  if (!s.resumed) {
    const p = systemPromptFor(args, cwd);
    s.log.append({
      type: "session/start",
      at: now(),
      model: choice.model,
      system: p.text,
      sections: p.sections,
    });
    // instructionsAs = user:项目指令与记忆作为首条 user 消息进日志(Q66)。
    // 它是一条用户没打过的用户消息,所以必须像其它用户消息一样落盘、上屏,不做任何隐藏。
    if (p.preamble.length > 0) {
      s.log.append({
        type: "user/message",
        at: now(),
        text: p.preamble.map((x) => x.text).join("\n\n"),
      });
    }
    return s;
  }
  const last = [...s.log.events]
    .reverse()
    .find((e) => e.type === "session/start" || e.type === "session/model");
  if (last && "model" in last && last.model !== choice.model) {
    s.log.append({ type: "session/model", at: now(), model: choice.model });
  }
  return s;
}

export { DEFAULT_CONFIG_PATH };
