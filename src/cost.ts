// 费用与用量汇总:全部是事件数组上的纯函数。价格是配置数据,内核不内置任何价目。
import type { AgentEvent, Usage } from "./events.js";

export type Price = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/**
 * 一次请求的费用(美元)。input 计价时扣掉缓存命中与缓存写入的部分,那两部分各按自己的单价算;
 * 没给缓存单价就按 input 单价算(不少家不区分)。
 */
export function costOf(u: Usage, price: Price): number {
  const read = u.cacheReadTokens ?? 0;
  const write = u.cacheWriteTokens ?? 0;
  const plain = Math.max(0, u.inputTokens - read - write);
  const per = 1_000_000;
  return (
    (plain * price.input +
      read * (price.cacheRead ?? price.input) +
      write * (price.cacheWrite ?? price.input) +
      u.outputTokens * price.output) /
    per
  );
}

export type UsageTotals = {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 有价格时的累计费用;没有价格为 undefined。 */
  cost?: number;
};

/** 会话累计:正常步的 assistant 用量 + 压缩摘要请求的用量,两者都花钱。 */
export function usageTotals(
  events: readonly AgentEvent[],
  priceFor?: (model: string) => Price | undefined,
): UsageTotals {
  const t: UsageTotals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let cost = 0;
  let priced = false;
  let model = "";
  for (const e of events) {
    if (e.type === "session/start" || e.type === "session/model") model = e.model;
    if (e.type === "request") model = e.model;
    const u = e.type === "assistant/message" || e.type === "compaction" ? e.usage : undefined;
    if (!u) continue;
    t.requests += 1;
    t.inputTokens += u.inputTokens;
    t.outputTokens += u.outputTokens;
    t.cacheReadTokens += u.cacheReadTokens ?? 0;
    t.cacheWriteTokens += u.cacheWriteTokens ?? 0;
    const price = priceFor?.(model);
    if (price) {
      priced = true;
      cost += costOf(u, price);
    }
  }
  if (priced) t.cost = cost;
  return t;
}

/** 美元金额的显示:小额保留到厘,大额到分。 */
export function fmtCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
