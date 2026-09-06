// 模型登记簿:models.dev 的公开清单(opencode 与 pi 都用它),给"服务器上有、配置里没有"的模型补能力数据。
// 配置仍持真相:登记簿只在把一个模型写进配置的那一刻用一次,写进去的值以后归用户改。
// 三级回退:models.dev 命中 → 抄最像的已配置模型(最长公共前缀)→ 保守假设 64k,每一级都在行上标出处。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clariHome, type ModelConfig, type ProviderConfig } from "../src/config.js";
import type { EffortLevel } from "../src/provider.js";

export const REGISTRY_URL = "https://models.dev/api.json";
/** 缓存有效期:一天。过期后后台重取,取不到就继续用旧的。 */
export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;

export type RegistryModel = {
  id: string;
  name?: string;
  reasoning?: boolean;
  reasoning_options?: { type: string; values?: string[] }[];
  tool_call?: boolean;
  limit?: { context?: number; output?: number };
  /** 每百万 token 的美元。 */
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
};

export type Registry = Record<
  string,
  { id?: string; api?: string; env?: string[]; models?: Record<string, RegistryModel> }
>;

export function registryCachePath(env = process.env): string {
  return join(clariHome(env), "models.dev.json");
}

/**
 * 取登记簿:缓存新鲜就直接用;否则联网取并写缓存;联网失败退回旧缓存;都没有返回 undefined。
 * 4 秒超时,不阻塞登录对话框太久。
 */
export async function fetchRegistry(
  opts: { cachePath?: string; ttlMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<Registry | undefined> {
  const path = opts.cachePath ?? registryCachePath();
  const ttl = opts.ttlMs ?? REGISTRY_TTL_MS;
  const cached = readCache(path);
  if (cached && Date.now() - cached.mtime < ttl) return cached.data;
  try {
    const f = opts.fetchImpl ?? fetch;
    const res = await f(REGISTRY_URL, { signal: AbortSignal.timeout(opts.timeoutMs ?? 4000) });
    if (!res.ok) throw new Error(`models.dev ${res.status}`);
    const data = (await res.json()) as Registry;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data), "utf8");
    return data;
  } catch {
    return cached?.data;
  }
}

function readCache(path: string): { data: Registry; mtime: number } | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return {
      data: JSON.parse(readFileSync(path, "utf8")) as Registry,
      mtime: statSync(path).mtimeMs,
    };
  } catch {
    return undefined;
  }
}

/** 我们的供应商名是用户起的;按 baseUrl 的主机认 models.dev 里的 id,认不出就按名字。 */
export function registryProviderId(
  providerName: string,
  p: Pick<ProviderConfig, "baseUrl">,
): string {
  const host = (() => {
    try {
      return new URL(p.baseUrl).hostname;
    } catch {
      return "";
    }
  })();
  if (/deepseek\.com$/.test(host)) return "deepseek";
  if (/openai\.com$/.test(host)) return "openai";
  if (/anthropic\.com$/.test(host)) return "anthropic";
  if (/openrouter\.ai$/.test(host)) return "openrouter";
  return providerName;
}

/** 在登记簿里找一个模型:先按供应商 id,再全库按模型 id 扫。 */
export function lookupModel(
  registry: Registry,
  providerId: string,
  modelId: string,
): RegistryModel | undefined {
  const direct = registry[providerId]?.models?.[modelId];
  if (direct) return direct;
  for (const p of Object.values(registry)) {
    const m = p.models?.[modelId];
    if (m) return m;
  }
  return undefined;
}

const EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max"]);

/** 登记簿条目 → 配置里的模型对象。价格单位一致(每百万 token,美元)。 */
export function modelConfigFromRegistry(modelId: string, m: RegistryModel): ModelConfig {
  const effort = m.reasoning_options
    ?.find((o) => o.type === "effort")
    ?.values?.filter((v): v is EffortLevel => EFFORTS.has(v));
  return {
    name: modelId,
    ...(m.limit?.context && { contextWindow: m.limit.context }),
    ...(m.limit?.output && { maxTokens: m.limit.output }),
    ...(effort && effort.length > 0 && { effortLevels: effort }),
    ...(m.cost?.input !== undefined &&
      m.cost.output !== undefined && {
        price: {
          input: m.cost.input,
          output: m.cost.output,
          ...(m.cost.cache_read !== undefined && { cacheRead: m.cost.cache_read }),
        },
      }),
  };
}

export type Inferred = {
  model: ModelConfig;
  /** 数据从哪来,原样显示在行上。 */
  source: string;
};

/** 假设值:没有任何依据时的保守窗口。宁可早压缩,不要撞 400。 */
export const ASSUMED_CONTEXT = 65536;

/** 最像的已配置模型:最长公共前缀,至少 6 个字符才算像。 */
export function closestConfigured(p: ProviderConfig, modelId: string): ModelConfig | undefined {
  let best: { m: string | ModelConfig; len: number } | undefined;
  for (const m of p.models) {
    const name = typeof m === "string" ? m : m.name;
    let i = 0;
    while (i < name.length && i < modelId.length && name[i] === modelId[i]) i++;
    if (i >= 6 && (!best || i > best.len)) best = { m, len: i };
  }
  if (!best) return undefined;
  return typeof best.m === "string" ? { name: best.m } : best.m;
}

/** 给一个配置里没有的模型推出配置:三级回退,标出处。 */
export function inferModelConfig(
  providerName: string,
  p: ProviderConfig,
  modelId: string,
  registry: Registry | undefined,
): Inferred {
  const hit = registry && lookupModel(registry, registryProviderId(providerName, p), modelId);
  if (hit?.limit?.context)
    return { model: modelConfigFromRegistry(modelId, hit), source: "models.dev" };
  const sibling = closestConfigured(p, modelId);
  if (sibling) {
    const { name: _name, ...rest } = sibling;
    return {
      model: { ...rest, name: modelId },
      source: `copied from ${sibling.name}`,
    };
  }
  return {
    model: { name: modelId, contextWindow: p.contextWindow ?? ASSUMED_CONTEXT },
    source: `assumed ${Math.round((p.contextWindow ?? ASSUMED_CONTEXT) / 1024)}k context`,
  };
}

/** 一行说明:窗口与价格,给选择器的行注。 */
export function describeInferred(inf: Inferred): string {
  const m = inf.model;
  const parts = [
    ...(m.contextWindow ? [`${fmtWindow(m.contextWindow)} ctx`] : []),
    ...(m.price ? [`$${m.price.input}/$${m.price.output} per 1M`] : []),
    inf.source,
  ];
  return parts.join(" · ");
}

function fmtWindow(n: number): string {
  return n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1024)}k`;
}

/** 已配置模型与登记簿的分歧(窗口不同),给选择器提示;没分歧返回 undefined。 */
export function registryDisagreement(
  registry: Registry | undefined,
  providerName: string,
  p: ProviderConfig,
  modelId: string,
  configured: number | undefined,
): string | undefined {
  if (!registry || configured === undefined) return undefined;
  const hit = lookupModel(registry, registryProviderId(providerName, p), modelId);
  const ctx = hit?.limit?.context;
  if (!ctx || ctx === configured) return undefined;
  return `config ${fmtWindow(configured)} · models.dev ${fmtWindow(ctx)}`;
}
