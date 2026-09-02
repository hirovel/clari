// TUI 壳(Q6 第二阶段):pi-tui 主屏模式,保留终端滚动历史。
// 用法:pnpm tui [-- --model <名>] [--subagent] [--compaction llm|clear|pipeline]
// 运行中输入 = 插话;Esc = 打断;/help 看命令。
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
  Spacer,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { Agent } from "../src/agent.js";
import { clearToolResults, llmSummarize, pipeline } from "../src/compaction.js";
import {
  createProvider,
  DEFAULT_CONFIG_PATH,
  loadConfig,
  resolveApiKey,
  resolveModel,
} from "../src/config.js";
import { contextBreakdown } from "../src/context.js";
import { type AgentEvent, now } from "../src/events.js";
import { EventLog } from "../src/log.js";
import type { CompactionConfig } from "../src/loop.js";
import { createTaskTool } from "../src/subagent.js";
import type { Tool } from "../src/tools.js";
import { c, editorTheme, markdownTheme } from "./theme.js";
import { bashTool } from "./tools/bash.js";
import { editTool, readTool, writeTool } from "./tools/fs.js";

// ---------- 启动:参数、配置、供应商 ----------

const args = parseArgs(process.argv.slice(2));
const { config, created } = loadConfig();
if (created) {
  console.log(`已生成配置模板:${DEFAULT_CONFIG_PATH}`);
  console.log("填入各家的 API key(推荐通过环境变量),或直接写入 providers.<名>.apiKey。\n");
}

let resolved: ReturnType<typeof resolveModel>;
let apiKey: string;
try {
  resolved = resolveModel(config, args.model);
  apiKey = resolveApiKey(resolved.providerName, resolved.provider);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const provider = createProvider(resolved, apiKey);
const contextWindow = resolved.contextWindow;
const RESERVE = 32000;
const threshold = contextWindow - RESERVE;

const sessionFile = `sessions/${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
const log = new EventLog(sessionFile);

const COMPACTION_STRATEGIES = {
  llm: () => llmSummarize(),
  clear: () => clearToolResults(),
  pipeline: () => pipeline(clearToolResults(), llmSummarize()),
} as const;
const strategyName = (args.compaction ?? "llm") as keyof typeof COMPACTION_STRATEGIES;
const compaction: CompactionConfig = {
  strategy: (COMPACTION_STRATEGIES[strategyName] ?? COMPACTION_STRATEGIES.llm)(),
  window: contextWindow,
  reserveTokens: RESERVE,
};

const baseTools: Tool[] = [readTool, writeTool, editTool, bashTool];
const tools: Tool[] = args.subagent
  ? [...baseTools, createTaskTool({ parent: log, provider, tools: baseTools, compaction })]
  : baseTools;

// ---------- 界面 ----------

const tui = new TuiMainScreen(new ProcessTerminal());
const transcript = new Container();
const live = new Container();
const status = new Text("", 1, 0);
const editor = new Editor(tui, editorTheme, { paddingX: 1 });

tui.addChild(
  new Text(
    `${c.jin("agent-kernel")}  ${c.soft(resolved.model)}  ${c.faint(`· ${resolved.providerName} · ${sessionFile}`)}`,
    1,
    0,
  ),
);
tui.addChild(new Text(c.faint("运行中输入即插话 · Esc 打断 · /help 命令"), 1, 0));
tui.addChild(new Spacer(1));
tui.addChild(transcript);
tui.addChild(live);
tui.addChild(status);
tui.addChild(editor);

const COMMANDS = [
  { name: "context", description: "上下文构成:各部分 token 与占比" },
  { name: "compact", description: "手动压缩,可附指示:/compact 保留报错" },
  { name: "stop", description: "打断正在运行的 turn" },
  { name: "model", description: "当前模型与已配置的模型" },
  { name: "help", description: "命令列表" },
  { name: "quit", description: "退出" },
];
editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, process.cwd()));

let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
let streaming: Markdown | undefined;
let streamBuffer = "";
let loader: Loader | undefined;

const agent = new Agent({
  log,
  provider,
  tools,
  compaction,
  onDelta: (d) => {
    if (!streaming) {
      streaming = new Markdown("", 1, 0, markdownTheme, { color: c.ink });
      transcript.addChild(streaming);
    }
    streamBuffer += d;
    streaming.setText(streamBuffer);
    tui.requestRender();
  },
});

log.subscribe(render);
log.append({
  type: "session/start",
  at: now(),
  model: resolved.model,
  system:
    "你是一个在用户机器上工作的编程助手。工作目录即当前目录。" +
    "优先用 read/edit 做精确修改,用 bash 执行命令与搜索。回答简洁。",
});
updateStatus();

// ---------- 输入 ----------

editor.onSubmit = (raw) => {
  const text = raw.trim();
  editor.setText("");
  if (!text) return;
  editor.addToHistory(text);
  if (text.startsWith("/")) {
    void handleCommand(text);
    return;
  }
  void submit(text);
};

function quit(): void {
  tui.stop();
  process.exit(0);
}

tui.addInputListener((data) => {
  if (matchesKey(data, Key.ctrl("c"))) quit();
  if (matchesKey(data, Key.escape) && agent.running && !editor.isShowingAutocomplete()) {
    agent.interrupt();
    return { consume: true };
  }
  return undefined;
});

async function submit(text: string): Promise<void> {
  if (agent.running) {
    void agent.prompt(text);
    updateStatus();
    return;
  }
  showLoader("思考中");
  try {
    const outcome = await agent.prompt(text);
    if (typeof outcome === "object") note(c.jin(`◇ 循环停止:${outcome.stopped}`));
  } catch (err) {
    note(c.zhu(`✗ 请求失败:${(err as Error).message}`));
  } finally {
    hideLoader();
    updateStatus();
  }
}

async function handleCommand(text: string): Promise<void> {
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "help":
      note(COMMANDS.map((x) => `${c.jin(`/${x.name}`)}  ${c.soft(x.description)}`).join("\n"));
      break;
    case "quit":
      quit();
      break;
    case "stop":
      agent.interrupt();
      break;
    case "model": {
      const all = Object.entries(config.providers).flatMap(([pn, p]) =>
        p.models.map((m) => `${pn}/${m}`),
      );
      note(
        `${c.soft("当前")} ${c.bold(resolved.model)} ${c.faint(`(${resolved.providerName})`)}\n` +
          `${c.soft("切换需重启:")} ${c.faint("pnpm tui -- --model <名>")}\n${all.map((m) => c.faint(`  ${m}`)).join("\n")}`,
      );
      break;
    }
    case "context":
      note(renderContext());
      break;
    case "compact":
      await manualCompact(arg);
      break;
    default:
      note(c.zhu(`未知命令 /${cmd}`));
  }
}

async function manualCompact(instructions: string): Promise<void> {
  showLoader("压缩中");
  try {
    const payload = await compaction.strategy({
      events: log.events,
      window: contextWindow,
      targetTokens: threshold,
      provider,
      ...(instructions && { instructions }),
    });
    if (!payload) note(c.faint("压缩未执行:无事可做或未取得足够进展"));
    else log.append({ type: "compaction", at: now(), ...payload });
  } catch (err) {
    note(c.zhu(`✗ 压缩失败:${(err as Error).message}`));
  } finally {
    hideLoader();
    updateStatus();
  }
}

// ---------- 呈现:UI 是事件流的订阅者 ----------

function render(e: AgentEvent): void {
  switch (e.type) {
    case "user/message":
      transcript.addChild(new Spacer(1));
      transcript.addChild(new Text(`${c.zhu("›")} ${c.bold(c.ink(e.text))}`, 1, 0));
      break;
    case "assistant/message": {
      if (streaming) {
        streaming.setText(e.text);
        streaming = undefined;
        streamBuffer = "";
      } else if (e.text) {
        transcript.addChild(new Markdown(e.text, 1, 0, markdownTheme, { color: c.ink }));
      }
      for (const tc of e.toolCalls) {
        transcript.addChild(
          new Text(`${c.zhu("⚙")} ${c.bold(tc.name)} ${c.soft(formatArgs(tc.args))}`, 1, 0),
        );
      }
      if (e.usage) lastUsage = e.usage;
      if (e.stopReason === "aborted") note(c.faint("— 已打断 —"));
      if (e.stopReason === "length") note(c.jin("◇ 输出被截断,已要求模型重发"));
      updateStatus();
      break;
    }
    case "tool/result": {
      const mark = e.isError ? c.zhu("✗") : c.green("✓");
      const body = e.content.trim() ? indent(e.content.trim()) : c.faint("  (无输出)");
      // 默认完整显示,不折叠(Q34)。
      transcript.addChild(
        new Text(`${mark} ${c.soft(e.name)}\n${e.isError ? c.soft(body) : c.faint(body)}`, 1, 0),
      );
      break;
    }
    case "compaction": {
      const parts: string[] = [];
      if (e.summary !== undefined) parts.push(`摘要覆盖事件 ${e.coversFrom ?? 1}-${e.coversUpTo}`);
      if (e.cleared?.length) parts.push(`清除 ${e.cleared.length} 条工具结果`);
      note(c.jin(`◇ 已压缩:${parts.join(",")}`) + c.faint("  /context 查看新构成"));
      break;
    }
    case "session/interrupt":
      break;
    case "session/start":
      break;
  }
  tui.requestRender();
}

function renderContext(): string {
  const b = contextBreakdown(log.events, contextWindow);
  const lines = [
    `${c.soft("上下文构成")}  ${c.ink(`估算 ${b.estimatedTokens} tok`)} ${c.faint(`/ 窗口 ${b.window},占 ${pct(b.usedShare)}`)}`,
  ];
  if (b.measuredTokens !== undefined)
    lines.push(c.faint(`上次请求实测输入 ${b.measuredTokens} tok`));
  for (const p of b.parts) {
    const bar = "█".repeat(Math.max(1, Math.round(p.share * 24))).padEnd(24);
    lines.push(
      `${c.jin(bar)} ${pct(p.share).padStart(4)}  ${c.soft(`${p.tokens} tok · ${p.count} 条 · ${p.label}`)}`,
    );
  }
  return lines.join("\n");
}

function updateStatus(): void {
  const state = agent.running ? c.zhu("● 运行中") : c.green("○ 空闲");
  const tokens = lastUsage
    ? `${lastUsage.inputTokens}→${lastUsage.outputTokens} tok · 距自动压缩 ${pct(Math.max(0, (threshold - lastUsage.inputTokens) / threshold))}`
    : "尚无请求";
  const queued = agent.queued > 0 ? ` · 留言 ${agent.queued}` : "";
  status.setText(`${state}  ${c.faint(tokens + queued)}`);
  tui.requestRender();
}

function showLoader(message: string): void {
  hideLoader();
  loader = new Loader(tui, c.zhu, c.faint, message);
  live.addChild(loader);
  loader.start();
  updateStatus();
}

function hideLoader(): void {
  if (!loader) return;
  loader.stop();
  live.removeChild(loader);
  loader = undefined;
  tui.requestRender();
}

function note(text: string): void {
  transcript.addChild(new Text(text, 1, 0));
  tui.requestRender();
}

function formatArgs(args: unknown): string {
  const s = JSON.stringify(args);
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function parseArgs(argv: string[]): { model?: string; subagent: boolean; compaction?: string } {
  const out: { model?: string; subagent: boolean; compaction?: string } = { subagent: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--model" && next) {
      out.model = next;
      i++;
    } else if (a === "--compaction" && next) {
      out.compaction = next;
      i++;
    } else if (a === "--subagent") {
      out.subagent = true;
    }
  }
  return out;
}

tui.setFocus(editor);
tui.start();
