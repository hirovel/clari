// coding agent 壳:内核 + 四工具(Q2 的第一个组装示例)。
// 用法:设好 DEEPSEEK_API_KEY 后 pnpm chat
// 运行中继续输入 = 插话(注入时点由 steering 槽决定,Q20);输入 /stop = 即时打断(Q11)。
import { createInterface } from "node:readline";
import { Agent } from "../src/agent.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { openaiCompat } from "../src/provider.js";
import { bashTool } from "./tools/bash.js";
import { editTool, readTool, writeTool } from "./tools/fs.js";

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

// UI 是事件流的订阅者(Q6),不在数据流主路径上。
log.subscribe(render);

log.append({
  type: "session/start",
  at: new Date().toISOString(),
  model: provider.model,
  system:
    "你是一个在用户机器上工作的编程助手。工作目录即当前目录。" +
    "优先用 read/edit 做精确修改,用 bash 执行命令与搜索。回答简洁。",
});

console.log(`会话日志: ${sessionFile}`);
console.log("运行中输入 = 插话;/stop = 打断;Ctrl+C = 退出\n");

const agent = new Agent({
  log,
  provider,
  tools: [readTool, writeTool, editTool, bashTool],
  onDelta: (d) => process.stdout.write(d),
});

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
rl.prompt();
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) {
    rl.prompt();
    return;
  }
  if (text === "/stop") {
    agent.interrupt();
    return;
  }
  if (agent.running) {
    void agent.prompt(text);
    console.log("  [已排队,将按 steering 策略注入]");
    return;
  }
  void agent
    .prompt(text)
    .catch((err: Error) => console.error(`\n请求失败: ${err.message}`))
    .finally(() => rl.prompt());
});

function render(e: AgentEvent): void {
  if (e.type === "assistant/message") {
    if (e.text) process.stdout.write("\n");
    for (const tc of e.toolCalls) console.log(`  → ${tc.name} ${JSON.stringify(tc.args)}`);
    if (e.usage) console.log(`  [${e.usage.inputTokens}→${e.usage.outputTokens} tok]`);
    if (e.stopReason === "aborted") console.log("  [已打断]");
  }
  if (e.type === "tool/result") {
    // 默认完整显示,不折叠(Q34):折叠只能是用户主动开启的选项,不是行业式的默认隐藏。
    const mark = e.isError ? "✗" : "✓";
    console.log(`  ${mark} ${e.name}: ${e.content.replaceAll("\n", "\n    ")}`);
  }
}
