// TUI 入口:参数、配置、供应商匹配、工具与压缩组装(见 bootstrap.ts),然后把界面交给 tui-app。
// 用法:pnpm tui [-- --model <供应商/模型>] [--effort <级别>] [--compaction llm|clear|pipeline]
//                [--resume <会话文件> | --continue] [--system-prompt <文件>] [--append-system-prompt <文件>]
//                [--subagent] [--no-trace] [--fold]
//   --effort   强度级别 off|low|medium|high|xhigh|max;缺省不传,用供应商默认
//   --resume   恢复会话并沿用同一文件继续;--continue 取 sessions/ 下最近一次
//   --no-trace 不记录原始流(缺省逐行记录:检视器"接收"分区、/raw N 可看,并写入 <会话>.trace.jsonl)
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
import { discoverSkills } from "./prompt.js";
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
  console.log(`config template created: ${DEFAULT_CONFIG_PATH}`);
  console.log(
    "Fill in each provider's API key (env vars recommended), or run /key provider secret after startup to write it into the config.\n",
  );
}

let first: ModelChoice;
try {
  first = boot.choose(args.model);
} catch (err) {
  console.error((err as Error).message);
  console.error(
    "\nhint: one provider key is enough to start; set the others inside the TUI with /key.",
  );
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
  console.error(`\n${kind}: ${e?.stack ?? String(err)}`);
  console.error(`session saved: ${sessionFile}; resume with pnpm tui -- --resume ${sessionFile}`);
  process.exit(70);
};
process.on("uncaughtException", crash("uncaught exception"));
process.on("unhandledRejection", crash("unhandled promise rejection"));
const memory = args.memory ? memoryFiles() : undefined;
let ext: Awaited<ReturnType<typeof loadExtensions>>;
try {
  ext = await loadExtensions(args.extensions, { cwd: process.cwd(), log });
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const skills = discoverSkills(process.cwd());
const baseTools = buildTools(
  log,
  first,
  compaction,
  args.subagent,
  (child) => app?.attachChild(child),
  memory,
  args.skillsLoad === "tool" ? skills : undefined,
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
  skills,
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
