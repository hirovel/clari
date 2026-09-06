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

/**
 * 会话累计的增量形态:界面每收到一条事件喂一次,状态栏读 totals() 是 O(1)。
 * 正常步的 assistant 用量 + 压缩摘要请求的用量,两者都花钱;价格按用量发生时的模型取。
 */
export class UsageAccumulator {
  private readonly t: UsageTotals = {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  private cost = 0;
  private priced = false;
  private model = "";

  constructor(private readonly priceFor?: (model: string) => Price | undefined) {}

  add(e: AgentEvent): void {
    if (e.type === "session/start" || e.type === "session/model" || e.type === "request")
      this.model = e.model;
    const u = e.type === "assistant/message" || e.type === "compaction" ? e.usage : undefined;
    if (!u) return;
    this.t.requests += 1;
    this.t.inputTokens += u.inputTokens;
    this.t.outputTokens += u.outputTokens;
    this.t.cacheReadTokens += u.cacheReadTokens ?? 0;
    this.t.cacheWriteTokens += u.cacheWriteTokens ?? 0;
    const price = this.priceFor?.(this.model);
    if (price) {
      this.priced = true;
      this.cost += costOf(u, price);
    }
  }

  totals(): UsageTotals {
    return { ...this.t, ...(this.priced && { cost: this.cost }) };
  }
}

/** 会话累计的一次性形态:扫一遍全部事件。回放与一次性模式用;界面用增量的 UsageAccumulator。 */
export function usageTotals(
  events: readonly AgentEvent[],
  priceFor?: (model: string) => Price | undefined,
): UsageTotals {
  const acc = new UsageAccumulator(priceFor);
  for (const e of events) acc.add(e);
  return acc.totals();
}

/** 美元金额的显示:小额保留到厘,大额到分。 */
export function fmtCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * 费用的粗略形态:两位有效数字,前面带 ≈。费用是实测 token 乘目录单价算出来的,不是账单,
 * 屏幕上常驻的那份不该假装精确;四位小数留给检视器。
 */
export function fmtCostApprox(usd: number): string {
  if (usd <= 0) return "≈$0";
  if (usd < 0.0001) return "≈$0.0001";
  const s = usd < 1 ? Number(usd.toPrecision(2)).toString() : usd.toFixed(2);
  return `≈$${s}`;
}
