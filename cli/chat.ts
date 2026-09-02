// coding agent 壳:内核 + 四工具(Q2 的第一个组装示例)。
// 用法:设好 DEEPSEEK_API_KEY 后 pnpm chat
// 运行中继续输入 = 插话(注入时点由 steering 槽决定,Q20);输入 /stop = 即时打断(Q11)。
import { createInterface } from "node:readline";
import { Agent } from "../src/agent.js";
import { clearToolResults, llmSummarize, pipeline } from "../src/compaction.js";
import { contextBreakdown } from "../src/context.js";
import type { AgentEvent } from "../src/events.js";
import { now } from "../src/events.js";
import { EventLog } from "../src/log.js";
import type { CompactionConfig } from "../src/loop.js";
import { openaiCompat } from "../src/provider.js";
import { createTaskTool } from "../src/subagent.js";
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

const contextWindow = Number(process.env.KERNEL_CONTEXT_WINDOW ?? 131072);
const RESERVE = 32000;
const threshold = contextWindow - RESERVE;

// 压缩策略注册表:代码定义菜单,运行时按名选择(KERNEL_COMPACTION=llm|clear|pipeline)。
const COMPACTION_STRATEGIES = {
  llm: () => llmSummarize(),
  clear: () => clearToolResults(),
  pipeline: () => pipeline(clearToolResults(), llmSummarize()),
} as const;
const chosen = (process.env.KERNEL_COMPACTION ?? "llm") as keyof typeof COMPACTION_STRATEGIES;
const compaction: CompactionConfig = {
  strategy: (COMPACTION_STRATEGIES[chosen] ?? COMPACTION_STRATEGIES.llm)(),
  window: contextWindow,
  reserveTokens: RESERVE,
};

console.log(`会话日志: ${sessionFile}`);
console.log(
  "运行中输入 = 插话;/stop = 打断;/context = 上下文构成;/compact [指示] = 手动压缩;Ctrl+C = 退出\n",
);

// subagent 是可选装能力,默认不装(KERNEL_SUBAGENT=1 开启)。子拿同样的四工具,不含 task。
const baseTools = [readTool, writeTool, editTool, bashTool];
const tools =
  process.env.KERNEL_SUBAGENT === "1"
    ? [...baseTools, createTaskTool({ parent: log, provider, tools: baseTools, compaction })]
    : baseTools;

const agent = new Agent({
  log,
  provider,
  tools,
  compaction,
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
  if (text === "/context") {
    printContext();
    rl.prompt();
    return;
  }
  if (text.startsWith("/compact")) {
    void manualCompact(text.slice("/compact".length).trim());
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

// 手动压缩(Q33):可附自定义指示,拼进摘要提示词。
async function manualCompact(instructions: string): Promise<void> {
  console.log("  [正在压缩会话……]");
  try {
    const payload = await compaction.strategy({
      events: log.events,
      window: contextWindow,
      targetTokens: threshold,
      provider,
      ...(instructions && { instructions }),
    });
    if (!payload) {
      console.log("  [压缩未执行:无事可做或未取得足够进展]");
    } else {
      log.append({ type: "compaction", at: now(), ...payload });
    }
  } catch (err) {
    console.error(`  [压缩失败: ${(err as Error).message}]`);
  }
  rl.prompt();
}

// 上下文构成投影(Q34):展示的就是将要发送的,与消息投影同源,没有第二套口径。
function printContext(): void {
  const b = contextBreakdown(log.events, contextWindow);
  console.log(
    `\n上下文构成(估算 ${b.estimatedTokens} tok / 窗口 ${b.window},占 ${pct(b.usedShare)})`,
  );
  if (b.measuredTokens !== undefined) {
    console.log(`上次请求实测输入:${b.measuredTokens} tok`);
  }
  for (const p of b.parts) {
    const bar = "█".repeat(Math.max(1, Math.round(p.share * 24))).padEnd(24);
    console.log(
      `  ${bar} ${pct(p.share).padStart(4)}  ${p.tokens} tok · ${p.count} 条 · ${p.label}`,
    );
  }
  console.log("");
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function render(e: AgentEvent): void {
  if (e.type === "assistant/message") {
    if (e.text) process.stdout.write("\n");
    for (const tc of e.toolCalls) console.log(`  → ${tc.name} ${JSON.stringify(tc.args)}`);
    if (e.usage) {
      const left = pct(Math.max(0, (threshold - e.usage.inputTokens) / threshold));
      console.log(`  [${e.usage.inputTokens}→${e.usage.outputTokens} tok · 距自动压缩 ${left}]`);
    }
    if (e.stopReason === "aborted") console.log("  [已打断]");
  }
  if (e.type === "compaction") {
    const parts: string[] = [];
    if (e.summary !== undefined) parts.push(`摘要覆盖事件 ${e.coversFrom ?? 1}-${e.coversUpTo}`);
    if (e.cleared?.length) parts.push(`清除 ${e.cleared.length} 条工具结果`);
    console.log(`  [已压缩:${parts.join(",")};/context 查看新构成]`);
  }
  if (e.type === "tool/result") {
    // 默认完整显示,不折叠(Q34):折叠只能是用户主动开启的选项,不是行业式的默认隐藏。
    const mark = e.isError ? "✗" : "✓";
    console.log(`  ${mark} ${e.name}: ${e.content.replaceAll("\n", "\n    ")}`);
  }
}
