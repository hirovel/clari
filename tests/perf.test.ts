// 生产级会话的规模下,投影、切段与检视器渲染必须在按键级延迟内完成。
// 阈值放得宽(CI 机器慢),目的是防止回归成二次方或每键重算全文。
import { describe, expect, it } from "vitest";
import { collectRequests, RequestInspector } from "../cli/inspector.js";
import { estimateAfter } from "../src/compaction.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { deriveMessages } from "../src/messages.js";
import type { Provider } from "../src/provider.js";

function bigSession(turns: number): EventLog {
  const log = new EventLog();
  const at = "2026-09-02T00:00:00.000Z";
  log.append({ type: "session/start", at, model: "m", system: "S".repeat(2000) });
  log.append({ type: "user/message", at, text: "开始" });
  for (let i = 0; i < turns; i++) {
    log.append({
      type: "request",
      at,
      model: "m",
      messages: 2 + i * 3,
      tools: ["bash"],
      estimatedTokens: i * 600,
      threshold: 99000,
      reason: "turn",
    });
    log.append({
      type: "assistant/message",
      at,
      text: `第 ${i} 步`,
      toolCalls: [{ id: `c${i}`, name: "bash", args: { command: `echo ${i}` } }],
      stopReason: "tool",
      usage: { inputTokens: i * 600, outputTokens: 20 },
      latencyMs: 800,
    });
    log.append({
      type: "tool/result",
      at,
      callId: `c${i}`,
      name: "bash",
      content: "输出".repeat(1000),
      isError: false,
      durationMs: 5,
    });
  }
  return log;
}

const ms = (fn: () => void): number => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe("性能:2000 事件的会话", () => {
  const log = bigSession(700); // 2 + 700 × 3 = 2102 条事件,约 1.4 MB 文本
  const provider: Provider = {
    model: "m",
    wire: (messages, tools) => ({ model: "m", messages, tools }),
    async complete() {
      throw new Error("x");
    },
  };

  it("投影与估算:单次 100ms 内", () => {
    expect(ms(() => deriveMessages(log.events))).toBeLessThan(100);
    expect(ms(() => estimateAfter(log.events))).toBeLessThan(100);
  });

  it("按请求切段:100ms 内", () => {
    let recs: AgentEvent[] = [];
    expect(ms(() => (recs = collectRequests(log.events).map((r) => r.request)))).toBeLessThan(100);
    expect(recs).toHaveLength(700);
  });

  it("检视器:列表、事件视图、小分区首次渲染 300ms 内,全文分区 1.5s 内,重复渲染走缓存 10ms 内", () => {
    const insp = new RequestInspector({
      events: () => log.events,
      providerFor: () => provider,
      tools: () => [{ name: "bash", description: "d", parameters: { type: "object" } }],
      rows: () => 40,
      onClose: () => {},
      requestRender: () => {},
    });
    insp.reset();
    expect(ms(() => insp.render(120))).toBeLessThan(300);
    insp.handleInput("\t");
    expect(ms(() => insp.render(120))).toBeLessThan(300);
    insp.handleInput("\t");
    insp.handleInput("\r");
    // 发送 / 线路 JSON / 写入 要把 1.4 MB 正文全部换行着色,给 1.5s;其余分区 300ms。
    const heavy = new Set(["3", "5", "7"]);
    for (const section of ["1", "2", "3", "4", "5", "6", "7"]) {
      insp.handleInput(section);
      const limit = heavy.has(section) ? 1500 : 300;
      expect(
        ms(() => insp.render(120)),
        `分区 ${section}`,
      ).toBeLessThan(limit);
      expect(
        ms(() => insp.render(120)),
        `分区 ${section} 缓存`,
      ).toBeLessThan(10);
    }
  });
});
