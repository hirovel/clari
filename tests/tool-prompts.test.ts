// 工具描述风格槽(Q89):三套风格可切、逐工具可改、切回原文;/toolprompts 记 session/slot;--tool-prompts 解析;
// MCP 事件泛化后审批规则按命名空间仍然对上。
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { parseCommonArgs, resolveToolPrompts } from "../cli/bootstrap.js";
import {
  applyToolPrompts,
  describeToolPrompts,
  styledDescription,
  styleTokens,
} from "../cli/tool-prompts.js";
import { createTuiApp } from "../cli/tui-app.js";
import { decide } from "../src/approval.js";
import { EventLog } from "../src/log.js";
import type { Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
import { VirtualTerminal } from "./helpers/virtual-terminal.js";

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string) => s.replace(ansi, "");

function fakeRead() {
  return defineTool({
    name: "read",
    description: "guided read text",
    parameters: Type.Object({ path: Type.String() }),
    async execute() {
      return "";
    },
  });
}

describe("applyToolPrompts", () => {
  it("terse / strict 换描述,guided 切回原文;表里没有的工具不动;用户覆盖最优先", () => {
    const read = fakeRead();
    const other = defineTool({
      name: "other",
      description: "mine",
      parameters: Type.Object({}),
      async execute() {
        return "";
      },
    });
    const tools = [read, other];
    expect(applyToolPrompts(tools, { style: "terse" })).toEqual(["read"]);
    expect(read.description).toMatch(/^Read a text file as numbered lines, or list a directory\./);
    expect(other.description).toBe("mine");
    applyToolPrompts(tools, { style: "strict" });
    expect(read.description).toContain("ALWAYS read only the part you need");
    applyToolPrompts(tools, { style: "guided" });
    expect(read.description).toBe("guided read text");
    applyToolPrompts(tools, { style: "terse", descriptions: { read: "my own words" } });
    expect(read.description).toBe("my own words");
    expect(styledDescription(other, { style: "strict" })).toBe("mine");
    expect(describeToolPrompts({ style: "terse", descriptions: { read: "x" } })).toBe(
      "terse, edited: read",
    );
    expect(describeToolPrompts(undefined)).toBe("guided");
    expect(styleTokens(tools, { style: "terse" })).toBeLessThan(
      styleTokens(tools, { style: "strict" }),
    );
  });

  it("--tool-prompts 解析与优先级:命令行 > 配置 > guided;非法值报错", () => {
    const args = parseCommonArgs(["--tool-prompts", "strict"]);
    expect(args.toolPrompts).toBe("strict");
    expect(() => parseCommonArgs(["--tool-prompts", "loud"])).toThrow("--tool-prompts accepts");
    const config = {
      default: "p/m",
      providers: {},
      toolPrompts: { style: "terse" as const, descriptions: { read: "r" } },
    };
    expect(resolveToolPrompts(args, config)).toEqual({
      style: "strict",
      descriptions: { read: "r" },
    });
    expect(resolveToolPrompts(parseCommonArgs([]), config).style).toBe("terse");
    expect(resolveToolPrompts(parseCommonArgs([]), { default: "p/m", providers: {} })).toEqual({
      style: "guided",
    });
  });
});

describe("/toolprompts", () => {
  it("列表标出当前风格与 token;切换记 session/slot 并改描述;reset 未改过的说明;非法子命令给用法", async () => {
    const log = new EventLog();
    const provider: Provider = {
      model: "m",
      async complete() {
        return { text: "done", toolCalls: [], stopReason: "end" };
      },
    };
    const read = fakeRead();
    const app = createTuiApp({
      terminal: new VirtualTerminal(120, 30),
      log,
      provider,
      tools: [read],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      systemPrompt: "s",
      toolPrompts: { style: "guided" },
      onExit: () => {},
    });
    const text = () => app.lines(120).map(plain).join("\n");
    await app.command("/toolprompts");
    let doc = text();
    expect(doc).toContain("● guided");
    expect(doc).toContain("○ terse");
    expect(doc).toContain("○ strict");
    await app.command("/toolprompts terse");
    expect(read.description).toMatch(/^Read a text file as numbered lines/);
    expect(log.events.at(-1)).toMatchObject({
      type: "session/slot",
      slot: "toolPrompts",
      value: "terse",
    });
    await app.command("/slots");
    expect(text()).toContain("toolPrompts   terse");
    await app.command("/toolprompts reset read");
    expect(text()).toContain("read is not edited");
    await app.command("/toolprompts reset nope");
    expect(text()).toContain("no tool named nope");
    await app.command("/toolprompts loud");
    doc = text();
    expect(doc).toContain("Usage: /toolprompts guided|terse|strict");
    await app.command("/tools");
    expect(text()).toContain("style terse");
    app.stop();
  });
});

describe("命名空间工具的审批规则(Q87 修订)", () => {
  it("prefix__group__name 对上 prefix:group:pattern 与裸 prefix;别的命名空间对不上", () => {
    const call = { id: "c", name: "mcp__github__get_issue", args: {} };
    const cfg = {
      default: "ask" as const,
      allow: ["mcp:github:get_*"],
      deny: ["mcp:github:delete_*"],
    };
    expect(decide(call, cfg, "C:/w").verdict).toBe("allow");
    expect(decide({ ...call, name: "mcp__github__delete_repo" }, cfg, "C:/w").verdict).toBe("deny");
    expect(decide({ ...call, name: "mcp__other__get_x" }, cfg, "C:/w").verdict).toBe("ask");
    expect(decide(call, { default: "ask", allow: ["mcp"] }, "C:/w").verdict).toBe("allow");
    expect(decide({ ...call, name: "ext__github__get_issue" }, cfg, "C:/w").verdict).toBe("ask");
  });
});
