// 真实供应商跑过之后的对照:读一份会话文件,把内核发请求前的预测与供应商回来的实测摆在一起,
// 再跑一组自动判据(判据与报告在 cli/checkup.ts)。离线、只读:不联网、不改文件、不读凭据;
// key 从不进会话文件,也不进这里的输出,报告可以原样贴回对话。
// 用法:pnpm checkup sessions/<文件>.jsonl [--json]
import { analyze, reportLines } from "../cli/checkup.js";
import { readRequestRecording } from "../cli/session-records.js";
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

const log = EventLog.load(file);
const requests = log.events.flatMap((e, i) => e.type === "request" ? [i] : []);
const records = requests.map((i) => readRequestRecording(file, log.events, i));
const evidence = records.some(Boolean) ? { lines: records.reduce((n, r) => n + (r?.attempts?.reduce((count, a) => count + a.response.split(/\r?\n/).length, 0) ?? 0), 0), requests: requests.filter((_, i) => records[i]?.attempts?.length && !records[i]?.error) } : undefined;
const checkup = analyze(log.events, evidence);
const totals = usageTotals(log.events, priceLookup());

if (flags.includes("--json")) {
  console.log(JSON.stringify({ file, ...checkup, totals }, null, 2));
} else {
  for (const l of reportLines(file, log.events.length, checkup, totals)) console.log(l);
}
process.exit(checkup.checks.some((c) => c.status === "fail") ? 1 : 0);
