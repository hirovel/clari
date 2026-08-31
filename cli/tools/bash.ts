// bash 工具(Q25,照抄 pi 方案):Windows 找 Git Bash,打断杀进程树,输出保尾截断。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { defineTool } from "../../src/tools.js";

const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;

export const bashTool = defineTool({
  name: "bash",
  description:
    "在当前工作目录执行 bash 命令,返回 stdout 与 stderr 合并输出。" +
    `输出超过 ${MAX_LINES} 行或 ${MAX_BYTES / 1024}KB 时只保留尾部,全量写入临时文件并附路径。`,
  parameters: Type.Object({
    command: Type.String({ description: "要执行的 bash 命令" }),
  }),
  async execute(args, ctx) {
    const shell = findBash();
    if (!shell) {
      throw new Error(
        "找不到 bash。可选方案:1. 安装 Git for Windows;2. 设环境变量 KERNEL_SHELL 指向 bash 可执行文件。",
      );
    }
    const { output, exitCode, aborted } = await run(shell, args.command, ctx.signal);
    const shown = truncateTail(output);
    if (aborted) throw new Error(`命令已被打断。已产出的输出:\n${shown}`);
    if (exitCode !== 0) throw new Error(`${shown}\n命令退出码 ${exitCode}`);
    return shown || "(无输出)";
  },
});

function findBash(): string | null {
  if (process.env.KERNEL_SHELL) return process.env.KERNEL_SHELL;
  if (process.platform !== "win32") return "bash";
  const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
  if (existsSync(gitBash)) return gitBash;
  const where = spawnSync("where.exe", ["bash.exe"], { encoding: "utf8" });
  const found = where.stdout?.split(/\r?\n/)[0]?.trim();
  return found || null;
}

function run(
  shell: string,
  command: string,
  signal: AbortSignal,
): Promise<{ output: string; exitCode: number; aborted: boolean }> {
  return new Promise((resolvePromise, rejectPromise) => {
    // POSIX 下 detached 开进程组,打断时整组杀掉;Windows 用 taskkill /T 杀进程树。
    const child = spawn(shell, ["-c", command], {
      cwd: process.cwd(),
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let output = "";
    let aborted = false;
    child.stdout.on("data", (d: Buffer) => {
      output += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      output += d.toString("utf8");
    });

    const onAbort = () => {
      aborted = true;
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)]);
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      signal.removeEventListener("abort", onAbort);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise({ output, exitCode: code ?? -1, aborted });
    });
  });
}

function truncateTail(output: string): string {
  const lines = output.split("\n");
  const withinLines = lines.length <= MAX_LINES;
  const withinBytes = Buffer.byteLength(output, "utf8") <= MAX_BYTES;
  if (withinLines && withinBytes) return output.trimEnd();

  const fullPath = join(mkdtempSync(join(tmpdir(), "kernel-bash-")), "output.txt");
  writeFileSync(fullPath, output, "utf8");

  let tail = lines.slice(-MAX_LINES);
  let text = tail.join("\n");
  while (Buffer.byteLength(text, "utf8") > MAX_BYTES && tail.length > 1) {
    tail = tail.slice(Math.ceil(tail.length / 10));
    text = tail.join("\n");
  }
  const from = lines.length - tail.length + 1;
  return `${text.trimEnd()}\n[显示第 ${from}-${lines.length} 行,共 ${lines.length} 行。完整输出:${fullPath}]`;
}
