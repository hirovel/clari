// 模型登记簿:三级回退(models.dev → 抄最像的 → 假设)、缓存与超时、分歧提示;登录对话框与 /models 里可选并写进配置。
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ASSUMED_CONTEXT,
  closestConfigured,
  describeInferred,
  fetchRegistry,
  inferModelConfig,
  lookupModel,
  type Registry,
  registryDisagreement,
  registryProviderId,
} from "../cli/registry.js";
import { type LoginDeps, LoginDialog } from "../cli/tui-login.js";
import { addModel, type KernelConfig, type ProviderConfig } from "../src/config.js";
import { stripAnsi } from "./helpers/virtual-terminal.js";

const REG: Registry = {
  deepseek: {
    id: "deepseek",
    models: {
      "deepseek-v4-flash-vision-exp": {
        id: "deepseek-v4-flash-vision-exp",
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
        limit: { context: 1_000_000, output: 384_000 },
        cost: { input: 0.098, output: 0.196, cache_read: 0.028 },
      },
      "deepseek-v4-pro": {
        id: "deepseek-v4-pro",
        limit: { context: 1_000_000 },
        cost: { input: 1, output: 2 },
      },
    },
  },
  other: { models: { "some-model": { id: "some-model", limit: { context: 32000 } } } },
};

const DS: ProviderConfig = {
  protocol: "openai",
  baseUrl: "https://api.deepseek.com",
  models: [
    { name: "deepseek-v4-pro", contextWindow: 131072, price: { input: 1, output: 2 } },
    { name: "deepseek-v4-flash", contextWindow: 131072, effortLevels: ["low", "high"] },
  ],
};

describe("推导", () => {
  it("models.dev 命中:窗口、输出上限、强度档、价格都来自登记簿,出处 models.dev", () => {
    const inf = inferModelConfig("deepseek", DS, "deepseek-v4-flash-vision-exp", REG);
    expect(inf.source).toBe("models.dev");
    expect(inf.model).toEqual({
      name: "deepseek-v4-flash-vision-exp",
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      effortLevels: ["low", "high", "max"],
      price: { input: 0.098, output: 0.196, cacheRead: 0.028 },
    });
    expect(describeInferred(inf)).toBe("1M ctx · $0.098/$0.196 per 1M · models.dev");
  });

  it("登记簿没有:抄最长公共前缀的已配置模型(不带名字);没有相似的用假设窗口", () => {
    const copied = inferModelConfig("deepseek", DS, "deepseek-v4-flash-lite", undefined);
    expect(copied.source).toBe("copied from deepseek-v4-flash");
    expect(copied.model).toEqual({
      name: "deepseek-v4-flash-lite",
      contextWindow: 131072,
      effortLevels: ["low", "high"],
    });
    const assumed = inferModelConfig("deepseek", DS, "totally-new", undefined);
    expect(assumed.source).toBe("assumed 64k context");
    expect(assumed.model).toEqual({ name: "totally-new", contextWindow: ASSUMED_CONTEXT });
    expect(closestConfigured(DS, "deep")).toBeUndefined(); // 少于 6 个字符不算像
  });

  it("供应商 id 按 baseUrl 主机认;找不到直接命中就全库扫;分歧只在窗口不同时报", () => {
    expect(registryProviderId("mine", { baseUrl: "https://api.deepseek.com/v1" })).toBe("deepseek");
    expect(registryProviderId("relay", { baseUrl: "https://relay.example.com" })).toBe("relay");
    expect(lookupModel(REG, "relay", "some-model")?.limit?.context).toBe(32000);
    expect(registryDisagreement(REG, "deepseek", DS, "deepseek-v4-pro", 131072)).toBe(
      "config 128k · models.dev 1M",
    );
    expect(registryDisagreement(REG, "deepseek", DS, "deepseek-v4-flash", 131072)).toBeUndefined();
    expect(
      registryDisagreement(undefined, "deepseek", DS, "deepseek-v4-pro", 131072),
    ).toBeUndefined();
  });
});

describe("缓存", () => {
  it("新鲜缓存直接用;过期后联网并重写;联网失败退回旧缓存;没有缓存且失败返回 undefined", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clari-reg-"));
    const path = join(dir, "models.dev.json");
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return { ok: true, json: async () => ({ fresh: { models: {} } }) };
    }) as unknown as typeof fetch;
    expect(await fetchRegistry({ cachePath: path, fetchImpl })).toEqual({ fresh: { models: {} } });
    expect(calls).toBe(1);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ fresh: { models: {} } });
    expect(await fetchRegistry({ cachePath: path, fetchImpl })).toEqual({ fresh: { models: {} } });
    expect(calls).toBe(1); // 缓存新鲜,不联网
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    utimesSync(path, old, old);
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchRegistry({ cachePath: path, fetchImpl: failing })).toEqual({
      fresh: { models: {} },
    });
    const none = join(dir, "missing.json");
    expect(await fetchRegistry({ cachePath: none, fetchImpl: failing })).toBeUndefined();
    writeFileSync(none, "{not json");
    expect(await fetchRegistry({ cachePath: none, fetchImpl: failing })).toBeUndefined();
  });
});

describe("写进配置", () => {
  it("addModel 追加或替换同名模型并落盘;登录对话框里服务器多出来的模型可选,选中先写配置再切换", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clari-cfg-"));
    const path = join(dir, "config.json");
    const config: KernelConfig = {
      default: "deepseek/deepseek-v4-pro",
      providers: { deepseek: DS },
    };
    const next = addModel(
      config,
      "deepseek",
      { name: "deepseek-v4-flash-vision-exp", contextWindow: 1_000_000 },
      path,
    );
    expect(
      next.providers.deepseek?.models.map((m) => (typeof m === "string" ? m : m.name)),
    ).toEqual(["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"]);
    const again = addModel(
      next,
      "deepseek",
      { name: "deepseek-v4-pro", contextWindow: 1_000_000 },
      path,
    );
    expect(again.providers.deepseek?.models).toHaveLength(3);
    expect(JSON.parse(readFileSync(path, "utf8")).providers.deepseek.models).toHaveLength(3);
    expect(() => addModel(config, "nope", { name: "x" }, path)).toThrow('unknown provider "nope"');

    const calls: string[] = [];
    const deps: LoginDeps = {
      providers: () => [{ name: "deepseek", protocol: "openai", models: ["deepseek-v4-pro"] }],
      verifyKey: async () => ["deepseek-v4-pro", "deepseek-v4-flash-vision-exp"],
      setKey: () => {},
      describeModel: async (p, m) => inferModelConfig(p, DS, m, REG),
      addModel: (p, m) => calls.push(`add:${p}/${m.name}:${m.contextWindow}`),
      useModel: (name) => calls.push(`use:${name}`),
      onDone: () => calls.push("done"),
      onChange: () => {},
    };
    const dlg = new LoginDialog(deps, { provider: "deepseek" });
    dlg.handleInput("sk-x");
    dlg.handleInput("\r");
    for (let i = 0; i < 20 && !stripAnsi(dlg.render().join("\n")).includes("key saved"); i++)
      await new Promise((r) => setTimeout(r, 5));
    const out = stripAnsi(dlg.render().join("\n"));
    expect(out).toContain(
      "deepseek-v4-flash-vision-exp  not in config · 1M ctx · $0.098/$0.196 per 1M · models.dev",
    );
    dlg.handleInput("\x1b[B");
    dlg.handleInput("\r");
    expect(calls).toEqual([
      "add:deepseek/deepseek-v4-flash-vision-exp:1000000",
      "use:deepseek/deepseek-v4-flash-vision-exp",
      "done",
    ]);
  });
});
