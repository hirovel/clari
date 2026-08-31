import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.js";
import { EventLog } from "../src/log.js";
import type { Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";

const echoTool = defineTool({
  name: "echo",
  description: "回显",
  parameters: Type.Object({ text: Type.String() }),
  async execute(args) {
    return `echo:${args.text}`;
  },
});

function newLog(): EventLog {
  const log = new EventLog();
  log.append({ type: "session/start", at: "t", model: "fake", system: "sys" });
  return log;
}

const tick = () => new Promise((r) => setImmediate(r));

describe("Agent", () => {
  it("运行中 prompt 进入队列,steer 默认策略在步边界注入", async () => {
    const log = newLog();
    let release = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const provider: Provider = {
      model: "fake",
      async complete() {
        calls += 1;
        if (calls === 1) {
          await gate; // 卡住第一次请求,给插话留出时间窗
          return {
            text: "",
            toolCalls: [{ id: "c1", name: "echo", args: { text: "x" } }],
            stopReason: "tool",
          };
        }
        return { text: "done", toolCalls: [], stopReason: "end" };
      },
    };
    const agent = new Agent({ log, provider, tools: [echoTool] });

    const first = agent.prompt("第一条");
    await tick();
    expect(agent.running).toBe(true);

    void agent.prompt("插话"); // 运行中 → 排队
    release();
    const outcome = await first;

    expect(outcome).toBe("idle");
    const texts = log.events.filter((e) => e.type === "user/message").map((e) => e.text);
    expect(texts).toEqual(["第一条", "插话"]);
    // 插话位于工具结果之后(步边界),不在末尾游离
    const types = log.events.map((e) => e.type);
    expect(types.indexOf("user/message", types.indexOf("tool/result"))).toBeLessThan(
      types.lastIndexOf("assistant/message"),
    );
  });

  it("interrupt:记 session/interrupt 事件并让 turn 以 aborted 收场(Q11)", async () => {
    const log = newLog();
    const provider: Provider = {
      model: "fake",
      async complete(_msgs, _tools, opts) {
        await new Promise<void>((resolve) => {
          opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { text: "半截", toolCalls: [], stopReason: "aborted" };
      },
    };
    const agent = new Agent({ log, provider, tools: [] });

    const running = agent.prompt("跑一个长任务");
    await tick();
    agent.interrupt();
    const outcome = await running;

    expect(outcome).toBe("aborted");
    expect(log.events.some((e) => e.type === "session/interrupt")).toBe(true);
    expect(log.events.at(-1)).toMatchObject({ type: "assistant/message", stopReason: "aborted" });
    expect(agent.running).toBe(false);
  });

  it("空闲时 prompt:上次打断遗留的队列先注入,不静默丢弃(Q20 硬规矩)", async () => {
    const log = newLog();
    let firstRun = true;
    const provider: Provider = {
      model: "fake",
      async complete(_msgs, _tools, opts) {
        if (firstRun) {
          firstRun = false;
          await new Promise<void>((resolve) => {
            opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          return { text: "", toolCalls: [], stopReason: "aborted" };
        }
        return { text: "ok", toolCalls: [], stopReason: "end" };
      },
    };
    const agent = new Agent({ log, provider, tools: [] });

    const running = agent.prompt("任务A");
    await tick();
    void agent.prompt("打断期间的留言"); // 排队
    agent.interrupt(); // aborted 返回,队列保留
    await running;

    await agent.prompt("任务B");
    const texts = log.events.filter((e) => e.type === "user/message").map((e) => e.text);
    expect(texts).toEqual(["任务A", "打断期间的留言", "任务B"]);
  });
});
