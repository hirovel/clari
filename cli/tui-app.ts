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
  type OverlayHandle,
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
import type { Provider, ToolDef } from "../src/provider.js";
import type { Tool } from "../src/tools.js";
import { fmtMs, fmtTok, RequestInspector } from "./inspector.js";
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
  /** 工具结果初始是否折叠。缺省不折叠(Q34);Ctrl+O 随时切换。 */
  fold?: boolean;
  /** 记录每次请求收到的原始流,供检视器"接收"分区逐行展示。 */
  trace?: boolean;
  /** 原始流旁路输出(如写 trace 文件)。requestIndex 是 request 事件在日志中的下标。 */
  onRaw?: (requestIndex: number, line: string) => void;
};

export type TuiApp = {
  tui: TUI;
  agent: Agent;
  submit(text: string): Promise<void>;
  command(text: string): Promise<void>;
  /** 当前文档的渲染行(带 ANSI),用于离线验证与预览。 */
  lines(width?: number): string[];
  /** 请求检视器(Ctrl+R)。lines() 在打开时返回检视器的渲染行,便于离线验证。 */
  inspector: {
    open(): void;
    close(): void;
    isOpen(): boolean;
    key(data: string): void;
    lines(width?: number): string[];
  };
  toggleFold(): void;
  toggleReasoning(): void;
  stop(): void;
};

/** 折叠时保留的行数。 */
const FOLD_HEAD = 3;

const COMMANDS = [
  { name: "inspect", description: "请求检视器:每次 API 请求的发送、接收与决策(Ctrl+R)" },
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
  tui.addChild(
    new Text(
      c.faint(
        "运行中输入即插话 · Esc 打断 · Ctrl+R 请求检视 · Ctrl+O 折叠结果 · Ctrl+T 思考 · /help",
      ),
      1,
      0,
    ),
  );
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

  // 显示状态(Q49):折叠/隐藏只改屏幕,不改日志;切换键重绘已有节点。
  let foldResults = deps.fold ?? false;
  let showReasoning = true;
  const resultNodes: { node: Text; name: string; content: string; isError: boolean }[] = [];
  const reasoningNodes: { node: Text; text: string }[] = [];

  // 请求层记录(Q48):发出每个请求时用的 provider,以及开 trace 时收到的原始流。都不进日志。
  const providersAt = new Map<number, Provider>();
  const rawAt = new Map<number, string[]>();
  let requestCount = 0;
  let lastRequestIndex = -1;
  let lastRequest: Extract<AgentEvent, { type: "request" }> | undefined;

  // 推理内容不隐藏(Q34):thinking 模型的思考过程以淡字实时呈现。
  const renderReasoning = (s: string) =>
    showReasoning
      ? `${c.faint("思考")}\n${c.faint(c.italic(indent(s.trim())))}`
      : c.faint("思考(已隐藏,Ctrl+T 显示)");

  const agent = new Agent({
    log,
    provider: deps.provider,
    tools,
    compaction,
    onRaw: (line) => {
      if (deps.trace) {
        const bucket = rawAt.get(lastRequestIndex) ?? [];
        bucket.push(line);
        rawAt.set(lastRequestIndex, bucket);
      }
      deps.onRaw?.(lastRequestIndex, line);
    },
    onDelta: (d) => {
      if (!streaming) {
        transcript.addChild(new Spacer(1));
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

  /** 工具结果的屏幕文本。折叠只是显示状态,内容原封不动留在节点里。 */
  function resultText(r: { name: string; content: string; isError: boolean }): string {
    const mark = r.isError ? c.zhu("✗") : c.green("✓");
    const trimmed = r.content.trim();
    const all = trimmed ? trimmed.split("\n") : [];
    let body: string;
    if (all.length === 0) body = "  (无输出)";
    else if (foldResults && all.length > FOLD_HEAD + 1) {
      body = `${indent(all.slice(0, FOLD_HEAD).join("\n"))}\n${c.soft(`  … 还有 ${all.length - FOLD_HEAD} 行(Ctrl+O 展开)`)}`;
    } else body = indent(trimmed);
    return `${mark} ${c.soft(r.name)}\n${r.isError ? c.soft(body) : c.faint(body)}`;
  }

  function toggleFold(): void {
    foldResults = !foldResults;
    for (const r of resultNodes) r.node.setText(resultText(r));
    note(c.faint(foldResults ? "· 工具结果已折叠(Ctrl+O 展开)" : "· 工具结果已展开"));
  }

  function toggleReasoning(): void {
    showReasoning = !showReasoning;
    for (const r of reasoningNodes) r.node.setText(renderReasoning(r.text));
    if (reasoningView) reasoningView.setText(renderReasoning(reasoningBuffer));
    note(c.faint(showReasoning ? "· 思考已显示" : "· 思考已隐藏(Ctrl+T 显示)"));
  }

  /** 一步请求的一行小结:估算 vs 实测、缓存、输出、耗时、停止原因。检视器展开全部细节。 */
  function requestSummary(e: Extract<AgentEvent, { type: "assistant/message" }>): string {
    if (!lastRequest) return "";
    const u = e.usage;
    const measured = u
      ? `→ 实测 ${fmtTok(u.inputTokens)}${u.cacheReadTokens !== undefined ? `(缓存 ${fmtTok(u.cacheReadTokens)})` : ""} · +${fmtTok(u.outputTokens)}`
      : "→ 无用量";
    return c.faint(
      `· #${requestCount}  ${lastRequest.messages} 条消息 ≈${fmtTok(lastRequest.estimatedTokens)} ${measured} · ${fmtMs(e.latencyMs)} · ${e.stopReason}`,
    );
  }

  // ---------- 请求检视器(Q49) ----------

  const defs = (): ToolDef[] =>
    tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  let overlay: OverlayHandle | undefined;
  const inspector = new RequestInspector({
    events: () => log.events,
    providerFor: (i) => providersAt.get(i),
    tools: defs,
    rows: () => deps.terminal.rows,
    ...(deps.trace && { rawFor: (i: number) => rawAt.get(i) }),
    onClose: () => closeInspector(),
    requestRender: () => tui.requestRender(),
  });

  function openInspector(): void {
    if (overlay) return;
    inspector.reset();
    overlay = tui.showOverlay(inspector, { width: "100%", maxHeight: "100%", anchor: "top-left" });
    tui.requestRender();
  }

  function closeInspector(): void {
    if (!overlay) return;
    overlay.hide();
    overlay = undefined;
    tui.setFocus(editor);
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
          if (e.reasoning) {
            reasoningView.setText(renderReasoning(e.reasoning));
            reasoningNodes.push({ node: reasoningView, text: e.reasoning });
          } else transcript.removeChild(reasoningView);
          reasoningView = undefined;
          reasoningBuffer = "";
        } else if (e.reasoning) {
          const node = new Text(renderReasoning(e.reasoning), 1, 0);
          reasoningNodes.push({ node, text: e.reasoning });
          transcript.addChild(node);
        }
        if (streaming) {
          if (e.text) streaming.setText(e.text);
          else transcript.removeChild(streaming);
          streaming = undefined;
          streamBuffer = "";
        } else if (e.text) {
          transcript.addChild(new Spacer(1));
          transcript.addChild(new Markdown(e.text, 1, 0, markdownTheme, { color: c.ink }));
        }
        if (e.toolCalls.length > 0) transcript.addChild(new Spacer(1));
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
        // 每步一行请求小结(Q48):始终显示,一行不爆;细节进检视器。
        const summary = requestSummary(e);
        if (summary) note(summary);
        if (e.stopReason === "aborted") note(c.faint("— 已打断 —"));
        if (e.stopReason === "length") note(c.jin("◇ 输出被截断,已要求模型重发"));
        break;
      }
      case "tool/result": {
        // 默认完整显示,不折叠(Q34);Ctrl+O 切换折叠,内容仍在节点里。
        const rec = { name: e.name, content: e.content, isError: e.isError };
        const node = new Text(resultText(rec), 1, 0);
        resultNodes.push({ node, ...rec });
        transcript.addChild(node);
        break;
      }
      case "request":
        requestCount += 1;
        lastRequestIndex = log.events.length - 1;
        lastRequest = e;
        providersAt.set(lastRequestIndex, agent.provider);
        break;
      case "retry":
        note(
          c.faint(
            `· 重试 ${e.attempt}:${e.status ?? ""} ${e.error.split("\n")[0]},${fmtMs(e.delayMs)} 后再试`,
          ),
        );
        break;
      case "decision":
        if (e.slot === "steering") note(c.faint(`· 插话注入 ${e.injected} 条(${e.boundary} 边界)`));
        break;
      case "request/error":
        // 循环随后抛出,submit 的 catch 负责呈现,这里不重复。
        break;
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
      case "inspect":
        openInspector();
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
    if (matchesKey(data, Key.ctrl("r"))) {
      if (overlay) closeInspector();
      else openInspector();
      return { consume: true };
    }
    if (overlay) return undefined; // 检视器打开时,其余按键归它
    if (matchesKey(data, Key.ctrl("o"))) {
      toggleFold();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("t"))) {
      toggleReasoning();
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
    inspector: {
      open: openInspector,
      close: closeInspector,
      isOpen: () => overlay !== undefined,
      key: (data) => inspector.handleInput(data),
      lines: (width = deps.terminal.columns) => (overlay ? inspector.render(width) : []),
    },
    toggleFold,
    toggleReasoning,
    stop,
  };
}

/** 工具参数的人读形态:命令与路径直接展示,其余压成紧凑 JSON。 */
function formatArgs(args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  let s: string;
  if (typeof a.command === "string") s = a.command;
  else if (typeof a.path === "string") {
    const range =
      typeof a.offset === "number" || typeof a.limit === "number"
        ? `  第 ${a.offset ?? 1} 行起${typeof a.limit === "number" ? `,${a.limit} 行` : ""}`
        : "";
    s = `${a.path}${range}`;
  } else s = JSON.stringify(args) ?? "";
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
