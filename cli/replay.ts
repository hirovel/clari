// 透明度工具:把一份会话日志投影成"模型眼里看到的样子"。
// 用法:pnpm replay sessions/2026-08-30T....jsonl
//
// 它不打网络、不改文件,只做 EventLog.load() → deriveMessages()。
// 存在的意义:让"模型到底看见了什么"这个问题永远有一个可执行的答案。
import { contextBreakdown } from "../src/context.js";
import { EventLog } from "../src/log.js";
import { deriveMessages } from "../src/messages.js";

const file = process.argv[2];
if (!file) {
  console.error("用法: pnpm replay <会话.jsonl>");
  process.exit(1);
}

const log = EventLog.load(file);
const messages = deriveMessages(log.events);

console.log(`\n事件 ${log.events.length} 条  →  模型可见消息 ${messages.length} 条`);

// 只入日志、不进投影的事件 —— "只给人看"的那一类,单独点名。
const humanOnly = log.events.filter(
  (e) => e.type === "session/interrupt" || e.type === "session/model",
);
if (humanOnly.length > 0) {
  console.log(`其中 ${humanOnly.length} 条只给人看(不投影): session/interrupt、session/model`);
}
console.log("─".repeat(64));

for (const m of messages) {
  const head = m.role === "tool" ? `tool:${m.name}${m.isError ? " (错误)" : ""}` : m.role;
  console.log(`\n【${head}】`);
  if (m.content) console.log(indent(m.content));
  if (m.role === "assistant") {
    for (const tc of m.toolCalls) {
      console.log(indent(`→ 调用 ${tc.name}(${JSON.stringify(tc.args)})`));
    }
  }
}

console.log(`\n${"─".repeat(64)}`);
const b = contextBreakdown(log.events, Number(process.env.KERNEL_CONTEXT_WINDOW ?? 131072));
console.log(`构成(估算 ${b.estimatedTokens} tok,占窗口 ${Math.round(b.usedShare * 100)}%):`);
for (const p of b.parts) {
  console.log(
    `  ${Math.round(p.share * 100)}%`.padStart(5) +
      `  ${p.tokens} tok · ${p.count} 条 · ${p.label}`,
  );
}
console.log("\n以上就是下一次请求发给模型的全部内容。日志之外,别无来源。\n");

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => "  " + l)
    .join("\n");
}
