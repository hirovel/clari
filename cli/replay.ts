// 离线透明度工具:把一份会话日志按"请求"组织打印出来,不打网络、不改文件。
// 用法:pnpm replay sessions/xxx.jsonl            → 请求时间线 + 上下文构成
//       pnpm replay sessions/xxx.jsonl --messages → 再打印最终投影(模型眼里的消息序列)
//       pnpm replay sessions/xxx.jsonl --request 3 → 打印第 3 次请求发出时的完整消息序列
//       pnpm replay sessions/xxx.jsonl --compaction 1 [--json] → 第 1 次压缩:原文 ↔ 摘要对照(JSON 给评测脚本)
// 存在的意义:让"模型到底看见了什么、内核中间做了什么"这两个问题永远有一个可执行的答案。

import { contextBreakdown } from "../src/context.js";
import { EventLog } from "../src/log.js";
import { deriveMessages } from "../src/messages.js";
import {
  COMPACTION_SECTIONS,
  collectCompactions,
  collectRequests,
  compactionLines,
  compactionRow,
  decisionLines,
  listRow,
  sentLines,
} from "./inspector.js";

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error("用法: pnpm replay <会话.jsonl> [--messages] [--request N]");
  process.exit(1);
}

const log = EventLog.load(file);
const records = collectRequests(log.events);
const start = log.events.find((e) => e.type === "session/start");
const sections = start?.type === "session/start" ? start.sections : undefined;

console.log(
  `\n事件 ${log.events.length} 条 · 请求 ${records.length} 次 · 模型可见消息 ${deriveMessages(log.events).length} 条`,
);
console.log("─".repeat(72));

// 一行一请求,与 TUI 检视器列表同一份渲染。
for (const r of records) console.log(listRow(r, false));
const compactions = collectCompactions(log.events);
if (compactions.length > 0) {
  console.log(`\n压缩 ${compactions.length} 次(--compaction N 看对照):`);
  for (const r of compactions) console.log(compactionRow(r, false));
}

const requestFlag = flags.indexOf("--request");
if (requestFlag >= 0) {
  const n = Number(flags[requestFlag + 1]);
  const rec = records.find((r) => r.n === n);
  if (!rec) {
    console.error(`没有第 ${n} 次请求(共 ${records.length} 次)`);
    process.exit(1);
  }
  console.log(`\n${"─".repeat(72)}\n请求 #${n} 的决策:`);
  for (const l of decisionLines(rec)) console.log(l);
  console.log(`\n请求 #${n} 发出时模型看到的全部内容:`);
  for (const l of sentLines(deriveMessages(log.events.slice(0, rec.index)), false, sections)) {
    console.log(l);
  }
}

// 压缩对照(Q63):哪一大段原文变成了什么;--json 给评测脚本。
const compactionFlag = flags.indexOf("--compaction");
if (compactionFlag >= 0) {
  const n = Number(flags[compactionFlag + 1]);
  const comps = collectCompactions(log.events);
  const rec = comps.find((r) => r.n === n);
  if (!rec) {
    console.error(`没有第 ${n} 次压缩(共 ${comps.length} 次)`);
    process.exit(1);
  }
  if (flags.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          n: rec.n,
          strategy: rec.event.strategy ?? null,
          at: rec.event.at,
          coveredIndices: rec.covered,
          coveredTokens: rec.coveredTokens,
          summaryTokens: rec.summaryTokens,
          ratio: rec.coveredTokens > 0 ? rec.summaryTokens / rec.coveredTokens : null,
          covered: rec.covered.map((i) => log.events[i]),
          summary: rec.event.summary ?? null,
          clearedIndices: rec.cleared,
          clearedTokens: rec.clearedTokens,
          cleared: rec.cleared.map((i) => log.events[i]),
          usage: rec.event.usage ?? null,
          latencyMs: rec.event.latencyMs ?? null,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  console.log(`\n${"─".repeat(72)}`);
  for (const section of [1, 2, 3, 4] as const) {
    console.log(`\n【${COMPACTION_SECTIONS[section - 1]}】`);
    for (const l of compactionLines(log.events, rec, section)) console.log(l);
  }
}

if (flags.includes("--messages")) {
  console.log(`\n${"─".repeat(72)}\n当前投影(下一次请求会发出的内容):`);
  for (const l of sentLines(deriveMessages(log.events), false, sections)) console.log(l);
}

console.log(`\n${"─".repeat(72)}`);
const b = contextBreakdown(log.events, Number(process.env.CLARI_CONTEXT_WINDOW ?? 131072));
console.log(`构成(估算 ${b.estimatedTokens} tok,占窗口 ${Math.round(b.usedShare * 100)}%):`);
for (const p of b.parts) {
  console.log(
    `  ${Math.round(p.share * 100)}%`.padStart(5) +
      `  ${p.tokens} tok · ${p.count} 条 · ${p.label}`,
  );
}
console.log("\n以上全部来自日志文件本身。日志之外,别无来源。\n");
