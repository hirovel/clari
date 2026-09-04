// 子 agent 视图(Q62)与压缩对照(Q63)。
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  collectCompactions,
  compactionLines,
  compactionRow,
  RequestInspector,
} from "../cli/inspector.js";
import { childEventLines, createTuiApp } from "../cli/tui-app.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { type ChildInfo, createTaskTool } from "../src/subagent.js";
import { defineTool } from "../src/tools.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

/** 父与子共用一个脚本 provider:父先派任务,子跑两步,父收尾。 */
function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "fake",
    wire: (messages, tools) => ({ model: "fake", messages, tools }),
    async complete() {
      const t = turns[i++];
      if (!t) throw new Error("脚本越界");
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

describe("子 agent 视图(Q62)", () => {
  it("task 工具把子日志与 callId 交给界面;子块挂在调用行下,尾窗、进度、完成态、会话切换", async () => {
    const provider = scripted([
      // 父:派任务
      {
        text: "交给子",
        toolCalls: [{ id: "t1", name: "task", args: { task: "统计 echo 两次\n第二行说明" } }],
        stopReason: "tool",
      },
      // 子:两步
      {
        text: "子先回显",
        toolCalls: [{ id: "c1", name: "echo", args: { text: "one" } }],
        stopReason: "tool",
        usage: { inputTokens: 300, outputTokens: 9 },
      },
      {
        text: "子完成:one",
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 420, outputTokens: 5 },
      },
      // 父:收尾
      { text: "父收到", toolCalls: [], stopReason: "end" },
    ]);
    const log = new EventLog();
    const children: ChildInfo[] = [];
    let app: ReturnType<typeof createTuiApp> | undefined;
    const task = createTaskTool({
      parent: log,
      provider,
      tools: [echo],
      onChild: (child) => {
        children.push(child);
        app?.attachChild(child);
      },
    });
    app = createTuiApp({
      terminal: new VirtualTerminal(110, 50),
      log,
      provider,
      tools: [echo, task],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 20000 },
      reserveTokens: 20000,
      info: { model: "fake", providerName: "p", sessionFile: "s" },
      systemPrompt: "sys",
      onExit: () => {},
    });
    await app.submit("开始");
    const doc = app.lines(110).map(stripAnsi).join("\n");

    expect(children).toHaveLength(1);
    expect(children[0]?.callId).toBe("t1");
    expect(children[0]?.scope).toBe("taskOnly");
    expect(children[0]?.index).toBe(1);
    expect(app.children()).toHaveLength(1);

    // 调用行、引导线、完成态进度、尾窗提示
    expect(doc).toContain("⚙ task  统计 echo 两次");
    expect(doc).toContain("┆ ✓ done · step 2 · 1 tool calls");
    expect(doc).toContain("420 tok");
    expect(doc).toContain("┆ sub-session"); // 完成后收起为一行
    expect(doc).toContain("✓ task"); // 父的工具结果
    expect(doc).toContain("子完成:one");
    expect(doc).toContain("父收到");

    // Ctrl+O 循环到"全部":子的每一行都带引导线
    app.toggleFold();
    const all = app.lines(110).map(stripAnsi).join("\n");
    expect(all).toContain('┆ ⚙ echo  {"text":"one"}');
    expect(all).toContain("┆ ✓ echo");
    expect(all).toContain("┆ 子先回显");

    // 检视器:s 切到子会话,请求列表与事件视图作用在子的数组上
    app.inspector.open();
    let insp = app.inspector.lines(110).map(stripAnsi).join("\n");
    expect(insp).toContain("▸ main");
    expect(insp).toContain("sub #1 统计 echo 两次");
    expect(insp).toContain("2 requests");
    app.inspector.key("s");
    insp = app.inspector.lines(110).map(stripAnsi).join("\n");
    expect(insp).toContain("▸ sub #1");
    expect(insp).toContain("2 requests");
    app.inspector.key("\r");
    app.inspector.key("5");
    insp = app.inspector.lines(110).map(stripAnsi).join("\n");
    expect(insp).toContain('"model": "fake"'); // 子会话的线路正文用当前 provider 重建
    app.inspector.key("\x1b");
    app.inspector.key("\t");
    insp = app.inspector.lines(110).map(stripAnsi).join("\n");
    expect(insp).toContain("Events");
    expect(insp).toContain("▸ sub #1");
    app.inspector.close();
    app.stop();
  });

  it("childEventLines:与主屏同一套记号,思考淡字,结果带行数与耗时", () => {
    const lines = childEventLines({
      type: "assistant/message",
      at: "t",
      text: "第一行\n第二行",
      reasoning: "想一下",
      toolCalls: [{ id: "x", name: "bash", args: { command: "ls" } }],
      stopReason: "tool",
    }).map(stripAnsi);
    expect(lines).toEqual(["想一下", "第一行", "第二行", "⚙ bash  ls"]);
    const result = childEventLines({
      type: "tool/result",
      at: "t",
      callId: "x",
      name: "bash",
      content: "a\nb",
      isError: false,
      durationMs: 12,
    }).map(stripAnsi);
    expect(result[0]).toBe("✓ bash  2 lines · 12ms");
    expect(
      childEventLines({
        type: "request",
        at: "t",
        model: "m",
        messages: 1,
        tools: [],
        estimatedTokens: 1,
        reason: "turn",
      }),
    ).toEqual([]);
  });
});

describe("压缩对照(Q63)", () => {
  const events: AgentEvent[] = [
    { type: "session/start", at: "t", model: "m", system: "S" },
    { type: "user/message", at: "t", text: "开始" },
    {
      type: "request",
      at: "t",
      model: "m",
      messages: 2,
      tools: [],
      estimatedTokens: 5,
      reason: "turn",
    },
    {
      type: "assistant/message",
      at: "t",
      text: "",
      toolCalls: [{ id: "c1", name: "bash", args: { command: "cat big" } }],
      stopReason: "tool",
    },
    {
      type: "tool/result",
      at: "t",
      callId: "c1",
      name: "bash",
      content: "x".repeat(4000),
      isError: false,
    },
    { type: "assistant/message", at: "t", text: "看完了", toolCalls: [], stopReason: "end" },
    { type: "user/message", at: "t", text: "继续" },
    {
      type: "compaction",
      at: "t",
      summary: "摘要:看过 big 文件。",
      coversFrom: 2,
      coversUpTo: 6,
      tokensBefore: 1200,
      usage: { inputTokens: 1100, outputTokens: 20 },
      latencyMs: 900,
      strategy: "llmSummarize(structuredFull, replay)",
    },
    {
      type: "tool/result",
      at: "t",
      callId: "c9",
      name: "read",
      content: "y".repeat(800),
      isError: false,
    },
    {
      type: "compaction",
      at: "t",
      cleared: [8],
      strategy: "clearToolResults(keepRecent=0, clearAtLeast=1)",
    },
  ];

  it("collectCompactions:覆盖的模型可见事件、token、摘要 token、清除条目", () => {
    const recs = collectCompactions(events);
    expect(recs).toHaveLength(2);
    const [a, b] = recs;
    if (!a || !b) throw new Error("应有两条");
    expect(a.covered).toEqual([3, 4, 5]); // request(2) 只给人看,不算
    expect(a.coveredTokens).toBeGreaterThan(1000);
    expect(a.summaryTokens).toBeGreaterThan(0);
    expect(a.cleared).toEqual([]);
    expect(b.covered).toEqual([]);
    expect(b.cleared).toEqual([8]);
    expect(b.clearedTokens).toBe(200);
  });

  it("列表行与四个分区:对照数字、原文全文、摘要、被清除的工具结果", () => {
    const [a, b] = collectCompactions(events);
    if (!a || !b) throw new Error("应有两条");
    const row = stripAnsi(compactionRow(a, true));
    expect(row).toContain("#1");
    expect(row).toContain("llmSummarize(structuredFull, replay)");
    expect(row).toContain("original #3–#5 (3 events");
    expect(row).toContain("→ summary");
    const overview = compactionLines(events, a, 1).map(stripAnsi).join("\n");
    expect(overview).toContain("ratio");
    expect(overview).toContain("summary request");
    expect(overview).toContain("Nothing was deleted");
    const original = compactionLines(events, a, 2).map(stripAnsi).join("\n");
    expect(original).toContain("#4 tool:bash");
    expect(original).toContain("x".repeat(100));
    expect(original).toContain("看完了");
    expect(compactionLines(events, a, 3).map(stripAnsi).join("\n")).toContain(
      "摘要:看过 big 文件。",
    );
    expect(compactionLines(events, a, 4).map(stripAnsi).join("\n")).toContain(
      "cleared no tool results",
    );
    expect(compactionLines(events, b, 4).map(stripAnsi).join("\n")).toContain("#8 tool:read");
    expect(compactionLines(events, b, 2).map(stripAnsi).join("\n")).toContain(
      "has no summary (clear only)",
    );
  });

  it("检视器:Tab 两次进压缩对照,Enter 看详情,分区切换,Esc 返回", () => {
    const log = new EventLog();
    for (const e of events) log.append(e);
    const insp = new RequestInspector({
      events: () => log.events,
      providerFor: () => undefined,
      tools: () => [],
      rows: () => 30,
      onClose: () => {},
      requestRender: () => {},
    });
    insp.reset();
    insp.handleInput("\t");
    insp.handleInput("\t");
    expect(insp.currentMode).toBe("compactions");
    let doc = insp.render(120).map(stripAnsi).join("\n");
    expect(doc).toContain("Compactions");
    expect(doc).toContain("2 compactions");
    expect(doc).toContain("▸ #2");
    insp.handleInput("g");
    insp.handleInput("\r");
    doc = insp.render(120).map(stripAnsi).join("\n");
    expect(insp.currentMode).toBe("compaction");
    expect(doc).toContain("Compaction #1");
    expect(doc).toContain("[1 compare]");
    insp.handleInput("2");
    expect(insp.render(120).map(stripAnsi).join("\n")).toContain(
      "The 3 model-visible events the summary replaced",
    );
    insp.handleInput("\x1b[C");
    expect(insp.render(120).map(stripAnsi).join("\n")).toContain("[3 summary]");
    insp.handleInput("\x1b");
    expect(insp.currentMode).toBe("compactions");
    insp.handleInput("\t");
    expect(insp.currentMode).toBe("composition"); // 第四视图:组装(Q81)
    insp.handleInput("	");
    expect(insp.currentMode).toBe("list");
  });
});
