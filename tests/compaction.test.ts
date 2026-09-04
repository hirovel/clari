import { describe, expect, it } from "vitest";
import {
  clearToolResults,
  estimateAfter,
  keepRecentTokens,
  legalizeCut,
  llmSummarize,
  pipeline,
} from "../src/compaction.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { runTurn } from "../src/loop.js";
import { CLEARED_PLACEHOLDER, deriveMessages, type Message } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";

function ev(events: Partial<AgentEvent>[]): AgentEvent[] {
  return events as AgentEvent[];
}

const BASE: AgentEvent[] = ev([
  { type: "session/start", at: "t", model: "m", system: "系统提示" },
  { type: "user/message", at: "t", text: "任务:修复测试" },
  {
    type: "assistant/message",
    at: "t",
    text: "",
    toolCalls: [{ id: "c1", name: "read", args: { path: "a.ts" } }],
    stopReason: "tool",
  },
  {
    type: "tool/result",
    at: "t",
    callId: "c1",
    name: "read",
    content: "x".repeat(400),
    isError: false,
  },
  {
    type: "assistant/message",
    at: "t",
    text: "",
    toolCalls: [{ id: "c2", name: "bash", args: { command: "pnpm test" } }],
    stopReason: "tool",
  },
  {
    type: "tool/result",
    at: "t",
    callId: "c2",
    name: "bash",
    content: "y".repeat(400),
    isError: false,
  },
  { type: "assistant/message", at: "t", text: "修好了", toolCalls: [], stopReason: "end" },
  { type: "user/message", at: "t", text: "继续下一个" },
]);

describe("投影处理 compaction 事件", () => {
  it("摘要覆盖区被跳过,摘要在覆盖起点注入;首条用户消息豁免可见", () => {
    const events = [
      ...BASE,
      { type: "compaction", at: "t", summary: "前段摘要", coversFrom: 2, coversUpTo: 7 },
    ] as AgentEvent[];
    const msgs = deriveMessages(events);
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "user", "user"]);
    expect(msgs[1]).toMatchObject({ content: "任务:修复测试" });
    expect(msgs[2]?.content).toContain("前段摘要");
    expect(msgs[3]).toMatchObject({ content: "继续下一个" });
  });

  it("被清除的工具结果换成占位文本,其余原样", () => {
    const events = [...BASE, { type: "compaction", at: "t", cleared: [3] }] as AgentEvent[];
    const msgs = deriveMessages(events);
    const tools = msgs.filter((m) => m.role === "tool");
    expect(tools[0]?.content).toBe(CLEARED_PLACEHOLDER);
    expect(tools[1]?.content).toBe("y".repeat(400));
  });

  it("多次压缩:取最新摘要,清除集合并集", () => {
    const events = [
      ...BASE,
      { type: "compaction", at: "t", cleared: [3] },
      {
        type: "compaction",
        at: "t",
        summary: "新摘要",
        coversFrom: 2,
        coversUpTo: 5,
        cleared: [5],
      },
    ] as AgentEvent[];
    const msgs = deriveMessages(events);
    expect(msgs.some((m) => m.content.includes("新摘要"))).toBe(true);
    const tools = msgs.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(1); // idx3 被摘要覆盖,idx5 被清除但可见
    expect(tools[0]?.content).toBe(CLEARED_PLACEHOLDER);
  });
});

describe("legalizeCut / keepRecentTokens", () => {
  it("切点不落在工具结果上(不拆调用对)", () => {
    expect(legalizeCut(BASE, 3)).toBe(2); // idx3 是 tool/result → 退到 assistant
    expect(legalizeCut(BASE, 7)).toBe(7); // idx7 是 assistant,合法
  });

  it("keepRecentTokens 从尾部累计预算并合法化", () => {
    const cut = keepRecentTokens(50)(BASE);
    expect(cut).toBeGreaterThan(1);
    expect(BASE[cut]?.type === "tool/result").toBe(false);
  });
});

describe("clearToolResults", () => {
  it("保最近 keepRecent 个,清除更旧的", async () => {
    const p = await clearToolResults({ keepRecent: 1, clearAtLeast: 10 })({
      events: BASE,
      window: 1000,
      targetTokens: 500,
    });
    expect(p).toMatchObject({ cleared: [3] });
  });

  it("清除量不足 clearAtLeast 不动手", async () => {
    const p = await clearToolResults({ keepRecent: 1, clearAtLeast: 99999 })({
      events: BASE,
      window: 1000,
      targetTokens: 500,
    });
    expect(p).toBeNull();
  });

  it("已清除过的不重复计入", async () => {
    const events = [...BASE, { type: "compaction", at: "t", cleared: [3] }] as AgentEvent[];
    const p = await clearToolResults({ keepRecent: 0, clearAtLeast: 10 })({
      events,
      window: 1000,
      targetTokens: 500,
    });
    expect(p).toMatchObject({ cleared: [5] });
  });
});

function fakeProvider(reply: string, capture?: { messages?: Message[] }): Provider {
  return {
    model: "fake",
    async complete(messages) {
      if (capture) capture.messages = messages;
      return { text: reply, toolCalls: [], stopReason: "end" };
    },
  };
}

describe("llmSummarize", () => {
  it("replay 模式:请求 = 前缀投影 + 指令;载荷含覆盖范围与程序化文件清单", async () => {
    const capture: { messages?: Message[] } = {};
    const p = await llmSummarize()({
      events: BASE,
      window: 100000,
      targetTokens: 50000,
      provider: fakeProvider("摘要内容", capture),
      preservation: () => 7,
    });
    expect(p).not.toBeNull();
    expect(p).toMatchObject({ coversFrom: 2, coversUpTo: 7 });
    expect(p?.summary).toContain("摘要内容");
    expect(p?.summary).toContain("Files read: a.ts");
    // 最后一条是摘要指令,其前是前缀投影
    const last = capture.messages?.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toContain("Compress the conversation above");
    expect(capture.messages?.[0]?.role).toBe("system");
  });

  it("手动指示拼进提示词", async () => {
    const capture: { messages?: Message[] } = {};
    await llmSummarize()({
      events: BASE,
      window: 100000,
      targetTokens: 50000,
      provider: fakeProvider("摘要", capture),
      preservation: () => 7,
      instructions: "重点保留报错",
    });
    expect(capture.messages?.at(-1)?.content).toContain("重点保留报错");
  });

  it("安全阀:摘要不比被覆盖内容小,返回 null", async () => {
    const p = await llmSummarize()({
      events: BASE,
      window: 100000,
      targetTokens: 50000,
      provider: fakeProvider("废".repeat(2000)),
      preservation: () => 7,
    });
    expect(p).toBeNull();
  });
});

describe("pipeline", () => {
  it("清除已达标则不再调用摘要", async () => {
    let summarizeCalled = 0;
    const spy: Provider = {
      model: "fake",
      async complete() {
        summarizeCalled++;
        return { text: "摘要", toolCalls: [], stopReason: "end" };
      },
    };
    const target = estimateAfter(BASE, { cleared: [3] }) + 1;
    const p = await pipeline(
      clearToolResults({ keepRecent: 1, clearAtLeast: 10 }),
      llmSummarize(),
    )({
      events: BASE,
      window: 100000,
      targetTokens: target,
      provider: spy,
      preservation: () => 7,
    });
    expect(p?.cleared).toEqual([3]);
    expect(p?.summary).toBeUndefined();
    expect(summarizeCalled).toBe(0);
  });

  it("清除不够则叠加摘要,载荷合并", async () => {
    const p = await pipeline(
      clearToolResults({ keepRecent: 1, clearAtLeast: 10 }),
      llmSummarize(),
    )({
      events: BASE,
      window: 100000,
      targetTokens: 1, // 永远不达标 → 两段都跑
      provider: fakeProvider("摘要内容"),
      preservation: () => 7,
    });
    expect(p?.cleared).toEqual([3]);
    expect(p?.summary).toContain("摘要内容");
  });
});

describe("循环触发(Q33)", () => {
  function log(): EventLog {
    const l = new EventLog();
    for (const e of BASE) l.append(e);
    return l;
  }

  it("超阈值时自动压缩,压缩事件先于下一次请求落盘", async () => {
    const l = log();
    const turns: AssistantTurn[] = [{ text: "好", toolCalls: [], stopReason: "end" }];
    const provider: Provider = {
      model: "fake",
      async complete() {
        const t = turns.shift();
        if (!t) throw new Error("越界");
        return t;
      },
    };
    await runTurn({
      log: l,
      provider,
      tools: [],
      compaction: {
        strategy: clearToolResults({ keepRecent: 0, clearAtLeast: 10 }),
        window: 300, // 极小窗口,必然超阈值
        reserveTokens: 100,
      },
    });
    const types = l.events.map((e) => e.type);
    expect(types).toContain("compaction");
    expect(types.indexOf("compaction")).toBeLessThan(types.lastIndexOf("assistant/message"));
  });

  it("溢出恢复:压缩取得进展则重试一次,再溢出直接抛", async () => {
    const l = log();
    let calls = 0;
    const provider: Provider = {
      model: "fake",
      async complete() {
        calls++;
        if (calls === 1) throw new Error("maximum context length exceeded");
        return { text: "恢复了", toolCalls: [], stopReason: "end" };
      },
    };
    const outcome = await runTurn({
      log: l,
      provider,
      tools: [],
      compaction: {
        strategy: clearToolResults({ keepRecent: 0, clearAtLeast: 10 }),
        window: 100000, // 不触发自动,只走溢出路径
        reserveTokens: 100,
      },
    });
    expect(outcome).toBe("idle");
    expect(calls).toBe(2);
    expect(l.events.some((e) => e.type === "compaction")).toBe(true);
  });

  it("溢出但压缩无进展:原样抛出", async () => {
    const l = log();
    const provider: Provider = {
      model: "fake",
      async complete() {
        throw new Error("maximum context length exceeded");
      },
    };
    await expect(
      runTurn({
        log: l,
        provider,
        tools: [],
        compaction: {
          strategy: async () => null, // 无能为力的策略
          window: 100000,
          reserveTokens: 100,
        },
      }),
    ).rejects.toThrow("maximum context length");
  });
});
