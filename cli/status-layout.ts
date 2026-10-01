// 状态栏的可选内容与四种排版共用一份登记表。这里仅处理显示，不保存运行状态。
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { STATUS_WIDGETS, type StatusStyle, type StatusWidget } from "../src/status-bar.js";
import { c } from "./theme.js";

/** 当前数据直接投影为片段；选中的片段会换行，不因为宽度不足而消失。 */
export function renderStatusLayout(
  style: StatusStyle,
  selected: readonly string[],
  values: Partial<Record<StatusWidget, string>>,
  width: number,
): string[] {
  const inner = Math.max(1, width - 2);
  const parts = STATUS_WIDGETS.filter((widget) => selected.includes(widget.id)).flatMap(
    ({ id }) => {
      const value = values[id as StatusWidget];
      return value ? [value] : [];
    },
  );
  if (!parts.length) return [];
  const decorate = (part: string) => {
    switch (style) {
      case "capsules":
        return c.soft(`〔 ${part} 〕`);
      case "tiles":
        return c.soft(`▏ ${part}`);
      case "rail":
        return c.soft(`─ ${part}`);
      case "classic":
        return c.soft(part);
    }
  };
  const separator = style === "classic" ? c.faint(" · ") : "  ";
  const lines: string[] = [];
  let line = "";
  for (const part of parts) {
    const item = decorate(part);
    const next = line ? `${line}${separator}${item}` : item;
    if (line && visibleWidth(next) > inner) {
      lines.push(` ${line}`);
      line = item;
    } else line = next;
    if (visibleWidth(line) > inner) {
      lines.push(...wrapTextWithAnsi(line, inner).map((wrapped) => ` ${wrapped}`));
      line = "";
    }
  }
  if (line) lines.push(` ${line}`);
  return lines;
}
