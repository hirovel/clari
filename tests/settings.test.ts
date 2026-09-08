// 开关登记表:配置模板的 defaults 就是它;命令行解析认得表里的每个键(防失步);打字形态与显示;来源判定。
import { describe, expect, it } from "vitest";
import { applyPreset, parseCommonArgs } from "../cli/args.js";
import { CONFIG_TEMPLATE, type KernelConfig, type Preset } from "../src/config.js";
import {
  defaultPreset,
  formatSetting,
  getSetting,
  parseSetting,
  SETTINGS,
  setSetting,
  settingDef,
  settingSource,
} from "../src/settings.js";

const config = (defaults: Preset): KernelConfig => ({
  default: "m",
  providers: { p: { protocol: "openai", baseUrl: "http://x", models: ["m"] } },
  defaults,
});

describe("开关登记表", () => {
  it("模板的 defaults 从表生成;每个键唯一;每组都有开关", () => {
    expect(CONFIG_TEMPLATE.defaults).toEqual(defaultPreset());
    const keys = SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(getSetting(defaultPreset(), "facts.repeats")).toBe(true);
    expect(getSetting(defaultPreset(), "prompt.skills.load")).toBe("read");
    expect(getSetting(defaultPreset(), "tools.disable")).toBeUndefined();
  });

  it("命令行解析认得表里的每个键:写进 defaults 的非缺省值都到了参数里", () => {
    // 每个键给一个与内置不同的值,经 applyPreset 后必须能在 CommonArgs 里找到。
    const probe: Record<string, unknown> = {
      screen: "main",
      fold: false,
      foldLines: 7,
      foldSteps: 9,
      results: { bash: "all" },
      compactionReserve: 12345,
      "facts.repeats": false,
      "facts.slow": false,
      "facts.date": false,
      plan: false,
      planReminder: 3,
      "prompt.sections": ["role", "env"],
      "prompt.instructionsAs": "user",
      "prompt.memory": true,
      "prompt.skills.list": "none",
      "prompt.skills.load": "tool",
      trace: false,
      "tools.disable": ["bash"],
      toolPrompts: "rules",
      subagent: true,
      maxSteps: 42,
      approve: "ask",
      compaction: "clear",
      compactionTrigger: "manual",
      preservation: "tokens 5000",
      execution: "parallel",
      steering: "turn",
      notify: "off",
      effort: "high",
    };
    for (const s of SETTINGS) expect(probe, `probe value for ${s.key}`).toHaveProperty(s.key);
    let defaults: Preset = {};
    for (const [k, v] of Object.entries(probe)) defaults = setSetting(defaults, k, v);
    const args = applyPreset(parseCommonArgs([]), config(defaults));
    const seen: Record<string, unknown> = {
      screen: args.screen,
      fold: args.fold,
      foldLines: args.foldLines,
      foldSteps: args.foldSteps,
      results: args.results,
      compactionReserve: args.compactionReserve,
      "facts.repeats": args.facts?.repeats,
      "facts.slow": args.facts?.slow,
      "facts.date": args.facts?.date,
      plan: args.plan,
      planReminder: args.planReminder,
      "prompt.sections": args.promptSections,
      "prompt.instructionsAs": args.instructionsAs,
      "prompt.memory": args.memory,
      "prompt.skills.list": args.skillsList,
      "prompt.skills.load": args.skillsLoad,
      trace: args.trace,
      "tools.disable": args.disabledTools,
      toolPrompts: args.toolPrompts,
      subagent: args.subagent,
      maxSteps: args.maxSteps,
      approve: args.approve,
      compaction: args.compaction,
      compactionTrigger: args.compactionTrigger,
      preservation: args.preservation,
      execution: args.execution,
      steering: args.steering,
      notify: args.notify,
      effort: args.effort,
    };
    for (const s of SETTINGS) expect(seen[s.key], s.key).toEqual(probe[s.key]);
  });

  it("按路径读写:写 undefined 删项,空对象一并删;不改原对象", () => {
    const a: Preset = { facts: { repeats: true } };
    const b = setSetting(a, "facts.slow", false);
    expect(b).toEqual({ facts: { repeats: true, slow: false } });
    expect(a).toEqual({ facts: { repeats: true } });
    const c = setSetting(setSetting(b, "facts.repeats", undefined), "facts.slow", undefined);
    expect(c).toEqual({});
    expect(getSetting({ prompt: { skills: { load: "tool" } } }, "prompt.skills.load")).toBe("tool");
    expect(getSetting({}, "prompt.skills.load")).toBeUndefined();
  });

  it("打字形态 → 值,值 → 显示;错值的话是给人看的一句", () => {
    const def = (k: string) => settingDef(k) as NonNullable<ReturnType<typeof settingDef>>;
    expect(parseSetting(def("fold"), "off")).toBe(false);
    expect(parseSetting(def("foldSteps"), "12")).toBe(12);
    expect(parseSetting(def("maxSteps"), "none")).toBeUndefined();
    expect(parseSetting(def("notify"), "always")).toBe("always");
    expect(parseSetting(def("results"), "read head bash all")).toEqual({
      read: "head",
      bash: "all",
    });
    expect(parseSetting(def("prompt.sections"), "role,env")).toEqual(["role", "env"]);
    expect(parseSetting(def("tools.disable"), "bash fetch")).toEqual(["bash", "fetch"]);
    expect(() => parseSetting(def("foldSteps"), "many")).toThrow("whole number");
    expect(() => parseSetting(def("notify"), "loud")).toThrow("unfocused · always · off");
    expect(() => parseSetting(def("prompt.sections"), "role,nope")).toThrow("nope is not one of");
    expect(() => parseSetting(def("results"), "read")).toThrow("pairs");
    expect(formatSetting(def("fold"), false)).toBe("off");
    expect(formatSetting(def("tools.disable"), undefined)).toBe("none");
    expect(formatSetting(def("results"), { read: "count", bash: "tail", edit: "count" })).toBe(
      "read count · bash tail · 1 more",
    );
    expect(formatSetting(def("prompt.sections"), ["role", "env"])).toBe("role · env");
  });

  it("来源:预设 > 配置 > 内置;都不等就是命令行", () => {
    const def = settingDef("foldSteps") as NonNullable<ReturnType<typeof settingDef>>;
    const layers = { defaults: { foldSteps: 5 }, preset: { foldSteps: 7 }, presetName: "long" };
    expect(settingSource(def, 7, layers)).toBe("preset long");
    expect(settingSource(def, 5, layers)).toBe("config");
    expect(settingSource(def, 3, {})).toBe("built-in");
    expect(settingSource(def, 9, layers)).toBe("flag");
  });
});
