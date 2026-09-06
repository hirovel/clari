// 两个入口(tui.ts 交互、run.ts 一次性)共用的组装:配置与模型、工具集、系统提示词、开始会话。只做拼装,不含界面。
// 参数解析在 args.ts,压缩策略装载在 strategies.ts,扩展模块在 extensions.ts,会话文件在 sessions.ts;
// 这里把它们再导出,入口与测试从 bootstrap 一处 import(重构块 6)。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  clariHome,
  createProvider,
  DEFAULT_CONFIG_PATH,
  type KernelConfig,
  loadConfig,
  modelNames,
  resolveApiKey,
  resolveModel,
  type SubagentsConfig,
  setApiKey,
  setDefaultModel,
  type ToolPromptsConfig,
} from "../src/config.js";
import { now } from "../src/events.js";
import type { EventLog } from "../src/log.js";
import type { CompactionConfig, TurnDeps } from "../src/loop.js";
import type { Provider } from "../src/provider.js";
import { type ChildInfo, createTaskTool } from "../src/subagent.js";
import type { Tool } from "../src/tools.js";
import { applyPreset, type CommonArgs, PROMPT_SECTION_NAMES } from "./args.js";
import {
  buildSystemPrompt,
  type DiscoverOptions,
  findGitRoot,
  type PromptSection,
  type Skill,
} from "./prompt.js";
import { openSession, SESSIONS_DIR } from "./sessions.js";
import { applyToolPrompts } from "./tool-prompts.js";
import { bashTool } from "./tools/bash.js";
import { createFetchTool, type FetchConfig } from "./tools/fetch.js";
import { editTool, readTool, writeTool } from "./tools/fs.js";
import { createRememberTool, type MemoryFiles } from "./tools/memory.js";
import { globTool, grepTool } from "./tools/search.js";
import { createSkillTool } from "./tools/skill.js";
import type { ModelChoice, TuiSettings } from "./tui-app.js";

export * from "./args.js";
export * from "./extensions.js";
export {
  forkSession,
  latestSession,
  newSessionPath,
  openSession,
  SESSIONS_DIR,
  sessionsDir,
} from "./sessions.js";
export * from "./strategies.js";
export { DEFAULT_CONFIG_PATH };

export const BASE_PROMPT =
  "You are a coding assistant working on the user's machine. The working directory is the current directory. " +
  "Prefer grep/glob to locate, read to read, edit for exact changes, and bash to run commands. Keep answers concise.";

export type Bootstrap = {
  config: KernelConfig;
  configCreated: boolean;
  choose(name?: string): ModelChoice;
  settings: TuiSettings;
  /** 把预设与配置缺省并进参数:显式参数 > 预设 > 配置 prompt 缺省 > 内置缺省。 */
  resolve(args: CommonArgs): CommonArgs;
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

/** 记忆文件:项目级 = git 根(或 cwd)的 AGENTS.md;用户级 = ~/.clari/AGENTS.md。 */
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
  /** fetch 工具的安全边界;不给用缺省(拒私网、30 秒、5 MB)。 */
  fetchConfig?: FetchConfig,
  /** 工具描述风格;不给就是工具文件里写的 guided。 */
  toolPrompts?: ToolPromptsConfig,
  /** 子 agent 的设置与接线:配置块、取父当前槽的函数、按模型名取 provider。 */
  subagents?: {
    config?: SubagentsConfig;
    slots?: () => TurnDeps["slots"] | undefined;
    providerFor?: (model: string) => Provider;
  },
): Tool[] {
  // 每次组装复制一份工具对象:描述风格槽原地改描述,不能碰模块级单例。
  const base: Tool[] = [
    readTool,
    writeTool,
    editTool,
    bashTool,
    grepTool,
    globTool,
    createFetchTool({ ...(fetchConfig && { config: fetchConfig }) }),
  ].map((t) => ({ ...t }));
  applyToolPrompts(base, toolPrompts);
  if (memory) base.push(createRememberTool(memory));
  if (skills?.some((s) => !s.disableModelInvocation)) base.push(createSkillTool(skills));
  if (!subagent) return base;
  const cfg = subagents?.config;
  const task = createTaskTool({
    parent: log,
    provider: choice.provider,
    tools: base,
    compaction,
    ...(onChild && { onChild }),
    ...(subagents?.slots && { slots: subagents.slots }),
    ...(subagents?.providerFor && { providerFor: subagents.providerFor }),
    ...(cfg?.approval !== undefined && { approval: cfg.approval }),
    ...(cfg?.maxSteps !== undefined && { maxSteps: cfg.maxSteps }),
    ...(cfg?.depth !== undefined && { depth: cfg.depth }),
    ...(cfg?.defaultType !== undefined && { defaultType: cfg.defaultType }),
    ...(cfg?.types && { types: cfg.types }),
  });
  applyToolPrompts([task], toolPrompts);
  return [...base, task];
}

/** 系统提示词:--system-prompt 整段替换,--append-system-prompt 追加;否则 角色 → 环境 → 项目指令。 */
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
    // instructionsAs = user:项目指令与记忆作为首条 user 消息进日志。
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
