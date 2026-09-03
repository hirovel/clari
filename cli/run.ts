// 一次性模式(Q55):跑一个 turn 就退出。策略 A/B 的执行器。
// 用法:pnpm once -- "任务" [--json] [--model X] [--effort L] [--compaction llm|clear|pipeline]
//                 [--max-steps N] [--resume 文件 | --continue] [--system-prompt 文件] [--append-system-prompt 文件]
// stdout:最终回复文本;--json 时输出结构化结果。非零退出码 = 请求失败。
import { Agent } from "../src/agent.js";
import type { AgentEvent } from "../src/events.js";
import { maxSteps } from "../src/loop.js";
import {
  beginSession,
  bootstrap,
  buildCompaction,
  buildTools,
  memoryFiles,
  parseCommonArgs,
  USAGE,
} from "./bootstrap.js";

let args: ReturnType<typeof parseCommonArgs>;
try {
  args = parseCommonArgs(process.argv.slice(2));
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
if (args.help) {
  console.log(USAGE);
  process.exit(0);
}
const prompt = args.rest.join(" ").trim();
if (!prompt) {
  console.error(USAGE);
  process.exit(2);
}

const boot = bootstrap();
try {
  args = boot.resolve(args);
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
let choice: ReturnType<typeof boot.choose>;
try {
  choice = boot.choose(args.model);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const { log, sessionFile } = beginSession(args, choice);
let compaction: Awaited<ReturnType<typeof buildCompaction>>;
try {
  compaction = await buildCompaction(args.compaction, choice.contextWindow);
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
const tools = buildTools(
  log,
  choice,
  compaction,
  args.subagent,
  undefined,
  args.memory ? memoryFiles() : undefined,
);

const agent = new Agent({
  log,
  provider: choice.provider,
  tools,
  compaction,
  // 一次性模式没有人在旁边点头:--approve ask 等于全部拒绝,模型会收到"用户拒绝"的结果。
  slots: {
    ...(args.maxSteps && { termination: maxSteps(args.maxSteps) }),
    ...(args.approve === "ask" && { approve: () => false }),
  },
  ...(args.effort && { effort: args.effort }),
  ...(!args.json && {
    onDelta: (d: string) => process.stdout.write(d),
  }),
});

const startIndex = log.events.length;
try {
  const outcome = await agent.prompt(prompt);
  const fresh = log.events.slice(startIndex);
  const last = [...fresh].reverse().find((e) => e.type === "assistant/message");
  const text = last?.type === "assistant/message" ? last.text : "";
  if (args.json) {
    console.log(
      JSON.stringify(summarize(fresh, text, outcome, sessionFile, choice.model), null, 2),
    );
  } else {
    if (!text.endsWith("\n")) process.stdout.write("\n");
    if (typeof outcome === "object") console.error(`[循环停止:${outcome.stopped}]`);
    console.error(`[会话:${sessionFile}]`);
  }
} catch (err) {
  if (args.json) {
    console.log(JSON.stringify({ ok: false, error: (err as Error).message, sessionFile }, null, 2));
  } else console.error(`请求失败:${(err as Error).message}`);
  process.exit(1);
}

function summarize(
  events: AgentEvent[],
  text: string,
  outcome: Awaited<ReturnType<Agent["prompt"]>>,
  file: string,
  model: string,
) {
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  let steps = 0;
  let requests = 0;
  let toolCalls = 0;
  for (const e of events) {
    if (e.type === "request") requests++;
    if (e.type === "assistant/message") {
      steps++;
      toolCalls += e.toolCalls.length;
      if (e.usage) {
        usage.inputTokens += e.usage.inputTokens;
        usage.outputTokens += e.usage.outputTokens;
        usage.cacheReadTokens += e.usage.cacheReadTokens ?? 0;
      }
    }
    if (e.type === "compaction" && e.usage) {
      usage.inputTokens += e.usage.inputTokens;
      usage.outputTokens += e.usage.outputTokens;
    }
  }
  return {
    ok: true,
    model,
    outcome: typeof outcome === "string" ? outcome : `stopped:${outcome.stopped}`,
    steps,
    requests,
    toolCalls,
    retries: events.filter((e) => e.type === "retry").length,
    compactions: events.filter((e) => e.type === "compaction").length,
    usage,
    text,
    sessionFile: file,
  };
}
