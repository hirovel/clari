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

  it("每步一行请求小结;Ctrl+O 折叠/展开工具结果;Ctrl+T 隐藏/显示思考", async () => {
    const long = defineTool({
      name: "long",
      description: "",
      parameters: Type.Object({}),
      async execute() {
        return Array.from({ length: 10 }, (_, i) => `行${i + 1}`).join("\n");
      },
    });
    const term = new VirtualTerminal(100, 40);
    const app = createTuiApp({
      terminal: term,
      log: new EventLog(),
      provider: scripted([
        {
          text: "",
          toolCalls: [{ id: "c1", name: "long", args: {} }],
          stopReason: "tool",
          reasoning: "先拿到输出",
          usage: { inputTokens: 1200, outputTokens: 20 },
        },
        {
          text: "好了",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 1500, outputTokens: 5 },
        },
      ]),
      tools: [long],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 32000 },
      reserveTokens: 32000,
      info: { model: "fake-model", providerName: "fake", sessionFile: "s" },
      systemPrompt: "sys",
      onExit: () => {},
    });
    await app.submit("跑");
    let doc = text(app);
    expect(doc).toContain("· #1  2 条消息");
    expect(doc).toContain("→ 实测 1.2k");
    expect(doc).toContain("· #2  4 条消息");
    expect(doc).toContain("行10"); // 默认完整显示(Q34)
    expect(doc).toContain("先拿到输出");

    term.feed("\x0f"); // Ctrl+O
    doc = text(app);
    expect(doc).toContain("行3");
    expect(doc).not.toContain("行10");
    expect(doc).toContain("… 还有 7 行(Ctrl+O 展开)");
    term.feed("\x0f");
    expect(text(app)).toContain("行10");

    term.feed("\x14"); // Ctrl+T
    doc = text(app);
    expect(doc).not.toContain("先拿到输出");
    expect(doc).toContain("思考(已隐藏,Ctrl+T 显示)");
    term.feed("\x14");
    expect(text(app)).toContain("先拿到输出");
    app.stop();
  });

  it("Ctrl+R 打开请求检视器,检视器接管按键,Esc 关闭后回到编辑器", async () => {
    const { app, term } = boot(
      scripted([
        {
          text: "ok",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 100, outputTokens: 2 },
        },
      ]),
    );
    await app.submit("x");
    expect(app.inspector.isOpen()).toBe(false);
    term.feed("\x12"); // Ctrl+R
    expect(app.inspector.isOpen()).toBe(true);
    let doc = app.inspector.lines(100).map(stripAnsi).join("\n");
    expect(doc).toContain("请求检视");
    expect(doc).toContain("▸ #1");
    app.inspector.key("\r");
    doc = app.inspector.lines(100).map(stripAnsi).join("\n");
    expect(doc).toContain("请求 #1");
    expect(doc).toContain("[1 概要]");
    app.inspector.key("\x1b");
    app.inspector.key("\x1b");
    expect(app.inspector.isOpen()).toBe(false);
    expect(app.inspector.lines(100)).toEqual([]);
    // 命令入口同样可用
    await app.command("/inspect");
    expect(app.inspector.isOpen()).toBe(true);
    term.feed("\x12");
    expect(app.inspector.isOpen()).toBe(false);
    // /events 直接进事件视图,/compactions 直接进压缩对照
    await app.command("/events");
    expect(app.inspector.isOpen()).toBe(true);
    expect(app.inspector.lines(100).map(stripAnsi).join("\n")).toContain("事件日志");
    app.inspector.close();
    await app.command("/compactions");
    expect(app.inspector.lines(100).map(stripAnsi).join("\n")).toContain("压缩对照");
    app.inspector.close();
    app.stop();
  });

  it("/effort 设置强度:状态栏显示、request 事件带级别、不支持的级别提示回退、auto 恢复", async () => {
    const seen: (string | undefined)[] = [];
    const provider: Provider = {
      model: "fake-model",
      async complete(_m, _t, opts) {
        seen.push(opts?.effort);
        return { text: "ok", toolCalls: [], stopReason: "end" };
      },
    };
    const term = new VirtualTerminal(100, 40);
    const log = new EventLog();
    const app = createTuiApp({
      terminal: term,
      log,
      provider,
      tools: [],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 32000 },
      reserveTokens: 32000,
      info: { model: "fake-model", providerName: "fake", sessionFile: "s" },
      systemPrompt: "sys",
      onExit: () => {},
      effortLevels: ["low", "high"],
    });
    await app.command("/effort");
    expect(text(app)).toContain("未设置");
    await app.command("/effort xhigh");
    let doc = text(app);
    expect(doc).toContain("强度已设为 xhigh");
    expect(doc).toContain("发送时向下回退");
    expect(doc).toContain("强度 xhigh");
    await app.submit("x");
    expect(seen).toEqual(["xhigh"]);
    const req = log.events.find((e) => e.type === "request");
    expect(req).toMatchObject({ type: "request", effort: "xhigh" });
    await app.command("/effort auto");
    doc = text(app);
    expect(doc).toContain("强度已恢复为不传");
    await app.submit("y");
    expect(seen).toEqual(["xhigh", undefined]);
    await app.command("/effort ultra");
    expect(text(app)).toContain('未知级别 "ultra"');
    app.stop();
  });

  it("/models 对照服务器列表与配置:标出下线与新增", async () => {
    const provider: Provider = {
      model: "fake-model",
      async complete() {
        throw new Error("x");
      },
      listModels: async () => ["fake-model", "fresh-model"],
    };
    const settings: TuiSettings = {
      listModels: () => ["fake/fake-model", "fake/retired-model", "other/big-model"],
      switchModel: () => {
        throw new Error("n/a");
      },
      setKey: () => {},
      setDefault: () => {},
    };
    const { app } = boot(provider, settings);
    await app.command("/models");
    const doc = text(app);
    expect(doc).toContain("服务器 2 个模型 · 配置 2 个");
    expect(doc).toContain("✓ fake-model");
    expect(doc).toContain("✗ retired-model");
    expect(doc).toContain("可能已下线");
    expect(doc).toContain("· fresh-model");
    expect(doc).not.toContain("big-model");
    app.stop();
  });

  it("edit 调用显示行级 diff,write 显示前几行与总行数(Q58)", async () => {
    const { app } = boot(
      scripted([
        {
          text: "",
          toolCalls: [
            {
              id: "c1",
              name: "edit",
              args: { path: "a.ts", oldText: "x = 1\ny = 2", newText: "x = 1\ny = 3" },
            },
            {
              id: "c2",
              name: "write",
              args: {
                path: "b.txt",
                content: Array.from({ length: 20 }, (_, i) => `L${i}`).join("\n"),
              },
            },
          ],
          stopReason: "tool",
        },
        { text: "done", toolCalls: [], stopReason: "end" },
      ]),
    );
    await app.submit("改");
    const doc = text(app);
    expect(doc).toContain("- y = 2");
    expect(doc).toContain("+ y = 3");
    expect(doc).toContain("+ L0");
    expect(doc).toContain("… 共 20 行");
    expect(doc).not.toContain("+ L19");
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
