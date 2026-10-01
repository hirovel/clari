import { getEventListeners } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  anthropic,
  feedAnthropicEvent,
  finishAnthropicAcc,
  newAnthropicAcc,
} from "../src/providers/anthropic.js";
import { isContextOverflow, isRetryable, ProviderError } from "../src/providers/errors.js";
import { linkedAbort } from "../src/providers/http.js";
import {
  feedChunk,
  finishAcc,
  newAcc,
  openaiCompat,
  toWire,
} from "../src/providers/openai-chat.js";
import { openaiResponses } from "../src/providers/openai-responses.js";
import { withRetry } from "../src/providers/retry.js";

it("请求取消不累积整轮监听器;本地超时不取消兄弟请求,整轮取消向下传递", async () => {
  const turn = new AbortController();
  const requests = Array.from({ length: 12 }, () => linkedAbort(turn.signal));
  expect(getEventListeners(turn.signal, "abort")).toHaveLength(0);
  requests[0]?.abort();
  expect(requests[0]?.signal.aborted).toBe(true);
  expect(turn.signal.aborted).toBe(false);
  expect(requests[1]?.signal.aborted).toBe(false);
  turn.abort();
  expect(requests.every((request) => request.signal.aborted)).toBe(true);
  expect(linkedAbort(turn.signal).signal.aborted).toBe(true);
  let started = () => {};
  let closed = () => {};
  let hold = false;
  let body = '{"data":[{"id":"fixture-model"}]}';
  const server = createServer((_req, res) => {
    if (hold) {
      res.once("close", () => closed());
      started();
    } else res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const options = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    apiKey: "local-fixture",
    model: "fixture-model",
  };
  try {
    for (const provider of [openaiCompat(options), openaiResponses(options), anthropic(options)]) {
      hold = false;
      body = '{"data":[{"id":"fixture-model"}]}';
      expect(await provider.listModels?.()).toEqual(["fixture-model"]);
      body = "{}";
      await expect(provider.listModels?.()).rejects.toThrow("Invalid model list");
      hold = true;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const disconnected = new Promise<void>((resolve) => {
        closed = resolve;
      });
      const controller = new AbortController();
      const interrupted = expect(provider.listModels?.(controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
      await ready;
      controller.abort();
      await interrupted;
      await disconnected;
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("withRetry", () => {
  const noSleep = { sleep: async () => {} };

  it("可重试错误重试到成功,次数与退避可观测", async () => {
    let calls = 0;
    const delays: number[] = [];
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new ProviderError("provider 503: busy", { status: 503 });
        return "ok";
      },
      { sleep: async (ms) => void delays.push(ms), baseDelayMs: 100 },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2);
    expect(delays[1]).toBeGreaterThan(delays[0] ?? 0); // 指数退避
  });

  it("上下文溢出不重试(交给压缩恢复);400 不重试;打断不重试", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new ProviderError("provider 400: prompt is too long", { status: 400 });
      }, noSleep),
    ).rejects.toThrow("prompt is too long");
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new ProviderError("provider 400: bad", { status: 400 });
      }, noSleep),
    ).rejects.toThrow("bad");
    expect(calls).toBe(1);

    // 在实际退避等待期间取消,应立即结束且不发出下一次请求。
    const controller = new AbortController();
    let ready!: () => void;
    const waiting = new Promise<void>((resolve) => {
      ready = resolve;
    });
    calls = 0;
    const pending = withRetry(
      async () => {
        calls++;
        throw new ProviderError("429", { status: 429, retryAfterMs: 30000 });
      },
      { signal: controller.signal, onRetry: ready },
    );
    const interrupted = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await waiting;
    controller.abort();
    await interrupted;
    expect(calls).toBe(1);
    await expect(
      withRetry(async () => calls++, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("服务端 retry-after 优先于退避;超过上限直接失败", async () => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls === 1) throw new ProviderError("429", { status: 429, retryAfterMs: 1234 });
        return 1;
      },
      { sleep: async (ms) => void delays.push(ms) },
    );
    expect(delays).toEqual([1234]);

    await expect(
      withRetry(async () => {
        throw new ProviderError("429", { status: 429, retryAfterMs: 999999 });
      }, noSleep),
    ).rejects.toThrow("429");
  });

  it("用尽 maxRetries 后抛出最后一次错误", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new ProviderError("provider 500", { status: 500 });
        },
        { ...noSleep, maxRetries: 2 },
      ),
    ).rejects.toThrow("provider 500");
    expect(calls).toBe(3);
  });
});

describe("错误归一", () => {
  it("溢出文案库覆盖三家,排除限流误判", () => {
    expect(isContextOverflow(new Error('400 {"code":"context_length_exceeded"}'))).toBe(true);
    expect(isContextOverflow(new Error("prompt is too long: 210000 tokens > 200000"))).toBe(true);
    expect(
      isContextOverflow(new Error("This model's maximum context length is 131072 tokens")),
    ).toBe(true);
    expect(isContextOverflow(new Error("Rate limit reached for tokens per minute"))).toBe(false);
    expect(isContextOverflow(new Error("fetch failed"))).toBe(false);
  });

  it("可重试判定:状态码集合与网络层失败", () => {
    expect(new ProviderError("x", { status: 429 }).retryable).toBe(true);
    expect(new ProviderError("x", { status: 503 }).retryable).toBe(true);
    expect(new ProviderError("x", { status: 401 }).retryable).toBe(false);
    expect(isRetryable(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryable(new Error("stream ended without finish_reason"))).toBe(true);
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(isRetryable(abort)).toBe(false);
  });
});

describe("推理内容与用量归一(OpenAI 兼容)", () => {
  it("reasoning_content 单独累积,随 turn 返回;缓存命中与推理 token 归一", () => {
    const acc = newAcc();
    feedChunk(acc, { choices: [{ delta: { reasoning_content: "先想" } }] });
    feedChunk(acc, { choices: [{ delta: { reasoning_content: "一想" } }] });
    feedChunk(acc, { choices: [{ delta: { content: "答案" }, finish_reason: "stop" }] });
    feedChunk(acc, {
      choices: [],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 640,
        completion_tokens_details: { reasoning_tokens: 30 },
      },
    });
    const turn = finishAcc(acc, false);
    expect(turn.reasoning).toBe("先想一想");
    expect(turn.text).toBe("答案");
    expect(turn.usage).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 640,
      reasoningTokens: 30,
    });
  });

  it("toWire:给了 reasoningField 才回传推理,且每条 assistant 都带(缺失补空串)", () => {
    const withReasoning = toWire(
      { role: "assistant", content: "a", toolCalls: [], reasoning: "r" },
      "reasoning_content",
    );
    expect(withReasoning).toMatchObject({ reasoning_content: "r" });
    const missing = toWire({ role: "assistant", content: "a", toolCalls: [] }, "reasoning_content");
    expect(missing).toMatchObject({ reasoning_content: "" });
    const plain = toWire({ role: "assistant", content: "a", toolCalls: [], reasoning: "r" });
    expect("reasoning_content" in plain).toBe(false);
  });
});

describe("Anthropic 用量归一", () => {
  it("input_tokens 不含缓存,占窗输入 = 三者之和;缓存命中单列", () => {
    const acc = newAnthropicAcc();
    feedAnthropicEvent(acc, {
      type: "message_start",
      message: {
        usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100 },
      },
    });
    feedAnthropicEvent(acc, {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 7 },
    });
    expect(finishAnthropicAcc(acc, false).usage).toEqual({
      inputTokens: 115,
      outputTokens: 7,
      cacheReadTokens: 100,
      cacheWriteTokens: 5,
    });
  });
});
