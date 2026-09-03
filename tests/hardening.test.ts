import { describe, expect, it } from "vitest";
import { feedChunk, finishAcc, newAcc, toWire } from "../src/provider.js";
import {
  feedAnthropicEvent,
  finishAnthropicAcc,
  newAnthropicAcc,
} from "../src/providers/anthropic.js";
import { isContextOverflow, isRetryable, ProviderError } from "../src/providers/errors.js";
import { withRetry } from "../src/providers/retry.js";

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
