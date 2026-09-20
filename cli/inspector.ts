// 检视器:对事件数组的几种投影,全部只读(上下文工作台的动作交回界面层落成事件)。
//   请求视图  一行一请求 → 七分区(概要 / 决策 / 发送 / 工具定义 / 线路 JSON / 接收 / 写入)   inspector-requests
//   事件视图  同一条流,每种事件一句人读的话;筛选页签;详情三页(排版 / JSON / 在投影里怎么了)   inspector-events
//   压缩对照  每次压缩:被覆盖的那一大段原文 ↔ 它变成的摘要,带 token 与压缩比                 inspector-compactions
//   工作台    Ctrl+E:下一次请求的正文按发送顺序一列,token 尺、缓存线、底部预览;Enter 出动作     inspector-workbench
//   会话切换  s 键在主会话与子 agent 会话间轮换,以上视图作用在选中的数组上
// 行数爆炸由视口与按键控制,不靠删内容:任何一字节都能翻到。
// 本文件只剩覆盖层组件 RequestInspector:模式、选中、滚动、按键、行缓存;各视图的行由上面的模块算。
import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentEvent } from "../src/events.js";
import type { Message } from "../src/messages.js";
import type { Provider, ToolDef } from "../src/provider.js";
import {
  BodyBrowser,
  inputBlocks,
  receivedBlocks,
  recordingErrorBlock,
} from "./inspector-bodies.js";
import {
  COMPACTION_SECTIONS,
  type CompactionRecord,
  type CompactionSection,
  collectCompactions,
  compactionLines,
  compactionRow,
} from "./inspector-compactions.js";
import {
  type ActionItem,
  actionsFor,
  type CompositionRow,
  type ContextAction,
  compositionLines,
  compositionRows,
  consequenceOf,
} from "./inspector-composition.js";
import {
  EVENT_FILTERS,
  EVENT_SECTIONS,
  type EventFilter,
  type EventSection,
  eventLine,
  eventViewLines,
  filteredIndices,
  projectionLines,
} from "./inspector-events.js";
import {
  cacheUsageLines,
  clock,
  fmtTok,
  messageTokens,
  pctOf,
  roleLabel,
} from "./inspector-format.js";
import {
  collectRequests,
  decisionLines,
  eventLines,
  exchangeLines,
  listRow,
  messagesFor,
  type RequestRecord,
  SECTIONS,
  type Section,
  sentLines,
  summaryLines,
  toolLines,
  wireLines,
  writtenLines,
} from "./inspector-requests.js";
import {
  coveredLines,
  previewLines,
  selectable,
  type Workbench,
  type WorkbenchRow,
  workbench,
  workbenchLine,
} from "./inspector-workbench.js";
import { type SectionState, sectionStates } from "./prompt-sections.js";
import type { RecordingSection, RequestRecording } from "./session-records.js";
import { c, G } from "./theme.js";

export * from "./inspector-compactions.js";
export * from "./inspector-composition.js";
export * from "./inspector-events.js";
export * from "./inspector-format.js";
export * from "./inspector-requests.js";
export * from "./inspector-workbench.js";

export type SessionSource = {
  name: string;
  events: readonly AgentEvent[];
  recordingFor?: (index: number, section?: RecordingSection) => RequestRecording | undefined;
};

export type InspectorDeps = {
  /** 主会话的事件。 */
  events: () => readonly AgentEvent[];
  /** 全部会话(主 + 子)。不给则只有主会话。 */
  sessions?: () => SessionSource[];
  /** 主会话某次请求当时的 provider;拿不到就退回内核层视图。 */
  providerFor: (requestIndex: number) => Provider | undefined;
  /** 当前 provider:子会话或恢复的会话在模型名相同时用它重建线路正文。 */
  currentProvider?: () => Provider | undefined;
  tools: () => ToolDef[];
  /** 可用行数(终端高度)。 */
  rows: () => number;
  /** 上一次正常请求发出的消息:工作台据此画缓存线。 */
  lastSent?: () => Message[] | undefined;
  /** 上下文窗口:工作台头行的占比。 */
  contextWindow?: () => number;
  /** 模型正在跑:工作台只看不改。 */
  running?: () => boolean;
  /** 工作台里选中一条消息并选了动作。view 由检视器自己处理,其余交给界面落到命令上。 */
  onAction?: (action: ContextAction, row: CompositionRow) => void;
  /** 工作台的 system 行:翻一段(界面层追加 context/edit)。 */
  onSection?: (name: string) => void;
  /** 工作台的 tools 行:开 /tools 选单(界面层关掉检视器再开)。 */
  onTools?: () => void;
  onClose: () => void;
  requestRender: () => void;
};

// ---------- 组件 ----------

type Mode =
  | "list"
  | "detail"
  | "events"
  | "event"
  | "compactions"
  | "compaction"
  | "composition"
  | "actions"
  | "message"
  | "sections"
  | "covered";

/** 工作台底部预览区的行数(来历一行加正文四行)。 */
const PREVIEW_LINES = 5;

function lastIndexWhere<T>(arr: readonly T[], pred: (x: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i] as T)) return i;
  return -1;
}
const CTRL_UP = "\x1b[1;5A";
const CTRL_DOWN = "\x1b[1;5B";

export class RequestInspector implements Component {
  private mode: Mode = "list";
  private sessionIndex = 0;
  private selected = 0;
  private eventSelected = 0;
  private eventFilter: EventFilter = 1;
  private eventSection: EventSection = 1;
  private compactionSelected = 0;
  private section: Section = 1;
  private compactionSection: CompactionSection = 1;
  private scroll = 0;
  private bodies = new BodyBrowser();
  private bodyEvidence = "";
  private lastViewport = 10;
  private sectionSelected = 0;
  /** 运行中按了会改上下文的键:在预览区说一句,不开动作单。 */
  private busyNote: string | undefined;
  private recCache:
    | { events: readonly AgentEvent[]; len: number; recs: RequestRecord[] }
    | undefined;
  private wbCache:
    | { events: readonly AgentEvent[]; len: number; key: string; wb: Workbench }
    | undefined;
  /** 已按宽度换行的分区内容缓存;键含会话与事件数,日志一变自然失效。生产级会话动辄上千事件,不能每个按键都重算。 */
  private lineCache = new Map<string, string[]>();

  constructor(private deps: InspectorDeps) {}

  /** 打开时回到主会话的请求列表并选中最新一条。 */
  reset(): void {
    this.mode = "list";
    this.section = 1;
    this.scroll = 0;
    this.selected = Math.max(0, this.records().length - 1);
  }

  /** 直接进入事件视图(/inspect events)。 */
  showEvents(): void {
    this.mode = "events";
    this.scroll = 0;
    const idx = filteredIndices(this.events(), this.eventFilter);
    this.eventSelected = idx.at(-1) ?? 0;
  }

  /** 直接进入压缩对照(/inspect compactions)。 */
  showCompactions(): void {
    this.mode = "compactions";
    this.scroll = 0;
    this.compactionSelected = Math.max(0, this.compactions().length - 1);
  }

  private messageSelected = 0;
  private actionSelected = 0;

  /** 直接定位到第 n 次请求的某个分区(/inspect raw N → 接收分区)。没有该请求返回 false。 */
  showRequest(n: number, section: Section): boolean {
    const idx = this.records().findIndex((r) => r.n === n);
    if (idx < 0) return false;
    this.sessionIndex = 0;
    this.selected = idx;
    this.section = section;
    this.mode = "detail";
    this.scroll = 0;
    return true;
  }

  /** 直接进入工作台(Ctrl+E)。at = 事件下标:光标落在从它起的第一条消息上;不给就落在最后一条。 */
  showComposition(at?: number): void {
    this.mode = "composition";
    this.scroll = 0;
    this.busyNote = undefined;
    const rows = this.workbench().rows;
    let pick = -1;
    if (at !== undefined) {
      pick = rows.findIndex(
        (r) => (r.kind === "message" || r.kind === "system") && r.row.event >= at,
      );
    }
    if (pick < 0) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]?.kind === "message" || rows[i]?.kind === "system") {
          pick = i;
          break;
        }
      }
    }
    this.messageSelected = Math.max(0, pick);
  }

  composition(): ReturnType<typeof compositionRows> {
    return compositionRows(this.events(), this.deps.currentProvider?.());
  }

  /** 工作台的行:按会话、事件数与工具集缓存,同一状态下按键不重算。 */
  workbench(): Workbench {
    const events = this.events();
    const tools = this.deps.tools();
    const lastSent = this.deps.lastSent?.();
    const key = `${this.sessionIndex}:${tools.map((t) => t.name).join(",")}:${lastSent?.length ?? -1}`;
    if (
      this.wbCache?.events !== events ||
      this.wbCache.len !== events.length ||
      this.wbCache.key !== key
    ) {
      const wb = workbench({
        events,
        provider: this.deps.currentProvider?.(),
        tools,
        lastSent,
      });
      this.wbCache = { events, len: events.length, key, wb };
    }
    return this.wbCache.wb;
  }

  /** 工作台当前选中的行。 */
  private selectedRow(): WorkbenchRow | undefined {
    return this.workbench().rows[this.messageSelected];
  }

  get isDetail(): boolean {
    return this.mode === "detail";
  }

  get currentMode(): Mode {
    return this.mode;
  }

  get currentSession(): number {
    return this.sessionIndex;
  }

  sessions(): SessionSource[] {
    const list = this.deps.sessions?.() ?? [];
    return list.length > 0 ? list : [{ name: "main", events: this.deps.events() }];
  }

  /** 当前选中会话的事件数组。 */
  events(): readonly AgentEvent[] {
    const list = this.sessions();
    const s = list[Math.min(this.sessionIndex, list.length - 1)];
    return s ? s.events : this.deps.events();
  }

  records(): RequestRecord[] {
    const events = this.events();
    if (this.recCache?.events !== events || this.recCache.len !== events.length) {
      this.recCache = { events, len: events.length, recs: collectRequests(events) };
    }
    return this.recCache.recs;
  }

  compactions(): CompactionRecord[] {
    return collectCompactions(this.events());
  }

  invalidate(): void {
    this.lineCache.clear();
  }

  private switchSession(): void {
    const n = this.sessions().length;
    if (n <= 1) return;
    this.sessionIndex = (this.sessionIndex + 1) % n;
    this.selected = Math.max(0, this.records().length - 1);
    this.eventSelected = filteredIndices(this.events(), this.eventFilter).at(-1) ?? 0;
    this.compactionSelected = Math.max(0, this.compactions().length - 1);
    this.scroll = 0;
  }

  /** 事件视图:在通过筛选的下标里移动 step 步(负数向上);request 为真时只在 request 之间跳。 */
  private moveEvent(step: number, request = false): void {
    const idx = filteredIndices(this.events(), this.eventFilter).filter(
      (i) => !request || this.events()[i]?.type === "request",
    );
    if (idx.length === 0) return;
    let pos = idx.indexOf(this.eventSelected);
    if (pos < 0) {
      // 当前项不在筛选里(如切了筛选):向移动方向找最近的一项。
      pos =
        step < 0
          ? idx.findIndex((i) => i > this.eventSelected)
          : lastIndexWhere(idx, (i) => i < this.eventSelected);
      if (pos < 0) pos = step < 0 ? idx.length : -1;
    }
    const next = Math.min(idx.length - 1, Math.max(0, pos + step));
    this.eventSelected = idx[next] as number;
  }

  /** 工作台:在可停的行之间移动。 */
  private moveRow(step: number): void {
    const rows = this.workbench().rows;
    let i = this.messageSelected;
    const dir = step < 0 ? -1 : 1;
    let left = Math.abs(step);
    while (left > 0) {
      let j = i + dir;
      while (j >= 0 && j < rows.length && !selectable(rows[j] as WorkbenchRow)) j += dir;
      if (j < 0 || j >= rows.length) break;
      i = j;
      left--;
    }
    this.messageSelected = i;
    this.busyNote = undefined;
  }

  private prepareBodies(rec: RequestRecord | undefined): boolean {
    if (!rec) return false;
    const events = this.events();
    const saved = this.sessions()[this.sessionIndex]?.recordingFor?.(
      rec.index,
      this.section === 3 ? "input" : "received",
    );
    const start = events.find((e) => e.type === "session/start");
    this.bodyEvidence =
      this.section === 3
        ? saved?.input
          ? saved.unsaved
            ? "captured input · not saved"
            : "saved adapter input"
          : "reconstructed from events"
        : "response and tool evidence";
    const prior = this.records()[rec.n - 2];
    const priorInput =
      prior && this.section === 3
        ? this.sessions()[this.sessionIndex]?.recordingFor?.(prior.index, "input")?.input
        : undefined;
    const previous =
      prior && this.section === 3
        ? (priorInput?.messages ?? messagesFor(events, prior))
        : undefined;
    if (this.section === 3) {
      const toolChange = !prior
        ? "first request"
        : saved?.input && priorInput
          ? JSON.stringify(saved.input.tools) === JSON.stringify(priorInput.tools)
            ? "unchanged"
            : "changed"
          : "comparison unavailable (definitions not recorded)";
      this.bodyEvidence += `\nTool definitions: ${toolChange}`;
    }
    const blocks =
      this.section === 3
        ? inputBlocks(
            saved?.input?.messages ?? messagesFor(events, rec),
            start?.type === "session/start" ? start.sections : undefined,
            previous,
          )
        : receivedBlocks(rec, saved);
    if (this.section === 3 && blocks[0]) {
      const changed = rec.before.filter(
        (e) => e.type === "context/edit" || e.type === "context/drop" || e.type === "compaction",
      );
      if (changed.length)
        blocks[0].meta += ` · ${[...new Set(changed.map((e) => e.type))].join(", ")} before this request; 2 decisions`;
    }
    if (this.section === 3 && saved?.error) blocks.unshift(recordingErrorBlock(saved.error));
    this.bodies.set(`${this.sessionIndex}:${rec.index}:${this.section}`, blocks);
    return true;
  }

  private busy(): boolean {
    return this.deps.running?.() ?? false;
  }

  /** 提示词段:切得回来就带开关;切不回来只列元数据。 */
  private sections(): { states: SectionState[] | undefined; names: string[] } {
    const events = this.events();
    const states = sectionStates(events);
    const start = events.find((e) => e.type === "session/start");
    const names = start?.type === "session/start" ? (start.sections ?? []).map((s) => s.name) : [];
    return { states, names };
  }

  handleInput(data: string): void {
    const recs = this.records();
    const events = this.events();
    const comps = this.compactions();
    const page = Math.max(1, this.lastViewport - 1);
    const tab = data === "\t";
    const clampSel = (v: number, len: number) => Math.min(Math.max(0, len - 1), Math.max(0, v));
    const scrollKeys = (): boolean => {
      if (matchesKey(data, Key.up) || data === "k") this.scroll = Math.max(0, this.scroll - 1);
      else if (matchesKey(data, Key.down) || data === "j") this.scroll += 1;
      else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - page);
      else if (matchesKey(data, Key.pageDown)) this.scroll += page;
      else if (matchesKey(data, Key.home) || data === "g") this.scroll = 0;
      else if (matchesKey(data, Key.end) || data === "G") this.scroll = Number.MAX_SAFE_INTEGER;
      else return false;
      return true;
    };
    switch (this.mode) {
      case "list":
        if (matchesKey(data, Key.escape) || data === "q") this.deps.onClose();
        else if (tab) this.showEvents();
        else if (data === "s") this.switchSession();
        else if (matchesKey(data, Key.up) || data === "k")
          this.selected = clampSel(this.selected - 1, recs.length);
        else if (matchesKey(data, Key.down) || data === "j")
          this.selected = clampSel(this.selected + 1, recs.length);
        else if (matchesKey(data, Key.home) || data === "g") this.selected = 0;
        else if (matchesKey(data, Key.end) || data === "G")
          this.selected = Math.max(0, recs.length - 1);
        else if (matchesKey(data, Key.enter) && recs.length > 0) {
          this.mode = "detail";
          this.scroll = 0;
        }
        break;
      case "detail":
        if (matchesKey(data, Key.escape) || data === "q") {
          this.mode = "list";
          this.scroll = 0;
        } else if (
          (this.section === 3 || this.section === 6) &&
          this.prepareBodies(recs[this.selected]) &&
          this.bodies.handleInput(data)
        ) {
          // 选择与展开仅属于当前正文视图。
        } else if (scrollKeys()) {
          // 已处理
        } else if (matchesKey(data, Key.left) || data === "h") this.switchSection(-1);
        else if (matchesKey(data, Key.right) || data === "l") this.switchSection(1);
        else if (/^[1-7]$/.test(data)) {
          this.section = Number(data) as Section;
          this.scroll = 0;
        } else if (data === "[" || data === "]") {
          this.selected = clampSel(this.selected + (data === "]" ? 1 : -1), recs.length);
          this.scroll = 0;
        }
        break;
      case "events":
        if (matchesKey(data, Key.escape) || data === "q") this.deps.onClose();
        else if (tab) this.showCompactions();
        else if (data === "s") this.switchSession();
        else if (data === CTRL_UP) this.moveEvent(-1, true);
        else if (data === CTRL_DOWN) this.moveEvent(1, true);
        else if (matchesKey(data, Key.up) || data === "k") this.moveEvent(-1);
        else if (matchesKey(data, Key.down) || data === "j") this.moveEvent(1);
        else if (matchesKey(data, Key.pageUp)) this.moveEvent(-page);
        else if (matchesKey(data, Key.pageDown)) this.moveEvent(page);
        else if (matchesKey(data, Key.home) || data === "g")
          this.eventSelected = filteredIndices(events, this.eventFilter)[0] ?? 0;
        else if (matchesKey(data, Key.end) || data === "G")
          this.eventSelected = filteredIndices(events, this.eventFilter).at(-1) ?? 0;
        else if (/^[1-5]$/.test(data)) {
          this.eventFilter = Number(data) as EventFilter;
          const idx = filteredIndices(events, this.eventFilter);
          if (!idx.includes(this.eventSelected)) {
            const at = lastIndexWhere(idx, (i) => i <= this.eventSelected);
            this.eventSelected = (at >= 0 ? idx[at] : idx[0]) ?? 0;
          }
        } else if (matchesKey(data, Key.enter) && events.length > 0) {
          this.mode = "event";
          this.scroll = 0;
        }
        break;
      case "event":
        if (matchesKey(data, Key.escape) || data === "q") {
          this.mode = "events";
          this.scroll = 0;
        } else if (scrollKeys()) {
          // 已处理
        } else if (/^[1-3]$/.test(data)) {
          this.eventSection = Number(data) as EventSection;
          this.scroll = 0;
        } else if (matchesKey(data, Key.left) || data === "h") {
          this.eventSection = (this.eventSection === 1 ? 3 : this.eventSection - 1) as EventSection;
          this.scroll = 0;
        } else if (matchesKey(data, Key.right) || data === "l") {
          this.eventSection = (this.eventSection === 3 ? 1 : this.eventSection + 1) as EventSection;
          this.scroll = 0;
        } else if (data === "[" || data === "]") {
          this.moveEvent(data === "]" ? 1 : -1);
          this.scroll = 0;
        }
        break;
      case "composition": {
        const row = this.selectedRow();
        if (matchesKey(data, Key.escape) || data === "q") this.deps.onClose();
        else if (tab) {
          this.mode = "list";
          this.scroll = 0;
        } else if (data === "s") {
          this.switchSession();
          this.showComposition();
        } else if (matchesKey(data, Key.up) || data === "k") this.moveRow(-1);
        else if (matchesKey(data, Key.down) || data === "j") this.moveRow(1);
        else if (matchesKey(data, Key.pageUp)) this.moveRow(-page);
        else if (matchesKey(data, Key.pageDown)) this.moveRow(page);
        else if (matchesKey(data, Key.home) || data === "g") {
          this.messageSelected = 0;
          this.moveRow(0);
        } else if (matchesKey(data, Key.end) || data === "G") {
          this.messageSelected = this.workbench().rows.length - 1;
          this.moveRow(0);
        } else if (matchesKey(data, Key.enter) && row) this.enterRow(row);
        break;
      }
      case "actions": {
        const row = this.selectedRow();
        const r = row?.kind === "message" || row?.kind === "system" ? row.row : undefined;
        const total = this.composition().rows.length;
        const items = r ? actionsFor(events, r, total) : [];
        if (matchesKey(data, Key.escape) || data === "q") this.mode = "composition";
        else if (matchesKey(data, Key.up) || data === "k")
          this.actionSelected = clampSel(this.actionSelected - 1, items.length);
        else if (matchesKey(data, Key.down) || data === "j")
          this.actionSelected = clampSel(this.actionSelected + 1, items.length);
        else if (/^[1-9]$/.test(data) && Number(data) <= items.length)
          this.actionSelected = Number(data) - 1;
        else if (matchesKey(data, Key.enter) && r) {
          const item = items[this.actionSelected];
          if (item?.action === "view") {
            this.mode = "message";
            this.scroll = 0;
          } else if (item) {
            this.mode = "composition";
            this.deps.onAction?.(item.action, r);
          }
        }
        break;
      }
      case "message": {
        if (matchesKey(data, Key.escape) || data === "q") {
          this.mode = "composition";
          this.scroll = 0;
        } else if (scrollKeys()) {
          // 已处理
        } else if (data === "[" || data === "]") {
          this.moveRow(data === "]" ? 1 : -1);
          const row = this.selectedRow();
          if (row?.kind !== "message" && row?.kind !== "system") this.mode = "composition";
          this.scroll = 0;
        }
        break;
      }
      case "sections": {
        const { states, names } = this.sections();
        const n = states?.length ?? names.length;
        if (matchesKey(data, Key.escape) || data === "q") this.mode = "composition";
        else if (matchesKey(data, Key.up) || data === "k")
          this.sectionSelected = clampSel(this.sectionSelected - 1, n);
        else if (matchesKey(data, Key.down) || data === "j")
          this.sectionSelected = clampSel(this.sectionSelected + 1, n);
        else if (/^[1-9]$/.test(data) && Number(data) <= n) this.sectionSelected = Number(data) - 1;
        else if (matchesKey(data, Key.enter) && states) {
          const s = states[this.sectionSelected];
          if (this.busy())
            this.busyNote =
              "cannot change the context while running · Esc in the transcript stops the turn";
          else if (s) this.deps.onSection?.(s.name);
        }
        break;
      }
      case "covered":
        if (matchesKey(data, Key.escape) || data === "q") {
          this.mode = "composition";
          this.scroll = 0;
        } else scrollKeys();
        break;
      case "compactions":
        if (matchesKey(data, Key.escape) || data === "q") this.deps.onClose();
        else if (tab) this.showComposition();
        else if (data === "s") this.switchSession();
        else if (matchesKey(data, Key.up) || data === "k")
          this.compactionSelected = clampSel(this.compactionSelected - 1, comps.length);
        else if (matchesKey(data, Key.down) || data === "j")
          this.compactionSelected = clampSel(this.compactionSelected + 1, comps.length);
        else if (matchesKey(data, Key.home) || data === "g") this.compactionSelected = 0;
        else if (matchesKey(data, Key.end) || data === "G")
          this.compactionSelected = Math.max(0, comps.length - 1);
        else if (matchesKey(data, Key.enter) && comps.length > 0) {
          this.mode = "compaction";
          this.compactionSection = 1;
          this.scroll = 0;
        }
        break;
      case "compaction":
        if (matchesKey(data, Key.escape) || data === "q") {
          this.mode = "compactions";
          this.scroll = 0;
        } else if (scrollKeys()) {
          // 已处理
        } else if (/^[1-4]$/.test(data)) {
          this.compactionSection = Number(data) as CompactionSection;
          this.scroll = 0;
        } else if (matchesKey(data, Key.left) || data === "h") {
          this.compactionSection = (
            this.compactionSection === 1 ? 4 : this.compactionSection - 1
          ) as CompactionSection;
          this.scroll = 0;
        } else if (matchesKey(data, Key.right) || data === "l") {
          this.compactionSection = (
            this.compactionSection === 4 ? 1 : this.compactionSection + 1
          ) as CompactionSection;
          this.scroll = 0;
        } else if (data === "[" || data === "]") {
          this.compactionSelected = clampSel(
            this.compactionSelected + (data === "]" ? 1 : -1),
            comps.length,
          );
          this.scroll = 0;
        }
        break;
    }
    this.deps.requestRender();
  }

  /** 工作台里按 Enter:按行的种类分派。 */
  private enterRow(row: WorkbenchRow): void {
    switch (row.kind) {
      case "message":
        if (this.busy()) {
          this.busyNote =
            "cannot change the context while running · Esc in the transcript stops the turn";
          return;
        }
        if (row.row.stages.some((s) => s.startsWith("summary"))) {
          const comps = this.compactions();
          const k = comps.findIndex((cmp) => cmp.index === row.row.event);
          if (k >= 0) {
            this.compactionSelected = k;
            this.compactionSection = 1;
            this.mode = "compaction";
            this.scroll = 0;
            return;
          }
        }
        this.mode = "actions";
        this.actionSelected = 0;
        return;
      case "system":
        this.mode = "sections";
        this.sectionSelected = 0;
        this.busyNote = undefined;
        return;
      case "tools":
        this.deps.onTools?.();
        return;
      case "covered":
        this.mode = "covered";
        this.scroll = 0;
        return;
      case "dropped":
      case "prefix":
        return;
    }
  }

  private switchSection(step: number): void {
    const next = this.section + step;
    this.section = (next < 1 ? 7 : next > 7 ? 1 : next) as Section;
    this.scroll = 0;
  }

  private providerFor(requestIndex: number): Provider | undefined {
    if (this.sessionIndex === 0) return this.deps.providerFor(requestIndex);
    const e = this.events()[requestIndex];
    const cur = this.deps.currentProvider?.();
    return e?.type === "request" && cur && e.model === cur.model ? cur : undefined;
  }

  /** 当前分区的完整内容行(未按视口裁切),测试与预览用。 */
  sectionLines(rec: RequestRecord, section: Section): string[] {
    const events = this.events();
    const recording = this.sessions()[this.sessionIndex]?.recordingFor?.(
      rec.index,
      section === 5 ? "wire" : section === 1 ? "summary" : "input",
    );
    const messages = recording?.input?.messages ?? messagesFor(events, rec);
    const available = new Map(this.deps.tools().map((d) => [d.name, d]));
    const defs =
      recording?.input?.tools ?? rec.request.tools.flatMap((name) => available.get(name) ?? []);
    const missing = rec.request.tools.filter((name) => !defs.some((d) => d.name === name));
    const previous = this.records()[rec.n - 2];
    const prior = previous
      ? (this.sessions()[this.sessionIndex]?.recordingFor?.(previous.index, "input")?.input
          ?.messages ?? messagesFor(events, previous))
      : undefined;
    switch (section) {
      case 1:
        return [
          ...exchangeLines(events, rec, messages, prior, recording),
          "",
          ...summaryLines(rec, messages),
        ];
      case 2:
        return decisionLines(rec);
      case 3: {
        const start = events.find((e) => e.type === "session/start");
        const sections = start?.type === "session/start" ? start.sections : undefined;
        return [
          ...(recording?.error ? [c.zhu(recording.error)] : []),
          ...sentLines(messages, false, sections, prior, Boolean(recording?.input)),
        ];
      }
      case 4:
        return toolLines(defs, rec.request.tools, recording);
      case 5:
        return wireLines(
          this.providerFor(rec.index),
          messages,
          defs,
          rec.request.effort,
          recording,
          missing,
        );
      case 6:
        return []; // 正文浏览器负责此分区。
      case 7: {
        const recs = this.records();
        const next = recs.find((r) => r.index > rec.index);
        return writtenLines(events, rec, next ? next.index : events.length);
      }
    }
  }

  private cached(key: string, build: () => string[]): string[] {
    const hit = this.lineCache.get(key);
    if (hit) return hit;
    if (this.lineCache.size > 64) this.lineCache.clear();
    const lines = build();
    this.lineCache.set(key, lines);
    return lines;
  }

  /** 会话选择器:多于一个会话时显示在列表类视图的头部。 */
  private sessionLine(): string | undefined {
    const list = this.sessions();
    if (list.length <= 1) return undefined;
    const items = list.map((s, i) =>
      i === this.sessionIndex ? c.ink(`▸ ${s.name}`) : c.faint(`  ${s.name}`),
    );
    return `${items.join("   ")}   ${c.faint("s switch session")}`;
  }

  /** 页签行:[1 name] 2 name 3 name。 */
  private tabs(
    names: readonly string[],
    current: number,
    width = Number.POSITIVE_INFINITY,
  ): string {
    const full = names
      .map((name, i) => {
        const n = i + 1;
        return n === current ? c.bold(c.ink(`[${n} ${name}]`)) : c.soft(` ${n} ${name} `);
      })
      .join(" ");
    return visibleWidth(full) <= width
      ? full
      : `${c.bold(c.ink(`[${current} ${names[current - 1]}]`))} ${c.faint(`· ${current}/${names.length} · ←→ or 1–${names.length}`)}`;
  }

  render(width: number): string[] {
    const w = Math.max(20, width);
    const inner = w - 2;
    const rows = Math.max(8, this.deps.rows());
    const events = this.events();
    const rule = c.faint("─".repeat(inner));
    const pad = (s: string) => ` ${truncateToWidth(s, inner, "…", true)} `;
    const fill = (body: string[], viewport: number) => {
      while (body.length < viewport) body.push(pad(""));
      return body;
    };
    const windowStart = (sel: number, total: number, viewport: number) =>
      Math.max(0, Math.min(sel - Math.floor(viewport / 2), total - viewport));
    const sessionLine = this.sessionLine();
    const focusLine = pad(c.jin("Inspector · Ctrl+R returns to draft"));
    const withSession = (head: string[]) => [
      head[0] as string,
      focusLine,
      ...(sessionLine ? [pad(sessionLine)] : []),
      ...head.slice(1),
    ];
    const cacheKey = (k: string) => `${this.sessionIndex}:${events.length}:${inner}:${k}`;

    if (this.mode === "list") {
      const recs = this.records();
      const title = `${c.bold(c.ink("Requests"))}  ${c.soft(`${recs.length} requests`)}  ${c.faint("one line per API request · Tab: events · compactions · context")}`;
      const columns = c.faint(
        "  #    time      model  sent (msgs · est. tok)  → measured (cache)  +out  latency  stop",
      );
      const head = withSession([pad(title), pad(columns), pad(rule)]);
      const foot = [
        pad(rule),
        pad(c.faint("↑↓ select · Enter details · Tab next view · s session · Esc close")),
      ];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      let body: string[];
      if (recs.length === 0) body = [pad(c.faint("No requests yet. Send a message first."))];
      else {
        const start = windowStart(this.selected, recs.length, viewport);
        body = recs
          .slice(start, start + viewport)
          .map((r, i) => pad(listRow(r, start + i === this.selected)));
      }
      return [...head, ...fill(body, viewport), ...foot];
    }

    if (this.mode === "events") {
      const idx = filteredIndices(events, this.eventFilter);
      const title = `${c.bold(c.ink("Events"))}  ${c.soft(`${events.length} events · this array is the whole kernel state`)}   ${this.tabs(EVENT_FILTERS, this.eventFilter)}`;
      const columns = c.faint(
        "   #     time      type             what                                                   ≈tok  model sees",
      );
      const head = withSession([pad(title), pad(columns), pad(rule)]);
      const foot = [
        pad(rule),
        pad(
          c.faint(
            "↑↓ move · Enter details · 1–5 filter · Ctrl+↑↓ request · PgUp/PgDn · Tab compactions · s session · Esc close",
          ),
        ),
      ];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      // 请求前空一行:条目里 undefined 就是空行。
      const entries: (number | undefined)[] = [];
      for (const i of idx) {
        if (events[i]?.type === "request" && entries.length > 0) entries.push(undefined);
        entries.push(i);
      }
      let body: string[];
      if (entries.length === 0) body = [pad(c.faint("no events match this filter"))];
      else {
        const selPos = Math.max(0, entries.indexOf(this.eventSelected));
        const start = windowStart(selPos, entries.length, viewport);
        body = entries
          .slice(start, start + viewport)
          .map((i) =>
            i === undefined
              ? pad("")
              : pad(eventLine(events, i, { selected: i === this.eventSelected, width: inner })),
          );
      }
      return [...head, ...fill(body, viewport), ...foot];
    }

    if (this.mode === "event") {
      const e = events[this.eventSelected];
      const idx = filteredIndices(events, this.eventFilter);
      const pos = idx.indexOf(this.eventSelected);
      const title = `${c.bold(c.ink(`Event #${this.eventSelected}`))}  ${c.ink(e?.type ?? "")}  ${c.faint(e ? clock(e.at) : "")}  ${c.faint(`(${pos + 1}/${idx.length})`)}   ${this.tabs(EVENT_SECTIONS, this.eventSection)}`;
      const head = [pad(title), focusLine, pad(rule)];
      const content = this.cached(
        cacheKey(`event:${this.eventSelected}:${this.eventSection}`),
        () => {
          const lines =
            this.eventSection === 1
              ? eventViewLines(events, this.eventSelected)
              : this.eventSection === 2
                ? eventLines(events, this.eventSelected)
                : projectionLines(events, this.eventSelected, this.deps.currentProvider?.());
          return lines.flatMap((l) => wrapTextWithAnsi(l, inner));
        },
      );
      return this.scrollable(
        head,
        content,
        "↑↓ scroll · PgUp/PgDn page · 1–3 section · [ ] prev/next event · Esc back",
        rows,
        pad,
        rule,
      );
    }

    if (this.mode === "compactions") {
      const comps = this.compactions();
      const title = `${c.bold(c.ink("Compactions"))}  ${c.soft(`${comps.length} compactions`)}  ${c.faint("what became what; the original always stays in the array")}`;
      const columns = c.faint(
        "  #    time      strategy  original (events · tok) → summary tok · ratio  cleared",
      );
      const head = withSession([pad(title), pad(columns), pad(rule)]);
      const foot = [
        pad(rule),
        pad(c.faint("↑↓ select · Enter details · Tab context · s session · Esc close")),
      ];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      let body: string[];
      if (comps.length === 0)
        body = [
          pad(
            c.faint(
              "No compactions yet. Come back after the context nears the threshold, or /compact.",
            ),
          ),
        ];
      else {
        const start = windowStart(this.compactionSelected, comps.length, viewport);
        body = comps
          .slice(start, start + viewport)
          .map((r, i) => pad(compactionRow(r, start + i === this.compactionSelected)));
      }
      return [...head, ...fill(body, viewport), ...foot];
    }

    if (this.mode === "composition") {
      const wb = this.workbench();
      const window = this.deps.contextWindow?.();
      const size = `≈${fmtTok(wb.total)}${window ? ` of ${fmtTok(window)} · ${pctOf(wb.total, window)}` : " tok"}`;
      const cacheNote =
        wb.prefixTokens === undefined
          ? c.faint("nothing sent yet")
          : wb.broken
            ? c.jin(`same prefix ≈${fmtTok(wb.prefixTokens)} · changed tail`)
            : c.faint(`same prefix ≈${fmtTok(wb.prefixTokens)}`);
      const title = `${c.bold(c.ink("Context"))}  ${c.soft("what the model sees on the next request")}   ${c.soft(size)}   ${cacheNote}`;
      const columns = c.faint(
        "   #     what                                                              tok  share",
      );
      const head = withSession([pad(title), pad(columns), pad(rule)]);
      const last = this.records().at(-1);
      if (last)
        head.splice(
          1,
          0,
          ...[
            `Last request #${last.n}`,
            ...cacheUsageLines(last.response?.usage ?? last.compaction?.usage, inner),
          ]
            .flatMap((line) => wrapTextWithAnsi(c.soft(line), inner))
            .map(pad),
        );
      const row = this.selectedRow();
      const maxTok = wb.rows.reduce(
        (m, r) =>
          r.kind === "message" || r.kind === "system" || r.kind === "tools"
            ? Math.max(m, r.tok)
            : m,
        1,
      );
      const preview = row
        ? previewLines(events, wb, row, {
            width: inner,
            lines: PREVIEW_LINES - 1,
            busy: this.busyNote,
          })
        : [];
      const previewBox = fill(preview.map(pad), PREVIEW_LINES);
      const foot = [
        pad(rule),
        ...previewBox.slice(0, PREVIEW_LINES),
        pad(rule),
        pad(
          c.faint(
            "↑↓ move · Enter actions · PgUp/PgDn page · Tab requests · s session · Esc close",
          ),
        ),
      ];
      const viewport = Math.max(3, rows - head.length - foot.length);
      this.lastViewport = viewport;
      let body: string[];
      if (wb.rows.length === 0) body = [pad(c.faint("no messages yet"))];
      else {
        const start = windowStart(this.messageSelected, wb.rows.length, viewport);
        body = wb.rows.slice(start, start + viewport).map((r, i) =>
          pad(
            workbenchLine(events, r, {
              selected: start + i === this.messageSelected,
              width: inner,
              maxTok,
            }),
          ),
        );
      }
      return [...head, ...fill(body, viewport), ...foot];
    }

    if (this.mode === "actions") {
      const row = this.selectedRow();
      const r = row?.kind === "message" || row?.kind === "system" ? row.row : undefined;
      if (!r) {
        this.mode = "composition";
        return this.render(width);
      }
      const crows = this.composition().rows;
      const items = actionsFor(events, r, crows.length);
      const sel = Math.min(this.actionSelected, items.length - 1);
      const m = r.message;
      const title = `${c.bold(c.ink(`#${r.event} ${roleLabel(m)}`))}  ${c.soft(`≈${messageTokens(m)} tok${m.edited ? ` · ${c.jin("edited")}` : ""}`)}`;
      const head = [pad(title), focusLine, pad(rule)];
      const previewSrc = m.content
        ? m.content.split("\n").slice(0, 6)
        : m.role === "assistant" && m.toolCalls.length > 0
          ? m.toolCalls.map((t) => `${G.call} ${t.name} ${JSON.stringify(t.args)}`)
          : ["(empty)"];
      const chosen = items[sel] as ActionItem;
      const body = [
        ...previewSrc.map((l) => pad(c.faint(`  ${truncateToWidth(l, inner - 4, "…")}`))),
        pad(""),
        pad(c.soft("Actions")),
        ...items.map((it, i) =>
          pad(
            i === sel
              ? `  ${c.zhu(G.cursor)} ${c.bold(c.ink(`${i + 1}  ${it.label.padEnd(24)}`))} ${c.faint(it.hint)}`
              : `    ${c.soft(`${i + 1}  ${it.label.padEnd(24)}`)} ${c.faint(it.hint)}`,
          ),
        ),
        pad(""),
        // 后果一行说不完就换行,不截断:这是面板存在的理由。
        ...wrapTextWithAnsi(
          `${c.soft("If you do this")}  ${c.faint(consequenceOf(chosen.action, r, crows, events, this.deps.currentProvider?.()))}`,
          inner,
        ).map(pad),
      ];
      const foot = [pad(rule), pad(c.faint("↑↓ or 1–9 choose · Enter do it · Esc back"))];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      return [...head, ...fill(body.slice(0, viewport), viewport), ...foot];
    }

    if (this.mode === "message") {
      const row = this.selectedRow();
      const r = row?.kind === "message" || row?.kind === "system" ? row.row : undefined;
      if (!r) {
        this.mode = "composition";
        return this.render(width);
      }
      const crows = this.composition().rows;
      const title = `${c.bold(c.ink(`#${r.event} ${roleLabel(r.message)}`))}  ${c.faint(`message ${r.i} of ${crows.length}`)}`;
      const head = [pad(title), focusLine, pad(rule)];
      const content = this.cached(cacheKey(`message:${r.event}:${r.i}`), () =>
        compositionLines(events, r).flatMap((l) => wrapTextWithAnsi(l, inner)),
      );
      return this.scrollable(
        head,
        content,
        "↑↓ scroll · PgUp/PgDn page · [ ] prev/next message · Esc back",
        rows,
        pad,
        rule,
      );
    }

    if (this.mode === "sections") {
      const { states, names } = this.sections();
      const start = events.find((e) => e.type === "session/start");
      const metas = start?.type === "session/start" ? (start.sections ?? []) : [];
      const total = metas.reduce((n, s) => n + Math.ceil(s.chars / 4), 0);
      const title = `${c.bold(c.ink("System prompt"))}  ${c.soft(`${metas.length} sections · ≈${total} tok`)}   ${c.faint(states ? "Enter flips a section for this session" : "section texts cannot be recovered from this log: read-only")}`;
      const head = [pad(title), focusLine, pad(rule)];
      const list =
        states ?? names.map((name) => ({ name, on: true, text: "", chars: 0, source: undefined }));
      const body: string[] = [];
      list.forEach((s, i) => {
        const meta = metas[i];
        const tok = Math.ceil((meta?.chars ?? s.chars) / 4);
        const first =
          s.text
            .split("\n")
            .find((l) => l.trim())
            ?.trim() ??
          meta?.source ??
          "";
        const state = states ? (s.on ? "on " : "off") : "   ";
        const line = `${i + 1}  ${s.name.padEnd(22)} ${state}  ${`≈${tok}`.padStart(6)}   ${truncateToWidth(first, Math.max(10, inner - 44), "…")}`;
        body.push(
          pad(
            i === this.sectionSelected
              ? `  ${c.zhu(G.cursor)} ${c.bold(c.ink(line))}`
              : `    ${s.on ? c.soft(line) : c.faint(line)}`,
          ),
        );
      });
      if (list.length === 0) body.push(pad(c.faint("no section metadata in this session")));
      body.push(pad(""));
      if (this.busyNote) body.push(pad(c.zhu(`  ${this.busyNote}`)));
      else if (states)
        body.push(
          ...wrapTextWithAnsi(
            `${c.soft("If you do this")}  ${c.faint("the system prompt changes for this session (recorded as an edit of event #0) · input changes from the top on the next request · /settings prompt.sections makes it stick")}`,
            inner,
          ).map(pad),
        );
      const foot = [
        pad(rule),
        pad(c.faint(states ? "↑↓ or 1–9 choose · Enter flip · Esc back" : "Esc back")),
      ];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      return [...head, ...fill(body.slice(0, viewport), viewport), ...foot];
    }

    if (this.mode === "covered") {
      const row = this.selectedRow();
      if (row?.kind !== "covered") {
        this.mode = "composition";
        return this.render(width);
      }
      const title = `${c.bold(c.ink(`Covered #${row.from}–#${row.upTo - 1}`))}  ${c.soft(`${row.count} messages · ≈${fmtTok(row.tok)} tok`)}  ${c.faint(`replaced by the summary #${row.summary}`)}`;
      const head = [pad(title), focusLine, pad(rule)];
      const content = this.cached(cacheKey(`covered:${row.from}:${row.upTo}`), () =>
        coveredLines(events, row).flatMap((l) => wrapTextWithAnsi(l, inner)),
      );
      return this.scrollable(
        head,
        content,
        "↑↓ scroll · PgUp/PgDn page · Esc back",
        rows,
        pad,
        rule,
      );
    }

    if (this.mode === "compaction") {
      const comps = this.compactions();
      const rec = comps[this.compactionSelected];
      if (!rec) {
        this.mode = "compactions";
        return this.render(width);
      }
      const tabs = this.tabs(COMPACTION_SECTIONS, this.compactionSection);
      const title = `${c.bold(c.ink(`Compaction #${rec.n}`))}  ${c.ink(rec.event.strategy ?? "")}  ${c.faint(clock(rec.event.at))}  ${c.faint(`(${this.compactionSelected + 1}/${comps.length})`)}`;
      const head = [pad(title), focusLine, pad(tabs), pad(rule)];
      const content = this.cached(
        cacheKey(`compaction:${rec.index}:${this.compactionSection}`),
        () =>
          compactionLines(events, rec, this.compactionSection).flatMap((l) =>
            wrapTextWithAnsi(l, inner),
          ),
      );
      return this.scrollable(
        head,
        content,
        "↑↓ scroll · PgUp/PgDn · ←→ 1-4 section · [ ] compaction · Esc back",
        rows,
        pad,
        rule,
      );
    }

    const recs = this.records();
    const rec = recs[this.selected];
    if (!rec) {
      this.mode = "list";
      return this.render(width);
    }
    const tabs = this.tabs(SECTIONS, this.section, inner);
    const title = `${c.bold(c.ink(`Request #${rec.n}`))}  ${c.ink(rec.request.model)}  ${c.faint(clock(rec.request.at))}  ${c.faint(`(${this.selected + 1}/${recs.length})`)}`;
    const head = [pad(title), focusLine, pad(tabs), pad(rule)];
    if ((this.section === 3 || this.section === 6) && this.prepareBodies(rec)) {
      const body = this.bodies.render(inner);
      const bodyHead = [
        ...head.slice(0, -1),
        ...wrapTextWithAnsi(c.soft(`${body.position} · ${this.bodyEvidence}`), inner).map(pad),
        ...(this.section === 3
          ? cacheUsageLines(rec.response?.usage ?? rec.compaction?.usage, inner)
              .flatMap((line) => wrapTextWithAnsi(c.soft(line), inner))
              .map(pad)
          : []),
        pad(
          c.ink(
            `Selected · ${body.selected} · ${body.action === "collapse" ? "expanded" : "collapsed"}`,
          ),
        ),
        head.at(-1) as string,
      ];
      const viewport = Math.max(1, rows - bodyHead.length - 2);
      if (
        body.focus !== undefined &&
        (body.focus < this.scroll || body.focus >= this.scroll + viewport - 2)
      )
        this.scroll = body.focus;
      const action = `↑↓ block · Enter ${body.action} · PgUp/Dn read`;
      return this.scrollable(bodyHead, body.lines, action, rows, pad, rule, true);
    }
    const build = () =>
      this.sectionLines(rec, this.section).flatMap((l) => wrapTextWithAnsi(l, inner));
    // 旁路流在请求完成前持续变化,不一定追加内核事件。仅正在查看的实录分区跳过缓存。
    const streaming =
      !rec.response && !rec.error && !rec.compaction && [1, 4, 5, 6].includes(this.section);
    const content = streaming
      ? build()
      : this.cached(cacheKey(`detail:${rec.index}:${this.section}`), build);
    return this.scrollable(
      head,
      content,
      width < 90
        ? "↑↓ read · [ ] request · Esc back"
        : "↑↓ scroll · PgUp/PgDn · ←→ 1-7 section · [ ] request · Esc back",
      rows,
      pad,
      rule,
    );
  }

  /** 带位置提示的视口:头部固定,内容按 scroll 裁切,尾部显示第几行到第几行。 */
  private scrollable(
    head: string[],
    content: string[],
    hint: string,
    rows: number,
    pad: (s: string) => string,
    rule: string,
    controlsFirst = false,
  ): string[] {
    const viewport = Math.max(1, rows - head.length - 2);
    this.lastViewport = viewport;
    const maxScroll = Math.max(0, content.length - viewport);
    this.scroll = Math.min(this.scroll, maxScroll);
    const slice = content.slice(this.scroll, this.scroll + viewport);
    while (slice.length < viewport) slice.push("");
    const pos =
      content.length <= viewport
        ? `${content.length} lines`
        : `lines ${this.scroll + 1}-${Math.min(content.length, this.scroll + viewport)} of ${content.length}`;
    // 位置在前:窄终端截断的是按键提示,不是"第几行"。
    const foot = controlsFirst
      ? [pad(`${c.faint(pos)} · ${c.faint("[ ] request · Esc back")}`), pad(c.soft(hint))]
      : [pad(rule), pad(`${c.soft(pos)}  ${c.faint(hint)}`)];
    return [...head, ...slice.map(pad), ...foot];
  }
}
