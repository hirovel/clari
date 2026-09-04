// 外部编辑器:长文本编辑走用户自己的编辑器,不在终端里造第二个。
// 顺序 CLARI_EDITOR > VISUAL > EDITOR > Windows 的 notepad > vi。编辑器退出后读回文件,没改就视为取消。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function editorCommand(env = process.env): string {
  const chosen = env.CLARI_EDITOR ?? env.VISUAL ?? env.EDITOR;
  if (chosen?.trim()) return chosen.trim();
  return process.platform === "win32" ? "notepad" : "vi";
}

/** 在外部编辑器里编辑一段文本。返回改后的文本;用户没改或编辑器失败返回 undefined。 */
export function editInExternalEditor(
  initial: string,
  opts: { env?: NodeJS.ProcessEnv; suffix?: string } = {},
): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), "kernel-edit-"));
  const file = join(dir, `edit${opts.suffix ?? ".md"}`);
  writeFileSync(file, initial, "utf8");
  const cmd = editorCommand(opts.env);
  // 编辑器命令可能带参数(如 "code --wait"),交给 shell 解析。
  const r = spawnSync(`${cmd} "${file}"`, { stdio: "inherit", shell: true });
  if (r.error || (r.status !== null && r.status !== 0)) return undefined;
  const next = readFileSync(file, "utf8");
  return next === initial ? undefined : next;
}
