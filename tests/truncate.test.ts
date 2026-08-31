import { describe, expect, it } from "vitest";
import { keepBothEnds, keepHead, keepTail } from "../cli/tools/truncate.js";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line-${i + 1}`).join("\n");

describe("truncation policies", () => {
  it("未超限:三种策略都原样返回", () => {
    const input = lines(10);
    for (const policy of [keepTail(), keepHead(), keepBothEnds()]) {
      expect(policy(input)).toEqual({ text: input, truncated: false });
    }
  });

  it("keepTail:保留末尾,note 标明范围", () => {
    const t = keepTail({ maxLines: 3 })(lines(10));
    expect(t.truncated).toBe(true);
    expect(t.text).toBe("line-8\nline-9\nline-10");
    expect(t.note).toBe("显示第 8-10 行,共 10 行");
  });

  it("keepHead:保留开头", () => {
    const t = keepHead({ maxLines: 3 })(lines(10));
    expect(t.text).toBe("line-1\nline-2\nline-3");
    expect(t.note).toBe("显示第 1-3 行,共 10 行");
  });

  it("keepBothEnds:两头保中略,标明省略行数", () => {
    const t = keepBothEnds({ headLines: 2, tailLines: 2 })(lines(10));
    expect(t.truncated).toBe(true);
    expect(t.text).toContain("line-1\nline-2");
    expect(t.text).toContain("line-9\nline-10");
    expect(t.text).toContain("[中略 6 行]");
    expect(t.note).toBe("显示首 2 行与末 2 行,共 10 行");
  });

  it("字节上限独立生效:行数达标但字节超限仍触发截断", () => {
    const fat = Array.from({ length: 10 }, () => "x".repeat(100)).join("\n");
    const t = keepTail({ maxLines: 100, maxBytes: 300 })(fat);
    expect(t.truncated).toBe(true);
    expect(Buffer.byteLength(t.text, "utf8")).toBeLessThanOrEqual(300);
  });
});
