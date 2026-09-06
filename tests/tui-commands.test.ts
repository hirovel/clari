// 界面:按键、提交与每条命令。/help /context、设置、检视器入口、/effort、/models、--approve ask、
// 附件与排队、命令的用法与错误分支、槽命令、审批理由输入、编辑器驱动的工具描述编辑。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { appendMemory } from "../cli/tools/memory.js";
import { createTuiApp, type TuiApp, type TuiAppDeps, type TuiSettings } from "../cli/tui-app.js";
import { DEFAULT_CONFIG_PATH } from "../src/config.js";
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

const plain = (s: string) => stripAnsi(s);
const doc = (app: TuiApp) => app.lines(120).map(plain).join("\n");
const tick = () => new Promise((r) => setTimeout(r, 5));

function scriptedB(turns: AssistantTurn[], extra: Partial<Provider> = {}): Provider {
  let i = 0;
  return {
    model: "m",
    async complete(_m, _t, opts) {
      const t = turns[i++] ?? { text: "done", toolCalls: [], stopReason: "end" };
      if (t.reasoning && opts?.onReasoning) opts.onReasoning(t.reasoning.slice(0, 2));
      return t;
    },
    ...extra,
  };
}

const echoB = defineTool({
  name: "echo",
  description: "Echo.",
  parameters: Type.Object({ text: Type.String() }),
  async execute(a) {
    return a.text;
  },
});

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  delete process.env.CLARI_EDITOR;
});

function bootB(provider: Provider, over: Partial<TuiAppDeps> = {}, log = new EventLog()) {
  const term = new VirtualTerminal(120, 40);
  const exits: number[] = [];
  const app = createTuiApp({
    terminal: term,
    log,
    provider,
    tools: [echoB],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
    reserveTokens: 1000,
    info: { model: "m", providerName: "p", sessionFile: "s" },
    systemPrompt: "s",
    onExit: () => exits.push(1),
    ...over,
  });
  return { app, term, log, exits };
}

describe("命令:帮助、设置、检视器入口、强度、模型、审批", () => {
  it("/help 与 /context 输出", async () => {
    const { app } = boot(scripted([]));
    await app.command("/help");
    await app.command("/context");
    const doc = text(app);
    expect(doc).toContain("/compact");
    expect(doc).toContain("/model");
    expect(doc).toContain("Context  estimated");
    expect(doc).toContain("system prompt");
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
    // 无参数:弹列表选择器,当前模型带 ▸;Esc 关闭
    expect(app.dialogLines().map(stripAnsi).join("\n")).toContain("▸ 1. fake/fake-model");
    app.dialogInput("\x1b");
    expect(app.dialogLines()).toEqual([]);

    await app.command("/model other/big-model");
    expect(calls).toContain("switch:other/big-model");
    expect(text(app)).toContain("big-model");
    expect(text(app)).toContain("model switched to big-model");
    expect(app.agent.provider.model).toBe("big-model");

    await app.command("/key deepseek sk-123");
    expect(calls).toContain("key:deepseek:sk-123");
    expect(text(app)).toContain("key for deepseek saved to the credentials file");

    await app.command("/default");
    expect(calls).toContain("default:other/big-model");
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
    expect(doc).toContain("Requests");
    expect(doc).toContain("▸ #1");
    app.inspector.key("\r");
    doc = app.inspector.lines(100).map(stripAnsi).join("\n");
    expect(doc).toContain("Request #1");
    expect(doc).toContain("[1 summary]");
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
    expect(app.inspector.lines(100).map(stripAnsi).join("\n")).toContain("Events");
    app.inspector.close();
    await app.command("/compactions");
    expect(app.inspector.lines(100).map(stripAnsi).join("\n")).toContain("Compactions");
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
    expect(text(app)).toContain("Effort not set");
    await app.command("/effort xhigh");
    let doc = text(app);
    expect(doc).toContain("· effort set to xhigh");
    expect(doc).toContain("clamped down when sending");
    expect(doc).toContain("· effort xhigh");
    await app.submit("x");
    expect(seen).toEqual(["xhigh"]);
    const req = log.events.find((e) => e.type === "request");
    expect(req).toMatchObject({ type: "request", effort: "xhigh" });
    await app.command("/effort auto");
    doc = text(app);
    expect(doc).toContain("· effort omitted again");
    await app.submit("y");
    expect(seen).toEqual(["xhigh", undefined]);
    await app.command("/effort ultra");
    expect(text(app)).toContain('unknown level "ultra"');
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
    // 结果是一个列表选择器:配置里的标 ✓/✗,服务器上多出来的不可选
    const dlg = app.dialogLines().map(stripAnsi).join("\n");
    expect(dlg).toContain("server 2 · configured 2");
    expect(dlg).toContain("fake-model");
    expect(dlg).toContain("✓ on the server");
    expect(dlg).toContain("retired-model");
    expect(dlg).toContain("possibly retired");
    expect(dlg).toContain("fresh-model");
    expect(dlg).toContain("not in config");
    expect(dlg).not.toContain("big-model");
    app.dialogInput("\x1b");
    expect(app.dialogLines()).toEqual([]);
    app.stop();
  });

  it("--approve ask:每个调用弹一行确认;y 执行、n 以拒绝结果回喂、a 本会话不再问", async () => {
    const term = new VirtualTerminal(100, 40);
    const log = new EventLog();
    const app = createTuiApp({
      terminal: term,
      log,
      provider: scripted([
        {
          text: "",
          toolCalls: [{ id: "c1", name: "echo", args: { text: "one" } }],
          stopReason: "tool",
        },
        {
          text: "",
          toolCalls: [{ id: "c2", name: "echo", args: { text: "two" } }],
          stopReason: "tool",
        },
        {
          text: "",
          toolCalls: [{ id: "c3", name: "echo", args: { text: "three" } }],
          stopReason: "tool",
        },
        {
          text: "",
          toolCalls: [{ id: "c4", name: "echo", args: { text: "four" } }],
          stopReason: "tool",
        },
        { text: "完事", toolCalls: [], stopReason: "end" },
      ]),
      tools: [echo],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 32000 },
      reserveTokens: 32000,
      info: { model: "fake-model", providerName: "fake", sessionFile: "s" },
      systemPrompt: "sys",
      onExit: () => {},
      approve: "ask",
    });
    const tick = () => new Promise((r) => setImmediate(r));
    const running = app.submit("跑");
    await tick();
    const prompt = app.approvalLines().map(stripAnsi).join("\n");
    expect(prompt).toContain("? echo");
    expect(prompt).toContain("▸ 1. Allow once");
    expect(prompt).toContain("2. Allow echo for the rest of this session");
    expect(prompt).toContain("4. Deny");
    term.feed("y");
    await tick();
    await tick();
    term.feed("n");
    await tick();
    await tick();
    term.feed("a");
    await running;
    const doc = text(app);
    expect(app.approvalLines()).toEqual([]);
    expect(doc).toContain("· approve: allowed echo");
    expect(doc).toContain("· approve: denied echo");
    expect(doc).toContain("· approve: allowed echo (not asked again this session)");
    const results = log.events.filter((e) => e.type === "tool/result");
    expect(results.map((r) => r.type === "tool/result" && r.content)).toEqual([
      "echo:one",
      "The user denied this call.",
      "echo:three",
      "echo:four", // a 之后同名工具直接放行
    ]);
    expect(doc).toContain("完事");
    app.stop();
  });
});

describe("按键", () => {
  it("? 列快捷键;Ctrl+R 开关检视器;Ctrl+E 开组装视图;Ctrl+T 切思考;Ctrl+C 退出;检视器的三个入口", async () => {
    const { app, term, exits } = bootB(scriptedB([]));
    term.feed("?");
    expect(doc(app)).toContain("Ctrl+R");
    term.feed("\x12");
    expect(app.inspector.isOpen()).toBe(true);
    term.feed("\x12");
    expect(app.inspector.isOpen()).toBe(false);
    term.feed("\x05");
    expect(app.inspector.isOpen()).toBe(true);
    // 检视器打开时,其余按键归它;? 不再打快捷键
    term.feed("?");
    app.inspector.close();
    term.feed("\x14");
    expect(doc(app)).toContain("thinking expanded");
    term.feed("\x14");
    expect(doc(app)).toContain("thinking collapsed");
    for (const open of [
      app.inspector.openEvents,
      app.inspector.openCompactions,
      app.inspector.openComposition,
    ]) {
      open();
      expect(app.inspector.isOpen()).toBe(true);
      expect(app.inspector.lines(120).length).toBeGreaterThan(0);
      app.inspector.close();
    }
    expect(app.inspector.lines(120)).toEqual([]);
    term.feed("\x03");
    expect(exits).toEqual([1]);
  });
});

describe("提交", () => {
  it("@路径附件:存在的附上并报字节数,不存在的说明跳过", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clari-tui-"));
    writeFileSync(join(tmp, "a.txt"), "hello");
    writeFileSync(join(tmp, "a.bin"), Buffer.from([0, 1, 2, 3]));
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      const { app, log } = bootB(scriptedB([]));
      await app.submit("look at @a.txt and @a.bin");
      const d = doc(app);
      expect(d).toContain("attached @a.txt (5 bytes)");
      expect(d).toContain("@a.bin: binary file, not attached");
      const user = log.events.find((e) => e.type === "user/message");
      expect(user && "text" in user ? user.text : "").toContain("hello");
    } finally {
      process.chdir(cwd);
    }
  });

  it("运行中提交:缺省排成插话,Alt+Enter 排成后续留言;状态栏计数", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const provider: Provider = {
      model: "m",
      async complete() {
        calls += 1;
        if (calls === 1) await new Promise<void>((r) => (release = r));
        return { text: `r${calls}`, toolCalls: [], stopReason: "end" };
      },
    };
    const { app, term } = bootB(provider);
    const first = app.submit("first");
    await tick();
    expect(doc(app)).toContain("● running");
    await app.submit("second");
    expect(doc(app)).toContain("queued as steering");
    await app.submit("third", { deliverAs: "followUp" });
    expect(doc(app)).toContain("queued for after the current step");
    expect(doc(app)).toContain("queued 2");
    // Alt+Enter 走同一条后续留言通道;文本为空时什么也不做
    term.feed("\x1b\r");
    release?.();
    await first;
    for (let i = 0; i < 20 && calls < 3; i++) await tick();
    expect(calls).toBeGreaterThanOrEqual(2);
    app.stop();
  });
});

describe("命令的分支", () => {
  it("/raw 用法与越界;/sessions 空目录与有会话;/mcp 无与有;/fields 无表与有表", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clari-tui-"));
    const withFields: Provider = {
      ...scriptedB([{ text: "ok", toolCalls: [], stopReason: "end" }]),
      fields: {
        protocol: "openai",
        sends: ["messages"],
        reads: ["choices"],
        ignores: ["logprobs"],
      },
    };
    const { app } = bootB(withFields, {
      sessionsDir: tmp,
      trace: false,
      mcp: {
        statuses: () => [
          { name: "s1", phase: "ready", transport: "stdio", toolCount: 2, ms: 5, missingVars: [] },
          {
            name: "s2",
            phase: "failed",
            transport: "http",
            toolCount: 0,
            ms: 9,
            error: "boom",
            missingVars: ["TOKEN"],
          },
        ],
      },
    });
    await app.command("/raw");
    expect(doc(app)).toContain("Usage: /raw N  (1..0); raw capture is off (--no-trace)");
    await app.command("/raw 3");
    expect(doc(app)).toContain("No request #3 (0 so far)");
    await app.command("/sessions");
    expect(doc(app)).toContain(`No sessions in ${tmp}/`);
    writeFileSync(
      join(tmp, "2026-09-01T00-00-00-000Z.jsonl"),
      `${JSON.stringify({ type: "session/start", at: "2026-09-01T00:00:00.000Z", model: "p/m", system: "" })}\n`,
    );
    await app.command("/sessions");
    expect(doc(app)).toContain("1 most recent in");
    expect(doc(app)).toContain("2026-09-01 00:00");
    await app.command("/mcp");
    const d = doc(app);
    expect(d).toContain("MCP 2 servers");
    expect(d).toContain("✓ s1");
    expect(d).toContain("✗ s2");
    expect(d).toContain("boom");
    await app.command("/fields");
    expect(doc(app)).toContain("known but ignored");
    expect(doc(app)).toContain("logprobs");
    await app.submit("go");
    await app.command("/raw 1");
    expect(app.inspector.isOpen()).toBe(true);
    app.inspector.close();
    app.stop();
  });

  it("没有 settings 时 /model /key /default 都说明;/key 用法;/models 供应商不支持;/mcp 无服务器;/fields 无表", async () => {
    const { app } = bootB(scriptedB([]));
    await app.command("/model");
    await app.command("/key");
    await app.command("/default");
    await app.command("/models");
    await app.command("/mcp");
    await app.command("/fields");
    const d = doc(app);
    expect(d.match(/settings interface not configured/g)?.length).toBe(3);
    expect(d).toContain("this provider cannot list models");
    expect(d).toContain("No MCP servers");
    expect(d).toContain("this provider has no field table");
    app.stop();
  });

  it("/prompt 段构成与 instructions-as user 的提示;/compact 失败;/fork 的三种参数;未知命令与模板", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clari-tui-"));
    const log = new EventLog();
    log.append({
      type: "session/start",
      at: "",
      model: "m",
      system: "ROLE ENV",
      sections: [
        { name: "role", chars: 4 },
        { name: "env", source: "cwd", chars: 3 },
      ],
    });
    log.append({ type: "user/message", at: "", text: "<instructions>x</instructions>" });
    const { app } = bootB(
      scriptedB([]),
      {
        sessionsDir: tmp,
        compaction: {
          strategy: async () => {
            throw new Error("no summary today");
          },
          window: 100000,
          reserveTokens: 1000,
        },
        templates: [{ name: "greet", description: "say hi", body: "Hi $ARGUMENTS", path: "t.md" }],
      },
      log,
    );
    await app.command("/prompt");
    let d = doc(app);
    expect(d).toContain("2 sections");
    expect(d).toContain("role");
    expect(d).toContain("cwd");
    expect(d).toContain("first user message (--instructions-as user)");
    expect(d).toContain("memory: off");
    await app.command("/compact");
    expect(doc(app)).toContain("compaction failed: no summary today");
    await app.command("/fork 0");
    expect(doc(app)).toContain("Usage: /fork or /fork N");
    await app.command("/fork");
    d = doc(app);
    expect(d).toContain("forked: first 1 events");
    await app.command("/fork 2");
    expect(doc(app)).toContain("forked: first 2 events");
    await app.command("/nothing");
    expect(doc(app)).toContain("unknown command /nothing");
    await app.command("/greet world");
    d = doc(app);
    expect(d).toContain("template /greet");
    expect(d).toContain("› Hi world");
    app.stop();
  });

  it("/memory:关着时说明;开着时列出、forget N、越界、clear", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clari-tui-"));
    const project = join(tmp, "AGENTS.md");
    const user = join(tmp, "home", "AGENTS.md");
    mkdirSync(join(tmp, "home"));
    appendMemory(project, "preference", "likes short answers");
    appendMemory(user, "project-fact", "uses pnpm");
    const off = bootB(scriptedB([]));
    await off.app.command("/memory");
    expect(doc(off.app)).toContain("memory is off");
    off.app.stop();
    const { app } = bootB(scriptedB([]), { memory: { project, user } });
    await app.command("/memory");
    let d = doc(app);
    expect(d).toContain("Memory 2 entries");
    expect(d).toContain("likes short answers");
    await app.command("/memory forget 9");
    expect(doc(app)).toContain("no entry 9 (2 total)");
    await app.command("/memory forget 1");
    expect(doc(app)).toContain("removed:");
    expect(doc(app)).toContain("likes short answers");
    await app.command("/memory clear");
    d = doc(app);
    expect(d).toContain("cleared 1 memories");
    await app.command("/memory");
    expect(doc(app)).toContain("no memories");
    app.stop();
  });
});

describe("槽命令的分支", () => {
  it("/preservation 三种输入;/approve 的 allow/deny/forget/outside 与用法;运行中拒绝", async () => {
    const { app, log } = bootB(scriptedB([]));
    await app.command("/preservation tokens 5000");
    expect(doc(app)).toContain("preservation → tokens 5000");
    expect(log.events.at(-1)).toMatchObject({
      slot: "preservation",
      value: "keepRecentTokens(5000)",
    });
    await app.command("/preservation ratio 0.3");
    expect(log.events.at(-1)).toMatchObject({ value: "keepRatio(0.3)" });
    await app.command("/preservation ratio 3");
    expect(doc(app)).toContain("ratio must be between 0 and 1");
    await app.command("/preservation lots");
    expect(doc(app)).toContain("Usage: /preservation tokens 20000 | ratio 0.3");
    await app.command("/approve");
    expect(doc(app)).toContain("approve all");
    await app.command("/approve allow");
    expect(doc(app)).toContain("Usage: /approve allow <rule>");
    await app.command("/approve allow bash:git *");
    expect(doc(app)).toContain("approve → allow bash:git *");
    await app.command("/approve deny bash:rm *");
    await app.command("/approve outside allow");
    expect(doc(app)).toContain("approve → outside cwd allow");
    await app.command("/approve outside sideways");
    expect(doc(app)).toContain("Usage: /approve outside ask|allow|deny");
    await app.command("/approve forget");
    expect(doc(app)).toContain("Usage: /approve forget <rule>");
    await app.command("/approve forget bash:git *");
    expect(doc(app)).toContain("approve → forget bash:git *");
    await app.command("/approve bogus");
    await app.command("/slots");
    const d = doc(app);
    expect(d).toContain("policy:");
    expect(d).toContain("bash:rm *");
    expect(d).not.toContain("allow bash:git *,");
    app.stop();
  });

  it("/toolprompts edit 走外部编辑器(改了生效、没改取消);reset;save 写回配置", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clari-tui-"));
    const append = join(tmp, "append.cjs");
    writeFileSync(
      append,
      'const fs=require("fs");const f=process.argv[2];fs.writeFileSync(f,fs.readFileSync(f,"utf8")+" EDITED\\n");',
    );
    const noop = join(tmp, "noop.cjs");
    writeFileSync(noop, "");
    const read = defineTool({
      name: "read",
      description: "guided read",
      parameters: Type.Object({ path: Type.String() }),
      async execute() {
        return "";
      },
    });
    const { app, log } = bootB(scriptedB([]), { tools: [read], toolPrompts: { style: "brief" } });
    process.env.CLARI_EDITOR = `node "${append}"`;
    await app.command("/toolprompts edit read");
    expect(read.description.endsWith("EDITED")).toBe(true);
    expect(doc(app)).toContain("toolPrompts → edit read");
    expect(log.events.at(-1)).toMatchObject({ slot: "toolPrompts", value: "brief, edited: read" });
    await app.command("/toolprompts");
    expect(doc(app)).toContain("edited by you: read");
    await app.command("/toolprompts save");
    const saved = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, "utf8")) as {
      toolPrompts?: { style: string; descriptions?: Record<string, string> };
    };
    expect(saved.toolPrompts?.style).toBe("brief");
    expect(saved.toolPrompts?.descriptions?.read?.endsWith("EDITED")).toBe(true);
    await app.command("/toolprompts reset read");
    expect(read.description).not.toContain("EDITED");
    expect(doc(app)).toContain("toolPrompts → reset read");
    process.env.CLARI_EDITOR = `node "${noop}"`;
    await app.command("/toolprompts edit read");
    expect(doc(app)).toContain("unchanged, cancelled");
    await app.command("/toolprompts edit");
    expect(doc(app)).toContain("no tool named ?");
    app.stop();
  });

  it("审批提示:r 进理由,退格与 Esc 返回;a 放行后不再问;Esc 视为拒绝", async () => {
    const { app } = bootB(
      scriptedB([
        {
          text: "",
          toolCalls: [
            { id: "c1", name: "echo", args: { text: "one" } },
            { id: "c2", name: "echo", args: { text: "two" } },
          ],
          stopReason: "tool",
        },
        { text: "done", toolCalls: [], stopReason: "end" },
      ]),
      { approve: "ask" },
    );
    const run = app.submit("go");
    for (let i = 0; i < 20 && app.approvalLines().length === 0; i++) await tick();
    expect(plain(app.approvalLines().join("\n"))).toContain("asked for every call");
    app.approvalInput("r");
    app.approvalInput("a");
    app.approvalInput("b");
    app.approvalInput("\x7f");
    expect(plain(app.approvalLines().join("\n"))).toContain("reason: a");
    app.approvalInput("\x1b");
    expect(plain(app.approvalLines().join("\n"))).toContain("Allow once");
    // ↓ 移到第 2 项再 Enter,与直接按 a 或 2 等价
    app.approvalInput("\x1b[B");
    expect(plain(app.approvalLines().join("\n"))).toContain(
      "▸ 2. Allow echo for the rest of this session",
    );
    app.approvalInput("\r");
    await run;
    const d = doc(app);
    expect(d).toContain("allowed echo (not asked again this session)");
    expect(d).toContain("done");
    app.stop();
  });
});
