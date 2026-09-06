// 文本块:续行悬挂缩进(记号行、引导行、前导空格行),截断模式,底带铺满;状态行左右分栏。
import { describe, expect, it } from "vitest";
import { Block, hangingIndent, hangLine, SplitLine } from "../cli/tui-block.js";
import { stripAnsi } from "./helpers/virtual-terminal.js";

describe("hangLine", () => {
  it("记号行的续行缩到正文列(第 2 列);截断模式不折行,超宽切到宽度并以 … 收尾", () => {
    const line = `› ${"word ".repeat(30).trim()}`;
    const out = hangLine(line, 60).map(stripAnsi);
    expect(out.length).toBeGreaterThan(1);
    expect(out[0]?.startsWith("› word")).toBe(true);
    for (const l of out.slice(1)) {
      expect(l.startsWith("  ")).toBe(true);
      expect(l[2]).not.toBe(" ");
      expect(l.length).toBeLessThanOrEqual(60);
    }
    const cut = new Block(`  ${"x".repeat(100)}\n  short`, { truncate: true })
      .render(40)
      .map(stripAnsi);
    expect(cut).toHaveLength(2);
    expect(cut[0]?.trimEnd().endsWith("…")).toBe(true);
    expect(cut[0]?.trimEnd().length).toBeLessThanOrEqual(40);
    expect(cut[1]?.trimEnd()).toBe("   short");
  });

  it("记号行缩 2,引导行缩 4 并重复引导线,前导空格行照前导空格", () => {
    expect(hangingIndent("› hello")).toBe(2);
    expect(hangingIndent("» bash  ls")).toBe(2);
    expect(hangingIndent("└ ✓ bash  3 lines")).toBe(2);
    expect(hangingIndent("≈ compacted")).toBe(2);
    expect(hangingIndent("  ┆ ✓ echo")).toBe(4);
    expect(hangingIndent("           body")).toBe(11);
    expect(hangingIndent("plain text with no label")).toBe(0);
    const guide = hangLine(`  ┆ ${"x ".repeat(40).trim()}`, 30).map(stripAnsi);
    expect(guide.length).toBeGreaterThan(1);
    expect(guide[1]?.startsWith("  ┆ ")).toBe(true);
  });

  it("放得下就原样返回;ANSI 不算宽度", () => {
    const styled = "\x1b[38;2;1;2;3mresult\x1b[39m     short";
    expect(hangLine(styled, 40)).toEqual([styled]);
  });
});

describe("Block 与 SplitLine", () => {
  it("Block 左右各留一列,底带铺满整行", () => {
    const b = new Block("› hi", { bg: (s) => `[${s}]` });
    const lines = b.render(12);
    expect(lines).toEqual(["[ › hi       ]"]);
    b.setText("");
    expect(b.render(12)).toEqual([]);
  });

  it("SplitLine 右边靠右;放不下时只留左边", () => {
    const s = new SplitLine();
    s.set("left", "right");
    expect(s.render(20)).toEqual([" left         right "]);
    expect(s.render(9)).toEqual([" left "]);
  });
});
