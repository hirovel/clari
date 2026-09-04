// 错误处理(P1):分类、供应商原话、下一步提示;request/error 事件带分类与响应体;界面画错误卡。
import http from "node:http";
import { describe, expect, it } from "vitest";
import { createTuiApp } from "../cli/tui-app.js";
import { EventLog } from "../src/log.js";
import { runTurn } from "../src/loop.js";
import { openaiCompat } from "../src/provider.js";
import { classifyError, hintFor, ProviderError, providerMessage } from "../src/providers/errors.js";
import { StreamStall } from "../src/providers/sse.js";
import { VirtualTerminal } from "./helpers/virtual-terminal.js";

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string) => s.replace(ansi, "");

describe("classifyError", () => {
  it("按状态码、错误名与文案分类,溢出优先于状态码", () => {
    expect(classifyError(new ProviderError("x", { status: 401 }))).toBe("auth");
    expect(classifyError(new ProviderError("x", { status: 403 }))).toBe("auth");
    expect(classifyError(new ProviderError("x", { status: 404 }))).toBe("not_found");
    expect(classifyError(new ProviderError("x", { status: 429 }))).toBe("rate_limit");
    expect(classifyError(new ProviderError("x", { status: 500 }))).toBe("server");
    expect(classifyError(new ProviderError("x", { status: 400 }))).toBe("bad_request");
    expect(
      classifyError(new ProviderError("provider 400: prompt is too long", { status: 400 })),
    ).toBe("overflow");
    expect(classifyError(new StreamStall(1000))).toBe("stream");
    expect(classifyError(new ProviderError("stream ended without finish_reason"))).toBe("stream");
    expect(classifyError(new Error("fetch failed"))).toBe("network");
    const aborted = new Error("x");
    aborted.name = "AbortError";
    expect(classifyError(aborted)).toBe("aborted");
    expect(classifyError(new Error("something else"))).toBe("unknown");
    expect(classifyError("not an error")).toBe("unknown");
  });

  it("providerMessage 取响应体里的 error.message,非 JSON 取前 300 字", () => {
    expect(
      providerMessage(
        new ProviderError("provider 401: …", {
          status: 401,
          body: '{"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}',
        }),
      ),
    ).toBe("Incorrect API key provided (invalid_request_error)");
    expect(
      providerMessage(new ProviderError("x", { status: 502, body: "<html>bad gateway</html>" })),
    ).toBe("<html>bad gateway</html>");
    expect(providerMessage(new Error("plain"))).toBeUndefined();
  });

  it("hintFor 每类都指向一个动作,并带上供应商与模型名", () => {
    expect(hintFor("auth", { providerName: "deepseek" })).toContain("/key deepseek");
    expect(hintFor("not_found", { model: "gpt-9" })).toContain("gpt-9");
    expect(hintFor("overflow")).toContain("/compact");
    expect(hintFor("bad_request")).toContain("wire JSON");
    expect(hintFor("stream")).toContain("stallTimeoutMs");
    expect(hintFor("unknown")).toContain("received");
  });
});

describe("request/error 事件与错误卡", () => {
  it("假服务器回 401:事件带 kind / provider / body;界面画出四行错误卡,含下一步", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Incorrect API key provided", type: "invalid_request_error" },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    const provider = openaiCompat({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: "bad",
      model: "m",
    });
    try {
      // 内核层:事件字段
      const log = new EventLog();
      log.append({ type: "session/start", at: "", model: "m", system: "s" });
      log.append({ type: "user/message", at: "", text: "hi" });
      await expect(runTurn({ log, provider, tools: [] })).rejects.toBeInstanceOf(ProviderError);
      const err = log.events.find((e) => e.type === "request/error");
      expect(err).toMatchObject({
        status: 401,
        kind: "auth",
        provider: "Incorrect API key provided (invalid_request_error)",
      });
      expect(err && "body" in err && err.body).toContain("Incorrect API key");

      // 界面层:错误卡
      const log2 = new EventLog();
      const app = createTuiApp({
        terminal: new VirtualTerminal(110, 30),
        log: log2,
        provider,
        tools: [],
        compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
        reserveTokens: 1000,
        info: { model: "m", providerName: "deepseek", sessionFile: "s" },
        systemPrompt: "s",
        onExit: () => {},
      });
      await app.submit("hi");
      const doc = app.lines(110).map(plain).join("\n");
      expect(doc).toContain("Request #1 failed");
      expect(doc).toContain("auth · HTTP 401");
      expect(doc).toContain("provider Incorrect API key provided");
      expect(doc).toContain("/key deepseek");
      expect(doc).toContain("received");
      // 不重复:submit 的 catch 不再另打一行
      expect(doc.match(/Incorrect API key provided/g)?.length).toBe(1);
      app.stop();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
