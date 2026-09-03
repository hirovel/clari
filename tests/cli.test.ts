// 真实入口:用子进程跑 cli/run.ts,配置从临时文件读(KERNEL_CONFIG),模型是本机假服务器。
// 覆盖 bootstrap → 配置 → 供应商 → 会话文件 → 输出的整条链路;没有 key、要帮助、正常一跑三种情形。
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const TSX = resolve("node_modules/tsx/dist/cli.mjs");
const RUN = resolve("cli/run.ts");
const TUI = resolve("cli/tui.ts");

function run(
  entry: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [TSX, entry, ...args], {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: "1", ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

async function fakeModel(): Promise<{ url: string; calls: number; close(): Promise<void> }> {
  const state = { calls: 0 };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      state.calls += 1;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const body = JSON.parse(raw) as { messages: { role: string; content: string }[] };
      const user = [...body.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const text = `收到:${user}`;
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 42, completion_tokens: 7 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${addr.port}`,
    get calls() {
      return state.calls;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("真实入口(子进程)", () => {
  it("--help 打印用法并以 0 退出;两个入口都认", async () => {
    tmp = mkdtempSync(join(tmpdir(), "ak-cli-"));
    const cfg = join(tmp, "config.json");
    for (const entry of [RUN, TUI]) {
      const r = await run(entry, ["--help"], { cwd: tmp, env: { KERNEL_CONFIG: cfg } });
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain("用法");
      expect(r.stdout).toContain("--compaction");
      expect(r.stdout).toContain(cfg);
    }
  }, 60000);

  it("没有 key:清楚地说去哪里填,退出码 1;首次运行生成配置模板", async () => {
    tmp = mkdtempSync(join(tmpdir(), "ak-cli-"));
    const cfg = join(tmp, "config.json");
    expect(existsSync(cfg)).toBe(false);
    const r = await run(RUN, ["你好"], {
      cwd: tmp,
      env: { KERNEL_CONFIG: cfg, DEEPSEEK_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("没有可用的 API key");
    expect(r.stderr).toContain("DEEPSEEK_API_KEY");
    expect(existsSync(cfg)).toBe(true);
    const created = JSON.parse(readFileSync(cfg, "utf8")) as { default: string };
    expect(created.default).toBe("deepseek-v4-pro");
  }, 60000);

  it("一次性模式对着假模型跑通:JSON 输出、会话文件落在 cwd/sessions、参数错误有提示", async () => {
    tmp = mkdtempSync(join(tmpdir(), "ak-cli-"));
    const model = await fakeModel();
    const cfg = join(tmp, "config.json");
    writeFileSync(
      cfg,
      JSON.stringify({
        default: "m",
        providers: { fake: { protocol: "openai", baseUrl: model.url, apiKey: "k", models: ["m"] } },
      }),
    );
    const ok = await run(RUN, ["你好", "--json", "--effort", "low"], {
      cwd: tmp,
      env: { KERNEL_CONFIG: cfg },
    });
    expect(ok.code, ok.stderr).toBe(0);
    const out = JSON.parse(ok.stdout) as Record<string, unknown>;
    expect(out).toMatchObject({ ok: true, model: "m", text: "收到:你好", steps: 1, requests: 1 });
    expect(model.calls).toBe(1);
    const sessions = readdirSync(join(tmp, "sessions")).filter((f) => f.endsWith(".jsonl"));
    expect(sessions).toHaveLength(1);
    const lines = readFileSync(join(tmp, "sessions", sessions[0] as string), "utf8")
      .trim()
      .split("\n");
    const first = JSON.parse(lines[0] as string) as { type: string; sections?: unknown[] };
    expect(first.type).toBe("session/start");
    expect(Array.isArray(first.sections)).toBe(true);
    expect(lines.some((l) => l.includes('"effort":"low"'))).toBe(true);

    const bad = await run(RUN, ["你好", "--effort", "ultra"], {
      cwd: tmp,
      env: { KERNEL_CONFIG: cfg },
    });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("未知强度级别");

    // 纯文本模式:回复到 stdout,会话路径到 stderr
    const plain = await run(RUN, ["再来"], { cwd: tmp, env: { KERNEL_CONFIG: cfg } });
    expect(plain.code, plain.stderr).toBe(0);
    expect(plain.stdout.trim()).toBe("收到:再来");
    expect(plain.stderr).toContain("[会话:");
    await model.close();
  }, 90000);
});
