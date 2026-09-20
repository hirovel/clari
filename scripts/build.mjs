import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
// 固定到仓库的输出目录,避免已删除或搬移的源码留在安装包中。
rmSync(new URL("dist/", root), { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [fileURLToPath(new URL("node_modules/typescript/bin/tsc", root)), "-p", "tsconfig.build.json"],
  { cwd: fileURLToPath(root), stdio: "inherit" },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
