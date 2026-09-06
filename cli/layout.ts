// 版式常量与窄屏模式。标签沟在 80 列以上是 9 列,窄屏缩到 7 列并用短标签;两处读同一个开关。
/** 标签沟宽度:标签占 9 列,再空两格,内容从第 12 列起。 */
export const GUTTER = 9;
/** 窄屏(80 列以下)的标签沟。 */
export const GUTTER_COMPACT = 7;
/** 窄屏阈值(列)。 */
export const COMPACT_BELOW = 80;

let compact = false;

/** 按终端宽度决定是否进入窄屏模式;每次画请求卡时调一次,状态行也读它。 */
export function setCompact(columns: number): void {
  compact = columns < COMPACT_BELOW;
}

export function isCompact(): boolean {
  return compact;
}

export function gutter(): number {
  return compact ? GUTTER_COMPACT : GUTTER;
}

const SHORT: Record<string, string> = {
  messages: "msgs",
  thinking: "think",
  provider: "from",
};

/** 标签在窄屏下的短形;放得下的照旧。 */
export function shortLabel(label: string): string {
  if (!compact || label.length <= GUTTER_COMPACT) return label;
  return SHORT[label] ?? label.slice(0, GUTTER_COMPACT);
}
