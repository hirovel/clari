// 检视器:对事件数组的几种投影,全部只读。
//   请求视图  一行一请求 → 七分区(概要 / 决策 / 发送 / 工具定义 / 线路 JSON / 接收 / 写入)   inspector-requests
//   事件视图  内核维护的全部事件,逐条大小与可见性 → 原样 JSON                                 inspector-requests
//   压缩对照  每次压缩:被覆盖的那一大段原文 ↔ 它变成的摘要,带 token 与压缩比                 inspector-compactions
//   组装视图  模型下一步会看到的每条消息从哪来、经过了什么;动作菜单                              inspector-composition
//   会话切换  s 键在主会话与子 agent 会话间轮换,以上视图作用在选中的数组上
// 行数爆炸由视口与按键控制,不靠删内容:任何一字节都能翻到。
// 本文件只剩覆盖层组件 RequestInspector:模式、选中、滚动、按键、行缓存;各视图的行由上面四个模块算。
// 其它模块从这里 import 视图函数照旧可用(重构块 5 的再导出)。
import {
  type Component,
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AgentEvent } from "../src/events.js";
import type { Provider, ToolDef } from "../src/provider.js";
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
  compositionRow,
  compositionRows,
  consequenceOf,
} from "./inspector-composition.js";
import { clock, messageTokens, roleLabel } from "./inspector-format.js";
import {
  collectRequests,
  decisionLines,
  eventLines,
  eventRow,
  listRow,
  messagesFor,
  type RequestRecord,
  receivedLines,
  SECTIONS,
  type Section,
  sentLines,
  summaryLines,
  toolLines,
  wireLines,
  writtenLines,
} from "./inspector-requests.js";
import { c } from "./theme.js";

export * from "./inspector-compactions.js";
export * from "./inspector-composition.js";
export * from "./inspector-format.js";
export * from "./inspector-requests.js";

export type SessionSource = { name: string; events: readonly AgentEvent[] };

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
  /** 主会话某请求的原始流(开了 trace 才有)。 */
  rawFor?: (requestIndex: number) => string[] | undefined;
  /** 上下文面板里选中一条消息并选了动作。view 由检视器自己处理,其余交给界面落到命令上。 */
  onAction?: (action: ContextAction, row: CompositionRow) => void;
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
  | "message";

export class RequestInspector implements Component {
  private mode: Mode = "list";
  private sessionIndex = 0;
  private selected = 0;
  private eventSelected = 0;
  private compactionSelected = 0;
  private section: Section = 1;
  private compactionSection: CompactionSection = 1;
  private scroll = 0;
  private folded = false;
  private lastViewport = 10;
  private recCache:
    | { events: readonly AgentEvent[]; len: number; recs: RequestRecord[] }
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

  /** 直接进入事件视图(/events)。 */
  showEvents(): void {
    this.mode = "events";
    this.scroll = 0;
    this.eventSelected = Math.max(0, this.events().length - 1);
  }

  /** 直接进入压缩对照(/compactions)。 */
  showCompactions(): void {
    this.mode = "compactions";
    this.scroll = 0;
    this.compactionSelected = Math.max(0, this.compactions().length - 1);
  }

  private messageSelected = 0;
  private actionSelected = 0;

  /** 直接定位到第 n 次请求的某个分区(/raw N → 接收分区)。没有该请求返回 false。 */
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

  /** 直接进入组装视图(Ctrl+E / /context)。 */
  showComposition(): void {
    this.mode = "composition";
    this.scroll = 0;
    this.messageSelected = Math.max(0, this.composition().rows.length - 1);
  }

  composition(): ReturnType<typeof compositionRows> {
    return compositionRows(this.events(), this.deps.currentProvider?.());
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
    this.eventSelected = Math.max(0, this.events().length - 1);
    this.compactionSelected = Math.max(0, this.compactions().length - 1);
    this.scroll = 0;
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
        } else if (scrollKeys()) {
          // 已处理
        } else if (matchesKey(data, Key.left) || data === "h") this.switchSection(-1);
        else if (matchesKey(data, Key.right) || data === "l") this.switchSection(1);
        else if (/^[1-7]$/.test(data)) {
          this.section = Number(data) as Section;
          this.scroll = 0;
        } else if (data === "f") {
          this.folded = !this.folded;
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
        else if (matchesKey(data, Key.up) || data === "k")
          this.eventSelected = clampSel(this.eventSelected - 1, events.length);
        else if (matchesKey(data, Key.down) || data === "j")
          this.eventSelected = clampSel(this.eventSelected + 1, events.length);
        else if (matchesKey(data, Key.pageUp))
          this.eventSelected = clampSel(this.eventSelected - page, events.length);
        else if (matchesKey(data, Key.pageDown))
          this.eventSelected = clampSel(this.eventSelected + page, events.length);
        else if (matchesKey(data, Key.home) || data === "g") this.eventSelected = 0;
        else if (matchesKey(data, Key.end) || data === "G")
          this.eventSelected = Math.max(0, events.length - 1);
        else if (matchesKey(data, Key.enter) && events.length > 0) {
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
        } else if (data === "[" || data === "]") {
          this.eventSelected = clampSel(
            this.eventSelected + (data === "]" ? 1 : -1),
            events.length,
          );
          this.scroll = 0;
        }
        break;
      case "composition": {
        const rows = this.composition().rows;
        if (matchesKey(data, Key.escape) || data === "q") this.deps.onClose();
        else if (tab) {
          this.mode = "list";
          this.scroll = 0;
        } else if (data === "s") this.switchSession();
        else if (matchesKey(data, Key.up) || data === "k")
          this.messageSelected = clampSel(this.messageSelected - 1, rows.length);
        else if (matchesKey(data, Key.down) || data === "j")
          this.messageSelected = clampSel(this.messageSelected + 1, rows.length);
        else if (matchesKey(data, Key.pageUp))
          this.messageSelected = clampSel(this.messageSelected - page, rows.length);
        else if (matchesKey(data, Key.pageDown))
          this.messageSelected = clampSel(this.messageSelected + page, rows.length);
        else if (matchesKey(data, Key.home) || data === "g") this.messageSelected = 0;
        else if (matchesKey(data, Key.end) || data === "G")
          this.messageSelected = Math.max(0, rows.length - 1);
        else if (matchesKey(data, Key.enter) && rows.length > 0) {
          this.mode = "actions";
          this.actionSelected = 0;
        }
        break;
      }
      case "actions": {
        const rows = this.composition().rows;
        const r = rows[this.messageSelected];
        const items = r ? actionsFor(events, r, rows.length) : [];
        if (matchesKey(data, Key.escape) || data === "q") this.mode = "composition";
        else if (matchesKey(data, Key.up) || data === "k")
          this.actionSelected = clampSel(this.actionSelected - 1, items.length);
        else if (matchesKey(data, Key.down) || data === "j")
          this.actionSelected = clampSel(this.actionSelected + 1, items.length);
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
        const rows = this.composition().rows;
        if (matchesKey(data, Key.escape) || data === "q") {
          this.mode = "composition";
          this.scroll = 0;
        } else if (scrollKeys()) {
          // 已处理
        } else if (data === "[" || data === "]") {
          this.messageSelected = clampSel(
            this.messageSelected + (data === "]" ? 1 : -1),
            rows.length,
          );
          this.scroll = 0;
        }
        break;
      }
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
    const messages = messagesFor(events, rec);
    const defs = this.deps.tools().filter((d) => rec.request.tools.includes(d.name));
    switch (section) {
      case 1:
        return summaryLines(rec, messages);
      case 2:
        return decisionLines(rec);
      case 3: {
        const start = events.find((e) => e.type === "session/start");
        const sections = start?.type === "session/start" ? start.sections : undefined;
        return sentLines(messages, this.folded, sections);
      }
      case 4:
        return toolLines(defs);
      case 5:
        return wireLines(this.providerFor(rec.index), messages, defs, rec.request.effort);
      case 6:
        return receivedLines(
          rec,
          this.sessionIndex === 0 ? this.deps.rawFor?.(rec.index) : undefined,
        );
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
    const withSession = (head: string[]) =>
      sessionLine ? [head[0] as string, pad(sessionLine), ...head.slice(1)] : head;
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
      const title = `${c.bold(c.ink("Events"))}  ${c.soft(`${events.length} events`)}  ${c.faint("this array is the whole kernel state; the screen, the requests and what the model sees are projections of it")}`;
      const columns = c.faint("  #     time      type                  size   visibility  state");
      const head = withSession([pad(title), pad(columns), pad(rule)]);
      const foot = [
        pad(rule),
        pad(c.faint("↑↓ select · Enter raw JSON · Tab compactions · s session · Esc close")),
      ];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      const start = windowStart(this.eventSelected, events.length, viewport);
      const body = this.cached(cacheKey(`events:${start}:${this.eventSelected}`), () =>
        events
          .slice(start, start + viewport)
          .map((_, i) => pad(eventRow(events, start + i, start + i === this.eventSelected))),
      ).slice();
      return [...head, ...fill(body, viewport), ...foot];
    }

    if (this.mode === "event") {
      const e = events[this.eventSelected];
      const title = `${c.bold(c.ink(`Event #${this.eventSelected}`))}  ${c.ink(e?.type ?? "")}  ${c.faint(e ? clock(e.at) : "")}  ${c.faint(`(${this.eventSelected + 1}/${events.length})`)}`;
      const head = [pad(title), pad(rule)];
      const content = this.cached(cacheKey(`event:${this.eventSelected}`), () =>
        eventLines(events, this.eventSelected).flatMap((l) => wrapTextWithAnsi(l, inner)),
      );
      return this.scrollable(
        head,
        content,
        "↑↓ scroll · PgUp/PgDn page · [ ] prev/next · Esc back",
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
      const { rows: crows, omitted } = this.composition();
      const total = crows.reduce((s, r) => s + messageTokens(r.message), 0);
      const title = `${c.bold(c.ink("Context"))}  ${c.soft(`${crows.length} messages · ≈${total} tok`)}  ${c.faint("what the model sees on the next request · event # is what /edit and /drop take · Tab: requests")}`;
      const columns = c.faint(
        "    #  event wire  role            tokens  stages                 preview",
      );
      const om =
        omitted.length > 0
          ? c.faint(
              `  omitted: ${omitted.filter((o) => o.reason === "covered").length} covered by the summary · ${omitted.filter((o) => o.reason === "dropped").length} dropped`,
            )
          : c.faint("  nothing omitted");
      const head = withSession([pad(title), pad(columns), pad(rule)]);
      const foot = [
        pad(rule),
        pad(om),
        pad(c.faint("↑↓ select · Enter actions · Tab requests · s session · Esc close")),
      ];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      let body: string[];
      if (crows.length === 0) body = [pad(c.faint("no messages yet"))];
      else {
        const start = windowStart(this.messageSelected, crows.length, viewport);
        body = crows
          .slice(start, start + viewport)
          .map((r, i) => pad(compositionRow(r, start + i === this.messageSelected)));
      }
      return [...head, ...fill(body, viewport), ...foot];
    }

    if (this.mode === "actions") {
      const { rows: crows } = this.composition();
      const r = crows[this.messageSelected];
      if (!r) {
        this.mode = "composition";
        return this.render(width);
      }
      const items = actionsFor(events, r, crows.length);
      const sel = Math.min(this.actionSelected, items.length - 1);
      const m = r.message;
      const title = `${c.bold(c.ink(`Message #${r.i}`))}  ${c.ink(roleLabel(m))}  ${c.soft(`event #${r.event} · ≈${messageTokens(m)} tok${m.edited ? " · edited" : ""}`)}`;
      const head = [pad(title), pad(rule)];
      const previewSrc = m.content
        ? m.content.split("\n").slice(0, 6)
        : m.role === "assistant" && m.toolCalls.length > 0
          ? m.toolCalls.map((t) => `» ${t.name} ${JSON.stringify(t.args)}`)
          : ["(empty)"];
      const chosen = items[sel] as ActionItem;
      const body = [
        ...previewSrc.map((l) => pad(c.faint(`  ${truncateToWidth(l, inner - 4, "…")}`))),
        pad(""),
        pad(c.soft("Actions")),
        ...items.map((it, i) =>
          pad(
            i === sel
              ? `  ${c.ink("▸")} ${c.bold(c.ink(it.label.padEnd(24)))} ${c.faint(it.hint)}`
              : `    ${c.soft(it.label.padEnd(24))} ${c.faint(it.hint)}`,
          ),
        ),
        pad(""),
        // 后果一行说不完就换行,不截断:这是面板存在的理由。
        ...wrapTextWithAnsi(
          `${c.soft("If you do this")}  ${c.faint(consequenceOf(chosen.action, r, crows, events, this.deps.currentProvider?.()))}`,
          inner,
        ).map(pad),
      ];
      const foot = [pad(rule), pad(c.faint("↑↓ move · Enter choose · Esc back"))];
      const viewport = rows - head.length - foot.length;
      this.lastViewport = viewport;
      return [...head, ...fill(body.slice(0, viewport), viewport), ...foot];
    }

    if (this.mode === "message") {
      const { rows: crows } = this.composition();
      const r = crows[this.messageSelected];
      if (!r) {
        this.mode = "composition";
        return this.render(width);
      }
      const title = `${c.bold(c.ink(`Message #${r.i}`))}  ${c.ink(roleLabel(r.message))}  ${c.faint(`event #${r.event}`)}  ${c.faint(`(${this.messageSelected + 1}/${crows.length})`)}`;
      const head = [pad(title), pad(rule)];
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

    if (this.mode === "compaction") {
      const comps = this.compactions();
      const rec = comps[this.compactionSelected];
      if (!rec) {
        this.mode = "compactions";
        return this.render(width);
      }
      const tabs = COMPACTION_SECTIONS.map((name, i) => {
        const n = i + 1;
        return n === this.compactionSection
          ? c.bold(c.ink(`[${n} ${name}]`))
          : c.soft(` ${n} ${name} `);
      }).join(" ");
      const title = `${c.bold(c.ink(`Compaction #${rec.n}`))}  ${c.ink(rec.event.strategy ?? "")}  ${c.faint(clock(rec.event.at))}  ${c.faint(`(${this.compactionSelected + 1}/${comps.length})`)}`;
      const head = [pad(title), pad(tabs), pad(rule)];
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
    const tabs = SECTIONS.map((name, i) => {
      const n = i + 1;
      return n === this.section ? c.bold(c.ink(`[${n} ${name}]`)) : c.soft(` ${n} ${name} `);
    }).join(" ");
    const title = `${c.bold(c.ink(`Request #${rec.n}`))}  ${c.ink(rec.request.model)}  ${c.faint(clock(rec.request.at))}  ${c.faint(`(${this.selected + 1}/${recs.length})`)}`;
    const head = [pad(title), pad(tabs), pad(rule)];
    const content = this.cached(
      cacheKey(`detail:${rec.index}:${this.section}:${this.folded}`),
      () => this.sectionLines(rec, this.section).flatMap((l) => wrapTextWithAnsi(l, inner)),
    );
    return this.scrollable(
      head,
      content,
      "↑↓ scroll · PgUp/PgDn · ←→ 1-7 section · [ ] request · f fold · Esc back",
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
    const foot = [pad(rule), pad(`${c.soft(pos)}  ${c.faint(hint)}`)];
    return [...head, ...slice.map(pad), ...foot];
  }
}
