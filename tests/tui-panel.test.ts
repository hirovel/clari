// 界面:上下文面板(Ctrl+E)。动作按消息类型增减与后果预告;Enter 出菜单再执行;
// compare / restore / rewind / edit-reasoning / drop / fork / retry 落到事件;编辑走外部编辑器。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { actionsFor, compositionRows, consequenceOf } from "../cli/inspector.js";
import { createTuiApp, type TuiApp, type TuiAppDeps } from "../cli/tui-app.js";
import { type AgentEvent, now } from "../src/events.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
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

function scriptedB(turns: AssistantTurn[], extra: Partial<Provider> = {}): Provider {
  let i = 0;
  return {
    model: "m",
    async complete(_m, _t, opts) {
      const t = turns[i++] ?? { text: "done", toolCalls: [], stopReason: "end" };
      if (t.reasoning && opts?.onReasoning) opts.onReasoning(t.reasoning.slice(0, 2));
      return t;
    },
    ...extra,
  };
}

const echoB = defineTool({
  name: "echo",
  description: "Echo.",
  parameters: Type.Object({ text: Type.String() }),
  async execute(a) {
    return a.text;
  },
});

function bootB(provider: Provider, over: Partial<TuiAppDeps> = {}, log = new EventLog()) {
  const term = new VirtualTerminal(120, 40);
  const exits: number[] = [];
  const app = createTuiApp({
    terminal: term,
    log,
    provider,
    tools: [echoB],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
    reserveTokens: 1000,
    info: { model: "m", providerName: "p", sessionFile: "s" },
    systemPrompt: "s",
    onExit: () => exits.push(1),
    ...over,
  });
  return { app, term, log, exits };
}

describe("上下文面板的动作与后果", () => {
  it("动作按消息类型与编辑状态增减;后果算出重算条数、缓存失效点、Anthropic 丢的思考块", () => {
    const events: AgentEvent[] = [
      { type: "session/start", at: now(), model: "m", system: "sys" },
      { type: "user/message", at: now(), text: "q" },
      {
        type: "assistant/message",
        at: now(),
        text: "a",
        toolCalls: [{ id: "c1", name: "read", args: {} }],
        stopReason: "tool",
        reasoning: "why",
        reasoningKind: "full",
        opaque: { kind: "anthropic-thinking", model: "m", blocks: [] },
      },
      {
        type: "tool/result",
        at: now(),
        callId: "c1",
        name: "read",
        content: "file",
        isError: false,
      },
      { type: "assistant/message", at: now(), text: "done", toolCalls: [], stopReason: "end" },
      { type: "context/edit", at: now(), target: 3, field: "content", value: "file (edited)" },
    ];
    const { rows } = compositionRows(events);
    const asst = rows.find((r) => r.event === 2) as (typeof rows)[number];
    const tool = rows.find((r) => r.event === 3) as (typeof rows)[number];
    const last = rows[rows.length - 1] as (typeof rows)[number];
    expect(actionsFor(events, asst, rows.length).map((a) => a.action)).toEqual([
      "view",
      "edit",
      "edit-reasoning",
      "drop",
      "rewind",
      "retry",
      "fork",
    ]);
    expect(actionsFor(events, tool, rows.length).map((a) => a.action)).toEqual([
      "view",
      "edit",
      "compare",
      "restore",
      "rewind",
      "retry",
      "fork",
    ]);
    expect(actionsFor(events, last, rows.length).map((a) => a.action)).not.toContain("rewind");
    const anthropic = {
      model: "m",
      fields: { protocol: "anthropic", sends: [], reads: [], ignores: [] },
      complete: async () => ({}) as AssistantTurn,
    } as unknown as Provider;
    const edit = consequenceOf("edit", asst, rows, events, anthropic);
    expect(edit).toContain("2 messages after #2 recomputed");
    expect(edit).toContain("cache miss from #2 on");
    expect(edit).toContain("Anthropic drops 1 thinking block");
    expect(consequenceOf("drop", asst, rows, events)).toContain("with its 1 tool result");
    expect(consequenceOf("rewind", tool, rows, events)).toContain(
      "the next request starts from #3",
    );
    expect(consequenceOf("view", tool, rows, events)).toBe("read-only · nothing changes");
  });

  it("界面:Enter 出菜单再 Enter 执行;/compare /restore /rewind 落到事件;首屏随第一条消息撤掉;? 列快捷键", async () => {
    const provider: Provider = {
      model: "m",
      async complete(): Promise<AssistantTurn> {
        return { text: "reply", toolCalls: [], stopReason: "end" };
      },
    };
    const echo = defineTool({
      name: "echo",
      description: "Echo.",
      parameters: Type.Object({ text: Type.String() }),
      async execute(a) {
        return a.text;
      },
    });
    const log = new EventLog();
    const app = createTuiApp({
      terminal: new VirtualTerminal(120, 40),
      log,
      provider,
      tools: [echo],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      systemPrompt: "s",
      onExit: () => {},
    });
    let doc = plain(app.lines(120).join("\n"));
    expect(doc).toContain("Ask anything");
    expect(doc).toContain("? shortcuts");
    await app.submit("first");
    await app.submit("second");
    doc = plain(app.lines(120).join("\n"));
    expect(doc).not.toContain("Ask anything");
    expect(doc).toContain("› second");
    // 直印:正常追加不印变化说明,没有请求卡
    expect(doc).not.toContain("Request #");
    expect(doc).not.toContain("recomputed");

    // Ctrl+E → 上下文面板;选最后一条(事件 #6,request 事件也占号)→ Enter 出菜单;↓ 到 Edit 看后果。
    app.inspector.openComposition();
    app.inspector.key("\r");
    let ins = plain(app.inspector.lines(120).join("\n"));
    expect(ins).toContain("Actions");
    expect(ins).toContain("View full message");
    expect(ins).toContain("If you do this");
    expect(ins).toContain("read-only · nothing changes");
    app.inspector.key("\x1b[B");
    ins = plain(app.inspector.lines(120).join("\n"));
    expect(ins).toContain("Edit content");
    expect(ins).toContain("cache miss from #6 on");
    app.inspector.key("\x1b");
    app.inspector.close();

    // 命令:编辑 #1 的 content,再 compare 与 restore;rewind 到 #1 丢掉之后的三条。
    await app.command("/edit 1 content first (edited)");
    await app.command("/edit compare 1");
    doc = plain(app.lines(120).join("\n"));
    expect(doc).toContain("#1.content  original 5 chars → current 14 chars");
    expect(doc).toContain("- first");
    expect(doc).toContain("+ first (edited)");
    await app.command("/edit restore 1");
    const restore = log.events.at(-1);
    expect(restore?.type).toBe("context/edit");
    expect((restore as { value: string }).value).toBe("first");
    await app.command("/edit rewind 1");
    const drops = log.events.filter((e) => e.type === "context/drop");
    expect(drops.map((e) => (e as { target: number }).target)).toEqual([3, 4, 6]);
    doc = plain(app.lines(120).join("\n"));
    expect(doc).toContain("rewound to event #1: dropped 3 messages");
    app.stop();
  });
});

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

describe("/retry 与面板的 drop、fork", () => {
  it("/retry:运行中拒绝;空闲时丢掉最后一步重问;上下文面板的 drop 与 fork 动作", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clari-tui-"));
    const { app, log } = bootB(
      scriptedB([
        { text: "first answer", toolCalls: [], stopReason: "end" },
        { text: "second answer", toolCalls: [], stopReason: "end" },
        { text: "third", toolCalls: [], stopReason: "end" },
      ]),
      { sessionsDir: tmp },
    );
    await app.submit("q");
    expect(doc(app)).toContain("first answer");
    await app.command("/edit retry");
    expect(doc(app)).toContain("second answer");
    expect(log.events.some((e) => e.type === "context/drop")).toBe(true);
    // 面板:最后一条(用户消息 q 之后是助手回复)→ Enter 出菜单 → ↓↓ 到 Drop → Enter
    app.inspector.openComposition();
    app.inspector.key("\r");
    let ins = plain(app.inspector.lines(120).join("\n"));
    expect(ins).toContain("Drop this message");
    app.inspector.key("\x1b[B");
    app.inspector.key("\x1b[B");
    app.inspector.key("\r");
    await tick();
    expect(app.inspector.isOpen()).toBe(false);
    expect(doc(app)).toContain("dropped event #");
    // 再开面板,菜单最后一项是 Fork
    app.inspector.openComposition();
    app.inspector.key("\r");
    ins = plain(app.inspector.lines(120).join("\n"));
    const items = ins
      .split("\n")
      .filter((l) =>
        /Fork here|Retry last step|Drop this message|Edit content|View full message/.test(l),
      );
    expect(items.length).toBeGreaterThan(2);
    for (let i = 0; i < 6; i++) app.inspector.key("\x1b[B");
    app.inspector.key("\r");
    await tick();
    expect(doc(app)).toContain("forked: first");
    app.stop();
  });
});
