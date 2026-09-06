// 从 models.dev 生成内置快照 cli/models.snapshot.ts:只留我们直连的三家与用到的字段,编译进包里。
// 运行:pnpm models:update。快照保证离线与首次启动有数据;运行时每天再刷新一次(cli/registry.ts)。
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY_URL, type Registry, type RegistryModel } from "../cli/registry.js";

const KEEP = ["deepseek", "openai", "anthropic"];
const FIELDS: (keyof RegistryModel)[] = [
  "id",
  "name",
  "reasoning",
  "reasoning_options",
  "tool_call",
  "limit",
  "cost",
];

const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(20000) });
if (!res.ok) throw new Error(`models.dev ${res.status}`);
const full = (await res.json()) as Registry;
const out: Registry = {};
for (const id of KEEP) {
  const p = full[id];
  if (!p) continue;
  const models: Record<string, RegistryModel> = {};
  for (const [mid, m] of Object.entries(p.models ?? {})) {
    const slim = {} as RegistryModel;
    for (const f of FIELDS) if (m[f] !== undefined) (slim as Record<string, unknown>)[f] = m[f];
    // 价格只留三项;分档与超长上下文加价不进快照,费用显示按基础档。
    if (slim.cost) {
      const { input, output, cache_read, cache_write } = slim.cost;
      slim.cost = {
        ...(input !== undefined && { input }),
        ...(output !== undefined && { output }),
        ...(cache_read !== undefined && { cache_read }),
        ...(cache_write !== undefined && { cache_write }),
      };
    }
    models[mid] = slim;
  }
  out[id] = { id, ...(p.api && { api: p.api }), ...(p.env && { env: p.env }), models };
}
const target = join(import.meta.dirname, "..", "cli", "models.snapshot.ts");
const fetchedAt = new Date().toISOString().slice(0, 10);
writeFileSync(
  target,
  `// 由 scripts/update-models.ts 从 models.dev 生成(${fetchedAt}),不要手改;pnpm models:update 重取。\n` +
    `import type { Registry } from "./registry.js";\n\n` +
    `export const SNAPSHOT_DATE = "${fetchedAt}";\n\n` +
    `export const SNAPSHOT: Registry = ${JSON.stringify(out, null, 1)};\n`,
  "utf8",
);
console.log(
  `wrote ${target}: ${KEEP.map((k) => `${k} ${Object.keys(out[k]?.models ?? {}).length}`).join(", ")}`,
);
