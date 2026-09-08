// 真实供应商跑过之后的对照:读一份会话文件,把内核发请求前的预测与供应商回来的实测摆在一起,
// 再跑一组自动判据(判据与报告在 cli/checkup.ts)。离线、只读:不联网、不改文件、不读凭据;
// key 从不进会话文件,也不进这里的输出,报告可以原样贴回对话。
// 用法:pnpm checkup sessions/<文件>.jsonl [--json]
import { existsSync, readFileSync } from "node:fs";
import { analyze, reportLines, type TraceInfo } from "../cli/checkup.js";
import { loadRegistrySync, resolveCapabilities } from "../cli/registry.js";
import { type KernelConfig, loadConfig, resolveModel } from "../src/config.js";
import { type Price, usageTotals } from "../src/cost.js";
import { EventLog } from "../src/log.js";

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error("usage: pnpm checkup <session.jsonl> [--json]");
  process.exit(1);
}

/** 价格只用来算费用;配置与登记簿都读不到就不算,不报错。 */
function priceLookup(): (model: string) => Price | undefined {
  let config: KernelConfig | undefined;
  try {
    config = loadConfig().config;
  } catch {
    return () => undefined;
  }
  const registry = loadRegistrySync();
  const cache = new Map<string, Price | undefined>();
  return (model) => {
    if (cache.has(model)) return cache.get(model);
    let price: Price | undefined;
    try {
      const r = resolveModel(config as KernelConfig, model);
      price = resolveCapabilities(r.providerName, r.provider, r.model, registry).price;
    } catch {
      price = undefined;
    }
    cache.set(model, price);
    return price;
  };
}

/** 原始流旁路文件:界面写的,一行一条 {request, line}。 */
function readTrace(sessionFile: string): TraceInfo | undefined {
  const path = sessionFile.replace(/\.jsonl$/, ".trace.jsonl");
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const requests = new Set<number>();
  for (const l of lines) {
    try {
      requests.add((JSON.parse(l) as { request: number }).request);
    } catch {
      // 半行不影响判断
    }
  }
  return { lines: lines.length, requests: [...requests] };
}

const log = EventLog.load(file);
const checkup = analyze(log.events, readTrace(file));
const totals = usageTotals(log.events, priceLookup());

if (flags.includes("--json")) {
  console.log(JSON.stringify({ file, ...checkup, totals }, null, 2));
} else {
  for (const l of reportLines(file, log.events.length, checkup, totals)) console.log(l);
}
process.exit(checkup.checks.some((c) => c.status === "fail") ? 1 : 0);
