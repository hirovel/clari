import { describe, expect, it } from "vitest";
import { CONFIG_TEMPLATE, resolveApiKey, resolveModel } from "../src/config.js";
import {
  type AnthropicEvent,
  feedAnthropicEvent,
  finishAnthropicAcc,
  newAnthropicAcc,
  toAnthropicWire,
} from "../src/providers/anthropic.js";

describe("Anthropic 流式累积", () => {
  it("文本 + 工具调用分块累积,usage 来自 message_start 与 message_delta", () => {
    const acc = newAnthropicAcc();
    const events: AnthropicEvent[] = [
      { type: "message_start", message: { usage: { input_tokens: 120 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "先看" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "文件" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tu_1", name: "read" },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"pa' },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: 'th":"a.ts"}' },
      },
      { type: "content_block_stop", index: 1 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } },
      { type: "message_stop" },
    ];
    const deltas = events.map((e) => feedAnthropicEvent(acc, e)).filter(Boolean);
    expect(deltas).toEqual(["先看", "文件"]);

    const turn = finishAnthropicAcc(acc, false);
    expect(turn).toEqual({
      text: "先看文件",
      toolCalls: [{ id: "tu_1", name: "read", args: { path: "a.ts" } }],
      stopReason: "tool",
      usage: { inputTokens: 120, outputTokens: 30 },
    });
  });

  it("max_tokens → length;aborted 丢弃调用保留文本", () => {
    const acc = newAnthropicAcc();
    feedAnthropicEvent(acc, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "半" },
    });
    feedAnthropicEvent(acc, { type: "message_delta", delta: { stop_reason: "max_tokens" } });
    expect(finishAnthropicAcc(acc, false).stopReason).toBe("length");
    expect(finishAnthropicAcc(acc, true)).toMatchObject({ text: "半", stopReason: "aborted" });
  });
});

describe("toAnthropicWire", () => {
  it("system 抽顶层;连续工具结果合并进一条 user 消息;空 assistant 补占位", () => {
    const wire = toAnthropicWire([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "read", args: { path: "x" } },
          { id: "b", name: "bash", args: { command: "ls" } },
        ],
      },
      { role: "tool", callId: "a", name: "read", content: "R", isError: false },
      { role: "tool", callId: "b", name: "bash", content: "E", isError: true },
      { role: "assistant", content: "", toolCalls: [] },
    ]);
    expect(wire.system).toBe("S");
    expect(wire.messages).toHaveLength(4);
    expect(wire.messages[1]?.content.map((b) => b.type)).toEqual(["tool_use", "tool_use"]);
    expect(wire.messages[2]?.role).toBe("user");
    expect(wire.messages[2]?.content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: "R" },
      { type: "tool_result", tool_use_id: "b", content: "E", is_error: true },
    ]);
    expect(wire.messages[3]?.content).toEqual([{ type: "text", text: "(空)" }]);
  });
});

describe("config 解析", () => {
  it("按 models 列表匹配、按前缀猜、供应商/模型显式写法", () => {
    expect(resolveModel(CONFIG_TEMPLATE, "deepseek-chat").providerName).toBe("deepseek");
    expect(resolveModel(CONFIG_TEMPLATE, "claude-opus-5").providerName).toBe("anthropic");
    expect(resolveModel(CONFIG_TEMPLATE, "claude-unlisted-9").providerName).toBe("anthropic");
    const explicit = resolveModel(CONFIG_TEMPLATE, "openai/gpt-x");
    expect(explicit).toMatchObject({
      providerName: "openai",
      model: "gpt-x",
      contextWindow: 400000,
    });
    expect(resolveModel(CONFIG_TEMPLATE).model).toBe("deepseek-chat");
  });

  it("匹配失败时列出全部已配置模型", () => {
    expect(() => resolveModel(CONFIG_TEMPLATE, "mystery")).toThrow("deepseek/deepseek-chat");
  });

  it("key:配置字段优先,其次环境变量,都缺则指路", () => {
    const p = CONFIG_TEMPLATE.providers.deepseek;
    if (!p) throw new Error("模板缺 deepseek");
    expect(resolveApiKey("deepseek", { ...p, apiKey: " k1 " }, {})).toBe("k1");
    expect(resolveApiKey("deepseek", p, { DEEPSEEK_API_KEY: "k2" })).toBe("k2");
    expect(() => resolveApiKey("deepseek", p, {})).toThrow("DEEPSEEK_API_KEY");
  });
});
