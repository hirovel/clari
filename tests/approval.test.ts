// 审批策略(Q84):规则裁决、cwd 之外、拒绝附理由;日志半行恢复;统一入口。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { createTuiApp } from "../cli/tui-app.js";
import { Agent } from "../src/agent.js";
import { DEFAULT_APPROVAL, decide, describeApproval, policyApprove } from "../src/approval.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
import { VirtualTerminal } from "./helpers/virtual-terminal.js";

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string) => s.replace(ansi, "");
const cwd = "C:/work/repo";
const call = (name: string, args: unknown) => ({ id: "c", name, args });

describe("规则裁决", () => {
  it("缺省:只读放行、其余问人;deny 优先;bash 模式匹配整条命令;路径模式匹配相对路径", () => {
    expect(decide(call("read", { path: "a.ts" }), DEFAULT_APPROVAL, cwd).verdict).toBe("allow");
    expect(decide(call("bash", { command: "git status" }), DEFAULT_APPROVAL, cwd)).toEqual({
      verdict: "ask",
      reason: "no rule for bash",
    });
    const cfg = {
      ...DEFAULT_APPROVAL,
      allow: [...(DEFAULT_APPROVAL.allow ?? []), "bash:git *", "edit:src/**"],
      deny: ["bash:rm -rf *", "bash:git push*"],
    };
    expect(decide(call("bash", { command: "git status" }), cfg, cwd).verdict).toBe("allow");
    expect(decide(call("bash", { command: "git push origin main" }), cfg, cwd)).toEqual({
      verdict: "deny",
      reason: "deny rule bash:git push*",
    });
    expect(decide(call("bash", { command: "rm -rf /" }), cfg, cwd).verdict).toBe("deny");
    expect(decide(call("edit", { path: "src/a/b.ts" }), cfg, cwd).verdict).toBe("allow");
    expect(decide(call("edit", { path: "tests/a.ts" }), cfg, cwd).verdict).toBe("ask");
    expect(decide(call("write", { path: "x" }), { default: "allow" }, cwd).verdict).toBe("allow");
  });

  it("cwd 之外:缺省问,就算 allow 命中;outsideCwd allow 时照规则;deny 时直接拒", () => {
    const outside = call("read", { path: "../secrets.txt" });
    expect(decide(outside, DEFAULT_APPROVAL, cwd)).toEqual({
      verdict: "ask",
      reason: "path outside the working directory",
    });
    expect(decide(outside, { ...DEFAULT_APPROVAL, outsideCwd: "allow" }, cwd).verdict).toBe(
      "allow",
    );
    expect(decide(outside, { ...DEFAULT_APPROVAL, outsideCwd: "deny" }, cwd).verdict).toBe("deny");
    expect(
      decide(call("read", { path: "C:/work/repo/src/a.ts" }), DEFAULT_APPROVAL, cwd).verdict,
    ).toBe("allow");
    expect(describeApproval(DEFAULT_APPROVAL)).toContain("default ask");
  });

  it("policyApprove:没有人可问时 ask 按拒绝并说明;拒绝理由进工具结果", async () => {
    const noAsker = policyApprove(DEFAULT_APPROVAL, undefined, cwd);
    expect(await noAsker(call("read", { path: "a" }))).toBe(true);
    const denied = await noAsker(call("bash", { command: "ls" }));
    expect(denied).toMatchObject({ allowed: false });
    expect((denied as { reason: string }).reason).toContain("no one to ask");

    let calls = 0;
    const provider: Provider = {
      model: "m",
      async complete(): Promise<AssistantTurn> {
        calls++;
        return calls === 1
          ? { text: "", toolCalls: [call("bash", { command: "ls" })], stopReason: "tool" }
          : { text: "done", toolCalls: [], stopReason: "end" };
      },
    };
    const bash = defineTool({
      name: "bash",
      description: "run",
      parameters: Type.Object({ command: Type.String() }),
      async execute() {
        return "ran";
      },
    });
    const log = new EventLog();
    const agent = new Agent({
      log,
      provider,
      tools: [bash],
      slots: { approve: policyApprove(DEFAULT_APPROVAL, undefined, cwd) },
    });
    await agent.prompt("go");
    const result = log.events.find((e) => e.type === "tool/result");
    expect(result).toMatchObject({ isError: true });
    expect((result as { content: string }).content).toContain(
      "The user denied this call: approval policy: no rule for bash",
    );
  });
});

describe("界面:策略提示、r 附理由、/approve 规则", () => {
  it("非只读工具弹提示并写明原因;r + 理由 → 拒绝结果带理由;/approve allow 后不再问", async () => {
    let n = 0;
    const provider: Provider = {
      model: "m",
      async complete(): Promise<AssistantTurn> {
        n++;
        return n % 2 === 1
          ? { text: "", toolCalls: [call("echo", { text: "hi" })], stopReason: "tool" }
          : { text: "ok", toolCalls: [], stopReason: "end" };
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
      terminal: new VirtualTerminal(120, 30),
      log,
      provider,
      tools: [echo],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      systemPrompt: "s",
      approve: DEFAULT_APPROVAL,
      onExit: () => {},
    });
    const pending = app.submit("one");
    await new Promise((r) => setTimeout(r, 20));
    let lines = plain(app.approvalLines().join("\n"));
    expect(lines).toContain("? run echo");
    expect(lines).toContain("(no rule for echo)");
    expect(lines).toContain("r deny with a reason");
    app.approvalInput("r");
    for (const ch of "not now") app.approvalInput(ch);
    lines = plain(app.approvalLines().join("\n"));
    expect(lines).toContain("reason: not now");
    app.approvalInput("\r");
    await pending;
    const denied = log.events.find((e) => e.type === "tool/result");
    expect((denied as { content: string }).content).toBe("The user denied this call: not now");
    expect(plain(app.lines(120).join("\n"))).toContain("· approve: denied echo: not now");

    await app.command("/approve allow echo");
    const slot = log.events.at(-1);
    expect(slot).toMatchObject({ type: "session/slot", slot: "approve" });
    expect((slot as { value: string }).value).toContain("echo");
    await app.submit("two");
    const results = log.events.filter((e) => e.type === "tool/result");
    expect(results).toHaveLength(2);
    expect((results[1] as { content: string; isError: boolean }).isError).toBe(false);
    await app.command("/approve");
    expect(plain(app.lines(120).join("\n"))).toContain("approve policy");
    app.stop();
  });
});

describe("日志半行恢复", () => {
  it("末尾半行截掉并记 session/recovered,文件被修正;中间坏行仍报错", () => {
    const dir = mkdtempSync(join(tmpdir(), "clari-log-"));
    const file = join(dir, "s.jsonl");
    const good = JSON.stringify({ type: "session/start", at: "t", model: "m", system: "s" });
    const half = '{"type":"user/message","at":"t","te';
    writeFileSync(file, `${good}\n${half}`);
    const log = EventLog.load(file, { attach: true });
    expect(log.events.map((e) => e.type)).toEqual(["session/start", "session/recovered"]);
    expect(log.events[1]).toMatchObject({ droppedBytes: Buffer.byteLength(half), preview: half });
    const rewritten = readFileSync(file, "utf8").split("\n").filter(Boolean);
    expect(rewritten).toHaveLength(2);
    expect(JSON.parse(rewritten[1] as string).type).toBe("session/recovered");

    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, `{"broken\n${good}\n`);
    expect(() => EventLog.load(bad)).toThrow(/corrupt event log .*:1/);
  });
});

describe("统一入口", () => {
  it("clari once --help 走一次性入口,exit 0", () => {
    const r = spawnSync("npx", ["tsx", "cli/main.ts", "once", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: true,
      timeout: 60000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });
});
