// TUI 入口:参数、配置、供应商匹配、工具与压缩组装(见 bootstrap.ts),然后把界面交给 tui-app。
// 用法:pnpm tui [-- --model <供应商/模型>] [--effort <级别>] [--compaction llm|clear|pipeline]
//                [--resume <会话文件> | --continue] [--system-prompt <文件>] [--append-system-prompt <文件>]
//                [--subagent] [--trace] [--fold]
//   --effort   强度级别 off|low|medium|high|xhigh|max;缺省不传,用供应商默认
//   --resume   恢复会话并沿用同一文件继续;--continue 取 sessions/ 下最近一次
//   --trace    逐行记录收到的原始流:检视器"接收"分区可看,并写入 <会话>.trace.jsonl
//   --fold     工具结果初始折叠(Ctrl+O 随时切换;缺省完整显示)
import { appendFileSync } from "node:fs";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import {
  bootstrap,
  buildCompaction,
  buildTools,
  DEFAULT_CONFIG_PATH,
  openSession,
  parseCommonArgs,
  RESERVE,
  systemPromptFor,
} from "./bootstrap.js";
import { createTuiApp, type ModelChoice } from "./tui-app.js";

let args: ReturnType<typeof parseCommonArgs>;
try {
  args = parseCommonArgs(process.argv.slice(2));
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}

const boot = bootstrap();
if (boot.configCreated) {
  console.log(`已生成配置模板:${DEFAULT_CONFIG_PATH}`);
  console.log("填入各家的 API key(推荐环境变量),或启动后用 /key 供应商 密钥 写入配置。\n");
}

let first: ModelChoice;
try {
  first = boot.choose(args.model);
} catch (err) {
  console.error((err as Error).message);
  console.error("\n提示:任一供应商 key 就位后即可启动;其余供应商可在 TUI 内用 /key 设置。");
  process.exit(1);
}

let session: ReturnType<typeof openSession>;
try {
  session = openSession(args);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const { log, sessionFile, resumed } = session;
const compaction = buildCompaction(args.compaction, first.contextWindow, RESERVE);
const tools = buildTools(log, first, compaction, args.subagent);
const traceFile = sessionFile.replace(/\.jsonl$/, ".trace.jsonl");

createTuiApp({
  terminal: new ProcessTerminal(),
  log,
  provider: first.provider,
  tools,
  compaction,
  reserveTokens: RESERVE,
  info: { model: first.model, providerName: first.providerName, sessionFile },
  settings: boot.settings,
  systemPrompt: systemPromptFor(args),
  resume: resumed,
  fold: args.fold,
  trace: args.trace,
  ...(args.effort && { effort: args.effort }),
  ...(first.effortLevels && { effortLevels: first.effortLevels }),
  ...(args.trace && {
    onRaw: (requestIndex: number, line: string) =>
      appendFileSync(traceFile, `${JSON.stringify({ request: requestIndex, line })}\n`),
  }),
});
