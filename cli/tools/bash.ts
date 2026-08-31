// bash 工具(Q25,照抄 pi 方案):Windows 找 Git Bash,打断杀进程树。
// 截断策略可换(Q28):默认保尾,自定义策略经 createBashTool 注入。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { defineTool } from "../../src/tools.js";
import { keepTail, type TruncationPolicy } from "./truncate.js";

export function createBashTool(opts: { truncate?: TruncationPolicy } = {}) {
  const truncate = opts.truncate ?? keepTail();
  return defineTool({
    name: "bash",
    description:
      "在当前工作目录执行 bash 命令,返回 stdout 与 stderr 合并输出。" +
      "输出超限时按截断策略保留一部分,全量写入临时文件并附路径。",
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
      const shown = applyTruncation(output, truncate);
      if (aborted) throw new Error(`命令已被打断。已产出的输出:\n${shown}`);
      if (exitCode !== 0) throw new Error(`${shown}\n命令退出码 ${exitCode}`);
      return shown || "(无输出)";
    },
  });
}

/** 默认实例:保尾截断 —— 命令输出的错误与结论通常在末尾。 */
export const bashTool = createBashTool();

function applyTruncation(output: string, truncate: TruncationPolicy): string {
  const t = truncate(output);
  if (!t.truncated) return t.text.trimEnd();
  // 全量落盘是透明度要求,与策略无关:被截掉的部分永远找得回来。
  const fullPath = join(mkdtempSync(join(tmpdir(), "kernel-bash-")), "output.txt");
  writeFileSync(fullPath, output, "utf8");
  return `${t.text.trimEnd()}\n[${t.note ?? "输出已截断"}。完整输出:${fullPath}]`;
}

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
