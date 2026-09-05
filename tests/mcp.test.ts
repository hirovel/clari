// MCP 客户端与桥接(Q87):双时代探测、分页、命名、白黑名单、isError 与协议错误、图片落盘、stderr 事件、
// list_changed 刷新、启动失败与 required、HTTP 传输、审批规则、配置合并与变量展开。
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bridgedName,
  connectMcpServers,
  contentToText,
  type McpEvent,
  mcpEvent,
  toolAllowed,
} from "../cli/mcp/bridge.js";
import { expandVars, loadMcpServers, type ResolvedServer } from "../cli/mcp/config.js";
import { decide } from "../src/approval.js";
import type { AgentEvent } from "../src/events.js";
import { EventLog } from "../src/log.js";
import type { Tool } from "../src/tools.js";
import { createLogic } from "./helpers/mcp-server.mjs";

const helper = resolve("tests/helpers/mcp-server.mjs");
const ctx = { signal: new AbortController().signal, callId: "call_1" } as never;
const mcpEvents = (events: readonly AgentEvent[]): McpEvent[] =>
  events.flatMap((e) => {
    const m = mcpEvent(e);
    return m ? [m] : [];
  });

function stdioServer(
  name: string,
  args: string[],
  extra: Partial<ResolvedServer["config"]> = {},
): ResolvedServer {
  return {
    name,
    config: { command: process.execPath, args: [helper, ...args], ...extra },
    missing: [],
    source: "test",
  };
}

const find = (tools: Tool[], name: string) => tools.find((t) => t.name === name) as Tool;

describe("stdio · modern", () => {
  it("server/discover 定时代;分页拼全;命名;echo / boom / proto / image;stderr 进 mcp/log;关闭", async () => {
    const log = new EventLog();
    const tools: Tool[] = [];
    const dir = mkdtempSync(join(tmpdir(), "clari-mcp-"));
    const bridge = await connectMcpServers(
      [stdioServer("fake", ["--era", "modern", "--tools", "3", "--page", "2", "--stderr-noise"])],
      { log, tools, artifactsDir: dir },
    );
    const [s] = bridge.statuses();
    expect(s).toMatchObject({
      phase: "ready",
      era: "modern",
      protocolVersion: "2026-07-28",
      toolCount: 7,
    });
    expect(s?.serverInfo?.name).toBe("fake");
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["boom", "echo", "image", "proto", "t1", "t2", "t3"].map((n) => `mcp__fake__${n}`).sort(),
    );
    const ev = mcpEvents(log.events);
    const lists = ev.filter(
      (m) => m.kind === "rpc" && m.direction === "send" && m.method === "tools/list",
    );
    expect(lists).toHaveLength(4);
    expect(ev.some((m) => m.kind === "log" && m.line === "this is not an error")).toBe(true);
    // 内核只有一种 ext/event;MCP 的四种都装在 payload 里,内核事件表没有 mcp 字样。
    expect(log.events.every((e) => !e.type.startsWith("mcp"))).toBe(true);
    expect(ev.find((m) => m.kind === "server" && m.phase === "ready")).toMatchObject({
      listed: 7,
      toolCount: 7,
    });

    expect(await find(tools, "mcp__fake__echo").execute({ text: "hi" }, ctx)).toBe("echo: hi");
    await expect(find(tools, "mcp__fake__boom").execute({}, ctx)).rejects.toThrow(
      "boom failed on purpose",
    );
    await expect(find(tools, "mcp__fake__proto").execute({}, ctx)).rejects.toThrow(
      /bad params for proto/,
    );
    const img = await find(tools, "mcp__fake__image").execute({}, ctx);
    expect(img).toContain("here is a picture");
    expect(img).toContain("saved to");
    expect(readdirSync(dir)).toEqual(["call_1-1.png"]);
    await bridge.close();
    expect(bridge.statuses()[0]?.phase).toBe("closed");
  });

  it("legacy:initialize 握手;第一次调用后 list_changed → 工具表原地刷新并记 mcp/tools", async () => {
    const log = new EventLog();
    const tools: Tool[] = [];
    const bridge = await connectMcpServers(
      [stdioServer("old", ["--era", "legacy", "--tools", "1", "--list-changed"])],
      { log, tools },
    );
    expect(bridge.statuses()[0]).toMatchObject({
      phase: "ready",
      era: "legacy",
      protocolVersion: "2025-06-18",
    });
    expect(mcpEvents(log.events).some((m) => m.kind === "rpc" && m.method === "initialize")).toBe(
      true,
    );
    expect(await find(tools, "mcp__old__t1").execute({ x: 1 }, ctx)).toBe('t1 got {"x":1}');
    for (let i = 0; i < 50 && !tools.some((t) => t.name === "mcp__old__t_new"); i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(tools.some((t) => t.name === "mcp__old__t_new")).toBe(true);
    const change = mcpEvents(log.events).find(
      (m) => m.kind === "tools" && m.added.includes("mcp__old__t_new"),
    );
    expect(change).toMatchObject({ removed: [], total: 6 });
    await bridge.close();
  });

  it("enabledTools / disabledTools;启动失败只记事件,required 才抛;进程崩溃 → closed", async () => {
    const log = new EventLog();
    const tools: Tool[] = [];
    const bridge = await connectMcpServers(
      [
        stdioServer("f", ["--era", "modern", "--tools", "3"], {
          enabledTools: ["t*"],
          disabledTools: ["t2"],
        }),
        {
          name: "gone",
          config: { command: "clari-no-such-command-xyz" },
          missing: ["TOKEN"],
          source: "test",
        },
        stdioServer("crash", ["--era", "modern", "--tools", "1", "--crash-after", "1"]),
      ],
      { log, tools },
    );
    expect(tools.filter((t) => t.name.startsWith("mcp__f__")).map((t) => t.name)).toEqual([
      "mcp__f__t1",
      "mcp__f__t3",
    ]);
    const gone = bridge.statuses().find((s) => s.name === "gone");
    expect(gone?.phase).toBe("failed");
    expect(gone?.error).toBeTruthy();
    expect(
      mcpEvents(log.events).find(
        (m) => m.kind === "server" && m.server === "gone" && m.phase === "starting",
      ),
    ).toMatchObject({ warning: "unset variables kept as-is: TOKEN" });
    await find(tools, "mcp__crash__t1").execute({}, ctx);
    for (
      let i = 0;
      i < 50 && bridge.statuses().find((s) => s.name === "crash")?.phase !== "closed";
      i++
    )
      await new Promise((r) => setTimeout(r, 20));
    expect(bridge.statuses().find((s) => s.name === "crash")).toMatchObject({ phase: "closed" });
    await expect(find(tools, "mcp__crash__t1").execute({}, ctx)).rejects.toThrow(
      /process|closed|not running/,
    );
    await bridge.close();

    await expect(
      connectMcpServers(
        [
          {
            name: "must",
            config: { command: "clari-no-such-command-xyz", required: true },
            missing: [],
            source: "t",
          },
        ],
        { log: new EventLog(), tools: [] },
      ),
    ).rejects.toThrow(/required but failed/);
  });
});

describe("Streamable HTTP · modern", () => {
  let server: Server;
  let url = "";
  const seen: Record<string, string>[] = [];
  beforeAll(async () => {
    const handle = createLogic({ era: "modern", tools: 1 });
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        seen.push(req.headers as Record<string, string>);
        const msg = JSON.parse(body);
        const out = handle(msg);
        if (msg.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        // 一半走 JSON,一半走 SSE:客户端两种都要吃。
        if (msg.method === "tools/call") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(out.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(""));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(out[0]));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  afterAll(() => server.close());

  it("POST 每条消息;头带版本与方法;JSON 与 SSE 两种响应都能读;Authorization 不进事件", async () => {
    const log = new EventLog();
    const tools: Tool[] = [];
    const bridge = await connectMcpServers(
      [
        {
          name: "web",
          config: { url, headers: { Authorization: "Bearer secret-token" } },
          missing: [],
          source: "t",
        },
      ],
      { log, tools },
    );
    expect(bridge.statuses()[0]).toMatchObject({
      phase: "ready",
      transport: "http",
      era: "modern",
    });
    expect(await find(tools, "mcp__web__echo").execute({ text: "via http" }, ctx)).toBe(
      "echo: via http",
    );
    const call = seen.find((h) => h["mcp-method"] === "tools/call");
    expect(call).toMatchObject({
      "mcp-protocol-version": "2026-07-28",
      "mcp-name": "echo",
      accept: "application/json, text/event-stream",
    });
    expect(JSON.stringify(log.events)).not.toContain("secret-token");
    await bridge.close();
  });
});

describe("命名、白黑名单、内容转换、审批规则、配置", () => {
  it("bridgedName 清洗与超长哈希;toolAllowed;contentToText 各类型", () => {
    expect(bridgedName("my server", "get/issue")).toBe("mcp__my_server__get_issue");
    const long = bridgedName("s", "x".repeat(200));
    expect(long).toHaveLength(128);
    expect(long).toMatch(/_[0-9a-f]{12}$/);
    expect(toolAllowed("get_x", ["get_*"], ["get_x"])).toBe(false);
    expect(toolAllowed("get_y", ["get_*"], ["get_x"])).toBe(true);
    expect(toolAllowed("anything", undefined, undefined)).toBe(true);
    expect(
      contentToText([
        { type: "text", text: "a" },
        { type: "resource", resource: { uri: "file:///x", text: "body" } },
        { type: "resource_link", uri: "https://x", name: "n" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ]),
    ).toBe(
      "a\n[resource file:///x]\nbody\n[resource link n https://x]\n[image image/png, 3 bytes, not saved]",
    );
  });

  it("审批:mcp:<server>:<tool> 规则,mcp 通配整类;缺省问", () => {
    const call = (name: string) => ({ id: "c", name, args: {} });
    const cfg = { default: "ask" as const, allow: ["mcp:github:get_*"], deny: ["mcp:*:delete_*"] };
    expect(decide(call("mcp__github__get_issue"), cfg, "C:/w").verdict).toBe("allow");
    expect(decide(call("mcp__github__delete_repo"), cfg, "C:/w").verdict).toBe("deny");
    expect(decide(call("mcp__github__create_issue"), cfg, "C:/w")).toEqual({
      verdict: "ask",
      reason: "no rule for mcp__github__create_issue",
    });
    expect(decide(call("mcp__x__y"), { default: "ask", allow: ["mcp"] }, "C:/w").verdict).toBe(
      "allow",
    );
  });

  it("配置合并:.mcp.json 与 config.json 同名以后者为准;${VAR} 展开与缺失记录;enabled:false 跳过", () => {
    const dir = mkdtempSync(join(tmpdir(), "clari-mcpcfg-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          a: { type: "stdio", command: "x", args: ["${TOKEN}", "${OPT:-dflt}"] },
          b: { url: "https://b" },
        },
      }),
    );
    const servers = loadMcpServers(
      {
        servers: {
          b: { url: "https://b2", headers: { Authorization: "Bearer ${TOKEN}" } },
          c: { command: "z", enabled: false },
        },
      },
      dir,
      { TOKEN: "tok" },
    );
    expect(servers.map((s) => s.name).sort()).toEqual(["a", "b"]);
    expect(servers.find((s) => s.name === "a")?.config.args).toEqual(["tok", "dflt"]);
    expect(servers.find((s) => s.name === "b")).toMatchObject({
      config: { url: "https://b2", headers: { Authorization: "Bearer tok" } },
      source: "config.json",
    });
    expect(expandVars("${MISSING}/x", {})).toEqual({ value: "${MISSING}/x", missing: ["MISSING"] });
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
  });
});
