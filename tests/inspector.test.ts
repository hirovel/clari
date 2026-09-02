import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { fmtMs, fmtTok, RequestInspector } from "../cli/inspector.js";
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

function build(log: EventLog, provider: Provider, rows = 30) {
  let closed = 0;
  const insp = new RequestInspector({
    events: () => log.events,
    providerFor: () => provider,
    tools: () => defs,
    rows: () => rows,
    rawFor: (i) => (i === 2 ? ["data: {}", "data: [DONE]"] : undefined),
    onClose: () => {
      closed += 1;
    },
    requestRender: () => {},
  });
  insp.reset();
  const text = () => insp.render(100).map(stripAnsi).join("\n");
  return { insp, text, closed: () => closed };
}

describe("请求检视器(Q49)", () => {
  it("格式化:token 与耗时", () => {
    expect(fmtTok(999)).toBe("999");
    expect(fmtTok(1200)).toBe("1.2k");
    expect(fmtTok(48200)).toBe("48k");
    expect(fmtTok(undefined)).toBe("—");
    expect(fmtMs(80)).toBe("80ms");
    expect(fmtMs(2340)).toBe("2.3s");
  });

  it("列表:一行一请求,含规模、实测、缓存、停止原因;行数恰为终端高度", async () => {
    const { log, provider } = await session();
    const { insp, text } = build(log, provider, 30);
    const doc = text();
    expect(insp.render(100)).toHaveLength(30);
    expect(doc).toContain("请求检视");
    expect(doc).toContain("2 次请求");
    expect(doc).toContain("#1");
    expect(doc).toContain("2 条消息");
    expect(doc).toContain("→ 1.2k(缓存 800)  +30");
    expect(doc).toContain("tool");
    expect(doc).toContain("#2");
    expect(doc).toContain("4 条消息");
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
    expect(doc).toContain("请求 #1");
    expect(doc).toContain("[1 概要]");
    expect(doc).toContain("2 条消息 · 1 个工具");
    expect(doc).toContain("阈值 80000");
    expect(doc).toContain("实测输入");
    expect(doc).toContain("缓存命中 800 tok");
    expect(doc).toContain("停止原因");

    insp.handleInput("2");
    doc = text();
    expect(doc).toContain("[2 决策]");
    expect(doc).toContain("自动压缩检查");
    expect(doc).toContain("未触发");
    expect(doc).toContain("没列出的就没发生");

    insp.handleInput("3");
    doc = text();
    expect(doc).toContain("[3 发送]");
    expect(doc).toContain("[1] system");
    expect(doc).toContain("├ 角色与规则");
    expect(doc).toContain("├ 环境  15 tok · 94%");
    expect(doc).toContain("你是助手");
    expect(doc).toContain("[2] user");
    expect(doc).toContain("读一下");
    expect(doc).toContain("完整正文");
    insp.handleInput("f");
    expect(text()).toContain("已折叠正文");

    insp.handleInput("4");
    doc = text();
    expect(doc).toContain("[4 工具定义]");
    expect(doc).toContain("echo");
    expect(doc).toContain("回显文本");
    expect(doc).toContain('"type": "object"');

    insp.handleInput("5");
    doc = text();
    expect(doc).toContain("[5 线路 JSON]");
    expect(doc).toContain("逐字节一致");
    expect(doc).toContain('"model": "fake"');
    expect(doc).toContain('"stream": true');

    insp.handleInput("6");
    doc = text();
    expect(doc).toContain("[6 接收]");
    expect(doc).toContain("停止原因 tool");
    expect(doc).toContain("思考");
    expect(doc).toContain("用户想读内容");
    expect(doc).toContain("先看看");
    expect(doc).toContain("⚙ echo");
    expect(doc).toContain('"text": "hi"');
    expect(doc).toContain("原始流");
    expect(doc).toContain("data: [DONE]");
  });

  it("按键:方向切分区、[ ] 切请求、滚动有位置提示、Esc 逐级返回并关闭", async () => {
    const { log, provider } = await session();
    const { insp, text, closed } = build(log, provider, 12);
    insp.handleInput("g");
    insp.handleInput("\r");
    insp.handleInput("\x1b[C"); // →
    expect(text()).toContain("[2 决策]");
    insp.handleInput("]");
    expect(text()).toContain("请求 #2");
    insp.handleInput("5");
    const before = text();
    expect(before).toMatch(/第 1-\d+ 行 \/ \d+/);
    insp.handleInput("\x1b[B"); // ↓
    expect(text()).toMatch(/第 2-\d+ 行/);
    insp.handleInput("G");
    expect(text()).not.toMatch(/第 2-/);
    insp.handleInput("\x1b");
    expect(insp.isDetail).toBe(false);
    insp.handleInput("\x1b");
    expect(closed()).toBe(1);
  });

  it("没有请求时给出提示而不崩", () => {
    const log = new EventLog();
    const { text } = build(log, scripted([]));
    expect(text()).toContain("尚无请求");
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
    expect(text()).toContain("未实现 wire()");
  });
});
