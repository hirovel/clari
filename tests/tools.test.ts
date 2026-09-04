import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { editTool } from "../cli/tools/fs.js";
import { validateArgs } from "../src/tools.js";

const SCHEMA = Type.Object({
  path: Type.String(),
  limit: Type.Optional(Type.Number()),
});

const ctx = { signal: new AbortController().signal };

describe("validateArgs", () => {
  it("合法参数通过,数字字符串被强转(Value.Convert)", () => {
    const r = validateArgs(SCHEMA, { path: "a.txt", limit: "5" });
    expect(r).toEqual({ ok: true, value: { path: "a.txt", limit: 5 } });
  });

  it("缺字段→错误含路径与收到的参数原文", () => {
    const r = validateArgs(SCHEMA, { limit: 3 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("path");
      expect(r.error).toContain('"limit": 3');
    }
  });

  it("__unparsed(烂 JSON)→专门的错误文本(Q9)", () => {
    const r = validateArgs(SCHEMA, { __unparsed: '{"broken' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不是合法 JSON");
  });

  it("校验不改动原始参数对象(历史不可变)", () => {
    const raw = { path: "a.txt", limit: "5" };
    validateArgs(SCHEMA, raw);
    expect(raw.limit).toBe("5");
  });
});

describe("editTool", () => {
  function tempFile(content: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "kernel-edit-")), "f.txt");
    writeFileSync(path, content, "utf8");
    return path;
  }

  it("唯一匹配→替换成功", async () => {
    const path = tempFile("aaa bbb ccc");
    await editTool.execute({ path, oldText: "bbb", newText: "xxx" }, ctx);
    expect(readFileSync(path, "utf8")).toBe("aaa xxx ccc");
  });

  it("不存在→报错提示先 read", async () => {
    const path = tempFile("aaa");
    await expect(editTool.execute({ path, oldText: "zzz", newText: "x" }, ctx)).rejects.toThrow(
      "not found",
    );
  });

  it("多处匹配→报错并给出次数,提示 replaceAll", async () => {
    const path = tempFile("aa aa");
    await expect(editTool.execute({ path, oldText: "aa", newText: "x" }, ctx)).rejects.toThrow(
      /occurs 2 times.*replaceAll/,
    );
  });

  it("replaceAll→全部替换并报次数;没有命中仍走 not found(Q88)", async () => {
    const path = tempFile("foo(a); foo(b);\nbar();");
    const out = await editTool.execute(
      { path, oldText: "foo(", newText: "baz(", replaceAll: true },
      ctx,
    );
    expect(out).toBe(`replaced 2 occurrences in ${path}.`);
    expect(readFileSync(path, "utf8")).toBe("baz(a); baz(b);\nbar();");
    await expect(
      editTool.execute({ path, oldText: "nope", newText: "x", replaceAll: true }, ctx),
    ).rejects.toThrow("not found");
  });
});
