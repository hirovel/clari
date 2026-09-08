// 命令的选单:次级选项不打字,选。每个命令无参数时弹选单,选中即落地;Esc 回去;
// 打字形态仍然认;帮助只列十四个命令;未知命令给去处。/tools 的开关真的改随请求发出的工具集。
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { createTuiApp, type TuiAppDeps } from "../cli/tui-app.js";
import { COMMANDS } from "../cli/tui-commands.js";
import type { SessionTarget } from "../cli/tui-context.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider, ToolDef } from "../src/provider.js";
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
const shout = defineTool({
  name: "shout",
  description: "Echo the text in capitals.",
  parameters: Type.Object({ text: Type.String() }),
  async execute(a) {
    return a.text.toUpperCase();
  },
});

function boot(over: Partial<TuiAppDeps> = {}, seen: ToolDef[][] = []) {
  const provider: Provider = {
    model: "m",
    async complete(_m, tools): Promise<AssistantTurn> {
      seen.push(tools);
      return { text: "ok", toolCalls: [], stopReason: "end" };
    },
  };
  const term = new VirtualTerminal(110, 40);
  const app = createTuiApp({
    terminal: term,
    log: new EventLog(),
    provider,
    tools: [echo, shout],
    compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
    reserveTokens: 1000,
    info: { model: "m", providerName: "p", sessionFile: "s" },
    systemPrompt: "sys",
    onExit: () => {},
    ...over,
  });
  const doc = () => app.lines(110).map(stripAnsi).join("\n");
  const menu = () => app.dialogLines().map(stripAnsi).join("\n");
  return { app, term, doc, menu };
}

describe("命令选单", () => {
  it("帮助只列十四个命令,按组;未知命令说去哪找", async () => {
    const { app, doc } = boot();
    expect(COMMANDS.map((c) => c.name)).toEqual([
      "help",
      "inspect",
      "set",
      "settings",
      "edit",
      "model",
      "login",
      "tools",
      "session",
      "memory",
      "compact",
      "copy",
      "stop",
      "quit",
    ]);
    await app.command("/help");
    const d = doc();
    expect(d).toContain("/inspect");
    expect(d).toContain("Keys");
    expect(d).not.toContain("/toolprompts");
    expect(d).not.toContain("/approve");
    await app.command("/approve ask");
    expect(doc()).toContain(
      "unknown command /approve  /help lists the commands · Ctrl+K searches everything",
    );
    app.stop();
  });

  it("/inspect 弹分区选单,行注带数量;选 usage 直接印;选 requests 开检视器;Esc 回去", async () => {
    const { app, doc, menu } = boot();
    await app.submit("hi");
    await app.command("/inspect");
    const m = menu();
    expect(m).toContain("Inspect");
    expect(m).toContain("requests");
    expect(m).toContain("every request as sent and received · 1");
    expect(m).toContain("Esc back");
    app.dialogInput("\x1b");
    expect(app.dialogLines()).toEqual([]);
    await app.command("/inspect");
    app.dialogInput("3"); // usage
    app.dialogInput("\r");
    await tick();
    expect(doc()).toContain("Context  estimated");
    await app.command("/inspect");
    app.dialogInput("\r"); // requests(第一行)
    await tick();
    expect(app.inspector.isOpen()).toBe(true);
    app.inspector.close();
    app.stop();
  });

  it("/set 弹槽选单(行注是当前值)→ 值选单 → 落地并记 session/slot;打字形态等价", async () => {
    const { app, doc, menu } = boot();
    await app.command("/set");
    let m = menu();
    expect(m).toContain("Set");
    expect(m).toContain("execution");
    expect(m).toContain("sequential · one tool call at a time");
    app.dialogInput("5"); // execution
    app.dialogInput("\r");
    await tick();
    m = menu();
    expect(m).toContain("now sequential");
    expect(m).toContain("parallel");
    app.dialogInput("2");
    app.dialogInput("\r");
    await tick();
    expect(doc()).toContain("execution → parallel");
    expect(app.agent.slots.execution).toBe("parallel");
    await app.command("/set execution sequential");
    expect(app.agent.slots.execution).toBe("sequential");
    // 审批选单:模式与规则;规则要打字,选中后填进输入框
    await app.command("/set approve");
    app.dialogInput("4"); // allow a rule
    app.dialogInput("\r");
    await tick();
    expect(doc()).toContain("type the rule after the command");
    app.stop();
  });

  it("/tools 选单里 Enter 翻开关:关掉的不随请求发出,/inspect tools 标 off,记 session/slot;打字 only 一次选集", async () => {
    const seen: ToolDef[][] = [];
    const { app, doc, menu } = boot({}, seen);
    await app.command("/tools");
    const m = menu();
    expect(m).toContain("2 of 2 on");
    expect(m).toContain("echo");
    app.dialogInput("2"); // shout
    app.dialogInput("\r");
    await tick();
    expect(menu()).toContain("1 of 2 on"); // 翻完重开
    app.dialogInput("\x1b");
    await tick();
    expect(doc()).toContain("tools off: shout");
    await app.submit("go");
    expect(seen.at(-1)?.map((t) => t.name)).toEqual(["echo"]);
    await app.command("/inspect tools");
    expect(doc()).toMatch(/shout.*off/);
    await app.command("/tools only shout");
    await app.submit("go");
    expect(seen.at(-1)?.map((t) => t.name)).toEqual(["shout"]);
    await app.command("/tools on echo");
    await app.submit("go");
    expect(seen.at(-1)?.map((t) => t.name)).toEqual(["echo", "shout"]);
    await app.command("/tools off nope");
    expect(doc()).toContain("no tool named nope");
    app.stop();
  });

  it("/session 选单:new 走入口的换会话;没有入口时说明;fork 复制前缀", async () => {
    const targets: SessionTarget[] = [];
    const { app, menu } = boot({ switchSession: (t) => targets.push(t) });
    await app.command("/session");
    expect(menu()).toContain("fresh log");
    app.dialogInput("\r"); // new
    await tick();
    expect(targets).toEqual([{ kind: "new" }]);
    const bare = boot();
    await bare.app.command("/session new");
    expect(bare.doc()).toContain("switching sessions is not available here");
    bare.app.stop();
    app.stop();
  });

  it("/edit 选单:retry 与 list;/copy 无代码块时直接复制;/memory 关着时选单不弹", async () => {
    const { app, doc, menu } = boot();
    await app.submit("hi");
    await app.command("/edit");
    expect(menu()).toContain("retry");
    app.dialogInput("3"); // list
    app.dialogInput("\r");
    await tick();
    expect(doc()).toContain("No edits");
    await app.command("/copy");
    expect(app.dialogLines()).toEqual([]);
    expect(doc()).toContain("copied the last reply");
    await app.command("/memory");
    expect(app.dialogLines()).toEqual([]);
    expect(doc()).toContain("memory is off");
    app.stop();
  });
});
