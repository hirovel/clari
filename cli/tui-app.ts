// TUI 应用:与终端实现解耦,便于用虚拟终端离线验证。cli/tui.ts 负责配置与真实终端,本文件负责界面。

// pi-tui 只当渲染引擎(Q45):差分渲染、编辑器、宽度计算;视觉层全部是这里的自有组合。
import { existsSync, readFileSync } from "node:fs";
import {
  CombinedAutocompleteProvider,
  type Component,
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
import { Agent, type DeliverAs } from "../src/agent.js";
import { keepRatio, keepRecentTokens } from "../src/compaction.js";
import { contextBreakdown } from "../src/context.js";
import { fmtCost, type Price, usageTotals } from "../src/cost.js";
import { type AgentEvent, now, type ToolCall } from "../src/events.js";
import type { EventLog } from "../src/log.js";
import {
  allowAll,
  type CompactionConfig,
  compactionThreshold,
  queueToTurnEnd,
  recordingProvider,
  steer,
  type TurnDeps,
} from "../src/loop.js";
import { composeContext, editState, type Message } from "../src/messages.js";
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type Provider,
  parseEffort,
  type ToolDef,
} from "../src/provider.js";
import { classifyError, type ErrorKind, hintFor } from "../src/providers/errors.js";
import type { ChildInfo } from "../src/subagent.js";
import type { Tool } from "../src/tools.js";
import { expandFileRefs } from "./attachments.js";
import { forkSession, loadCompactionStrategy, SESSIONS_DIR } from "./bootstrap.js";
import {
  callLine,
  cont,
  errorCardLines,
  firstRunLines,
  GUTTER,
  predictedCache,
  rawRow,
  receiveBlockLines,
  receiveHead,
  resultLines,
  sendCardLines,
  shortcutLines,
  thinkingLines,
} from "./cards.js";
import { editInExternalEditor } from "./editor.js";
import {
  type CompositionRow,
  type ContextAction,
  fmtMs,
  fmtTok,
  messagesFor,
  RequestInspector,
  type SessionSource,
} from "./inspector.js";
import { expandSkill, type Skill } from "./prompt.js";
import { expandTemplate, type PromptTemplate } from "./templates.js";
import { c, editorTheme, markdownTheme } from "./theme.js";
import { diffLines, hunks } from "./tools/diff.js";
import { clearMemory, forgetMemory, type MemoryFiles, memoryEntries } from "./tools/memory.js";

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
  /** 审批槽的界面实现(Q64):ask = 每个工具调用弹一行确认;缺省 all 不问。 */
  approve?: "all" | "ask";
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
    /** 直接进入事件视图。 */
    openEvents(): void;
    /** 直接进入压缩对照。 */
    openCompactions(): void;
    /** 直接进入组装视图(Ctrl+E)。 */
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
  toggleFold(): void;
  toggleReasoning(): void;
  stop(): void;
};

/** 折叠时保留的行数。 */
const FOLD_HEAD = 3;
/** 子 agent 尾窗保留的行数。 */
const CHILD_TAIL = 3;
/** 子 agent 视图的三态:尾窗(缺省)→ 全部 → 仅进度。 */
type ChildMode = "tail" | "all" | "progress";

const COMMANDS = [
  {
    name: "inspect",
    description:
      "Inspector (Ctrl+R): every API request, what was sent, received, decided and written",
  },
  {
    name: "events",
    description: "Events view: the whole event array the kernel maintains, raw JSON per event",
  },
  {
    name: "compactions",
    description: "Compactions: which span of the original became which summary",
  },
  {
    name: "composition",
    description:
      "Context composition (Ctrl+E): every message the model sees next, its source event, stages, wire index",
  },
  { name: "context", description: "Context breakdown: tokens and share per part" },
  { name: "prompt", description: "System prompt sections: what they are, how big, where they sit" },
  {
    name: "memory",
    description:
      "Cross-session memory: /memory lists; /memory forget N removes one; /memory clear empties it",
  },
  {
    name: "compact",
    description: "Compact now, optionally with instructions: /compact keep the errors",
  },
  {
    name: "fork",
    description:
      "Fork the session: /fork copies up to the last user message; /fork N copies the first N events to a new file",
  },
  {
    name: "edit",
    description:
      "Edit the context: /edit N [text|reasoning|content|system] [new text]; without text the external editor opens. The original stays in the event",
  },
  {
    name: "drop",
    description:
      "Drop a message: /drop N [note]; an assistant message takes its tool results with it",
  },
  { name: "compare", description: "Compare an edited message with its original: /compare N" },
  {
    name: "restore",
    description: "Restore the original of an edited message: /restore N (recorded as another edit)",
  },
  {
    name: "rewind",
    description: "Rewind to a message: /rewind N drops every message after event N",
  },
  { name: "edits", description: "List every edit and drop in this session" },
  {
    name: "retry",
    description:
      "Retry the step: drop the last assistant reply and its tool results, then ask again with no new prompt",
  },
  { name: "slots", description: "Show every strategy slot and its current implementation" },
  {
    name: "tools",
    description: "Tool definitions sent with every request: name, tokens, concurrency, params",
  },
  { name: "raw", description: "Raw stream of request N as received, line by line: /raw N" },
  {
    name: "skills",
    description: "List skills: source, description size, model-invocable, allowed tools",
  },
  {
    name: "compaction",
    description: "Switch compaction strategy: /compaction llm|clear|pipeline|./x.mjs|off",
  },
  {
    name: "preservation",
    description: "How much recent context compaction keeps: /preservation tokens N | ratio R",
  },
  { name: "execution", description: "Tool execution: /execution sequential|parallel" },
  { name: "steering", description: "When queued messages are injected: /steering step|turn" },
  { name: "approve", description: "Tool approval: /approve all|ask" },
  {
    name: "model",
    description: "Switch model: /model provider/model; without arguments lists the options",
  },
  {
    name: "models",
    description: "Ask the provider which models exist; flags configured ones that are gone",
  },
  {
    name: "fields",
    description:
      "What this protocol puts in a request, reads from a response, and knowingly ignores",
  },
  {
    name: "effort",
    description: "Effort level: /effort off|low|medium|high|xhigh|max; auto omits it",
  },
  {
    name: "key",
    description: "Set a provider key: /key deepseek sk-… (written to the config file)",
  },
  { name: "default", description: "Make the current model the default" },
  { name: "stop", description: "Interrupt the running turn" },
  { name: "help", description: "List commands" },
  { name: "quit", description: "Quit" },
];

/** 引导线:子 agent 的每一行都带它,一眼分清层级;不是框线(Q45)。 */
const GUIDE = `  ${c.faint("┆")} `;

/** 内存里保留的原始流行数上限;超过就整桶淘汰最旧请求的 raw(磁盘旁路文件不受影响)。 */
const RAW_LINE_CAP = 100_000;

export function createTuiApp(deps: TuiAppDeps): TuiApp {
  const { log, tools, compaction } = deps;
  let info = deps.info;
  let effortLevels = deps.effortLevels;
  let contextWindow = compaction.window;
  const threshold = () => compactionThreshold(contextWindow, deps.reserveTokens);

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

  let lastUsage: { inputTokens: number; outputTokens: number } | undefined;
  let streaming: Markdown | undefined;
  let streamBuffer = "";
  let reasoningView: Text | undefined;
  let reasoningBuffer = "";
  let loader: Loader | undefined;

  // 显示状态(Q49):折叠/隐藏只改屏幕,不改日志;切换键重绘已有节点。
  let foldResults = deps.fold ?? false;
  // 思考缺省折成一行(首行 + 种类 + 行数),Ctrl+T 展开全文。
  let showReasoning = false;
  /** 首屏(新会话且还没有用户消息时显示),第一条消息一到就撤。 */
  let firstRun: Text | undefined;
  let childMode: ChildMode = "tail";
  type ResultRecord = { name: string; content: string; isError: boolean; durationMs?: number };
  const resultNodes: ({ node: Text } & ResultRecord)[] = [];
  const reasoningNodes: { node: Text; text: string; kind?: "full" | "summary" }[] = [];

  // 请求层记录(Q48):发出每个请求时用的 provider,以及开 trace 时收到的原始流。都不进日志。
  const providersAt = new Map<number, Provider>();
  const rawAt = new Map<number, string[]>();
  let rawLines = 0;
  let requestCount = 0;
  let lastRequestIndex = -1;

  // 子 agent(Q62):每个子一个视图块,挂在父会话里对应 task 调用行的下面。
  const childViews: ChildView[] = [];
  const childSlots = new Map<string, Container>();

  // 推理内容不隐藏(Q34):thinking 模型的思考过程以淡字实时呈现。
  const renderReasoning = (s: string, kind?: "full" | "summary") =>
    thinkingLines(s, kind, showReasoning, Math.max(20, deps.terminal.columns - GUTTER - 24)).join(
      "\n",
    );

  // 发送卡 / 接收卡(可见性的核心):上一次正常步发出的消息是"未变 / 新增"的比较基线;
  // 每个 request 事件下标对应一个接收卡头行节点,响应、压缩结果或失败到来时更新它。
  let lastSent: Message[] | undefined;
  let lastToolNames = "";
  const receiveHeads = new Map<number, Text>();
  const predictedAt = new Map<number, number>();
  let lastTurnRequestIndex = -1;
  let lastCompactionRequestIndex = -1;

  const onRaw = (line: string): void => {
    if (deps.trace) {
      const bucket = rawAt.get(lastRequestIndex) ?? [];
      bucket.push(line);
      rawAt.set(lastRequestIndex, bucket);
      // 缺省开(Q82),内存里只留最近 RAW_LINE_CAP 行:整桶淘汰最旧的请求,磁盘旁路文件不删。
      rawLines++;
      while (rawLines > RAW_LINE_CAP && rawAt.size > 1) {
        const oldest = rawAt.keys().next().value as number;
        rawLines -= rawAt.get(oldest)?.length ?? 0;
        rawAt.delete(oldest);
      }
    }
    deps.onRaw?.(lastRequestIndex, line);
  };

  // 审批(Q64):问一次就是一次;a 把该工具加进本会话的放行名单。拒绝以错误结果回喂模型(Q23)。
  const alwaysAllow = new Set<string>();
  /** 用户触发的技能声明的 allowed-tools:这一 turn 内免审批,turn 结束清空。 */
  const skillAllow = new Set<string>();
  const skills = deps.skills ?? [];
  let approval: OverlayHandle | undefined;
  let approvalPrompt: ApprovalPrompt | undefined;
  const askApproval = (call: ToolCall): Promise<boolean> => {
    if (alwaysAllow.has(call.name) || skillAllow.has(call.name)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const prompt = new ApprovalPrompt(call, (decision) => {
        approval?.hide();
        approval = undefined;
        approvalPrompt = undefined;
        tui.setFocus(editor);
        if (decision === "a") alwaysAllow.add(call.name);
        const allowed = decision !== "n";
        note(
          allowed
            ? c.faint(
                `· approve: allowed ${call.name}${decision === "a" ? " (not asked again this session)" : ""}`,
              )
            : c.zhu(`· approve: denied ${call.name}`),
        );
        resolve(allowed);
      });
      approvalPrompt = prompt;
      approval = tui.showOverlay(prompt, { width: "100%", anchor: "bottom-left" });
      tui.requestRender();
    });
  };

  const agent = new Agent({
    log,
    provider: deps.provider,
    tools,
    compaction,
    onRaw,
    ...(deps.effort && { effort: deps.effort }),
    slots: { ...deps.slots, ...(deps.approve === "ask" && { approve: askApproval }) },
    onDelta: (d) => {
      if (!streaming) {
        // 回复正文:一行 reply 标签,正文缩进到标签沟的内容列,Markdown 照常渲染。
        transcript.addChild(new Text(c.faint("reply"), 1, 0));
        streaming = new Markdown("", GUTTER + 3, 0, markdownTheme, { color: c.ink });
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
      `${c.bold(c.jin("clari"))}  ${c.ink(info.model)}  ${c.faint(`${info.providerName} · ${info.sessionFile}`)}`,
    );
  }

  /** 当前模型的价格:配置接口优先,其次启动时带来的。 */
  const priceFor = (model: string): Price | undefined =>
    deps.settings?.priceFor?.(model) ?? (model === info.model ? deps.price : undefined);

  function updateStatus(): void {
    const state = agent.running ? c.zhu("● running") : c.green("○ idle");
    const t = threshold();
    let tokens = c.faint("no requests yet");
    if (lastUsage) {
      // 上下文占用条:以自动压缩阈值为满格;过七成转朱色提醒。
      const used = Math.min(1, lastUsage.inputTokens / t);
      const cells = used > 0 ? Math.max(1, Math.round(used * 10)) : 0;
      const bar = "▰".repeat(cells) + "▱".repeat(10 - cells);
      const tone = used >= 0.7 ? c.zhu : c.jin;
      tokens = `${tone(bar)} ${c.faint(`${pct(Math.max(0, 1 - used))} until auto-compaction · ${lastUsage.inputTokens}→${lastUsage.outputTokens} tok`)}`;
    }
    // 会话累计(含压缩摘要请求):输入、输出、缓存命中、费用。数据全部来自事件数组。
    const totals = usageTotals(log.events, priceFor);
    const sum =
      totals.requests > 0
        ? c.faint(
            ` · total ↑${fmtTok(totals.inputTokens)} ↓${fmtTok(totals.outputTokens)}${totals.cacheReadTokens > 0 ? ` cache ${fmtTok(totals.cacheReadTokens)}` : ""}${totals.cost !== undefined ? ` ${fmtCost(totals.cost)}` : ""}`,
          )
        : "";
    const queued = agent.queued > 0 ? c.faint(` · queued ${agent.queued}`) : "";
    const effort = agent.effort ? c.faint(` · effort ${agent.effort}`) : "";
    const runningChildren = childViews.filter((v) => v.running).length;
    const kids = runningChildren > 0 ? c.faint(` · sub-agents ${runningChildren} running`) : "";
    status.setText(`${state}  ${tokens}${sum}${effort}${queued}${kids}`);
    tui.requestRender();
  }

  function note(text: string): void {
    transcript.addChild(new Text(text, 1, 0));
    tui.requestRender();
  }

  /** 工具结果的屏幕文本。折叠只是显示状态,内容原封不动留在节点里。 */
  function resultText(r: ResultRecord): string {
    return resultLines(r, { folded: foldResults, head: FOLD_HEAD }).join("\n");
  }

  /** Ctrl+O:父的工具结果折叠/展开;子 agent 块在 尾窗 → 全部 → 仅进度 间轮换。 */
  function toggleFold(): void {
    foldResults = !foldResults;
    for (const r of resultNodes) r.node.setText(resultText(r));
    const order: ChildMode[] = ["tail", "all", "progress"];
    childMode = order[(order.indexOf(childMode) + 1) % order.length] as ChildMode;
    for (const v of childViews) v.refresh();
    const kids =
      childViews.length > 0
        ? `; sub-agents: ${childMode === "tail" ? "tail" : childMode === "all" ? "all" : "progress only"}`
        : "";
    note(
      c.faint(`· tool results ${foldResults ? "folded (Ctrl+O to unfold)" : "unfolded"}${kids}`),
    );
  }

  function toggleReasoning(): void {
    showReasoning = !showReasoning;
    for (const r of reasoningNodes) r.node.setText(renderReasoning(r.text, r.kind));
    if (reasoningView) reasoningView.setText(renderReasoning(reasoningBuffer));
    note(
      c.faint(showReasoning ? "· thinking expanded" : "· thinking collapsed to one line (Ctrl+T)"),
    );
  }

  /** 更新某次请求的接收卡头行;n 是它的请求序号。 */
  function setReceiveHead(
    requestIndex: number,
    n: number,
    fill: Partial<Parameters<typeof receiveHead>[0]>,
  ): void {
    const node = receiveHeads.get(requestIndex);
    const req = log.events[requestIndex];
    if (!node || req?.type !== "request") return;
    const price = priceFor(req.model);
    const predicted = predictedAt.get(requestIndex);
    node.setText(
      receiveHead({
        n,
        estimated: req.estimatedTokens,
        ...(price && { price }),
        ...(predicted !== undefined && { predictedCache: predicted }),
        ...fill,
      }),
    );
  }

  // ---------- 子 agent 视图(Q62) ----------

  class ChildView {
    readonly block = new Container();
    private readonly progress = new Text("", 1, 0);
    private readonly body = new Text("", 1, 0);
    private readonly lines: string[] = [];
    private steps = 0;
    private toolsUsed = 0;
    private tokens = 0;
    private readonly startedAt = Date.now();
    private finishedAt: number | undefined;
    private ok = true;
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor(readonly info: ChildInfo) {
      this.block.addChild(this.progress);
      this.block.addChild(this.body);
      // 起始事件(继承的父上下文、任务简报)不重画:父屏幕上已经有它们;只画子自己产生的。
      const skip = info.log.events.length;
      info.log.subscribe((e) => {
        this.absorb(e);
        this.refresh();
      });
      void skip;
      this.timer = setInterval(() => this.refresh(), 1000);
      this.refresh();
    }

    get running(): boolean {
      return this.finishedAt === undefined;
    }

    private absorb(e: AgentEvent): void {
      if (e.type === "assistant/message") {
        this.steps += 1;
        if (e.usage) this.tokens = e.usage.inputTokens;
      }
      if (e.type === "tool/result") this.toolsUsed += 1;
      this.lines.push(...childEventLines(e).map((l) => GUIDE + l));
    }

    finish(ok: boolean): void {
      this.ok = ok;
      this.finishedAt = Date.now();
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      this.refresh();
    }

    dispose(): void {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
    }

    refresh(): void {
      const elapsed = fmtMs((this.finishedAt ?? Date.now()) - this.startedAt);
      const stats = `step ${this.steps} · ${this.toolsUsed} tool calls · ${elapsed}${this.tokens ? ` · ${fmtTok(this.tokens)} tok` : ""}`;
      const head = this.running
        ? `${c.zhu("●")} ${c.soft(`running · ${stats}`)}`
        : this.ok
          ? `${c.green("✓")} ${c.soft(`done · ${stats}`)}`
          : `${c.zhu("✗")} ${c.soft(`partial · ${stats}`)}`;
      this.progress.setText(GUIDE + head);
      let body: string;
      if (childMode === "progress" || (!this.running && childMode !== "all")) {
        body =
          GUIDE +
          c.faint(
            `sub-session ${this.lines.length} lines · Ctrl+O to expand${this.info.log.path ? ` · ${this.info.log.path}` : ""}`,
          );
      } else if (childMode === "all") {
        body = this.lines.length > 0 ? this.lines.join("\n") : GUIDE + c.faint("(no output yet)");
      } else {
        const tail = this.lines.slice(-CHILD_TAIL);
        const more =
          this.lines.length > CHILD_TAIL
            ? [GUIDE + c.faint(`… ${this.lines.length} lines in the sub-session · Ctrl+O for all`)]
            : [];
        body = [...tail, ...more].join("\n") || GUIDE + c.faint("(no output yet)");
      }
      this.body.setText(body);
      tui.requestRender();
    }
  }

  function attachChild(child: ChildInfo): void {
    const view = new ChildView(child);
    childViews.push(view);
    const slot = child.callId ? childSlots.get(child.callId) : undefined;
    if (slot) slot.addChild(view.block);
    else transcript.addChild(view.block);
    updateStatus();
  }

  // ---------- 请求检视器(Q49) ----------

  const defs = (): ToolDef[] =>
    tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  let overlay: OverlayHandle | undefined;
  const sessions = (): SessionSource[] => [
    { name: "main", events: log.events },
    ...childViews.map((v) => ({
      name: `sub #${v.info.index} ${brief(v.info.task)}`,
      events: v.info.log.events,
    })),
  ];
  const inspector = new RequestInspector({
    events: () => log.events,
    sessions,
    // 恢复的会话拿不到当时的 provider 对象;模型名相同就用当前的重建线路正文,否则如实缺省。
    providerFor: (i) => {
      const known = providersAt.get(i);
      if (known) return known;
      const e = log.events[i];
      return e?.type === "request" && e.model === agent.provider.model ? agent.provider : undefined;
    },
    currentProvider: () => agent.provider,
    tools: defs,
    rows: () => deps.terminal.rows,
    ...(deps.trace && { rawFor: (i: number) => rawAt.get(i) }),
    onClose: () => closeInspector(),
    onAction: (action, row) => void contextAction(action, row),
    requestRender: () => tui.requestRender(),
  });

  function openInspector(opts: { keep?: boolean } = {}): void {
    if (overlay) return;
    // keep:调用方已经定好位(如 /raw N),不回到列表。
    if (!opts.keep) inspector.reset();
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
        if (firstRun) {
          transcript.removeChild(firstRun);
          firstRun = undefined;
        }
        transcript.addChild(new Spacer(1));
        transcript.addChild(new Text(`${c.zhu("›")} ${c.bold(c.ink(e.text))}`, 1, 0));
        break;
      case "assistant/message": {
        // 接收卡头行:停止原因、耗时、实测用量、缓存命中率、费用。
        setReceiveHead(lastTurnRequestIndex, requestCount, { response: e });
        if (reasoningView) {
          if (e.reasoning) {
            reasoningView.setText(renderReasoning(e.reasoning, e.reasoningKind));
            reasoningNodes.push({
              node: reasoningView,
              text: e.reasoning,
              ...(e.reasoningKind && { kind: e.reasoningKind }),
            });
          } else transcript.removeChild(reasoningView);
          reasoningView = undefined;
          reasoningBuffer = "";
        } else if (e.reasoning) {
          const node = new Text(renderReasoning(e.reasoning, e.reasoningKind), 1, 0);
          reasoningNodes.push({
            node,
            text: e.reasoning,
            ...(e.reasoningKind && { kind: e.reasoningKind }),
          });
          transcript.addChild(node);
        }
        if (streaming) {
          if (e.text) streaming.setText(e.text);
          else transcript.removeChild(streaming);
          streaming = undefined;
          streamBuffer = "";
        } else if (e.text) {
          transcript.addChild(new Text(c.faint("reply"), 1, 0));
          transcript.addChild(new Markdown(e.text, GUTTER + 3, 0, markdownTheme, { color: c.ink }));
        }
        if (e.usage) lastUsage = e.usage;
        for (const tc of e.toolCalls) {
          transcript.addChild(new Text(callLine(tc.name, formatArgs(tc.args)), 1, 0));
          // edit/write 的改动内容直接可见(Q58):diff 从参数算出,不进日志。续行缩进到内容列。
          const detail = toolCallDetail(tc.name, tc.args);
          if (detail) {
            transcript.addChild(
              new Text(
                detail
                  .split("\n")
                  .map((l) => cont(l))
                  .join("\n"),
                1,
                0,
              ),
            );
          }
          // task 调用行下面留一个槽,子 agent 开跑时把它的块挂进来(Q62)。
          if (tc.name === "task") {
            const slot = new Container();
            childSlots.set(tc.id, slot);
            transcript.addChild(slot);
          }
        }
        // 响应里除思考与文本之外的块:私有回传物(签名思考块、加密推理项)。
        for (const l of receiveBlockLines(e)) transcript.addChild(new Text(l, 1, 0));
        // 原始流缺省开(Q82):每张接收卡尾行说明收了几行、去哪看。
        if (deps.trace) {
          const raw = rawAt.get(lastTurnRequestIndex);
          if (raw) transcript.addChild(new Text(rawRow(raw.length, requestCount), 1, 0));
        }
        if (e.stopReason === "aborted") note(c.faint("— interrupted —"));
        if (e.stopReason === "length")
          note(c.jin("◇ output truncated; the model was asked to resend"));
        break;
      }
      case "tool/result": {
        // 默认完整显示,不折叠(Q34);Ctrl+O 切换折叠,内容仍在节点里。
        const rec: ResultRecord = {
          name: e.name,
          content: e.content,
          isError: e.isError,
          ...(e.durationMs !== undefined && { durationMs: e.durationMs }),
        };
        const node = new Text(resultText(rec), 1, 0);
        resultNodes.push({ node, ...rec });
        transcript.addChild(node);
        const child = childViews.find((v) => v.info.callId === e.callId && v.running);
        if (child) child.finish(!e.isError);
        break;
      }
      case "request": {
        requestCount += 1;
        lastRequestIndex = log.events.length - 1;
        providersAt.set(lastRequestIndex, agent.provider);
        // 发送卡:这次实际发出的消息(正常步 = 之前事件的投影;摘要请求 = 记录的 body),
        // 与上一次正常步比出"未变 / 新增",参数来自 provider.wire,与线路正文同源。
        const rec = {
          index: lastRequestIndex,
          request: e,
          n: requestCount,
          retries: [],
          before: [],
        };
        const messages = messagesFor(log.events, rec);
        // 来历(Q81):正常步的正文就是之前事件的投影,每条都能对回事件号;摘要请求的正文由策略记的 body 重建,没有来历。
        const provenance = e.body
          ? undefined
          : composeContext(log.events.slice(0, lastRequestIndex)).provenance;
        const activeDefs = defs().filter((d) => e.tools.includes(d.name));
        const level = e.effort ? parseEffort(e.effort) : undefined;
        const wire = agent.provider.wire?.(messages, activeDefs, level ? { effort: level } : {});
        const start = log.events.find((x) => x.type === "session/start");
        const toolNames = e.tools.join(" ");
        transcript.addChild(new Spacer(1));
        transcript.addChild(
          new Text(
            sendCardLines({
              n: requestCount,
              request: e,
              messages,
              ...(lastSent && { previous: lastSent }),
              ...(wire !== undefined && { wire }),
              defs: activeDefs,
              ...(start?.type === "session/start" &&
                start.sections && { sections: start.sections }),
              ...(provenance && { provenance }),
              width: Math.max(24, deps.terminal.columns - 52),
              toolsUnchanged: toolNames === lastToolNames,
              dropsThinking: agent.provider.fields?.protocol.startsWith("anthropic") ?? false,
            }).join("\n"),
            1,
            0,
          ),
        );
        predictedAt.set(lastRequestIndex, predictedCache(lastSent, messages));
        lastToolNames = toolNames;
        if (e.reason === "compaction") lastCompactionRequestIndex = lastRequestIndex;
        else {
          lastTurnRequestIndex = lastRequestIndex;
          lastSent = messages;
        }
        // 接收卡头行先占位,响应到了再填。思考与正文节点随后接在它下面。
        const headNode = new Text("", 1, 0);
        receiveHeads.set(lastRequestIndex, headNode);
        transcript.addChild(headNode);
        setReceiveHead(lastRequestIndex, requestCount, {});
        break;
      }
      case "retry":
        note(
          c.faint(
            `· retry ${e.attempt}: ${e.status ?? ""} ${e.error.split("\n")[0]}, next attempt in ${fmtMs(e.delayMs)}`,
          ),
        );
        break;
      case "decision":
        if (e.slot === "steering")
          note(c.faint(`· steering: injected ${e.injected} (${e.boundary} boundary)`));
        if (e.slot === "execution")
          note(c.faint(`· parallel: ${e.parallel} calls at once: ${e.tools.join(", ")}`));
        break;
      case "request/error": {
        // 接收卡头行标成失败,下面画错误卡:分类、供应商原话、下一步、原始体在哪。
        const req = log.events[lastRequestIndex];
        const kind = (e.kind ?? classifyError(new Error(e.error))) as ErrorKind;
        // 头行只写分类与状态码;原话与下一步在错误卡里,不重复。
        setReceiveHead(lastRequestIndex, requestCount, {
          error: `${kind}${e.status !== undefined ? ` · HTTP ${e.status}` : ""}`,
        });
        const lines = errorCardLines(e, {
          n: requestCount,
          providerName: info.providerName,
          ...(req?.type === "request" && { model: req.model }),
          hint: hintFor(kind, { providerName: info.providerName, model: info.model }),
        });
        transcript.addChild(new Text(lines.join("\n"), 1, 0));
        break;
      }
      case "compaction": {
        if (e.usage) {
          const n = log.events
            .slice(0, lastCompactionRequestIndex + 1)
            .filter((x) => x.type === "request").length;
          setReceiveHead(lastCompactionRequestIndex, n, { compaction: e });
        }
        const parts: string[] = [];
        if (e.summary !== undefined)
          parts.push(`summary covers events ${e.coversFrom ?? 1}-${e.coversUpTo}`);
        if (e.cleared?.length) parts.push(`cleared ${e.cleared.length} tool results`);
        const cost = e.usage
          ? `  summary request · ${fmtTok(e.usage.inputTokens)}→${fmtTok(e.usage.outputTokens)} tok · ${fmtMs(e.latencyMs)}`
          : "";
        const who = e.strategy ? ` (${e.strategy})` : "";
        note(
          `${c.jin(`◇ compacted${who}: ${parts.join(", ")}`)}${c.faint(`${cost}  /compactions to compare original and summary`)}`,
        );
        break;
      }
      case "session/model":
        note(c.jin(`◇ model switched to ${e.model}`));
        break;
      case "session/slot":
        // 恢复会话时把历史切换也画出来;当前会话里 slotCommand 已经打过确认行,这里只补状态。
        slotState[e.slot] = e.value;
        break;
      case "session/interrupt":
      case "session/start":
        break;
    }
    updateStatus();
  }

  if (log.events.length > 0) {
    // 日志已有内容(入口落过 session/start,或恢复的会话):屏幕即历史,
    // 用同一个渲染函数把已有事件过一遍,历史与新事件长得一样(Q54)。
    for (const e of log.events) render(e);
    log.subscribe(render);
    if (log.events.length > 1) {
      note(c.jin(`◇ resumed: ${log.events.length} events, appending to ${info.sessionFile}`));
    }
  } else {
    log.subscribe(render);
    log.append({
      type: "session/start",
      at: now(),
      model: info.model,
      system: deps.systemPrompt ?? "",
    });
  }
  if (!log.events.some((e) => e.type === "user/message")) {
    firstRun = new Text(firstRunLines().join("\n"), 1, 0);
    transcript.addChild(firstRun);
  }
  updateHeader();
  updateStatus();

  // ---------- 输入 ----------

  async function submit(raw: string, opts: { deliverAs?: DeliverAs } = {}): Promise<void> {
    // @路径 展开成消息里的 <file> 块:附上的就是发出的,落盘上屏都完整。
    const expanded = expandFileRefs(raw);
    for (const a of expanded.attachments) {
      note(
        a.skipped
          ? c.zhu(`· @${a.ref}: ${a.skipped}`)
          : c.faint(`· attached @${a.ref} (${a.bytes} bytes)`),
      );
    }
    const text = expanded.text;
    if (agent.running) {
      void agent.prompt(text, opts);
      note(
        c.faint(
          opts.deliverAs === "followUp"
            ? "· queued for after the current step"
            : "· queued as steering: injected at the next step boundary",
        ),
      );
      updateStatus();
      return;
    }
    showLoader("thinking");
    try {
      // prompt() 同步执行到首个 await 时已把 running 置位;此处刷新状态栏才能显示"运行中"。
      const pending = agent.prompt(text);
      updateStatus();
      const outcome = await pending;
      if (typeof outcome === "object") note(c.jin(`◇ loop stopped: ${outcome.stopped}`));
    } catch (err) {
      // 请求层的失败已由 request/error 事件画成错误卡;这里只兜住循环之外的异常。
      if (log.events.at(-1)?.type !== "request/error") note(c.zhu(`✗ ${(err as Error).message}`));
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
          [
            ...COMMANDS.map((x) => `${c.jin(`/${x.name}`.padEnd(12))} ${c.soft(x.description)}`),
            ...templates.map(
              (t) => `${c.jin(`/${t.name}`.padEnd(12))} ${c.soft(`template: ${t.description}`)}`,
            ),
            c.faint(
              "Alt+Enter queues a message for after the current step · @path attaches a file · ? shortcuts",
            ),
          ].join("\n"),
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
      case "events":
        openInspector();
        inspector.showEvents();
        tui.requestRender();
        break;
      case "compactions":
        openInspector();
        inspector.showCompactions();
        tui.requestRender();
        break;
      case "composition":
        openInspector();
        inspector.showComposition();
        tui.requestRender();
        break;
      case "raw": {
        // /raw N:第 N 次请求的原始流,直接落到检视器接收分区。
        const n = Number(arg);
        if (!Number.isInteger(n) || n < 1) {
          note(
            c.faint(
              `Usage: /raw N  (1..${requestCount}); raw capture is ${deps.trace ? "on" : "off (--no-trace)"}`,
            ),
          );
          break;
        }
        if (!inspector.showRequest(n, 6)) {
          note(c.zhu(`No request #${n} (${requestCount} so far)`));
          break;
        }
        openInspector({ keep: true });
        tui.requestRender();
        break;
      }
      case "tools":
        note(toolsList());
        break;
      case "context":
        note(renderContext());
        break;
      case "prompt":
        note(renderPrompt());
        break;
      case "memory":
        note(memoryCommand(arg));
        break;
      case "compact":
        await manualCompact(arg);
        break;
      case "fork":
        note(forkCommand(arg));
        break;
      case "edit":
        note(editCommand(arg));
        break;
      case "drop":
        note(dropCommand(arg));
        break;
      case "edits":
        note(editsList());
        break;
      case "compare":
        note(compareCommand(arg));
        break;
      case "restore":
        note(restoreCommand(arg));
        break;
      case "rewind":
        note(rewindCommand(arg));
        break;
      case "retry":
        await retryStep();
        break;
      case "compaction":
      case "preservation":
      case "execution":
      case "steering":
      case "approve":
        note(await slotCommand(cmd, arg));
        break;
      case "slots":
        note(slotsList());
        break;
      case "skills":
        note(skillsList());
        break;
      case "model":
        switchModel(arg);
        break;
      case "models":
        await listRemoteModels();
        break;
      case "fields":
        note(renderFields());
        break;
      case "effort":
        setEffort(arg);
        break;
      case "key":
        setKey(arg);
        break;
      case "default":
        if (!deps.settings) {
          note(c.zhu("settings interface not configured"));
          break;
        }
        deps.settings.setDefault(`${info.providerName}/${info.model}`);
        note(c.jin(`◇ default model set to ${info.providerName}/${info.model}`));
        break;
      default: {
        // 提示词模板:/名 参数 → 展开成一条普通用户消息提交。
        const t = templates.find((x) => x.name === cmd);
        if (t) {
          note(c.faint(`· template /${t.name}  ${t.path}`));
          await submit(expandTemplate(t, arg));
          break;
        }
        // 技能(Q80):/名 参数 → 正文作为一条用户消息;allowed-tools 在这一 turn 免审批。
        const sk = skills.find((x) => x.name === cmd);
        if (sk) {
          note(
            c.faint(
              `· skill /${sk.name}  ${sk.path}${sk.allowedTools.length ? `  allowed-tools: ${sk.allowedTools.join(" ")}` : ""}`,
            ),
          );
          for (const name of sk.allowedTools) skillAllow.add(name);
          try {
            await submit(expandSkill(sk, arg));
          } finally {
            skillAllow.clear();
          }
          break;
        }
        note(c.zhu(`unknown command /${cmd}`) + c.faint("  /help lists commands"));
      }
    }
  }

  // ---------- 编辑上下文(Q74):改的是投影,不是历史 ----------

  type EditField = "text" | "reasoning" | "content" | "system";

  /** 目标事件允许改哪些字段,以及各字段当前(投影里)的值。 */
  function editable(
    target: number,
  ): { fields: EditField[]; current: (f: EditField) => string } | string {
    const e = log.events[target];
    if (!e) return `no event #${target} (${log.events.length} events; Ctrl+E shows event numbers)`;
    const cur = editState(log.events).edits.get(target) ?? {};
    switch (e.type) {
      case "assistant/message":
        return {
          fields: ["text", "reasoning"],
          current: (f) =>
            f === "reasoning" ? (cur.reasoning ?? e.reasoning ?? "") : (cur.text ?? e.text),
        };
      case "user/message":
        return { fields: ["content"], current: () => cur.content ?? e.text };
      case "tool/result":
        return { fields: ["content"], current: () => cur.content ?? e.content };
      case "session/start":
        return { fields: ["system"], current: () => cur.system ?? e.system };
      default:
        return `event #${target} is ${e.type}; it never reaches the model, nothing to edit`;
    }
  }

  /** 编辑的后果,保存时一并打印:缓存前缀失效、回传物丢弃、Anthropic 之后思考块全丢。 */
  function editConsequences(target: number): string[] {
    const out = [
      `the prefix from event #${target} on differs from the last request; cache hits will drop`,
    ];
    const e = log.events[target];
    if (e?.type === "assistant/message" && e.opaque !== undefined)
      out.push("this message's opaque block is no longer sent");
    if (agent.provider.fields?.protocol.startsWith("anthropic")) {
      out.push(
        "Anthropic thinking signatures bind the prefix: thinking blocks after this point are no longer echoed back",
      );
    }
    return out;
  }

  function editCommand(arg: string): string {
    if (agent.running) return c.zhu("cannot edit while running; press Esc first");
    const m = arg.match(/^(\d+)(?:\s+(text|reasoning|content|system))?(?:\s+([\s\S]+))?$/);
    if (!m)
      return c.faint(
        "Usage: /edit N [text|reasoning|content|system] [new text]; without text the external editor opens",
      );
    const target = Number(m[1]);
    const info = editable(target);
    if (typeof info === "string") return c.zhu(info);
    const field = (m[2] as EditField | undefined) ?? (info.fields[0] as EditField);
    if (!info.fields.includes(field)) {
      return c.zhu(`event #${target} has no field ${field}; editable: ${info.fields.join(" / ")}`);
    }
    const e = log.events[target];
    if (field === "reasoning" && e?.type === "assistant/message" && e.reasoningKind !== "full") {
      return c.zhu(
        `event #${target} thinking is ${e.reasoningKind === "summary" ? "a summary" : "of unknown kind"}: the model reads the opaque block, so editing it changes nothing. To steer, append a message, or use a model that echoes full thinking (DeepSeek)`,
      );
    }
    let value = m[3]?.trim();
    if (!value) {
      // 长文本走外部编辑器:先让出终端,编辑器退出后再接管。
      tui.stop();
      const next = editInExternalEditor(info.current(field), {
        suffix: field === "reasoning" ? ".txt" : ".md",
      });
      tui.start();
      if (next === undefined) return c.faint("· unchanged, cancelled");
      value = next;
    }
    log.append({ type: "context/edit", at: now(), target, field, value });
    return [
      c.jin(`◇ edited event #${target}.${field} (${value.length} chars)`),
      ...editConsequences(target).map((s) => c.faint(`  · ${s}`)),
      c.faint(
        "  · the original stays in the event; Ctrl+E shows the projection, the events view shows context/edit",
      ),
    ].join("\n");
  }

  function dropCommand(arg: string): string {
    if (agent.running) return c.zhu("cannot edit while running; press Esc first");
    const m = arg.match(/^(\d+)(?:\s+([\s\S]+))?$/);
    if (!m) return c.faint("Usage: /drop N [note]");
    const target = Number(m[1]);
    const e = log.events[target];
    if (!e) return c.zhu(`no event #${target}`);
    if (e.type !== "user/message" && e.type !== "assistant/message") {
      return c.zhu(
        `only user or assistant messages can be dropped (with their tool results); #${target} is ${e.type}`,
      );
    }
    const note = m[2]?.trim();
    log.append({ type: "context/drop", at: now(), target, ...(note && { note }) });
    const withResults =
      e.type === "assistant/message" && e.toolCalls.length > 0
        ? ` with its ${e.toolCalls.length} tool results`
        : "";
    return [
      c.jin(`◇ dropped event #${target}${withResults}`),
      ...editConsequences(target).map((s) => c.faint(`  · ${s}`)),
    ].join("\n");
  }

  /** 某事件在投影里可改的主字段与它的原值。 */
  function originalOf(target: number): { field: EditField; value: string } | undefined {
    const e = log.events[target];
    switch (e?.type) {
      case "assistant/message":
        return { field: "text", value: e.text };
      case "user/message":
        return { field: "content", value: e.text };
      case "tool/result":
        return { field: "content", value: e.content };
      case "session/start":
        return { field: "system", value: e.system };
      default:
        return undefined;
    }
  }

  /** 某字段的原值:reasoning 单独取,其余是主字段。 */
  function originalValue(target: number, field: string): string {
    const e = log.events[target];
    if (field === "reasoning" && e?.type === "assistant/message") return e.reasoning ?? "";
    return originalOf(target)?.value ?? "";
  }

  /** /compare N:编辑过的字段,原文与现值的行级 diff。 */
  function compareCommand(arg: string): string {
    const target = Number(arg);
    if (!Number.isInteger(target) || !originalOf(target))
      return c.faint("Usage: /compare N  (an edited user, assistant, tool-result or system event)");
    const cur = editState(log.events).edits.get(target) ?? {};
    const fields = Object.entries(cur).filter(([, v]) => typeof v === "string") as [
      string,
      string,
    ][];
    if (fields.length === 0) return c.faint(`event #${target} has no edits; nothing to compare`);
    const out: string[] = [];
    for (const [field, value] of fields) {
      const before = originalValue(target, field);
      out.push(
        c.jin(
          `◇ #${target}.${field}  original ${before.length} chars → current ${value.length} chars`,
        ),
      );
      out.push(
        (toolCallDetail("edit", { oldText: before, newText: value }) || c.faint("(identical)"))
          .split("\n")
          .map((l) => `    ${l}`)
          .join("\n"),
      );
    }
    return out.join("\n");
  }

  /** /restore N:把编辑过的字段改回原值。记成又一次编辑;事件数组只增不删。 */
  function restoreCommand(arg: string): string {
    if (agent.running) return c.zhu("cannot edit while running; press Esc first");
    const target = Number(arg);
    if (!Number.isInteger(target) || !originalOf(target)) return c.faint("Usage: /restore N");
    const cur = editState(log.events).edits.get(target) ?? {};
    const fields = Object.keys(cur) as EditField[];
    if (fields.length === 0) return c.faint(`event #${target} has no edits; nothing to restore`);
    for (const field of fields) {
      log.append({
        type: "context/edit",
        at: now(),
        target,
        field,
        value: originalValue(target, field),
        note: "restore",
      });
    }
    return [
      c.jin(
        `◇ restored event #${target} (${fields.join(", ")}) · recorded as another edit, nothing deleted`,
      ),
      ...editConsequences(target).map((s) => c.faint(`  · ${s}`)),
    ].join("\n");
  }

  /** /rewind N:丢弃事件 N 之后的每条用户与助手消息(工具结果随调用一起走)。下一请求从 N 起。 */
  function rewindCommand(arg: string): string {
    if (agent.running) return c.zhu("cannot edit while running; press Esc first");
    const target = Number(arg);
    if (!Number.isInteger(target) || !log.events[target])
      return c.faint("Usage: /rewind N  (drops every message after event N)");
    const dropped = editState(log.events).dropped;
    const victims = log.events
      .map((e, i) => ({ e, i }))
      .filter(
        ({ e, i }) =>
          i > target &&
          (e.type === "user/message" || e.type === "assistant/message") &&
          !dropped.has(i),
      );
    if (victims.length === 0) return c.faint(`nothing after event #${target} to drop`);
    for (const { i } of victims)
      log.append({ type: "context/drop", at: now(), target: i, note: `rewind to #${target}` });
    return [
      c.jin(
        `◇ rewound to event #${target}: dropped ${victims.length} message${victims.length === 1 ? "" : "s"} after it (tool results go with their calls)`,
      ),
      c.faint(
        "  · nothing is deleted; the next request starts from here · /retry asks again, or type a new message",
      ),
    ].join("\n");
  }

  /** 上下文面板(Ctrl+E)里选中一条消息后的动作:全部落到已有命令上,面板只是入口。 */
  async function contextAction(action: ContextAction, row: CompositionRow): Promise<void> {
    if (action === "view") return;
    closeInspector();
    const target = row.event;
    switch (action) {
      case "edit":
        note(editCommand(`${target} ${originalOf(target)?.field ?? "content"}`));
        break;
      case "edit-reasoning":
        note(editCommand(`${target} reasoning`));
        break;
      case "compare":
        note(compareCommand(String(target)));
        break;
      case "restore":
        note(restoreCommand(String(target)));
        break;
      case "drop":
        note(dropCommand(String(target)));
        break;
      case "rewind":
        note(rewindCommand(String(target)));
        break;
      case "retry":
        await retryStep();
        break;
      case "fork":
        note(forkCommand(String(target + 1)));
        break;
    }
  }

  /** /retry:编辑之后立刻看效果。丢弃以事件落盘,发送卡会标出编辑点。 */
  async function retryStep(): Promise<void> {
    if (agent.running) {
      note(c.zhu("cannot retry while running; press Esc first"));
      return;
    }
    showLoader("retrying");
    try {
      const pending = agent.retry();
      updateStatus();
      const outcome = await pending;
      if (typeof outcome === "object") note(c.jin(`◇ loop stopped: ${outcome.stopped}`));
    } catch (err) {
      note(c.zhu(`✗ ${(err as Error).message}`));
    } finally {
      hideLoader();
      updateStatus();
    }
  }

  function editsList(): string {
    const rows = log.events
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.type === "context/edit" || e.type === "context/drop");
    if (rows.length === 0) return c.faint("No edits. /edit N changes a message, /drop N drops one");
    return rows
      .map(({ e, i }) =>
        e.type === "context/edit"
          ? `  ${c.jin(`#${i}`)} ${c.ink(`edit #${e.target}.${e.field}`)} ${c.faint(`${e.value.length} chars ${e.at.slice(11, 19)}`)}`
          : `  ${c.jin(`#${i}`)} ${c.ink(`drop #${(e as { target: number }).target}`)} ${c.faint(e.at.slice(11, 19))}`,
      )
      .join("\n");
  }

  /** /fork:复制事件前缀到新文件。事件即真相,分叉就是复制前缀,原文件不动。 */
  function forkCommand(arg: string): string {
    let upTo: number;
    if (arg) {
      upTo = Number(arg);
      if (!Number.isInteger(upTo) || upTo < 1)
        return c.zhu("Usage: /fork or /fork N (first N events)");
    } else {
      const lastUser = [...log.events].reverse().findIndex((e) => e.type === "user/message");
      upTo = lastUser < 0 ? log.events.length : log.events.length - 1 - lastUser;
      if (upTo < 1) return c.faint("nothing to fork yet");
    }
    const r = forkSession(log.events, upTo, deps.sessionsDir ?? SESSIONS_DIR);
    return `${c.jin(`◇ forked: first ${r.events} events → ${r.file}`)}\n${c.faint(`  pnpm tui -- --resume ${r.file}   continues from there; this session is untouched`)}`;
  }

  function switchModel(arg: string): void {
    if (!deps.settings) {
      note(c.zhu("settings interface not configured"));
      return;
    }
    const models = deps.settings.listModels();
    if (!arg) {
      note(
        `${c.soft("current")} ${c.ink(`${info.providerName}/${info.model}`)}\n${models
          .map((m) =>
            m === `${info.providerName}/${info.model}` ? c.jin(`  ▸ ${m}`) : c.faint(`    ${m}`),
          )
          .join("\n")}\n${c.faint("Usage: /model provider/model")}`,
      );
      return;
    }
    if (agent.running) {
      note(c.zhu("cannot switch models while running; press Esc first"));
      return;
    }
    try {
      const choice = deps.settings.switchModel(arg);
      agent.setProvider(choice.provider);
      info = { ...info, model: choice.model, providerName: choice.providerName };
      effortLevels = choice.effortLevels;
      contextWindow = choice.contextWindow;
      compaction.window = choice.contextWindow;
      updateHeader();
      updateStatus();
    } catch (err) {
      note(c.zhu(`✗ ${(err as Error).message}`));
    }
  }

  /** 强度级别(Q52):缺省不传;设了就记进每条 request 事件,下一请求生效。 */
  function setEffort(arg: string): void {
    if (!arg) {
      const rows = EFFORT_LEVELS.map((l) => {
        const current = l === agent.effort;
        const unsupported = effortLevels && !effortLevels.includes(l);
        return `  ${current ? c.jin("▸") : " "} ${current ? c.jin(l) : c.soft(l)}${unsupported ? c.faint("  not declared by this model; clamped down when sending") : ""}`;
      });
      note(
        `${c.soft("Effort")} ${c.ink(agent.effort ?? "not set (omitted; provider default)")}\n${rows.join("\n")}\n${c.faint("Usage: /effort <level>; /effort auto omits it again")}`,
      );
      return;
    }
    if (arg === "auto") {
      agent.setEffort(undefined);
      note(c.jin("◇ effort omitted again"));
      updateStatus();
      return;
    }
    const level = parseEffort(arg);
    if (!level) {
      note(c.zhu(`unknown level "${arg}"`) + c.faint(`  options: ${EFFORT_LEVELS.join(" ")} auto`));
      return;
    }
    agent.setEffort(level);
    const clamped =
      effortLevels && !effortLevels.includes(level)
        ? c.faint(`  this model declares ${effortLevels.join("/")}; clamped down when sending`)
        : "";
    note(c.jin(`◇ effort set to ${level}; applies from the next request`) + clamped);
    updateStatus();
  }

  /** 向供应商查当前模型列表(Q59):配置里有、服务器没有的标出来,发现下线不靠猜。 */
  async function listRemoteModels(): Promise<void> {
    const p = agent.provider;
    if (!p.listModels) {
      note(c.zhu("this provider cannot list models"));
      return;
    }
    showLoader("listing models");
    try {
      const remote = await p.listModels();
      const prefix = `${info.providerName}/`;
      const configured = (deps.settings?.listModels() ?? [])
        .filter((m) => m.startsWith(prefix))
        .map((m) => m.slice(prefix.length));
      const lines = [
        `${c.soft("provider")} ${c.ink(info.providerName)}  ${c.faint(`server ${remote.length} models · configured ${configured.length}`)}`,
      ];
      for (const m of configured) {
        lines.push(
          remote.includes(m)
            ? `  ${c.green("✓")} ${c.ink(m)}`
            : `  ${c.zhu("✗")} ${c.ink(m)}  ${c.zhu("not on the server; possibly retired")}`,
        );
      }
      const extra = remote.filter((m) => !configured.includes(m));
      if (extra.length > 0) {
        lines.push(c.faint("  on the server, not in config:"));
        for (const m of extra) lines.push(c.faint(`    · ${m}`));
      }
      note(lines.join("\n"));
    } catch (err) {
      note(c.zhu(`✗ listing failed: ${(err as Error).message}`));
    } finally {
      hideLoader();
      updateStatus();
    }
  }

  function setKey(arg: string): void {
    if (!deps.settings) {
      note(c.zhu("settings interface not configured"));
      return;
    }
    const [providerName, ...keyParts] = arg.split(/\s+/);
    const key = keyParts.join("");
    if (!providerName || !key) {
      note(c.faint("Usage: /key provider key   e.g. /key deepseek sk-xxxx"));
      return;
    }
    try {
      deps.settings.setKey(providerName, key);
      note(
        c.jin(`◇ key for ${providerName} written to the config file`) +
          c.faint("  /model to switch to that provider"),
      );
    } catch (err) {
      note(c.zhu(`✗ ${(err as Error).message}`));
    }
  }

  // ---------- 策略槽在会话中切换(Q78):每次切换记 session/slot,下一次 turn 起生效 ----------

  const slotState: Record<string, string> = {
    compaction: deps.compactionName ?? "llm",
    preservation: "keepRecentTokens (min(20000, window/4))",
    execution: deps.slots?.execution ?? "sequential",
    steering: deps.slots?.steering ? "custom" : "step",
    approve: deps.approve ?? "all",
  };
  function recordSlot(slot: string, value: string): void {
    slotState[slot] = value;
    log.append({ type: "session/slot", at: now(), slot, value });
  }

  async function slotCommand(slot: string, arg: string): Promise<string> {
    if (agent.running) return c.zhu("Cannot switch a slot while running; press Esc first.");
    const v = arg.trim();
    const done = (value: string, when = "takes effect from the next turn") =>
      `${c.jin(`◇ ${slot} → ${value}`)}  ${c.faint(when)}`;
    switch (slot) {
      case "compaction": {
        if (!v)
          return c.faint(
            `compaction is ${slotState.compaction}. Usage: /compaction llm|clear|pipeline|./strategy.mjs|off`,
          );
        if (v === "off") {
          compaction.auto = false;
          recordSlot("compaction", "off (auto-compaction disabled; /compact still works)");
          return done("off", "auto-compaction disabled");
        }
        try {
          compaction.strategy = await loadCompactionStrategy(v);
        } catch (err) {
          return c.zhu(`✗ ${(err as Error).message}`);
        }
        compaction.auto = true;
        recordSlot("compaction", v);
        return done(v, "used by the next auto or manual compaction");
      }
      case "preservation": {
        const m = v.match(/^(tokens|ratio)\s+([\d.]+)$/);
        if (!m)
          return c.faint(
            `preservation is ${slotState.preservation}. Usage: /preservation tokens 20000 | ratio 0.3`,
          );
        const n = Number(m[2]);
        if (m[1] === "tokens") compaction.preservation = keepRecentTokens(n);
        else {
          if (n <= 0 || n >= 1) return c.zhu("ratio must be between 0 and 1");
          compaction.preservation = keepRatio(n);
        }
        recordSlot("preservation", `${m[1] === "tokens" ? "keepRecentTokens" : "keepRatio"}(${n})`);
        return done(`${m[1]} ${n}`, "used by the next compaction");
      }
      case "execution": {
        if (v !== "sequential" && v !== "parallel")
          return c.faint(
            `execution is ${slotState.execution}. Usage: /execution sequential|parallel`,
          );
        agent.setSlot("execution", v);
        recordSlot("execution", v);
        return done(v);
      }
      case "steering": {
        if (v !== "step" && v !== "turn")
          return c.faint(
            `steering is ${slotState.steering}. Usage: /steering step|turn  (step = inject queued messages at the next step; turn = only when the model stops calling tools)`,
          );
        agent.setSlot("steering", v === "step" ? steer : queueToTurnEnd);
        recordSlot("steering", v);
        return done(v);
      }
      case "approve": {
        if (v !== "all" && v !== "ask")
          return c.faint(`approve is ${slotState.approve}. Usage: /approve all|ask`);
        agent.setSlot("approve", v === "ask" ? askApproval : allowAll);
        recordSlot("approve", v);
        return done(v);
      }
      default:
        return c.zhu(`unknown slot ${slot}`);
    }
  }

  /** /tools:随请求发出的每个工具定义:名字、定义占的 token、并行安全、描述首行。 */
  function toolsList(): string {
    const total = tools.reduce(
      (s, t) => s + Math.ceil(JSON.stringify(defs().find((d) => d.name === t.name)).length / 4),
      0,
    );
    const rows = tools.map((t) => {
      const def = defs().find((d) => d.name === t.name);
      const tok = Math.ceil(JSON.stringify(def).length / 4);
      const params = Object.keys(
        (t.parameters as { properties?: Record<string, unknown> }).properties ?? {},
      );
      return `  ${c.jin(t.name.padEnd(10))} ${c.soft(String(tok).padStart(5))} ${c.faint("tok")}  ${c.faint((t.concurrency === "parallel" ? "parallel" : "sequential").padEnd(10))} ${c.ink(t.description.split("\n")[0]?.slice(0, 70) ?? "")}\n${" ".repeat(13)}${c.faint(`params: ${params.join(", ") || "(none)"}`)}`;
    });
    return [
      `${c.soft("Tools")} ${c.ink(`${tools.length}`)}  ${c.faint(`≈${total} tok of definitions sent with every request · full JSON in Ctrl+R → tool definitions`)}`,
      ...rows,
    ].join("\n");
  }

  /** /skills:每个技能的来源、描述占的 token、能否被模型调用、免审批工具。 */
  function skillsList(): string {
    if (skills.length === 0) {
      return c.faint(
        "No skills. Put <name>/SKILL.md under ~/.clari/skills, ~/.claude/skills, <repo>/.agents/skills or <repo>/.claude/skills.",
      );
    }
    const rows = skills.map((s) => {
      const desc = Math.ceil(s.description.length / 4);
      const body = Math.ceil(s.body.length / 4);
      const flags = [
        s.disableModelInvocation ? "user-only" : "model + user",
        ...(s.allowedTools.length ? [`allowed-tools: ${s.allowedTools.join(" ")}`] : []),
        ...(s.argumentHint ? [`args: ${s.argumentHint}`] : []),
      ].join(" · ");
      return `  ${c.jin(`/${s.name}`.padEnd(16))} ${c.ink(s.description || "(no description)")}\n${" ".repeat(19)}${c.faint(`${s.path} · listing ${desc} tok · body ${body} tok · ${flags}`)}`;
    });
    return [
      `${c.soft("Skills")} ${c.ink(`${skills.length}`)}  ${c.faint("/<name> args to run one now; the model picks from the system prompt list (or the skill tool when skills.load = tool)")}`,
      ...rows,
    ].join("\n");
  }

  /** /slots:当前每个槽的实现。全部是可切换的;切换记事件。 */
  function slotsList(): string {
    const rows = Object.entries(slotState).map(
      ([k, val]) => `  ${c.jin(k.padEnd(13))} ${c.ink(val)}`,
    );
    return [
      `${c.soft("Slots")}  ${c.faint("switch with /compaction /preservation /execution /steering /approve; each switch is a session/slot event")}`,
      ...rows,
      `  ${c.jin("termination".padEnd(13))} ${c.ink(deps.slots?.termination ? "custom" : "untilIdle")}  ${c.faint("(--max-steps N at startup)")}`,
    ].join("\n");
  }

  async function manualCompact(instructions: string): Promise<void> {
    showLoader("compacting");
    try {
      const payload = await compaction.strategy({
        events: log.events,
        window: contextWindow,
        targetTokens: threshold(),
        provider: recordingProvider(log, agent.provider, { threshold: threshold(), onRaw }),
        ...(instructions && { instructions }),
      });
      if (!payload) note(c.faint("compaction skipped: nothing to do or not enough progress"));
      else log.append({ type: "compaction", at: now(), ...payload });
    } catch (err) {
      note(c.zhu(`✗ compaction failed: ${(err as Error).message}`));
    } finally {
      hideLoader();
      updateStatus();
    }
  }

  /** /fields:当前适配器的三张字段表。数据是适配器自己维护的静态清单,与代码同步。 */
  function renderFields(): string {
    const f = agent.provider.fields;
    if (!f) return c.faint("this provider has no field table");
    const block = (title: string, rows: string[]) => [
      c.jin(title),
      ...rows.map((r) => `  ${c.soft("·")} ${c.ink(r)}`),
    ];
    return [
      `${c.soft("protocol")} ${c.ink(f.protocol)}  ${c.faint(`model ${info.model} · byte-exact body in Ctrl+R → wire JSON`)}`,
      ...block("sends", f.sends),
      ...block("reads", f.reads),
      ...block("known but ignored", f.ignores),
    ].join("\n");
  }

  /** /prompt:系统提示词的段构成与位置(Q66)。数据来自 session/start,与模型看到的同源。 */
  function renderPrompt(): string {
    const start = log.events.find((e) => e.type === "session/start");
    if (start?.type !== "session/start") return c.faint("no session yet");
    const sections = start.sections ?? [];
    const total = sections.reduce((n, s) => n + s.chars, 0);
    const lines = [
      `${c.soft("System prompt")}  ${c.ink(`${sections.length} sections · ≈${Math.ceil(start.system.length / 4)} tok`)}`,
    ];
    for (const s of sections) {
      lines.push(
        `  ${c.jin(s.name.padEnd(8))} ${c.soft(`${String(Math.ceil(s.chars / 4)).padStart(6)} tok · ${pct(total > 0 ? s.chars / total : 0).padStart(4)}`)}${s.source ? c.faint(`  ${s.source}`) : ""}`,
      );
    }
    const preamble = log.events[1];
    if (
      preamble?.type === "user/message" &&
      start.sections?.every((s) => !/instruction|指令/i.test(s.name))
    ) {
      lines.push(
        c.faint(
          "  project instructions and memory are in the first user message (--instructions-as user); see the first › line above",
        ),
      );
    }
    lines.push(
      c.faint(
        `  memory: ${deps.memory ? "on (remember tool available)" : "off (--memory enables it; the memory section of AGENTS.md is not injected)"}  · full text in Ctrl+R → sent`,
      ),
    );
    return lines.join("\n");
  }

  /** /memory:列出、删一条、清空。记忆就是 AGENTS.md 里的一节,这里只是它的编辑入口。 */
  function memoryCommand(arg: string): string {
    if (!deps.memory)
      return c.faint("memory is off. Start with --memory or set prompt.memory: true");
    const files = [deps.memory.project, deps.memory.user].filter((f): f is string => !!f);
    const all = files.flatMap((file) =>
      (existsSync(file) ? memoryEntries(readFileSync(file, "utf8")) : []).map((text, i) => ({
        file,
        i: i + 1,
        text,
      })),
    );
    const [sub, ...restArgs] = arg.split(/\s+/).filter(Boolean);
    if (sub === "clear") {
      const n = files.reduce((acc, f) => acc + clearMemory(f), 0);
      return c.jin(`◇ cleared ${n} memories`);
    }
    if (sub === "forget") {
      const idx = Number(restArgs[0]);
      const target = all[idx - 1];
      if (!target) return c.zhu(`no entry ${restArgs[0] ?? "?"} (${all.length} total)`);
      const removed = forgetMemory(target.file, target.i);
      return c.jin(`◇ removed: ${removed}`);
    }
    if (all.length === 0) return c.faint(`no memories. files: ${files.join(", ")}`);
    const lines = [
      `${c.soft("Memory")} ${c.ink(`${all.length} entries`)}  ${c.faint("injected at the start of the next session · /memory forget N removes one")}`,
    ];
    all.forEach((m, k) => {
      lines.push(`  ${c.jin(String(k + 1).padStart(2))} ${c.ink(m.text)}  ${c.faint(m.file)}`);
    });
    return lines.join("\n");
  }

  function renderContext(): string {
    const b = contextBreakdown(log.events, contextWindow);
    const lines = [
      `${c.soft("Context")}  ${c.ink(`estimated ${b.estimatedTokens} tok`)} ${c.faint(`/ window ${b.window} · ${pct(b.usedShare)}`)}`,
    ];
    if (b.measuredTokens !== undefined)
      lines.push(c.faint(`last request measured ${b.measuredTokens} tok in`));
    const totals = usageTotals(log.events, priceFor);
    if (totals.requests > 0) {
      lines.push(
        c.faint(
          `session total: ${totals.requests} requests · in ${totals.inputTokens} · out ${totals.outputTokens} · cache read ${totals.cacheReadTokens} · cache write ${totals.cacheWriteTokens}${totals.cost !== undefined ? ` · cost ${fmtCost(totals.cost)}` : " · no price configured (models[].price)"}`,
        ),
      );
    }
    for (const p of b.parts) {
      const bar = "█".repeat(Math.max(1, Math.round(p.share * 24))).padEnd(24);
      lines.push(
        `${c.jin(bar)} ${pct(p.share).padStart(4)}  ${c.soft(`${p.tokens} tok · ${p.count} · ${p.label}`)}`,
      );
    }
    // 系统提示词按段拆开(Q51):角色、环境、项目指令各占多少,一眼可见。
    const start = log.events.find((e) => e.type === "session/start");
    const sections = start?.type === "session/start" ? start.sections : undefined;
    if (sections && sections.length > 0) {
      const total = sections.reduce((n, s) => n + s.chars, 0);
      lines.push(c.soft("System prompt sections"));
      for (const s of sections) {
        const tok = Math.ceil(s.chars / 4);
        lines.push(
          c.faint(
            `  ├ ${s.name.padEnd(8)} ${String(tok).padStart(6)} tok · ${pct(total > 0 ? s.chars / total : 0).padStart(4)}${s.source ? `  ${s.source}` : ""}`,
          ),
        );
      }
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
    if (matchesKey(data, Key.ctrl("e"))) {
      // Ctrl+E:组装视图(Q81),模型下一步会看到的每条消息从哪来、落在线路的第几条。
      if (!overlay) openInspector();
      inspector.showComposition();
      tui.requestRender();
      return { consume: true };
    }
    if (overlay || approval) return undefined; // 检视器或审批提示打开时,其余按键归它们
    if (data === "?" && editor.getText() === "") {
      note(shortcutLines().join("\n"));
      return { consume: true };
    }
    if (matchesKey(data, Key.alt("enter"))) {
      // 后续留言:不打断当前步,等模型不再调工具时才给它。空闲时与普通提交等价。
      const text = editor.getText().trim();
      if (!text) return { consume: true };
      editor.setText("");
      editor.addToHistory(text);
      if (text.startsWith("/")) void command(text);
      else void submit(text, { deliverAs: "followUp" });
      return { consume: true };
    }
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
    for (const v of childViews) v.dispose();
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
      openEvents: () => {
        openInspector();
        inspector.showEvents();
      },
      openCompactions: () => {
        openInspector();
        inspector.showCompactions();
      },
      openComposition: () => {
        openInspector();
        inspector.showComposition();
      },
      close: closeInspector,
      isOpen: () => overlay !== undefined,
      key: (data) => inspector.handleInput(data),
      lines: (width = deps.terminal.columns) => (overlay ? inspector.render(width) : []),
    },
    attachChild,
    children: () => childViews.map((v) => v.info),
    approvalLines: () => approvalPrompt?.render() ?? [],
    toggleFold,
    toggleReasoning,
    stop,
  };
}

/** 审批提示(Q64):一行问题、一行按键说明;y / n / a,Esc 视为拒绝。 */
class ApprovalPrompt implements Component {
  constructor(
    private readonly call: ToolCall,
    private readonly onDecide: (d: "y" | "n" | "a") => void,
  ) {}

  render(): string[] {
    return [
      `${c.zhu("?")} ${c.bold(c.ink("run"))} ${c.bold(c.ink(this.call.name))}  ${c.soft(formatArgs(this.call.args))}`,
      c.faint(`  y allow · n deny · a always allow ${this.call.name} this session · Esc deny`),
    ];
  }

  handleInput(data: string): void {
    if (data === "y" || data === "Y") this.onDecide("y");
    else if (data === "a" || data === "A") this.onDecide("a");
    else if (data === "n" || data === "N" || matchesKey(data, Key.escape)) this.onDecide("n");
  }

  invalidate(): void {}
}

/** 子 agent 事件的屏幕行(不含引导线),与主屏同一套记号:› ⚙ ✓ ✗ ◇。 */
export function childEventLines(e: AgentEvent): string[] {
  switch (e.type) {
    case "user/message":
      return [`${c.zhu("›")} ${c.ink(e.text)}`];
    case "assistant/message": {
      const lines: string[] = [];
      if (e.reasoning)
        lines.push(
          ...e.reasoning
            .trim()
            .split("\n")
            .map((l) => c.faint(c.italic(l))),
        );
      if (e.text)
        lines.push(
          ...e.text
            .trim()
            .split("\n")
            .map((l) => c.ink(l)),
        );
      for (const tc of e.toolCalls) {
        lines.push(`${c.zhu("⚙")} ${c.bold(c.ink(tc.name))}  ${c.soft(formatArgs(tc.args))}`);
      }
      if (e.stopReason === "aborted") lines.push(c.faint("— interrupted —"));
      return lines;
    }
    case "tool/result": {
      const mark = e.isError ? c.zhu("✗") : c.green("✓");
      const body = e.content.trim().split("\n");
      const meta = [
        ...(body.length > 1 ? [`${body.length} lines`] : []),
        ...(e.durationMs !== undefined ? [fmtMs(e.durationMs)] : []),
      ];
      return [
        `${mark} ${c.soft(e.name)}${meta.length ? c.faint(`  ${meta.join(" · ")}`) : ""}`,
        ...body.map((l) => (e.isError ? c.soft(`  ${l}`) : c.faint(`  ${l}`))),
      ];
    }
    case "retry":
      return [c.faint(`· retry ${e.attempt}: ${e.status ?? ""} ${e.error.split("\n")[0]}`)];
    case "request/error":
      return [c.zhu(`✗ request failed: ${e.error.split("\n")[0]}`)];
    case "compaction":
      return [c.jin(`◇ compacted${e.strategy ? ` (${e.strategy})` : ""}`)];
    default:
      return [];
  }
}

/** 任务简报的一句话形态,给会话选择器与标题用。 */
function brief(task: string): string {
  const first = task.split("\n")[0]?.trim() ?? "";
  return first.length > 24 ? `${first.slice(0, 24)}…` : first;
}

/** 工具参数的人读形态:命令与路径直接展示,其余压成紧凑 JSON。 */
function formatArgs(args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  let s: string;
  if (typeof a.command === "string") s = a.command;
  else if (typeof a.path === "string") {
    const range =
      typeof a.offset === "number" || typeof a.limit === "number"
        ? `  from line ${a.offset ?? 1}${typeof a.limit === "number" ? `, ${a.limit} lines` : ""}`
        : "";
    s = `${a.path}${range}`;
  } else if (typeof a.task === "string") {
    s = `${a.scope ? `scope=${a.scope}  ` : ""}${brief(a.task)}`;
  } else s = JSON.stringify(args) ?? "";
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** 最多展示的改动行数;超出的折成一行计数。 */
const DETAIL_MAX_LINES = 60;

/** edit → 行级 diff(- 朱 / + 绿 / 上下文淡);write → 前几行加总行数。其它工具无详情。 */
export function toolCallDetail(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  let lines: string[] = [];
  if (name === "edit" && typeof a.oldText === "string" && typeof a.newText === "string") {
    lines = hunks(diffLines(a.oldText, a.newText)).map((l) => {
      switch (l.kind) {
        case "-":
          return c.zhu(`- ${l.text}`);
        case "+":
          return c.green(`+ ${l.text}`);
        case "…":
          return c.faint(`  ${l.text}`);
        default:
          return c.faint(`  ${l.text}`);
      }
    });
  } else if (name === "write" && typeof a.content === "string") {
    const all = a.content.split("\n");
    lines = all.slice(0, 12).map((l) => c.green(`+ ${l}`));
    if (all.length > 12) lines.push(c.faint(`… ${all.length} lines total`));
  }
  if (lines.length === 0) return "";
  if (lines.length > DETAIL_MAX_LINES) {
    const rest = lines.length - DETAIL_MAX_LINES;
    lines = [...lines.slice(0, DETAIL_MAX_LINES), c.faint(`… ${rest} more changed lines`)];
  }
  return lines.join("\n");
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}
