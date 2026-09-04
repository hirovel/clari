import { describe, expect, it } from "vitest";
import { contextBreakdown, estimateTokens } from "../src/context.js";
import type { AgentEvent } from "../src/events.js";

const EVENTS: AgentEvent[] = [
  { type: "session/start", at: "t", model: "m", system: "s".repeat(400) },
  { type: "user/message", at: "t", text: "u".repeat(200) },
  {
    type: "assistant/message",
    at: "t",
    text: "a".repeat(100),
    toolCalls: [{ id: "c1", name: "read", args: { path: "x" } }],
    stopReason: "tool",
    usage: { inputTokens: 1234, outputTokens: 56 },
  },
  {
    type: "tool/result",
    at: "t",
    callId: "c1",
    name: "read",
    content: "r".repeat(800),
    isError: false,
  },
  {
    type: "tool/result",
    at: "t",
    callId: "c2",
    name: "bash",
    content: "b".repeat(400),
    isError: false,
  },
];

describe("contextBreakdown", () => {
  it("按角色分桶,工具结果按工具名细分", () => {
    const b = contextBreakdown(EVENTS, 10000);
    const labels = b.parts.map((p) => p.label);
    expect(labels).toContain("system prompt");
    expect(labels).toContain("tool results read");
    expect(labels).toContain("tool results bash");
    expect(b.parts.find((p) => p.label === "tool results read")?.tokens).toBe(
      estimateTokens("r".repeat(800)),
    );
  });

  it("份额合计为 1,占窗比例正确", () => {
    const b = contextBreakdown(EVENTS, 10000);
    const sum = b.parts.reduce((n, p) => n + p.share, 0);
    expect(sum).toBeCloseTo(1, 5);
    expect(b.usedShare).toBeCloseTo(b.estimatedTokens / 10000, 5);
  });

  it("带回最近一次请求的实测 usage 供对照", () => {
    const b = contextBreakdown(EVENTS, 10000);
    expect(b.measuredTokens).toBe(1234);
  });
});
