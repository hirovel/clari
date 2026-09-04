import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createReadTool } from "../cli/tools/fs.js";
import { capLineLength, keepBothEnds, keepHead, keepTail } from "../cli/tools/truncate.js";

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
    expect(t.note).toBe("showing lines 8-10 of 10");
  });

  it("keepHead:保留开头", () => {
    const t = keepHead({ maxLines: 3 })(lines(10));
    expect(t.text).toBe("line-1\nline-2\nline-3");
    expect(t.note).toBe("showing lines 1-3 of 10");
  });

  it("keepBothEnds:两头保中略,标明省略行数", () => {
    const t = keepBothEnds({ headLines: 2, tailLines: 2 })(lines(10));
    expect(t.truncated).toBe(true);
    expect(t.text).toContain("line-1\nline-2");
    expect(t.text).toContain("line-9\nline-10");
    expect(t.text).toContain("[6 lines omitted]");
    expect(t.note).toBe("showing first 2 and last 2 lines of 10");
  });

  it("字节上限独立生效:行数达标但字节超限仍触发截断", () => {
    const fat = Array.from({ length: 10 }, () => "x".repeat(100)).join("\n");
    const t = keepTail({ maxLines: 100, maxBytes: 300 })(fat);
    expect(t.truncated).toBe(true);
    expect(Buffer.byteLength(t.text, "utf8")).toBeLessThanOrEqual(300);
  });

  it("capLineLength:超长行截到上限并加标记,短行不动(Q29)", () => {
    const cap = capLineLength(10);
    expect(cap("short\n" + "y".repeat(30))).toBe(
      `short\n${"y".repeat(10)}…[line truncated to 10 chars]`,
    );
  });
});

describe("readTool 截断行为(Q29)", () => {
  const ctx = { signal: new AbortController().signal };

  function tempFile(content: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "kernel-read-")), "f.txt");
    writeFileSync(path, content, "utf8");
    return path;
  }

  it("超长行被压扁(压缩产物不再吃穿字节预算)", async () => {
    const path = tempFile(`a\n${"z".repeat(5000)}\nb`);
    const read = createReadTool({ maxLineChars: 100 });
    const out = await read.execute({ path }, ctx);
    expect(out).toContain("…[line truncated to 100 chars]");
    expect(out.split("\n")[1]?.length).toBeLessThan(200);
  });

  it("行数截断时给出具体的续读 offset", async () => {
    const path = tempFile(Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n"));
    const read = createReadTool({ truncate: keepHead({ maxLines: 3 }) });
    const out = await read.execute({ path }, ctx);
    expect(out).toContain("continue with offset=4");
  });
});
