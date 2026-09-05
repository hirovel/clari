// 屏幕文本的小工具:工具参数的人读形态、edit/write 的改动详情、任务简报、百分比。渲染、审批提示、编辑命令共用。
import { c } from "./theme.js";
import { diffLines, hunks } from "./tools/diff.js";

/** 任务简报的一句话形态,给会话选择器与标题用。 */
export function brief(task: string): string {
  const first = task.split("\n")[0]?.trim() ?? "";
  return first.length > 24 ? `${first.slice(0, 24)}…` : first;
}

/** 工具参数的人读形态:命令与路径直接展示,其余压成紧凑 JSON。 */
export function formatArgs(args: unknown): string {
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

export function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}
