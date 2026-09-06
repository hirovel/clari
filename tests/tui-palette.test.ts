// 命令面板:Ctrl+K 打开,模糊过滤,Enter 跑命令或填输入框,模型条目切模型,Esc 关。
import { describe, expect, it } from "vitest";
import { createTuiApp, type TuiSettings } from "../cli/tui-app.js";
import { Palette, type PaletteItem } from "../cli/tui-palette.js";
import { EventLog } from "../src/log.js";
import type { Provider } from "../src/provider.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

const plain = (lines: string[]) => lines.map(stripAnsi).join("\n");

describe("Palette 组件", () => {
  it("模糊过滤、光标环绕、Enter 跑选中项并关闭、Esc 只关闭", () => {
    const ran: string[] = [];
    let closed = 0;
    const items: PaletteItem[] = [
      { kind: "command", label: "/model", note: "switch", run: () => ran.push("model") },
      { kind: "command", label: "/memory", note: "memory", run: () => ran.push("memory") },
      { kind: "model", label: "deepseek/deepseek-v4-pro", run: () => ran.push("ds") },
    ];
    const p = new Palette(items, () => closed++);
    let out = plain(p.render());
    expect(out).toContain("Command palette");
    expect(out).toContain("▸ /model");
    expect(out).toContain("cmd");
    p.handleInput("d");
    p.handleInput("s");
    out = plain(p.render());
    expect(out).toContain("› ds");
    expect(out).toContain("deepseek/deepseek-v4-pro");
    expect(out).not.toContain("/memory");
    p.handleInput("\x7f");
    p.handleInput("\x7f");
    p.handleInput("\x1b[A"); // 从第 0 项上翻到末项
    expect(plain(p.render())).toContain("▸ deepseek/deepseek-v4-pro");
    p.handleInput("\r");
    expect(ran).toEqual(["ds"]);
    expect(closed).toBe(1);
    p.handleInput("\x1b");
    expect(closed).toBe(2);
    p.handleInput("z");
    p.handleInput("z");
    expect(plain(p.render())).toContain("no match");
  });
});

describe("Ctrl+K", () => {
  it("打开面板;选模型切换;要参数的命令填进输入框;不要参数的直接跑", async () => {
    const term = new VirtualTerminal(110, 30);
    const real: Provider = {
      model: "big-model",
      async complete() {
        return { text: "ok", toolCalls: [], stopReason: "end" };
      },
    };
    const switched: string[] = [];
    const settings: TuiSettings = {
      listModels: () => ["fake/fake-model", "other/big-model"],
      switchModel: (name) => {
        switched.push(name);
        return { provider: real, model: "big-model", providerName: "other", contextWindow: 1000 };
      },
      setKey: () => {},
      setDefault: () => {},
      providers: () => [{ name: "other", protocol: "openai", models: ["big-model"] }],
      verifyKey: async () => [],
    };
    const app = createTuiApp({
      terminal: term,
      log: new EventLog(),
      provider: real,
      tools: [],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "fake-model", providerName: "fake", sessionFile: "s" },
      systemPrompt: "sys",
      settings,
      skills: [],
      onExit: () => {},
    });
    term.feed("\x0b"); // Ctrl+K
    let out = plain(app.dialogLines());
    expect(out).toContain("Command palette");
    expect(out).toContain("/inspect");
    for (const ch of "other") app.dialogInput(ch);
    out = plain(app.dialogLines());
    expect(out).toContain("other/big-model");
    expect(out).toContain("login other");
    expect(out).toContain("key missing");
    for (const ch of " big") app.dialogInput(ch);
    expect(plain(app.dialogLines())).not.toContain("login other");
    app.dialogInput("\r");
    expect(switched).toEqual(["other/big-model"]);
    expect(app.dialogLines()).toEqual([]);

    term.feed("\x0b");
    for (const ch of "/rewind") app.dialogInput(ch);
    app.dialogInput("\r");
    expect(plain(app.lines(110))).not.toContain("Usage: /rewind");
    // 输入框里现在是 "/rewind ",等用户补事件号
    app.dialogInput("x"); // 面板已关,这一键落空
    term.feed("\x0b");
    for (const ch of "/help") app.dialogInput(ch);
    app.dialogInput("\r");
    expect(plain(app.lines(110))).toContain("/inspect");
    term.feed("\x0b");
    expect(app.dialogLines().length).toBeGreaterThan(0);
    term.feed("\x0b"); // 再按一次关闭
    expect(app.dialogLines()).toEqual([]);
    app.stop();
  });
});
