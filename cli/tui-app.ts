// TUI 应用:与终端实现解耦,便于用虚拟终端离线验证。cli/tui.ts 负责配置与真实终端,本文件负责组装。
//
// pi-tui 只当渲染引擎:差分渲染、编辑器、宽度计算;视觉层全部是自有组合。
// 界面分成几个接 ctx 的模块(重构块 2):
//   tui-context   共享状态的形状
//   tui-render    事件 → 屏幕,子 agent 视图,流式增量
//   tui-commands  提交与 / 命令的分发,列表类命令
//   tui-edit      编辑上下文的命令与面板动作
//   tui-slots     策略槽切换与审批提示
// 本文件只做:建组件树、建 Agent、建 ctx、接检视器与按键、回放历史、返回 TuiApp 接口。
import {
  CombinedAutocompleteProvider,
  type Component,
  Container,
  Editor,
  getKeybindings,
  isViewportTUI,
  Key,
  matchesKey,
  ScrollView,
  Spacer,
  type Terminal,
  Text,
  type TUI,
  TuiAltScreen,
  TuiMainScreen,
  truncateToWidth,
  VStack,
} from "@earendil-works/pi-tui";
import { Agent, type DeliverAs } from "../src/agent.js";
import type { ApprovalConfig } from "../src/approval.js";
import type { ModelConfig, Preset, ResultView, ToolPromptsConfig } from "../src/config.js";
import { type Price, UsageAccumulator } from "../src/cost.js";
import { type AgentEvent, now } from "../src/events.js";
import { imageBytes } from "../src/images.js";
import type { EventLog } from "../src/log.js";
import { type CompactionConfig, compactionThreshold, type TurnDeps } from "../src/loop.js";
import type { EffortLevel, Provider, ToolDef } from "../src/provider.js";
import type { SettingLayers } from "../src/settings.js";
import { mergeSetup } from "../src/setup.js";
import type { ChildInfo } from "../src/subagent.js";
import type { Tool } from "../src/tools.js";
import { DEFAULT_RESULT_VIEWS, firstRunLines, thinkingLines } from "./cards.js";
import { type ClipboardInput, imageFromPath, readClipboardInput } from "./clipboard-input.js";
import { editInExternalEditor } from "./editor.js";
import { RequestInspector, type SessionSource } from "./inspector.js";
import type { McpServerStatus } from "./mcp/bridge.js";
import type { Skill } from "./prompt.js";
import type { CapabilitySource, Inferred } from "./registry.js";
import type { SessionInputs } from "./session-inputs.js";
import type { RecordingSection, RequestRecording } from "./session-records.js";
import { recordingReader } from "./session-records.js";
import { captureSessionSetup, type SessionSetup } from "./session-setup.js";
import {
  type ExitState,
  exitReview,
  SessionSetupReview,
  sessionChoice,
  textReview,
} from "./session-view.js";
import type { PromptTemplate } from "./templates.js";
import {
  FOCUS_OFF,
  FOCUS_ON,
  notifySequence,
  openUrl,
  withFocusTracking,
} from "./terminal-extras.js";
import { c, editorTheme, G } from "./theme.js";
import type { MemoryFiles } from "./tools/memory.js";
import { Block } from "./tui-block.js";
import { applyTools, COMMANDS, command, openLogin, openPalette, submit } from "./tui-commands.js";
import { FOLD_HEAD, type SessionTarget, type TuiContext } from "./tui-context.js";
import { contextAction, flipSection } from "./tui-edit.js";
import { brief } from "./tui-format.js";
import type { ProviderSummary } from "./tui-login.js";
import {
  attachChild,
  render,
  resultText,
  streamDelta,
  streamReasoning,
  toggleFold,
  toggleReasoning,
} from "./tui-render.js";
import { approveImpl, initialApproval, initialSlotState } from "./tui-slots.js";
import { InputHints, RuntimeStatus } from "./tui-status.js";
import { clearStepSelection, FOLD_STEPS, selectStep, toggleSelectedStep } from "./tui-steps.js";

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
  /** 窗口数据的出处:config / models.dev / assumed。 */
  capabilitySource?: CapabilitySource;
  /** 拿不到 provider 的原因(缺 key);界面据此打开登录对话框,发消息时提示。 */
  unavailable?: string;
};

export type TuiSettings = {
  /** "供应商/模型" 列表,供 /model 与补全使用。 */
  listModels(): string[];
  /** 顶层配置的默认模型;defaults.model 是可移除的覆盖。 */
  defaultModel?(): string;
  /** 某模型的价格;没配置返回 undefined。会话里换过模型时按各自价格累计。 */
  priceFor?(model: string): Price | undefined;
  /** 按名切换模型(可能需要读 key),返回新 provider。 */
  switchModel(name: string): ModelChoice;
  /** 写入某供应商的 key 并落盘。 */
  setKey(providerName: string, key: string): void;
  /** 把某模型设为缺省并落盘。 */
  setDefault(model: string): void;
  /** 供应商清单(名、协议、key 来源、环境变量名、配置里的模型),登录对话框用。 */
  providers?(): ProviderSummary[];
  /** 用一把 key 向供应商查模型清单;抛错即无效。登录对话框验证用。 */
  verifyKey?(providerName: string, key: string): Promise<string[]>;
  /** 给配置里没有的模型推出配置(models.dev → 抄最像的 → 假设),带出处;选择器用来写行注与落盘。 */
  describeModel?(providerName: string, modelId: string): Promise<Inferred>;
  /** 把一个模型写进配置并落盘。 */
  addModel?(providerName: string, model: ModelConfig): void;
  /** 已配置模型生效的能力数据一行注(窗口、价格、出处;配置覆盖了登记簿时带登记簿的值)。 */
  capabilityNote?(providerName: string, modelId: string): Promise<string>;
  /** 配置的 defaults 与当前预设:/settings 据此写来源列。 */
  settingLayers?(): SettingLayers;
  /** 写一个开关进配置 defaults 并落盘;undefined 删掉那一项。 */
  saveSetting?(key: string, value: unknown): void;
  /** 只包含方案,不暴露供应商连接或凭据。 */
  listPresets?(): { name: string; values: Preset }[];
  savePreset?(name: string, values: Preset): void;
  /** 把方案写为后续启动的 defaults,不伪装成当前会话已切换。 */
  usePreset?(name: string): void;
};

export type TuiAppDeps = {
  terminal: Terminal;
  log: EventLog;
  provider: Provider;
  tools: Tool[];
  compaction: CompactionConfig;
  reserveTokens: number;
  info: {
    model: string;
    providerName: string;
    sessionFile: string;
    resumed?: boolean;
    /** 窗口与出处,头部显示;假设值标红。 */
    contextWindow?: number;
    capabilitySource?: CapabilitySource;
  };
  settings?: TuiSettings;
  /** 启动时已解析的设置快照;用于区分当前值与后来保存的默认值。 */
  startupSettings?: Preset;
  /** 日志为空时用它落 session/start;入口已经落过(bootstrap.beginSession)就不需要。 */
  systemPrompt?: string;
  onExit?: () => void;
  /** 工具结果初始是否折叠。缺省不折叠;Ctrl+O 随时切换。 */
  fold?: boolean;
  /** 折叠时保留的结果行数;缺省 5。 */
  foldLines?: number;
  /** 每个工具的结果可见度;没写的按 DEFAULT_RESULT_VIEWS,再没有按 head。 */
  results?: Record<string, ResultView>;
  /** 事实附注开关;缺省全开。 */
  facts?: { repeats?: boolean; slow?: boolean; date?: boolean };
  /** 计划复述的步数;缺省 8,0 = 从不。 */
  planReminder?: number;
  /** 账簿保持展开的最新步数;缺省 3,0 = 从不自动折。 */
  foldSteps?: number;
  /** 屏幕模式:alt(缺省)备用屏,main 主屏。 */
  screen?: "alt" | "main";
  /** 桌面通知:unfocused(缺省)| always | off。 */
  notify?: "unfocused" | "always" | "off";
  recordingFor?: (
    log: EventLog,
    requestIndex: number,
    section?: RecordingSection,
  ) => RequestRecording | undefined;
  readClipboard?: () => Promise<ClipboardInput>;
  /** 初始强度级别;缺省不传。 */
  effort?: EffortLevel;
  effortLevels?: EffortLevel[];
  /** 起始模型的价格(配置里给了才有)。 */
  price?: Price;
  /**
   * 审批槽的启动形态:all(缺省)不问;ask 每个调用都问;规则对象 = policy 模式,
   * 按规则裁决,规则说 ask 的才问人。/approve 在会话中切换。
   */
  approve?: "all" | "ask" | ApprovalConfig;
  /** 跨会话记忆已打开时的两个文件,供 /memory 看与删。 */
  memory?: MemoryFiles;
  /** 启动时的压缩策略名(llm / clear / pipeline / 模块路径),/slots 显示用;缺省 llm。 */
  compactionName?: string;
  /** 策略槽实现(执行策略、扩展模块换上的槽等)。approve=ask 时界面的审批实现覆盖这里的 approve。 */
  slots?: TurnDeps["slots"];
  /** 提示词模板:/名 参数 展开成一条用户消息。 */
  templates?: PromptTemplate[];
  /** 技能:/名 参数 触发;/skills 列出。 */
  skills?: Skill[];
  /** 会话目录,/fork 的新文件写到这里。 */
  sessionsDir?: string;
  /** MCP 桥接:/mcp 列状态。工具本身已在 tools 里。 */
  mcp?: { statuses(): McpServerStatus[] };
  /** 工具描述风格槽的启动形态;/toolprompts 会话中切换与逐条编辑。 */
  toolPrompts?: ToolPromptsConfig;
  /** 启动时的保留策略显示名(--preservation / 配置);缺省内置。 */
  preservationName?: string;
  /** 启动时没有可用的 provider(缺 key)的原因:界面先弹登录对话框。 */
  unavailable?: string;
  /** 启动时关掉的工具(配置 tools.disable)。 */
  disabledTools?: string[];
  mcpReconnect?: string[];
  onSetupChange?: (setup: SessionSetup) => void;
  readOnlyReason?: string;
  inputs?: SessionInputs;
  saveInputs?: boolean;
  /** 换会话(/session new · fork · resume):由入口实现,停掉这个界面、换日志再起一个。 */
  switchSession?: (target: SessionTarget) => void;
};

export type TuiApp = {
  setExitState(state?: ExitState): void;
  flushInputs(): void;
  draft(): string;
  setDraft(text: string): void;
  setup(): SessionSetup;
  choose(title: string, rows: { label: string; note?: string }[]): Promise<string | undefined>;
  reviewSetup(setup: SessionSetup, missing: string[]): Promise<SessionSetup | undefined>;
  showText(title: string, text: string): Promise<void>;
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
    /** 打开工作台;at = 事件下标,光标落在从它起的第一条消息上。 */
    openComposition(at?: number): void;
    close(): void;
    isOpen(): boolean;
    key(data: string): void;
    lines(width?: number): string[];
  };
  /** 子 agent 开跑时由 task 工具通知:挂到对应调用行下面并实时订阅。 */
  attachChild(child: ChildInfo): void;
  children(): ChildInfo[];
  /** 当前策略槽实现;task 工具派活时取,子沿用父此刻的审批与执行策略。 */
  slots(): TurnDeps["slots"];
  /** 正在等待回答的审批提示的渲染行;没有时为空。离线验证用(覆盖层不在 lines() 里)。 */
  approvalLines(): string[];
  /** 把按键送给正在等待的审批提示(离线验证用)。 */
  approvalInput(data: string): void;
  /** 当前对话框(登录、模型选择)的渲染行;没有时为空。 */
  dialogLines(): string[];
  dialogInput(data: string): void;
  /** 打开登录对话框(/login)。 */
  openLogin(provider?: string): void;
  toggleFold(): void;
  toggleReasoning(): void;
  /** 往对话流追加一行说明(入口层报错用)。 */
  note(text: string): void;
  stop(): void;
};

/** 头部的窗口标签:1M ctx (models.dev);假设值用朱色,提醒去配置里写。 */
function contextTag(info: TuiAppDeps["info"]): string {
  if (!info.contextWindow) return "";
  const n = info.contextWindow;
  const w = n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1024)}k`;
  const src = info.capabilitySource ?? "config";
  return src === "assumed" ? c.zhu(`${w} ctx assumed`) : c.faint(`${w} ctx (${src})`);
}

export function createTuiApp(deps: TuiAppDeps): TuiApp {
  const { log, tools, compaction } = deps;
  const savedInputs = deps.inputs?.read(log.events);
  let stopped = false;
  let unsubscribeLog: (() => void) | undefined;
  let cancelSessionDialog: (() => void) | undefined;
  let exiting = false;

  // ---------- 组件树 ----------
  // 备用屏(缺省):头部与状态行固定,正文自己滚,鼠标滚轮、拖选即复制、Ctrl+Shift+F 搜索、Ctrl+↑↓ 按步跳;
  // 主屏:一切进终端回滚。两者的组件树相同,只是挂法不同。
  const screen = deps.screen ?? "alt";
  // 焦点在终端层记:引擎(备用屏)自己也吃焦点序列,不能靠输入监听。
  const terminal = withFocusTracking(deps.terminal, (focused) => {
    ctx.view.focused = focused;
  });
  const tui: TUI =
    screen === "alt"
      ? new TuiAltScreen(terminal, true, undefined, {
          mouse: true,
          openUrl,
          searchMatchStyle: (t) => c.band(t),
          searchCurrentMatchStyle: (t) => c.inverse(t),
        })
      : new TuiMainScreen(terminal);
  const header = new Block("", { truncate: true });
  const transcript = new Container();
  const live = new Container();
  const status = new RuntimeStatus(() => ctx);
  const inputHints = new InputHints(() => ctx);
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
  let scroll: ScrollView | undefined;
  if (isViewportTUI(tui)) {
    const body = new Container();
    body.addChild(transcript);
    body.addChild(live);
    const top = new Container();
    top.addChild(header);
    top.addChild(new Spacer(1));
    const bottom = new Container();
    bottom.addChild(new Spacer(1));
    bottom.addChild(status);
    bottom.addChild(editor);
    bottom.addChild(inputHints);
    scroll = new ScrollView(body, { follow: "end", primary: true, overscroll: "chain" });
    tui.setLayoutRoot(
      new VStack([
        { component: top, basis: "auto" },
        { component: scroll, basis: 0, grow: 1, minSize: 1 },
        { component: bottom, basis: "auto", shrink: 1, minSize: 1 },
      ]),
    );
    // PgUp / PgDn 归账簿(按步移动光标并滚到那一步);引擎的整页滚动让给它。Ctrl+↑↓ 仍是引擎的按标记跳。
    const kb = getKeybindings();
    kb.setUserBindings({
      ...kb.getUserBindings(),
      "tui.altScreen.pageUp": [],
      "tui.altScreen.pageDown": [],
    });
  } else {
    tui.addChild(header);
    tui.addChild(new Spacer(1));
    tui.addChild(transcript);
    tui.addChild(live);
    tui.addChild(new Spacer(1));
    tui.addChild(status);
    tui.addChild(editor);
    tui.addChild(inputHints);
  }
  // 焦点事件:通知只在终端失焦时发。
  deps.terminal.write(FOCUS_ON);

  // ---------- Agent:界面是它的事件订阅者;流式增量走两个回调 ----------
  const approval = initialApproval(deps.approve);
  // 关掉的工具(配置 tools.disable、/tools)不随请求发出;全表仍在 ctx.tools 里,开关随时可翻。
  const disabledTools = new Set(deps.disabledTools ?? []);
  const agent = new Agent({
    ...(savedInputs && { pending: savedInputs.pending }),
    onPendingChange: (pending) => {
      deps.inputs?.setPending(pending);
      ctx.updateStatus();
    },
    log,
    provider: deps.provider,
    tools: () => tools.filter((t) => !disabledTools.has(t.name)),
    compaction,
    ...(deps.effort && { effort: deps.effort }),
    ...(deps.facts && { facts: deps.facts }),
    ...(deps.planReminder !== undefined && { planReminder: deps.planReminder }),
    slots: { ...deps.slots },
    onDelta: (d) => streamDelta(ctx, d),
    onReasoning: (d) => streamReasoning(ctx, d),
  });

  // ---------- 检视器 ----------
  const defs = (): ToolDef[] =>
    tools
      .filter((t) => !ctx.slots.disabledTools.has(t.name))
      .map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  const readRecording = recordingReader();
  const sessions = (): SessionSource[] => [
    {
      name: "main",
      events: log.events,
      recordingFor: (i: number, section?: RecordingSection) =>
        deps.recordingFor
          ? deps.recordingFor(log, i, section)
          : readRecording(log, log.path ?? deps.info.sessionFile, i, section),
    },
    ...ctx.children.views.map((v) => ({
      name: `sub #${v.info.index} ${brief(v.info.task)}`,
      events: v.info.log.events,
      recordingFor: (i: number, section?: RecordingSection) =>
        deps.recordingFor
          ? deps.recordingFor(v.info.log, i, section)
          : v.info.log.path
            ? readRecording(v.info.log, v.info.log.path, i, section)
            : undefined,
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
    lastSent: () => ctx.req.lastSent,
    contextWindow: () => ctx.model.contextWindow,
    running: () => agent.running,
    onClose: () => ctx.inspector.close(),
    onAction: (action, row) => void contextAction(ctx, action, row),
    onSection: (name) => flipSection(ctx, name),
    onTools: () => {
      ctx.inspector.close();
      void command(ctx, "/tools");
    },
    requestRender: () => tui.requestRender(),
  });

  // ---------- ctx:模块共享的全部状态与少数动作 ----------
  const ctx: TuiContext = {
    deps,
    setupInitial: structuredClone(
      deps.startupSettings ??
        mergeSetup(
          deps.settings?.settingLayers?.().defaults ?? {},
          deps.settings?.settingLayers?.().preset ?? {},
        ),
    ),
    log,
    tools,
    compaction,
    agent,
    tui,
    header,
    root: transcript,
    transcript,
    scroll,
    steps: [],
    live,
    status,
    editor,
    templates,
    skills: deps.skills ?? [],
    model: { info: deps.info, effortLevels: deps.effortLevels, contextWindow: compaction.window },
    draftImages: savedInputs?.draft.images ?? [],
    inputReading: false,
    view: {
      foldResults: deps.fold ?? true,
      foldLines: deps.foldLines ?? FOLD_HEAD,
      results: { ...DEFAULT_RESULT_VIEWS, ...deps.results },
      afterUser: false,
      foldSteps: deps.foldSteps ?? FOLD_STEPS,
      selectedStep: undefined,
      pulse: [],
      sealFrame: 0,
      showReasoning: false,
      childMode: "tail",
      firstRun: undefined,
      streaming: undefined,
      streamBuffer: "",
      streamTimer: undefined,
      focused: true,
      turnStartedAt: undefined,
      reasoningView: undefined,
      reasoningBuffer: "",
      loaderTimer: undefined,
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
      predictedAt: new Map(),
      lastSent: undefined,
    },
    usage: new UsageAccumulator((model) => ctx.priceFor(model)),
    approval,
    slots: {
      state: initialSlotState(deps, approval),
      toolPrompts: {
        style: deps.toolPrompts?.style ?? "explain",
        descriptions: { ...deps.toolPrompts?.descriptions },
      },
      disabledTools,
    },
    children: { views: [], slots: new Map() },
    dialog: {
      overlay: undefined,
      component: undefined,
      open(component) {
        ctx.dialog.close();
        ctx.dialog.component = component;
        ctx.dialog.overlay = tui.showOverlay(component, { width: "100%", anchor: "bottom-left" });
        tui.requestRender();
        // 命令层在等"选单开了"这个信号,好把控制权交回去。
        ctx.dialog.onOpen?.();
      },
      close() {
        const cancel = cancelSessionDialog;
        cancelSessionDialog = undefined;
        cancel?.();
        if (!ctx.dialog.overlay) return;
        ctx.dialog.overlay.hide();
        ctx.dialog.overlay = undefined;
        ctx.dialog.component = undefined;
        tui.requestRender();
      },
    },
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
        tui.requestRender();
      },
    },
    note(text) {
      transcript.addChild(new Block(text));
      tui.requestRender();
    },
    redrawResults() {
      for (const r of ctx.view.resultNodes) r.node.setText(resultText(ctx, r));
      tui.requestRender();
    },
    applyTools: () => applyTools(ctx),
    notify(text) {
      const mode = deps.notify ?? "unfocused";
      if (mode === "off") return;
      if (mode === "unfocused" && ctx.view.focused) return;
      deps.terminal.write(notifySequence("clari", text));
    },
    // 朱印呼吸:模型工作时印章按四个相位缓慢明暗,两秒一息;空闲时定在最亮。
    updateHeader() {
      const { info } = ctx.model;
      const tone = c.seal[ctx.view.sealFrame % c.seal.length] ?? c.zhu;
      header.setText(
        info.providerName === "none"
          ? `${tone(G.seal)} ${c.bold(c.jin("clari"))}  ${c.zhu("no model")}  ${c.faint(`/login to add an API key · ${info.sessionFile}`)}`
          : `${tone(G.seal)} ${c.bold(c.jin("clari"))}  ${c.ink(info.model)}  ${[c.faint(info.providerName), contextTag(info), c.faint(info.sessionFile)].filter(Boolean).join(c.faint(" · "))}`,
      );
    },
    updateStatus,
    // 工作状态固定在输入区上方,滚回历史时仍然可见。
    showLoader(message) {
      ctx.hideLoader();
      const startedAt = Date.now();
      ctx.view.turnStartedAt = startedAt;
      status.begin(message);
      // 半秒一拍:印章进一个相位;每两拍刷一次用时与标题。
      ctx.view.loaderTimer = setInterval(() => {
        ctx.view.sealFrame += 1;
        ctx.updateHeader();
        if (ctx.view.sealFrame % 2 === 0) {
          updateTitle();
        }
        tui.requestRender();
      }, 500);
      tui.requestRender();
    },
    hideLoader() {
      if (ctx.view.loaderTimer) clearInterval(ctx.view.loaderTimer);
      ctx.view.loaderTimer = undefined;
      ctx.view.sealFrame = 0;
      ctx.updateHeader();
      status.end();
    },
    threshold: () => compactionThreshold(ctx.model.contextWindow, deps.reserveTokens),
    // 当前模型的价格:配置接口优先,其次启动时带来的。
    priceFor: (model) =>
      deps.settings?.priceFor?.(model) ?? (model === ctx.model.info.model ? deps.price : undefined),
    defs,
    renderReasoning: (s, kind) =>
      thinkingLines(s, kind, ctx.view.showReasoning, Math.max(20, deps.terminal.columns - 24)).join(
        "\n",
      ),
    exit:
      deps.onExit ??
      (() => {
        ctx.stop();
        process.exit(0);
      }),
    persistSetup: () => deps.onSetupChange?.(captureSessionSetup(ctx)),
    stop() {
      stopped = true;
      deps.inputs?.flush();
      deps.inputs?.detach();
      for (const off of recordingOffs) off();
      log.recording?.flush();
      ctx.dialog.close();
      // 停止的界面不再消费日志;旧连接的迟到事件不能重新驱动它渲染。
      unsubscribeLog?.();
      unsubscribeLog = undefined;
      ctx.hideLoader();
      for (const v of ctx.children.views) v.dispose();
      deps.terminal.write(FOCUS_OFF);
      tui.stop();
    },
  };
  // 审批实现闭包引用 ctx,只能在 ctx 建好后装上;all 模式不装,内核缺省就是放行。
  if (approval.mode !== "all") agent.setSlot("approve", approveImpl(ctx));

  /** 终端标题跟状态:运行中带用时,空闲带模型名。 */
  function updateTitle(): void {
    const started = ctx.view.turnStartedAt;
    const title = agent.running
      ? `clari · running ${started ? `${Math.round((Date.now() - started) / 1000)}s` : ""}`.trim()
      : `clari · ${ctx.model.info.model}`;
    deps.terminal.setTitle(title);
  }

  let wasRunning = false;
  /** 通知和标题跟随执行状态;固定状态区自己按实际宽度投影。 */
  function updateStatus(): void {
    ctx.persistSetup();
    // 回合结束(运行 → 空闲)时通知一次;审批提示在 askApproval 里自己通知。之后的说明行回到根上,不进最后一步。
    if (wasRunning && !agent.running) {
      ctx.notify("turn finished");
      ctx.transcript = ctx.root;
    }
    wasRunning = agent.running;
    updateTitle();
    tui.requestRender();
  }

  const recordingOffs: (() => void)[] = [];
  const watchRecording = (source: EventLog) => {
    const off = source.recording?.subscribe(() => {
      if (source.recording?.error)
        ctx.note(
          c.zhu(
            `Saving failed: ${source.recording.error}. Work continues; unsaved data stays in memory. Retrying automatically; Ctrl+S retries now.`,
          ),
        );
      tui.requestRender();
    });
    if (off) recordingOffs.push(off);
  };
  watchRecording(log);

  // ---------- 历史回放与订阅:屏幕即历史,历史与新事件长得一样 ----------
  const draw = (e: AgentEvent, index = log.events.length - 1) => {
    status.observe(e);
    render(ctx, e, index);
  };
  if (log.events.length > 0) {
    for (const [index, e] of log.events.entries()) draw(e, index);
    unsubscribeLog = log.subscribe(draw);
    if (deps.info.resumed) {
      ctx.note(
        c.soft(`· resumed: ${log.events.length} events, appending to ${deps.info.sessionFile}`),
      );
    }
  } else {
    unsubscribeLog = log.subscribe(draw);
    log.append({
      type: "session/start",
      at: now(),
      model: deps.info.model,
      system: deps.systemPrompt ?? "",
    });
  }
  if (!log.events.some((e) => e.type === "user/message")) {
    // 首屏一行占位;没 key 时连这一行也不要,屏幕上只有头部与登录对话框。
    if (deps.info.providerName !== "none") {
      ctx.view.firstRun = new Text(firstRunLines().join("\n"), 1, 0);
      transcript.addChild(ctx.view.firstRun);
    }
  }
  ctx.updateHeader();
  updateStatus();

  // ---------- 输入 ----------
  editor.onSubmit = (raw) => {
    // 编辑器先清空再回调;接收成功前恢复草稿,让附图归属与失败保留走同一条路径。
    editor.setText(raw);
    const text = raw.trim();
    if (ctx.inputReading) {
      ctx.note(c.soft("Reading clipboard; send after the attachment appears."));
      return;
    }
    if (!text && !ctx.draftImages.length) return;
    editor.addToHistory(text);
    if (text.startsWith("/")) {
      editor.setText("");
      void command(ctx, text);
    } else void submit(ctx, text);
  };
  if (savedInputs) editor.setText(savedInputs.draft.text);
  deps.inputs?.bind((error) =>
    ctx.note(
      c.zhu(
        `Input saving failed: ${error.message}. Keep this session open and retry with /session inputs.`,
      ),
    ),
  );
  editor.onChange = (text) => deps.inputs?.setDraft(text, ctx.draftImages);

  const pasteInput = async (get: () => Promise<ClipboardInput>) => {
    if (ctx.inputReading) return;
    ctx.inputReading = true;
    tui.requestRender();
    try {
      const value = await get();
      const image = value.image ?? (value.text ? await imageFromPath(value.text) : undefined);
      if (stopped) return;
      if (image) {
        ctx.draftImages = [...ctx.draftImages, image];
        deps.inputs?.setDraft(editor.getText(), ctx.draftImages);
      } else if (value.text) {
        editor.handleInput(`\x1b[200~${value.text}\x1b[201~`);
      } else ctx.note(c.soft("No image or text on the clipboard."));
    } catch (error) {
      if (!stopped) ctx.note(c.zhu(`Paste failed: ${(error as Error).message}. Draft unchanged.`));
    } finally {
      ctx.inputReading = false;
      if (!stopped) tui.requestRender();
    }
  };

  tui.addInputListener((data) => {
    if (!exiting && !ctx.inspector.overlay && !approval.overlay && !ctx.dialog.overlay) {
      if (matchesKey(data, Key.ctrl("v")) || matchesKey(data, Key.alt("v"))) {
        void pasteInput(deps.readClipboard ?? readClipboardInput);
        return { consume: true };
      }
      if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~")) {
        const pasted = data.slice(6, -6);
        if (/\.(png|jpe?g|gif|webp)["']?\s*$/i.test(pasted.trim()) && !/[\r\n]/.test(pasted)) {
          void pasteInput(async () => ({ text: pasted }));
          return { consume: true };
        }
      }
      if (matchesKey(data, Key.alt("i"))) {
        let selected = 0;
        ctx.dialog.open({
          invalidate() {},
          render(width) {
            const line = (s: string) => truncateToWidth(s, Math.max(1, width - 2));
            const count = Math.max(1, terminal.rows - 8);
            const start = Math.max(0, selected - count + 1);
            return [
              line(` Draft images · ${ctx.draftImages.length} attached · Enter sends from editor`),
              "",
              ...ctx.draftImages.slice(start, start + count).map((image, index) => {
                const i = start + index;
                return line(
                  ` ${selected === i ? "›" : " "} ${i + 1}. ${image.name ?? image.mimeType} · ${imageBytes(image)} bytes`,
                );
              }),
              ...(ctx.draftImages.length ? [] : [" No images attached."]),
              "",
              " ↑↓ select · Delete remove · Esc back",
            ];
          },
          handleInput(key) {
            if (matchesKey(key, Key.escape)) ctx.dialog.close();
            else if (matchesKey(key, Key.up)) selected = Math.max(0, selected - 1);
            else if (matchesKey(key, Key.down))
              selected = Math.min(ctx.draftImages.length - 1, selected + 1);
            else if (matchesKey(key, Key.delete)) {
              ctx.draftImages = ctx.draftImages.filter((_, i) => i !== selected);
              selected = Math.max(0, Math.min(selected, ctx.draftImages.length - 1));
              deps.inputs?.setDraft(editor.getText(), ctx.draftImages);
            }
            tui.requestRender();
          },
        });
        return { consume: true };
      }
    }
    if (matchesKey(data, Key.ctrl("s"))) {
      for (const source of [log, ...ctx.children.views.map((v) => v.info.log)])
        source.recording?.flush();
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      ctx.exit();
      return { consume: true };
    }
    if (exiting) {
      ctx.dialog.component?.handleInput?.(data);
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("k"))) {
      if (ctx.inspector.overlay || approval.overlay) return undefined;
      if (ctx.dialog.overlay) ctx.dialog.close();
      else openPalette(ctx);
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("g"))) {
      // 长提示交给用户自己的编辑器:先让出终端,编辑器退出后再接管。
      if (ctx.inspector.overlay || approval.overlay || ctx.dialog.overlay) return undefined;
      tui.stop();
      const next = editInExternalEditor(editor.getText());
      tui.start();
      deps.terminal.write(FOCUS_ON);
      if (next !== undefined) editor.setText(next.replace(/\s+$/, ""));
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("r"))) {
      if (approval.overlay || ctx.dialog.overlay) return undefined;
      if (ctx.inspector.overlay) ctx.inspector.close();
      else ctx.inspector.open();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("e"))) {
      if (approval.overlay || ctx.dialog.overlay) return undefined;
      // Ctrl+E:上下文工作台。账簿光标停在某一步时,落在那一步的消息上;再按一次关。
      if (ctx.inspector.overlay && inspector.currentMode === "composition") {
        ctx.inspector.close();
        return { consume: true };
      }
      if (!ctx.inspector.overlay) ctx.inspector.open();
      const step =
        ctx.view.selectedStep !== undefined ? ctx.steps[ctx.view.selectedStep] : undefined;
      inspector.showComposition(step ? step.requestIndex : undefined);
      tui.requestRender();
      return { consume: true };
    }
    if (ctx.inspector.overlay || approval.overlay || ctx.dialog.overlay) return undefined; // 检视器、审批提示或对话框打开时,其余按键归它们
    if (matchesKey(data, Key.alt("enter"))) {
      // 后续留言:不打断当前步,等模型不再调工具时才给它。空闲时与普通提交等价。
      const text = editor.getText().trim();
      if (!text && !ctx.draftImages.length) return { consume: true };
      editor.addToHistory(text);
      if (text.startsWith("/")) {
        editor.setText("");
        void command(ctx, text);
      } else void submit(ctx, text, { deliverAs: "followUp" });
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("o"))) {
      toggleFold(ctx);
      return { consume: true };
    }
    // 账簿光标:PgUp / PgDn 在步之间移动并滚到那一步;Enter(输入框为空)展开或折起;Esc 放开。
    if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      selectStep(ctx, matchesKey(data, "pageUp") ? -1 : 1);
      return { consume: true };
    }
    if (
      matchesKey(data, Key.enter) &&
      editor.getText() === "" &&
      !ctx.draftImages.length &&
      !editor.isShowingAutocomplete() &&
      ctx.view.selectedStep !== undefined
    ) {
      toggleSelectedStep(ctx);
      return { consume: true };
    }
    if (
      matchesKey(data, Key.escape) &&
      !editor.isShowingAutocomplete() &&
      (ctx.view.selectedStep !== undefined || (scroll && !scroll.isFollowingEnd))
    ) {
      clearStepSelection(ctx);
      scroll?.scrollToEnd();
      tui.requestRender();
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
  // 没 key:屏幕上只留头部与对话框;原因已在头部(no model),不再另打一行。
  if (deps.unavailable) openLogin(ctx, {});

  function sessionDialog<T>(
    build: (done: (value?: T) => void) => Component,
  ): Promise<T | undefined> {
    return new Promise((resolve) => {
      ctx.dialog.open(
        build((value) => {
          cancelSessionDialog = undefined;
          resolve(value);
          ctx.dialog.close();
        }),
      );
      cancelSessionDialog = () => resolve(undefined);
    });
  }

  return {
    tui,
    flushInputs: () => deps.inputs?.flush(),
    agent,
    draft: () => editor.getText(),
    setDraft: (text) => {
      editor.setText(text);
      tui.requestRender();
    },
    setExitState(state) {
      exiting = Boolean(state);
      if (state) {
        ctx.inspector.close();
        ctx.dialog.open(exitReview(ctx, state));
      } else ctx.dialog.close();
    },
    setup: () => captureSessionSetup(ctx),
    choose: (heading, rows) =>
      sessionDialog<string>((done) =>
        sessionChoice(
          heading,
          rows,
          () => deps.terminal.rows,
          done,
          () => tui.requestRender(),
        ),
      ),
    reviewSetup: (setup, missing) =>
      sessionDialog<SessionSetup>(
        (done) =>
          new SessionSetupReview(
            setup,
            missing,
            () => deps.terminal.rows,
            done,
            () => tui.requestRender(),
          ),
      ),
    showText: (heading, text) =>
      sessionDialog<void>((done) =>
        textReview(
          heading,
          text,
          () => deps.terminal.rows,
          done,
          () => tui.requestRender(),
        ),
      ),
    submit: (text, opts) =>
      exiting
        ? Promise.reject(new Error("Session is closing; new input was not submitted."))
        : submit(ctx, text, opts),
    command: (text) =>
      exiting && text.trim() !== "/quit"
        ? Promise.reject(new Error("Session is closing; command was not run."))
        : command(ctx, text),
    // 离线验证与预览用的整份文档:两种屏幕模式都按同一顺序拼,备用屏的滚动区不经布局不出行。
    lines: (width = deps.terminal.columns) =>
      isViewportTUI(tui)
        ? [
            ...header.render(width),
            "",
            ...transcript.render(width),
            ...live.render(width),
            "",
            ...status.render(width),
            ...editor.render(width),
            ...inputHints.render(width),
          ]
        : tui.render(width),
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
      openComposition: (at) => {
        ctx.inspector.open();
        inspector.showComposition(at);
      },
      close: () => ctx.inspector.close(),
      isOpen: () => ctx.inspector.overlay !== undefined,
      key: (data) => inspector.handleInput(data),
      lines: (width = deps.terminal.columns) =>
        ctx.inspector.overlay ? inspector.render(width) : [],
    },
    attachChild: (child) => {
      watchRecording(child.log);
      return attachChild(ctx, child);
    },
    children: () => ctx.children.views.map((v) => v.info),
    slots: () => ctx.agent.slots,
    approvalLines: () => approval.prompt?.render(deps.terminal.columns) ?? [],
    approvalInput: (data) => approval.prompt?.handleInput(data),
    note: (text) => ctx.note(text),
    dialogLines: () => ctx.dialog.component?.render(deps.terminal.columns) ?? [],
    dialogInput: (data) => ctx.dialog.component?.handleInput?.(data),
    openLogin: (provider) => openLogin(ctx, provider ? { provider } : {}),
    toggleFold: () => toggleFold(ctx),
    toggleReasoning: () => toggleReasoning(ctx),
    stop: () => ctx.stop(),
  };
}
