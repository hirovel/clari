// 对照 pi 吸收的部分:每一项都是槽或可选项,缺省行为不变。
// 执行槽(并行/串行)、后续留言、实测优先的上下文口径、宽松编辑、提示词模板、@文件、技能段、分叉、扩展模块。
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { expandFileRefs } from "../cli/attachments.js";
import { forkSession, loadExtensions } from "../cli/bootstrap.js";
import { buildSystemPrompt, discoverSkills, parseSkill } from "../cli/prompt.js";
import { discoverTemplates, expandTemplate, parseTemplate, splitArgs } from "../cli/templates.js";
import { fuzzyReplace, normalizeLine } from "../cli/tools/fs.js";
import { Agent } from "../src/agent.js";
import { contextTokens, estimateAfter } from "../src/compaction.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import { runTurn } from "../src/loop.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { openaiCompat } from "../src/provider.js";
import { defineTool } from "../src/tools.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 脚本化 provider:按顺序吐出预设的响应。 */
function scripted(turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model: "fake",
    async complete() {
      const t = turns[i++];
      if (!t) return { text: "done", toolCalls: [], stopReason: "end" };
      return t;
    },
  };
}

function slowTool(name: string, ms: number, concurrency?: "parallel" | "sequential") {
  const order: string[] = [];
  const tool = defineTool({
    name,
    description: name,
    parameters: Type.Object({}),
    ...(concurrency && { concurrency }),
    async execute() {
      order.push(`${name}:start`);
      await sleep(ms);
      order.push(`${name}:end`);
      return name;
    },
  });
  return { tool, order };
}

describe("执行槽(Q10):并行只在选了策略且工具声明并行安全时发生", () => {
  const calls = [
    { id: "a", name: "ra", args: {} },
    { id: "b", name: "rb", args: {} },
    { id: "c", name: "w", args: {} },
  ];

  it("缺省串行:逐个跑,无 execution 决策事件", async () => {
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "fake", system: "" });
    log.append({ type: "user/message", at: "", text: "go" });
    const a = slowTool("ra", 30, "parallel");
    const b = slowTool("rb", 30, "parallel");
    const w = slowTool("w", 5);
    const provider = scripted([{ text: "", toolCalls: calls, stopReason: "tool" }]);
    await runTurn({ log, provider, tools: [a.tool, b.tool, w.tool] });
    expect([...a.order, ...b.order].join(",")).toBe("ra:start,ra:end,rb:start,rb:end");
    expect(log.events.some((e) => e.type === "decision" && e.slot === "execution")).toBe(false);
  });

  it("parallel:相邻并行安全的调用同时跑,写工具仍独占;结果按调用顺序落盘,并记一条决策", async () => {
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "fake", system: "" });
    log.append({ type: "user/message", at: "", text: "go" });
    const a = slowTool("ra", 40, "parallel");
    const b = slowTool("rb", 10, "parallel");
    const w = slowTool("w", 5);
    const timeline: string[] = [];
    const wrap = (t: ReturnType<typeof slowTool>) => ({
      ...t.tool,
      async execute(args: never, ctx: never) {
        const out = await t.tool.execute(args, ctx);
        timeline.push(t.tool.name);
        return out;
      },
    });
    const provider = scripted([{ text: "", toolCalls: calls, stopReason: "tool" }]);
    await runTurn({
      log,
      provider,
      tools: [wrap(a), wrap(b), wrap(w)],
      slots: { execution: "parallel" },
    });
    // rb 比 ra 先完成,说明两者同时在跑;w 在两者之后才开始。
    expect(timeline).toEqual(["rb", "ra", "w"]);
    const results = log.events.filter((e) => e.type === "tool/result").map((e) => e.callId);
    expect(results).toEqual(["a", "b", "c"]);
    const decision = log.events.find((e) => e.type === "decision" && e.slot === "execution");
    expect(decision).toMatchObject({ slot: "execution", parallel: 2, tools: ["ra", "rb"] });
  });

  it("parallel 下未声明并行安全的工具与校验失败的调用不会进批", async () => {
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "fake", system: "" });
    log.append({ type: "user/message", at: "", text: "go" });
    const a = slowTool("ra", 5, "parallel");
    const bad = defineTool({
      name: "bad",
      description: "",
      parameters: Type.Object({ n: Type.Number() }),
      concurrency: "parallel",
      async execute() {
        return "x";
      },
    });
    const provider = scripted([
      {
        text: "",
        toolCalls: [
          { id: "1", name: "ra", args: {} },
          { id: "2", name: "bad", args: { n: "not-a-number-at-all" } },
          { id: "3", name: "ra", args: {} },
        ],
        stopReason: "tool",
      },
    ]);
    await runTurn({ log, provider, tools: [a.tool, bad], slots: { execution: "parallel" } });
    const results = log.events.filter((e) => e.type === "tool/result");
    expect(results.map((e) => [e.callId, e.isError])).toEqual([
      ["1", false],
      ["2", true],
      ["3", false],
    ]);
    expect(log.events.some((e) => e.type === "decision" && e.slot === "execution")).toBe(false);
  });
});

describe("留言投递方式(Q20):steer 步边界,followUp 等到 turn 边界", () => {
  it("followUp 不在步边界注入,模型不再调工具时才注入", async () => {
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "fake", system: "" });
    const t = slowTool("r", 5, "parallel");
    const provider = scripted([
      { text: "", toolCalls: [{ id: "1", name: "r", args: {} }], stopReason: "tool" },
      { text: "第一步做完", toolCalls: [], stopReason: "end" },
      { text: "回答后续", toolCalls: [], stopReason: "end" },
    ]);
    const agent = new Agent({ log, provider, tools: [t.tool] });
    const run = agent.prompt("开始");
    await sleep(1);
    void agent.prompt("后续问题", { deliverAs: "followUp" });
    expect(agent.queued).toBe(1);
    await run;
    const seq = log.events
      .filter(
        (e) =>
          e.type === "user/message" || e.type === "assistant/message" || e.type === "tool/result",
      )
      .map((e) =>
        e.type === "user/message" ? `U:${e.text}` : e.type === "tool/result" ? "T" : `A:${e.text}`,
      );
    // 后续留言排在"第一步做完"之后,而不是工具结果之后。
    expect(seq).toEqual(["U:开始", "A:", "T", "A:第一步做完", "U:后续问题", "A:回答后续"]);
    const decision = log.events.find((e) => e.type === "decision" && e.slot === "steering");
    expect(decision).toMatchObject({ boundary: "turn", injected: 1 });
  });

  it("steer(缺省)在步边界注入", async () => {
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "fake", system: "" });
    const t = slowTool("r", 5, "parallel");
    const provider = scripted([
      { text: "", toolCalls: [{ id: "1", name: "r", args: {} }], stopReason: "tool" },
      { text: "看到插话", toolCalls: [], stopReason: "end" },
    ]);
    const agent = new Agent({ log, provider, tools: [t.tool] });
    const run = agent.prompt("开始");
    await sleep(1);
    void agent.prompt("插话");
    await run;
    const decision = log.events.find((e) => e.type === "decision" && e.slot === "steering");
    expect(decision).toMatchObject({ boundary: "step", injected: 1 });
  });
});

describe("上下文口径:实测优先", () => {
  it("最近 assistant 有用量且其后无压缩:实测输入+输出+新增估算;否则纯估算", () => {
    const events: AgentEvent[] = [
      { type: "session/start", at: "", model: "m", system: "x".repeat(400) },
      { type: "user/message", at: "", text: "hi" },
      {
        type: "assistant/message",
        at: "",
        text: "",
        toolCalls: [{ id: "1", name: "r", args: {} }],
        stopReason: "tool",
        usage: { inputTokens: 5000, outputTokens: 20 },
      },
      {
        type: "tool/result",
        at: "",
        callId: "1",
        name: "r",
        content: "y".repeat(400),
        isError: false,
      },
    ];
    expect(contextTokens(events)).toBe(5000 + 20 + 100);
    expect(contextTokens(events.slice(0, 2))).toBe(estimateAfter(events.slice(0, 2)));
    const after: AgentEvent[] = [...events, { type: "compaction", at: "", cleared: [3] }];
    expect(contextTokens(after)).toBe(estimateAfter(after));
  });
});

describe("edit 宽松匹配", () => {
  it("归一化:行尾空白、弯引号、长破折号", () => {
    expect(normalizeLine("a = “x”  ")).toBe('a = "x"');
    expect(normalizeLine("it’s — ok")).toBe("it's - ok");
  });

  it("精确失败时按行归一化匹配,只改命中的行", () => {
    const content = 'const a = "x";   \nconst b = 2;\n// keep   \n';
    const r = fuzzyReplace(content, "const a = “x”;\nconst b = 2;", "const a = 1;");
    expect(r).toEqual({ next: "const a = 1;\n// keep   \n", line: 1 });
  });

  it("多处命中报错,无命中返回 undefined", () => {
    expect(() => fuzzyReplace("a\nb\na\nb\n", "a\nb", "c")).toThrow(/不唯一/);
    expect(fuzzyReplace("a\nb\n", "zzz", "c")).toBeUndefined();
  });
});

describe("提示词模板", () => {
  it("frontmatter 的 description、$ARGUMENTS 与 $n 展开、引号参数", () => {
    const t = parseTemplate(
      "/x/review.md",
      "---\ndescription: 审查\n---\n审查 $1,重点 $2。全部:$ARGUMENTS",
    );
    expect(t).toMatchObject({ name: "review", description: "审查" });
    expect(expandTemplate(t, 'src/a.ts "错误 处理"')).toBe(
      '审查 src/a.ts,重点 错误 处理。全部:src/a.ts "错误 处理"',
    );
    expect(splitArgs(`a 'b c' "d"`)).toEqual(["a", "b c", "d"]);
  });

  it("发现:用户级 → 项目级,同名以项目级为准", () => {
    const home = mkdtempSync(join(tmpdir(), "ak-home-"));
    const proj = mkdtempSync(join(tmpdir(), "ak-proj-"));
    mkdirSync(join(home, "prompts"), { recursive: true });
    mkdirSync(join(proj, ".clari", "prompts"), { recursive: true });
    mkdirSync(join(proj, ".git"));
    writeFileSync(join(home, "prompts", "a.md"), "用户级 A");
    writeFileSync(join(home, "prompts", "b.md"), "用户级 B");
    writeFileSync(join(proj, ".clari", "prompts", "a.md"), "项目级 A");
    const found = discoverTemplates(proj, home);
    expect(found.map((t) => [t.name, t.body])).toEqual([
      ["a", "项目级 A"],
      ["b", "用户级 B"],
    ]);
  });
});

describe("@文件引用", () => {
  it("存在的文本文件附成 <file> 块;不存在的原样保留;二进制与超大文件跳过并说明", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-attach-"));
    writeFileSync(join(dir, "a.txt"), "hello");
    writeFileSync(join(dir, "bin"), Buffer.from([0, 1, 2]));
    writeFileSync(join(dir, "big.txt"), "z".repeat(60 * 1024));
    const r = expandFileRefs("看 @a.txt 和 @nope.txt 与 @bin @big.txt", dir);
    expect(r.text).toContain('<file name="a.txt">\nhello\n</file>');
    expect(r.text).not.toContain('name="nope.txt"');
    expect(r.attachments.map((a) => [a.ref, a.skipped ?? "ok"])).toEqual([
      ["a.txt", "ok"],
      ["bin", "二进制文件,未附上"],
      ["big.txt", expect.stringContaining("超过")],
    ]);
  });
});

describe("技能段", () => {
  it("发现 SKILL.md,frontmatter 取名与描述,注入只放名字、描述与路径", () => {
    const home = mkdtempSync(join(tmpdir(), "ak-sk-home-"));
    const proj = mkdtempSync(join(tmpdir(), "ak-sk-proj-"));
    mkdirSync(join(proj, ".git"));
    mkdirSync(join(home, "skills", "deploy"), { recursive: true });
    mkdirSync(join(proj, ".agents", "skills", "review"), { recursive: true });
    writeFileSync(
      join(home, "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: 发布流程\n---\n步骤很长很长",
    );
    writeFileSync(join(proj, ".agents", "skills", "review", "SKILL.md"), "没有 frontmatter 的技能");
    const skills = discoverSkills(proj, { home, root: proj });
    expect(skills.map((s) => [s.name, s.description])).toEqual([
      ["deploy", "发布流程"],
      ["review", ""],
    ]);
    const built = buildSystemPrompt({
      base: "角色",
      cwd: proj,
      discover: { home, root: proj },
      env: { git: false },
    });
    const sec = built.sections.find((s) => s.name === "技能");
    expect(sec?.text).toContain("- deploy:发布流程");
    expect(sec?.text).not.toContain("步骤很长很长");
    // 不点名技能段就不扫目录、不注入。
    const without = buildSystemPrompt({
      base: "角色",
      cwd: proj,
      discover: { home, root: proj },
      env: { git: false },
      sections: ["role", "env"],
    });
    expect(without.sections.some((s) => s.name === "技能")).toBe(false);
    expect(parseSkill("/x/foo/SKILL.md", "no front").name).toBe("foo");
  });
});

describe("分叉与扩展模块", () => {
  it("forkSession:复制前 N 条事件到新文件,原日志不动", () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-fork-"));
    const events: AgentEvent[] = [
      { type: "session/start", at: "", model: "m", system: "s" },
      { type: "user/message", at: "", text: "1" },
      { type: "assistant/message", at: "", text: "a", toolCalls: [], stopReason: "end" },
      { type: "user/message", at: "", text: "2" },
    ];
    const r = forkSession(events, 3, dir);
    expect(r.events).toBe(3);
    const copied = EventLog.load(r.file);
    expect(copied.events).toEqual(events.slice(0, 3));
    expect(events).toHaveLength(4);
  });

  it("loadExtensions:default 导出函数,返回工具与槽,可订阅事件;非函数报错", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ak-ext-"));
    const file = join(dir, "ext.mjs");
    writeFileSync(
      file,
      [
        "export default (ctx) => ({",
        '  tools: [{ name: "hello", description: "d", parameters: { type: "object", properties: {} }, execute: async () => "hi " + ctx.cwd }],',
        '  slots: { execution: "parallel" },',
        "  onEvent: (e) => { globalThis.__seen = (globalThis.__seen ?? 0) + 1; },",
        "});",
      ].join("\n"),
    );
    const log = new EventLog();
    const ext = await loadExtensions([file], { cwd: "/w", log });
    expect(ext.tools?.map((t) => t.name)).toEqual(["hello"]);
    expect(ext.slots?.execution).toBe("parallel");
    log.append({ type: "user/message", at: "", text: "x" });
    expect((globalThis as { __seen?: number }).__seen).toBe(1);
    writeFileSync(join(dir, "bad.mjs"), "export default 42;");
    await expect(loadExtensions([join(dir, "bad.mjs")], { cwd: "/w", log })).rejects.toThrow(
      /default 导出一个函数/,
    );
  });
});

describe("OpenAI 兼容:输出上限字段按方言", () => {
  it("openai 发 max_completion_tokens,deepseek 发 max_tokens,不配置则都不发", () => {
    const base = { baseUrl: "http://x", apiKey: "k", model: "m" };
    const oa = openaiCompat({ ...base, maxTokens: 100 }).wire?.([], []) as Record<string, unknown>;
    expect(oa.max_completion_tokens).toBe(100);
    expect(oa.max_tokens).toBeUndefined();
    const ds = openaiCompat({ ...base, maxTokens: 100, dialect: "deepseek" }).wire?.(
      [],
      [],
    ) as Record<string, unknown>;
    expect(ds.max_tokens).toBe(100);
    const none = openaiCompat(base).wire?.([], []) as Record<string, unknown>;
    expect(none.max_tokens).toBeUndefined();
    expect(none.max_completion_tokens).toBeUndefined();
  });
});

// 让 readFileSync 的导入有用武之地:分叉文件是逐行 JSON。
it("分叉文件是 JSONL", () => {
  const dir = mkdtempSync(join(tmpdir(), "ak-fork2-"));
  const r = forkSession([{ type: "session/start", at: "", model: "m", system: "s" }], 1, dir);
  expect(readFileSync(r.file, "utf8").trim().split("\n")).toHaveLength(1);
});

describe("自动压缩阈值", () => {
  it("余量不许吃掉超过一半窗口:小窗口下阈值不为负", async () => {
    const { compactionThreshold } = await import("../src/loop.js");
    expect(compactionThreshold(131072, 32000)).toBe(99072);
    expect(compactionThreshold(8000, 32000)).toBe(4000);
    expect(compactionThreshold(50000)).toBe(25000);
  });
});
