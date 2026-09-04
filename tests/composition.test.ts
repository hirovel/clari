// 上下文组装(Q81):composeContext 的来历与省略、三家 wireMap、组装槽记 body、检视器组装视图。
import { describe, expect, it } from "vitest";
import { compositionLines, compositionRows, RequestInspector } from "../cli/inspector.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { runTurn } from "../src/loop.js";
import { composeContext, deriveMessages } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { openaiCompat } from "../src/provider.js";
import { anthropic } from "../src/providers/anthropic.js";
import { openaiResponses } from "../src/providers/openai-responses.js";

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string) => s.replace(ansi, "");

function sample(): AgentEvent[] {
  return [
    { type: "session/start", at: "", model: "m", system: "S" },
    { type: "user/message", at: "", text: "u1" },
    {
      type: "assistant/message",
      at: "",
      text: "",
      toolCalls: [
        { id: "a", name: "r", args: {} },
        { id: "b", name: "r", args: {} },
      ],
      stopReason: "tool",
      opaque: { kind: "anthropic-thinking", model: "m", blocks: [] },
    },
    { type: "tool/result", at: "", callId: "a", name: "r", content: "RA", isError: false },
    { type: "tool/result", at: "", callId: "b", name: "r", content: "RB", isError: false },
    { type: "assistant/message", at: "", text: "a1", toolCalls: [], stopReason: "end" },
    { type: "user/message", at: "", text: "u2" },
    { type: "assistant/message", at: "", text: "a2", toolCalls: [], stopReason: "end" },
    { type: "user/message", at: "", text: "u3" },
  ];
}

describe("composeContext", () => {
  it("每条消息带来源事件与阶段;摘要、清除、编辑、丢弃各有名字;省略列出原因;deriveMessages 只是它的一列", () => {
    const events: AgentEvent[] = [
      ...sample(),
      { type: "compaction", at: "", summary: "SUM", coversFrom: 2, coversUpTo: 6, cleared: [] },
      { type: "context/edit", at: "", target: 6, field: "content", value: "u2 edited" },
      { type: "context/drop", at: "", target: 7 },
    ];
    const comp = composeContext(events);
    expect(comp.messages).toEqual(deriveMessages(events));
    const tags = comp.provenance.map((p) => `${p.event}:${p.stages.join("+")}`);
    // system, u1, summary(compaction event #9), u2(edited), u3;a2 被丢弃,#2-#5 被摘要覆盖
    expect(tags).toEqual(["0:", "1:", "9:summary(covers #2–#5)", "6:edited:content", "8:"]);
    expect(comp.omitted).toEqual([
      { event: 2, reason: "covered" },
      { event: 3, reason: "covered" },
      { event: 4, reason: "covered" },
      { event: 5, reason: "covered" },
      { event: 7, reason: "dropped" },
    ]);
  });

  it("清除与改过的助手消息标 cleared / opaque-dropped", () => {
    const events: AgentEvent[] = [
      ...sample(),
      { type: "compaction", at: "", cleared: [3] },
      { type: "context/edit", at: "", target: 2, field: "text", value: "x" },
    ];
    const comp = composeContext(events);
    const byEvent = new Map(comp.provenance.map((p) => [p.event, p.stages]));
    expect(byEvent.get(3)).toEqual(["cleared"]);
    expect(byEvent.get(2)).toEqual(["edited:text", "opaque-dropped"]);
  });
});

describe("wireMap", () => {
  const msgs = deriveMessages(sample());
  it("chat completions 恒等;Anthropic 抽 system 并合并连续工具结果;Responses 抽 instructions", () => {
    expect(openaiCompat({ baseUrl: "http://x", apiKey: "k", model: "m" }).wireMap?.(msgs)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    // system -1;u1→0;assistant→1;两条工具结果合并成 wire[2];a1→3;u2→4;a2→5;u3→6
    expect(anthropic({ apiKey: "k", model: "m" }).wireMap?.(msgs)).toEqual([
      -1, 0, 1, 2, 2, 3, 4, 5, 6,
    ]);
    // system -1;u1→0;assistant(两个 function_call)→1;RA→3;RB→4;a1→5;u2→6;a2→7;u3→8
    expect(openaiResponses({ apiKey: "k", model: "gpt-5.5" }).wireMap?.(msgs)).toEqual([
      -1, 0, 1, 3, 4, 5, 6, 7, 8,
    ]);
  });
});

describe("组装槽", () => {
  it("assemble 换了投影,request.body 记下差异,检视器仍能重建", async () => {
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "m", system: "S" });
    log.append({ type: "user/message", at: "", text: "hi" });
    let seen: unknown;
    const provider: Provider = {
      model: "m",
      async complete(messages): Promise<AssistantTurn> {
        seen = messages;
        return { text: "ok", toolCalls: [], stopReason: "end" };
      },
    };
    await runTurn({
      log,
      provider,
      tools: [],
      slots: {
        assemble: (events) => [
          ...deriveMessages(events),
          { role: "user", content: "(reminder) be brief" },
        ],
      },
    });
    expect((seen as unknown[]).length).toBe(3);
    const req = log.events.find((e) => e.type === "request");
    expect(req?.type === "request" && req.body).toEqual({
      prefixEvents: 2,
      tail: [{ role: "user", content: "(reminder) be brief" }],
    });
  });
});

describe("检视器组装视图", () => {
  it("行含投影号、来源事件、wire 下标、阶段;Enter 看单条的来历与全文;Tab 从压缩对照进入", () => {
    const events: AgentEvent[] = [
      ...sample(),
      { type: "compaction", at: "", summary: "SUM", coversFrom: 2, coversUpTo: 6 },
    ];
    const provider = anthropic({ apiKey: "k", model: "m" });
    const { rows, omitted } = compositionRows(events, provider);
    expect(rows.map((r) => r.wire)).toEqual([-1, 0, 1, 2, 3, 4]);
    expect(rows[2]?.stages[0]).toContain("summary");
    expect(omitted).toHaveLength(4);
    const detail = compositionLines(events, rows[2] as (typeof rows)[number])
      .map(plain)
      .join("\n");
    expect(detail).toContain("event #9 compaction");
    expect(detail).toContain("messages[1]");
    expect(detail).toContain("SUM");

    const insp = new RequestInspector({
      events: () => events,
      providerFor: () => provider,
      currentProvider: () => provider,
      tools: () => [],
      rows: () => 30,
      onClose: () => {},
      requestRender: () => {},
    });
    insp.showCompactions();
    insp.handleInput("\t");
    expect(insp.currentMode).toBe("composition");
    const screen = insp.render(120).map(plain).join("\n");
    expect(screen).toContain("Context");
    expect(screen).toContain("6 messages");
    expect(screen).toContain("summary(covers #2–#5)");
    expect(screen).toContain("omitted: 4 covered by the summary");
    // Enter 先开动作菜单(Q83),第一项"View full message"再 Enter 才进全文
    insp.handleInput("\r");
    expect(insp.currentMode).toBe("actions");
    const menu = insp.render(120).map(plain).join("\n");
    expect(menu).toContain("Message #6");
    expect(menu).toContain("View full message");
    expect(menu).toContain("If you do this");
    insp.handleInput("\r");
    expect(insp.currentMode).toBe("message");
    expect(insp.render(120).map(plain).join("\n")).toContain("Message #6");
    insp.handleInput("\t");
    insp.handleInput("\x1b");
    expect(insp.currentMode).toBe("composition");
    insp.handleInput("\t");
    expect(insp.currentMode).toBe("list");
  });
});
