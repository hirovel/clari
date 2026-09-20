import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { fmtMs, fmtTok, RequestInspector } from "../cli/inspector.js";
import { cacheUsageLines } from "../cli/inspector-format.js";
import { messagesFor } from "../cli/inspector-requests.js";
import type { RequestRecording } from "../cli/session-records.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { runTurn } from "../src/loop.js";
import type { AssistantTurn, Provider, ToolDef } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
import { stripAnsi } from "./helpers/virtual-terminal.js";

const echo = defineTool({
  name: "echo",
  description: "回显文本",
  parameters: Type.Object({ text: Type.String() }),
  async execute(args) {
    return `echo:${args.text}`;
  },
});
const defs: ToolDef[] = [
  { name: echo.name, description: echo.description, parameters: echo.parameters },
];

function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "fake",
    wire: (messages, tools) => ({ model: "fake", messages, tools, stream: true }),
    async complete() {
      const t = turns[i++];
      if (!t) throw new Error("脚本越界");
      return t;
    },
  };
}

async function session(): Promise<{ log: EventLog; provider: Provider }> {
  const log = new EventLog();
  log.append({
    type: "session/start",
    at: "2026-09-01T09:00:00.000Z",
    model: "fake",
    system: "你是助手",
    sections: [
      { name: "角色与规则", chars: 4 },
      { name: "环境", chars: 60 },
    ],
  });
  log.append({ type: "user/message", at: "2026-09-01T09:00:01.000Z", text: "读一下" });
  const provider = scripted([
    {
      text: "先看看",
      toolCalls: [{ id: "c1", name: "echo", args: { text: "hi" } }],
      stopReason: "tool",
      usage: { inputTokens: 1200, outputTokens: 30, cacheReadTokens: 800 },
      reasoning: "用户想读内容",
    },
    {
      text: "完成",
      toolCalls: [],
      stopReason: "end",
      usage: { inputTokens: 1500, outputTokens: 10 },
    },
  ]);
  await runTurn({
    log,
    provider,
    tools: [echo],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 20000 },
  });
  return { log, provider };
}

function build(log: EventLog, provider: Provider, rows = 30, currentDefs = defs) {
  let closed = 0;
  const insp = new RequestInspector({
    events: () => log.events,
    providerFor: () => provider,
    tools: () => currentDefs,
    rows: () => rows,
    sessions: () => [
      {
        name: "main",
        events: log.events,
        recordingFor: (i) =>
          i === 2
            ? {
                bodies: [],
                attempts: [
                  { n: 1, status: 200, state: "complete", response: "data: {}\ndata: [DONE]" },
                ],
              }
            : undefined,
      },
    ],
    onClose: () => {
      closed += 1;
    },
    requestRender: () => {},
  });
  insp.reset();
  const text = (width = 100) => insp.render(width).map(stripAnsi).join("\n");
  return { insp, text, closed: () => closed };
}

describe("请求检视器", () => {
  it("格式化:token 与耗时", () => {
    expect(fmtTok(999)).toBe("999");
    expect(fmtTok(1200)).toBe("1.2k");
    expect(fmtTok(48200)).toBe("48k");
    expect(fmtTok(undefined)).toBe("—");
    expect(fmtMs(80)).toBe("80ms");
    expect(fmtMs(2340)).toBe("2.3s");
    expect(
      cacheUsageLines({ inputTokens: 1200, outputTokens: 5000, cacheReadTokens: 800 })[0],
    ).toContain("66.7%");
    expect(
      cacheUsageLines({ inputTokens: 1200, outputTokens: 0, cacheReadTokens: 0 })[0],
    ).toContain("0.0%");
    expect(cacheUsageLines({ inputTokens: 1200, outputTokens: 0 })).toEqual([
      "Cache hit: not reported",
    ]);
    expect(
      cacheUsageLines({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 101 })[0],
    ).toContain("unavailable");
  });

  it("列表:一行一请求,含规模、实测、缓存、停止原因;行数恰为终端高度", async () => {
    const { log, provider } = await session();
    const { insp, text } = build(log, provider, 30);
    const doc = text();
    expect(insp.render(100)).toHaveLength(30);
    expect(doc).toContain("Requests");
    expect(doc).toContain("2 requests");
    expect(doc).toContain("#1");
    expect(doc).toContain("2 msgs");
    expect(doc).toContain("→ 1.2k (cache 800)  +30");
    expect(doc).toContain("tool");
    expect(doc).toContain("#2");
    expect(doc).toContain("4 msgs");
    expect(doc).toContain("end");
    expect(doc).toContain("▸ #2"); // 打开时选中最新一条
  });

  it("详情六分区:概要 / 决策 / 发送(折叠可切) / 工具定义 / 线路 JSON / 接收", async () => {
    const { log, provider } = await session();
    const { insp, text } = build(log, provider, 40);
    insp.handleInput("g"); // 选到 #1
    insp.handleInput("\r");
    let doc = text();
    expect(insp.isDetail).toBe(true);
    expect(doc).toContain("Request #1");
    expect(doc).toContain("[1 summary]");
    expect(doc).toContain("2 messages · 1 tools");
    expect(doc).toContain("threshold 80000");
    expect(doc).toContain("measured in");
    expect(doc).toContain("cache hit 800 tok");
    expect(doc).toContain("stop reason");

    insp.handleInput("2");
    doc = text();
    expect(doc).toContain("[2 decisions]");
    expect(doc).toContain("recorded threshold");
    expect(doc).toContain("below threshold");

    insp.handleInput("3");
    doc = text();
    expect(doc).toContain("[3 sent]");
    expect(doc).toContain("Cache hit: 66.7%");
    expect(doc).toContain("exact text spans not reported");
    expect(doc).toContain("1. system");
    expect(doc).toContain("2. user");
    expect(doc).toContain("reconstructed from events");
    expect(doc).not.toContain("├ 角色与规则");
    insp.handleInput("\r");
    expect(text()).toContain("├ 角色与规则");
    expect(text()).toContain("├ 环境  15 tok · 94%");
    expect(text()).toContain("[−] 1. system");
    expect(text()).toContain("[+] 2. user");
    insp.handleInput("\x1b[B");
    insp.handleInput("\r");
    expect(text()).toContain("[−] 2. user");
    expect(text()).toContain("[−] 1. system");
    insp.handleInput("f"); // 普通字符不能触发展开、编辑或发送。
    expect(text()).toContain("[−] 2. user");

    insp.handleInput("4");
    doc = text();
    expect(doc).toContain("[4 tool defs]");
    expect(doc).toContain("echo");
    expect(doc).toContain("回显文本");
    expect(doc).toContain('"type": "object"');

    insp.handleInput("5");
    doc = text();
    expect(doc).toContain("[5 wire JSON]");
    expect(doc).toContain("Reconstructed preview");
    expect(doc).toContain('"model": "fake"');
    expect(doc).toContain('"stream": true');

    insp.handleInput("6");
    doc = text();
    expect(doc).toContain("[6 received]");
    expect(doc).toContain("先看看");
    expect(doc).toContain("Call · echo");
    expect(doc).toContain("HTTP attempt 1");
    expect(doc).not.toContain("data: [DONE]");
    insp.handleInput("\x1b[B");
    insp.handleInput("\r");
    expect(text()).toContain('"text": "hi"');
    insp.handleInput("\x1b[B");
    insp.handleInput("\r");
    expect(text()).toContain("data: [DONE]");
    expect(text()).toContain("用户想读内容");
  });

  it("按键:方向切分区、[ ] 切请求、滚动有位置提示、Esc 逐级返回并关闭", async () => {
    const { log, provider } = await session();
    const { insp, text, closed } = build(log, provider, 12);
    insp.handleInput("g");
    insp.handleInput("\r");
    insp.handleInput("\x1b[C"); // →
    expect(text()).toContain("[2 decisions]");
    insp.handleInput("]");
    expect(text()).toContain("Request #2");
    insp.handleInput("5");
    // 位置提示在页脚提示语之后;100 列下会被截断,用宽终端看它
    const before = text(160);
    expect(before).toMatch(/lines 1-\d+ of \d+/);
    insp.handleInput("\x1b[B"); // ↓
    expect(text(160)).toMatch(/lines 2-\d+ of \d+/);
    insp.handleInput("G");
    expect(text(160)).not.toMatch(/lines 2-/);
    insp.handleInput("\x1b");
    expect(insp.isDetail).toBe(false);
    insp.handleInput("\x1b");
    expect(closed()).toBe(1);
  });

  it("第 7 分区 写入:本次请求之后追加的事件原样 JSON", async () => {
    const { log, provider } = await session();
    const { insp, text } = build(log, provider, 60);
    insp.handleInput("g");
    insp.handleInput("\r");
    insp.handleInput("7");
    const doc = text();
    expect(doc).toContain("[7 written]");
    expect(doc).toContain("assistant/message");
    expect(doc).toContain("tool/result");
    expect(doc).toContain('"callId": "c1"');
    expect(doc).toContain("model-visible");
    expect(doc).not.toContain('"text": "完成"'); // 那是下一次请求的写入
  });

  it("事件视图(Tab):内核维护的全部事件,逐条大小与可见性;Enter 看原样 JSON", async () => {
    const { log, provider } = await session();
    const { insp, text } = build(log, provider, 30);
    insp.handleInput("\t");
    let doc = text();
    expect(insp.currentMode).toBe("events");
    expect(doc).toContain("Events");
    expect(doc).toContain(`${log.events.length} events`);
    expect(doc).toContain("#0   ");
    expect(doc).toContain("session/start");
    expect(doc).toContain("request");
    // 右列:模型眼里的状态;request 行前空一行,一句人读的话
    expect(doc).toContain("kernel");
    expect(doc).toContain("sent");
    expect(doc).toMatch(/→ .+ · \d+ msgs · ≈/);
    expect(doc).toContain("[1 all]");
    // 筛选:3 kernel 只留 request 之类
    insp.handleInput("3");
    doc = text();
    expect(doc).not.toContain("session/start");
    expect(doc).toContain("request");
    insp.handleInput("1");
    insp.handleInput("g");
    insp.handleInput("\r");
    doc = text();
    expect(insp.currentMode).toBe("event");
    expect(doc).toContain("Event #0");
    expect(doc).toContain("[1 view]");
    expect(doc).toContain("system prompt");
    insp.handleInput("2");
    doc = text();
    expect(doc).toContain('"type": "session/start"');
    expect(doc).toContain('"system": "你是助手"');
    insp.handleInput("3");
    expect(text()).toContain("position");
    insp.handleInput("1");
    insp.handleInput("]");
    expect(text()).toContain("Event #1");
    insp.handleInput("\x1b");
    expect(insp.currentMode).toBe("events");
    insp.handleInput("\t"); // 事件视图 → 压缩对照 → 请求视图
    expect(insp.currentMode).toBe("compactions");
    insp.handleInput("\t");
    expect(insp.currentMode).toBe("composition"); // 第四视图:组装
    insp.handleInput("	");
    expect(insp.currentMode).toBe("list");
  });

  it("压缩请求的发送分区显示真实发出的消息(前缀 + 摘要指示),线路 JSON 同源", () => {
    const events: AgentEvent[] = [
      { type: "session/start", at: "t", model: "fake", system: "S" },
      { type: "user/message", at: "t", text: "U1" },
      { type: "assistant/message", at: "t", text: "A1", toolCalls: [], stopReason: "end" },
      { type: "user/message", at: "t", text: "U2" },
      {
        type: "request",
        at: "t",
        model: "fake",
        messages: 4,
        tools: [],
        estimatedTokens: 10,
        reason: "compaction",
        body: { prefixEvents: 3, tail: [{ role: "user", content: "请压缩以上对话" }] },
      },
      {
        type: "compaction",
        at: "t",
        summary: "摘要",
        coversFrom: 2,
        coversUpTo: 3,
        strategy: "llmSummarize(structuredFull, replay)",
      },
    ];
    const log = new EventLog();
    for (const e of events) log.append(e);
    const { insp, text } = build(log, scripted([]));
    insp.handleInput("\r");
    insp.handleInput("3");
    const doc = text();
    expect(doc).toContain("请压缩以上对话");
    expect(doc).toContain("A1");
    expect(doc).not.toContain("U2"); // 前缀只到第 3 条事件
    insp.handleInput("5");
    expect(text()).toContain("请压缩以上对话");
    insp.handleInput("1");
    expect(text()).toContain("strategy");
    expect(text()).toContain("llmSummarize(structuredFull, replay)");
  });

  it("没有请求时给出提示而不崩", () => {
    const log = new EventLog();
    const { text } = build(log, scripted([]));
    expect(text()).toContain("No requests yet. Send a message first.");
  });

  it("provider 未实现 wire 时线路分区如实说明", async () => {
    const { log } = await session();
    const bare: Provider = {
      model: "fake",
      async complete() {
        throw new Error("x");
      },
    };
    const { insp, text } = build(log, bare);
    insp.handleInput("\r");
    insp.handleInput("5");
    expect(text()).toContain("This provider has no wire()");
    // 历史请求有工具,当前已找不到定义:不能伪造一份少工具的历史线路正文。
    const missing = build(log, scripted([]), 30, []);
    missing.insp.handleInput("\r");
    missing.insp.handleInput("4");
    expect(missing.text()).toContain("Unavailable definitions: echo");
    expect(missing.text()).not.toContain("No tools were sent");
    missing.insp.handleInput("5");
    expect(missing.text()).not.toContain('"stream": true');
    expect(missing.text()).toContain("Cannot reconstruct");

    // 请求尚未返回时,旁路记录会变化而事件数不变;不能让缓存一直显示未捕获。
    const events = log.events.slice(0, 3);
    const trace: RequestRecording = { bodies: [], attempts: [] };
    const live = new RequestInspector({
      events: () => events,
      sessions: () => [{ name: "main", events, recordingFor: () => trace }],
      providerFor: () => undefined,
      tools: () => [],
      rows: () => 30,
      onClose: () => {},
      requestRender: () => {},
    });
    live.showRequest(1, 5);
    const render = () => live.render(100).map(stripAnsi).join("\n");
    expect(render()).toContain("Cannot reconstruct");
    trace.bodies.push('{"model":"historical","tools":[{"name":"echo"}]}');
    expect(render()).toContain('"model": "historical"');
    expect(render()).not.toContain("Cannot reconstruct");
    live.handleInput("6");
    expect(render()).toContain("No HTTP response captured");
    trace.attempts?.push({ n: 1, state: "unfinished", response: "data: live-chunk" });
    expect(render()).toContain("data: live-chunk");
    // 翻页后正文块的标题已经滚出视口,固定头仍需说明 Enter 操作谁。
    const attempt = trace.attempts?.[0];
    if (!attempt) throw new Error("missing attempt");
    attempt.response = Array.from({ length: 100 }, (_, i) => `data: chunk-${i}`).join("\n");
    live.handleInput("\r");
    render();
    live.handleInput("\x1b[6~");
    const page = live.render(60).map(stripAnsi).join("\n");
    expect(page).toContain("Selected · HTTP attempt 1");
    expect(page).not.toContain("data: chunk-0\n");
    // 发送页不能把读取失败隐藏在重建标签背后。
    trace.error = "Missing or unreadable recording: fixture input";
    live.handleInput("3");
    const damaged = live.render(60).map(stripAnsi).join("\n");
    expect(damaged).toContain("Recording unavailable or damaged");
    expect(damaged).toContain("Missing or unreadable recording");
    expect(damaged).toContain("reconstructed from events");

    // 历史工具同名也可能改了定义;只比较实录,不借当前工具集猜测。
    const records = build(log, bare).insp.records();
    const recorded = new RequestInspector({
      events: () => log.events,
      providerFor: () => undefined,
      sessions: () => [
        {
          name: "main",
          events: log.events,
          recordingFor: (i) => {
            const rec = records.find((r) => r.index === i);
            return rec
              ? {
                  bodies: [],
                  input: {
                    messages: messagesFor(log.events, rec),
                    tools: [
                      { name: "echo", parameters: {}, description: rec.n === 1 ? "old" : "new" },
                    ],
                  },
                }
              : undefined;
          },
        },
      ],
      tools: () => [],
      rows: () => 40,
      onClose() {},
      requestRender() {},
    });
    recorded.showRequest(2, 3);
    const compared = recorded.render(100).map(stripAnsi).join("\n");
    expect(compared).toContain("Tool definitions: changed");
    expect(compared).toContain("Same message prefix");
    expect(compared).toContain("Added since previous input");
    expect(compared).toContain("Cache hit: not reported");
    log.append({
      type: "context/edit",
      at: "t",
      target: 1,
      field: "content",
      value: "changed question",
    });
    log.append({
      type: "request",
      at: "t",
      model: "fake",
      messages: 5,
      tools: [],
      estimatedTokens: 50,
      reason: "turn",
    });
    recorded.showRequest(3, 3);
    const edited = recorded.render(100).map(stripAnsi).join("\n");
    expect(edited).toContain("Changed tail from here");
    expect(edited).not.toContain("Added since previous input");
    expect(edited).toContain("context/edit");
  });
});
