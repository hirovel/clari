// TUI 的共享状态(重构块 2):createTuiApp 组装一个显式的 ctx,拆出去的模块都是接 ctx 的函数。
// 状态按关心的事分组:model(当前模型)、view(屏幕显示状态)、req(请求层记录)、approval(审批)、
// slots(策略槽)、children(子 agent)、inspector(检视器)。函数字段是组装处提供的少数动作。
import type {
  Container,
  Editor,
  Loader,
  Markdown,
  OverlayHandle,
  Text,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import type { Agent } from "../src/agent.js";
import type { ApprovalConfig } from "../src/approval.js";
import type { ToolPromptsConfig } from "../src/config.js";
import type { Price, UsageAccumulator } from "../src/cost.js";
import type { EventLog } from "../src/log.js";
import type { CompactionConfig } from "../src/loop.js";
import type { Message } from "../src/messages.js";
import type { EffortLevel, Provider, ToolDef } from "../src/provider.js";
import type { Tool } from "../src/tools.js";
import type { RequestInspector } from "./inspector.js";
import type { Skill } from "./prompt.js";
import type { PromptTemplate } from "./templates.js";
import { c } from "./theme.js";
import type { TuiAppDeps } from "./tui-app.js";
import type { ChildView } from "./tui-render.js";
import type { ApprovalPrompt } from "./tui-slots.js";

/** 折叠时保留的工具结果行数。 */
export const FOLD_HEAD = 3;
/** 子 agent 尾窗保留的行数。 */
export const CHILD_TAIL = 3;
/** 引导线:子 agent 的每一行都带它,一眼分清层级;不是框线(Q45)。 */
export const GUIDE = `  ${c.faint("┆")} `;
/** 内存里保留的原始流行数上限;超过就整桶淘汰最旧请求的 raw(磁盘旁路文件不受影响)。 */
export const RAW_LINE_CAP = 100_000;

/** 子 agent 视图的三态:尾窗(缺省)→ 全部 → 仅进度。 */
export type ChildMode = "tail" | "all" | "progress";

export type ResultRecord = { name: string; content: string; isError: boolean; durationMs?: number };

export type TuiInfo = TuiAppDeps["info"];

/** 显示状态(Q49):折叠/隐藏只改屏幕,不改日志;切换键重绘已有节点。 */
export type ViewState = {
  foldResults: boolean;
  /** 思考缺省折成一行(首行 + 种类 + 行数),Ctrl+T 展开全文。 */
  showReasoning: boolean;
  childMode: ChildMode;
  /** 首屏(新会话且还没有用户消息时显示),第一条消息一到就撤。 */
  firstRun: Text | undefined;
  streaming: Markdown | undefined;
  streamBuffer: string;
  reasoningView: Text | undefined;
  reasoningBuffer: string;
  loader: Loader | undefined;
  resultNodes: ({ node: Text } & ResultRecord)[];
  reasoningNodes: { node: Text; text: string; kind?: "full" | "summary" }[];
  lastUsage: { inputTokens: number; outputTokens: number } | undefined;
};

/** 请求层记录(Q48):发出每个请求时用的 provider、原始流、接收卡头节点。都不进日志。 */
export type RequestState = {
  count: number;
  lastIndex: number;
  /** 启动时日志里最后一个 request 事件的下标;回放时之前的请求卡只画两行。之后的新请求都比它大。 */
  finalRequestIndex: number;
  /** 最近一次正常步(非压缩)的 request 事件下标。 */
  lastTurnIndex: number;
  lastCompactionIndex: number;
  providersAt: Map<number, Provider>;
  rawAt: Map<number, string[]>;
  rawLines: number;
  receiveHeads: Map<number, Text>;
  predictedAt: Map<number, number>;
  /** 上一次正常步发出的消息:发送卡"未变 / 新增"的比较基线。 */
  lastSent: Message[] | undefined;
  /** 上一次发出的工具定义全文;变了发送卡才标 changed。 */
  lastToolSig: string;
  lastParams: string | undefined;
  lastCard: { node: Text; lines: string[] } | undefined;
};

/** 审批(Q64/Q84):规则对象被策略实现闭包引用,/approve 改它即生效。 */
export type ApprovalState = {
  cfg: ApprovalConfig;
  mode: "all" | "ask" | "policy";
  /** a 键放行的工具,本会话内不再问。 */
  alwaysAllow: Set<string>;
  /** 用户触发的技能声明的 allowed-tools:这一 turn 内免审批。 */
  skillAllow: Set<string>;
  overlay: OverlayHandle | undefined;
  prompt: ApprovalPrompt | undefined;
};

/** 策略槽的当前形态,/slots 显示;每次切换记 session/slot。 */
export type SlotState = {
  state: Record<string, string>;
  /** 工具描述风格的当前形态(Q89):风格加逐工具覆盖。 */
  toolPrompts: ToolPromptsConfig;
};

export type TuiContext = {
  deps: TuiAppDeps;
  log: EventLog;
  tools: Tool[];
  compaction: CompactionConfig;
  agent: Agent;
  tui: TuiMainScreen;
  header: Text;
  transcript: Container;
  live: Container;
  status: Text;
  editor: Editor;
  templates: PromptTemplate[];
  skills: Skill[];
  model: { info: TuiInfo; effortLevels: EffortLevel[] | undefined; contextWindow: number };
  view: ViewState;
  req: RequestState;
  /** 会话累计用量与费用,render 每条事件喂一次;状态栏与 /context 读它,不重扫事件数组。 */
  usage: UsageAccumulator;
  approval: ApprovalState;
  slots: SlotState;
  children: { views: ChildView[]; slots: Map<string, Container> };
  inspector: {
    view: RequestInspector;
    overlay: OverlayHandle | undefined;
    open(opts?: { keep?: boolean }): void;
    close(): void;
  };
  /** 往对话流追加一行说明。 */
  note(text: string): void;
  updateHeader(): void;
  updateStatus(): void;
  showLoader(message: string): void;
  hideLoader(): void;
  /** 自动压缩阈值(token)。 */
  threshold(): number;
  priceFor(model: string): Price | undefined;
  /** 随请求发出的工具定义。 */
  defs(): ToolDef[];
  renderReasoning(s: string, kind?: "full" | "summary"): string;
  onRaw(line: string): void;
  exit(): void;
  stop(): void;
};
