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
  createProvider,
  DEFAULT_CONFIG_PATH,
  type KernelConfig,
  loadConfig,
  modelNames,
  resolveApiKey,
  resolveModel,
  setApiKey,
  setDefaultModel,
} from "../src/config.js";
import { now } from "../src/events.js";
import { EventLog } from "../src/log.js";
import type { CompactionConfig } from "../src/loop.js";
import { EFFORT_LEVELS, type EffortLevel, parseEffort } from "../src/provider.js";
import { type ChildInfo, createTaskTool } from "../src/subagent.js";
import type { Tool } from "../src/tools.js";
import { buildSystemPrompt } from "./prompt.js";
import { bashTool } from "./tools/bash.js";
import { editTool, readTool, writeTool } from "./tools/fs.js";
import { globTool, grepTool, lsTool } from "./tools/search.js";
import type { ModelChoice, TuiSettings } from "./tui-app.js";

export const BASE_PROMPT =
  "你是一个在用户机器上工作的编程助手。工作目录即当前目录。" +
  "优先用 grep/glob 定位、read 读取、edit 做精确修改,用 bash 执行命令。回答简洁。";
export const RESERVE = 32000;
export const SESSIONS_DIR = "sessions";

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
  /** 非选项参数(一次性模式的任务文本)。 */
  rest: string[];
};

export function parseCommonArgs(argv: string[]): CommonArgs {
  const out: CommonArgs = {
    compaction: "llm",
    subagent: false,
    trace: false,
    fold: false,
    continue: false,
    json: false,
    help: false,
    approve: "all",
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
        break;
      case "--trace":
        out.trace = true;
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
        break;
      }
      case "--help":
      case "-h":
        out.help = true;
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
  --max-steps N                  终止保底(缺省不设上限)
  --subagent                     装上 task 工具(子 agent)
  --trace                        逐行记录原始流,并写 <会话>.trace.jsonl
  --fold                         工具结果初始折叠(Ctrl+O 切换)
  --json                         一次性模式输出结构化结果
  -h, --help

配置
  ${DEFAULT_CONFIG_PATH}
  环境变量 KERNEL_CONFIG 可改路径;key 走 apiKeyEnv 指向的环境变量,或界面里 /key 供应商 密钥`;

export type Bootstrap = {
  config: KernelConfig;
  configCreated: boolean;
  choose(name?: string): ModelChoice;
  settings: TuiSettings;
};

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
    };
  };
  const settings: TuiSettings = {
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

export function buildTools(
  log: EventLog,
  choice: ModelChoice,
  compaction: CompactionConfig,
  subagent: boolean,
  onChild?: (child: ChildInfo) => void,
): Tool[] {
  const base: Tool[] = [readTool, writeTool, editTool, bashTool, grepTool, globTool, lsTool];
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

/** 最近一次会话文件(按文件名排序,文件名即时间戳)。 */
export function latestSession(dir = SESSIONS_DIR): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl") && !f.endsWith(".trace.jsonl"))
    .sort();
  const last = files.at(-1);
  return last ? join(dir, last) : undefined;
}

/**
 * 打开会话(Q54):新建,或恢复并沿用同一文件继续追加。
 * 恢复时不重算系统提示词,日志里那份是唯一真相。
 */
export function openSession(args: Pick<CommonArgs, "resume" | "continue">): {
  log: EventLog;
  sessionFile: string;
  resumed: boolean;
} {
  const target = args.resume ?? (args.continue ? latestSession() : undefined);
  if (target) {
    if (!existsSync(target)) throw new Error(`会话文件不存在:${target}`);
    return { log: EventLog.load(target, { attach: true }), sessionFile: target, resumed: true };
  }
  if (args.continue) throw new Error(`${SESSIONS_DIR}/ 下没有可恢复的会话`);
  const sessionFile = `${SESSIONS_DIR}/${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
  return { log: new EventLog(sessionFile), sessionFile, resumed: false };
}

/** 系统提示词(Q51):--system-prompt 整段替换,--append-system-prompt 追加;否则 角色 → 环境 → 项目指令。 */
export function systemPromptFor(
  args: Pick<CommonArgs, "systemPromptFile" | "appendSystemPromptFile">,
  cwd = process.cwd(),
): { text: string; sections: { name: string; source?: string; chars: number }[] } {
  const read = (p: string | undefined) => (p ? readFileSync(p, "utf8") : undefined);
  const replace = read(args.systemPromptFile);
  const append = read(args.appendSystemPromptFile);
  const built = buildSystemPrompt({
    base: BASE_PROMPT,
    cwd,
    ...(replace !== undefined && { replace }),
    ...(append !== undefined && { append }),
  });
  return {
    text: built.text,
    sections: built.sections.map((s) => ({
      name: s.name,
      ...(s.source && { source: s.source }),
      chars: s.text.length,
    })),
  };
}

/**
 * 开始会话:新建时落 session/start(系统提示词与分段构成);恢复时沿用日志里的系统提示词,
 * 只在当前模型与日志最后记录的不同时追加 session/model。两个入口共用,界面层不再碰 session/start。
 */
export function beginSession(
  args: Pick<CommonArgs, "resume" | "continue" | "systemPromptFile" | "appendSystemPromptFile">,
  choice: Pick<ModelChoice, "model">,
  cwd = process.cwd(),
): { log: EventLog; sessionFile: string; resumed: boolean } {
  const s = openSession(args);
  if (!s.resumed) {
    const p = systemPromptFor(args, cwd);
    s.log.append({
      type: "session/start",
      at: now(),
      model: choice.model,
      system: p.text,
      sections: p.sections,
    });
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
