// 行级 diff(Q58):只为屏幕展示"模型改了什么",不进日志、不进内核。
// 最长公共子序列的经典算法,片段很小;超过上限退化为整段删除加整段新增。

export type DiffLine = { kind: "+" | "-" | " "; text: string };

const MAX_LINES = 400;

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [
      ...a.map((text) => ({ kind: "-" as const, text })),
      ...b.map((text) => ({ kind: "+" as const, text })),
    ];
  }
  // dp[i][j] = a[i..] 与 b[j..] 的 LCS 长度
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = dp[i] as number[];
      const next = dp[i + 1] as number[];
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const row = dp[i] as number[];
    const next = dp[i + 1] as number[];
    if (a[i] === b[j]) {
      out.push({ kind: " ", text: a[i] as string });
      i++;
      j++;
    } else if ((next[j] as number) >= (row[j + 1] as number)) {
      out.push({ kind: "-", text: a[i] as string });
      i++;
    } else {
      out.push({ kind: "+", text: b[j] as string });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "-", text: a[i++] as string });
  while (j < b.length) out.push({ kind: "+", text: b[j++] as string });
  return out;
}

/** 只保留改动行及其上下各 context 行,中间以省略行分隔。 */
export function hunks(lines: DiffLine[], context = 2): (DiffLine | { kind: "…"; text: string })[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, idx) => {
    if (l.kind === " ") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) {
      keep[k] = true;
    }
  });
  const out: (DiffLine | { kind: "…"; text: string })[] = [];
  let skipping = 0;
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      // 开头的未变行直接省略,不放标记;中间的才标出略去多少。
      if (skipping > 0 && out.length > 0) out.push({ kind: "…", text: `…${skipping} 行未变…` });
      skipping = 0;
      out.push(l);
    } else skipping++;
  });
  return out;
}
