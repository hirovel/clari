// TUI 应用:与终端实现解耦,便于用虚拟终端离线验证。cli/tui.ts 负责配置与真实终端,本文件负责组装。
//
// pi-tui 只当渲染引擎(Q45):差分渲染、编辑器、宽度计算;视觉层全部是自有组合。
// 界面分成几个接 ctx 的模块(重构块 2):
//   tui-context   共享状态的形状
//   tui-render    事件 → 屏幕,子 agent 视图,流式增量
//   tui-commands  提交与 / 命令的分发,列表类命令
//   tui-edit      编辑上下文的命令与面板动作
//   tui-slots     策略槽切换与审批提示
// 本文件只做:建组件树、建 Agent、建 ctx、接检视器与按键、回放历史、返回 TuiApp 接口。
import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Key,
  Loader,
  matchesKey,
  Spacer,
  type Terminal,
  Text,
  type TUI,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { Agent, type DeliverAs } from "../src/agent.js";
import type { ApprovalConfig } from "../src/approval.js";
import type { ToolPromptsConfig } from "../src/config.js";
import { fmtCost, type Price, UsageAccumulator } from "../src/cost.js";
import { type AgentEvent, now } from "../src/events.js";
import type { EventLog } from "../src/log.js";
import { type CompactionConfig, compactionThreshold, type TurnDeps } from "../src/loop.js";
import type { EffortLevel, Provider, ToolDef } from "../src/provider.js";
import type { ChildInfo } from "../src/subagent.js";
import type { Tool } from "../src/tools.js";
import { firstRunLines, GUTTER, shortcutLines, thinkingLines } from "./cards.js";
import { fmtTok, RequestInspector, type SessionSource } from "./inspector.js";
import type { McpServerStatus } from "./mcp/bridge.js";
import type { Skill } from "./prompt.js";
import type { PromptTemplate } from "./templates.js";
import { c, editorTheme } from "./theme.js";
import type { MemoryFiles } from "./tools/memory.js";
import { COMMANDS, command, submit } from "./tui-commands.js";
import { RAW_LINE_CAP, type TuiContext } from "./tui-context.js";
import { contextAction } from "./tui-edit.js";
import { brief, pct } from "./tui-format.js";
import {
  attachChild,
  render,
  streamDelta,
  streamReasoning,
  toggleFold,
  toggleReasoning,
} from "./tui-render.js";
import { approveImpl, initialApproval, initialSlotState } from "./tui-slots.js";

export { toolCallDetail } from "./tui-format.js";
export { childEventLines } from "./tui-render.js";

export type ModelChoice = {
  provider: Provider;
  model: string;
  providerName: string;
  contextWindow: number;
  /** 该模型声明支持的强度级别;不声明 = 不校验。 */
  effortLevels?: EffortLevel[];
  /** 价格数据(配置里给了才有),只用于显示费用。 */
  price?: Price;
};

export type TuiSettings = {
  /** "供应商/模型" 列表,供 /model 与补全使用。 */
  listModels(): string[];
  /** 某模型的价格;没配置返回 undefined。会话里换过模型时按各自价格累计。 */
  priceFor?(model: string): Price | undefined;
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
  /** 日志为空时用它落 session/start;入口已经落过(bootstrap.beginSession)就不需要。 */
  systemPrompt?: string;
  onExit?: () => void;
  /** 工具结果初始是否折叠。缺省不折叠(Q34);Ctrl+O 随时切换。 */
  fold?: boolean;
  /** 记录每次请求收到的原始流,供检视器"接收"分区逐行展示。 */
  trace?: boolean;
  /** 原始流旁路输出(如写 trace 文件)。requestIndex 是 request 事件在日志中的下标。 */
  onRaw?: (requestIndex: number, line: string) => void;
  /** 初始强度级别(Q52);缺省不传。 */
  effort?: EffortLevel;
  effortLevels?: EffortLevel[];
  /** 起始模型的价格(配置里给了才有)。 */
  price?: Price;
  /**
   * 审批槽的启动形态(Q84):all(缺省)不问;ask 每个调用都问;规则对象 = policy 模式,
   * 按规则裁决,规则说 ask 的才问人。/approve 在会话中切换。
   */
  approve?: "all" | "ask" | ApprovalConfig;
  /** 跨会话记忆已打开时的两个文件(Q65),供 /memory 看与删。 */
  memory?: MemoryFiles;
  /** 启动时的压缩策略名(llm / clear / pipeline / 模块路径),/slots 显示用;缺省 llm。 */
  compactionName?: string;
  /** 策略槽实现(执行策略、扩展模块换上的槽等)。approve=ask 时界面的审批实现覆盖这里的 approve。 */
  slots?: TurnDeps["slots"];
  /** 提示词模板:/名 参数 展开成一条用户消息。 */
  templates?: PromptTemplate[];
  /** 技能(Q80):/名 参数 触发;/skills 列出。 */
  skills?: Skill[];
  /** 会话目录,/fork 的新文件写到这里。 */
  sessionsDir?: string;
  /** MCP 桥接(Q87):/mcp 列状态。工具本身已在 tools 里。 */
  mcp?: { statuses(): McpServerStatus[] };
  /** 工具描述风格槽(Q89)的启动形态;/toolprompts 会话中切换与逐条编辑。 */
  toolPrompts?: ToolPromptsConfig;
  /** 启动时的保留策略显示名(--preservation / 配置);缺省内置。 */
  preservationName?: string;
};

export type TuiApp = {
  tui: TUI;
  agent: Agent;
  /** 提交一条用户消息;运行中时 deliverAs 决定是步边界插话(缺省)还是等模型做完再给。 */
  submit(text: string, opts?: { deliverAs?: DeliverAs }): Promise<void>;
  command(text: string): Promise<void>;
  /** 当前文档的渲染行(带 ANSI),用于离线验证与预览。 */
  lines(width?: number): string[];
  /** 请求检视器(Ctrl+R)。lines() 在打开时返回检视器的渲染行,便于离线验证。 */
  inspector: {
    open(): void;
    openEvents(): void;
    openCompactions(): void;
    openComposition(): void;
    close(): void;
    isOpen(): boolean;
    key(data: string): void;
    lines(width?: number): string[];
  };
  /** 子 agent 开跑时由 task 工具通知(Q62):挂到对应调用行下面并实时订阅。 */
  attachChild(child: ChildInfo): void;
  children(): ChildInfo[];
  /** 正在等待回答的审批提示的渲染行;没有时为空。离线验证用(覆盖层不在 lines() 里)。 */
  approvalLines(): string[];
  /** 把按键送给正在等待的审批提示(离线验证用)。 */
  approvalInput(data: string): void;
  toggleFold(): void;
  toggleReasoning(): void;
  stop(): void;
};

export function createTuiApp(deps: TuiAppDeps): TuiApp {
  const { log, tools, compaction } = deps;

  // ---------- 组件树 ----------
  const tui = new TuiMainScreen(deps.terminal);
  const header = new Text("", 1, 0);
  const transcript = new Container();
  const live = new Container();
  const status = new Text("", 1, 0);
  const editor = new Editor(tui, editorTheme, { paddingX: 1 });
  const templates = deps.templates ?? [];
  editor.setAutocompleteProvider(
    new CombinedAutocompleteProvider(
      [
        ...COMMANDS,
        ...templates.map((t) => ({ name: t.name, description: `template: ${t.description}` })),
      ],
      process.cwd(),
    ),
  );
  tui.addChild(header);
  tui.addChild(
    new Text(
      c.faint(
        "Esc interrupt · Ctrl+R inspect · Ctrl+E context · Ctrl+O fold · Ctrl+T thinking · ? shortcuts",
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

  // ---------- Agent:界面是它的事件订阅者;流式增量走两个回调 ----------
  const approval = initialApproval(deps.approve);
  const agent = new Agent({
    log,
    provider: deps.provider,
    tools,
    compaction,
    onRaw: (line) => ctx.onRaw(line),
    ...(deps.effort && { effort: deps.effort }),
    slots: { ...deps.slots },
    onDelta: (d) => streamDelta(ctx, d),
    onReasoning: (d) => streamReasoning(ctx, d),
  });

  // ---------- 检视器(Q49) ----------
  const defs = (): ToolDef[] =>
    tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  const sessions = (): SessionSource[] => [
    { name: "main", events: log.events },
    ...ctx.children.views.map((v) => ({
      name: `sub #${v.info.index} ${brief(v.info.task)}`,
      events: v.info.log.events,
    })),
  ];
  const inspector = new RequestInspector({
    events: () => log.events,
    sessions,
    // 恢复的会话拿不到当时的 provider 对象;模型名相同就用当前的重建线路正文,否则如实缺省。
    providerFor: (i) => {
      const known = ctx.req.providersAt.get(i);
      if (known) return known;
      const e = log.events[i];
      return e?.type === "request" && e.model === agent.provider.model ? agent.provider : undefined;
    },
    currentProvider: () => agent.provider,
    tools: defs,
    rows: () => deps.terminal.rows,
    ...(deps.trace && { rawFor: (i: number) => ctx.req.rawAt.get(i) }),
    onClose: () => ctx.inspector.close(),
    onAction: (action, row) => void contextAction(ctx, action, row),
    requestRender: () => tui.requestRender(),
  });

  // ---------- ctx:模块共享的全部状态与少数动作 ----------
  const ctx: TuiContext = {
    deps,
    log,
    tools,
    compaction,
    agent,
    tui,
    header,
    transcript,
    live,
    status,
    editor,
    templates,
    skills: deps.skills ?? [],
    model: { info: deps.info, effortLevels: deps.effortLevels, contextWindow: compaction.window },
    view: {
      foldResults: deps.fold ?? false,
      showReasoning: false,
      childMode: "tail",
      firstRun: undefined,
      streaming: undefined,
      streamBuffer: "",
      reasoningView: undefined,
      reasoningBuffer: "",
      loader: undefined,
      resultNodes: [],
      reasoningNodes: [],
      lastUsage: undefined,
    },
    req: {
      count: 0,
      lastIndex: -1,
      finalRequestIndex: log.events.reduce((last, e, i) => (e.type === "request" ? i : last), -1),
      lastTurnIndex: -1,
      lastCompactionIndex: -1,
      providersAt: new Map(),
      rawAt: new Map(),
      rawLines: 0,
      receiveHeads: new Map(),
      predictedAt: new Map(),
      lastSent: undefined,
      lastToolSig: "",
      lastParams: undefined,
      lastCard: undefined,
    },
    usage: new UsageAccumulator((model) => ctx.priceFor(model)),
    approval,
    slots: {
      state: initialSlotState(deps, approval),
      toolPrompts: {
        style: deps.toolPrompts?.style ?? "guided",
        descriptions: { ...deps.toolPrompts?.descriptions },
      },
    },
    children: { views: [], slots: new Map() },
    inspector: {
      view: inspector,
      overlay: undefined,
      open(opts = {}) {
        if (ctx.inspector.overlay) return;
        // keep:调用方已经定好位(如 /raw N),不回到列表。
        if (!opts.keep) inspector.reset();
        ctx.inspector.overlay = tui.showOverlay(inspector, {
          width: "100%",
          maxHeight: "100%",
          anchor: "top-left",
        });
        tui.requestRender();
      },
      close() {
        if (!ctx.inspector.overlay) return;
        ctx.inspector.overlay.hide();
        ctx.inspector.overlay = undefined;
        tui.setFocus(editor);
        tui.requestRender();
      },
    },
    note(text) {
      transcript.addChild(new Text(text, 1, 0));
      tui.requestRender();
    },
    updateHeader() {
      const { info } = ctx.model;
      header.setText(
        `${c.bold(c.jin("clari"))}  ${c.ink(info.model)}  ${c.faint(`${info.providerName} · ${info.sessionFile}`)}`,
      );
    },
    updateStatus,
    showLoader(message) {
      ctx.hideLoader();
      const loader = new Loader(tui, c.zhu, c.faint, message);
      ctx.view.loader = loader;
      live.addChild(loader);
      loader.start();
    },
    hideLoader() {
      const loader = ctx.view.loader;
      if (!loader) return;
      loader.stop();
      live.removeChild(loader);
      ctx.view.loader = undefined;
    },
    threshold: () => compactionThreshold(ctx.model.contextWindow, deps.reserveTokens),
    // 当前模型的价格:配置接口优先,其次启动时带来的。
    priceFor: (model) =>
      deps.settings?.priceFor?.(model) ?? (model === ctx.model.info.model ? deps.price : undefined),
    defs,
    renderReasoning: (s, kind) =>
      thinkingLines(
        s,
        kind,
        ctx.view.showReasoning,
        Math.max(20, deps.terminal.columns - GUTTER - 24),
      ).join("\n"),
    onRaw(line) {
      const r = ctx.req;
      if (deps.trace) {
        const bucket = r.rawAt.get(r.lastIndex) ?? [];
        bucket.push(line);
        r.rawAt.set(r.lastIndex, bucket);
        // 缺省开(Q82),内存里只留最近 RAW_LINE_CAP 行:整桶淘汰最旧的请求,磁盘旁路文件不删。
        r.rawLines++;
        while (r.rawLines > RAW_LINE_CAP && r.rawAt.size > 1) {
          const oldest = r.rawAt.keys().next().value as number;
          r.rawLines -= r.rawAt.get(oldest)?.length ?? 0;
          r.rawAt.delete(oldest);
        }
      }
      deps.onRaw?.(r.lastIndex, line);
    },
    exit: deps.onExit ?? (() => process.exit(0)),
    stop() {
      ctx.hideLoader();
      for (const v of ctx.children.views) v.dispose();
      tui.stop();
    },
  };
  // 审批实现闭包引用 ctx,只能在 ctx 建好后装上;all 模式不装,内核缺省就是放行。
  if (approval.mode !== "all") agent.setSlot("approve", approveImpl(ctx));

  function updateStatus(): void {
    const state = agent.running ? c.zhu("● running") : c.green("○ idle");
    const t = ctx.threshold();
    let tokens = c.faint("no requests yet");
    const usage = ctx.view.lastUsage;
    if (usage) {
      // 上下文占用条:以自动压缩阈值为满格;过七成转朱色提醒。
      const used = Math.min(1, usage.inputTokens / t);
      const cells = used > 0 ? Math.max(1, Math.round(used * 10)) : 0;
      const bar = "▰".repeat(cells) + "▱".repeat(10 - cells);
      const tone = used >= 0.7 ? c.zhu : c.jin;
      tokens = `${tone(bar)} ${c.faint(`${pct(Math.max(0, 1 - used))} until auto-compaction · ${usage.inputTokens}→${usage.outputTokens} tok`)}`;
    }
    // 会话累计(含压缩摘要请求):输入、输出、缓存命中、费用。增量累计,每条事件到来时 render 喂进去。
    const totals = ctx.usage.totals();
    const sum =
      totals.requests > 0
        ? c.faint(
            ` · total ↑${fmtTok(totals.inputTokens)} ↓${fmtTok(totals.outputTokens)}${totals.cacheReadTokens > 0 ? ` cache ${fmtTok(totals.cacheReadTokens)}` : ""}${totals.cost !== undefined ? ` ${fmtCost(totals.cost)}` : ""}`,
          )
        : "";
    const queued = agent.queued > 0 ? c.faint(` · queued ${agent.queued}`) : "";
    const effort = agent.effort ? c.faint(` · effort ${agent.effort}`) : "";
    const runningChildren = ctx.children.views.filter((v) => v.running).length;
    const kids = runningChildren > 0 ? c.faint(` · sub-agents ${runningChildren} running`) : "";
    status.setText(`${state}  ${tokens}${sum}${effort}${queued}${kids}`);
    tui.requestRender();
  }

  // ---------- 历史回放与订阅:屏幕即历史,历史与新事件长得一样(Q54) ----------
  const draw = (e: AgentEvent) => render(ctx, e);
  if (log.events.length > 0) {
    for (const e of log.events) draw(e);
    log.subscribe(draw);
    if (log.events.length > 1) {
      ctx.note(
        c.jin(`◇ resumed: ${log.events.length} events, appending to ${deps.info.sessionFile}`),
      );
    }
  } else {
    log.subscribe(draw);
    log.append({
      type: "session/start",
      at: now(),
      model: deps.info.model,
      system: deps.systemPrompt ?? "",
    });
  }
  if (!log.events.some((e) => e.type === "user/message")) {
    ctx.view.firstRun = new Text(firstRunLines().join("\n"), 1, 0);
    transcript.addChild(ctx.view.firstRun);
  }
  ctx.updateHeader();
  updateStatus();

  // ---------- 输入 ----------
  editor.onSubmit = (raw) => {
    const text = raw.trim();
    editor.setText("");
    if (!text) return;
    editor.addToHistory(text);
    if (text.startsWith("/")) void command(ctx, text);
    else void submit(ctx, text);
  };

  tui.addInputListener((data) => {
    if (matchesKey(data, Key.ctrl("c"))) {
      ctx.stop();
      ctx.exit();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      if (ctx.inspector.overlay) ctx.inspector.close();
      else ctx.inspector.open();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("e"))) {
      // Ctrl+E:组装视图(Q81),模型下一步会看到的每条消息从哪来、落在线路的第几条。
      if (!ctx.inspector.overlay) ctx.inspector.open();
      inspector.showComposition();
      tui.requestRender();
      return { consume: true };
    }
    if (ctx.inspector.overlay || approval.overlay) return undefined; // 检视器或审批提示打开时,其余按键归它们
    if (data === "?" && editor.getText() === "") {
      ctx.note(shortcutLines().join("\n"));
      return { consume: true };
    }
    if (matchesKey(data, Key.alt("enter"))) {
      // 后续留言:不打断当前步,等模型不再调工具时才给它。空闲时与普通提交等价。
      const text = editor.getText().trim();
      if (!text) return { consume: true };
      editor.setText("");
      editor.addToHistory(text);
      if (text.startsWith("/")) void command(ctx, text);
      else void submit(ctx, text, { deliverAs: "followUp" });
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      toggleFold(ctx);
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("t"))) {
      toggleReasoning(ctx);
      return { consume: true };
    }
    if (matchesKey(data, Key.escape) && agent.running && !editor.isShowingAutocomplete()) {
      agent.interrupt();
      return { consume: true };
    }
    return undefined;
  });

  tui.setFocus(editor);
  tui.start();

  return {
    tui,
    agent,
    submit: (text, opts) => submit(ctx, text, opts),
    command: (text) => command(ctx, text),
    lines: (width = deps.terminal.columns) => tui.render(width),
    inspector: {
      open: () => ctx.inspector.open(),
      openEvents: () => {
        ctx.inspector.open();
        inspector.showEvents();
      },
      openCompactions: () => {
        ctx.inspector.open();
        inspector.showCompactions();
      },
      openComposition: () => {
        ctx.inspector.open();
        inspector.showComposition();
      },
      close: () => ctx.inspector.close(),
      isOpen: () => ctx.inspector.overlay !== undefined,
      key: (data) => inspector.handleInput(data),
      lines: (width = deps.terminal.columns) =>
        ctx.inspector.overlay ? inspector.render(width) : [],
    },
    attachChild: (child) => attachChild(ctx, child),
    children: () => ctx.children.views.map((v) => v.info),
    approvalLines: () => approval.prompt?.render() ?? [],
    approvalInput: (data) => approval.prompt?.handleInput(data),
    toggleFold: () => toggleFold(ctx),
    toggleReasoning: () => toggleReasoning(ctx),
    stop: () => ctx.stop(),
  };
}
