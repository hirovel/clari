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
  Container,
  Editor,
  getKeybindings,
  isViewportTUI,
  Key,
  Loader,
  matchesKey,
  ScrollView,
  Spacer,
  type Terminal,
  Text,
  type TUI,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
} from "@earendil-works/pi-tui";
import { Agent, type DeliverAs } from "../src/agent.js";
import type { ApprovalConfig } from "../src/approval.js";
import { contextTokens } from "../src/compaction.js";
import type { ModelConfig, ResultView, ToolPromptsConfig } from "../src/config.js";
import { fmtCostApprox, type Price, UsageAccumulator } from "../src/cost.js";
import { type AgentEvent, now } from "../src/events.js";
import type { EventLog } from "../src/log.js";
import { type CompactionConfig, compactionThreshold, type TurnDeps } from "../src/loop.js";
import type { EffortLevel, Provider, ToolDef } from "../src/provider.js";
import type { ChildInfo } from "../src/subagent.js";
import type { Tool } from "../src/tools.js";
import { DEFAULT_RESULT_VIEWS, firstRunLines, shortcutLines, thinkingLines } from "./cards.js";
import { editInExternalEditor } from "./editor.js";
import { fmtTok, RequestInspector, type SessionSource } from "./inspector.js";
import type { McpServerStatus } from "./mcp/bridge.js";
import type { Skill } from "./prompt.js";
import type { CapabilitySource, Inferred } from "./registry.js";
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
import { Block, SplitLine } from "./tui-block.js";
import { COMMANDS, command, openLogin, openPalette, submit } from "./tui-commands.js";
import { FOLD_HEAD, RAW_LINE_CAP, type TuiContext } from "./tui-context.js";
import { contextAction } from "./tui-edit.js";
import { brief, pct } from "./tui-format.js";
import type { ProviderSummary } from "./tui-login.js";
import {
  attachChild,
  render,
  streamDelta,
  streamReasoning,
  toggleFold,
  toggleReasoning,
} from "./tui-render.js";
import { approveImpl, initialApproval, initialSlotState } from "./tui-slots.js";
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
    /** 窗口与出处,头部显示;假设值标红。 */
    contextWindow?: number;
    capabilitySource?: CapabilitySource;
  };
  settings?: TuiSettings;
  /** 日志为空时用它落 session/start;入口已经落过(bootstrap.beginSession)就不需要。 */
  systemPrompt?: string;
  onExit?: () => void;
  /** 工具结果初始是否折叠。缺省不折叠;Ctrl+O 随时切换。 */
  fold?: boolean;
  /** 折叠时保留的结果行数;缺省 5。 */
  foldLines?: number;
  /** 每个工具的结果可见度;没写的按 DEFAULT_RESULT_VIEWS,再没有按 head。 */
  results?: Record<string, ResultView>;
  /** 账簿保持展开的最新步数;缺省 3,0 = 从不自动折。 */
  foldSteps?: number;
  /** 屏幕模式:alt(缺省)备用屏,main 主屏。 */
  screen?: "alt" | "main";
  /** 桌面通知:unfocused(缺省)| always | off。 */
  notify?: "unfocused" | "always" | "off";
  /** 记录每次请求收到的原始流,供检视器"接收"分区逐行展示。 */
  trace?: boolean;
  /** 原始流旁路输出(如写 trace 文件)。requestIndex 是 request 事件在日志中的下标。 */
  onRaw?: (requestIndex: number, line: string) => void;
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

/** 脉搏的八级格。 */
const PULSE_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

export function createTuiApp(deps: TuiAppDeps): TuiApp {
  const { log, tools, compaction } = deps;

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
  const header = new Text("", 1, 0);
  const transcript = new Container();
  const live = new Container();
  const status = new SplitLine();
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
  }
  // 焦点事件:通知只在终端失焦时发。
  deps.terminal.write(FOCUS_ON);

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

  // ---------- 检视器 ----------
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
      loader: undefined,
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
      rawAt: new Map(),
      rawLines: 0,
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
      },
      close() {
        if (!ctx.dialog.overlay) return;
        ctx.dialog.overlay.hide();
        ctx.dialog.overlay = undefined;
        ctx.dialog.component = undefined;
        tui.setFocus(editor);
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
        tui.setFocus(editor);
        tui.requestRender();
      },
    },
    note(text) {
      transcript.addChild(new Block(text));
      tui.requestRender();
    },
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
          : `${tone(G.seal)} ${c.bold(c.jin("clari"))}  ${c.ink(info.model)}  ${c.faint(`${info.providerName} · `)}${contextTag(info)}${c.faint(` · ${info.sessionFile}`)}`,
      );
    },
    updateStatus,
    // 工作行:spinner、在做什么、用时、怎么打断;用时每秒刷新。
    showLoader(message) {
      ctx.hideLoader();
      const startedAt = Date.now();
      ctx.view.turnStartedAt = startedAt;
      const text = () =>
        `${message} · ${Math.round((Date.now() - startedAt) / 1000)}s · Esc to interrupt`;
      const loader = new Loader(tui, c.zhu, c.faint, text());
      ctx.view.loader = loader;
      // 半秒一拍:印章进一个相位;每两拍刷一次用时与标题。
      ctx.view.loaderTimer = setInterval(() => {
        ctx.view.sealFrame += 1;
        ctx.updateHeader();
        if (ctx.view.sealFrame % 2 === 0) {
          loader.setMessage(text());
          updateTitle();
        }
        tui.requestRender();
      }, 500);
      live.addChild(loader);
      loader.start();
    },
    hideLoader() {
      const loader = ctx.view.loader;
      if (ctx.view.loaderTimer) clearInterval(ctx.view.loaderTimer);
      ctx.view.loaderTimer = undefined;
      ctx.view.sealFrame = 0;
      ctx.updateHeader();
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
      thinkingLines(s, kind, ctx.view.showReasoning, Math.max(20, deps.terminal.columns - 24)).join(
        "\n",
      ),
    onRaw(line) {
      const r = ctx.req;
      if (deps.trace) {
        const bucket = r.rawAt.get(r.lastIndex) ?? [];
        bucket.push(line);
        r.rawAt.set(r.lastIndex, bucket);
        // 缺省开,内存里只留最近 RAW_LINE_CAP 行:整桶淘汰最旧的请求,磁盘旁路文件不删。
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
  /** 状态行:左边是状态与上下文占用,右边是会话累计与快捷键入口;放不下时右边先让。 */
  function updateStatus(): void {
    // 回合结束(运行 → 空闲)时通知一次;审批提示在 askApproval 里自己通知。之后的说明行回到根上,不进最后一步。
    if (wasRunning && !agent.running) {
      ctx.notify("turn finished");
      ctx.transcript = ctx.root;
    }
    wasRunning = agent.running;
    updateTitle();
    const state = agent.running ? c.zhu(`${G.running} running`) : c.soft(`${G.idle} idle`);
    const t = ctx.threshold();
    let tokens = c.faint("no requests yet");
    const usage = ctx.view.lastUsage;
    if (usage) {
      // 上下文占用条:以自动压缩阈值为满格;细线淡色是背景信息,过七成才转朱色提醒。
      // 口径与请求卡的 limit 行一致:实测优先、压缩后按估算,手动 /compact 之后状态栏立刻回落。
      const used = Math.min(1, contextTokens(log.events) / t);
      const cells = used > 0 ? Math.max(1, Math.round(used * 10)) : 0;
      const bar = "━".repeat(cells) + "┄".repeat(10 - cells);
      const tone = used >= 0.7 ? c.zhu : c.faint;
      const trigger = compaction.trigger ?? "threshold";
      const room = `${pct(Math.max(0, 1 - used))} ${trigger === "threshold" ? "until auto-compaction" : "until the compaction threshold"}`;
      const over =
        used >= 1 && trigger !== "threshold"
          ? c.zhu(
              ` · past the threshold: /compact to compress${trigger === "manual" ? "" : " (compaction is set to remind)"}`,
            )
          : "";
      tokens = `${tone(bar)} ${c.faint(`${room} · ${usage.inputTokens}→${usage.outputTokens} tok`)}${over}`;
    }
    const queued = agent.queued > 0 ? c.faint(` · queued ${agent.queued}`) : "";
    const effort = agent.effort ? c.faint(` · effort ${agent.effort}`) : "";
    const runningChildren = ctx.children.views.filter((v) => v.running).length;
    const kids = runningChildren > 0 ? c.faint(` · sub-agents ${runningChildren} running`) : "";
    // 会话累计(含压缩摘要请求):输入、输出、缓存命中、费用。增量累计,每条事件到来时 render 喂进去。
    const totals = ctx.usage.totals();
    const sum =
      totals.requests > 0
        ? `↑${fmtTok(totals.inputTokens)} ↓${fmtTok(totals.outputTokens)}${totals.cacheReadTokens > 0 ? ` · cache ${fmtTok(totals.cacheReadTokens)}` : ""}${totals.cost !== undefined ? ` · ${fmtCostApprox(totals.cost)}` : ""} · `
        : "";
    // 上下文脉搏:最近十次请求的占用比各一格,压缩发生在哪、上下文在涨还是稳,一眼看到。
    const pulse =
      ctx.view.pulse.length > 1
        ? ` ${c.faint(ctx.view.pulse.map((r) => PULSE_BLOCKS[Math.min(7, Math.max(0, Math.round(r * 7)))]).join(""))}`
        : "";
    const cursor =
      ctx.view.selectedStep !== undefined
        ? c.soft(
            ` · step ${ctx.view.selectedStep + 1}/${ctx.steps.length} · Enter fold or unfold · Esc release`,
          )
        : "";
    status.set(
      `${state}  ${tokens}${pulse}${effort}${queued}${kids}${cursor}`,
      c.faint(`${sum}? shortcuts`),
    );
    tui.requestRender();
  }

  // ---------- 历史回放与订阅:屏幕即历史,历史与新事件长得一样 ----------
  const draw = (e: AgentEvent) => render(ctx, e);
  if (log.events.length > 0) {
    for (const e of log.events) draw(e);
    log.subscribe(draw);
    if (log.events.length > 1) {
      ctx.note(
        c.soft(`· resumed: ${log.events.length} events, appending to ${deps.info.sessionFile}`),
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
      if (ctx.inspector.overlay) ctx.inspector.close();
      else ctx.inspector.open();
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("e"))) {
      // Ctrl+E:组装视图,模型下一步会看到的每条消息从哪来、落在线路的第几条。
      if (!ctx.inspector.overlay) ctx.inspector.open();
      inspector.showComposition();
      tui.requestRender();
      return { consume: true };
    }
    if (ctx.inspector.overlay || approval.overlay || ctx.dialog.overlay) return undefined; // 检视器、审批提示或对话框打开时,其余按键归它们
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
    // 账簿光标:PgUp / PgDn 在步之间移动并滚到那一步;Enter(输入框为空)展开或折起;Esc 放开。
    if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      selectStep(ctx, matchesKey(data, "pageUp") ? -1 : 1);
      return { consume: true };
    }
    if (
      matchesKey(data, Key.enter) &&
      editor.getText() === "" &&
      !editor.isShowingAutocomplete() &&
      ctx.view.selectedStep !== undefined
    ) {
      toggleSelectedStep(ctx);
      return { consume: true };
    }
    if (matchesKey(data, Key.escape) && !agent.running && clearStepSelection(ctx)) {
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

  return {
    tui,
    agent,
    submit: (text, opts) => submit(ctx, text, opts),
    command: (text) => command(ctx, text),
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
    slots: () => ctx.agent.slots,
    approvalLines: () => approval.prompt?.render() ?? [],
    approvalInput: (data) => approval.prompt?.handleInput(data),
    dialogLines: () => ctx.dialog.component?.render(deps.terminal.columns) ?? [],
    dialogInput: (data) => ctx.dialog.component?.handleInput?.(data),
    openLogin: (provider) => openLogin(ctx, provider ? { provider } : {}),
    toggleFold: () => toggleFold(ctx),
    toggleReasoning: () => toggleReasoning(ctx),
    stop: () => ctx.stop(),
  };
}
