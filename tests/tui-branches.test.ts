// 界面模块的分支(重构块 3):按键、提交时的附件与排队、每条命令的用法与错误分支、
// 槽命令的参数校验、审批理由输入、编辑器驱动的工具描述编辑、少见事件的渲染、文本小工具。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it } from "vitest";
import { appendMemory } from "../cli/tools/memory.js";
import { createTuiApp, type TuiApp, type TuiAppDeps } from "../cli/tui-app.js";
import { brief, formatArgs, toolCallDetail } from "../cli/tui-format.js";
import { DEFAULT_CONFIG_PATH } from "../src/config.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

const plain = (s: string) => stripAnsi(s);
const doc = (app: TuiApp) => app.lines(120).map(plain).join("\n");
const tick = () => new Promise((r) => setTimeout(r, 5));

function scripted(turns: AssistantTurn[], extra: Partial<Provider> = {}): Provider {
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

const echo = defineTool({
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

function boot(provider: Provider, over: Partial<TuiAppDeps> = {}, log = new EventLog()) {
  const term = new VirtualTerminal(120, 40);
  const exits: number[] = [];
  const app = createTuiApp({
    terminal: term,
    log,
    provider,
    tools: [echo],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
    reserveTokens: 1000,
    info: { model: "m", providerName: "p", sessionFile: "s" },
    systemPrompt: "s",
    onExit: () => exits.push(1),
    ...over,
  });
  return { app, term, log, exits };
}

describe("按键", () => {
  it("? 列快捷键;Ctrl+R 开关检视器;Ctrl+E 开组装视图;Ctrl+T 切思考;Ctrl+C 退出;检视器的三个入口", async () => {
    const { app, term, exits } = boot(scripted([]));
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
      const { app, log } = boot(scripted([]));
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
    const { app, term } = boot(provider);
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
      ...scripted([{ text: "ok", toolCalls: [], stopReason: "end" }]),
      fields: {
        protocol: "openai",
        sends: ["messages"],
        reads: ["choices"],
        ignores: ["logprobs"],
      },
    };
    const { app } = boot(withFields, {
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
    const { app } = boot(scripted([]));
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
    const { app } = boot(
      scripted([]),
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
    const off = boot(scripted([]));
    await off.app.command("/memory");
    expect(doc(off.app)).toContain("memory is off");
    off.app.stop();
    const { app } = boot(scripted([]), { memory: { project, user } });
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

  it("/retry:运行中拒绝;空闲时丢掉最后一步重问;上下文面板的 drop 与 fork 动作", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clari-tui-"));
    const { app, log } = boot(
      scripted([
        { text: "first answer", toolCalls: [], stopReason: "end" },
        { text: "second answer", toolCalls: [], stopReason: "end" },
        { text: "third", toolCalls: [], stopReason: "end" },
      ]),
      { sessionsDir: tmp },
    );
    await app.submit("q");
    expect(doc(app)).toContain("first answer");
    await app.command("/retry");
    expect(doc(app)).toContain("second answer");
    expect(log.events.some((e) => e.type === "context/drop")).toBe(true);
    // 面板:最后一条(用户消息 q 之后是助手回复)→ Enter 出菜单 → ↓↓ 到 Drop → Enter
    app.inspector.openComposition();
    app.inspector.key("\r");
    let ins = plain(app.inspector.lines(120).join("\n"));
    expect(ins).toContain("Drop this message");
    app.inspector.key("\x1b[B");
    app.inspector.key("\x1b[B");
    app.inspector.key("\r");
    await tick();
    expect(app.inspector.isOpen()).toBe(false);
    expect(doc(app)).toContain("dropped event #");
    // 再开面板,菜单最后一项是 Fork
    app.inspector.openComposition();
    app.inspector.key("\r");
    ins = plain(app.inspector.lines(120).join("\n"));
    const items = ins
      .split("\n")
      .filter((l) =>
        /Fork here|Retry last step|Drop this message|Edit content|View full message/.test(l),
      );
    expect(items.length).toBeGreaterThan(2);
    for (let i = 0; i < 6; i++) app.inspector.key("\x1b[B");
    app.inspector.key("\r");
    await tick();
    expect(doc(app)).toContain("forked: first");
    app.stop();
  });
});

describe("槽命令的分支", () => {
  it("/preservation 三种输入;/approve 的 allow/deny/forget/outside 与用法;运行中拒绝", async () => {
    const { app, log } = boot(scripted([]));
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
    const { app, log } = boot(scripted([]), { tools: [read], toolPrompts: { style: "terse" } });
    process.env.CLARI_EDITOR = `node "${append}"`;
    await app.command("/toolprompts edit read");
    expect(read.description.endsWith("EDITED")).toBe(true);
    expect(doc(app)).toContain("toolPrompts → edit read");
    expect(log.events.at(-1)).toMatchObject({ slot: "toolPrompts", value: "terse, edited: read" });
    await app.command("/toolprompts");
    expect(doc(app)).toContain("edited by you: read");
    await app.command("/toolprompts save");
    const saved = JSON.parse(readFileSync(DEFAULT_CONFIG_PATH, "utf8")) as {
      toolPrompts?: { style: string; descriptions?: Record<string, string> };
    };
    expect(saved.toolPrompts?.style).toBe("terse");
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
    const { app } = boot(
      scripted([
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
    expect(plain(app.approvalLines().join("\n"))).toContain("y allow");
    app.approvalInput("a");
    await run;
    const d = doc(app);
    expect(d).toContain("allowed echo (not asked again this session)");
    expect(d).toContain("done");
    app.stop();
  });
});

describe("少见事件与流式思考的渲染", () => {
  it("恢复的日志里 session/recovered 与 ext/event(mcp 与未登记来源)各画一行", () => {
    const log = new EventLog();
    log.append({ type: "session/start", at: "", model: "m", system: "s" });
    log.append({ type: "session/recovered", at: "", droppedBytes: 12, preview: "{" });
    log.append({
      type: "ext/event",
      at: "",
      source: "mcp",
      kind: "server",
      payload: {
        server: "s1",
        phase: "ready",
        transport: "stdio",
        era: "modern",
        protocolVersion: "2026-07-28",
        toolCount: 2,
        listed: 3,
        ms: 7,
      },
    });
    log.append({
      type: "ext/event",
      at: "",
      source: "mcp",
      kind: "rpc",
      payload: { server: "s1", direction: "send", bytes: 1, body: "{}" },
    });
    log.append({ type: "ext/event", at: "", source: "other", kind: "thing", payload: {} });
    log.append({ type: "session/slot", at: "", slot: "execution", value: "parallel" });
    const { app } = boot(scripted([]), {}, log);
    const d = doc(app);
    expect(d).toContain("recovered: dropped 12 bytes");
    expect(d).toContain("mcp s1: ready · stdio · modern 2026-07-28 · 2 tools of 3 listed · 7ms");
    expect(d).toContain("· other/thing");
    expect(d).not.toContain("rpc");
    expect(d).toContain("resumed: 6 events");
    app.stop();
  });

  it("流式思考:定稿带思考时保留节点并可 Ctrl+T 展开;定稿无思考时撤掉节点;task 调用留槽", async () => {
    const { app, term } = boot(
      scripted([
        {
          text: "",
          toolCalls: [{ id: "t1", name: "task", args: { task: "sub job" } }],
          stopReason: "tool",
          reasoning: "thinking hard about it",
          reasoningKind: "full",
        },
        { text: "final", toolCalls: [], stopReason: "end", reasoning: "" },
      ]),
    );
    await app.submit("go");
    let d = doc(app);
    expect(d).toContain("thinking");
    expect(d).toContain("⚙ task");
    term.feed("\x14");
    d = doc(app);
    expect(d).toContain("thinking hard about it");
    expect(d).toContain("final");
    app.stop();
  });
});

describe("文本小工具", () => {
  it("formatArgs 的四种形态与截断;brief;toolCallDetail 的 write 长文与超长 diff", () => {
    expect(formatArgs({ command: "ls -la" })).toBe("ls -la");
    expect(formatArgs({ path: "a.ts", offset: 5, limit: 3 })).toBe("a.ts  from line 5, 3 lines");
    expect(formatArgs({ path: "a.ts", limit: 3 })).toBe("a.ts  from line 1, 3 lines");
    expect(formatArgs({ task: `${"x".repeat(30)}\nmore`, scope: "fork" })).toBe(
      `scope=fork  ${"x".repeat(24)}…`,
    );
    expect(formatArgs({ other: "y".repeat(200) }).endsWith("…")).toBe(true);
    expect(formatArgs(undefined)).toBe("");
    expect(brief("short")).toBe("short");
    const write = plain(
      toolCallDetail("write", {
        content: Array.from({ length: 15 }, (_, i) => `l${i}`).join("\n"),
      }),
    );
    expect(write).toContain("+ l11");
    expect(write).not.toContain("+ l12");
    expect(write).toContain("… 15 lines total");
    const oldText = Array.from({ length: 70 }, (_, i) => `a${i}`).join("\n");
    const newText = Array.from({ length: 70 }, (_, i) => `b${i}`).join("\n");
    const big = plain(toolCallDetail("edit", { oldText, newText }));
    expect(big).toContain("more changed lines");
    expect(toolCallDetail("bash", { command: "x" })).toBe("");
  });
});
