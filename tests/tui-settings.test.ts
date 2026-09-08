// /settings:一屏所有开关,Enter 翻值,当场生效并写回配置;打字形态给脚本;来源列写谁定的值。
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { createTuiApp, type TuiAppDeps } from "../cli/tui-app.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

const tick = () => new Promise((r) => setTimeout(r, 5));

const echo = defineTool({
  name: "echo",
  description: "Echo the text back.",
  parameters: Type.Object({ text: Type.String() }),
  async execute(a) {
    return a.text;
  },
});

function boot(over: Partial<TuiAppDeps> = {}) {
  const saved: [string, unknown][] = [];
  const provider: Provider = {
    model: "m",
    async complete(): Promise<AssistantTurn> {
      return { text: "ok", toolCalls: [], stopReason: "end" };
    },
  };
  const term = new VirtualTerminal(120, 40);
  const app = createTuiApp({
    terminal: term,
    log: new EventLog(),
    provider,
    tools: [echo],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
    reserveTokens: 1000,
    info: { model: "m", providerName: "p", sessionFile: "s" },
    systemPrompt: "sys",
    foldSteps: 5,
    settings: {
      listModels: () => [],
      switchModel: () => {
        throw new Error("no");
      },
      setKey: () => {},
      setDefault: () => {},
      settingLayers: () => ({
        defaults: { foldSteps: 5, notify: "always" },
        presetName: "long",
        preset: { notify: "off" },
      }),
      saveSetting: (key, value) => saved.push([key, value]),
    },
    onExit: () => {},
    ...over,
  });
  const doc = () => app.lines(120).map(stripAnsi).join("\n");
  const menu = () => app.dialogLines().map(stripAnsi).join("\n");
  return { app, doc, menu, saved };
}

describe("/settings", () => {
  it("全屏表:分组、当前值、一句话、来源;Enter 开值选单,选中即生效并写回;Esc 逐级回", async () => {
    const { app, doc, menu, saved } = boot();
    await app.command("/settings");
    let m = menu();
    expect(m).toContain("Settings");
    expect(m).toContain("every session");
    for (const g of ["display", "context", "tools", "strategy", "notifications", "model"])
      expect(m).toContain(g);
    // 来源列:foldSteps 5 来自 config;notify 的生效值是内置的 unfocused(界面没收到预设 off 与配置 always)
    expect(m).toMatch(/foldSteps\s+5\s+.*config/);
    expect(m).toMatch(/notify\s+unfocused\s+.*built-in/);
    expect(m).toMatch(/fold\s+on\s+.*built-in/);
    expect(m).toMatch(/screen\s+alt\s+.*next start/);
    // 光标缺省在第一行 screen;↓↓↓ 到 foldSteps,Enter 开值选单
    app.dialogInput("\x1b[B");
    app.dialogInput("\x1b[B");
    app.dialogInput("\x1b[B");
    app.dialogInput("\r");
    m = menu();
    expect(m).toContain("foldSteps");
    expect(m).toContain("now 5 (config)");
    expect(m).toContain("type a value");
    expect(m).toContain("written to config defaults.foldSteps");
    app.dialogInput("4"); // 10
    app.dialogInput("\r");
    await tick();
    expect(app.tui).toBeDefined();
    expect(saved).toEqual([["foldSteps", 10]]);
    m = menu();
    expect(m).toContain("foldSteps → 10 · in effect now · saved to config");
    expect(m).toMatch(/foldSteps\s+10\s+.*flag/); // 生效值与各层都不等:来源是这次改动
    // 布尔:Enter 直接翻
    app.dialogInput("\x1b[A"); // foldLines
    app.dialogInput("\x1b[A"); // fold
    app.dialogInput("\r");
    await tick();
    expect(saved.at(-1)).toEqual(["fold", false]);
    expect(menu()).toMatch(/fold\s+off/);
    app.dialogInput("\x1b");
    expect(app.dialogLines()).toEqual([]);
    expect(doc()).not.toContain("Settings");
    app.stop();
  });

  it("打字形态:/settings key value 直接落;策略类走槽命令并记事件;错值与未知键说明", async () => {
    const { app, doc, saved } = boot();
    await app.command("/settings foldLines 9");
    expect(doc()).toContain("foldLines → 9 · in effect now · saved to config");
    expect(saved.at(-1)).toEqual(["foldLines", 9]);
    await app.command("/settings approve ask");
    expect(app.agent.slots.approve).toBeDefined();
    expect(app.tui).toBeDefined();
    expect(saved.at(-1)).toEqual(["approve", "ask"]);
    await app.command("/settings notify off");
    expect(saved.at(-1)).toEqual(["notify", "off"]);
    await app.command("/settings screen main");
    expect(doc()).toContain("screen → main · takes effect at the next start");
    await app.command("/settings foldLines many");
    expect(doc()).toContain("foldLines takes a whole number");
    await app.command("/settings nope 1");
    expect(doc()).toContain("unknown setting nope");
    await app.command("/settings plan off");
    expect(doc()).toContain("the plan tool is not loaded in this session");
    await app.command("/settings tools.disable echo");
    expect(saved.at(-1)).toEqual(["tools.disable", ["echo"]]);
    await app.command("/settings tools.disable none");
    expect(saved.at(-1)).toEqual(["tools.disable", undefined]);
    app.stop();
  });

  it("/settings key 定位到那一行;列表与映射型开关有自己的子选单", async () => {
    const { app, menu, saved } = boot();
    await app.command("/settings results");
    let m = menu();
    expect(m).toMatch(/▸\s+results/);
    app.dialogInput("\r");
    m = menu();
    expect(m).toContain("Enter cycles count · head · tail · all");
    expect(m).toMatch(/1\s+echo\s+head/);
    app.dialogInput("\r");
    await tick();
    const last = saved.at(-1);
    expect(last?.[0]).toBe("results");
    expect((last?.[1] as Record<string, string> | undefined)?.echo).toBe("tail");
    app.dialogInput("\x1b");
    await app.command("/settings prompt.sections");
    app.dialogInput("\r");
    m = menu();
    expect(m).toMatch(/4\s+memory\s+on/);
    app.dialogInput("4");
    app.dialogInput("\r");
    await tick();
    expect(saved.at(-1)).toEqual([
      "prompt.sections",
      ["role", "env", "instructions", "skills", "append"],
    ]);
    app.stop();
  });
});
