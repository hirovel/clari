// 状态栏配置词汇：设置登记、渲染和预览使用同一份名单。
export const STATUS_STYLES = [
  {
    label: "rail",
    name: "Signal rail",
    note: "Thin separators; readings wrap to fit the terminal.",
  },
  { label: "capsules", name: "Capsules", note: "Compact groups with clear edges." },
  { label: "tiles", name: "Instrument tiles", note: "Each reading has its own label." },
  { label: "classic", name: "Classic", note: "Plain text with minimal decoration." },
] as const;
export type StatusStyle = (typeof STATUS_STYLES)[number]["label"];

export const STATUS_WIDGETS = [
  {
    id: "context",
    name: "Context",
    note: "Estimated messages; tools are separate until API measurement.",
  },
  { id: "cache", name: "Cache", note: "Last API-reported cache hit rate; never guessed." },
  { id: "model", name: "Model", note: "The model used for the next request." },
  { id: "effort", name: "Effort", note: "Auto means the request omits an effort level." },
  { id: "compaction", name: "Compaction", note: "Current trigger and its threshold." },
  { id: "tokens", name: "Session tokens", note: "API-reported input and output totals." },
  {
    id: "trend",
    name: "Context trend",
    note: "Recent context-size trend; available after several requests.",
  },
  { id: "queue", name: "Input queue", note: "Queued and paused messages." },
  { id: "elapsed", name: "Elapsed", note: "Time spent in the current turn." },
  { id: "children", name: "Sub-agents", note: "Number of running child tasks." },
  { id: "position", name: "Reading position", note: "Selected request or history-reading state." },
] as const;
export type StatusWidget = (typeof STATUS_WIDGETS)[number]["id"];
export const DEFAULT_STATUS_WIDGETS: StatusWidget[] = [
  "context",
  "cache",
  "model",
  "effort",
  "compaction",
  "queue",
  "position",
];
