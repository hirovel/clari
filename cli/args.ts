import { type ApprovalConfig, DEFAULT_APPROVAL } from "../src/approval.js";
import { keepRatio, keepRecentTokens, type PreservationPolicy } from "../src/compaction.js";
import {
  DEFAULT_CONFIG_PATH,
  type KernelConfig,
  type Preset,
  type PromptSectionName,
  type ToolPromptStyle,
  type ToolPromptsConfig,
} from "../src/config.js";
import type { ExecutionPolicy } from "../src/loop.js";
import { EFFORT_LEVELS, type EffortLevel, parseEffort } from "../src/provider.js";
import { isToolPromptStyle } from "./tool-prompts.js";

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
  /** 审批槽(Q23/Q64/Q84):all(缺省)= 不问;policy = 按规则裁决,ask 的才问人;ask = 每个调用都问。 */
  approve: "all" | "ask" | "policy";
  /** 工具描述风格槽(Q89):命令行 > 预设 > 配置 > guided。 */
  toolPrompts?: ToolPromptStyle;
  /** 插话槽(Q78):step 缺省;turn = 留言等到模型停止调用工具。 */
  steering?: "step" | "turn";
  /** 保留策略(Q78):"tokens N" 或 "ratio X";不给用内置缺省。 */
  preservation?: string;
  /** 预设里的审批规则(Q84);没有就用配置的,再没有就用内置缺省。 */
  approval?: ApprovalConfig;
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
  traceExplicit?: boolean;
  foldExplicit?: boolean;
};

/** 保留策略的文字形态 → 实现与显示名(Q78/Q90):配置、预设、命令行、/preservation 共用一种写法。 */
export function parsePreservation(spec: string): { policy: PreservationPolicy; label: string } {
  const m = spec.trim().match(/^(tokens|ratio)\s+([\d.]+)$/);
  if (!m) throw new Error(`preservation must be "tokens N" or "ratio X", got "${spec}"`);
  const n = Number(m[2]);
  if (m[1] === "tokens") {
    if (!(n > 0)) throw new Error("preservation tokens must be positive");
    return { policy: keepRecentTokens(n), label: `keepRecentTokens(${n})` };
  }
  if (n <= 0 || n >= 1) throw new Error("preservation ratio must be between 0 and 1");
  return { policy: keepRatio(n), label: `keepRatio(${n})` };
}

/** 审批槽的启动形态(Q84):all / ask 原样;policy = 预设规则 → 配置规则 → 内置缺省。 */
export function resolveApproval(
  args: CommonArgs,
  config: KernelConfig,
): "all" | "ask" | ApprovalConfig {
  if (args.approve !== "policy") return args.approve;
  return args.approval ?? config.approval ?? DEFAULT_APPROVAL;
}

/** 工具描述风格的启动形态(Q89):风格按优先级取,逐工具覆盖只来自配置。 */
export function resolveToolPrompts(args: CommonArgs, config: KernelConfig): ToolPromptsConfig {
  return {
    style: args.toolPrompts ?? config.toolPrompts?.style ?? "guided",
    ...(config.toolPrompts?.descriptions && { descriptions: config.toolPrompts.descriptions }),
  };
}

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
    if (v === undefined) throw new Error(`${name} requires a value`);
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
        if (!level) {
          throw new Error(`unknown effort level "${v}"; choices: ${EFFORT_LEVELS.join(" ")}`);
        }
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
        out.traceExplicit = true;
        break;
      case "--no-trace":
        out.trace = false;
        out.traceExplicit = true;
        break;
      case "--fold":
        out.fold = true;
        out.foldExplicit = true;
        break;
      case "--steering": {
        const v = takeValue(i++, a);
        if (v !== "step" && v !== "turn")
          throw new Error(`--steering accepts step or turn, got "${v}"`);
        out.steering = v;
        break;
      }
      case "--preservation": {
        const v = takeValue(i++, a);
        parsePreservation(v);
        out.preservation = v;
        break;
      }
      case "--json":
        out.json = true;
        break;
      case "--approve": {
        const v = takeValue(i++, a);
        if (v !== "all" && v !== "ask" && v !== "policy")
          throw new Error(`--approve accepts all, ask or policy, got "${v}"`);
        out.approve = v;
        out.approveExplicit = true;
        break;
      }
      case "--tool-prompts": {
        const v = takeValue(i++, a);
        if (!isToolPromptStyle(v))
          throw new Error(`--tool-prompts accepts guided, terse or strict, got "${v}"`);
        out.toolPrompts = v;
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
            throw new Error(
              `unknown prompt section "${n}"; choices: ${PROMPT_SECTION_NAMES.join(" ")}`,
            );
          }
        }
        out.promptSections = names as PromptSectionName[];
        break;
      }
      case "--instructions-as": {
        const v = takeValue(i++, a);
        if (v !== "system" && v !== "user")
          throw new Error("--instructions-as accepts system or user");
        out.instructionsAs = v;
        break;
      }
      case "--execution": {
        const v = takeValue(i++, a);
        if (v !== "sequential" && v !== "parallel")
          throw new Error(`--execution accepts sequential or parallel, got "${v}"`);
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
        if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
        out.rest.push(a);
    }
  }
  return out;
}

export const USAGE = `Usage
  clari [options]                      interactive UI          (from source: pnpm tui -- [options])
  clari once "task" [options]          one-shot mode: run one turn and exit; stdout is the reply
  clari replay <session.jsonl> [--request N] [--compaction N [--json]] [--messages]

Options
  --model provider/model         default: the config's default model
  --effort off|low|medium|high|xhigh|max   default: not sent, provider default applies
  --compaction llm|clear|pipeline|./strategy.mjs   default llm
  --resume <session file> | --continue   resume a session and keep appending to the same file
  --system-prompt <file> | --append-system-prompt <file>
  --approve all|policy|ask       all (default, pi stance) = never ask; policy = allow/deny rules from config, ask when no rule matches; ask = every call
  --tool-prompts guided|terse|strict   tool description style (default guided); edit single descriptions with /toolprompts edit <tool>
  --preset name                  apply the parameter set presets.name from config; explicit flags still win
  --memory | --no-memory         cross-session memory (memory section in AGENTS.md + remember tool); default off
  --prompt-sections role,env,instructions,memory,skills,append   which system prompt sections, in which order
  --instructions-as system|user  put project instructions and memory in system (default) or in the first user message
  --execution sequential|parallel  tool execution slot: default one at a time; parallel = adjacent read-only calls run together
  --steering step|turn           steering slot: step (default) injects queued messages at the next step; turn waits until the model stops calling tools
  --preservation "tokens N|ratio X"   what compaction keeps verbatim; default tokens min(20000, window/4)
  --extension <module.mjs>       load an extension module (repeatable): add tools, replace slot implementations
  --max-steps N                  termination guard (default: no limit)
  --subagent                     add the task tool (sub-agents)
  --no-trace                     do not record the raw stream (default: every received line is written to <session>.trace.jsonl; view with /raw N)
  --fold                         tool results start folded (Ctrl+O toggles)
  --json                         one-shot mode: print a structured result
  --events                       one-shot mode: write every event to stdout as a JSON line
  -h, --help

Config
  ${DEFAULT_CONFIG_PATH}
  CLARI_CONFIG overrides the path; keys come from the env var named by apiKeyEnv, or /key provider secret in the UI
  every option above has a config counterpart: defaults.<name> is the global default, presets.<name>.<option> a named set; flags > preset > defaults > built-in
  clari sessions [--dir D]        list session files; clari sessions prune --older-than 30d | --keep N [--yes]
  session files default to ./sessions/; override with sessionsDir in config or CLARI_SESSIONS
  prompt templates: ~/.clari/prompts/*.md and <git root>/.clari/prompts/*.md; /name args in the UI
  skills: ~/.clari/skills/<name>/SKILL.md and <git root>/.agents/skills/<name>/SKILL.md; listed in the system prompt's skills section`;

export function applyPreset(args: CommonArgs, config: KernelConfig): CommonArgs {
  const out: CommonArgs = { ...args };
  const preset = args.preset ? config.presets?.[args.preset] : undefined;
  if (args.preset && !preset) {
    throw new Error(
      `no preset "${args.preset}" in config; choices: ${Object.keys(config.presets ?? {}).join(" ") || "(none)"}`,
    );
  }
  // 解析顺序(Q90):命令行 > 预设 > 配置 defaults > 内置缺省。有内置缺省的字段靠 *Explicit 与 settled 判断"还没人定"。
  const settled = new Set<string>();
  const open = (field: string, explicit: boolean | undefined) => !explicit && !settled.has(field);
  const applyLayer = (layer: Preset, label: string) => {
    if (out.model === undefined && layer.model) out.model = layer.model;
    if (out.effort === undefined && layer.effort) {
      const level = parseEffort(layer.effort);
      if (!level) throw new Error(`${label} has invalid effort "${layer.effort}"`);
      out.effort = level;
    }
    if (open("compaction", args.compactionExplicit) && layer.compaction) {
      out.compaction = layer.compaction;
      settled.add("compaction");
    }
    if (open("approve", args.approveExplicit) && layer.approve) {
      out.approve = layer.approve;
      settled.add("approve");
    }
    if (open("subagent", args.subagentExplicit) && layer.subagent !== undefined) {
      out.subagent = layer.subagent;
      settled.add("subagent");
    }
    if (open("trace", args.traceExplicit) && layer.trace !== undefined) {
      out.trace = layer.trace;
      settled.add("trace");
    }
    if (open("fold", args.foldExplicit) && layer.fold !== undefined) {
      out.fold = layer.fold;
      settled.add("fold");
    }
    if (out.toolPrompts === undefined && layer.toolPrompts) out.toolPrompts = layer.toolPrompts;
    if (out.approval === undefined && layer.approval) out.approval = layer.approval;
    if (out.systemPromptFile === undefined && layer.systemPromptFile)
      out.systemPromptFile = layer.systemPromptFile;
    if (out.appendSystemPromptFile === undefined && layer.appendSystemPromptFile)
      out.appendSystemPromptFile = layer.appendSystemPromptFile;
    if (out.maxSteps === undefined && layer.maxSteps !== undefined) out.maxSteps = layer.maxSteps;
    if (out.execution === undefined && layer.execution) out.execution = layer.execution;
    if (out.steering === undefined && layer.steering) out.steering = layer.steering;
    if (out.preservation === undefined && layer.preservation) {
      parsePreservation(layer.preservation);
      out.preservation = layer.preservation;
    }
    if (out.extensions.length === 0 && layer.extensions) out.extensions = [...layer.extensions];
  };
  if (preset) applyLayer(preset, `preset ${args.preset}`);
  if (config.defaults) applyLayer(config.defaults, "config defaults");
  // prompt 段的三层同样按 预设 > defaults > 配置顶层 prompt 合并;命令行给了的字段不动。
  const prompt = { ...config.prompt, ...config.defaults?.prompt, ...preset?.prompt };
  if (out.memory === undefined && prompt.memory !== undefined) out.memory = prompt.memory;
  if (out.promptSections === undefined && prompt.sections) out.promptSections = prompt.sections;
  if (out.instructionsAs === undefined && prompt.instructionsAs) {
    out.instructionsAs = prompt.instructionsAs;
  }
  const skills = {
    ...config.prompt?.skills,
    ...config.defaults?.prompt?.skills,
    ...preset?.prompt?.skills,
  };
  if (skills.list) out.skillsList = skills.list;
  if (skills.load) out.skillsLoad = skills.load;
  return out;
}
