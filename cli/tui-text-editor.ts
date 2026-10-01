// 会话文本共用现有编辑组件。编辑期间不改事实,明确应用后才交给调用方。
import { type Component, Editor, Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readClipboardInput } from "./clipboard-input.js";
import { c, editorTheme } from "./theme.js";
import type { TuiContext } from "./tui-context.js";
import { cleanPasteText } from "./tui-format.js";

export class TextEditor implements Component {
  private readonly editor: Editor;
  private readonly initial: string;
  private action = 0; // 文本、应用、取消,只属于本次对话框。
  private hasFocus = false;
  private reading = false;
  private error = "";

  constructor(
    private readonly ctx: TuiContext,
    private readonly title: string,
    private readonly note: string,
    private readonly original: string,
    private readonly apply: (text: string) => string,
  ) {
    this.editor = new Editor(ctx.tui, editorTheme, { paddingX: 1 });
    this.editor.disableSubmit = true;
    this.editor.setText(original);
    // 只打开或撤回修改不能把组件的文本归一化误记成用户编辑。
    this.initial = this.editor.getExpandedText();
  }

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    this.editor.focused = value && this.action === 0;
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  render(width: number): string[] {
    const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(1, width));
    const button = (label: string, index: number) =>
      this.action === index ? c.inverse(` ${label} `) : c.soft(`[${label}]`);
    return [
      ...wrap(c.bold(this.title)),
      ...wrap(c.soft(this.note)),
      ...(this.original !== this.initial
        ? wrap(c.faint("Edited text uses LF and four spaces per tab."))
        : []),
      ...this.editor.render(width),
      ...wrap(`${button(this.reading ? "Apply unavailable" : "Apply", 1)}  ${button("Cancel", 2)}`),
      ...wrap(
        c.faint(
          this.action === 0
            ? "Enter newline · Tab actions · Esc cancel"
            : this.action === 1 && this.reading
              ? "Tab next · Esc cancel"
              : `Enter ${this.action === 1 ? "apply" : "cancel"} · Tab next · Esc cancel`,
        ),
      ),
      ...wrap(c.faint("Ctrl+V / Alt+V paste in text")),
      ...(this.reading ? wrap(c.soft("Reading clipboard… You can keep editing or cancel.")) : []),
      ...(this.error ? wrap(c.zhu(this.error)) : []),
    ];
  }

  private insert(text: string): void {
    // 两种粘贴共用正文路径,不折叠、不识别图片路径,不接受终端控制序列。
    this.editor.insertTextAtCursor(cleanPasteText(text));
  }

  private async paste(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    this.error = "";
    this.ctx.tui.requestRender();
    try {
      const value = await (this.ctx.deps.readClipboard ?? readClipboardInput)();
      if (this.ctx.dialog.component !== this) return;
      if (value.text) this.insert(value.text);
      else
        this.error = value.image
          ? "Text only here. Add images from the message input."
          : "No text on the clipboard.";
    } catch (error) {
      if (this.ctx.dialog.component === this)
        this.error = `Paste failed: ${(error as Error).message}. Text unchanged.`;
    } finally {
      this.reading = false;
      if (this.ctx.dialog.component === this) this.ctx.tui.requestRender();
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.ctx.dialog.close();
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, "shift+tab")) {
      this.action = (this.action + (matchesKey(data, Key.tab) ? 1 : 2)) % 3;
    } else if (this.action === 0) {
      if (matchesKey(data, Key.ctrl("v")) || matchesKey(data, Key.alt("v"))) void this.paste();
      else if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~"))
        this.insert(data.slice(6, -6));
      else if (matchesKey(data, Key.enter)) this.editor.insertTextAtCursor("\n");
      else this.editor.handleInput(data);
    } else if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
      this.action = this.action === 1 ? 2 : 1;
    } else if (matchesKey(data, Key.enter)) {
      if (this.action === 2) {
        this.ctx.dialog.close();
        return;
      }
      if (this.reading) return;
      if (this.editor.getExpandedText() === this.initial) {
        this.ctx.dialog.close();
        return;
      }
      try {
        if (this.ctx.agent.running)
          throw new Error("Cannot apply while running; wait for this turn to finish.");
        const result = this.apply(this.editor.getExpandedText());
        this.ctx.dialog.close();
        if (result) this.ctx.note(result);
      } catch (error) {
        this.error = (error as Error).message;
      }
    }
    this.editor.focused = this.hasFocus && this.action === 0;
    this.ctx.tui.requestRender();
  }
}
