// bash 工具(Q25,照抄 pi 方案):Windows 找 Git Bash,打断杀进程树。
// 截断策略可换(Q28):默认保尾,自定义策略经 createBashTool 注入。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { defineTool } from "../../src/tools.js";
import { keepTail, type TruncationPolicy } from "./truncate.js";

/** 缺省超时(秒)与输出缓冲上限(字节)。超过就杀进程树,已收到的部分照常返回并说明。 */
export const DEFAULT_TIMEOUT_S = 120;
export const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export function createBashTool(
  opts: { truncate?: TruncationPolicy; defaultTimeoutS?: number; maxOutputBytes?: number } = {},
) {
  const truncate = opts.truncate ?? keepTail();
  const defaultTimeout = opts.defaultTimeoutS ?? DEFAULT_TIMEOUT_S;
  const maxBytes = opts.maxOutputBytes ?? MAX_OUTPUT_BYTES;
  return defineTool({
    name: "bash",
    description:
      "在当前工作目录执行 bash 命令,返回 stdout 与 stderr 合并输出。" +
      `缺省 ${defaultTimeout} 秒超时,长任务用 timeout 参数加大。` +
      "输出超限时按截断策略保留一部分,全量写入临时文件并附路径。",
    parameters: Type.Object({
      command: Type.String({ description: "要执行的 bash 命令" }),
      timeout: Type.Optional(
        Type.Number({ description: `超时秒数,缺省 ${defaultTimeout};0 = 不限` }),
      ),
    }),
    async execute(args, ctx) {
      const shell = findBash();
      if (!shell) {
        throw new Error(
          "找不到 bash。可选方案:1. 安装 Git for Windows;2. 设环境变量 CLARI_SHELL 指向 bash 可执行文件。",
        );
      }
      const timeoutS = args.timeout ?? defaultTimeout;
      const r = await run(shell, args.command, ctx.signal, {
        timeoutMs: timeoutS > 0 ? timeoutS * 1000 : 0,
        maxBytes,
      });
      const shown = applyTruncation(r.output, truncate);
      if (r.aborted) throw new Error(`命令已被打断。已产出的输出:\n${shown}`);
      if (r.timedOut) {
        throw new Error(`命令超过 ${timeoutS} 秒未结束,已终止。已产出的输出:\n${shown}`);
      }
      if (r.overflowed) {
        throw new Error(
          `命令输出超过 ${Math.round(maxBytes / 1024 / 1024)} MB,已终止。请缩小输出范围。已产出的输出:\n${shown}`,
        );
      }
      if (r.exitCode !== 0) throw new Error(`${shown}\n命令退出码 ${r.exitCode}`);
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
  if (process.env.CLARI_SHELL) return process.env.CLARI_SHELL;
  if (process.platform !== "win32") return "bash";
  const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
  if (existsSync(gitBash)) return gitBash;
  const where = spawnSync("where.exe", ["bash.exe"], { encoding: "utf8" });
  const found = where.stdout?.split(/\r?\n/)[0]?.trim();
  return found || null;
}

type RunResult = {
  output: string;
  exitCode: number;
  aborted: boolean;
  timedOut: boolean;
  overflowed: boolean;
};

function run(
  shell: string,
  command: string,
  signal: AbortSignal,
  limits: { timeoutMs: number; maxBytes: number },
): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    // POSIX 下 detached 开进程组,打断时整组杀掉;Windows 用 taskkill /T 杀进程树。
    const child = spawn(shell, ["-c", command], {
      cwd: process.cwd(),
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let aborted = false;
    let timedOut = false;
    let overflowed = false;
    let killed = false;

    const killTree = () => {
      if (killed || child.pid === undefined) return;
      killed = true;
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
    const onData = (d: Buffer) => {
      if (overflowed) return;
      chunks.push(d);
      bytes += d.length;
      if (bytes > limits.maxBytes) {
        overflowed = true;
        killTree();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const onAbort = () => {
      aborted = true;
      killTree();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timer =
      limits.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree();
          }, limits.timeoutMs)
        : undefined;

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
    };
    child.on("error", (err) => {
      cleanup();
      rejectPromise(err);
    });
    child.on("close", (code) => {
      cleanup();
      resolvePromise({
        output: Buffer.concat(chunks).toString("utf8"),
        exitCode: code ?? -1,
        aborted,
        timedOut,
        overflowed,
      });
    });
  });
}
