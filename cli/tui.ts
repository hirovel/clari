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
import type { EventLog } from "../src/log.js";
import { queueToTurnEnd } from "../src/loop.js";
import {
  beginSession,
  bootstrap,
  buildCompaction,
  buildTools,
  DEFAULT_CONFIG_PATH,
  loadExtensions,
  memoryFiles,
  openSession,
  parseCommonArgs,
  parsePreservation,
  RESERVE,
  resolveApproval,
  resolveToolPrompts,
  sessionsDir,
  USAGE,
} from "./bootstrap.js";
import { connectMcpServers, type McpBridge } from "./mcp/bridge.js";
import { loadMcpServers, mcpConfigOf } from "./mcp/config.js";
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
if (boot.configCreated) console.log(`config template created: ${DEFAULT_CONFIG_PATH}`);

// 没有 key 也进界面:占位 provider 加登录对话框,key 在界面里贴。
let first: ModelChoice;
try {
  first = boot.chooseOrNone(args.model);
} catch (err) {
  console.error((err as Error).message);
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
  compaction = await buildCompaction(
    args.compaction,
    first.contextWindow,
    args.compactionReserve ?? RESERVE,
    args.compactionTrigger,
  );
  if (args.preservation) compaction.preservation = parsePreservation(args.preservation).policy;
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
const toolPromptsCfg = resolveToolPrompts(args, boot.config);
const { resume: _resume, continue: _continue, ...promptArgs } = args;
const sessionArgs = { ...promptArgs, continue: false };
// MCP 工具在第一次连接时拿到,换会话时原样带过去(桥接进程不重连)。
let mcpTools: Awaited<ReturnType<typeof buildTools>> = [];
let mcp: McpBridge | undefined;

/** 起一个界面:按会话组装工具(task 工具绑定父日志)与 app。换会话就是停掉旧的再调一次。 */
async function launch(current: { log: EventLog; sessionFile: string }): Promise<void> {
  const { log, sessionFile } = current;
  const baseTools = buildTools(
    log,
    first,
    compaction,
    args.subagent,
    (child) => app?.attachChild(child),
    memory,
    args.skillsLoad === "tool" ? skills : undefined,
    boot.config.fetch,
    toolPromptsCfg,
    {
      ...(boot.config.subagents && { config: boot.config.subagents }),
      slots: () => app?.slots(),
      providerFor: (model) => boot.choose(model).provider,
    },
    { plan: args.plan ?? true },
  );
  // 扩展模块的工具重名时覆盖内置的。
  const tools = [
    ...baseTools.filter((t) => !ext.tools?.some((x) => x.name === t.name)),
    ...(ext.tools ?? []),
  ];
  // MCP 服务器:第一次启动时连接,工具原地追加到 tools;required 的失败即退出。
  if (mcp === undefined) {
    const mcpCfg = mcpConfigOf(boot.config.mcp);
    const mcpServers = loadMcpServers(mcpCfg, process.cwd());
    if (mcpServers.length > 0) {
      const before = tools.length;
      try {
        mcp = await connectMcpServers(mcpServers, {
          log,
          tools,
          artifactsDir: sessionFile.replace(/.jsonl$/, ".mcp"),
          ...(mcpCfg && { mcp: mcpCfg }),
        });
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
      mcpTools = tools.slice(before);
    }
  } else tools.push(...mcpTools);
  const traceFile = sessionFile.replace(/.jsonl$/, ".trace.jsonl");

  app = createTuiApp({
    terminal: new ProcessTerminal(),
    log,
    provider: first.provider,
    tools,
    compaction,
    reserveTokens: RESERVE,
    info: {
      model: first.model,
      providerName: first.providerName,
      sessionFile,
      contextWindow: first.contextWindow,
      ...(first.capabilitySource && { capabilitySource: first.capabilitySource }),
    },
    settings: boot.settings,
    fold: args.fold,
    ...(args.foldLines !== undefined && { foldLines: args.foldLines }),
    ...(args.results && { results: args.results }),
    ...(args.facts && { facts: args.facts }),
    ...(args.planReminder !== undefined && { planReminder: args.planReminder }),
    ...(args.disabledTools && { disabledTools: args.disabledTools }),
    ...(args.foldSteps !== undefined && { foldSteps: args.foldSteps }),
    ...(args.screen && { screen: args.screen }),
    ...(args.notify && { notify: args.notify }),
    trace: args.trace,
    approve: resolveApproval(args, boot.config),
    compactionName: args.compaction,
    slots: {
      ...ext.slots,
      ...(args.execution && { execution: args.execution }),
      ...(args.steering === "turn" && { steering: queueToTurnEnd }),
    },
    ...(args.preservation && { preservationName: parsePreservation(args.preservation).label }),
    templates: discoverTemplates(),
    skills,
    sessionsDir: sessionDir,
    ...(mcp && { mcp }),
    toolPrompts: toolPromptsCfg,
    onExit: () => {
      void (mcp?.close() ?? Promise.resolve()).finally(() => process.exit(0));
    },
    ...(memory && { memory }),
    ...(args.effort && { effort: args.effort }),
    ...(first.effortLevels && { effortLevels: first.effortLevels }),
    ...(first.price && { price: first.price }),
    ...(first.unavailable && { unavailable: first.unavailable }),
    ...(args.trace && {
      onRaw: (requestIndex: number, line: string) =>
        appendFileSync(
          traceFile,
          `${JSON.stringify({ request: requestIndex, line })}
`,
        ),
    }),
    // 换会话:停掉这个界面,开或恢复另一份日志,再起一个;事件即真相,分叉就是复制前缀。
    switchSession: (target) => {
      let next: { log: EventLog; sessionFile: string };
      try {
        if (target.kind === "new")
          next = beginSession(sessionArgs, first, process.cwd(), sessionDir);
        else next = openSession({ resume: target.file, continue: false }, sessionDir);
      } catch (err) {
        app?.note((err as Error).message);
        return;
      }
      app?.stop();
      void launch(next);
    },
  });
}

await launch({ log, sessionFile });
