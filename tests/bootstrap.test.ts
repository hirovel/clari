import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginSession,
  buildCompaction,
  latestSession,
  loadCompactionStrategy,
  openSession,
  parseCommonArgs,
  systemPromptFor,
} from "../cli/bootstrap.js";
import { createTuiApp } from "../cli/tui-app.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function scripted(model: string, turns: AssistantTurn[]): Provider {
  let i = 0;
  return {
    model,
    wire: (messages, tools) => ({ model, messages, tools }),
    async complete() {
      const t = turns[i++];
      if (!t) throw new Error("脚本越界");
      return t;
    },
  };
}

describe("入口参数与会话文件", () => {
  it("parseCommonArgs:选项、-p、位置参数、非法值报错", () => {
    const a = parseCommonArgs([
      "--model",
      "x/y",
      "--effort",
      "minimal",
      "--compaction",
      "clear",
      "--max-steps",
      "3",
      "--json",
      "--trace",
      "任务",
      "文本",
    ]);
    expect(a).toMatchObject({
      model: "x/y",
      effort: "low",
      compaction: "clear",
      maxSteps: 3,
      json: true,
      trace: true,
      rest: ["任务", "文本"],
    });
    expect(parseCommonArgs(["-p", "hi", "--continue"]).rest).toEqual(["hi"]);
    expect(() => parseCommonArgs(["--effort", "ultra"])).toThrow("未知强度级别");
    expect(parseCommonArgs(["--compaction", "./x.mjs"]).compaction).toBe("./x.mjs");
    expect(() => parseCommonArgs(["--bogus"])).toThrow("未知参数");
    expect(() => parseCommonArgs(["--model"])).toThrow("需要一个值");
  });

  it("latestSession 取最新且跳过 trace 文件;openSession 恢复时挂回同一文件", () => {
    tmp = mkdtempSync(join(tmpdir(), "ak-boot-"));
    expect(latestSession(tmp)).toBeUndefined();
    writeFileSync(join(tmp, "2026-09-01T01.jsonl"), "");
    writeFileSync(join(tmp, "2026-09-02T02.jsonl"), "");
    writeFileSync(join(tmp, "2026-09-03T03.trace.jsonl"), "");
    expect(latestSession(tmp)?.endsWith("2026-09-02T02.jsonl")).toBe(true);

    const file = join(tmp, "s.jsonl");
    const first = new EventLog(file);
    first.append({ type: "session/start", at: "t", model: "m", system: "sys" });
    const opened = openSession({ resume: file, continue: false });
    expect(opened.resumed).toBe(true);
    expect(opened.log.events).toHaveLength(1);
    opened.log.append({ type: "user/message", at: "t", text: "继续" });
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
    expect(() => openSession({ resume: join(tmp ?? "", "nope.jsonl"), continue: false })).toThrow(
      "不存在",
    );
  });
});

describe("会话恢复(Q54)", () => {
  it("历史渲染到屏幕、不重发 session/start、换模型记 session/model、检视器可重建同模型的线路正文", async () => {
    tmp = mkdtempSync(join(tmpdir(), "ak-resume-"));
    const file = join(tmp, "s.jsonl");
    const term1 = new VirtualTerminal(100, 40);
    const app1 = createTuiApp({
      terminal: term1,
      log: new EventLog(file),
      provider: scripted("m1", [
        {
          text: "第一轮回复",
          toolCalls: [],
          stopReason: "end",
          usage: { inputTokens: 100, outputTokens: 5 },
        },
      ]),
      tools: [],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 20000 },
      reserveTokens: 20000,
      info: { model: "m1", providerName: "p", sessionFile: file },
      systemPrompt: "原始系统提示词",
      onExit: () => {},
    });
    await app1.submit("第一轮");
    app1.stop();
    const before = readFileSync(file, "utf8").trim().split("\n").length;

    const log = EventLog.load(file, { attach: true });
    const term2 = new VirtualTerminal(100, 40);
    const app2 = createTuiApp({
      terminal: term2,
      log,
      provider: scripted("m1", [{ text: "第二轮回复", toolCalls: [], stopReason: "end" }]),
      tools: [],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 20000 },
      reserveTokens: 20000,
      info: { model: "m1", providerName: "p", sessionFile: file },
      systemPrompt: "这份不该被用",
      onExit: () => {},
    });
    let doc = app2.lines(100).map(stripAnsi).join("\n");
    expect(doc).toContain("› 第一轮");
    expect(doc).toContain("第一轮回复");
    expect(doc).toContain("已恢复会话");
    expect(doc).toContain("· #1"); // 历史请求小结也在
    expect(log.events.filter((e) => e.type === "session/start")).toHaveLength(1);
    expect(log.events.filter((e) => e.type === "session/model")).toHaveLength(0);

    await app2.submit("第二轮");
    doc = app2.lines(100).map(stripAnsi).join("\n");
    expect(doc).toContain("第二轮回复");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(before);
    expect(JSON.parse(lines[0] as string).system).toBe("原始系统提示词");

    // 旧请求的线路正文:模型相同,用当前 provider 重建
    app2.inspector.open();
    app2.inspector.key("g");
    app2.inspector.key("\r");
    app2.inspector.key("5");
    const insp = app2.inspector.lines(100).map(stripAnsi).join("\n");
    expect(insp).toContain('"model": "m1"');
    app2.inspector.close();
    app2.stop();

    // 换模型恢复:入口层(beginSession)记一条 session/model,界面层不再碰
    const s3 = beginSession({ resume: file, continue: false }, { model: "m2" });
    expect(s3.resumed).toBe(true);
    expect(s3.log.events.at(-1)).toMatchObject({ type: "session/model", model: "m2" });
    // 同模型恢复不多记
    const s4 = beginSession({ resume: file, continue: false }, { model: "m2" });
    expect(s4.log.events.filter((e) => e.type === "session/model")).toHaveLength(1);
  });

  it("压缩策略:内置名、外部模块路径(扩展点)、未知名报错", async () => {
    tmp = mkdtempSync(join(tmpdir(), "ak-strategy-"));
    const file = join(tmp, "my-strategy.mjs");
    writeFileSync(
      file,
      "export default async (input) => ({ cleared: [], strategy: `mine(${input.events.length})` });\n",
    );
    const custom = await loadCompactionStrategy(file);
    const out = await custom({ events: [], window: 1, targetTokens: 1 });
    expect(out?.strategy).toBe("mine(0)");
    const cfg = await buildCompaction("clear", 1000, 100);
    expect(cfg).toMatchObject({ window: 1000, reserveTokens: 100 });
    await expect(loadCompactionStrategy("zip")).rejects.toThrow("未知压缩策略");
    writeFileSync(join(tmp, "bad.mjs"), "export const nothing = 1;\n");
    await expect(loadCompactionStrategy(join(tmp, "bad.mjs"))).rejects.toThrow(
      "default 导出一个函数",
    );
  });

  it("新会话的系统提示词带分段构成(名称、来源、字符数)", () => {
    tmp = mkdtempSync(join(tmpdir(), "ak-prompt-"));
    const p = systemPromptFor({}, tmp);
    expect(p.sections.map((s) => s.name)).toEqual(["角色与规则", "环境"]);
    expect(p.sections.every((s) => s.chars > 0)).toBe(true);
    expect(p.text).toContain("工作目录:");
  });
});
