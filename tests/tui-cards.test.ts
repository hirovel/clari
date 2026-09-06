// 界面:卡片与屏幕渲染。完整 turn、请求卡与响应卡、折叠与思考、diff 预览、错误行、打断、
// 少见事件与流式思考、changed 行与消息表、文本小工具。
import { rmSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedLine,
  firstRunLines,
  messageRows,
  messageTableLines,
  sendCardLines,
  thinkingLines,
} from "../cli/cards.js";
import { createTuiApp, type TuiApp, type TuiAppDeps, type TuiSettings } from "../cli/tui-app.js";
import { brief, formatArgs, toolCallDetail } from "../cli/tui-format.js";
import { now } from "../src/events.js";
import { EventLog } from "../src/log.js";
import type { Message } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "fake-model",
    async complete(_m, _t, opts) {
      const t = turns[i++];
      if (!t) throw new Error("脚本越界");
      if (t.text && opts?.onDelta) opts.onDelta(t.text); // 模拟流式:整段作为一次增量
      return t;
    },
  };
}

const echo = defineTool({
  name: "echo",
  description: "回显",
  parameters: Type.Object({ text: Type.String() }),
  async execute(args) {
    return `echo:${args.text}`;
  },
});

function boot(provider: Provider, settings?: TuiSettings): { app: TuiApp; term: VirtualTerminal } {
  const term = new VirtualTerminal(100, 40);
  const app = createTuiApp({
    terminal: term,
    log: new EventLog(),
    provider,
    tools: [echo],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 32000 },
    reserveTokens: 32000,
    info: { model: "fake-model", providerName: "fake", sessionFile: "sessions/t.jsonl" },
    ...(settings && { settings }),
    systemPrompt: "sys",
    onExit: () => {},
  });
  return { app, term };
}

const text = (app: TuiApp) => app.lines(100).map(stripAnsi).join("\n");

const plain = (s: string) => stripAnsi(s);
const doc = (app: TuiApp) => app.lines(120).map(plain).join("\n");

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

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  delete process.env.CLARI_EDITOR;
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

const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content, toolCalls: [] });

describe("屏幕:完整 turn、卡片、折叠、diff、错误、打断", () => {
  it("一个完整 turn:用户消息、工具调用与结果、流式回复、状态栏全部呈现且不重复", async () => {
    const { app, term } = boot(
      scripted([
        {
          text: "",
          toolCalls: [{ id: "c1", name: "echo", args: { text: "hi" } }],
          stopReason: "tool",
        },
        {
          text: "**完成**:内容是 hi",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 1200, outputTokens: 40 },
        },
      ]),
    );
    await app.submit("读一下");
    const doc = text(app);

    expect(doc).toContain("clari");
    expect(doc).toContain("fake-model");
    expect(doc).toContain("› 读一下");
    expect(doc).toContain("⚙ echo");
    expect(doc).toContain("✓ echo");
    expect(doc).toContain("echo:hi");
    expect(doc).toContain("完成");
    expect(doc.match(/内容是 hi/g)?.length).toBe(1); // 流式组件被定稿替换,不重复
    expect(doc).toContain("○ idle");
    expect(doc).toContain("1200→40 tok");
    expect(doc).toContain("98% until auto-compaction");

    // 整条渲染管线:经差分渲染写入模拟终端后,屏幕上确实有内容
    app.tui.renderNow(true);
    const screen = (await term.screen()).join("\n");
    expect(screen).toContain("clari");
    expect(screen).toContain("读一下");
    app.stop();
  });

  it("每步一张请求卡与响应卡;Ctrl+O 折叠/展开工具结果;Ctrl+T 展开/收起思考", async () => {
    const long = defineTool({
      name: "long",
      description: "",
      parameters: Type.Object({}),
      async execute() {
        return Array.from({ length: 10 }, (_, i) => `行${i + 1}`).join("\n");
      },
    });
    const term = new VirtualTerminal(100, 40);
    const app = createTuiApp({
      terminal: term,
      log: new EventLog(),
      provider: scripted([
        {
          text: "",
          toolCalls: [{ id: "c1", name: "long", args: {} }],
          stopReason: "tool",
          reasoning: "先拿到输出\n再看结果",
          usage: { inputTokens: 1200, outputTokens: 20 },
        },
        {
          text: "好了",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 1500, outputTokens: 5 },
        },
      ]),
      tools: [long],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 32000 },
      reserveTokens: 32000,
      info: { model: "fake-model", providerName: "fake", sessionFile: "s" },
      systemPrompt: "sys",
      onExit: () => {},
    });
    await app.submit("跑");
    let doc = text(app);
    // 请求卡:头行、changed 行、messages 行(条数与合计);响应卡:头行与 usage 行(实测用量)。
    expect(doc).toContain("Request #1");
    expect(doc).toContain("first request · 2 messages");
    expect(doc).not.toContain("messages   2 · ≈"); // 旧卡折成两行(头 + changed)
    expect(doc).toContain("Response #1");
    expect(doc).toContain("in 1.2k (estimated ≈");
    expect(doc).toContain("Request #2");
    expect(doc).toContain("messages   4 · ≈");
    expect(doc).toContain("same       params · system · tools");
    expect(doc).toContain("行10"); // 默认完整显示
    // 思考缺省折成一行:首行 + 种类与行数;第二行不显示。
    expect(doc).toContain("thinking   先拿到输出");
    expect(doc).toContain("(? · 2 lines · Ctrl+T)");
    expect(doc).not.toContain("再看结果");

    term.feed("\x0f"); // Ctrl+O
    doc = text(app);
    expect(doc).toContain("行3");
    expect(doc).not.toContain("行10");
    expect(doc).toContain("… 7 more lines · Ctrl+O");
    expect(doc).toContain("· tool results folded (Ctrl+O to unfold)");
    term.feed("\x0f");
    expect(text(app)).toContain("行10");

    term.feed("\x14"); // Ctrl+T:展开全文
    doc = text(app);
    expect(doc).toContain("先拿到输出");
    expect(doc).toContain("再看结果");
    expect(doc).toContain("· thinking expanded");
    term.feed("\x14"); // 再按:收回一行
    doc = text(app);
    expect(doc).toContain("先拿到输出");
    expect(doc).not.toContain("再看结果");
    expect(doc).toContain("· thinking collapsed to one line (Ctrl+T)");
    app.stop();
  });

  it("edit 调用显示行级 diff,write 显示前几行与总行数", async () => {
    const { app } = boot(
      scripted([
        {
          text: "",
          toolCalls: [
            {
              id: "c1",
              name: "edit",
              args: { path: "a.ts", oldText: "x = 1\ny = 2", newText: "x = 1\ny = 3" },
            },
            {
              id: "c2",
              name: "write",
              args: {
                path: "b.txt",
                content: Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n"),
              },
            },
          ],
          stopReason: "tool",
        },
        { text: "done", toolCalls: [], stopReason: "end" },
      ]),
    );
    await app.submit("改");
    const doc = text(app);
    expect(doc).toContain("- y = 2");
    expect(doc).toContain("+ y = 3");
    expect(doc).toContain("+ L0");
    expect(doc).toContain("… 20 lines total");
    expect(doc).not.toContain("+ L19");
    app.stop();
  });

  it("请求失败不崩:错误以朱标行呈现,状态回到空闲", async () => {
    const provider: Provider = {
      model: "fake-model",
      async complete() {
        throw new Error("网络断了");
      },
    };
    const { app } = boot(provider);
    await app.submit("x");
    const doc = text(app);
    expect(doc).toContain("Request #1 failed");
    expect(doc).toContain("网络断了");
    expect(doc).toContain("○ idle");
    app.stop();
  });

  it("Esc 通过终端输入通道打断运行中的 turn", async () => {
    const provider: Provider = {
      model: "fake-model",
      async complete(_m, _t, opts) {
        await new Promise<void>((r) =>
          opts?.signal?.addEventListener("abort", () => r(), { once: true }),
        );
        return { text: "半截", toolCalls: [], stopReason: "aborted" };
      },
    };
    const { app, term } = boot(provider);
    const running = app.submit("长任务");
    await new Promise((r) => setImmediate(r));
    expect(text(app)).toContain("● running");
    term.feed("\x1b");
    await running;
    const doc = text(app);
    expect(doc).toContain("— interrupted —");
    expect(doc).toContain("○ idle");
    app.stop();
  });
});

describe("少见事件与流式思考的渲染", () => {
  it("恢复的日志里 session/recovered 与 ext/event(mcp 与未登记来源)各画一行", () => {
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "m", system: "s" });
    log.append({ type: "session/recovered", at: "", droppedBytes: 12, preview: "{" });
    log.append({
      type: "ext/event",
      at: "",
      source: "mcp",
      kind: "server",
      payload: {
        server: "s1",
        phase: "ready",
        transport: "stdio",
        era: "modern",
        protocolVersion: "2026-07-28",
        toolCount: 2,
        listed: 3,
        ms: 7,
      },
    });
    log.append({
      type: "ext/event",
      at: "",
      source: "mcp",
      kind: "rpc",
      payload: { server: "s1", direction: "send", bytes: 1, body: "{}" },
    });
    log.append({ type: "ext/event", at: "", source: "other", kind: "thing", payload: {} });
    log.append({ type: "session/slot", at: "", slot: "execution", value: "parallel" });
    const { app } = bootB(scriptedB([]), {}, log);
    const d = doc(app);
    expect(d).toContain("recovered: dropped 12 bytes");
    expect(d).toContain("mcp s1: ready · stdio · modern 2026-07-28 · 2 tools of 3 listed · 7ms");
    expect(d).toContain("· other/thing");
    expect(d).not.toContain("rpc");
    expect(d).toContain("resumed: 6 events");
    app.stop();
  });

  it("流式思考:定稿带思考时保留节点并可 Ctrl+T 展开;定稿无思考时撤掉节点;task 调用留槽", async () => {
    const { app, term } = bootB(
      scriptedB([
        {
          text: "",
          toolCalls: [{ id: "t1", name: "task", args: { task: "sub job" } }],
          stopReason: "tool",
          reasoning: "thinking hard about it",
          reasoningKind: "full",
        },
        { text: "final", toolCalls: [], stopReason: "end", reasoning: "" },
      ]),
    );
    await app.submit("go");
    let d = doc(app);
    expect(d).toContain("thinking");
    expect(d).toContain("⚙ task");
    term.feed("\x14");
    d = doc(app);
    expect(d).toContain("thinking hard about it");
    expect(d).toContain("final");
    app.stop();
  });
});

describe("Request 卡:changed 行与消息表", () => {
  it("第一次请求说 first request;之后按前缀比出 new / edited / summary,未变超过 3 条折叠", () => {
    const prev = [user("a"), assistant("b"), user("c"), assistant("d"), user("e")];
    const cur = [
      ...prev,
      { ...assistant("d2"), edited: true as const },
      user("f"),
      { ...user("[summary]"), edited: true as const },
    ];
    const provenance = cur.map((_, i) => ({
      event: i + 1,
      stages: i === 5 ? ["edited:text"] : i === 7 ? ["summary(covers #1–#3)"] : [],
    }));
    const rows = messageRows(cur, prev, provenance);
    expect(rows.map((r) => r.state)).toEqual([
      "same",
      "same",
      "same",
      "same",
      "same",
      "edited",
      "new",
      "summary",
    ]);
    const table = plain(messageTableLines(rows).join("\n"));
    expect(table).toContain("…  3 unchanged");
    expect(table).toContain("✎   6  assistant");
    expect(table).toContain("+   7  user");
    expect(table).toContain("≈   8  user");
    const request = {
      type: "request" as const,
      at: now(),
      model: "m",
      reason: "turn" as const,
      messages: cur.length,
      tools: [],
      estimatedTokens: 40,
      threshold: 1000,
    };
    const changed = plain(
      changedLine(
        {
          n: 2,
          request,
          messages: cur,
          previous: prev,
          defs: [],
          toolsUnchanged: true,
          provenance,
        },
        rows,
      ),
    );
    expect(changed).toContain("+1 new");
    expect(changed).toContain("1 edited (#6)");
    expect(changed).toContain("1 summary (#8)");
    expect(changed).toContain("3 recomputed");
    const first = plain(
      sendCardLines({ n: 1, request, messages: cur, defs: [], toolsUnchanged: false }).join("\n"),
    );
    expect(first).toContain("Request #1");
    expect(first).toContain("first request · 8 messages");
    expect(first).toContain("limit");
    expect(first).toContain("tok until the compaction threshold");
  });

  it("思考缺省一行,展开后逐行;首屏五个动词", () => {
    const collapsed = plain(thinkingLines("line one\nline two", "full", false).join("\n"));
    expect(collapsed.split("\n")).toHaveLength(1);
    expect(collapsed).toContain("line one");
    expect(collapsed).toContain("(full · 2 lines · Ctrl+T)");
    const expanded = plain(thinkingLines("line one\nline two", "summary", true).join("\n"));
    expect(expanded).toContain("summary · the model reads the opaque block");
    expect(expanded).toContain("line two");
    const first = plain(firstRunLines().join("\n"));
    for (const verb of ["type", "watch", "inspect", "change", "more"])
      expect(first).toContain(verb);
  });
});

describe("文本小工具", () => {
  it("formatArgs 的四种形态与截断;brief;toolCallDetail 的 write 长文与超长 diff", () => {
    expect(formatArgs({ command: "ls -la" })).toBe("ls -la");
    expect(formatArgs({ path: "a.ts", offset: 5, limit: 3 })).toBe("a.ts  from line 5, 3 lines");
    expect(formatArgs({ path: "a.ts", limit: 3 })).toBe("a.ts  from line 1, 3 lines");
    expect(formatArgs({ task: `${"x".repeat(30)}\nmore`, scope: "fork" })).toBe(
      `scope=fork  ${"x".repeat(24)}…`,
    );
    expect(formatArgs({ other: "y".repeat(200) }).endsWith("…")).toBe(true);
    expect(formatArgs(undefined)).toBe("");
    expect(brief("short")).toBe("short");
    const write = plain(
      toolCallDetail("write", {
        content: Array.from({ length: 15 }, (_, i) => `l${i}`).join("\n"),
      }),
    );
    expect(write).toContain("+ l11");
    expect(write).not.toContain("+ l12");
    expect(write).toContain("… 15 lines total");
    const oldText = Array.from({ length: 70 }, (_, i) => `a${i}`).join("\n");
    const newText = Array.from({ length: 70 }, (_, i) => `b${i}`).join("\n");
    const big = plain(toolCallDetail("edit", { oldText, newText }));
    expect(big).toContain("more changed lines");
    expect(toolCallDetail("bash", { command: "x" })).toBe("");
  });
});
