// 界面定稿(Q83):标签沟卡片、changed 行、未变折叠、上下文面板动作菜单与后果、/compare /restore /rewind、首屏、? 键。
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import {
  changedLine,
  firstRunLines,
  messageRows,
  messageTableLines,
  sendCardLines,
  thinkingLines,
} from "../cli/cards.js";
import { actionsFor, compositionRows, consequenceOf } from "../cli/inspector.js";
import { createTuiApp } from "../cli/tui-app.js";
import { type AgentEvent, now } from "../src/events.js";
import { EventLog } from "../src/log.js";
import type { Message } from "../src/messages.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
import { VirtualTerminal } from "./helpers/virtual-terminal.js";

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string) => s.replace(ansi, "");

const user = (content: string): Message => ({ role: "user", content });
const assistant = (content: string): Message => ({ role: "assistant", content, toolCalls: [] });

describe("Request 卡:changed 行与消息表", () => {
  it("第一次请求说 first request;之后按前缀比出 new / edited / summary,未变超过 3 条折叠", () => {
    const prev = [user("a"), assistant("b"), user("c"), assistant("d"), user("e")];
    const cur = [
      ...prev,
      { ...assistant("d2"), edited: true as const },
      user("f"),
      { ...user("[summary]"), edited: true as const },
    ];
    const provenance = cur.map((_, i) => ({
      event: i + 1,
      stages: i === 5 ? ["edited:text"] : i === 7 ? ["summary(covers #1–#3)"] : [],
    }));
    const rows = messageRows(cur, prev, provenance);
    expect(rows.map((r) => r.state)).toEqual([
      "same",
      "same",
      "same",
      "same",
      "same",
      "edited",
      "new",
      "summary",
    ]);
    const table = plain(messageTableLines(rows).join("\n"));
    expect(table).toContain("…  3 unchanged");
    expect(table).toContain("✎   6  assistant");
    expect(table).toContain("+   7  user");
    expect(table).toContain("≈   8  user");
    const request = {
      type: "request" as const,
      at: now(),
      model: "m",
      reason: "turn" as const,
      messages: cur.length,
      tools: [],
      estimatedTokens: 40,
      threshold: 1000,
    };
    const changed = plain(
      changedLine(
        {
          n: 2,
          request,
          messages: cur,
          previous: prev,
          defs: [],
          toolsUnchanged: true,
          provenance,
        },
        rows,
      ),
    );
    expect(changed).toContain("+1 new");
    expect(changed).toContain("1 edited (#6)");
    expect(changed).toContain("1 summary (#8)");
    expect(changed).toContain("3 recomputed");
    const first = plain(
      sendCardLines({ n: 1, request, messages: cur, defs: [], toolsUnchanged: false }).join("\n"),
    );
    expect(first).toContain("Request #1");
    expect(first).toContain("first request · 8 messages");
    expect(first).toContain("limit");
    expect(first).toContain("tok until auto-compaction");
  });

  it("思考缺省一行,展开后逐行;首屏五个动词", () => {
    const collapsed = plain(thinkingLines("line one\nline two", "full", false).join("\n"));
    expect(collapsed.split("\n")).toHaveLength(1);
    expect(collapsed).toContain("line one");
    expect(collapsed).toContain("(full · 2 lines · Ctrl+T)");
    const expanded = plain(thinkingLines("line one\nline two", "summary", true).join("\n"));
    expect(expanded).toContain("summary · the model reads the opaque block");
    expect(expanded).toContain("line two");
    const first = plain(firstRunLines().join("\n"));
    for (const verb of ["type", "watch", "inspect", "change", "more"])
      expect(first).toContain(verb);
  });
});

describe("上下文面板的动作与后果", () => {
  it("动作按消息类型与编辑状态增减;后果算出重算条数、缓存失效点、Anthropic 丢的思考块", () => {
    const events: AgentEvent[] = [
      { type: "session/start", at: now(), model: "m", system: "sys" },
      { type: "user/message", at: now(), text: "q" },
      {
        type: "assistant/message",
        at: now(),
        text: "a",
        toolCalls: [{ id: "c1", name: "read", args: {} }],
        stopReason: "tool",
        reasoning: "why",
        reasoningKind: "full",
        opaque: { kind: "anthropic-thinking", model: "m", blocks: [] },
      },
      {
        type: "tool/result",
        at: now(),
        callId: "c1",
        name: "read",
        content: "file",
        isError: false,
      },
      { type: "assistant/message", at: now(), text: "done", toolCalls: [], stopReason: "end" },
      { type: "context/edit", at: now(), target: 3, field: "content", value: "file (edited)" },
    ];
    const { rows } = compositionRows(events);
    const asst = rows.find((r) => r.event === 2) as (typeof rows)[number];
    const tool = rows.find((r) => r.event === 3) as (typeof rows)[number];
    const last = rows[rows.length - 1] as (typeof rows)[number];
    expect(actionsFor(events, asst, rows.length).map((a) => a.action)).toEqual([
      "view",
      "edit",
      "edit-reasoning",
      "drop",
      "rewind",
      "retry",
      "fork",
    ]);
    expect(actionsFor(events, tool, rows.length).map((a) => a.action)).toEqual([
      "view",
      "edit",
      "compare",
      "restore",
      "rewind",
      "retry",
      "fork",
    ]);
    expect(actionsFor(events, last, rows.length).map((a) => a.action)).not.toContain("rewind");
    const anthropic = {
      model: "m",
      fields: { protocol: "anthropic", sends: [], reads: [], ignores: [] },
      complete: async () => ({}) as AssistantTurn,
    } as unknown as Provider;
    const edit = consequenceOf("edit", asst, rows, events, anthropic);
    expect(edit).toContain("2 messages after #2 recomputed");
    expect(edit).toContain("cache miss from #2 on");
    expect(edit).toContain("Anthropic drops 1 thinking block");
    expect(consequenceOf("drop", asst, rows, events)).toContain("with its 1 tool result");
    expect(consequenceOf("rewind", tool, rows, events)).toContain(
      "the next request starts from #3",
    );
    expect(consequenceOf("view", tool, rows, events)).toBe("read-only · nothing changes");
  });

  it("界面:Enter 出菜单再 Enter 执行;/compare /restore /rewind 落到事件;首屏随第一条消息撤掉;? 列快捷键", async () => {
    const provider: Provider = {
      model: "m",
      async complete(): Promise<AssistantTurn> {
        return { text: "reply", toolCalls: [], stopReason: "end" };
      },
    };
    const echo = defineTool({
      name: "echo",
      description: "Echo.",
      parameters: Type.Object({ text: Type.String() }),
      async execute(a) {
        return a.text;
      },
    });
    const log = new EventLog();
    const app = createTuiApp({
      terminal: new VirtualTerminal(120, 40),
      log,
      provider,
      tools: [echo],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      systemPrompt: "s",
      onExit: () => {},
    });
    let doc = plain(app.lines(120).join("\n"));
    expect(doc).toContain("Everything the model sees");
    expect(doc).toContain("Try:");
    await app.submit("first");
    await app.submit("second");
    doc = plain(app.lines(120).join("\n"));
    expect(doc).not.toContain("Everything the model sees");
    expect(doc).toContain("Request #2");
    expect(doc).toContain("+2 new");
    expect(doc).toContain("reply");

    // Ctrl+E → 上下文面板;选最后一条(事件 #6,request 事件也占号)→ Enter 出菜单;↓ 到 Edit 看后果。
    app.inspector.openComposition();
    app.inspector.key("\r");
    let ins = plain(app.inspector.lines(120).join("\n"));
    expect(ins).toContain("Actions");
    expect(ins).toContain("View full message");
    expect(ins).toContain("If you do this");
    expect(ins).toContain("read-only · nothing changes");
    app.inspector.key("\x1b[B");
    ins = plain(app.inspector.lines(120).join("\n"));
    expect(ins).toContain("Edit content");
    expect(ins).toContain("cache miss from #6 on");
    app.inspector.key("\x1b");
    app.inspector.close();

    // 命令:编辑 #1 的 content,再 compare 与 restore;rewind 到 #1 丢掉之后的三条。
    await app.command("/edit 1 content first (edited)");
    await app.command("/compare 1");
    doc = plain(app.lines(120).join("\n"));
    expect(doc).toContain("#1.content  original 5 chars → current 14 chars");
    expect(doc).toContain("- first");
    expect(doc).toContain("+ first (edited)");
    await app.command("/restore 1");
    const restore = log.events.at(-1);
    expect(restore?.type).toBe("context/edit");
    expect((restore as { value: string }).value).toBe("first");
    await app.command("/rewind 1");
    const drops = log.events.filter((e) => e.type === "context/drop");
    expect(drops.map((e) => (e as { target: number }).target)).toEqual([3, 4, 6]);
    doc = plain(app.lines(120).join("\n"));
    expect(doc).toContain("rewound to event #1: dropped 3 messages");
    app.stop();
  });
});
