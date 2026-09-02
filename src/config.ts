// 供应商配置:哪家、什么协议、key 从哪来、模型名怎么匹配到家。
// key 只从配置文件字段或环境变量读取,内核不持久化、不打印。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Provider } from "./provider.js";
import { openaiCompat } from "./provider.js";
import { anthropic } from "./providers/anthropic.js";

export type ProviderConfig = {
  protocol: "openai" | "anthropic";
  baseUrl: string;
  /** 直接写在配置里的 key(可选;推荐用 apiKeyEnv)。 */
  apiKey?: string;
  /** 存放 key 的环境变量名。 */
  apiKeyEnv?: string;
  /** 该家已知的模型名;用于按模型名匹配供应商。 */
  models: string[];
  contextWindow?: number;
  maxTokens?: number;
};

export type KernelConfig = {
  /** 缺省模型;命令行 --model 可覆盖。 */
  default: string;
  providers: Record<string, ProviderConfig>;
};

export const DEFAULT_CONFIG_PATH = join(homedir(), ".agent-kernel", "config.json");

export const CONFIG_TEMPLATE: KernelConfig = {
  default: "deepseek-chat",
  providers: {
    deepseek: {
      protocol: "openai",
      baseUrl: "https://api.deepseek.com",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      models: ["deepseek-chat", "deepseek-reasoner"],
      contextWindow: 131072,
    },
    anthropic: {
      protocol: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
      contextWindow: 200000,
      maxTokens: 8192,
    },
    openai: {
      protocol: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKeyEnv: "OPENAI_API_KEY",
      models: ["gpt-5", "gpt-5-mini"],
      contextWindow: 400000,
    },
  },
};

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
    throw new Error(`配置文件解析失败 ${path}: ${(err as Error).message}`);
  }
  return { config: validate(parsed, path), created: false };
}

function validate(raw: unknown, path: string): KernelConfig {
  const c = raw as Partial<KernelConfig>;
  if (!c || typeof c !== "object" || typeof c.default !== "string" || !c.providers) {
    throw new Error(`配置文件缺少 default 或 providers 字段: ${path}`);
  }
  for (const [name, p] of Object.entries(c.providers)) {
    if (p.protocol !== "openai" && p.protocol !== "anthropic") {
      throw new Error(`供应商 ${name} 的 protocol 必须是 openai 或 anthropic`);
    }
    if (typeof p.baseUrl !== "string" || !Array.isArray(p.models)) {
      throw new Error(`供应商 ${name} 缺少 baseUrl 或 models`);
    }
  }
  return c as KernelConfig;
}

export type Resolved = {
  providerName: string;
  provider: ProviderConfig;
  model: string;
  contextWindow: number;
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
    if (!p) throw new Error(`未知供应商 "${pn}",可选:${entries.map(([n]) => n).join(", ")}`);
    return finish(pn, p, name.slice(slash + 1));
  }

  const listed = entries.find(([, p]) => p.models.includes(name));
  if (listed) return finish(listed[0], listed[1], name);

  const guess = entries.find(([pn, p]) => {
    if (name.startsWith("claude-")) return p.protocol === "anthropic";
    if (name.startsWith("deepseek-")) return pn === "deepseek" || p.baseUrl.includes("deepseek");
    if (name.startsWith("gpt-") || /^o\d/.test(name)) return p.baseUrl.includes("openai.com");
    return false;
  });
  if (guess) return finish(guess[0], guess[1], name);

  const all = entries.flatMap(([pn, p]) => p.models.map((m) => `${pn}/${m}`));
  throw new Error(`无法为模型 "${name}" 匹配供应商。已配置的模型:\n  ${all.join("\n  ")}`);

  function finish(pn: string, p: ProviderConfig, model: string): Resolved {
    return { providerName: pn, provider: p, model, contextWindow: p.contextWindow ?? 128000 };
  }
}

/** 取 key:配置字段优先,其次环境变量。缺失时的报错要告诉用户该去哪里填。 */
export function resolveApiKey(name: string, p: ProviderConfig, env = process.env): string {
  if (p.apiKey?.trim()) return p.apiKey.trim();
  if (p.apiKeyEnv) {
    const v = env[p.apiKeyEnv];
    if (v?.trim()) return v.trim();
  }
  const where = p.apiKeyEnv
    ? `环境变量 ${p.apiKeyEnv},或配置文件 providers.${name}.apiKey`
    : `配置文件 providers.${name}.apiKey 或 apiKeyEnv`;
  throw new Error(`供应商 ${name} 没有可用的 API key。请设置:${where}(${DEFAULT_CONFIG_PATH})`);
}

export function createProvider(r: Resolved, apiKey: string): Provider {
  if (r.provider.protocol === "anthropic") {
    return anthropic({
      baseUrl: r.provider.baseUrl,
      apiKey,
      model: r.model,
      ...(r.provider.maxTokens && { maxTokens: r.provider.maxTokens }),
    });
  }
  return openaiCompat({ baseUrl: r.provider.baseUrl, apiKey, model: r.model });
}
