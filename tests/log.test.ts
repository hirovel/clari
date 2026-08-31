import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { deriveMessages } from "../src/messages.js";

const START: AgentEvent = {
  type: "session/start",
  at: "t0",
  model: "m",
  system: "你是测试用 agent。",
};
const ASK: AgentEvent = { type: "user/message", at: "t1", text: "读一下 a.txt" };

const SESSION: AgentEvent[] = [
  START,
  ASK,
  {
    type: "assistant/message",
    at: "t2",
    text: "",
    toolCalls: [{ id: "c1", name: "read", args: { path: "a.txt" } }],
    stopReason: "tool",
  },
  { type: "tool/result", at: "t3", callId: "c1", name: "read", content: "hello", isError: false },
  { type: "assistant/message", at: "t4", text: "内容是 hello。", toolCalls: [], stopReason: "end" },
];

describe("EventLog", () => {
  it("落盘再加载,事件逐字节一致(回放地基)", () => {
    const file = join(mkdtempSync(join(tmpdir(), "kernel-")), "s.jsonl");
    const log = new EventLog(file);
    for (const e of SESSION) log.append(e);

    const loaded = EventLog.load(file);
    expect(loaded.events).toEqual(SESSION);
  });

  it("订阅是只读旁路:收到每个事件,退订后停止", () => {
    const log = new EventLog();
    const seen: string[] = [];
    const off = log.subscribe((e) => seen.push(e.type));
    log.append(START);
    off();
    log.append(ASK);
    expect(seen).toEqual(["session/start"]);
  });
});

describe("deriveMessages", () => {
  it("完整会话投影为模型可见序列", () => {
    expect(deriveMessages(SESSION)).toEqual([
      { role: "system", content: "你是测试用 agent。" },
      { role: "user", content: "读一下 a.txt" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read", args: { path: "a.txt" } }],
      },
      { role: "tool", callId: "c1", name: "read", content: "hello", isError: false },
      { role: "assistant", content: "内容是 hello。", toolCalls: [] },
    ]);
  });

  it("interrupt 不投影;aborted 半截消息照常投影(真相不丢)", () => {
    const events: AgentEvent[] = [
      START,
      ASK,
      { type: "session/interrupt", at: "t2" },
      { type: "assistant/message", at: "t3", text: "我正要", toolCalls: [], stopReason: "aborted" },
    ];
    const msgs = deriveMessages(events);
    expect(msgs).toHaveLength(3);
    expect(msgs[2]).toEqual({ role: "assistant", content: "我正要", toolCalls: [] });
  });

  it("同一日志投影两次,结果相同(纯函数)", () => {
    expect(deriveMessages(SESSION)).toEqual(deriveMessages(SESSION));
  });
});
