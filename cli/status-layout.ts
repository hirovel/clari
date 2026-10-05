// 状态栏的可选内容与四种排版共用一份登记表。这里仅处理显示，不保存运行状态。
import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { STATUS_WIDGETS, type StatusStyle, type StatusWidget } from "../src/status-bar.js";
import { c } from "./theme.js";

/** 宽度不足时换行;固定窗口高度不足时列出省略项,不修改小组件选择。 */
export function renderStatusLayout(
  style: StatusStyle,
  selected: readonly string[],
  values: Partial<Record<StatusWidget, string>>,
  width: number,
  maxRows = Number.POSITIVE_INFINITY,
): string[] {
  const inner = Math.max(1, width - 2);
  const widgets = STATUS_WIDGETS.filter((widget) => selected.includes(widget.id)).flatMap(
    (widget) => {
      const { id } = widget;
      const value = values[id as StatusWidget];
      return value ? [{ ...widget, value }] : [];
    },
  );
  if (!widgets.length || maxRows <= 0) return [];
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
  const render = (count: number): string[] => {
    const lines: string[] = [];
    let line = "";
    for (const widget of widgets.slice(0, count)) {
      const item = decorate(widget.value);
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
  };
  const full = render(widgets.length);
  if (full.length <= maxRows) return full;
  // 保持原顺序和配置;只有当前屏幕收缩。说明具体缺席的内容,不显示不明含义的计数。
  for (let count = widgets.length - 1; count >= 0; count--) {
    const omitted = widgets
      .slice(count)
      .map((widget) => widget.id)
      .join(", ");
    const note = wrapTextWithAnsi(c.faint(`Not shown: ${omitted}`), inner).map((l) => ` ${l}`);
    const lines = [...render(count), ...note];
    if (lines.length <= maxRows) return lines;
  }
  return wrapTextWithAnsi(c.faint("Status shortened · /settings"), inner)
    .slice(0, maxRows)
    .map((line) => ` ${line}`);
}
