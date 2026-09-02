// TUI 应用:与终端实现解耦,便于用虚拟终端离线验证。cli/tui.ts 负责配置与真实终端,本文件负责界面。
// pi-tui 只当渲染引擎(Q45):差分渲染、编辑器、宽度计算;视觉层全部是这里的自有组合。
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  Loader,
  Markdown,
  matchesKey,
  Spacer,
  type Terminal,
  Text,
  type TUI,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { Agent } from "../src/agent.js";
import { contextBreakdown } from "../src/context.js";
import { type AgentEvent, now } from "../src/events.js";
import type { EventLog } from "../src/log.js";
import type { CompactionConfig } from "../src/loop.js";
import type { Provider } from "../src/provider.js";
import type { Tool } from "../src/tools.js";
import { c, editorTheme, markdownTheme } from "./theme.js";

export type ModelChoice = {
  provider: Provider;
  model: string;
  providerName: string;
  contextWindow: number;
};

export type TuiSettings = {
  /** "供应商/模型" 列表,供 /model 与补全使用。 */
  listModels(): string[];
  /** 按名切换模型(可能需要读 key),返回新 provider。 */
  switchModel(name: string): ModelChoice;
  /** 写入某供应商的 key 并落盘。 */
  setKey(providerName: string, key: string): void;
  /** 把某模型设为缺省并落盘。 */
  setDefault(model: string): void;
};

export type TuiAppDeps = {
  terminal: Terminal;
  log: EventLog;
  provider: Provider;
  tools: Tool[];
  compaction: CompactionConfig;
  reserveTokens: number;
  info: { model: string; providerName: string; sessionFile: string };
  settings?: TuiSettings;
  systemPrompt: string;
  onExit?: () => void;
};

export type TuiApp = {
  tui: TUI;
  agent: Agent;
  submit(text: string): Promise<void>;
  command(text: string): Promise<void>;
  /** 当前文档的渲染行(带 ANSI),用于离线验证与预览。 */
  lines(width?: number): string[];
  stop(): void;
};

const COMMANDS = [
  { name: "context", description: "上下文构成:各部分 token 与占比" },
  { name: "compact", description: "手动压缩,可附指示:/compact 保留报错" },
  { name: "model", description: "切换模型:/model 供应商/模型;不带参数列出可选" },
  { name: "key", description: "设置供应商 key:/key deepseek sk-…(写入配置文件)" },
  { name: "default", description: "把当前模型设为缺省" },
  { name: "stop", description: "打断正在运行的 turn" },
  { name: "help", description: "命令列表" },
  { name: "quit", description: "退出" },
];

export function createTuiApp(deps: TuiAppDeps): TuiApp {
  const { log, tools, compaction } = deps;
  let info = deps.info;
  let contextWindow = compaction.window;
  const threshold = () => contextWindow - deps.reserveTokens;

  const tui = new TuiMainScreen(deps.terminal);
  const header = new Text("", 1, 0);
  const transcript = new Container();
  const live = new Container();
  const status = new Text("", 1, 0);
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, process.cwd()));

  tui.addChild(header);
  tui.addChild(new Text(c.faint("运行中输入即插话 · Esc 打断 · /help 命令"), 1, 0));
  tui.addChild(new Spacer(1));
  tui.addChild(transcript);
  tui.addChild(live);
  tui.addChild(new Spacer(1));
  tui.addChild(status);
  tui.addChild(editor);

  let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
  let streaming: Markdown | undefined;
  let streamBuffer = "";
  let reasoningView: Text | undefined;
  let reasoningBuffer = "";
  let loader: Loader | undefined;

  // 推理内容不隐藏(Q34):thinking 模型的思考过程以淡字实时呈现。
  const renderReasoning = (s: string) =>
    `${c.faint("思考")}\n${c.faint(c.italic(indent(s.trim())))}`;

  const agent = new Agent({
    log,
    provider: deps.provider,
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
    onReasoning: (d) => {
      if (!reasoningView) {
        reasoningView = new Text("", 1, 0);
        transcript.addChild(reasoningView);
      }
      reasoningBuffer += d;
      reasoningView.setText(renderReasoning(reasoningBuffer));
      tui.requestRender();
    },
  });

  const exit = deps.onExit ?? (() => process.exit(0));

  function updateHeader(): void {
    header.setText(
      `${c.bold(c.jin("agent-kernel"))}  ${c.ink(info.model)}  ${c.faint(`${info.providerName} · ${info.sessionFile}`)}`,
    );
  }

  function updateStatus(): void {
    const state = agent.running ? c.zhu("● 运行中") : c.green("○ 空闲");
    const t = threshold();
    const tokens = lastUsage
      ? `${lastUsage.inputTokens}→${lastUsage.outputTokens} tok · 距自动压缩 ${pct(Math.max(0, (t - lastUsage.inputTokens) / t))}`
      : "尚无请求";
    const queued = agent.queued > 0 ? ` · 留言 ${agent.queued}` : "";
    status.setText(`${state}  ${c.faint(tokens + queued)}`);
    tui.requestRender();
  }

  function note(text: string): void {
    transcript.addChild(new Text(text, 1, 0));
    tui.requestRender();
  }

  function showLoader(message: string): void {
    hideLoader();
    loader = new Loader(tui, c.zhu, c.faint, message);
    live.addChild(loader);
    loader.start();
  }

  function hideLoader(): void {
    if (!loader) return;
    loader.stop();
    live.removeChild(loader);
    loader = undefined;
  }

  // ---------- 呈现:UI 是事件流的订阅者 ----------

  function render(e: AgentEvent): void {
    switch (e.type) {
      case "user/message":
        transcript.addChild(new Spacer(1));
        transcript.addChild(new Text(`${c.zhu("›")} ${c.bold(c.ink(e.text))}`, 1, 0));
        break;
      case "assistant/message": {
        if (reasoningView) {
          if (e.reasoning) reasoningView.setText(renderReasoning(e.reasoning));
          else transcript.removeChild(reasoningView);
          reasoningView = undefined;
          reasoningBuffer = "";
        } else if (e.reasoning) {
          transcript.addChild(new Text(renderReasoning(e.reasoning), 1, 0));
        }
        if (streaming) {
          if (e.text) streaming.setText(e.text);
          else transcript.removeChild(streaming);
          streaming = undefined;
          streamBuffer = "";
        } else if (e.text) {
          transcript.addChild(new Markdown(e.text, 1, 0, markdownTheme, { color: c.ink }));
        }
        for (const tc of e.toolCalls) {
          transcript.addChild(
            new Text(
              `${c.zhu("⚙")} ${c.bold(c.ink(tc.name))}  ${c.soft(formatArgs(tc.args))}`,
              1,
              0,
            ),
          );
        }
        if (e.usage) lastUsage = e.usage;
        if (e.stopReason === "aborted") note(c.faint("— 已打断 —"));
        if (e.stopReason === "length") note(c.jin("◇ 输出被截断,已要求模型重发"));
        break;
      }
      case "tool/result": {
        const mark = e.isError ? c.zhu("✗") : c.green("✓");
        const trimmed = e.content.trim();
        const body = trimmed ? indent(trimmed) : "  (无输出)";
        // 默认完整显示,不折叠(Q34)。
        transcript.addChild(
          new Text(`${mark} ${c.soft(e.name)}\n${e.isError ? c.soft(body) : c.faint(body)}`, 1, 0),
        );
        break;
      }
      case "compaction": {
        const parts: string[] = [];
        if (e.summary !== undefined)
          parts.push(`摘要覆盖事件 ${e.coversFrom ?? 1}-${e.coversUpTo}`);
        if (e.cleared?.length) parts.push(`清除 ${e.cleared.length} 条工具结果`);
        note(`${c.jin(`◇ 已压缩:${parts.join(",")}`)}${c.faint("  /context 查看新构成")}`);
        break;
      }
      case "session/model":
        note(c.jin(`◇ 已切换模型:${e.model}`));
        break;
      case "session/interrupt":
      case "session/start":
        break;
    }
    updateStatus();
  }

  log.subscribe(render);
  log.append({ type: "session/start", at: now(), model: info.model, system: deps.systemPrompt });
  updateHeader();
  updateStatus();

  // ---------- 输入 ----------

  async function submit(text: string): Promise<void> {
    if (agent.running) {
      void agent.prompt(text);
      updateStatus();
      return;
    }
    showLoader("思考中");
    try {
      // prompt() 同步执行到首个 await 时已把 running 置位;此处刷新状态栏才能显示"运行中"。
      const pending = agent.prompt(text);
      updateStatus();
      const outcome = await pending;
      if (typeof outcome === "object") note(c.jin(`◇ 循环停止:${outcome.stopped}`));
    } catch (err) {
      note(c.zhu(`✗ 请求失败:${(err as Error).message}`));
    } finally {
      hideLoader();
      updateStatus();
    }
  }

  async function command(text: string): Promise<void> {
    const [cmd = "", ...rest] = text.replace(/^\//, "").split(/\s+/);
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "help":
        note(
          COMMANDS.map((x) => `${c.jin(`/${x.name}`.padEnd(10))} ${c.soft(x.description)}`).join(
            "\n",
          ),
        );
        break;
      case "quit":
        stop();
        exit();
        break;
      case "stop":
        agent.interrupt();
        break;
      case "context":
        note(renderContext());
        break;
      case "compact":
        await manualCompact(arg);
        break;
      case "model":
        switchModel(arg);
        break;
      case "key":
        setKey(arg);
        break;
      case "default":
        if (!deps.settings) {
          note(c.zhu("未配置设置接口"));
          break;
        }
        deps.settings.setDefault(`${info.providerName}/${info.model}`);
        note(c.jin(`◇ 缺省模型已设为 ${info.providerName}/${info.model}`));
        break;
      default:
        note(c.zhu(`未知命令 /${cmd}`) + c.faint("  /help 查看命令"));
    }
  }

  function switchModel(arg: string): void {
    if (!deps.settings) {
      note(c.zhu("未配置设置接口"));
      return;
    }
    const models = deps.settings.listModels();
    if (!arg) {
      note(
        `${c.soft("当前")} ${c.ink(`${info.providerName}/${info.model}`)}\n${models
          .map((m) =>
            m === `${info.providerName}/${info.model}` ? c.jin(`  ▸ ${m}`) : c.faint(`    ${m}`),
          )
          .join("\n")}\n${c.faint("用法:/model 供应商/模型")}`,
      );
      return;
    }
    if (agent.running) {
      note(c.zhu("运行中不能切换模型,先 Esc 打断"));
      return;
    }
    try {
      const choice = deps.settings.switchModel(arg);
      agent.setProvider(choice.provider);
      info = { ...info, model: choice.model, providerName: choice.providerName };
      contextWindow = choice.contextWindow;
      compaction.window = choice.contextWindow;
      updateHeader();
      updateStatus();
    } catch (err) {
      note(c.zhu(`✗ ${(err as Error).message}`));
    }
  }

  function setKey(arg: string): void {
    if (!deps.settings) {
      note(c.zhu("未配置设置接口"));
      return;
    }
    const [providerName, ...keyParts] = arg.split(/\s+/);
    const key = keyParts.join("");
    if (!providerName || !key) {
      note(c.faint("用法:/key 供应商 密钥   例:/key deepseek sk-xxxx"));
      return;
    }
    try {
      deps.settings.setKey(providerName, key);
      note(
        c.jin(`◇ ${providerName} 的 key 已写入配置文件`) + c.faint("  /model 切换到该供应商即生效"),
      );
    } catch (err) {
      note(c.zhu(`✗ ${(err as Error).message}`));
    }
  }

  async function manualCompact(instructions: string): Promise<void> {
    showLoader("压缩中");
    try {
      const payload = await compaction.strategy({
        events: log.events,
        window: contextWindow,
        targetTokens: threshold(),
        provider: agent.provider,
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

  editor.onSubmit = (raw) => {
    const text = raw.trim();
    editor.setText("");
    if (!text) return;
    editor.addToHistory(text);
    if (text.startsWith("/")) void command(text);
    else void submit(text);
  };

  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      stop();
      exit();
      return { consume: true };
    }
    if (matchesKey(data, Key.escape) && agent.running && !editor.isShowingAutocomplete()) {
      agent.interrupt();
      return { consume: true };
    }
    return undefined;
  });

  function stop(): void {
    hideLoader();
    tui.stop();
  }

  tui.setFocus(editor);
  tui.start();

  return {
    tui,
    agent,
    submit,
    command,
    lines: (width = deps.terminal.columns) => tui.render(width),
    stop,
  };
}

function formatArgs(args: unknown): string {
  const s = JSON.stringify(args) ?? "";
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
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
