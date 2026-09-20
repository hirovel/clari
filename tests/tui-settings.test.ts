// 验证用户能完成的调整流程:作用域、真实请求、恢复、错误、窄屏与长列表。
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { createTuiApp, type TuiAppDeps } from "../cli/tui-app.js";
import type { Preset } from "../src/config.js";
import { EventLog } from "../src/log.js";
import { planTool } from "../src/plan.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { setSetting } from "../src/settings.js";
import { defineTool } from "../src/tools.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

const tick = () => new Promise((r) => setTimeout(r, 5));
const DOWN = "\x1b[B",
  ENTER = "\r",
  ESC = "\x1b",
  TAB = "\t";
const echo = defineTool({
  name: "echo",
  description: "Echo the text back.",
  parameters: Type.Object({ text: Type.String() }),
  async execute(a) {
    return a.text;
  },
});

function boot(over: Partial<TuiAppDeps> = {}, size = [120, 40]) {
  const saved: [string, unknown][] = [];
  let defaults: Preset = { foldSteps: 5 };
  const presets: { name: string; values: Preset }[] = [];
  const requests: string[][] = [];
  const provider: Provider = {
    model: "m",
    async complete(_messages, tools): Promise<AssistantTurn> {
      requests.push(tools.map((t) => t.name));
      return { text: "ok", toolCalls: [], stopReason: "end" };
    },
  };
  const term = new VirtualTerminal(size[0], size[1]);
  const log = new EventLog();
  const app = createTuiApp({
    terminal: term,
    log,
    provider,
    tools: [echo, planTool],
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
      settingLayers: () => ({ defaults }),
      saveSetting: (key, value) => {
        saved.push([key, value]);
        defaults = setSetting(defaults, key, value);
      },
      listPresets: () => presets,
      savePreset: (name, values) => {
        presets.push({ name, values });
      },
      usePreset: (name) => {
        defaults = presets.find((p) => p.name === name)?.values ?? {};
      },
    },
    onExit: () => {},
    ...over,
  });
  const doc = () => app.lines(size[0]).map(stripAnsi).join("\n");
  const menu = () => app.dialogLines().map(stripAnsi).join("\n");
  return { app, term, doc, menu, saved, presets, requests, log, defaults: () => defaults };
}

describe("Agent setup", () => {
  it("同一模型入口区分当前切换与默认值保存,保存默认值不会创建供应商", async () => {
    let chosen = 0;
    let defaults: Preset = {};
    const { app, menu, log } = boot({
      settings: {
        listModels: () => ["p/m", "p/other"],
        defaultModel: () => "p/m",
        switchModel: (name) => {
          chosen++;
          return {
            provider: {
              model: name.split("/")[1] as string,
              async complete() {
                return { text: "ok", toolCalls: [], stopReason: "end" };
              },
            },
            providerName: "p",
            model: name.split("/")[1] as string,
            contextWindow: 64000,
          };
        },
        setKey: () => {},
        setDefault: () => {},
        settingLayers: () => ({ defaults }),
        saveSetting: (key, value) => {
          defaults = setSetting(defaults, key, value);
        },
      },
    });
    await app.command("/settings model");
    app.dialogInput(ENTER);
    app.dialogInput("3");
    app.dialogInput(ENTER);
    await tick();
    expect(chosen).toBe(1);
    expect(app.agent.provider.model).toBe("other");
    expect(log.events.some((e) => e.type === "session/model" && e.model === "other")).toBe(true);
    app.dialogInput(TAB);
    app.dialogInput(ENTER);
    app.dialogInput("2");
    app.dialogInput(ENTER);
    await tick();
    expect(chosen).toBe(1);
    expect(defaults.model).toBe("p/m");
    expect(menu()).toContain("this session unchanged");
    app.stop();
  });
  it("按组成导航,搜索后可以修改当前会话,不偷偷保存", async () => {
    const { app, menu, saved } = boot();
    await app.command("/settings");
    expect(menu()).toContain("Agent setup");
    for (const name of [
      "Model",
      "Instructions & memory",
      "Tools & delegation",
      "Context management",
      "Execution & control",
      "Save as preset",
    ])
      expect(menu()).toContain(name);
    app.dialogInput("/");
    app.dialogInput("foldLines");
    expect(menu()).toContain("Output preview lines");
    app.dialogInput(ENTER);
    app.dialogInput("e");
    app.dialogInput("\x15");
    app.dialogInput("9");
    app.dialogInput(ENTER);
    await tick();
    expect(menu()).toContain("this session only");
    expect(saved).toEqual([]);
    expect(menu()).toContain("9");
    app.dialogInput(ESC);
    app.dialogInput(ESC);
    expect(app.dialogLines()).toEqual([]);
    app.stop();
  });

  it("保存默认值不改当前会话;重新打开仍区分实际值与保存值", async () => {
    const { app, menu, saved } = boot();
    await app.command("/settings foldSteps");
    expect(menu()).toContain("matches config");
    app.dialogInput(TAB);
    app.dialogInput(ENTER);
    app.dialogInput("5");
    app.dialogInput(ENTER);
    await tick();
    expect(saved).toEqual([["foldSteps", 10]]);
    expect(menu()).toContain("this session unchanged");
    app.dialogInput(TAB);
    expect(menu()).toMatch(/Expanded recent steps\s+5/);
    app.dialogInput(ESC);
    app.dialogInput(ESC);
    await app.command("/settings foldSteps");
    expect(menu()).toMatch(/Expanded recent steps\s+5/);
    expect(menu()).toContain("Current: 5");
    expect(menu()).toContain("Saved default: 10");
    app.stop();
  });

  it("工具显示 Enabled/Disabled,开关改变下一轮实际发送的工具,并保留未知工具配置", async () => {
    const { app, menu, requests } = boot({ disabledTools: ["missing-mcp-tool"] });
    await app.command("/settings tools.disable");
    app.dialogInput(ENTER);
    expect(menu()).toMatch(/echo\s+Enabled/);
    expect(menu()).toMatch(/missing-mcp-tool\s+Disabled/);
    app.dialogInput(ENTER);
    await tick();
    expect(menu()).toMatch(/echo\s+Disabled/);
    app.dialogInput(ESC);
    app.dialogInput(ESC);
    app.dialogInput(ESC);
    await app.submit("hi");
    expect(requests[0]).not.toContain("echo");
    expect(requests[0]).toContain("plan");
    app.stop();
  });

  it("自定义值报错留在编辑器,推荐值恢复有明确预览且可以取消", async () => {
    const { app, menu } = boot();
    await app.command("/settings planReminder");
    app.dialogInput(ENTER);
    app.dialogInput("e");
    app.dialogInput("\x15");
    app.dialogInput("many");
    app.dialogInput(ENTER);
    await tick();
    expect(menu()).toContain("takes a whole number");
    app.dialogInput("\x15");
    app.dialogInput("12");
    app.dialogInput(ENTER);
    await tick();
    expect(app.agent.planReminder).toBe(12);
    app.dialogInput("r");
    expect(menu()).toContain("Restore recommended value");
    app.dialogInput(ESC);
    expect(app.agent.planReminder).toBe(12);
    app.dialogInput("r");
    app.dialogInput(ENTER);
    await tick();
    expect(app.agent.planReminder).toBe(0);
    app.stop();
  });

  it("需要重启的设置不冒充当前已生效;空段列表可以真的保存为空", async () => {
    const { app, menu, saved } = boot();
    await app.command("/settings prompt.sections");
    app.dialogInput(ENTER);
    expect(menu()).toContain("Requires a restart");
    expect(saved).toEqual([]);
    app.dialogInput(TAB);
    app.dialogInput(ENTER);
    for (let i = 0; i < 6; i++) {
      app.dialogInput(ENTER);
      await tick();
      app.dialogInput(DOWN);
    }
    expect(saved.at(-1)).toEqual(["prompt.sections", []]);
    app.dialogInput(ESC);
    app.dialogInput(TAB);
    expect(menu()).toMatch(/Prompt sections\s+6 selected/);
    app.stop();
  });

  it("运行中策略切换失败不会把拒绝的值保存;界面设置仍可改", async () => {
    let finish: ((turn: AssistantTurn) => void) | undefined;
    const provider: Provider = {
      model: "m",
      complete: () =>
        new Promise((r) => {
          finish = r;
        }),
    };
    const { app, doc, saved } = boot({ provider });
    const pending = app.submit("wait");
    await tick();
    await app.command("/settings execution parallel");
    expect(doc()).toContain("cannot change mid-turn");
    expect(saved).toEqual([]);
    await app.command("/settings foldLines 9");
    expect(saved).toEqual([["foldLines", 9]]);
    finish?.({ text: "ok", toolCalls: [], stopReason: "end" });
    await pending;
    app.stop();
  });

  it("持久化失败有恢复说明,保留编辑状态,不关闭工作台", async () => {
    const { app, menu } = boot({
      settings: {
        listModels: () => [],
        switchModel: () => {
          throw new Error("unused");
        },
        setKey: () => {},
        setDefault: () => {},
        saveSetting: () => {
          throw new Error("disk full");
        },
      },
    });
    await app.command("/settings fold");
    app.dialogInput(TAB);
    app.dialogInput(ENTER);
    app.dialogInput("2");
    app.dialogInput(ENTER);
    await tick();
    expect(menu()).toContain("disk full");
    expect(menu()).toContain("Fold tool output");
    expect(menu()).toContain("Enter apply");
    app.stop();
  });

  it("方案保存包含当前注册设置与模型,加载先预览再修改默认值", async () => {
    const { app, menu, presets } = boot();
    await app.command("/settings");
    app.dialogInput("8");
    app.dialogInput(ENTER);
    app.dialogInput("my-agent");
    app.dialogInput(ENTER);
    await tick();
    expect(presets[0]?.name).toBe("my-agent");
    expect(presets[0]?.values.model).toBe("p/m");
    expect(presets[0]?.values.planReminder).toBe(0);
    app.dialogInput("9");
    app.dialogInput(ENTER);
    app.dialogInput(DOWN);
    app.dialogInput(ENTER);
    expect(menu()).toContain("Load my-agent");
    expect(menu()).toContain("Use for saved defaults");
    app.dialogInput(ENTER);
    await tick();
    expect(menu()).toContain("my-agent saved as defaults");
    expect(menu()).toContain("[Saved defaults]");
    app.stop();
  });

  it("窄终端与长工具列表:视口有边界,选中最后一项仍可见且可操作", async () => {
    const tools = Array.from({ length: 40 }, (_, i) => ({
      ...echo,
      name: `tool_${String(i).padStart(2, "0")}`,
    }));
    const { app, menu, term, saved } = boot({ tools }, [60, 24]);
    await app.command("/settings tools.disable");
    app.dialogInput(ENTER);
    app.dialogInput("\x1b[F");
    expect(menu()).toMatch(/▸\s+tool_39/);
    expect(menu()).toContain("of 40");
    expect(app.dialogLines().length).toBeLessThanOrEqual(22);
    expect(app.dialogLines().every((line) => stripAnsi(line).length <= 60)).toBe(true);
    app.dialogInput(ENTER);
    await tick();
    expect(menu()).toMatch(/tool_39\s+Disabled/);
    // 经过真实 TUI→ANSI→xterm 渲染链后,底部操作提示仍在可见窗口。
    app.tui.requestRender();
    await tick();
    expect((await term.screen()).slice(-24).join("\n")).toContain("Esc back");
    // 选项详情不能丢掉光标候选,返回时仍可确认同一项;阅读本身不修改设置。
    await app.command("/settings compaction");
    app.dialogInput(ENTER);
    app.dialogInput(DOWN);
    expect(menu()).toContain("No model call.");
    expect(menu()).toContain("Current: Model summary");
    expect(menu()).toContain("Saved default: Model summary");
    app.dialogInput("i");
    expect(menu()).toContain("Clear tool results");
    expect(menu()).toContain("No model call.");
    app.dialogInput("\x1b[6~");
    app.dialogInput(ESC);
    expect(menu()).toMatch(/▸\s+Clear tool results/);
    expect(menu()).toContain("Current: Model summary");
    expect(saved).toEqual([]);
    app.dialogInput(ENTER);
    await tick();
    app.dialogInput("i");
    expect(menu()).toContain("Current: Clear tool results (clear)");
    expect(menu()).toContain("Saved default: Model summary (llm)");
    app.stop();
  });

  it("打字入口保留应用并保存语义,错误与恢复都明确", async () => {
    const { app, doc, saved, log } = boot();
    await app.command("/settings foldLines 9");
    expect(saved.at(-1)).toEqual(["foldLines", 9]);
    await app.command("/settings screen main");
    expect(doc()).toContain("screen → main · takes effect at the next start");
    await app.command("/settings nope 1");
    expect(doc()).toContain("unknown setting nope");
    expect(log.events.some((e) => e.type === "ext/event" && e.source === "setup")).toBe(true);
    app.stop();
  });
});
