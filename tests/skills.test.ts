// 技能(Q80):frontmatter 四字段、四个发现目录、清单排除只许用户触发的、用户 /名 触发成用户消息、
// allowed-tools 免审批、skill 工具(load = tool)、skills.list = none 不进系统提示词、/skills 列表。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { applyPreset, buildTools, parseCommonArgs, systemPromptFor } from "../cli/bootstrap.js";
import { discoverSkills, expandSkill, parseSkill, skillsSection } from "../cli/prompt.js";
import { createSkillTool } from "../cli/tools/skill.js";
import { createTuiApp } from "../cli/tui-app.js";
import type { KernelConfig } from "../src/config.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { defineTool } from "../src/tools.js";
import { VirtualTerminal } from "./helpers/virtual-terminal.js";

const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const plain = (s: string) => s.replace(ansi, "");

const DEPLOY = `---
name: deploy
description: Ship a release
disable-model-invocation: false
allowed-tools: bash, read
argument-hint: <env>
---
Deploy to $1. Full args: $ARGUMENTS
Run ./scripts/release.sh`;

function project(): { home: string; proj: string } {
  const home = mkdtempSync(join(tmpdir(), "clari-sk-home-"));
  const proj = mkdtempSync(join(tmpdir(), "clari-sk-proj-"));
  mkdirSync(join(proj, ".git"));
  mkdirSync(join(home, "skills", "deploy"), { recursive: true });
  writeFileSync(join(home, "skills", "deploy", "SKILL.md"), DEPLOY);
  mkdirSync(join(proj, ".claude", "skills", "secret"), { recursive: true });
  writeFileSync(
    join(proj, ".claude", "skills", "secret", "SKILL.md"),
    "---\nname: secret\ndescription: user only\ndisable-model-invocation: true\n---\nOnly when asked.",
  );
  return { home, proj };
}

describe("SKILL.md 解析与发现", () => {
  it("四个字段、目录、正文;.claude/skills 也算;清单排除 user-only", () => {
    const s = parseSkill("/x/deploy/SKILL.md", DEPLOY);
    expect(s).toMatchObject({
      name: "deploy",
      description: "Ship a release",
      dir: "/x/deploy",
      disableModelInvocation: false,
      allowedTools: ["bash", "read"],
      argumentHint: "<env>",
    });
    expect(s.body.startsWith("Deploy to $1.")).toBe(true);

    const { home, proj } = project();
    const skills = discoverSkills(proj, { home, root: proj });
    expect(skills.map((x) => [x.name, x.disableModelInvocation])).toEqual([
      ["deploy", false],
      ["secret", true],
    ]);
    const sec = skillsSection(skills);
    expect(sec?.text).toContain("- deploy: Ship a release");
    expect(sec?.text).not.toContain("secret");
    expect(skillsSection(skills.filter((x) => x.disableModelInvocation))).toBeUndefined();
  });

  it("expandSkill:$1 与 $ARGUMENTS 替换,头一行带路径与目录", () => {
    const s = parseSkill("/x/deploy/SKILL.md", DEPLOY);
    const msg = expandSkill(s, 'staging "extra arg"');
    expect(msg).toContain(
      'Skill "deploy" (/x/deploy/SKILL.md; relative paths are relative to /x/deploy)',
    );
    expect(msg).toContain('Deploy to staging. Full args: staging "extra arg"');
  });

  it("skill 工具:只列 model 可调的,返回正文;buildTools 在 load = tool 时装上", async () => {
    const { home, proj } = project();
    const skills = discoverSkills(proj, { home, root: proj });
    const tool = createSkillTool(skills);
    expect(tool.description).toContain("deploy");
    expect(tool.description).not.toContain("secret");
    const out = await tool.execute(
      { name: "deploy", args: "prod" },
      { signal: new AbortController().signal },
    );
    expect(out).toContain("Deploy to prod.");
    const log = new EventLog();
    const choice = {
      provider: {
        model: "m",
        async complete(): Promise<AssistantTurn> {
          return { text: "", toolCalls: [], stopReason: "end" };
        },
      },
      model: "m",
      providerName: "p",
      contextWindow: 1000,
    };
    const cfg = { strategy: async () => null, window: 1000 };
    expect(buildTools(log, choice, cfg, false).map((t) => t.name)).not.toContain("skill");
    expect(
      buildTools(log, choice, cfg, false, undefined, undefined, skills).map((t) => t.name),
    ).toContain("skill");
  });

  it("skills.list = none:清单不进系统提示词;配置与预设都能给", () => {
    const { home, proj } = project();
    const base: KernelConfig = {
      default: "m",
      providers: {},
      prompt: { skills: { list: "none" } },
    };
    const args = applyPreset(parseCommonArgs([]), base);
    expect(args.skillsList).toBe("none");
    const withList = systemPromptFor({ ...parseCommonArgs([]) }, proj, { home, root: proj });
    const without = systemPromptFor(args, proj, { home, root: proj });
    expect(withList.sections.some((s) => s.name === "技能")).toBe(true);
    expect(without.sections.some((s) => s.name === "技能")).toBe(false);
    const preset: KernelConfig = {
      default: "m",
      providers: {},
      presets: { p: { prompt: { skills: { load: "tool" } } } },
    };
    expect(applyPreset(parseCommonArgs(["--preset", "p"]), preset).skillsLoad).toBe("tool");
  });
});

describe("界面里的技能", () => {
  it("/deploy staging 变成一条用户消息;allowed-tools 免审批,turn 结束后恢复;/skills 列表", async () => {
    const { home, proj } = project();
    const skills = discoverSkills(proj, { home, root: proj });
    const asked: string[] = [];
    const bash = defineTool({
      name: "bash",
      description: "",
      parameters: Type.Object({ command: Type.String() }),
      async execute() {
        return "ran";
      },
    });
    const other = defineTool({
      name: "other",
      description: "",
      parameters: Type.Object({}),
      async execute() {
        return "x";
      },
    });
    let step = 0;
    const provider: Provider = {
      model: "m",
      async complete(messages) {
        step += 1;
        if (step === 1) {
          // 第一步:用户消息就是技能正文
          const last = messages.at(-1);
          expect(last?.role === "user" && last.content).toContain("Deploy to staging.");
          return {
            text: "",
            toolCalls: [
              { id: "1", name: "bash", args: { command: "x" } },
              { id: "2", name: "other", args: {} },
            ],
            stopReason: "tool",
          };
        }
        return { text: "done", toolCalls: [], stopReason: "end" };
      },
    };
    const log = new EventLog();
    const term = new VirtualTerminal(110, 30);
    const app = createTuiApp({
      terminal: term,
      log,
      provider,
      tools: [bash, other],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      systemPrompt: "s",
      approve: "ask",
      skills,
      onExit: () => {},
    });
    const run = app.command("/deploy staging");
    // bash 在 allowed-tools 里不问;other 会弹审批,按 n 拒绝
    await new Promise((r) => setTimeout(r, 30));
    for (let i = 0; i < 20 && app.approvalLines().length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    asked.push(plain(app.approvalLines().join("\n")));
    expect(asked[0]).toContain("other");
    expect(asked[0]).not.toContain("bash");
    term.feed("n");
    await run;
    const results = log.events.filter((e) => e.type === "tool/result");
    expect(results.find((r) => r.name === "bash")).toMatchObject({
      isError: false,
      content: "ran",
    });
    const user = log.events.find((e) => e.type === "user/message");
    expect(user?.type === "user/message" && user.text).toContain('Skill "deploy"');
    expect(plain(app.lines(110).join("\n"))).toContain("skill /deploy");

    await app.command("/skills");
    const doc = plain(app.lines(110).join("\n"));
    expect(doc).toContain("/deploy");
    expect(doc).toContain("allowed-tools: bash read");
    expect(doc).toContain("/secret");
    expect(doc).toContain("user-only");
    app.stop();
  });
});
