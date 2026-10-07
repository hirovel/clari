// 命令面板:Ctrl+K 打开,模糊过滤,Enter 跑命令或填输入框,模型条目切模型,Esc 关。

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { ModelSettings } from "../cli/model-settings.js";
import { createTuiApp } from "../cli/tui-app.js";
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
    expect(out).toContain("› /model");
    expect(out).toContain("cmd");
    p.handleInput("d");
    p.handleInput("s");
    out = plain(p.render());
    expect(out).toContain("› ds");
    expect(out).toContain("deepseek/deepseek-v4-pro");
    expect(out).not.toContain("/memory");
    p.handleInput("\x7f");
    p.handleInput("\x7f");
    p.handleInput("\x1b[200~ds\x1b[201~");
    expect(plain(p.render())).toContain("› ds");
    p.handleInput("\x7f");
    p.handleInput("\x7f");
    p.handleInput("🙂");
    p.handleInput("\x1b[127u");
    expect(plain(p.render())).not.toContain("no match");
    p.handleInput("\x1bOA"); // 应用光标模式的方向键也要从第 0 项上翻到末项。
    expect(plain(p.render())).toContain("› deepseek/deepseek-v4-pro");
    p.handleInput("\r");
    expect(ran).toEqual(["ds"]);
    expect(closed).toBe(1);
    p.handleInput("\x1b");
    expect(closed).toBe(2);
    p.handleInput("z");
    p.handleInput("z");
    expect(plain(p.render())).toContain("no match");
    let chosen = -1;
    let height = 18;
    const many = new Palette(
      Array.from({ length: 35 }, (_, index) => ({
        kind: "skill" as const,
        label: `/skill-${index + 1}-中文`,
        note: `${"Long description 中文. ".repeat(45)}END-${index + 1}`,
        run: () => {
          chosen = index;
        },
      })),
      () => {},
      () => {},
      () => height,
    );
    for (let i = 0; i < 30; i++) many.handleInput("\x1bOB");
    const screen = many.render(40);
    expect(plain(screen)).toContain("Selected 31/35");
    expect(screen.length).toBeLessThanOrEqual(16);
    expect(screen.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(plain(screen)).toContain("Esc close");
    for (let i = 0; i < 60; i++) {
      many.handleInput("\x1b[6~");
      many.render(40);
    }
    expect(plain(many.render(40))).toContain("END-31");
    height = 10;
    const resized = many.render(24);
    expect(resized.length).toBeLessThanOrEqual(8);
    expect(resized.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(plain(resized)).toContain("Esc close");
    many.handleInput("\r");
    expect(chosen).toBe(30);
    // 完整文件名优先于较短字段的零散模糊命中,不能恢复错误会话。
    const paths = new Palette(
      [
        { kind: "session", label: "a b", run: () => ran.push("scattered") },
        { kind: "session", label: "Long prefix ab", run: () => ran.push("exact") },
      ],
      () => {},
    );
    paths.handleInput("ab");
    paths.handleInput("\r");
    expect(ran.at(-1)).toBe("exact");
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
    const settings: ModelSettings = {
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
    for (const ch of "/edit") app.dialogInput(ch);
    app.dialogInput("\r");
    // 有次级选项的命令直接弹它的选单
    expect(plain(app.dialogLines())).toContain("retry");
    app.dialogInput("\x1b");
    term.feed("\x0b");
    for (const ch of "/help") app.dialogInput(ch);
    app.dialogInput("\r");
    expect(plain(app.lines(110))).toContain("/inspect");
    term.feed("\x0b");
    expect(app.dialogLines().length).toBeGreaterThan(0);
    term.feed("\x0b"); // 再按一次关闭
    expect(app.dialogLines()).toEqual([]);
    const compact = () => {
      term.feed("\x0b");
      app.dialogInput("/compact");
      app.dialogInput("\r");
    };
    app.setDraft("unfinished request");
    compact();
    expect(plain(app.dialogLines())).toContain("Replace the current draft");
    app.dialogInput("\r"); // 默认保留。
    await Promise.resolve();
    expect(app.draft()).toBe("unfinished request");
    compact();
    term.feed("\x0b"); // 从别处关闭也要取消,不能留下迟到替换。
    await Promise.resolve();
    expect(app.draft()).toBe("unfinished request");
    compact();
    app.dialogInput("\x1b[B");
    app.dialogInput("\r");
    await vi.waitFor(() => expect(app.draft()).toBe("/compact "));
    app.setDraft("");
    compact();
    expect(app.dialogLines()).toEqual([]);
    expect(app.draft()).toBe("/compact ");
    app.stop();
  });
});
