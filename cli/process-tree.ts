import { type ChildProcess, spawnSync } from "node:child_process";

/** 停止进程及后代;失败必须向调用方暴露,不能假称已清理。 */
export function stopProcessTree(child: ChildProcess, group = false): void {
  const pid = child.pid;
  if (pid === undefined) throw new Error("process has no PID; its children may still be running");
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if (result.status === 0 && !result.error) return;
    let fallback = "";
    try {
      if (!child.kill("SIGKILL")) fallback = "; direct child did not accept SIGKILL";
    } catch (error) {
      fallback = `; direct child stop failed: ${(error as Error).message}`;
    }
    const detail = result.error?.message || result.stderr?.trim() || `exit code ${result.status}`;
    throw new Error(
      `could not stop process tree ${pid}: ${detail}${fallback}. Child processes may still be running`,
    );
  }
  try {
    if (group) process.kill(-pid, "SIGKILL");
    else if (!child.kill("SIGKILL")) throw new Error("process did not accept SIGKILL");
  } catch (error) {
    if (group) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 原进程组失败已在下方报告,直杀也只是尽力补救。 */
      }
    }
    throw new Error(
      `could not stop process tree ${pid}: ${(error as Error).message}. Child processes may still be running`,
    );
  }
}
