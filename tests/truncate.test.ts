import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadTool } from "../cli/tools/fs.js";
import { capLineLength, keepHead, keepTail } from "../cli/tools/truncate.js";

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line-${i + 1}`).join("\n");

describe("truncation policies", () => {
  it("未超限:三种策略都原样返回", () => {
    const input = lines(10);
    for (const policy of [keepTail(), keepHead()]) {
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

  it("字节上限独立生效:行数达标但字节超限仍触发截断", () => {
    const fat = Array.from({ length: 10 }, () => "x".repeat(100)).join("\n");
    const t = keepTail({ maxLines: 100, maxBytes: 300 })(fat);
    expect(t.truncated).toBe(true);
    expect(Buffer.byteLength(t.text, "utf8")).toBeLessThanOrEqual(300);
    const oneLine = `${"甲".repeat(200)}${"乙".repeat(200)}`;
    for (const [policy, edge] of [
      [keepHead({ maxBytes: 300 }), "甲".repeat(100)],
      [keepTail({ maxBytes: 300 }), "乙".repeat(100)],
    ] as const) {
      const clipped = policy(oneLine);
      expect(clipped.truncated).toBe(true);
      expect(clipped.text).toBe(edge);
      expect(Buffer.byteLength(clipped.text, "utf8")).toBe(300);
    }
  });

  it("capLineLength:超长行截到上限并加标记,短行不动", () => {
    const cap = capLineLength(10);
    expect(cap(`short\n${"y".repeat(30)}`)).toBe(
      `short\n${"y".repeat(10)}…[line truncated to 10 chars]`,
    );
  });
});

describe("readTool 截断行为", () => {
  const ctx = { signal: new AbortController().signal };
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function tempFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "kernel-read-"));
    tempDirs.push(dir);
    const path = join(dir, "f.txt");
    writeFileSync(path, content, "utf8");
    return path;
  }

  it("超长行被压扁(压缩产物不再吃穿字节预算)", async () => {
    const path = tempFile(`a\n${"z".repeat(5000)}\nb`);
    const read = createReadTool({ maxLineChars: 100 });
    const out = await read.execute({ path }, ctx);
    expect(out).toContain("…[line truncated to 100 chars]");
    expect(out.split("\n")[1]?.length).toBeLessThan(200);
    expect(out).toContain("raise maxOutputBytes to see more of each line");
    expect(out).not.toContain("continue with offset=");

    const oneLine = tempFile("z".repeat(500));
    const byteLimited = createReadTool({ truncate: keepHead({ maxBytes: 100 }) });
    const partial = await byteLimited.execute({ path: oneLine }, ctx);
    expect(partial).toContain("current line is incomplete");
    expect(partial).not.toContain("continue with offset=2");

    const clippedAndPaged = createReadTool({
      maxLineChars: 100,
      truncate: keepHead({ maxLines: 2 }),
    });
    const mixed = await clippedAndPaged.execute({ path }, ctx);
    expect(mixed).toContain("selected lines are shortened");
    expect(mixed).not.toContain("continue with offset=");
  });

  it("行数截断时给出具体的续读 offset", async () => {
    const path = tempFile(Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n"));
    const read = createReadTool({ truncate: keepHead({ maxLines: 3 }) });
    const out = await read.execute({ path }, ctx);
    expect(out).toContain("continue with offset=4");
  });

  it("目录列表也受输出预算约束,原文仍可记录", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kernel-read-"));
    tempDirs.push(dir);
    for (const name of ["a", "b", "c"]) writeFileSync(join(dir, name), "x");
    let recorded = "";
    const read = createReadTool({ truncate: keepHead({ maxLines: 2 }) });
    const out = await read.execute({ path: dir }, {
      ...ctx,
      output: {
        write: (text: string | Uint8Array) => {
          recorded += text;
        },
      },
    } as Parameters<typeof read.execute>[1]);
    expect(out).toContain("use glob to narrow");
    expect(out).not.toContain("c  1 B");
    expect(recorded).toContain("c  1 B");
  });

  it("大文件仍可按行读取,单次提高字节预算不会改变默认截断", async () => {
    const originalLine = "z".repeat(5000);
    const path = tempFile(`${(`${"x".repeat(1023)}\n`).repeat(20481)}${originalLine}`);
    const read = createReadTool();
    await expect(read.execute({ path }, ctx)).rejects.toThrow(/specify offset and limit/);
    let recorded = "";
    const tail = await read.execute({ path, offset: 20482, limit: 1 }, {
      ...ctx,
      output: {
        write: (text: string | Uint8Array) => {
          recorded += text;
        },
      },
    } as Parameters<typeof read.execute>[1]);
    expect(tail).toContain("20482\t");
    expect(tail).toContain("line truncated to 2000 chars");
    expect(recorded).toBe(originalLine);

    const dense = tempFile(Array.from({ length: 80 }, () => "a".repeat(1000)).join("\n"));
    const usual = await read.execute({ path: dense }, ctx);
    const raised = await read.execute({ path: dense, maxOutputBytes: 100000 }, ctx);
    expect(usual).toContain("continue with offset=");
    expect(raised).toContain("80\t");
    expect(raised).not.toContain("continue with offset=");
  });
});
