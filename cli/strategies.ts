import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type CompactionStrategy,
  clearToolResults,
  llmSummarize,
  pipeline,
} from "../src/compaction.js";
import type { CompactionConfig } from "../src/loop.js";

/** 自动压缩阈值之下预留给回复与工具结果的 token 数。 */
export const RESERVE = 32000;

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
      throw new Error(`compaction strategy module ${name} must default-export a function`);
    }
    return fn as CompactionStrategy;
  }
  throw new Error(
    `unknown compaction strategy "${name}"; choices: ${Object.keys(BUILTIN_STRATEGIES).join(" ")}, or a module path`,
  );
}

export async function buildCompaction(
  name: string,
  window: number,
  reserveTokens = RESERVE,
): Promise<CompactionConfig> {
  return { strategy: await loadCompactionStrategy(name), window, reserveTokens };
}
