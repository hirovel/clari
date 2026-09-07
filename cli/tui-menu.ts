// 菜单:命令的次级选项不让用户打字,列出来选。ListPicker 包成 Promise,命令实现里就能一层层 await:
// 选槽 → 选值 → 落地。每个选择器一眼能看出是什么(标题说明、行注写当前值)、按键一致(↑↓ 数字 Enter Esc)、
// 底部一行提示。Esc 永远是"回去",不是"退出"。
import { c } from "./theme.js";
import type { TuiContext } from "./tui-context.js";
import { ListPicker, type PickRow } from "./tui-login.js";

export type Picked = { row: PickRow; key: "enter" | "d" };

export const HINT = "↑↓ or 1–9 choose · Enter pick · Esc back";

/** 弹一个列表,resolve 选中的行;Esc 取消 resolve undefined。 */
export function choose(
  ctx: TuiContext,
  title: string,
  rows: PickRow[],
  hint = HINT,
): Promise<Picked | undefined> {
  return new Promise((resolve) => {
    const picker = new ListPicker(
      title,
      rows,
      hint,
      (row, key) => {
        ctx.dialog.close();
        resolve({ row, key });
      },
      () => {
        ctx.dialog.close();
        resolve(undefined);
      },
      () => ctx.tui.requestRender(),
    );
    ctx.dialog.open(picker);
  });
}

/** 标题:粗体名字加淡色说明。 */
export function title(name: string, note: string): string {
  return `${c.bold(c.ink(name))}  ${c.faint(note)}`;
}

/** 是/否确认:危险动作(清空记忆、回退)前问一句,缺省停在 No。 */
export async function confirm(ctx: TuiContext, question: string, yes: string): Promise<boolean> {
  const picked = await choose(ctx, title("Confirm", question), [
    { label: "No", note: "back", current: true },
    { label: "Yes", note: yes },
  ]);
  return picked?.row.label === "Yes";
}

/** 当前值的行注:选中态 ● 与"current"。 */
export function valueRows(
  values: { label: string; note?: string }[],
  current: string | undefined,
): PickRow[] {
  return values.map((v) => ({
    label: v.label,
    ...(v.label === current && { current: true }),
    note: [v.label === current ? "current" : "", v.note ?? ""].filter(Boolean).join(" · "),
  }));
}
