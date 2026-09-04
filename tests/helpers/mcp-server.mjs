// 假 MCP 服务器(测试用):一行一条 JSON-RPC。
//   --era modern|legacy   modern 认 server/discover 并要求 _meta;legacy 只认 initialize
//   --tools N             生成 N 个工具 t1..tN(外加 echo、image、boom、proto)
//   --page N              tools/list 每页 N 个(分页)
//   --stderr-noise        启动时往 stderr 写两行
//   --slow MS             每次 tools/call 延迟
//   --list-changed        legacy:第一次 tools/call 后推送 notifications/tools/list_changed,之后多一个工具 t_new
//   --crash-after N       第 N 次 tools/call 后退出进程
// 同一套逻辑也给 HTTP 测试用:import { createLogic } 后自己挂 node:http。
import { createInterface } from "node:readline";

export const MODERN = "2026-07-28";
export const LEGACY = "2025-06-18";

export function createLogic(opts = {}) {
  const era = opts.era ?? "modern";
  const n = opts.tools ?? 2;
  const page = opts.page ?? 0;
  let calls = 0;
  let extra = false;
  const tools = () => [
    ...Array.from({ length: n }, (_, i) => ({
      name: `t${i + 1}`,
      description: `tool ${i + 1}`,
      inputSchema: { type: "object", properties: { x: { type: "number" } } },
    })),
    {
      name: "echo",
      description: "Echo text",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    { name: "image", description: "A picture", inputSchema: { type: "object", properties: {} } },
    { name: "boom", description: "Always fails", inputSchema: { type: "object", properties: {} } },
    {
      name: "proto",
      description: "Protocol error",
      inputSchema: { type: "object", properties: {} },
    },
    ...(extra
      ? [
          {
            name: "t_new",
            description: "arrived later",
            inputSchema: { type: "object", properties: {} },
          },
        ]
      : []),
  ];
  const meta = (params) => params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  const err = (id, code, message, data) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data && { data }) },
  });
  const ok = (id, result) => ({ jsonrpc: "2.0", id, result });

  /** 返回要发回的消息数组(可能为空:通知)。after(cb) 用于延后推送。 */
  return function handle(msg, push = () => {}) {
    const { id, method, params } = msg;
    if (method === "server/discover") {
      if (era !== "modern") return [err(id, -32601, "method not found")];
      if (meta(params) !== MODERN)
        return [err(id, -32022, "unsupported protocol version", { supported: [MODERN] })];
      return [
        ok(id, {
          supportedVersions: [MODERN],
          capabilities: { tools: {} },
          instructions: "fake server",
          _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake", version: "1.0" } },
        }),
      ];
    }
    if (method === "initialize") {
      if (era !== "legacy") return [err(id, -32601, "use server/discover")];
      return [
        ok(id, {
          protocolVersion: LEGACY,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: "fake-legacy", version: "0.9" },
        }),
      ];
    }
    if (method === "notifications/initialized" || method === "notifications/cancelled") return [];
    if (era === "modern" && meta(params) !== MODERN)
      return [err(id, -32602, "missing or wrong _meta protocolVersion")];
    if (method === "tools/list") {
      const all = tools();
      if (!page) return [ok(id, { tools: all })];
      const start = Number(params?.cursor ?? 0);
      const slice = all.slice(start, start + page);
      const next = start + page < all.length ? String(start + page) : undefined;
      return [ok(id, { tools: slice, ...(next !== undefined && { nextCursor: next }) })];
    }
    if (method === "tools/call") {
      calls++;
      const name = params?.name;
      const args = params?.arguments ?? {};
      const respond = (result) => {
        const out = [ok(id, result)];
        if (opts.listChanged && calls === 1 && era === "legacy") {
          extra = true;
          push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        }
        if (opts.crashAfter && calls >= opts.crashAfter) setTimeout(() => process.exit(3), 20);
        return out;
      };
      if (name === "proto") return [err(id, -32602, "bad params for proto")];
      if (name === "boom")
        return respond({
          content: [{ type: "text", text: "boom failed on purpose" }],
          isError: true,
        });
      if (name === "image")
        return respond({
          content: [
            { type: "text", text: "here is a picture" },
            { type: "image", data: Buffer.from("PNG").toString("base64"), mimeType: "image/png" },
          ],
        });
      if (name === "echo")
        return respond({ content: [{ type: "text", text: `echo: ${args.text}` }] });
      if (/^t\d+$|^t_new$/.test(name))
        return respond({
          content: [{ type: "text", text: `${name} got ${JSON.stringify(args)}` }],
        });
      return [err(id, -32602, `unknown tool ${name}`)];
    }
    if (id !== undefined) return [err(id, -32601, `method not found: ${method}`)];
    return [];
  };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--era") o.era = argv[++i];
    else if (a === "--tools") o.tools = Number(argv[++i]);
    else if (a === "--page") o.page = Number(argv[++i]);
    else if (a === "--stderr-noise") o.stderr = true;
    else if (a === "--slow") o.slow = Number(argv[++i]);
    else if (a === "--list-changed") o.listChanged = true;
    else if (a === "--crash-after") o.crashAfter = Number(argv[++i]);
  }
  return o;
}

if (process.argv[1] && /mcp-server\.mjs$/.test(process.argv[1])) {
  const opts = parseArgs(process.argv.slice(2));
  const handle = createLogic(opts);
  const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  if (opts.stderr) {
    process.stderr.write("fake mcp server starting\n");
    process.stderr.write("this is not an error\n");
  }
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const reply = () => {
      for (const m of handle(msg, send)) send(m);
    };
    if (opts.slow && msg.method === "tools/call") setTimeout(reply, opts.slow);
    else reply();
  });
  rl.on("close", () => process.exit(0));
}
