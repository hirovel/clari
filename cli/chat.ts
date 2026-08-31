// D1 冒烟:裸对话(无工具)端到端 —— 用户输入→事件日志→投影→provider 流式→事件日志。
// 用法:设好 DEEPSEEK_API_KEY 后 pnpm chat
import { createInterface } from "node:readline/promises";
import { now } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { deriveMessages } from "../src/messages.js";
import { openaiCompat } from "../src/provider.js";

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("缺 DEEPSEEK_API_KEY 环境变量");
  process.exit(1);
}

const provider = openaiCompat({
  baseUrl: process.env.KERNEL_BASE_URL ?? "https://api.deepseek.com",
  apiKey,
  model: process.env.KERNEL_MODEL ?? "deepseek-chat",
});

const sessionFile = `sessions/${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
const log = new EventLog(sessionFile);

// 透明度的第一版:UI 就是事件流本身的订阅者,别无信道。
log.subscribe((e) => {
  if (e.type === "assistant/message" && e.usage) {
    process.stdout.write(`\n  [${e.usage.inputTokens}→${e.usage.outputTokens} tok]\n`);
  }
});

log.append({
  type: "session/start",
  at: now(),
  model: provider.model,
  system: "你是一个简洁的助手。",
});
console.log(`会话日志: ${sessionFile}(Ctrl+C 退出)\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout });
while (true) {
  const text = (await rl.question("> ")).trim();
  if (!text) continue;
  log.append({ type: "user/message", at: now(), text });

  try {
    const turn = await provider.complete(deriveMessages(log.events), [], {
      onDelta: (d) => process.stdout.write(d),
    });
    log.append({ type: "assistant/message", at: now(), ...turn });
  } catch (err) {
    // provider 抛出的只有真实意外(网络断/HTTP 错)。打印后继续,REPL 不因一次请求失败而死。
    console.error(`\n请求失败: ${(err as Error).message}`);
  }
}
