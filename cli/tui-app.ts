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
import { contextBreakdown } from "../src/context.js";
import { costOf, fmtCost, type Price, usageTotals } from "../src/cost.js";
import { type AgentEvent, now, type ToolCall } from "../src/events.js";
import type { EventLog } from "../src/log.js";
import { type CompactionConfig, recordingProvider, type TurnDeps } from "../src/loop.js";
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type Provider,
  parseEffort,
  type ToolDef,
} from "../src/provider.js";
import type { ChildInfo } from "../src/subagent.js";
import type { Tool } from "../src/tools.js";
import { expandFileRefs } from "./attachments.js";
import { forkSession, SESSIONS_DIR } from "./bootstrap.js";
import { fmtMs, fmtTok, RequestInspector, type SessionSource } from "./inspector.js";
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
  /** 策略槽实现(执行策略、扩展模块换上的槽等)。approve=ask 时界面的审批实现覆盖这里的 approve。 */
  slots?: TurnDeps["slots"];
  /** 提示词模板:/名 参数 展开成一条用户消息。 */
  templates?: PromptTemplate[];
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
  { name: "inspect", description: "请求检视器:每次 API 请求的发送、接收、决策与写入(Ctrl+R)" },
  { name: "events", description: "事件视图:内核维护的全部事件数组,逐条原样 JSON(检视器内 Tab)" },
  { name: "compactions", description: "压缩对照:每次压缩把哪一大段原文变成了什么摘要" },
  { name: "context", description: "上下文构成:各部分 token 与占比" },
  { name: "prompt", description: "系统提示词由哪几段组成、各占多少、放在哪(Q66)" },
  {
    name: "memory",
    description: "跨会话记忆:/memory 列出;/memory forget N 删一条;/memory clear 清空",
  },
  { name: "compact", description: "手动压缩,可附指示:/compact 保留报错" },
  {
    name: "fork",
    description: "分叉会话:/fork 复制到最后一条用户消息之前;/fork N 复制前 N 条事件到新文件",
  },
  { name: "model", description: "切换模型:/model 供应商/模型;不带参数列出可选" },
  { name: "models", description: "向供应商查询当前可用模型,对照配置标出下线与新增" },
  { name: "effort", description: "强度级别:/effort off|low|medium|high|xhigh|max;auto 恢复不传" },
  { name: "key", description: "设置供应商 key:/key deepseek sk-…(写入配置文件)" },
  { name: "default", description: "把当前模型设为缺省" },
  { name: "stop", description: "打断正在运行的 turn" },
  { name: "help", description: "命令列表" },
  { name: "quit", description: "退出" },
];

/** 引导线:子 agent 的每一行都带它,一眼分清层级;不是框线(Q45)。 */
const GUIDE = `  ${c.faint("┆")} `;

export function createTuiApp(deps: TuiAppDeps): TuiApp {
  const { log, tools, compaction } = deps;
  let info = deps.info;
  let effortLevels = deps.effortLevels;
  let contextWindow = compaction.window;
  const threshold = () => contextWindow - deps.reserveTokens;

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
        ...templates.map((t) => ({ name: t.name, description: `模板:${t.description}` })),
      ],
      process.cwd(),
    ),
  );

  tui.addChild(header);
  tui.addChild(
    new Text(
      c.faint("Esc 打断 · Ctrl+R 检视 · Ctrl+O 折叠 · Ctrl+T 思考 · 运行中输入即插话 · /help"),
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
  let childMode: ChildMode = "tail";
  type ResultRecord = { name: string; content: string; isError: boolean; durationMs?: number };
  const resultNodes: ({ node: Text } & ResultRecord)[] = [];
  const reasoningNodes: { node: Text; text: string }[] = [];

  // 请求层记录(Q48):发出每个请求时用的 provider,以及开 trace 时收到的原始流。都不进日志。
  const providersAt = new Map<number, Provider>();
  const rawAt = new Map<number, string[]>();
  let requestCount = 0;
  let lastRequestIndex = -1;
  let lastRequest: Extract<AgentEvent, { type: "request" }> | undefined;

  // 子 agent(Q62):每个子一个视图块,挂在父会话里对应 task 调用行的下面。
  const childViews: ChildView[] = [];
  const childSlots = new Map<string, Container>();

  // 推理内容不隐藏(Q34):thinking 模型的思考过程以淡字实时呈现。
  const renderReasoning = (s: string) =>
    showReasoning
      ? `${c.faint("思考")}\n${c.faint(c.italic(indent(s.trim())))}`
      : c.faint("思考(已隐藏,Ctrl+T 显示)");

  const onRaw = (line: string): void => {
    if (deps.trace) {
      const bucket = rawAt.get(lastRequestIndex) ?? [];
      bucket.push(line);
      rawAt.set(lastRequestIndex, bucket);
    }
    deps.onRaw?.(lastRequestIndex, line);
  };

  // 审批(Q64):问一次就是一次;a 把该工具加进本会话的放行名单。拒绝以错误结果回喂模型(Q23)。
  const alwaysAllow = new Set<string>();
  let approval: OverlayHandle | undefined;
  let approvalPrompt: ApprovalPrompt | undefined;
  const askApproval = (call: ToolCall): Promise<boolean> => {
    if (alwaysAllow.has(call.name)) return Promise.resolve(true);
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
            ? c.faint(`· 审批:允许 ${call.name}${decision === "a" ? "(本会话不再问)" : ""}`)
            : c.zhu(`· 审批:拒绝 ${call.name}`),
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

  /** 当前模型的价格:配置接口优先,其次启动时带来的。 */
  const priceFor = (model: string): Price | undefined =>
    deps.settings?.priceFor?.(model) ?? (model === info.model ? deps.price : undefined);

  function updateStatus(): void {
    const state = agent.running ? c.zhu("● 运行中") : c.green("○ 空闲");
    const t = threshold();
    let tokens = c.faint("尚无请求");
    if (lastUsage) {
      // 上下文占用条:以自动压缩阈值为满格;过七成转朱色提醒。
      const used = Math.min(1, lastUsage.inputTokens / t);
      const cells = used > 0 ? Math.max(1, Math.round(used * 10)) : 0;
      const bar = "▰".repeat(cells) + "▱".repeat(10 - cells);
      const tone = used >= 0.7 ? c.zhu : c.jin;
      tokens = `${tone(bar)} ${c.faint(`距自动压缩 ${pct(Math.max(0, 1 - used))} · ${lastUsage.inputTokens}→${lastUsage.outputTokens} tok`)}`;
    }
    // 会话累计(含压缩摘要请求):输入、输出、缓存命中、费用。数据全部来自事件数组。
    const totals = usageTotals(log.events, priceFor);
    const sum =
      totals.requests > 0
        ? c.faint(
            ` · 累计 ↑${fmtTok(totals.inputTokens)} ↓${fmtTok(totals.outputTokens)}${totals.cacheReadTokens > 0 ? ` 缓存 ${fmtTok(totals.cacheReadTokens)}` : ""}${totals.cost !== undefined ? ` ${fmtCost(totals.cost)}` : ""}`,
          )
        : "";
    const queued = agent.queued > 0 ? c.faint(` · 留言 ${agent.queued}`) : "";
    const effort = agent.effort ? c.faint(` · 强度 ${agent.effort}`) : "";
    const runningChildren = childViews.filter((v) => v.running).length;
    const kids = runningChildren > 0 ? c.faint(` · 子 ${runningChildren} 运行中`) : "";
    status.setText(`${state}  ${tokens}${sum}${effort}${queued}${kids}`);
    tui.requestRender();
  }

  function note(text: string): void {
    transcript.addChild(new Text(text, 1, 0));
    tui.requestRender();
  }

  /** 工具结果的屏幕文本。折叠只是显示状态,内容原封不动留在节点里。 */
  function resultText(r: ResultRecord): string {
    const mark = r.isError ? c.zhu("✗") : c.green("✓");
    const trimmed = r.content.trim();
    const all = trimmed ? trimmed.split("\n") : [];
    let body: string;
    if (all.length === 0) body = "  (无输出)";
    else if (foldResults && all.length > FOLD_HEAD + 1) {
      body = `${indent(all.slice(0, FOLD_HEAD).join("\n"))}\n${c.soft(`  … 还有 ${all.length - FOLD_HEAD} 行(Ctrl+O 展开)`)}`;
    } else body = indent(trimmed);
    const metaParts = [
      ...(all.length > 1 ? [`${all.length} 行`] : []),
      ...(r.durationMs !== undefined ? [fmtMs(r.durationMs)] : []),
    ];
    const meta = metaParts.length > 0 ? c.faint(`  ${metaParts.join(" · ")}`) : "";
    return `${mark} ${c.soft(r.name)}${meta}\n${r.isError ? c.soft(body) : c.faint(body)}`;
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
        ? `;子 agent ${childMode === "tail" ? "尾窗" : childMode === "all" ? "全部" : "仅进度"}`
        : "";
    note(c.faint(`· 工具结果已${foldResults ? "折叠(Ctrl+O 展开)" : "展开"}${kids}`));
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
    // 缓存命中率 = 命中 / 全部输入;前缀没变就该接近 100%,骤降说明前缀被改动了。
    const hit =
      u?.cacheReadTokens !== undefined && u.inputTokens > 0
        ? `(缓存 ${fmtTok(u.cacheReadTokens)} · ${Math.round((u.cacheReadTokens / u.inputTokens) * 100)}%)`
        : "";
    const measured = u
      ? `→ 实测 ${fmtTok(u.inputTokens)}${hit} · +${fmtTok(u.outputTokens)}`
      : "→ 无用量";
    const price = u ? priceFor(lastRequest.model) : undefined;
    const cost = u && price ? ` · ${fmtCost(costOf(u, price))}` : "";
    return c.faint(
      `· #${requestCount}  ${lastRequest.messages} 条消息 ≈${fmtTok(lastRequest.estimatedTokens)} ${measured}${cost} · ${fmtMs(e.latencyMs)} · ${e.stopReason}`,
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
      const stats = `第 ${this.steps} 步 · ${this.toolsUsed} 次工具 · ${elapsed}${this.tokens ? ` · ${fmtTok(this.tokens)} tok` : ""}`;
      const head = this.running
        ? `${c.zhu("●")} ${c.soft(`运行中 · ${stats}`)}`
        : this.ok
          ? `${c.green("✓")} ${c.soft(`完成 · ${stats}`)}`
          : `${c.zhu("✗")} ${c.soft(`部分完成 · ${stats}`)}`;
      this.progress.setText(GUIDE + head);
      let body: string;
      if (childMode === "progress" || (!this.running && childMode !== "all")) {
        body =
          GUIDE +
          c.faint(
            `子会话 ${this.lines.length} 行 · Ctrl+O 展开${this.info.log.path ? ` · ${this.info.log.path}` : ""}`,
          );
      } else if (childMode === "all") {
        body = this.lines.length > 0 ? this.lines.join("\n") : GUIDE + c.faint("(尚无输出)");
      } else {
        const tail = this.lines.slice(-CHILD_TAIL);
        const more =
          this.lines.length > CHILD_TAIL
            ? [GUIDE + c.faint(`… 子会话共 ${this.lines.length} 行,Ctrl+O 展开全部`)]
            : [];
        body = [...tail, ...more].join("\n") || GUIDE + c.faint("(尚无输出)");
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
    { name: "主会话", events: log.events },
    ...childViews.map((v) => ({
      name: `子 #${v.info.index} ${brief(v.info.task)}`,
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
        if (e.usage) lastUsage = e.usage;
        // 每步一行请求小结(Q48):紧跟响应正文,放在工具调用之前,让"调用 → 结果"连在一起。
        const summary = requestSummary(e);
        if (summary) note(summary);
        if (e.toolCalls.length > 0) transcript.addChild(new Spacer(1));
        for (const tc of e.toolCalls) {
          transcript.addChild(
            new Text(
              `${c.zhu("⚙")} ${c.bold(c.ink(tc.name))}  ${c.soft(formatArgs(tc.args))}`,
              1,
              0,
            ),
          );
          // edit/write 的改动内容直接可见(Q58):diff 从参数算出,不进日志。
          const detail = toolCallDetail(tc.name, tc.args);
          if (detail) transcript.addChild(new Text(detail, 1, 0));
          // task 调用行下面留一个槽,子 agent 开跑时把它的块挂进来(Q62)。
          if (tc.name === "task") {
            const slot = new Container();
            childSlots.set(tc.id, slot);
            transcript.addChild(slot);
          }
        }
        if (e.stopReason === "aborted") note(c.faint("— 已打断 —"));
        if (e.stopReason === "length") note(c.jin("◇ 输出被截断,已要求模型重发"));
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
        if (e.slot === "execution")
          note(c.faint(`· 并行执行 ${e.parallel} 个调用:${e.tools.join(", ")}`));
        break;
      case "request/error":
        // 循环随后抛出,submit 的 catch 负责呈现,这里不重复。
        break;
      case "compaction": {
        const parts: string[] = [];
        if (e.summary !== undefined)
          parts.push(`摘要覆盖事件 ${e.coversFrom ?? 1}-${e.coversUpTo}`);
        if (e.cleared?.length) parts.push(`清除 ${e.cleared.length} 条工具结果`);
        const cost = e.usage
          ? `  摘要请求 #${requestCount} · ${fmtTok(e.usage.inputTokens)}→${fmtTok(e.usage.outputTokens)} tok · ${fmtMs(e.latencyMs)}`
          : "";
        const who = e.strategy ? `(${e.strategy})` : "";
        note(
          `${c.jin(`◇ 已压缩${who}:${parts.join(",")}`)}${c.faint(`${cost}  /compactions 看原文与摘要对照`)}`,
        );
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

  if (log.events.length > 0) {
    // 日志已有内容(入口落过 session/start,或恢复的会话):屏幕即历史,
    // 用同一个渲染函数把已有事件过一遍,历史与新事件长得一样(Q54)。
    for (const e of log.events) render(e);
    log.subscribe(render);
    if (log.events.length > 1) {
      note(c.jin(`◇ 已恢复会话:${log.events.length} 条事件,继续写入 ${info.sessionFile}`));
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
  updateHeader();
  updateStatus();

  // ---------- 输入 ----------

  async function submit(raw: string, opts: { deliverAs?: DeliverAs } = {}): Promise<void> {
    // @路径 展开成消息里的 <file> 块:附上的就是发出的,落盘上屏都完整。
    const expanded = expandFileRefs(raw);
    for (const a of expanded.attachments) {
      note(
        a.skipped
          ? c.zhu(`· @${a.ref}:${a.skipped}`)
          : c.faint(`· 附上 @${a.ref}(${a.bytes} 字节)`),
      );
    }
    const text = expanded.text;
    if (agent.running) {
      void agent.prompt(text, opts);
      note(
        c.faint(
          opts.deliverAs === "followUp"
            ? "· 已排入后续留言:模型做完手头的事再给它"
            : "· 已排入插话:下一个步边界注入",
        ),
      );
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
          [
            ...COMMANDS.map((x) => `${c.jin(`/${x.name}`.padEnd(12))} ${c.soft(x.description)}`),
            ...templates.map(
              (t) => `${c.jin(`/${t.name}`.padEnd(12))} ${c.soft(`模板:${t.description}`)}`,
            ),
            c.faint("Alt+Enter 排入后续留言(模型做完再给);@路径 把文件附进消息"),
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
      case "model":
        switchModel(arg);
        break;
      case "models":
        await listRemoteModels();
        break;
      case "effort":
        setEffort(arg);
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
      default: {
        // 提示词模板:/名 参数 → 展开成一条普通用户消息提交。
        const t = templates.find((x) => x.name === cmd);
        if (t) {
          note(c.faint(`· 模板 /${t.name}  ${t.path}`));
          await submit(expandTemplate(t, arg));
          break;
        }
        note(c.zhu(`未知命令 /${cmd}`) + c.faint("  /help 查看命令"));
      }
    }
  }

  /** /fork:复制事件前缀到新文件。事件即真相,分叉就是复制前缀,原文件不动。 */
  function forkCommand(arg: string): string {
    let upTo: number;
    if (arg) {
      upTo = Number(arg);
      if (!Number.isInteger(upTo) || upTo < 1) return c.zhu("用法:/fork 或 /fork N(前 N 条事件)");
    } else {
      const lastUser = [...log.events].reverse().findIndex((e) => e.type === "user/message");
      upTo = lastUser < 0 ? log.events.length : log.events.length - 1 - lastUser;
      if (upTo < 1) return c.faint("还没有可分叉的历史");
    }
    const r = forkSession(log.events, upTo, deps.sessionsDir ?? SESSIONS_DIR);
    return `${c.jin(`◇ 已分叉:前 ${r.events} 条事件 → ${r.file}`)}\n${c.faint(`  pnpm tui -- --resume ${r.file}   从那个时点继续;当前会话不受影响`)}`;
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
        return `  ${current ? c.jin("▸") : " "} ${current ? c.jin(l) : c.soft(l)}${unsupported ? c.faint("  该模型未声明支持,发送时向下回退") : ""}`;
      });
      note(
        `${c.soft("强度级别")} ${c.ink(agent.effort ?? "未设置(不传,用供应商默认)")}\n${rows.join("\n")}\n${c.faint("用法:/effort <级别>;/effort auto 恢复不传")}`,
      );
      return;
    }
    if (arg === "auto") {
      agent.setEffort(undefined);
      note(c.jin("◇ 强度已恢复为不传"));
      updateStatus();
      return;
    }
    const level = parseEffort(arg);
    if (!level) {
      note(c.zhu(`未知级别 "${arg}"`) + c.faint(`  可选:${EFFORT_LEVELS.join(" ")} auto`));
      return;
    }
    agent.setEffort(level);
    const clamped =
      effortLevels && !effortLevels.includes(level)
        ? c.faint(`  当前模型声明支持 ${effortLevels.join("/")},发送时向下回退`)
        : "";
    note(c.jin(`◇ 强度已设为 ${level},下一请求生效`) + clamped);
    updateStatus();
  }

  /** 向供应商查当前模型列表(Q59):配置里有、服务器没有的标出来,发现下线不靠猜。 */
  async function listRemoteModels(): Promise<void> {
    const p = agent.provider;
    if (!p.listModels) {
      note(c.zhu("当前 provider 不支持查询模型列表"));
      return;
    }
    showLoader("查询模型列表");
    try {
      const remote = await p.listModels();
      const prefix = `${info.providerName}/`;
      const configured = (deps.settings?.listModels() ?? [])
        .filter((m) => m.startsWith(prefix))
        .map((m) => m.slice(prefix.length));
      const lines = [
        `${c.soft("供应商")} ${c.ink(info.providerName)}  ${c.faint(`服务器 ${remote.length} 个模型 · 配置 ${configured.length} 个`)}`,
      ];
      for (const m of configured) {
        lines.push(
          remote.includes(m)
            ? `  ${c.green("✓")} ${c.ink(m)}`
            : `  ${c.zhu("✗")} ${c.ink(m)}  ${c.zhu("服务器无此模型,可能已下线")}`,
        );
      }
      const extra = remote.filter((m) => !configured.includes(m));
      if (extra.length > 0) {
        lines.push(c.faint("  服务器有、配置里没有:"));
        for (const m of extra) lines.push(c.faint(`    · ${m}`));
      }
      note(lines.join("\n"));
    } catch (err) {
      note(c.zhu(`✗ 查询失败:${(err as Error).message}`));
    } finally {
      hideLoader();
      updateStatus();
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
        provider: recordingProvider(log, agent.provider, { threshold: threshold(), onRaw }),
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

  /** /prompt:系统提示词的段构成与位置(Q66)。数据来自 session/start,与模型看到的同源。 */
  function renderPrompt(): string {
    const start = log.events.find((e) => e.type === "session/start");
    if (start?.type !== "session/start") return c.faint("尚无会话");
    const sections = start.sections ?? [];
    const total = sections.reduce((n, s) => n + s.chars, 0);
    const lines = [
      `${c.soft("系统提示词")}  ${c.ink(`${sections.length} 段 · 约 ${Math.ceil(start.system.length / 4)} tok`)}`,
    ];
    for (const s of sections) {
      lines.push(
        `  ${c.jin(s.name.padEnd(8))} ${c.soft(`${String(Math.ceil(s.chars / 4)).padStart(6)} tok · ${pct(total > 0 ? s.chars / total : 0).padStart(4)}`)}${s.source ? c.faint(`  ${s.source}`) : ""}`,
      );
    }
    const preamble = log.events[1];
    if (preamble?.type === "user/message" && start.sections?.every((s) => s.name !== "项目指令")) {
      lines.push(
        c.faint("  项目指令与记忆放在首条 user 消息里(--instructions-as user),见上方第一条 › 行"),
      );
    }
    lines.push(
      c.faint(
        `  记忆:${deps.memory ? "已打开(remember 工具可用)" : "关(--memory 打开;AGENTS.md 里的记忆节不会注入)"}  · 全文见 Ctrl+R → 发送分区`,
      ),
    );
    return lines.join("\n");
  }

  /** /memory:列出、删一条、清空。记忆就是 AGENTS.md 里的一节,这里只是它的编辑入口。 */
  function memoryCommand(arg: string): string {
    if (!deps.memory) return c.faint("记忆未打开。启动加 --memory,或配置 prompt.memory: true");
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
      return c.jin(`◇ 已清空 ${n} 条记忆`);
    }
    if (sub === "forget") {
      const idx = Number(restArgs[0]);
      const target = all[idx - 1];
      if (!target) return c.zhu(`没有第 ${restArgs[0] ?? "?"} 条(共 ${all.length} 条)`);
      const removed = forgetMemory(target.file, target.i);
      return c.jin(`◇ 已删除:${removed}`);
    }
    if (all.length === 0) return c.faint(`没有记忆。文件:${files.join(", ")}`);
    const lines = [
      `${c.soft("记忆")} ${c.ink(`${all.length} 条`)}  ${c.faint("下次会话开始时注入;/memory forget N 删除")}`,
    ];
    all.forEach((m, k) => {
      lines.push(`  ${c.jin(String(k + 1).padStart(2))} ${c.ink(m.text)}  ${c.faint(m.file)}`);
    });
    return lines.join("\n");
  }

  function renderContext(): string {
    const b = contextBreakdown(log.events, contextWindow);
    const lines = [
      `${c.soft("上下文构成")}  ${c.ink(`估算 ${b.estimatedTokens} tok`)} ${c.faint(`/ 窗口 ${b.window},占 ${pct(b.usedShare)}`)}`,
    ];
    if (b.measuredTokens !== undefined)
      lines.push(c.faint(`上次请求实测输入 ${b.measuredTokens} tok`));
    const totals = usageTotals(log.events, priceFor);
    if (totals.requests > 0) {
      lines.push(
        c.faint(
          `会话累计 ${totals.requests} 次请求 · 输入 ${totals.inputTokens} · 输出 ${totals.outputTokens} · 缓存命中 ${totals.cacheReadTokens} · 缓存写入 ${totals.cacheWriteTokens}${totals.cost !== undefined ? ` · 费用 ${fmtCost(totals.cost)}` : " · 未配置价格(config 里 models[].price)"}`,
        ),
      );
    }
    for (const p of b.parts) {
      const bar = "█".repeat(Math.max(1, Math.round(p.share * 24))).padEnd(24);
      lines.push(
        `${c.jin(bar)} ${pct(p.share).padStart(4)}  ${c.soft(`${p.tokens} tok · ${p.count} 条 · ${p.label}`)}`,
      );
    }
    // 系统提示词按段拆开(Q51):角色、环境、项目指令各占多少,一眼可见。
    const start = log.events.find((e) => e.type === "session/start");
    const sections = start?.type === "session/start" ? start.sections : undefined;
    if (sections && sections.length > 0) {
      const total = sections.reduce((n, s) => n + s.chars, 0);
      lines.push(c.soft("系统提示词构成"));
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
    if (overlay || approval) return undefined; // 检视器或审批提示打开时,其余按键归它们
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
      `${c.zhu("?")} ${c.bold(c.ink("执行"))} ${c.bold(c.ink(this.call.name))}  ${c.soft(formatArgs(this.call.args))}`,
      c.faint(`  y 允许 · n 拒绝 · a 本会话总是允许 ${this.call.name} · Esc 拒绝`),
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
      if (e.stopReason === "aborted") lines.push(c.faint("— 已打断 —"));
      return lines;
    }
    case "tool/result": {
      const mark = e.isError ? c.zhu("✗") : c.green("✓");
      const body = e.content.trim().split("\n");
      const meta = [
        ...(body.length > 1 ? [`${body.length} 行`] : []),
        ...(e.durationMs !== undefined ? [fmtMs(e.durationMs)] : []),
      ];
      return [
        `${mark} ${c.soft(e.name)}${meta.length ? c.faint(`  ${meta.join(" · ")}`) : ""}`,
        ...body.map((l) => (e.isError ? c.soft(`  ${l}`) : c.faint(`  ${l}`))),
      ];
    }
    case "retry":
      return [c.faint(`· 重试 ${e.attempt}:${e.status ?? ""} ${e.error.split("\n")[0]}`)];
    case "request/error":
      return [c.zhu(`✗ 请求失败:${e.error.split("\n")[0]}`)];
    case "compaction":
      return [c.jin(`◇ 已压缩${e.strategy ? `(${e.strategy})` : ""}`)];
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
        ? `  第 ${a.offset ?? 1} 行起${typeof a.limit === "number" ? `,${a.limit} 行` : ""}`
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
          return c.zhu(`  - ${l.text}`);
        case "+":
          return c.green(`  + ${l.text}`);
        case "…":
          return c.faint(`    ${l.text}`);
        default:
          return c.faint(`    ${l.text}`);
      }
    });
  } else if (name === "write" && typeof a.content === "string") {
    const all = a.content.split("\n");
    lines = all.slice(0, 12).map((l) => c.green(`  + ${l}`));
    if (all.length > 12) lines.push(c.faint(`    … 共 ${all.length} 行`));
  }
  if (lines.length === 0) return "";
  if (lines.length > DETAIL_MAX_LINES) {
    const rest = lines.length - DETAIL_MAX_LINES;
    lines = [...lines.slice(0, DETAIL_MAX_LINES), c.faint(`    … 还有 ${rest} 行改动`)];
  }
  return lines.join("\n");
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
