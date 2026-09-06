// 登录对话框:没有 key 也进界面,选供应商、贴 key(遮罩)、验证、选模型;/login 与 /model 的列表选择。
import { describe, expect, it } from "vitest";
import { noProviderChoice } from "../cli/bootstrap.js";
import { createTuiApp, type TuiApp, type TuiSettings } from "../cli/tui-app.js";
import { type LoginDeps, LoginDialog, type ProviderSummary } from "../cli/tui-login.js";
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
  it("供应商列表 → 贴 key(遮罩只露尾四位)→ 验证 → 选模型;d 同时设缺省", async () => {
    const { deps, calls } = fakeDeps();
    const dlg = new LoginDialog(deps);
    let out = plain(dlg.render());
    expect(out).toContain("Set up a provider");
    expect(out).toContain("▸ 1. deepseek");
    expect(out).toContain("key: missing");
    expect(out).toContain("anthropic");
    expect(out).toContain("key: set (env)");
    // 数字键直接跳到该行;再按回到第 1 项
    dlg.handleInput("2");
    expect(plain(dlg.render())).toContain("▸ 2. anthropic");
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
    expect(out).toContain("configured");
    expect(out).toContain("deepseek-v4-flash");
    expect(out).toContain("not on the server");
    expect(out).toContain("deepseek-v4-lite");
    expect(out).toContain("on the server, not in config");
    dlg.handleInput("\x1b[B"); // 到 flash
    dlg.handleInput("\x1b[B"); // lite 不可选,跳回 pro
    dlg.handleInput("d");
    expect(calls.at(-2)).toBe("use:deepseek/deepseek-v4-pro:true");
    expect(calls.at(-1)).toBe("done");
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
    dlg.handleInput("\x1b");
    expect(plain(dlg.render())).toContain("Set up a provider");
    dlg.handleInput("\x1b");
    expect(calls.at(-1)).toBe("done");
  });
});

describe("没有 key 的界面", () => {
  function boot(settings: TuiSettings, unavailable?: string) {
    const log = new EventLog();
    const none = noProviderChoice();
    const app = createTuiApp({
      terminal: new VirtualTerminal(110, 40),
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
    return { app, log };
  }
  const doc = (app: TuiApp) => plain(app.lines(110));

  it("启动即弹登录对话框;发消息被拦住并重新打开;走完流程后模型切过去", async () => {
    const calls: string[] = [];
    const real: Provider = {
      model: "deepseek-v4-pro",
      async complete() {
        return { text: "hello from the real model", toolCalls: [], stopReason: "end" };
      },
    };
    const settings: TuiSettings = {
      listModels: () => ["deepseek/deepseek-v4-pro"],
      switchModel: (name) => {
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
    const { app, log } = boot(settings, "no API key for provider deepseek");
    expect(doc(app)).toContain("no model");
    expect(doc(app)).toContain("✗ no API key for provider deepseek");
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
    app.dialogInput("\r");
    expect(calls).toEqual(["set:deepseek:sk-live-key", "switch:deepseek/deepseek-v4-pro"]);
    expect(app.dialogLines()).toEqual([]);
    expect(doc(app)).toContain("key for deepseek saved to the credentials file");
    expect(doc(app)).toContain("deepseek-v4-pro");
    expect(log.events.some((e) => e.type === "session/model")).toBe(true);

    await app.submit("hi again");
    expect(doc(app)).toContain("hello from the real model");
    app.stop();
  });

  it("/login anthropic 直接进该供应商的输入步;占位 provider 的请求失败并指向 /login", async () => {
    const settings: TuiSettings = {
      listModels: () => [],
      switchModel: () => {
        throw new Error("n/a");
      },
      setKey: () => {},
      setDefault: () => {},
      providers: () => PROVIDERS,
      verifyKey: async () => [],
    };
    const { app } = boot(settings);
    await app.command("/login anthropic");
    const out = plain(app.dialogLines());
    expect(out).toContain("anthropic");
    expect(out).toContain("paste the API key");
    app.dialogInput("\x1b");
    app.dialogInput("\x1b");
    expect(app.dialogLines()).toEqual([]);
    const none = noProviderChoice();
    await expect(none.provider.complete([], [])).rejects.toThrow("Run /login to add an API key");
    app.stop();
  });
});
