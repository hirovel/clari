// 一次性模式:跑一个 turn 就退出。策略 A/B 的执行器。
// 用法:pnpm once -- "任务" [--json] [--model X] [--effort L] [--compaction llm|clear|pipeline]
//                 [--max-steps N] [--resume 文件 | --continue] [--system-prompt 文件] [--append-system-prompt 文件]
// stdout:最终回复文本;--json 时输出结构化结果。非零退出码 = 请求失败。
import { Agent } from "../src/agent.js";
import { policyApprove } from "../src/approval.js";
import { usageTotals } from "../src/cost.js";
import type { AgentEvent } from "../src/events.js";
import { expandFileRefs } from "./attachments.js";
import {
  beginSession,
  bootstrap,
  parseCommonArgs,
  resolveApproval,
  sessionsDir,
  USAGE,
} from "./bootstrap.js";
import { prepareSessionRuntime } from "./session-runtime.js";

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

const { log, sessionFile } = beginSession(args, choice, process.cwd(), sessionsDir(boot.config));
// 事件流输出(--events):每条事件一行 JSON,与会话文件逐字节相同;给外部程序订阅内核的全部状态变化。
if (args.events) log.subscribe((e) => process.stdout.write(`${JSON.stringify(e)}\n`));
log.subscribe((e) => {
  if (e.type === "ext/event" && e.source === "skills" && e.kind === "load-error")
    console.error(String(e.payload.message));
});
let runtime: Awaited<ReturnType<typeof prepareSessionRuntime>>;
let agent: Agent;
const recordingOffs: (() => void)[] = [];
const watchSaving = (source: typeof log) => {
  const off = source.recording?.subscribe(() => {
    if (source.recording?.error)
      console.error(
        `Saving failed (${source.path}): ${source.recording.error}. Work continues; retrying storage every second. Unsaved data may be lost on exit.`,
      );
  });
  if (off) recordingOffs.push(off);
};
watchSaving(log);
try {
  runtime = await prepareSessionRuntime({
    boot,
    args,
    log,
    sessionFile,
    slots: () => agent.slots,
    current: () => ({ provider: agent.provider, tools: agent.tools }),
    onChild: (child) => watchSaving(child.log),
  });
  runtime.activate();
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
const approvalCfg = resolveApproval(args, boot.config);
agent = new Agent({
  log,
  provider: runtime.choice.provider,
  tools: () => runtime.tools.filter((tool) => !args.disabledTools?.includes(tool.name)),
  compaction: runtime.compaction,
  ...(args.facts && { facts: args.facts }),
  ...(args.planReminder !== undefined && { planReminder: args.planReminder }),
  slots: {
    ...runtime.slots,
    ...(args.approve === "ask" && {
      approve: () => ({
        allowed: false,
        reason: "one-shot mode with --approve ask; no one to ask",
      }),
    }),
    ...(typeof approvalCfg === "object" && { approve: policyApprove(approvalCfg, undefined) }),
  },
  ...(args.effort && { effort: args.effort }),
  ...(!args.json && !args.events && { onDelta: (d: string) => process.stdout.write(d) }),
});

const startIndex = log.events.length;
try {
  const outcome = await agent.prompt(expandFileRefs(prompt).text);
  const fresh = log.events.slice(startIndex);
  const last = [...fresh].reverse().find((e) => e.type === "assistant/message");
  const text = last?.type === "assistant/message" ? last.text : "";
  if (args.json) {
    const summary = summarize(fresh, text, outcome, sessionFile, choice.model);
    // 事件流模式下摘要也是一行,type 字段区分;否则缩进打印。
    console.log(
      args.events
        ? JSON.stringify({ type: "summary", ...summary })
        : JSON.stringify(summary, null, 2),
    );
  } else if (args.events) {
    console.error(`[session: ${sessionFile}]`);
  } else {
    if (!text.endsWith("\n")) process.stdout.write("\n");
    if (typeof outcome === "object") console.error(`[loop stopped: ${outcome.stopped}]`);
    console.error(`[session: ${sessionFile}]`);
  }
} catch (err) {
  if (args.json) {
    console.log(JSON.stringify({ ok: false, error: (err as Error).message, sessionFile }, null, 2));
  } else console.error(`request failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await runtime.dispose();
  await log.checkpoint();
  for (const off of recordingOffs) off();
}

function summarize(
  events: AgentEvent[],
  text: string,
  outcome: Awaited<ReturnType<Agent["prompt"]>>,
  file: string,
  model: string,
) {
  let steps = 0;
  let requests = 0;
  let toolCalls = 0;
  for (const e of events) {
    if (e.type === "request") requests++;
    if (e.type === "assistant/message") {
      steps++;
      toolCalls += e.toolCalls.length;
    }
  }
  const totals = usageTotals(events, () => choice.price);
  return {
    ok: true,
    model,
    outcome: typeof outcome === "string" ? outcome : `stopped:${outcome.stopped}`,
    steps,
    requests,
    toolCalls,
    retries: events.filter((e) => e.type === "retry").length,
    compactions: events.filter((e) => e.type === "compaction").length,
    usage: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
    },
    ...(totals.cost !== undefined && { costUsd: Number(totals.cost.toFixed(6)) }),
    text,
    sessionFile: file,
  };
}
