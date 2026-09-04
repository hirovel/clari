import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectRequests } from "../cli/inspector.js";
import { clearToolResults, keepRecentTokens, llmSummarize } from "../src/compaction.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { describeRequestBody, maxSteps, recordingProvider, runTurn } from "../src/loop.js";
import { deriveMessages } from "../src/messages.js";
import { type AssistantTurn, openaiCompat, type Provider } from "../src/provider.js";
import { ProviderError } from "../src/providers/errors.js";
import { defineTool } from "../src/tools.js";

const echo = defineTool({
  name: "echo",
  description: "回显",
  parameters: Type.Object({ text: Type.String() }),
  async execute(args) {
    return `echo:${args.text}`;
  },
});

function scripted(
  turns: AssistantTurn[],
  hook?: (opts: Parameters<Provider["complete"]>[2]) => void,
): Provider {
  let i = 0;
  return {
    model: "fake",
    async complete(_m, _t, opts) {
      hook?.(opts);
      const t = turns[i++];
      if (!t) throw new Error("脚本越界");
      return t;
    },
  };
}

function fresh(): EventLog {
  const log = new EventLog();
  log.append({ type: "session/start", at: "t", model: "fake", system: "sys" });
  log.append({ type: "user/message", at: "t", text: "hi" });
  return log;
}

const types = (log: EventLog) => log.events.map((e) => e.type);

describe("请求层记录(Q48)", () => {
  it("每次请求先落 request 事件:规模、工具、估算、阈值;响应带耗时", async () => {
    const log = fresh();
    await runTurn({
      log,
      provider: scripted([
        {
          text: "",
          toolCalls: [{ id: "c1", name: "echo", args: { text: "a" } }],
          stopReason: "tool",
        },
        { text: "done", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echo],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 20000 },
    });
    expect(types(log)).toEqual([
      "session/start",
      "user/message",
      "request",
      "assistant/message",
      "tool/result",
      "request",
      "assistant/message",
    ]);
    const req = log.events[2];
    if (req?.type !== "request") throw new Error("应为 request");
    expect(req.model).toBe("fake");
    expect(req.messages).toBe(2);
    expect(req.tools).toEqual(["echo"]);
    expect(req.estimatedTokens).toBeGreaterThan(0);
    expect(req.threshold).toBe(80000);
    expect(req.reason).toBe("turn");
    const second = log.events[5];
    if (second?.type !== "request") throw new Error("应为 request");
    expect(second.messages).toBe(4);
    const resp = log.events[3];
    if (resp?.type !== "assistant/message") throw new Error("应为 assistant/message");
    expect(typeof resp.latencyMs).toBe("number");
  });

  it("执行过的工具结果带耗时;未执行的(未知工具)没有", async () => {
    const log = fresh();
    await runTurn({
      log,
      provider: scripted([
        {
          text: "",
          toolCalls: [
            { id: "c1", name: "echo", args: { text: "a" } },
            { id: "c2", name: "nope", args: {} },
          ],
          stopReason: "tool",
        },
        { text: "done", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echo],
    });
    const results = log.events.filter((e) => e.type === "tool/result");
    expect(results[0] && "durationMs" in results[0] && typeof results[0].durationMs).toBe("number");
    expect(results[1] && "durationMs" in results[1]).toBe(false);
  });

  it("未配置压缩时 request 不带阈值", async () => {
    const log = fresh();
    await runTurn({
      log,
      provider: scripted([{ text: "ok", toolCalls: [], stopReason: "end" }]),
      tools: [],
    });
    const req = log.events.find((e) => e.type === "request");
    expect(req && "threshold" in req).toBe(false);
  });

  it("provider 的每次重试都记 retry 事件,带状态码", async () => {
    const log = fresh();
    await runTurn({
      log,
      provider: scripted([{ text: "ok", toolCalls: [], stopReason: "end" }], (opts) => {
        opts?.onRetry?.({
          attempt: 1,
          delayMs: 120,
          error: new ProviderError("provider 429: slow down", { status: 429 }),
        });
      }),
      tools: [],
    });
    expect(types(log)).toEqual([
      "session/start",
      "user/message",
      "request",
      "retry",
      "assistant/message",
    ]);
    const retry = log.events[3];
    if (retry?.type !== "retry") throw new Error("应为 retry");
    expect(retry.attempt).toBe(1);
    expect(retry.delayMs).toBe(120);
    expect(retry.status).toBe(429);
    expect(retry.error).toContain("slow down");
  });

  it("请求最终失败记 request/error 后再抛出", async () => {
    const log = fresh();
    const provider: Provider = {
      model: "fake",
      async complete() {
        throw new ProviderError("provider 500: boom", { status: 500 });
      },
    };
    await expect(runTurn({ log, provider, tools: [] })).rejects.toThrow("boom");
    expect(types(log)).toEqual(["session/start", "user/message", "request", "request/error"]);
    const err = log.events[3];
    if (err?.type !== "request/error") throw new Error("应为 request/error");
    expect(err.status).toBe(500);
  });

  it("插话注入先落 steering 决策,再落留言;终止叫停落 termination 决策", async () => {
    const log = fresh();
    let drained = false;
    await runTurn({
      log,
      provider: scripted([
        { text: "a", toolCalls: [], stopReason: "end" },
        { text: "b", toolCalls: [], stopReason: "end" },
      ]),
      tools: [],
      drainQueue: () => {
        if (drained) return [];
        drained = true;
        return ["插话"];
      },
    });
    const i = log.events.findIndex((e) => e.type === "decision");
    const d = log.events[i];
    if (d?.type !== "decision" || d.slot !== "steering") throw new Error("应为 steering 决策");
    expect(d.boundary).toBe("step");
    expect(d.injected).toBe(1);
    expect(log.events[i + 1]).toMatchObject({ type: "user/message", text: "插话" });

    const log2 = fresh();
    const out = await runTurn({
      log: log2,
      provider: scripted([
        {
          text: "",
          toolCalls: [{ id: "c1", name: "echo", args: { text: "a" } }],
          stopReason: "tool",
        },
      ]),
      tools: [echo],
      slots: { termination: maxSteps(1) },
    });
    expect(out).toEqual({ stopped: "已达步数上限 1" });
    const last = log2.events.at(-1);
    expect(last).toMatchObject({ type: "decision", slot: "termination", steps: 1 });
  });

  it("这些事件全部只给人看:投影不受影响", async () => {
    const log = fresh();
    await runTurn({
      log,
      provider: scripted([{ text: "ok", toolCalls: [], stopReason: "end" }], (opts) => {
        opts?.onRetry?.({ attempt: 1, delayMs: 1, error: new Error("x") });
      }),
      tools: [],
      slots: { termination: maxSteps(5) },
    });
    const messages = deriveMessages(log.events);
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
  });

  it("collectRequests 按请求切段:重试归入请求,压缩归入下一请求的 before,失败与溢出重发分开", () => {
    const at = "t";
    const events: AgentEvent[] = [
      { type: "session/start", at, model: "m", system: "s" },
      { type: "user/message", at, text: "u" },
      {
        type: "request",
        at,
        model: "m",
        messages: 2,
        tools: [],
        estimatedTokens: 10,
        reason: "turn",
      },
      { type: "retry", at, attempt: 1, delayMs: 5, error: "429" },
      { type: "assistant/message", at, text: "a", toolCalls: [], stopReason: "end", latencyMs: 3 },
      { type: "user/message", at, text: "u2" },
      {
        type: "request",
        at,
        model: "m",
        messages: 4,
        tools: [],
        estimatedTokens: 99999,
        reason: "turn",
      },
      { type: "request/error", at, error: "context length exceeded", status: 400 },
      { type: "compaction", at, summary: "S", coversFrom: 1, coversUpTo: 5 },
      {
        type: "request",
        at,
        model: "m",
        messages: 3,
        tools: [],
        estimatedTokens: 50,
        reason: "overflow-retry",
      },
      { type: "assistant/message", at, text: "b", toolCalls: [], stopReason: "end" },
    ];
    const recs = collectRequests(events);
    expect(recs.map((r) => r.n)).toEqual([1, 2, 3]);
    const [a, b, c] = recs;
    if (!a || !b || !c) throw new Error("应有三条");
    expect(a.retries).toHaveLength(1);
    expect(a.response?.text).toBe("a");
    expect(b.error?.status).toBe(400);
    expect(b.response).toBeUndefined();
    expect(c.request.reason).toBe("overflow-retry");
    expect(c.before.map((e) => e.type)).toEqual(["compaction"]);
    expect(c.response?.text).toBe("b");
  });
});

describe("策略请求的真实正文与策略名(Q60)", () => {
  it("describeRequestBody:正常步 tail 为空;摘要请求 = 前缀投影 + 指示消息", () => {
    const log = fresh();
    log.append({ type: "assistant/message", at: "t", text: "a", toolCalls: [], stopReason: "end" });
    const plain = deriveMessages(log.events);
    expect(describeRequestBody(log.events, plain)).toEqual({ prefixEvents: 3, tail: [] });

    const withInstruction = [
      ...deriveMessages(log.events.slice(0, 2)),
      { role: "user" as const, content: "请压缩" },
    ];
    expect(describeRequestBody(log.events, withInstruction)).toEqual({
      prefixEvents: 2,
      tail: [{ role: "user", content: "请压缩" }],
    });

    const standalone = [
      { role: "system" as const, content: "You are a conversation compaction assistant." },
      { role: "user" as const, content: "全文…" },
    ];
    expect(describeRequestBody(log.events, standalone)).toEqual({
      prefixEvents: 0,
      tail: standalone,
    });
  });

  it("recordingProvider 把摘要请求的真实正文记进 request.body;压缩事件带策略名", async () => {
    const log = fresh();
    log.append({
      type: "assistant/message",
      at: "t",
      text: "",
      toolCalls: [{ id: "c1", name: "big", args: {} }],
      stopReason: "tool",
    });
    log.append({
      type: "tool/result",
      at: "t",
      callId: "c1",
      name: "big",
      content: "x".repeat(4000),
      isError: false,
    });
    log.append({
      type: "assistant/message",
      at: "t",
      text: "ok",
      toolCalls: [],
      stopReason: "end",
    });
    const summarizer: Provider = {
      model: "fake",
      async complete() {
        return {
          text: "摘要正文",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 900, outputTokens: 10 },
        };
      },
    };
    const strategy = llmSummarize();
    const payload = await strategy({
      events: log.events,
      window: 100000,
      targetTokens: 50,
      provider: recordingProvider(log, summarizer),
      preservation: keepRecentTokens(10),
    });
    expect(payload?.strategy).toBe("llmSummarize(structuredFull, replay)");
    const req = log.events.find((e) => e.type === "request");
    if (req?.type !== "request") throw new Error("应记 request");
    expect(req.reason).toBe("compaction");
    const body = req.body;
    if (!body) throw new Error("应记 body");
    expect(body.tail).toHaveLength(1);
    expect(body.tail[0]?.role).toBe("user");
    expect((body.tail[0] as { content: string }).content).toContain(
      "Compress the conversation above",
    );
    expect(body.prefixEvents).toBeGreaterThan(0);

    const cleared = await clearToolResults({ keepRecent: 0, clearAtLeast: 1 })({
      events: log.events,
      window: 1,
      targetTokens: 1,
    });
    expect(cleared?.strategy).toBe("clearToolResults(keepRecent=0, clearAtLeast=1)");
  });
});

describe("wire 层与实际发送一致(Q48)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("openaiCompat.wire() 与 fetch 收到的正文逐字节相同;onRaw 收到每一行", async () => {
    let sentBody = "";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      const sse = [
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
        "",
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n");
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const p = openaiCompat({
      baseUrl: "http://x",
      apiKey: "k",
      model: "m",
      reasoningField: "reasoning_content",
    });
    const messages = deriveMessages([
      { type: "session/start", at: "t", model: "m", system: "sys" },
      { type: "user/message", at: "t", text: "hello" },
    ]);
    const tools = [{ name: "echo", description: "d", parameters: { type: "object" } }];
    const raw: string[] = [];
    const turn = await p.complete(messages, tools, { onRaw: (l) => raw.push(l) });
    expect(turn.text).toBe("hi");
    expect(JSON.parse(sentBody)).toEqual(p.wire?.(messages, tools));
    expect(sentBody).toBe(JSON.stringify(p.wire?.(messages, tools)));
    expect(raw).toHaveLength(3);
    expect(raw[2]).toBe("data: [DONE]");
  });
});
