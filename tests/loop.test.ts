import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/log.js";
import { maxSteps, queueToTurnEnd, runTurn, steer } from "../src/loop.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";

// 脚本化 provider:按序吐出预设的 turn,离线验证循环语义。
function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "fake",
    async complete() {
      const turn = turns[i];
      if (!turn) throw new Error(`脚本只有 ${turns.length} 个 turn,第 ${i + 1} 次请求越界`);
      i += 1;
      return turn;
    },
  };
}

const echoTool = defineTool({
  name: "echo",
  description: "回显",
  parameters: Type.Object({ text: Type.String() }),
  async execute(args) {
    return `echo:${args.text}`;
  },
});

const failTool = defineTool({
  name: "fail",
  description: "总是失败",
  parameters: Type.Object({}),
  async execute() {
    throw new Error("工具内部错误");
  },
});

function newLog(): EventLog {
  const log = new EventLog();
  log.append({ type: "session/start", at: "t", model: "fake", system: "sys" });
  log.append({ type: "user/message", at: "t", text: "开始" });
  return log;
}

function call(name: string, args: unknown, id = "c1") {
  return { id, name, args };
}

/** 首条工具结果。请求/决策等只给人的事件夹在中间,不按固定下标取。 */
function firstResult(log: EventLog) {
  return log.events.find((e) => e.type === "tool/result");
}

describe("runTurn", () => {
  it("工具调用→执行→回喂→模型收尾:事件序列完整", async () => {
    const log = newLog();
    const outcome = await runTurn({
      log,
      provider: scripted([
        { text: "", toolCalls: [call("echo", { text: "hi" })], stopReason: "tool" },
        { text: "完成", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echoTool],
    });
    expect(outcome).toBe("idle");
    // 每次模型请求前落一条 request(只给人看),响应紧随其后。
    expect(log.events.map((e) => e.type)).toEqual([
      "session/start",
      "user/message",
      "request",
      "assistant/message",
      "tool/result",
      "request",
      "assistant/message",
    ]);
    expect(firstResult(log)).toMatchObject({ callId: "c1", content: "echo:hi", isError: false });
  });

  it("工具抛异常→isError 结果回喂,循环继续不炸(Q9)", async () => {
    const log = newLog();
    const outcome = await runTurn({
      log,
      provider: scripted([
        { text: "", toolCalls: [call("fail", {})], stopReason: "tool" },
        { text: "看到错误了", toolCalls: [], stopReason: "end" },
      ]),
      tools: [failTool],
    });
    expect(outcome).toBe("idle");
    expect(firstResult(log)).toMatchObject({ content: "工具内部错误", isError: true });
  });

  it("参数校验失败→错误文本含路径与原参数,不执行工具(Q19)", async () => {
    const log = newLog();
    await runTurn({
      log,
      provider: scripted([
        { text: "", toolCalls: [call("echo", { wrong: 1 })], stopReason: "tool" },
        { text: "", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echoTool],
    });
    const result = firstResult(log) as { content: string; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content).toContain("参数校验失败");
    expect(result.content).toContain('"wrong": 1');
  });

  it("审批拒绝→不执行,以错误结果回喂(Q23)", async () => {
    const log = newLog();
    await runTurn({
      log,
      provider: scripted([
        { text: "", toolCalls: [call("echo", { text: "hi" })], stopReason: "tool" },
        { text: "", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echoTool],
      slots: { approve: () => false },
    });
    expect(firstResult(log)).toMatchObject({ content: "用户拒绝执行此调用。", isError: true });
  });

  it("maxSteps 终止策略叫停,返回 stopped 理由(Q8)", async () => {
    const log = newLog();
    const loopForever: AssistantTurn = {
      text: "",
      toolCalls: [call("echo", { text: "x" })],
      stopReason: "tool",
    };
    const outcome = await runTurn({
      log,
      provider: scripted([loopForever, loopForever, loopForever]),
      tools: [echoTool],
      slots: { termination: maxSteps(2) },
    });
    expect(outcome).toEqual({ stopped: "已达步数上限 2" });
  });

  it("length:一个都不执行,逐个补错误应答后让模型重发(Q26)", async () => {
    const log = newLog();
    await runTurn({
      log,
      provider: scripted([
        {
          text: "",
          toolCalls: [call("echo", { text: "a" }, "c1"), call("echo", { text: "b" }, "c2")],
          stopReason: "length",
        },
        { text: "重发", toolCalls: [call("echo", { text: "a" }, "c3")], stopReason: "tool" },
        { text: "", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echoTool],
    });
    const results = log.events.filter((e) => e.type === "tool/result");
    expect(results[0]).toMatchObject({ callId: "c1", isError: true });
    expect(results[1]).toMatchObject({ callId: "c2", isError: true });
    expect(results[2]).toMatchObject({ callId: "c3", content: "echo:a", isError: false });
  });

  it("steer 模式:插话在 step 边界注入,模型下一步就看到(Q20)", async () => {
    const log = newLog();
    const queue = ["插话"];
    await runTurn({
      log,
      provider: scripted([
        { text: "", toolCalls: [call("echo", { text: "hi" })], stopReason: "tool" },
        { text: "收到插话", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echoTool],
      slots: { steering: steer },
      drainQueue: () => queue.splice(0),
    });
    const types = log.events.map((e) => e.type);
    // 插话紧跟在工具结果之后、下一条请求之前;注入决定先于留言落盘
    expect(types).toEqual([
      "session/start",
      "user/message",
      "request",
      "assistant/message",
      "tool/result",
      "decision",
      "user/message",
      "request",
      "assistant/message",
    ]);
  });

  it("queue 模式:插话等到 turn 末才注入,并触发新一轮(Q20)", async () => {
    const log = newLog();
    const queue = ["插话"];
    await runTurn({
      log,
      provider: scripted([
        { text: "", toolCalls: [call("echo", { text: "hi" })], stopReason: "tool" },
        { text: "第一件事完成", toolCalls: [], stopReason: "end" },
        { text: "处理插话", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echoTool],
      slots: { steering: queueToTurnEnd },
      drainQueue: () => queue.splice(0),
    });
    const types = log.events.map((e) => e.type);
    // 插话出现在第二条 assistant(end)之后
    expect(types).toEqual([
      "session/start",
      "user/message",
      "request",
      "assistant/message",
      "tool/result",
      "request",
      "assistant/message",
      "decision",
      "user/message",
      "request",
      "assistant/message",
    ]);
  });

  it("打断:剩余调用不执行但逐个补应答,投影保持合法(Q21)", async () => {
    const log = newLog();
    const ac = new AbortController();
    const abortingTool = defineTool({
      name: "boom",
      description: "执行时触发打断",
      parameters: Type.Object({}),
      async execute() {
        ac.abort();
        throw new Error("执行中被打断");
      },
    });
    const outcome = await runTurn({
      log,
      provider: scripted([
        {
          text: "",
          toolCalls: [call("boom", {}, "c1"), call("echo", { text: "x" }, "c2")],
          stopReason: "tool",
        },
      ]),
      tools: [abortingTool, echoTool],
      signal: ac.signal,
    });
    expect(outcome).toBe("aborted");
    const results = log.events.filter((e) => e.type === "tool/result");
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ callId: "c1", isError: true });
    expect(results[1]).toMatchObject({
      callId: "c2",
      content: "已被用户打断,未执行。",
      isError: true,
    });
  });

  it("未知工具→错误回喂,不抛出", async () => {
    const log = newLog();
    await runTurn({
      log,
      provider: scripted([
        { text: "", toolCalls: [call("nope", {})], stopReason: "tool" },
        { text: "", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echoTool],
    });
    expect(firstResult(log)).toMatchObject({ content: '未知工具 "nope"。', isError: true });
  });
});
