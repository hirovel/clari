// 屏幕文本的小工具:工具参数的人读形态、edit/write 的改动详情、任务简报、百分比。渲染、审批提示、编辑命令共用。
import { fileUrl, osc8 } from "./terminal-extras.js";
import { c } from "./theme.js";
import { diffLines, hunks } from "./tools/diff.js";

/** 单行设置输入保留粘贴正文,过滤终端标记和控制字符。 */
export function printableInput(data: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 过滤终端粘贴标记和控制序列。
  const ansi = /\u001b\[[0-9;]*[A-Za-z~]/g;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 单行输入拒绝控制字符。
  const controls = /[\u0000-\u001f\u007f]/g;
  return data.replace(ansi, "").replace(controls, "");
}

/** 任务简报的一句话形态,给会话选择器与标题用。 */
export function brief(task: string): string {
  const first = task.split("\n")[0]?.trim() ?? "";
  return first.length > 24 ? `${first.slice(0, 24)}…` : first;
}

/** 工具参数的人读形态:命令与路径直接展示,其余压成紧凑 JSON。路径是 OSC 8 链接,支持的终端里可点击打开。 */
export function formatArgs(args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  let s: string;
  if (typeof a.command === "string") s = a.command;
  else if (typeof a.path === "string") {
    const range =
      typeof a.offset === "number" || typeof a.limit === "number"
        ? `  from line ${a.offset ?? 1}${typeof a.limit === "number" ? `, ${a.limit} lines` : ""}`
        : "";
    const shown = a.path.length > 120 ? `${a.path.slice(0, 120)}…` : a.path;
    return `${osc8(shown, fileUrl(a.path))}${range}`;
  } else if (typeof a.task === "string") {
    s = `${a.scope ? `scope=${a.scope}  ` : ""}${brief(a.task)}`;
  } else if (Array.isArray(a.items)) {
    const items = a.items as { status?: string }[];
    const done = items.filter((i) => i.status === "done").length;
    s = `${items.length} step${items.length === 1 ? "" : "s"} · ${done} done`;
  } else s = JSON.stringify(args) ?? "";
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** 最多展示的改动行数;超出的折成一行计数。 */
const DETAIL_MAX_LINES = 60;

const DEL = (s: string) => c.delBg(c.zhu(s));
const ADD = (s: string) => c.addBg(c.green(s));

/** edit → 行级 diff(- 朱字深红底 / + 绿字深绿底 / 上下文淡字无底);write → 前几行加总行数。其它工具无详情。 */
export function toolCallDetail(
  name: string,
  args: unknown,
  view: "preview" | "full" = "preview",
): string {
  const a = (args ?? {}) as Record<string, unknown>;
  let lines: string[] = [];
  if (name === "edit" && typeof a.oldText === "string" && typeof a.newText === "string") {
    lines = hunks(diffLines(a.oldText, a.newText)).map((l) => {
      switch (l.kind) {
        case "-":
          return DEL(`- ${l.text}`);
        case "+":
          return ADD(`+ ${l.text}`);
        case "…":
          return c.faint(`  ${l.text}`);
        default:
          return c.faint(`  ${l.text}`);
      }
    });
  } else if (name === "write" && typeof a.content === "string") {
    const all = a.content.split("\n");
    lines = (view === "full" ? all : all.slice(0, 12)).map((l) => ADD(`+ ${l}`));
    if (view === "preview" && all.length > 12) lines.push(c.faint(`… ${all.length} lines total`));
  } else if (name === "plan" && Array.isArray(a.items)) {
    // 计划整张可见:进行中的是墨色,其余淡色。
    const MARK: Record<string, string> = {
      pending: "[ ]",
      in_progress: "[>]",
      done: "[x]",
      cancelled: "[-]",
    };
    lines = (a.items as { text?: string; status?: string }[]).map((it, i) => {
      const line = `${MARK[it.status ?? "pending"] ?? "[ ]"} ${i + 1}. ${it.text ?? ""}`;
      return it.status === "in_progress" ? c.ink(line) : c.faint(line);
    });
  }
  if (lines.length === 0) return "";
  if (view === "preview" && lines.length > DETAIL_MAX_LINES) {
    const rest = lines.length - DETAIL_MAX_LINES;
    lines = [...lines.slice(0, DETAIL_MAX_LINES), c.faint(`… ${rest} more changed lines`)];
  }
  return lines.join("\n");
}

export function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}
