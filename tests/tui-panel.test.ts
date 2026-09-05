// 上下文面板(Ctrl+E)的动作菜单落到编辑命令:compare / restore / rewind / edit-reasoning 四条路径,
// 以及编辑命令走外部编辑器的分支。菜单项按标签定位,不依赖行序。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTuiApp, type TuiApp } from "../cli/tui-app.js";
import { EventLog } from "../src/log.js";
import type { Provider } from "../src/provider.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

const plain = (s: string) => stripAnsi(s);
const doc = (app: TuiApp) => app.lines(120).map(plain).join("\n");
const panel = (app: TuiApp) => plain(app.inspector.lines(120).join("\n"));
const tick = () => new Promise((r) => setTimeout(r, 5));

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  delete process.env.CLARI_EDITOR;
});

/** 从当前行往上找,直到菜单里出现某个标签;返回是否找到(菜单保持打开)。 */
function findRowWith(app: TuiApp, label: string): boolean {
  for (let i = 0; i < 12; i++) {
    app.inspector.key("\r");
    if (panel(app).includes(label)) return true;
    app.inspector.key("\x1b");
    app.inspector.key("\x1b[A");
  }
  return false;
}

/** 菜单已打开:按标签顺序数到目标项,回车执行。 */
function pick(app: TuiApp, label: string): void {
  const lines = panel(app).split("\n");
  const labels = [
    "View full message",
    "Edit content",
    "Edit thinking",
    "Compare with original",
    "Restore original",
    "Drop this message",
    "Rewind to here",
    "Retry last step",
    "Fork here",
  ];
  const present = labels.filter((l) => lines.some((x) => x.includes(l)));
  const idx = present.indexOf(label);
  if (idx < 0) throw new Error(`menu has no ${label}: ${present.join(", ")}`);
  for (let i = 0; i < idx; i++) app.inspector.key("\x1b[B");
  app.inspector.key("\r");
}

describe("面板动作菜单", () => {
  it("compare / restore / rewind 落到事件;Edit thinking 走外部编辑器", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clari-panel-"));
    const append = join(tmp, "append.cjs");
    writeFileSync(
      append,
      'const fs=require("fs");const f=process.argv[2];fs.writeFileSync(f,fs.readFileSync(f,"utf8")+" EDITED");',
    );
    process.env.CLARI_EDITOR = `node "${append}"`;
    const provider: Provider = {
      model: "m",
      async complete() {
        return {
          text: "answer",
          toolCalls: [],
          stopReason: "end",
          reasoning: "deep thought",
          reasoningKind: "full",
        };
      },
    };
    const log = new EventLog();
    const app = createTuiApp({
      terminal: new VirtualTerminal(120, 40),
      log,
      provider,
      tools: [],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      systemPrompt: "s",
      sessionsDir: tmp,
      onExit: () => {},
    });
    await app.submit("first");
    await app.submit("second");
    await app.command("/edit 1 content first (edited)");

    // 找到编辑过的那一行(菜单里有 Compare),依次 compare、restore
    app.inspector.openComposition();
    expect(findRowWith(app, "Compare with original")).toBe(true);
    pick(app, "Compare with original");
    await tick();
    expect(app.inspector.isOpen()).toBe(false);
    expect(doc(app)).toContain("#1.content  original 5 chars → current 14 chars");

    app.inspector.openComposition();
    expect(findRowWith(app, "Restore original")).toBe(true);
    pick(app, "Restore original");
    await tick();
    expect(doc(app)).toContain("restored event #1");

    // 全文思考的助手行:Edit thinking → 外部编辑器追加文字 → 记 context/edit reasoning
    app.inspector.openComposition();
    expect(findRowWith(app, "Edit thinking")).toBe(true);
    pick(app, "Edit thinking");
    await tick();
    const edit = [...log.events].reverse().find((e) => e.type === "context/edit");
    expect(edit).toMatchObject({ field: "reasoning" });
    expect((edit as { value: string }).value.endsWith("EDITED")).toBe(true);
    expect(doc(app)).toContain(".reasoning (");

    // Rewind 到第一条:之后的消息全部丢弃
    app.inspector.openComposition();
    expect(findRowWith(app, "Rewind to here")).toBe(true);
    pick(app, "Rewind to here");
    await tick();
    expect(doc(app)).toContain("rewound to event #");
    expect(log.events.filter((e) => e.type === "context/drop").length).toBeGreaterThan(0);
    app.stop();
  });
});
