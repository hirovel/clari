// 供应商配置:哪家、什么协议、key 从哪来、模型名怎么匹配到家,以及每个模型的能力数据。
// 分层原则:协议形状写在适配器代码里(多年不变);模型名、窗口、强度集合、thinking 模式是数据,放这里;
// API 新增的参数用 extraBody / extraHeaders 逐字透传,不必等代码。key 只从配置字段或环境变量读取。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ApprovalConfig } from "./approval.js";
import type { CompactionTrigger } from "./loop.js";
import type { EffortLevel, OpenAIDialect, Provider } from "./provider.js";
import { openaiCompat } from "./provider.js";
import { anthropic, type ThinkingMode } from "./providers/anthropic.js";
import { openaiResponses } from "./providers/openai-responses.js";
import type { SubagentApproval, SubagentType } from "./subagent.js";
import type { DescriptionLevel } from "./tools.js";

/** 每百万 token 的价格(美元)。缺哪项就不计哪项;整个缺省 = 不显示费用。 */
export type ModelPrice = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/** 单个模型的能力数据。字符串形式等价于只有 name。 */
export type ModelConfig = {
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  /** 支持的强度级别;请求了不支持的会向下回退。不写 = 不校验。 */
  effortLevels?: EffortLevel[];
  /** Anthropic:adaptive(4.7+/5 系)或 budget(4.6 及更早)。 */
  thinkingMode?: ThinkingMode;
  /** 逐字合并进请求正文。 */
  extraBody?: Record<string, unknown>;
  /** 价格数据,只用于显示费用;变价是常态,verifiedAt 标核对日期。 */
  price?: ModelPrice;
};

export type ProviderConfig = {
  /** openai = chat completions(DeepSeek、多数中转站);openai-responses = GPT 系推理摘要可见的那条;anthropic = Messages。 */
  protocol: "openai" | "openai-responses" | "anthropic";
  /** openai-responses:推理摘要档位,缺省 auto;none 不要摘要。 */
  reasoningSummary?: "auto" | "concise" | "detailed" | "none";
  baseUrl: string;
  /** 直接写在配置里的 key:演示与脚本用;正常用法是 /login 写进凭据文件,或 apiKeyEnv。 */
  apiKey?: string;
  /** 存放 key 的环境变量名。 */
  apiKeyEnv?: string;
  /** 该家的模型;字符串或带能力数据的对象。用于按模型名匹配供应商。 */
  models: (string | ModelConfig)[];
  /** 供应商级缺省,模型级可覆盖。 */
  contextWindow?: number;
  maxTokens?: number;
  /** thinking 模型的推理字段名(DeepSeek 为 reasoning_content),带工具多轮时必须原样回传。 */
  reasoningField?: string;
  /** openai 协议的方言:强度参数写法不同。 */
  dialect?: OpenAIDialect;
  thinkingMode?: ThinkingMode;
  effortLevels?: EffortLevel[];
  extraBody?: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  /** Anthropic 提示缓存断点,缺省开;中转站不支持时关。 */
  promptCache?: boolean;
  /** 流停滞判定毫秒数,缺省 90000;0 = 不限。 */
  stallTimeoutMs?: number;
  /** 重试参数;缺省 2 次、500ms 起、×2 退避、上限 8s(与两大官方 SDK 一致)。 */
  retry?: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number };
};

/** 工具描述风格 = 拼接层级:brief 只有核心;explain(缺省)加指导;rules 再加 ALWAYS / NEVER 规则。descriptions 逐工具覆盖。 */
export type ToolPromptStyle = DescriptionLevel;
export type ToolPromptsConfig = {
  style?: ToolPromptStyle;
  descriptions?: Record<string, string>;
};

/** 系统提示词的段名:哪几段、什么顺序由配置或预设决定。 */
export type PromptSectionName = "role" | "env" | "instructions" | "memory" | "skills" | "append";

export type PromptConfig = {
  /** 要哪几段、什么顺序;缺省 role, env, instructions, memory, skills, append。 */
  sections?: PromptSectionName[];
  /** 项目指令与记忆放 system(缺省)还是首条 user 消息。 */
  instructionsAs?: "system" | "user";
  /** 跨会话记忆:缺省关。开了才读 AGENTS.md 里的记忆节并装上 remember 工具。 */
  memory?: boolean;
  /**
   * 技能两个旋钮。list:清单放系统提示词(缺省 system)还是不放(none,只许用户 /名 触发)。
   * load:模型触发时怎么拿正文,read = 自己用 read 读 SKILL.md(缺省),tool = 装一个 skill 工具,正文作为工具结果返回。
   * 用户触发固定为一条 user 消息。
   */
  skills?: { list?: "system" | "none"; load?: "read" | "tool" };
};

/**
 * 预设:一组命名好的启动参数,`--preset 名`。命令行显式给的参数仍然优先。
 * 指令文件在这里当"预设指令器":不同预设指向不同的 system-prompt / append 文件与段组合。
 */
export type Preset = {
  model?: string;
  effort?: string;
  compaction?: string;
  /** all = 不问;ask = 每个调用都问;policy(缺省)= 按 approval 规则。 */
  approve?: "all" | "ask" | "policy";
  /** 审批规则,覆盖全局的 approval。 */
  approval?: ApprovalConfig;
  /** 执行槽:sequential(缺省)| parallel。 */
  execution?: "sequential" | "parallel";
  /** 插话槽:step(缺省,下一步就注入)| turn(等模型停止调用工具)。 */
  steering?: "step" | "turn";
  /** 保留策略:"tokens 20000" 或 "ratio 0.3";缺省 keepRecentTokens(min(20000, window/4))。 */
  preservation?: string;
  /** 压缩触发:threshold(缺省,到阈值自动压)| manual(只在 /compact)| remind(到阈值只提示)。 */
  compactionTrigger?: CompactionTrigger;
  /** 自动压缩阈值 = 窗口 − 这个余量;缺省 32000。 */
  compactionReserve?: number;
  /** 是否记录原始流到 <session>.trace.jsonl;缺省 true。 */
  trace?: boolean;
  /** 工具结果初始折叠;缺省 false。 */
  fold?: boolean;
  /** 扩展模块路径列表。 */
  extensions?: string[];
  systemPromptFile?: string;
  appendSystemPromptFile?: string;
  subagent?: boolean;
  maxSteps?: number;
  prompt?: PromptConfig;
  /** 工具描述风格。 */
  toolPrompts?: ToolPromptStyle;
};

export type KernelConfig = {
  /** 缺省模型;命令行 --model 可覆盖。 */
  default: string;
  /** 模板里的能力数据核对日期。过期是常态,发现靠 /models。 */
  verifiedAt?: string;
  providers: Record<string, ProviderConfig>;
  /** 系统提示词组装的全局缺省。 */
  prompt?: PromptConfig;
  /**
   * 全局缺省:与预设同形,每个可选项都能写在这里。解析顺序 命令行 > --preset 指的预设 > defaults > 内置缺省。
   * 模板把每个旋钮的内置缺省值都列出来,改哪个就改哪个。
   */
  defaults?: Preset;
  /** 命名预设。 */
  presets?: Record<string, Preset>;
  /** 会话文件目录;缺省工作目录下的 sessions/。环境变量 CLARI_SESSIONS 优先。 */
  sessionsDir?: string;
  /** 审批规则:缺省只读工具放行、其余问人、cwd 之外必问。 */
  approval?: ApprovalConfig;
  /** 工具描述风格与逐工具覆盖。 */
  toolPrompts?: ToolPromptsConfig;
  /** 子 agent(task 工具)的设置;开关本身在 defaults.subagent / --subagent。 */
  subagents?: SubagentsConfig;
  /** MCP 桥接的配置。内核不解释它;形状归 cli/mcp/config.ts。 */
  mcp?: Record<string, unknown>;
  /** fetch 工具的安全边界:私网放行、超时、字节上限、重定向次数。 */
  fetch?: {
    allowPrivate?: boolean;
    timeoutMs?: number;
    maxBytes?: number;
    maxRedirects?: number;
    userAgent?: string;
    /** 会话内缓存存活毫秒数,缺省 15 分钟;0 关。 */
    cacheTtlMs?: number;
    /** 每主机每分钟最多几次真实请求,缺省 10;0 不限。 */
    perHostPerMinute?: number;
  };
};

export type SubagentsConfig = {
  /** 子的工具调用怎么过审:inherit(缺省)沿用父的;allow 不问;{ deny: [...] } 在父的基础上再收紧。 */
  approval?: SubagentApproval;
  /** 子的步数上限;不给就不设上限,靠续聊与人的打断。 */
  maxSteps?: number;
  /** 嵌套深度,缺省 1:子没有 task 工具。 */
  depth?: number;
  /** 缺省类型,缺省 default。 */
  defaultType?: string;
  /** 类型注册表:名 → 说明、系统提示词、工具子集、模型、缺省范围、步数上限;叠在内置 default 之上。 */
  types?: Record<string, SubagentType>;
};

/** 用户目录:环境变量 CLARI_HOME 指定,否则 ~/.clari。 */
export function clariHome(env = process.env): string {
  return env.CLARI_HOME?.trim() || join(homedir(), ".clari");
}

/** 配置文件路径;环境变量 CLARI_CONFIG 可改(多套配置、测试用)。 */
export const DEFAULT_CONFIG_PATH =
  process.env.CLARI_CONFIG?.trim() || join(clariHome(), "config.json");

export const CONFIG_TEMPLATE: KernelConfig = {
  default: "deepseek-v4-pro",
  verifiedAt: "2026-09-02",
  // 每个可选项的内置缺省值。命令行与预设可以覆盖;删掉某一项等于用内置缺省。
  defaults: {
    compaction: "llm",
    compactionTrigger: "threshold",
    compactionReserve: 32000,
    approve: "all",
    execution: "sequential",
    steering: "step",
    toolPrompts: "explain",
    subagent: false,
    trace: true,
    fold: false,
    prompt: {
      sections: ["role", "env", "instructions", "memory", "skills", "append"],
      instructionsAs: "system",
      memory: false,
      skills: { list: "system", load: "read" },
    },
  },
  subagents: {
    approval: "inherit",
    depth: 1,
    defaultType: "default",
    types: {},
  },
  providers: {
    deepseek: {
      protocol: "openai",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      dialect: "deepseek",
      reasoningField: "reasoning_content",
      contextWindow: 131072,
      models: [
        { name: "deepseek-v4-pro", effortLevels: ["off", "low", "high", "max"] },
        { name: "deepseek-v4-flash", effortLevels: ["off", "low", "high", "max"] },
      ],
    },
    anthropic: {
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      contextWindow: 200000,
      // 思考与正文共用这个上限;5 系模型思考常开,给足。
      maxTokens: 16384,
      models: [
        { name: "claude-opus-5", effortLevels: ["off", "low", "medium", "high", "xhigh", "max"] },
        { name: "claude-sonnet-5", effortLevels: ["off", "low", "medium", "high", "xhigh", "max"] },
        {
          name: "claude-haiku-4-5-20251001",
          thinkingMode: "budget",
          effortLevels: ["off", "low", "medium", "high"],
        },
      ],
    },
    openai: {
      // GPT 系走 Responses 协议:推理摘要可见,推理正文加密回传;中转站多数只支持 chat completions,另起一条 protocol: openai。
      protocol: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      reasoningSummary: "auto",
      contextWindow: 400000,
      models: [
        { name: "gpt-5.5", effortLevels: ["off", "low", "medium", "high", "xhigh"] },
        { name: "gpt-5.6", effortLevels: ["off", "low", "medium", "high", "xhigh", "max"] },
      ],
    },
  },
};

/** 模型名列表(兼容字符串与对象两种写法)。 */
export function modelNames(p: ProviderConfig): string[] {
  return p.models.map((m) => (typeof m === "string" ? m : m.name));
}

/** 某模型的能力数据;字符串写法或未列出的模型返回只有 name 的对象。 */
export function modelConfig(p: ProviderConfig, name: string): ModelConfig {
  const found = p.models.find((m) => (typeof m === "string" ? m : m.name) === name);
  return typeof found === "object" ? found : { name };
}

/** 读配置;文件不存在时写入模板并返回它(key 字段留空,由用户填)。 */
export function loadConfig(path = DEFAULT_CONFIG_PATH): { config: KernelConfig; created: boolean } {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, "utf8");
    return { config: CONFIG_TEMPLATE, created: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`failed to parse config ${path}: ${(err as Error).message}`);
  }
  return { config: validate(parsed, path), created: false };
}

export function saveConfig(config: KernelConfig, path = DEFAULT_CONFIG_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** 凭据文件:~/.clari/credentials.json,环境变量 CLARI_CREDENTIALS 可改。key 只进这里,配置文件里不出现。 */
export function credentialsPath(env = process.env): string {
  return env.CLARI_CREDENTIALS?.trim() || join(clariHome(env), "credentials.json");
}

export type Credentials = Record<string, { apiKey: string }>;

export function loadCredentials(path = credentialsPath()): Credentials {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`failed to parse credentials ${path}: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object")
    throw new Error(`credentials is not an object: ${path}`);
  const out: Credentials = {};
  for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
    const key = (v as { apiKey?: unknown } | null)?.apiKey;
    if (typeof key === "string" && key.trim()) out[name] = { apiKey: key.trim() };
  }
  return out;
}

/** 写入一家的 key(合并已有),文件权限 0600。 */
export function saveCredential(
  providerName: string,
  apiKey: string,
  path = credentialsPath(),
): void {
  const next = { ...loadCredentials(path), [providerName]: { apiKey: apiKey.trim() } };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export type KeySource = "env" | "credentials" | "config";

/** key 从哪来:环境变量 > 凭据文件 > 配置里的 apiKey(演示与脚本用)。没有返回 undefined。 */
export function findApiKey(
  name: string,
  p: ProviderConfig,
  env = process.env,
  credentials?: Credentials,
): { key: string; source: KeySource } | undefined {
  if (p.apiKeyEnv) {
    const v = env[p.apiKeyEnv];
    if (v?.trim()) return { key: v.trim(), source: "env" };
  }
  const creds = credentials ?? loadCredentials(credentialsPath(env));
  const stored = creds[name]?.apiKey;
  if (stored) return { key: stored, source: "credentials" };
  if (p.apiKey?.trim()) return { key: p.apiKey.trim(), source: "config" };
  return undefined;
}

/** 写入某供应商的 key(TUI 的 /login 与 /key 用):进凭据文件,不碰配置。返回配置原样。 */
export function setApiKey(
  config: KernelConfig,
  providerName: string,
  apiKey: string,
  path = credentialsPath(),
): KernelConfig {
  if (!config.providers[providerName]) {
    throw new Error(
      `unknown provider "${providerName}"; options: ${Object.keys(config.providers).join(", ")}`,
    );
  }
  saveCredential(providerName, apiKey, path);
  return config;
}

/** 修改缺省模型并落盘。 */
export function setDefaultModel(
  config: KernelConfig,
  model: string,
  path = DEFAULT_CONFIG_PATH,
): KernelConfig {
  const next = { ...config, default: model };
  saveConfig(next, path);
  return next;
}

function validate(raw: unknown, path: string): KernelConfig {
  const c = raw as Partial<KernelConfig>;
  if (!c || typeof c !== "object" || typeof c.default !== "string" || !c.providers) {
    throw new Error(`config is missing default or providers: ${path}`);
  }
  for (const [name, p] of Object.entries(c.providers)) {
    if (
      p.protocol !== "openai" &&
      p.protocol !== "anthropic" &&
      p.protocol !== "openai-responses"
    ) {
      throw new Error(`provider ${name}: protocol must be openai, openai-responses or anthropic`);
    }
    if (typeof p.baseUrl !== "string" || !Array.isArray(p.models)) {
      throw new Error(`provider ${name} is missing baseUrl or models`);
    }
    for (const m of p.models) {
      const ok = typeof m === "string" || (typeof m === "object" && typeof m?.name === "string");
      if (!ok)
        throw new Error(`provider ${name}: models entries must be strings or objects with a name`);
    }
  }
  return c as KernelConfig;
}

export type Resolved = {
  providerName: string;
  provider: ProviderConfig;
  model: string;
  contextWindow: number;
  maxTokens?: number;
  effortLevels?: EffortLevel[];
  thinkingMode?: ThinkingMode;
  extraBody?: Record<string, unknown>;
  price?: ModelPrice;
};

/**
 * 模型名 → 供应商。三级匹配:①"供应商/模型" 显式写法;②某家 models 列表包含该名;
 * ③按前缀猜(claude-* → anthropic 协议的那家,deepseek-* / gpt-* 同理)。都不中就报错并列出可选项。
 */
export function resolveModel(config: KernelConfig, requested?: string): Resolved {
  const name = requested ?? config.default;
  const entries = Object.entries(config.providers);

  const slash = name.indexOf("/");
  if (slash > 0) {
    const pn = name.slice(0, slash);
    const p = config.providers[pn];
    if (!p)
      throw new Error(`unknown provider "${pn}"; options: ${entries.map(([n]) => n).join(", ")}`);
    return finish(pn, p, name.slice(slash + 1));
  }

  const listed = entries.find(([, p]) => modelNames(p).includes(name));
  if (listed) return finish(listed[0], listed[1], name);

  const guess = entries.find(([pn, p]) => {
    if (name.startsWith("claude-")) return p.protocol === "anthropic";
    if (name.startsWith("deepseek-")) return pn === "deepseek" || p.baseUrl.includes("deepseek");
    if (name.startsWith("gpt-") || /^o\d/.test(name)) return p.baseUrl.includes("openai.com");
    return false;
  });
  if (guess) return finish(guess[0], guess[1], name);

  const all = entries.flatMap(([pn, p]) => modelNames(p).map((m) => `${pn}/${m}`));
  throw new Error(`no provider matches model "${name}". Configured models:\n  ${all.join("\n  ")}`);

  function finish(pn: string, p: ProviderConfig, model: string): Resolved {
    const m = modelConfig(p, model);
    const maxTokens = m.maxTokens ?? p.maxTokens;
    const effortLevels = m.effortLevels ?? p.effortLevels;
    const thinkingMode = m.thinkingMode ?? p.thinkingMode;
    const extraBody = p.extraBody || m.extraBody ? { ...p.extraBody, ...m.extraBody } : undefined;
    return {
      providerName: pn,
      provider: p,
      model,
      contextWindow: m.contextWindow ?? p.contextWindow ?? 128000,
      ...(maxTokens !== undefined && { maxTokens }),
      ...(effortLevels && { effortLevels }),
      ...(thinkingMode && { thinkingMode }),
      ...(extraBody && { extraBody }),
      ...(m.price && { price: m.price }),
    };
  }
}

/** 取 key:配置字段优先,其次环境变量。缺失时的报错要告诉用户该去哪里填。 */
export function resolveApiKey(name: string, p: ProviderConfig, env = process.env): string {
  const found = findApiKey(name, p, env);
  if (found) return found.key;
  const where = p.apiKeyEnv ? `set env var ${p.apiKeyEnv}, ` : "";
  throw new Error(
    `no API key for provider ${name}. Run /login in the TUI, ${where}or add it to ${credentialsPath(env)}`,
  );
}

export function createProvider(r: Resolved, apiKey: string): Provider {
  // 手工构造的 Resolved 可能只填了供应商级字段,这里统一回落。
  const effortLevels = r.effortLevels ?? r.provider.effortLevels;
  const extraBody = r.extraBody ?? r.provider.extraBody;
  const maxTokens = r.maxTokens ?? r.provider.maxTokens;
  const thinkingMode = r.thinkingMode ?? r.provider.thinkingMode;
  const shared = {
    apiKey,
    model: r.model,
    ...(effortLevels && { effortLevels }),
    ...(extraBody && { extraBody }),
    ...(r.provider.extraHeaders && { extraHeaders: r.provider.extraHeaders }),
    ...(r.provider.stallTimeoutMs !== undefined && { stallTimeoutMs: r.provider.stallTimeoutMs }),
    ...(r.provider.retry && { retry: r.provider.retry }),
    ...(maxTokens !== undefined && { maxTokens }),
  };
  if (r.provider.protocol === "anthropic") {
    return anthropic({
      baseUrl: r.provider.baseUrl,
      ...shared,
      ...(thinkingMode && { thinkingMode }),
      ...(r.provider.promptCache !== undefined && { promptCache: r.provider.promptCache }),
    });
  }
  if (r.provider.protocol === "openai-responses") {
    return openaiResponses({
      baseUrl: r.provider.baseUrl,
      ...shared,
      ...(r.provider.reasoningSummary && { reasoningSummary: r.provider.reasoningSummary }),
    });
  }
  return openaiCompat({
    baseUrl: r.provider.baseUrl,
    ...shared,
    ...(r.provider.reasoningField && { reasoningField: r.provider.reasoningField }),
    ...(r.provider.dialect && { dialect: r.provider.dialect }),
  });
}
