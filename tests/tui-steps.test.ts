// 账簿:更早的步自动折成一行账目;PgUp/PgDn 移动光标,Enter 展开/折起,Esc 放开;foldSteps 0 从不折;脉搏出现在状态行。
import { describe, expect, it } from "vitest";
import { createTuiApp } from "../cli/tui-app.js";
import { EventLog } from "../src/log.js";
import type { AssistantTurn, Provider } from "../src/provider.js";
import { stripAnsi, VirtualTerminal } from "./helpers/virtual-terminal.js";

function counting(): Provider {
  let n = 0;
  return {
    model: "m",
    async complete(): Promise<AssistantTurn> {
      n += 1;
      return {
        text: `reply number ${n}`,
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 100 * n, outputTokens: 10 },
      };
    },
  };
}

function boot(extra: Record<string, unknown> = {}) {
  const term = new VirtualTerminal(110, 30);
  const app = createTuiApp({
    terminal: term,
    log: new EventLog(),
    provider: counting(),
    tools: [],
    compaction: { strategy: async () => null, window: 10000, reserveTokens: 1000 },
    reserveTokens: 1000,
    info: { model: "m", providerName: "p", sessionFile: "s" },
    systemPrompt: "sys",
    onExit: () => {},
    ...extra,
  });
  const doc = () => app.lines(110).map(stripAnsi).join("\n");
  return { app, term, doc };
}

/** 展开的回复正文:从正文列起(边距一格 + 标记列两格);折起的账目行里同样的字前面是 · 。 */
function open(n: number): RegExp {
  return new RegExp(`^ {3}reply number ${n}(?!\\d)`, "m");
}

describe("账簿折叠", () => {
  it("最新三步展开,更早的折成一行账目;用户消息永远不折", async () => {
    const { app, doc } = boot();
    for (let i = 1; i <= 5; i++) await app.submit(`question ${i}`);
    const d = doc();
    expect(d).toContain("≡ #1");
    expect(d).toContain("≡ #2");
    expect(d).not.toContain("≡ #3");
    expect(d).not.toMatch(open(1));
    expect(d).not.toMatch(open(2));
    expect(d).toMatch(open(3));
    expect(d).toMatch(open(5));
    // 账目里有停止原因、用量与回复首行;用户消息还在
    expect(d).toMatch(/≡ #1 {2}end · ↑100 ↓10 · reply number 1/);
    for (let i = 1; i <= 5; i++) expect(d).toContain(`› question ${i}`);
    app.stop();
  });

  it("PgUp/PgDn 移动光标,状态行显示位置;Enter 折起或展开;Esc 放开;手动展开的不再自动折", async () => {
    const { app, term, doc } = boot();
    for (let i = 1; i <= 4; i++) await app.submit(`q ${i}`);
    term.feed("\x1b[5~"); // PgUp:从最后一步起
    expect(doc()).toContain("step 4/4");
    term.feed("\x1b[5~");
    term.feed("\x1b[5~");
    term.feed("\x1b[5~");
    expect(doc()).toContain("step 1/4");
    expect(doc()).toContain("▸ #1"); // 折起的账目行带光标
    term.feed("\r"); // 展开
    let d = doc();
    expect(d).toMatch(open(1));
    expect(d).not.toContain("▸ #1");
    term.feed("\r"); // 再折起
    expect(doc()).not.toMatch(open(1));
    term.feed("\r"); // 展开并 pin
    term.feed("\x1b[6~"); // PgDn → step 2
    expect(doc()).toContain("step 2/4");
    term.feed("\x1b"); // 放开
    expect(doc()).not.toContain("step 2/4");
    await app.submit("q 5");
    // #1 手动展开过,不再自动折;#2 被折
    d = doc();
    expect(d).toMatch(open(1));
    expect(d).toContain("≡ #2");
    app.stop();
  });

  it("foldSteps 0 从不折;脉搏在两次请求后出现在状态行", async () => {
    const { app, doc } = boot({ foldSteps: 0 });
    for (let i = 1; i <= 5; i++) await app.submit(`q ${i}`);
    const d = doc();
    expect(d).not.toContain("≡ #");
    expect(d).toMatch(open(1));
    expect(d).toMatch(/[▁▂▃▄▅▆▇█]{5}/);
    app.stop();
  });
});
