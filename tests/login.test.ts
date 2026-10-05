// 登录对话框:没有 key 也进界面,选供应商、贴 key(遮罩)、验证、选模型;/login 与 /model 的列表选择。

import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { noProviderChoice } from "../cli/bootstrap.js";
import type { ModelSettings, ProviderSummary } from "../cli/model-settings.js";
import { createTuiApp, type TuiApp } from "../cli/tui-app.js";
import { type LoginDeps, LoginDialog } from "../cli/tui-login.js";
import { EventLog } from "../src/log.js";
import type { Provider } from "../src/provider.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

const plain = (lines: string[]) => lines.map(stripAnsi).join("\n");
const tick = () => new Promise((r) => setTimeout(r, 5));

const PROVIDERS: ProviderSummary[] = [
  {
    name: "deepseek",
    protocol: "openai",
    env: "DEEPSEEK_API_KEY",
    models: ["deepseek-v4-pro", "deepseek-v4-flash"],
  },
  {
    name: "anthropic",
    protocol: "anthropic",
    env: "ANTHROPIC_API_KEY",
    keySource: "env",
    models: ["claude-sonnet-5"],
  },
];

function fakeDeps(overrides: Partial<LoginDeps> = {}) {
  const calls: string[] = [];
  const deps: LoginDeps = {
    providers: () => PROVIDERS,
    verifyKey: async (p, k) => {
      calls.push(`verify:${p}:${k}`);
      if (k === "bad") throw new Error("provider 401: invalid api key");
      return ["deepseek-v4-pro", "deepseek-v4-lite"];
    },
    setKey: (p, k) => calls.push(`set:${p}:${k}`),
    useModel: (name, d) => calls.push(`use:${name}:${d}`),
    onDone: () => calls.push("done"),
    onChange: () => {},
    ...overrides,
  };
  return { deps, calls };
}

describe("LoginDialog", () => {
  it("供应商列表 → 贴 key(遮罩只露尾四位)→ 验证 → 选模型和使用范围", async () => {
    const { deps, calls } = fakeDeps();
    const dlg = new LoginDialog(deps);
    let out = plain(dlg.render());
    expect(out).toContain("Set up a provider");
    expect(out).toContain("› 1. deepseek");
    expect(out).toContain("no key");
    expect(out).toContain("anthropic");
    expect(out).toContain("key: env");
    // 数字键直接跳到该行;再按回到第 1 项
    dlg.handleInput("2");
    expect(plain(dlg.render())).toContain("› 2. anthropic");
    dlg.handleInput("1");
    dlg.handleInput("\r");
    out = plain(dlg.render());
    expect(out).toContain("paste the API key");
    // 括号粘贴一次进来,再补一个字符;屏幕上只有点与尾四位
    dlg.handleInput("\x1b[200~sk-abcdef12345\x1b[201~");
    dlg.handleInput("6");
    out = plain(dlg.render());
    expect(out).toContain("•••••••••••3456");
    expect(out).not.toContain("sk-abc");
    dlg.handleInput("\x7f"); // 退格
    expect(plain(dlg.render())).toContain("••••••••••2345");
    dlg.handleInput("\r");
    expect(plain(dlg.render())).toContain("checking the key");
    await tick();
    out = plain(dlg.render());
    expect(calls).toContain("verify:deepseek:sk-abcdef12345");
    expect(calls).toContain("set:deepseek:sk-abcdef12345");
    expect(out).toContain("key saved · 2 models on the server");
    expect(out).toContain("deepseek-v4-pro");
    expect(out).toContain("deepseek-v4-flash");
    expect(out).toContain("not on the server");
    expect(out).toContain("deepseek-v4-lite");
    expect(out).toContain("not in config");
    dlg.handleInput("\x1b[B"); // 到 flash
    dlg.handleInput("\x1b[B"); // lite 不可选,跳回 pro
    dlg.handleInput("d");
    expect(calls.some((call) => call.startsWith("use:"))).toBe(false);
    dlg.handleInput("\r");
    expect(plain(dlg.render())).toContain("Use and save as default");
    dlg.handleInput("\x1b[B");
    dlg.handleInput("\r");
    expect(calls.at(-2)).toBe("use:deepseek/deepseek-v4-pro:true");
    expect(calls.at(-1)).toBe("done");
    const models = Array.from({ length: 35 }, (_, i) => `local-model-${i + 1}`);
    const chosen: string[] = [];
    let failSelection = true;
    let height = 18;
    const { deps: manyDeps } = fakeDeps({
      providers: () =>
        Array.from({ length: 35 }, (_, i) => ({
          name: `local-provider-${i + 1}`,
          protocol: "openai",
          models,
        })),
      verifyKey: async () => models,
      useModel: (name) => {
        if (failSelection)
          throw new Error(
            `${"Model switch failed; check the provider configuration. ".repeat(15)}END-ERROR`,
          );
        chosen.push(name);
      },
      height: () => height,
    });
    const many = new LoginDialog(manyDeps);
    for (let i = 0; i < 30; i++) many.handleInput("\x1bOB");
    const providerLines = many.render(40);
    expect(plain(providerLines)).toContain("Selected 31/35");
    expect(plain(providerLines)).toContain("Esc close");
    expect(providerLines.length).toBeLessThanOrEqual(16);
    expect(providerLines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    many.handleInput("\r");
    many.handleInput("local-fixture");
    many.handleInput("\r");
    await tick();
    for (let i = 0; i < 30; i++) many.handleInput("\x1bOB");
    const modelLines = many.render(40);
    expect(plain(modelLines)).toContain("Selected 31/35");
    expect(modelLines.length).toBeLessThanOrEqual(16);
    expect(modelLines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    many.handleInput("\r");
    many.handleInput("\r");
    expect(plain(many.render(40))).toContain("Model switch failed");
    for (let i = 0; i < 50; i++) {
      many.handleInput("\x1b[6~");
      many.render(40);
    }
    expect(plain(many.render(40))).toContain("END-ERROR");
    height = 8;
    const tiny = many.render(24);
    expect(tiny.length).toBeLessThanOrEqual(6);
    expect(plain(tiny)).toContain("Esc back");
    failSelection = false;
    many.handleInput("\r");
    expect(chosen).toEqual(["local-provider-31/local-model-31"]);
  });

  it("验证可取消,迟到结果不保存;保存失败留在输入步显示错误", async () => {
    let finish = (_models: string[]) => {};
    let checkingSignal: AbortSignal | undefined;
    const { deps, calls } = fakeDeps({
      verifyKey: (_provider, _key, signal) => {
        checkingSignal = signal;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    const dialog = new LoginDialog(deps, { provider: "deepseek" });
    dialog.handleInput("local-fixture");
    dialog.handleInput("\r");
    dialog.handleInput("\x1b");
    expect(checkingSignal?.aborted).toBe(true);
    expect(plain(dialog.render())).toContain("paste the API key");
    finish(["deepseek-v4-pro"]);
    await tick();
    expect(calls.some((call) => call.startsWith("set:"))).toBe(false);
    const failed = new LoginDialog(
      fakeDeps({
        setKey() {
          throw new Error("Fixture disk unavailable");
        },
      }).deps,
      { provider: "deepseek" },
    );
    failed.handleInput("local-fixture");
    failed.handleInput("\r");
    await tick();
    expect(plain(failed.render())).toContain("Fixture disk unavailable");
    expect(plain(failed.render())).toContain("paste the API key");
    const key = "local-fixture-".repeat(20);
    const longError = new LoginDialog(
      fakeDeps({
        height: () => 12,
        verifyKey: async () => {
          throw new Error(`${key} ${"Network failure details. ".repeat(30)}END-ERROR`, {
            cause: Object.assign(new Error("Private diagnostic content"), { code: "ENOTFOUND" }),
          });
        },
      }).deps,
      { provider: "deepseek" },
    );
    longError.handleInput(key);
    expect(longError.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
    longError.handleInput("\r");
    await tick();
    let received = "";
    for (let i = 0; i < 100; i++) {
      const lines = longError.render(40);
      expect(lines.length).toBeLessThanOrEqual(10);
      expect(lines.every((line) => visibleWidth(line) <= 40)).toBe(true);
      received += plain(lines);
      longError.handleInput("\x1b[6~");
    }
    expect(received).toContain("END-ERROR");
    expect(received).toContain("[redacted]");
    expect(received).toContain("[ENOTFOUND]");
    expect(received).not.toContain("Private diagnostic content");
    expect(received).not.toContain("local-fixture");
    expect(received).toContain("Esc back");
    longError.handleInput("\x13");
    expect(plain(longError.render(40))).toContain("not verified");
    expect(plain(longError.render(40))).toContain("deepseek-v4-pro");
  });

  it("key 无效:留在输入步并显示原因;空 key 不发请求;Esc 退回供应商列表;列表上 Esc 关闭", async () => {
    const { deps, calls } = fakeDeps();
    const dlg = new LoginDialog(deps, { provider: "deepseek" });
    expect(plain(dlg.render())).toContain("paste the API key");
    dlg.handleInput("\r");
    expect(plain(dlg.render())).toContain("the key is empty");
    expect(calls.filter((x) => x.startsWith("verify"))).toHaveLength(0);
    dlg.handleInput("bad");
    dlg.handleInput("\r");
    await tick();
    const out = plain(dlg.render());
    expect(out).toContain("✗ provider 401: invalid api key");
    expect(out).toContain("•••");
    expect(calls.some((x) => x.startsWith("set:"))).toBe(false);
    expect(out).toContain("Ctrl+S save without verification");
    dlg.handleInput("new");
    dlg.handleInput("\x13");
    expect(calls.some((x) => x.startsWith("set:"))).toBe(false);
    dlg.handleInput("\x1b");
    expect(plain(dlg.render())).toContain("Set up a provider");
    dlg.handleInput("\x1b");
    expect(calls.at(-1)).toBe("done");
  });
});

describe("没有 key 的界面", () => {
  function boot(settings: ModelSettings, unavailable?: string) {
    const log = new EventLog();
    const none = noProviderChoice();
    const term = new VirtualTerminal(110, 40);
    const app = createTuiApp({
      terminal: term,
      log,
      provider: none.provider,
      tools: [],
      compaction: { strategy: async () => null, window: 100000, reserveTokens: 1000 },
      reserveTokens: 1000,
      info: { model: none.model, providerName: none.providerName, sessionFile: "s" },
      systemPrompt: "sys",
      settings,
      onExit: () => {},
      ...(unavailable && { unavailable }),
    });
    return { app, log, term };
  }
  const doc = (app: TuiApp) => plain(app.lines(110));

  it("启动即弹登录对话框;发消息被拦住并重新打开;走完流程后模型切过去", async () => {
    const calls: string[] = [];
    let failSwitch = false;
    const real: Provider = {
      model: "deepseek-v4-pro",
      async complete() {
        return { text: "hello from the real model", toolCalls: [], stopReason: "end" };
      },
    };
    const settings: ModelSettings = {
      listModels: () => ["deepseek/deepseek-v4-pro"],
      switchModel: (name) => {
        if (failSwitch) throw new Error("Fixture model switch unavailable");
        calls.push(`switch:${name}`);
        return {
          provider: real,
          model: "deepseek-v4-pro",
          providerName: "deepseek",
          contextWindow: 128000,
        };
      },
      setKey: (p, k) => calls.push(`set:${p}:${k}`),
      setDefault: (m) => calls.push(`default:${m}`),
      providers: () => PROVIDERS,
      verifyKey: async () => ["deepseek-v4-pro"],
    };
    const { app, log, term } = boot(settings, "no API key for provider deepseek");
    expect(doc(app)).toContain("no model");
    expect(plain(app.dialogLines())).toContain("Set up a provider");
    app.dialogInput("\x1b");
    expect(app.dialogLines()).toEqual([]);

    await app.submit("hi");
    expect(doc(app)).toContain("no provider yet: add an API key first");
    expect(log.events.some((e) => e.type === "user/message")).toBe(false);
    expect(plain(app.dialogLines())).toContain("Set up a provider");

    app.dialogInput("\r");
    app.dialogInput("sk-live-key");
    app.dialogInput("\r");
    for (let i = 0; i < 20 && !plain(app.dialogLines()).includes("key saved"); i++) await tick();
    failSwitch = true;
    app.dialogInput("\r");
    app.dialogInput("\r");
    expect(plain(app.dialogLines())).toContain("Model switch failed");
    failSwitch = false;
    app.dialogInput("\r");
    expect(calls).toEqual(["set:deepseek:sk-live-key", "switch:deepseek/deepseek-v4-pro"]);
    expect(app.dialogLines()).toEqual([]);
    expect(doc(app)).toContain("key for deepseek saved to the credentials file");
    expect(doc(app)).toContain("deepseek-v4-pro");
    expect(log.events.some((e) => e.type === "session/model")).toBe(true);

    // 当前模型已切换时,缺省值写盘失败不能把登录留在“切换失败”状态。
    settings.setDefault = () => {
      throw new Error("Fixture defaults read-only");
    };
    await app.command("/login deepseek");
    term.feed("local-fixture");
    term.feed("\r");
    await tick();
    term.feed("d");
    expect(app.dialogLines().length).toBeGreaterThan(0);
    term.feed("\r");
    term.feed("\x1b[B");
    term.feed("\r");
    expect(app.dialogLines()).toEqual([]);
    expect(app.agent.provider.model).toBe("deepseek-v4-pro");
    expect(doc(app)).toContain("default could not be saved");
    expect(doc(app)).toContain("/model default");
    settings.setDefault = (m) => calls.push(`default:${m}`);
    await app.command("/model default");
    expect(calls.at(-1)).toBe("default:deepseek/deepseek-v4-pro");

    await app.submit("hi again");
    expect(doc(app)).toContain("hello from the real model");
    settings.verifyKey = async () => {
      throw new Error("Fixture catalog unavailable");
    };
    await app.command("/login deepseek");
    term.feed("local-unverified");
    term.feed("\r");
    await tick();
    expect(plain(app.dialogLines())).toContain("Ctrl+S");
    term.feed("\x13");
    expect(plain(app.dialogLines())).toContain("not verified");
    expect(calls.at(-1)).toBe("set:deepseek:local-unverified");
    term.feed("\r");
    term.feed("\r");
    expect(app.dialogLines()).toEqual([]);
    app.stop();
  });

  it("/login anthropic 直接进该供应商的输入步;占位 provider 的请求失败并指向 /login", async () => {
    let finish = (_models: string[]) => {};
    const saved: string[] = [];
    const settings: ModelSettings = {
      listModels: () => [],
      switchModel: () => {
        throw new Error("n/a");
      },
      setKey: (provider) => {
        saved.push(provider);
      },
      setDefault: () => {},
      providers: () => PROVIDERS,
      verifyKey: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    };
    const { app, term } = boot(settings);
    await app.command("/login anthropic");
    const out = plain(app.dialogLines());
    expect(out).toContain("anthropic");
    expect(out).toContain("paste the API key");
    app.dialogInput("\x1b");
    app.dialogInput("\x1b");
    expect(app.dialogLines()).toEqual([]);
    await app.command("/login anthropic");
    app.dialogInput("local-fixture");
    app.dialogInput("\r");
    term.feed("\x0b"); // 用全局快捷键关闭验证中的视图。
    finish(["claude-sonnet-5"]);
    await tick();
    expect(saved).toEqual([]);
    expect(app.dialogLines()).toEqual([]);
    const none = noProviderChoice();
    await expect(none.provider.complete([], [])).rejects.toThrow("Run /login to add an API key");
    app.stop();
  });
});
