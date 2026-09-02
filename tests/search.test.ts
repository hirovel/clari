import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffLines, hunks } from "../cli/tools/diff.js";
import {
  createGrepTool,
  globTool,
  globToRegExp,
  grepFiles,
  lsTool,
  walkFiles,
} from "../cli/tools/search.js";

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function project(): string {
  tmp = mkdtempSync(join(tmpdir(), "ak-search-"));
  mkdirSync(join(tmp, "src", "deep"), { recursive: true });
  mkdirSync(join(tmp, "node_modules", "x"), { recursive: true });
  writeFileSync(join(tmp, "src", "a.ts"), "export const alpha = 1;\nfunction beta() {}\n");
  writeFileSync(join(tmp, "src", "deep", "b.ts"), "const Alpha = 2;\n");
  writeFileSync(join(tmp, "README.md"), "alpha in docs\n");
  writeFileSync(join(tmp, "node_modules", "x", "index.js"), "alpha should be skipped\n");
  return tmp;
}

describe("只读工具(Q56)", () => {
  it("walkFiles 跳过 node_modules 等目录,路径用正斜杠", () => {
    const root = project();
    expect(walkFiles(root)).toEqual(["README.md", "src/a.ts", "src/deep/b.ts"]);
  });

  it("glob → 正则:** 跨层级,* 单段", () => {
    expect(globToRegExp("src/**/*.ts").test("src/deep/b.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.ts")).toBe(false);
    expect(globToRegExp("*.md").test("README.md")).toBe(true);
    expect(globToRegExp("src/?.ts").test("src/a.ts")).toBe(true);
  });

  it("grepFiles:正则、文件过滤、结果上限", () => {
    const root = project();
    const all = grepFiles(root, /alpha/i);
    expect(all.matches.map((m) => `${m.file}:${m.line}`)).toEqual([
      "README.md:1",
      "src/a.ts:1",
      "src/deep/b.ts:1",
    ]);
    const ts = grepFiles(root, /alpha/i, { glob: "*.ts" });
    expect(ts.matches.map((m) => m.file)).toEqual(["src/a.ts", "src/deep/b.ts"]);
    const capped = grepFiles(root, /alpha/i, { maxResults: 1 });
    expect(capped.matches).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  it("grep 工具(JS 回退):输出 路径:行号:内容,无匹配时说明;glob 与 ls 工具", async () => {
    const root = project();
    const grep = createGrepTool({ useRipgrep: false });
    const out = await grep.execute(
      { pattern: "beta", path: root },
      { signal: new AbortController().signal },
    );
    expect(out).toBe("src/a.ts:2:function beta() {}");
    const none = await grep.execute(
      { pattern: "zzz", path: root },
      { signal: new AbortController().signal },
    );
    expect(none).toContain("无匹配");

    const files = await globTool.execute(
      { pattern: "**/*.ts", path: root },
      { signal: new AbortController().signal },
    );
    expect(files.split("\n")).toEqual(["src/a.ts", "src/deep/b.ts"]);

    const listing = await lsTool.execute(
      { path: join(root, "src") },
      { signal: new AbortController().signal },
    );
    expect(listing.split("\n")[0]).toBe("deep/");
    expect(listing).toContain("a.ts  ");
  });
});

describe("行级 diff(Q58)", () => {
  it("增删改与上下文折叠", () => {
    const d = diffLines("a\nb\nc\nd\ne\nf\ng", "a\nb\nX\nd\ne\nf\ng\nh");
    expect(d.map((l) => l.kind + l.text)).toEqual([
      " a",
      " b",
      "-c",
      "+X",
      " d",
      " e",
      " f",
      " g",
      "+h",
    ]);
    const h = hunks(d, 1);
    expect(h.map((l) => l.kind + l.text)).toEqual([
      " b",
      "-c",
      "+X",
      " d",
      "……2 行未变…",
      " g",
      "+h",
    ]);
  });

  it("超长片段退化为整删整增,不做二次方计算", () => {
    const big = Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n");
    const d = diffLines(big, `${big}\nmore`);
    expect(d.filter((l) => l.kind === "-")).toHaveLength(500);
    expect(d.filter((l) => l.kind === "+")).toHaveLength(501);
  });
});
