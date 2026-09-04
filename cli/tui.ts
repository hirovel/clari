// TUI 入口:参数、配置、供应商匹配、工具与压缩组装(见 bootstrap.ts),然后把界面交给 tui-app。
// 用法:pnpm tui [-- --model <供应商/模型>] [--effort <级别>] [--compaction llm|clear|pipeline]
//                [--resume <会话文件> | --continue] [--system-prompt <文件>] [--append-system-prompt <文件>]
//                [--subagent] [--trace] [--fold]
//   --effort   强度级别 off|low|medium|high|xhigh|max;缺省不传,用供应商默认
//   --resume   恢复会话并沿用同一文件继续;--continue 取 sessions/ 下最近一次
//   --trace    逐行记录收到的原始流:检视器"接收"分区可看,并写入 <会话>.trace.jsonl
//   --fold     工具结果初始折叠(Ctrl+O 随时切换;缺省完整显示)
//   --approve ask  每个工具调用在界面里问一次(y 允许 / n 拒绝 / a 本会话总是允许该工具);缺省 all 不问
import { appendFileSync } from "node:fs";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import {
  beginSession,
  bootstrap,
  buildCompaction,
  buildTools,
  DEFAULT_CONFIG_PATH,
  loadExtensions,
  memoryFiles,
  parseCommonArgs,
  RESERVE,
  sessionsDir,
  USAGE,
} from "./bootstrap.js";
import { discoverTemplates } from "./templates.js";
import { createTuiApp, type ModelChoice } from "./tui-app.js";

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

const boot = bootstrap();
try {
  args = boot.resolve(args);
} catch (err) {
  console.error((err as Error).message);
  process.exit(2);
}
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

const sessionDir = sessionsDir(boot.config);
let session: ReturnType<typeof beginSession>;
try {
  session = beginSession(args, first, process.cwd(), sessionDir);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const { log, sessionFile } = session;
let compaction: Awaited<ReturnType<typeof buildCompaction>>;
try {
  compaction = await buildCompaction(args.compaction, first.contextWindow, RESERVE);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
// 子 agent 只会在用户输入之后出现,此时 app 已经建好;先声明后赋值即可。
let app: ReturnType<typeof createTuiApp> | undefined;

// 进程级兜底:界面代码抛出的异常必须先把终端还原,再把错误与会话文件打印出来,不能留下一个乱掉的终端。
const crash = (kind: string) => (err: unknown) => {
  try {
    app?.stop();
  } catch {
    // 还原失败也要继续打印
  }
  const e = err as Error;
  console.error(`\n${kind}:${e?.stack ?? String(err)}`);
  console.error(`会话已落盘:${sessionFile};pnpm tui -- --resume ${sessionFile} 可恢复`);
  process.exit(70);
};
process.on("uncaughtException", crash("未捕获异常"));
process.on("unhandledRejection", crash("未处理的 Promise 拒绝"));
const memory = args.memory ? memoryFiles() : undefined;
let ext: Awaited<ReturnType<typeof loadExtensions>>;
try {
  ext = await loadExtensions(args.extensions, { cwd: process.cwd(), log });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const baseTools = buildTools(
  log,
  first,
  compaction,
  args.subagent,
  (child) => app?.attachChild(child),
  memory,
);
// 扩展模块的工具重名时覆盖内置的。
const tools = [
  ...baseTools.filter((t) => !ext.tools?.some((x) => x.name === t.name)),
  ...(ext.tools ?? []),
];
const traceFile = sessionFile.replace(/\.jsonl$/, ".trace.jsonl");

app = createTuiApp({
  terminal: new ProcessTerminal(),
  log,
  provider: first.provider,
  tools,
  compaction,
  reserveTokens: RESERVE,
  info: { model: first.model, providerName: first.providerName, sessionFile },
  settings: boot.settings,
  fold: args.fold,
  trace: args.trace,
  approve: args.approve,
  compactionName: args.compaction,
  slots: { ...ext.slots, ...(args.execution && { execution: args.execution }) },
  templates: discoverTemplates(),
  sessionsDir: sessionDir,
  ...(memory && { memory }),
  ...(args.effort && { effort: args.effort }),
  ...(first.effortLevels && { effortLevels: first.effortLevels }),
  ...(first.price && { price: first.price }),
  ...(args.trace && {
    onRaw: (requestIndex: number, line: string) =>
      appendFileSync(traceFile, `${JSON.stringify({ request: requestIndex, line })}\n`),
  }),
});
