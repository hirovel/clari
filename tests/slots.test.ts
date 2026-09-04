// 会话中切换策略槽(Q78):命令改变下一次 turn 的行为,每次切换记 session/slot,/slots 显示当前。
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { createTuiApp } from "../cli/tui-app.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
import { VirtualTerminal } from "./helpers/virtual-terminal.js";

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string) => s.replace(ansi, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "m",
    async complete() {
      return turns[i++] ?? { text: "done", toolCalls: [], stopReason: "end" };
    },
  };
}

function boot(provider: Provider) {
  const log = new EventLog();
  const slow = defineTool({
    name: "slow",
    description: "",
    parameters: Type.Object({}),
    concurrency: "parallel",
    async execute() {
      await sleep(5);
      return "ok";
    },
  });
  const app = createTuiApp({
    terminal: new VirtualTerminal(110, 30),
    log,
    provider,
    tools: [slow],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
    reserveTokens: 1000,
    info: { model: "m", providerName: "p", sessionFile: "s" },
    systemPrompt: "s",
    compactionName: "llm",
    onExit: () => {},
  });
  const text = () => app.lines(110).map(plain).join("\n");
  return { app, log, text };
}

describe("/slots 与切换命令", () => {
  it("/slots 列出缺省;/execution parallel 记事件并让下一 turn 并行;/steering turn 让插话等到 turn 边界", async () => {
    const two = [
      { id: "a", name: "slow", args: {} },
      { id: "b", name: "slow", args: {} },
    ];
    const { app, log, text } = boot(
      scripted([
        { text: "", toolCalls: two, stopReason: "tool" },
        { text: "first", toolCalls: [], stopReason: "end" },
        { text: "", toolCalls: two, stopReason: "tool" },
        { text: "second", toolCalls: [], stopReason: "end" },
      ]),
    );
    await app.command("/slots");
    let doc = text();
    expect(doc).toContain("execution     sequential");
    expect(doc).toContain("compaction    llm");
    expect(doc).toContain("steering      step");

    // 缺省串行:第一 turn 没有 execution 决策事件
    await app.submit("go");
    expect(log.events.some((e) => e.type === "decision" && e.slot === "execution")).toBe(false);

    await app.command("/execution parallel");
    expect(log.events.at(-1)).toMatchObject({
      type: "session/slot",
      slot: "execution",
      value: "parallel",
    });
    expect(text()).toContain("execution → parallel");
    await app.submit("again");
    const decisions = log.events.filter((e) => e.type === "decision" && e.slot === "execution");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ parallel: 2 });

    await app.command("/steering turn");
    expect(app.agent.slots.steering).toBeDefined();
    expect(log.events.at(-1)).toMatchObject({
      type: "session/slot",
      slot: "steering",
      value: "turn",
    });
    await app.command("/slots");
    doc = text();
    expect(doc).toContain("steering      turn");
    expect(doc).toContain("execution     parallel");
    app.stop();
  });

  it("参数校验:非法值给用法;运行中拒绝;/compaction clear 换策略且 /compact 用它;/compaction off 关自动", async () => {
    const { app, log, text } = boot(scripted([]));
    await app.command("/execution sideways");
    expect(text()).toContain("Usage: /execution sequential|parallel");
    await app.command("/preservation ratio 3");
    expect(text()).toContain("ratio must be between 0 and 1");

    // 造几条工具结果,让 clear 策略有东西可清
    for (let i = 0; i < 6; i++) {
      log.append({
        type: "assistant/message",
        at: "",
        text: "",
        toolCalls: [{ id: `c${i}`, name: "slow", args: {} }],
        stopReason: "tool",
      });
      log.append({
        type: "tool/result",
        at: "",
        callId: `c${i}`,
        name: "slow",
        content: "x".repeat(4000),
        isError: false,
      });
    }
    await app.command("/compaction clear");
    expect(log.events.at(-1)).toMatchObject({
      type: "session/slot",
      slot: "compaction",
      value: "clear",
    });
    await app.command("/compact");
    const comp = log.events.at(-1);
    expect(comp?.type).toBe("compaction");
    expect(comp?.type === "compaction" && comp.strategy).toContain("clearToolResults");

    await app.command("/compaction off");
    expect(log.events.at(-1)).toMatchObject({ type: "session/slot", slot: "compaction" });
    expect(text()).toContain("auto-compaction disabled");

    await app.command("/compaction ./does-not-exist.mjs");
    expect(text()).toContain("✗");
    app.stop();
  });
});
