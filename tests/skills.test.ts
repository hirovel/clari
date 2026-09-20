// 技能:frontmatter 四字段、四个发现目录、清单排除只许用户触发的、用户 /名 触发成用户消息、
// allowed-tools 免审批、skill 工具(load = tool)、skills.mode = manual 不进系统提示词、/skills 列表。
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { applyPreset, buildTools, parseCommonArgs, systemPromptFor } from "../cli/bootstrap.js";
import {
  automaticSkills,
  discoverSkills,
  expandSkill,
  parseSkill,
  skillsSection,
} from "../cli/prompt.js";
import { recordSessionSetup, restoreSessionSetup } from "../cli/session-setup.js";
import { createSkillTool } from "../cli/tools/skill.js";
import { createTuiApp } from "../cli/tui-app.js";
import type { KernelConfig } from "../src/config.js";
import { EventLog } from "../src/log.js";
import { deriveMessages } from "../src/messages.js";
import type { Provider } from "../src/provider.js";
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

    const body = "Keep $ARGUMENTS literal.\r\n\r\n---\r\n  Indented Markdown stays intact.";
    const yaml = parseSkill(
      "/x/review/SKILL.md",
      `\uFEFF---\r\nname: "review" # comment\r\ndescription: >-\r\n  Review code changes\r\n  and find defects.\r\ndisable-model-invocation: true\r\nallowed-tools: 'read grep'\r\nargument-hint: '<file:line>'\r\n---\r\n${body}`,
    );
    expect(yaml).toMatchObject({
      name: "review",
      description: "Review code changes and find defects.",
      disableModelInvocation: true,
      allowedTools: ["read", "grep"],
      argumentHint: "<file:line>",
      body,
    });
    expect(
      parseSkill("/x/review/SKILL.md", "---\ndescription: |\n  First line\n  Second line\n---")
        .description,
    ).toBe("First line\nSecond line");
    expect(
      parseSkill("/x/review/SKILL.md", "---\ndescription:\nname: review\n---\nbody").description,
    ).toBe("");
    for (const invalid of [
      "name: [unclosed",
      "name: review\nname: duplicate",
      "- not a mapping",
      "disable-model-invocation: yes",
      "allowed-tools: [read, grep]",
    ])
      expect(() => parseSkill("/x/broken/SKILL.md", `---\n${invalid}\n---\nbody`)).toThrow(
        "Invalid skill /x/broken/SKILL.md",
      );
    expect(() => parseSkill("/x/broken/SKILL.md", "---\nname: review")).toThrow(
      "Unclosed YAML frontmatter",
    );

    const { home, proj } = project();
    const broken = join(home, "skills", "broken", "SKILL.md");
    mkdirSync(join(home, "skills", "broken"), { recursive: true });
    writeFileSync(broken, "---\nname: [unclosed\n---\nbody");
    const warnings: string[] = [];
    const skills = discoverSkills(proj, {
      home,
      root: proj,
      onError: (error) => warnings.push(error.message),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(broken);
    expect(warnings[0]).toContain("Invalid skill");
    expect(skills.map((x) => [x.name, x.disableModelInvocation])).toEqual([
      ["deploy", false],
      ["secret", true],
    ]);
    const sec = skillsSection(skills, { mode: "auto" });
    expect(sec?.text).toContain("- deploy: Ship a release");
    expect(sec?.text).not.toContain("secret");
    expect(skillsSection(skills.filter((x) => x.disableModelInvocation))).toBeUndefined();
  });

  it("技能正文不作模板替换,带来源并完整保留用户要求,无参数时只加载正文", () => {
    const s = parseSkill("/x/deploy/SKILL.md", DEPLOY);
    const request = 'staging "extra arg"\n保留字面量 $1、$@ 和 $ARGUMENTS';
    const msg = expandSkill(s, request);
    expect(msg).toContain(
      'Skill "deploy" (/x/deploy/SKILL.md; relative paths are relative to /x/deploy)',
    );
    expect(msg).toContain(s.body);
    expect(msg.endsWith(`User request:\n${request}`)).toBe(true);
    const ordinary = {
      ...s,
      body: "Collect writing fragments. Ask for the output path if missing.",
    };
    expect(expandSkill(ordinary, "Save to fragments.md")).toContain(
      `${ordinary.body}\n\nUser request:\nSave to fragments.md`,
    );
    expect(expandSkill(s, "").endsWith(s.body)).toBe(true);
    expect(expandSkill(s, " \n ")).toBe(expandSkill(s, ""));
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
    expect(out).toContain("Deploy to $1. Full args: $ARGUMENTS");
    expect(out).toContain("User request:\nprod");
    expect(buildTools().map((t) => t.name)).not.toContain("skill");
    expect(buildTools({ skills }).map((t) => t.name)).toContain("skill");
  });

  it("手动缺省,自动范围全选包含后来发现的技能,指定名称保持固定;配置与预设都能给", () => {
    const { home, proj } = project();
    const base: KernelConfig = {
      default: "m",
      providers: {},
      prompt: { skills: { mode: "manual" } },
    };
    const args = applyPreset(parseCommonArgs([]), base);
    expect(args.skillsMode).toBe("manual");
    const withList = systemPromptFor({ ...parseCommonArgs([]), skillsMode: "auto" }, proj, {
      home,
      root: proj,
    });
    const without = systemPromptFor(args, proj, { home, root: proj });
    expect(withList.sections.some((s) => s.name === "Skills")).toBe(true);
    expect(without.sections.some((s) => s.name === "Skills")).toBe(false);
    expect(systemPromptFor(parseCommonArgs([]), proj, { home, root: proj }).text).not.toContain(
      "# Skills",
    );
    const path = join(proj, ".agents", "skills", "review", "SKILL.md");
    mkdirSync(join(proj, ".agents", "skills", "review"), { recursive: true });
    writeFileSync(path, "---\nname: review\ndescription: Review a patch\n---\nCheck the patch.");
    const refreshed = discoverSkills(proj, { home, root: proj });
    expect(automaticSkills(refreshed, { mode: "auto", include: "all" }).map((s) => s.name)).toEqual(
      ["deploy", "review"],
    );
    expect(
      automaticSkills(refreshed, { mode: "auto", include: ["deploy", "secret"] }).map(
        (s) => s.name,
      ),
    ).toEqual(["deploy"]);
    expect(automaticSkills(refreshed, { mode: "auto", include: [] })).toEqual([]);
    expect(automaticSkills(refreshed, { mode: "manual", include: "all", load: "tool" })).toEqual(
      [],
    );
    expect(skillsSection(refreshed, { mode: "auto", load: "tool" })).toBeUndefined();
    const preset: KernelConfig = {
      default: "m",
      providers: {},
      presets: { p: { prompt: { skills: { load: "tool" } } } },
    };
    expect(applyPreset(parseCommonArgs(["--preset", "p"]), preset).skillsLoad).toBe("tool");
    expect(() =>
      applyPreset(parseCommonArgs([]), {
        ...base,
        prompt: { skills: { list: "system" } },
      } as unknown as KernelConfig),
    ).toThrow("was removed");
  });
});

describe("界面里的技能", () => {
  it("勾选范围只改未来请求,全选保存意图,历史正文与自定义系统文本保留;恢复同一配置", async () => {
    const { home, proj } = project();
    const skills = discoverSkills(proj, { home, root: proj });
    skills.push({
      ...parseSkill("/x/review/SKILL.md", DEPLOY),
      name: "review",
      description: "Review a patch",
      body: "Check the patch.",
    });
    const log = new EventLog();
    const term = new VirtualTerminal(60, 28);
    const requests: { system: string; tools: string[]; description: string }[] = [];
    const app = createTuiApp({
      terminal: term,
      log,
      skills,
      tools: buildTools(),
      provider: {
        model: "m",
        async complete(messages, tools) {
          requests.push({
            system: String(messages.find((m) => m.role === "system")?.content),
            tools: tools.map((t) => t.name),
            description: tools.find((t) => t.name === "skill")?.description ?? "",
          });
          return { text: "ok", toolCalls: [], stopReason: "end" };
        },
      },
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: "m", providerName: "p", sessionFile: "s" },
      systemPrompt: "My exact base instructions.",
      onExit: () => {},
      onSetupChange: (setup) => recordSessionSetup(log, setup),
    });
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const menu = () => app.dialogLines().map(plain).join("\n");
    await app.command("/settings prompt.skills.include");
    app.dialogInput("\r");
    expect(menu()).toContain("All (including new skills)");
    expect(menu()).toContain("Manual mode");
    app.dialogInput("\x1b[B"); // deploy: 全选 -> 去掉 deploy 的具体名单
    app.dialogInput("\r");
    await tick();
    expect(restoreSessionSetup(log.events, {}).setup.values.prompt?.skills?.include).toEqual([
      "review",
    ]);
    app.dialogInput("i");
    expect(menu()).toContain("Ship a release");
    app.dialogInput("\x1b");
    app.dialogInput("\x1b[H");
    app.dialogInput("\r"); // 再全选,保存字符串而非现有名单
    await tick();
    expect(restoreSessionSetup(log.events, {}).setup.values.prompt?.skills?.include).toBe("all");
    app.dialogInput("\x1b");
    app.dialogInput("\x1b");
    app.dialogInput("\x1b");
    await app.command("/deploy staging");
    expect(requests[0]?.system).toBe("My exact base instructions.");
    expect(requests[0]?.tools).not.toContain("skill");
    await app.command("/settings prompt.skills.mode auto");
    await app.command("/settings prompt.skills.include review");
    await app.submit("continue");
    expect(requests.at(-1)?.system).toContain("- review:");
    expect(requests.at(-1)?.system).not.toContain("- deploy:");
    await app.command("/settings prompt.skills.load tool");
    await app.submit("continue");
    expect(requests.at(-1)?.system).toBe("My exact base instructions.");
    expect(requests.at(-1)?.tools).toContain("skill");
    expect(requests.at(-1)?.description).toContain("review");
    expect(requests.at(-1)?.description).not.toContain("deploy");
    const setup = restoreSessionSetup(log.events, {}).setup;
    const resumed = applyPreset(parseCommonArgs([]), {
      default: "m",
      providers: {},
      defaults: setup.values,
    });
    expect(resumed.skillsMode).toBe("auto");
    expect(resumed.skillsInclude).toEqual(["review"]);
    expect(resumed.skillsLoad).toBe("tool");
    await app.command("/settings prompt.skills.mode manual");
    await app.submit("continue");
    expect(requests.at(-1)?.tools).not.toContain("skill");
    expect(requests.at(-1)?.system).toBe("My exact base instructions.");
    expect(JSON.stringify(deriveMessages(log.events))).toContain("User request:\\nstaging");
    app.stop();
  });
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
          // 第一步:技能正文与用户要求都真实投递,而非仅显示在界面里。
          const last = messages.at(-1);
          expect(last?.role === "user" && last.content).toContain(
            "Deploy to $1. Full args: $ARGUMENTS",
          );
          expect(last?.role === "user" && last.content).toContain("User request:\nstaging");
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
    expect(user?.type === "user/message" && user.text).toContain("User request:\nstaging");
    expect(plain(app.lines(110).join("\n"))).toContain("skill /deploy");

    await app.command("/inspect skills");
    const doc = plain(app.lines(110).join("\n"));
    expect(doc).toContain("/deploy");
    expect(doc).toContain("allowed-tools: bash read");
    expect(doc).toContain("/secret");
    expect(doc).toContain("user-only");
    app.stop();
  });
});
