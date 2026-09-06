// 内核与工具的低分支(重构块 7):配置文件的每种坏形态与写回、模型解析的猜测与报错、key 的三条路;
// bash 的 shell 不可用 / 打断 / 非零退出 / 截断落盘;grep 的 rg 路径与 JS 回退、glob 上限;参数解析的每个开关。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyPreset, parseCommonArgs, resolveApproval } from "../cli/args.js";
import { createBashTool } from "../cli/tools/bash.js";
import { createGrepTool, globTool, grepFiles, walkFiles } from "../cli/tools/search.js";
import { keepTail } from "../cli/tools/truncate.js";
import { DEFAULT_APPROVAL } from "../src/approval.js";
import {
  CONFIG_TEMPLATE,
  createProvider,
  type KernelConfig,
  loadConfig,
  resolveApiKey,
  resolveModel,
  setApiKey,
  setDefaultModel,
} from "../src/config.js";

const ctx = (signal = new AbortController().signal) => ({ signal }) as never;

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
  delete process.env.CLARI_SHELL;
});

const base: KernelConfig = {
  default: "m",
  providers: {
    fake: { protocol: "openai", baseUrl: "http://x/v1", apiKeyEnv: "FAKE_KEY", models: ["m"] },
  },
};

describe("配置文件", () => {
  it("不存在就写模板并标 created;再读不标;坏 JSON 报路径;四种缺字段各自报错", () => {
    tmp = mkdtempSync(join(tmpdir(), "clari-cfg-"));
    const path = join(tmp, "deep", "config.json");
    const first = loadConfig(path);
    expect(first.created).toBe(true);
    expect(first.config.default).toBe(CONFIG_TEMPLATE.default);
    expect(existsSync(path)).toBe(true);
    expect(loadConfig(path).created).toBe(false);
    writeFileSync(path, "{ not json");
    expect(() => loadConfig(path)).toThrow(/failed to parse config .*config\.json/);
    const bad = (obj: unknown, message: RegExp) => {
      writeFileSync(path, JSON.stringify(obj));
      expect(() => loadConfig(path)).toThrow(message);
    };
    bad({ providers: {} }, /missing default or providers/);
    bad({ default: "m" }, /missing default or providers/);
    bad(
      { default: "m", providers: { p: { protocol: "grpc", baseUrl: "x", models: [] } } },
      /protocol must be/,
    );
    bad(
      { default: "m", providers: { p: { protocol: "openai", models: [] } } },
      /missing baseUrl or models/,
    );
    bad(
      { default: "m", providers: { p: { protocol: "openai", baseUrl: "x", models: [42] } } },
      /models entries/,
    );
  });

  it("setApiKey 写回并去空白,未知供应商报错列出选项;setDefaultModel 写回", () => {
    tmp = mkdtempSync(join(tmpdir(), "clari-cfg-"));
    const path = join(tmp, "config.json");
    expect(() => setApiKey(base, "nope", "k", path)).toThrow(
      /unknown provider "nope"; options: fake/,
    );
    const next = setApiKey(base, "fake", "  sk-1  ", path);
    expect(next.providers.fake?.apiKey).toBe("sk-1");
    expect(JSON.parse(readFileSync(path, "utf8")).providers.fake.apiKey).toBe("sk-1");
    const withDefault = setDefaultModel(next, "fake/other", path);
    expect(withDefault.default).toBe("fake/other");
    expect(JSON.parse(readFileSync(path, "utf8")).default).toBe("fake/other");
  });
});

describe("模型解析与 key", () => {
  const cfg: KernelConfig = {
    default: "deepseek-v4-pro",
    providers: {
      deepseek: {
        protocol: "openai",
        baseUrl: "https://api.deepseek.com",
        models: ["deepseek-v4-pro"],
        extraBody: { a: 1 },
        contextWindow: 100,
      },
      anthropic: {
        protocol: "anthropic",
        baseUrl: "https://api.anthropic.com",
        models: [
          { name: "claude-x", maxTokens: 5, price: { input: 1, output: 2 }, extraBody: { b: 2 } },
        ],
        thinkingMode: "adaptive",
        promptCache: false,
        stallTimeoutMs: 0,
        retry: { maxRetries: 1 },
        extraHeaders: { "x-h": "1" },
      },
      openai: {
        protocol: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        models: [],
        reasoningSummary: "auto",
      },
    },
  };

  it("显式 供应商/模型;未知供应商报错;按前缀猜到 anthropic / deepseek / openai;猜不到列出全部", () => {
    expect(resolveModel(cfg, "anthropic/claude-y").model).toBe("claude-y");
    expect(() => resolveModel(cfg, "nope/x")).toThrow(/unknown provider "nope"/);
    expect(resolveModel(cfg, "claude-z").providerName).toBe("anthropic");
    expect(resolveModel(cfg, "deepseek-new").providerName).toBe("deepseek");
    expect(resolveModel(cfg, "gpt-9").providerName).toBe("openai");
    expect(resolveModel(cfg, "o5-mini").providerName).toBe("openai");
    expect(() => resolveModel(cfg, "llama")).toThrow(
      /no provider matches model "llama"[\s\S]*deepseek\/deepseek-v4-pro/,
    );
  });

  it("finish 合并:模型级 maxTokens / price / extraBody 与供应商级 extraBody、thinkingMode;窗口回落 128000", () => {
    const r = resolveModel(cfg, "anthropic/claude-x");
    expect(r).toMatchObject({
      maxTokens: 5,
      price: { input: 1, output: 2 },
      extraBody: { b: 2 },
      thinkingMode: "adaptive",
      contextWindow: 128000,
    });
    expect(resolveModel(cfg, "deepseek-v4-pro")).toMatchObject({
      extraBody: { a: 1 },
      contextWindow: 100,
    });
    expect(resolveModel(cfg, "openai/gpt-9").extraBody).toBeUndefined();
  });

  it("key:配置字段去空白优先;其次环境变量;缺失时的提示分两种写法", () => {
    const p = cfg.providers.deepseek as NonNullable<KernelConfig["providers"]["x"]>;
    expect(resolveApiKey("deepseek", { ...p, apiKey: " k1 " }, {})).toBe("k1");
    expect(resolveApiKey("deepseek", { ...p, apiKeyEnv: "K" }, { K: " k2 " })).toBe("k2");
    expect(() => resolveApiKey("deepseek", { ...p, apiKeyEnv: "K" }, {})).toThrow(
      /env var K, or providers\.deepseek\.apiKey/,
    );
    expect(() => resolveApiKey("deepseek", p, {})).toThrow(
      /providers\.deepseek\.apiKey or apiKeyEnv/,
    );
  });

  it("createProvider:三种协议各自带上供应商级选项;手工 Resolved 回落到供应商字段", () => {
    const a = createProvider(resolveModel(cfg, "anthropic/claude-x"), "k");
    expect(a.model).toBe("claude-x");
    expect(a.fields?.protocol.startsWith("anthropic")).toBe(true);
    const o = createProvider(resolveModel(cfg, "openai/gpt-9"), "k");
    expect(o.fields?.protocol).toContain("responses");
    const d = createProvider(
      {
        providerName: "deepseek",
        provider: cfg.providers.deepseek as never,
        model: "x",
        contextWindow: 1,
      },
      "k",
    );
    expect(d.model).toBe("x");
    expect(d.fields?.protocol.startsWith("openai")).toBe(true);
  });
});

describe("bash 工具的其它边界", () => {
  it("CLARI_SHELL 指向不存在的程序 → 启动失败报错;非零退出带输出;无输出说明;截断落盘", async () => {
    process.env.CLARI_SHELL = join(tmpdir(), "no-such-shell-xyz.exe");
    const broken = createBashTool();
    await expect(broken.execute({ command: "echo hi" }, ctx())).rejects.toThrow();
    delete process.env.CLARI_SHELL;
    const tool = createBashTool({ truncate: keepTail({ maxLines: 3 }) });
    await expect(tool.execute({ command: "echo out; exit 3" }, ctx())).rejects.toThrow(
      /out[\s\S]*exited with code 3/,
    );
    expect(await tool.execute({ command: "true" }, ctx())).toBe("(no output)");
    const spilled = await tool.execute({ command: "printf 'a\\nb\\nc\\nd\\n'" }, ctx());
    expect(spilled).toContain("c\nd");
    expect(spilled).not.toContain("a\nb");
    const file = spilled.match(/Full output: (.+)\]/)?.[1];
    expect(file && readFileSync(file, "utf8")).toBe("a\nb\nc\nd\n");
    expect(await tool.execute({ command: "echo unlimited", timeout: 0 }, ctx())).toBe("unlimited");
  }, 20000);

  it("打断:signal 中止 → 杀进程,错误里带已产出的输出", async () => {
    const tool = createBashTool();
    const ac = new AbortController();
    const pending = tool.execute({ command: "echo started; sleep 5; echo late" }, ctx(ac.signal));
    setTimeout(() => ac.abort(), 300);
    await expect(pending).rejects.toThrow(/command interrupted[\s\S]*started/);
  }, 20000);
});

describe("搜索工具的回退与上限", () => {
  it("walkFiles:不存在的根为空,maxFiles 截断;grepFiles:根是文件、glob 按文件名过滤、二进制跳过", () => {
    tmp = mkdtempSync(join(tmpdir(), "clari-search-"));
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "a.ts"), "needle here\nother");
    writeFileSync(join(tmp, "src", "b.md"), "needle too");
    writeFileSync(join(tmp, "bin.dat"), Buffer.from([0x6e, 0x65, 0x00, 0x64]));
    expect(walkFiles(join(tmp, "missing"))).toEqual([]);
    expect(walkFiles(tmp, { maxFiles: 2 })).toHaveLength(2);
    const one = grepFiles(join(tmp, "src", "a.ts"), /needle/);
    expect(one.matches).toEqual([{ file: join(tmp, "src", "a.ts"), line: 1, text: "needle here" }]);
    const byName = grepFiles(tmp, /needle/, { glob: "*.md" });
    expect(byName.matches.map((m) => m.file)).toEqual(["src/b.md"]);
    const all = grepFiles(tmp, /ne/);
    expect(all.matches.map((m) => m.file).sort()).toEqual(["src/a.ts", "src/b.md"]);
    expect(all.scanned).toBe(2);
  });

  const hasRg = spawnSync("rg", ["--version"]).status === 0;

  it.skipIf(!hasRg)(
    "grep 工具走 rg:路径前缀、无匹配、ignoreCase;非法正则落到 JS 回退并报错",
    async () => {
      tmp = mkdtempSync(join(tmpdir(), "clari-search-"));
      mkdirSync(join(tmp, "src"));
      writeFileSync(join(tmp, "src", "a.ts"), "Needle here\nneedle again");
      const rg = createGrepTool({ useRipgrep: true });
      const out = await rg.execute({ pattern: "needle", path: tmp, ignoreCase: true }, ctx());
      expect(out).toContain("a.ts:1:Needle here");
      expect(out).toContain("a.ts:2:needle again");
      const inFile = await rg.execute({ pattern: "again", path: join(tmp, "src", "a.ts") }, ctx());
      expect(inFile).toContain(":2:needle again");
      expect(await rg.execute({ pattern: "zzz", path: tmp }, ctx())).toBe("(no matches)");
      await expect(rg.execute({ pattern: "(", path: tmp }, ctx())).rejects.toThrow();
    },
  );

  it("grep 工具 JS 回退:ignoreCase、根是文件时的前缀、结果上限、非法正则报错、rg 不在时自动回退", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clari-search-"));
    mkdirSync(join(tmp, "src"));
    writeFileSync(join(tmp, "src", "a.ts"), "Needle here\nneedle again");
    const js = createGrepTool({ useRipgrep: false, maxResults: 1 });
    const capped = await js.execute({ pattern: "needle", path: tmp, ignoreCase: true }, ctx());
    expect(capped).toContain("a.ts:1:Needle here");
    expect(capped).toContain("showing first 1 results");
    const inFile = await js.execute({ pattern: "again", path: join(tmp, "src", "a.ts") }, ctx());
    expect(inFile).toContain(":2:needle again");
    await expect(js.execute({ pattern: "(", path: tmp }, ctx())).rejects.toThrow();
    const auto = createGrepTool({ useRipgrep: true });
    expect(await auto.execute({ pattern: "zzz", path: tmp }, ctx())).toMatch(/no matches/);
  });

  it("glob 工具:无匹配说明;超过 500 条截断", async () => {
    tmp = mkdtempSync(join(tmpdir(), "clari-glob-"));
    for (let i = 0; i < 501; i++) writeFileSync(join(tmp, `f${i}.txt`), "");
    expect(await globTool.execute({ pattern: "*.md", path: tmp }, ctx())).toBe("(no matches)");
    const out = await globTool.execute({ pattern: "*.txt", path: tmp }, ctx());
    expect(out).toContain("[showing first 500 of 501 results]");
    expect(out.split("\n")).toHaveLength(501);
  });
});

describe("参数解析的每个开关", () => {
  it("每个选项落到字段;非法值各自报错;-h", () => {
    tmp = mkdtempSync(join(tmpdir(), "clari-args-"));
    const a = parseCommonArgs([
      "--resume",
      "s.jsonl",
      "--system-prompt",
      "sys.md",
      "--append-system-prompt",
      "more.md",
      "--subagent",
      "--no-trace",
      "--fold",
      "--steering",
      "turn",
      "--preservation",
      "ratio 0.2",
      "--approve",
      "ask",
      "--tool-prompts",
      "brief",
      "--preset",
      "fast",
      "--memory",
      "--prompt-sections",
      "role, env",
      "--instructions-as",
      "user",
      "--execution",
      "parallel",
      "--extension",
      "a.mjs",
      "--extension",
      "b.mjs",
      "--events",
      "-h",
    ]);
    expect(a).toMatchObject({
      resume: "s.jsonl",
      systemPromptFile: "sys.md",
      appendSystemPromptFile: "more.md",
      subagent: true,
      subagentExplicit: true,
      trace: false,
      traceExplicit: true,
      fold: true,
      foldExplicit: true,
      steering: "turn",
      preservation: "ratio 0.2",
      approve: "ask",
      approveExplicit: true,
      toolPrompts: "brief",
      preset: "fast",
      memory: true,
      promptSections: ["role", "env"],
      instructionsAs: "user",
      execution: "parallel",
      extensions: ["a.mjs", "b.mjs"],
      events: true,
      help: true,
    });
    expect(parseCommonArgs(["--no-memory"]).memory).toBe(false);
    expect(() => parseCommonArgs(["--prompt-sections", "role,bogus"])).toThrow(
      /unknown prompt section "bogus"/,
    );
    expect(() => parseCommonArgs(["--instructions-as", "sideways"])).toThrow(
      /accepts system or user/,
    );
    expect(() => parseCommonArgs(["--execution", "fast"])).toThrow(
      /accepts sequential or parallel/,
    );
    expect(() => parseCommonArgs(["--approve", "maybe"])).toThrow(/accepts all, ask or policy/);
    expect(() => parseCommonArgs(["--preservation", "ratio 9"])).toThrow(/between 0 and 1/);
    expect(() => parseCommonArgs(["--preservation", "tokens 0"])).toThrow(/must be positive/);
  });

  it("applyPreset:未知预设、非法 effort 报错;预设的文件、扩展、maxSteps、审批规则、prompt.sections 都套上;resolveApproval 三级回落", () => {
    const config: KernelConfig = {
      ...base,
      prompt: { sections: ["role", "env"] },
      approval: { default: "ask", allow: ["read"] },
      presets: {
        p: {
          effort: "high",
          systemPromptFile: "sys.md",
          appendSystemPromptFile: "add.md",
          extensions: ["x.mjs"],
          maxSteps: 3,
          approval: { default: "allow" },
          subagent: true,
        },
        bad: { effort: "ultra" },
      },
    };
    expect(() => applyPreset(parseCommonArgs(["--preset", "nope"]), config)).toThrow(
      /no preset "nope" in config; choices: p bad/,
    );
    expect(() => applyPreset(parseCommonArgs(["--preset", "bad"]), config)).toThrow(
      /invalid effort "ultra"/,
    );
    const out = applyPreset(parseCommonArgs(["--preset", "p"]), config);
    expect(out).toMatchObject({
      effort: "high",
      systemPromptFile: "sys.md",
      appendSystemPromptFile: "add.md",
      extensions: ["x.mjs"],
      maxSteps: 3,
      approval: { default: "allow" },
      subagent: true,
      promptSections: ["role", "env"],
    });
    expect(resolveApproval(parseCommonArgs(["--approve", "ask"]), config)).toBe("ask");
    expect(resolveApproval({ ...out, approve: "policy" }, config)).toEqual({ default: "allow" });
    expect(resolveApproval(parseCommonArgs(["--approve", "policy"]), config)).toEqual({
      default: "ask",
      allow: ["read"],
    });
    expect(resolveApproval(parseCommonArgs(["--approve", "policy"]), base)).toBe(DEFAULT_APPROVAL);
  });
});
