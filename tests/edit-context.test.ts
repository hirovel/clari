// 编辑上下文(Q74):投影层的编辑与丢弃、回传物丢弃、Anthropic 前缀绑定、界面命令与拒绝条件。
import { describe, expect, it } from "vitest";
import { createTuiApp } from "../cli/tui-app.js";
import { EventLog } from "../src/log.js";
import { deriveMessages, editState } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { toAnthropicWire } from "../src/providers/anthropic.js";
import { VirtualTerminal } from "./helpers/virtual-terminal.js";

const thinking = (model: string) => ({
  kind: "anthropic-thinking",
  model,
  blocks: [{ type: "thinking", thinking: "t", signature: "sig" }],
});

function sample(): EventLog {
  const log = new EventLog();
  log.append({ type: "session/start", at: "", model: "m", system: "S" });
  log.append({ type: "user/message", at: "", text: "u1" });
  log.append({
    type: "assistant/message",
    at: "",
    text: "a1",
    toolCalls: [{ id: "c1", name: "r", args: {} }],
    stopReason: "tool",
    reasoning: "想法一",
    reasoningKind: "full",
    opaque: thinking("m"),
  });
  log.append({
    type: "tool/result",
    at: "",
    callId: "c1",
    name: "r",
    content: "R1",
    isError: false,
  });
  log.append({
    type: "assistant/message",
    at: "",
    text: "a2",
    toolCalls: [],
    stopReason: "end",
    reasoning: "想法二",
    reasoningKind: "summary",
    opaque: thinking("m"),
  });
  log.append({ type: "user/message", at: "", text: "u2" });
  return log;
}

describe("投影应用编辑", () => {
  it("edit 换字段、标 edited、丢该消息的回传物;最后一次编辑生效;原事件不变", () => {
    const log = sample();
    log.append({
      type: "context/edit",
      at: "",
      target: 2,
      field: "reasoning",
      value: "改过的想法",
    });
    log.append({ type: "context/edit", at: "", target: 2, field: "reasoning", value: "再改一次" });
    log.append({ type: "context/edit", at: "", target: 3, field: "content", value: "R1 改" });
    log.append({ type: "context/edit", at: "", target: 0, field: "system", value: "S 改" });
    const msgs = deriveMessages(log.events);
    expect(msgs[0]).toEqual({ role: "system", content: "S 改", edited: true });
    expect(msgs[2]).toMatchObject({
      role: "assistant",
      content: "a1",
      reasoning: "再改一次",
      edited: true,
    });
    expect(msgs[2]).not.toHaveProperty("opaque");
    expect(msgs[3]).toMatchObject({ role: "tool", content: "R1 改", edited: true });
    // 没被改的助手消息仍带回传物。
    expect(msgs[4]).toHaveProperty("opaque");
    const e2 = log.events[2];
    expect(e2?.type === "assistant/message" && e2.reasoning).toBe("想法一");
    expect(editState(log.events).edits.get(2)).toEqual({ reasoning: "再改一次" });
  });

  it("drop 助手消息连同它的工具结果一起跳过;drop 用户消息只跳过自己", () => {
    const log = sample();
    log.append({ type: "context/drop", at: "", target: 2 });
    let roles = deriveMessages(log.events).map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "user"]);
    log.append({ type: "context/drop", at: "", target: 5 });
    roles = deriveMessages(log.events).map((m) => m.role);
    expect(roles).toEqual(["system", "user", "assistant"]);
  });

  it("Anthropic:前缀里有编辑过的消息,之后所有思考块都不再回传;编辑点之前的照常", () => {
    const log = sample();
    log.append({ type: "context/edit", at: "", target: 3, field: "content", value: "R1 改" });
    const wire = toAnthropicWire(deriveMessages(log.events), { model: "m" });
    const assistants = wire.messages.filter((m) => m.role === "assistant");
    // 第一条助手在编辑点之前,思考块仍在;第二条在编辑点之后,思考块没了。
    expect(assistants[0]?.content.some((b) => b.type === "thinking")).toBe(true);
    expect(assistants[1]?.content.some((b) => b.type === "thinking")).toBe(false);
  });
});

describe("界面命令", () => {
  function app(log: EventLog) {
    const provider: Provider = {
      model: "m",
      fields: { protocol: "anthropic(messages)", sends: [], reads: [], ignores: [] },
      async complete(): Promise<AssistantTurn> {
        return { text: "", toolCalls: [], stopReason: "end" };
      },
    };
    return createTuiApp({
      terminal: new VirtualTerminal(100, 30),
      log,
      provider,
      tools: [],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      onExit: () => {},
    });
  }
  // 用码点拼出 ESC,避免正则字面量里出现控制字符。
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
  const text = (a: ReturnType<typeof app>) =>
    a
      .lines(100)
      .map((l) => l.replace(ansi, ""))
      .join("\n");

  it("/edit 内联文本追加 context/edit 并打印后果;摘要思考拒绝编辑;/drop;/edits", async () => {
    const log = sample();
    const a = app(log);
    await a.command("/edit 2 reasoning 换个思路,先读文件");
    const edit = log.events.at(-1);
    expect(edit).toMatchObject({
      type: "context/edit",
      target: 2,
      field: "reasoning",
      value: "换个思路,先读文件",
    });
    let doc = text(a);
    expect(doc).toContain("◇ edited event #2.reasoning");
    expect(doc).toContain("thinking blocks after this point are no longer");

    await a.command("/edit 4 reasoning 试图改摘要");
    expect(log.events.at(-1)?.type).toBe("context/edit"); // 没有新增
    doc = text(a);
    expect(doc).toContain("event #4 thinking is a summary");

    // #6 是刚追加的 context/edit 事件本身,不进入模型上下文。
    await a.command("/edit 6 text x");
    expect(text(a)).toContain("event #6 is context/edit; it never reaches the model");
    await a.command("/edit 1 reasoning x");
    expect(text(a)).toContain("event #1 has no field reasoning");

    await a.command("/drop 2 走错方向");
    expect(log.events.at(-1)).toMatchObject({ type: "context/drop", target: 2, note: "走错方向" });
    expect(text(a)).toContain("◇ dropped event #2 with its 1 tool results");

    await a.command("/edits");
    doc = text(a);
    expect(doc).toContain("edit #2.reasoning");
    expect(doc).toContain("drop #2");
    a.stop();
  });
});
