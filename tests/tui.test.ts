import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { createTuiApp, type TuiApp, type TuiSettings } from "../cli/tui-app.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "fake-model",
    async complete(_m, _t, opts) {
      const t = turns[i++];
      if (!t) throw new Error("脚本越界");
      if (t.text && opts?.onDelta) opts.onDelta(t.text); // 模拟流式:整段作为一次增量
      return t;
    },
  };
}

const echo = defineTool({
  name: "echo",
  description: "回显",
  parameters: Type.Object({ text: Type.String() }),
  async execute(args) {
    return `echo:${args.text}`;
  },
});

function boot(provider: Provider, settings?: TuiSettings): { app: TuiApp; term: VirtualTerminal } {
  const term = new VirtualTerminal(100, 40);
  const app = createTuiApp({
    terminal: term,
    log: new EventLog(),
    provider,
    tools: [echo],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 32000 },
    reserveTokens: 32000,
    info: { model: "fake-model", providerName: "fake", sessionFile: "sessions/t.jsonl" },
    ...(settings && { settings }),
    systemPrompt: "sys",
    onExit: () => {},
  });
  return { app, term };
}

const text = (app: TuiApp) => app.lines(100).map(stripAnsi).join("\n");

describe("TUI 壳", () => {
  it("一个完整 turn:用户消息、工具调用与结果、流式回复、状态栏全部呈现且不重复", async () => {
    const { app, term } = boot(
      scripted([
        {
          text: "",
          toolCalls: [{ id: "c1", name: "echo", args: { text: "hi" } }],
          stopReason: "tool",
        },
        {
          text: "**完成**:内容是 hi",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 1200, outputTokens: 40 },
        },
      ]),
    );
    await app.submit("读一下");
    const doc = text(app);

    expect(doc).toContain("agent-kernel");
    expect(doc).toContain("fake-model");
    expect(doc).toContain("› 读一下");
    expect(doc).toContain("⚙ echo");
    expect(doc).toContain("✓ echo");
    expect(doc).toContain("echo:hi");
    expect(doc).toContain("完成");
    expect(doc.match(/内容是 hi/g)?.length).toBe(1); // 流式组件被定稿替换,不重复
    expect(doc).toContain("○ 空闲");
    expect(doc).toContain("1200→40 tok");
    expect(doc).toContain("距自动压缩 98%");

    // 整条渲染管线:经差分渲染写入模拟终端后,屏幕上确实有内容
    app.tui.renderNow(true);
    const screen = (await term.screen()).join("\n");
    expect(screen).toContain("agent-kernel");
    expect(screen).toContain("读一下");
    app.stop();
  });

  it("/help 与 /context 输出", async () => {
    const { app } = boot(scripted([]));
    await app.command("/help");
    await app.command("/context");
    const doc = text(app);
    expect(doc).toContain("/compact");
    expect(doc).toContain("/model");
    expect(doc).toContain("上下文构成");
    expect(doc).toContain("系统提示词");
    app.stop();
  });

  it("设置:/model 列表与切换、/key 写入、/default", async () => {
    const calls: string[] = [];
    const settings: TuiSettings = {
      listModels: () => ["fake/fake-model", "other/big-model"],
      switchModel: (name) => {
        calls.push(`switch:${name}`);
        return {
          provider: {
            model: "big-model",
            async complete() {
              throw new Error("x");
            },
          },
          model: "big-model",
          providerName: "other",
          contextWindow: 200000,
        };
      },
      setKey: (p, k) => calls.push(`key:${p}:${k}`),
      setDefault: (m) => calls.push(`default:${m}`),
    };
    const { app } = boot(scripted([]), settings);

    await app.command("/model");
    expect(text(app)).toContain("▸ fake/fake-model");

    await app.command("/model other/big-model");
    expect(calls).toContain("switch:other/big-model");
    expect(text(app)).toContain("big-model");
    expect(text(app)).toContain("已切换模型");
    expect(app.agent.provider.model).toBe("big-model");

    await app.command("/key deepseek sk-123");
    expect(calls).toContain("key:deepseek:sk-123");
    expect(text(app)).toContain("key 已写入");

    await app.command("/default");
    expect(calls).toContain("default:other/big-model");
    app.stop();
  });

  it("Esc 通过终端输入通道打断运行中的 turn", async () => {
    const provider: Provider = {
      model: "fake-model",
      async complete(_m, _t, opts) {
        await new Promise<void>((r) =>
          opts?.signal?.addEventListener("abort", () => r(), { once: true }),
        );
        return { text: "半截", toolCalls: [], stopReason: "aborted" };
      },
    };
    const { app, term } = boot(provider);
    const running = app.submit("长任务");
    await new Promise((r) => setImmediate(r));
    expect(text(app)).toContain("● 运行中");
    term.feed("\x1b");
    await running;
    const doc = text(app);
    expect(doc).toContain("— 已打断 —");
    expect(doc).toContain("○ 空闲");
    app.stop();
  });

  it("请求失败不崩:错误以朱标行呈现,状态回到空闲", async () => {
    const provider: Provider = {
      model: "fake-model",
      async complete() {
        throw new Error("网络断了");
      },
    };
    const { app } = boot(provider);
    await app.submit("x");
    const doc = text(app);
    expect(doc).toContain("✗ 请求失败:网络断了");
    expect(doc).toContain("○ 空闲");
    app.stop();
  });
});
