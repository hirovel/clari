import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

/** 本机文件的写入资格;长持有靠心跳恢复崩溃遗留,调用方在写入和释放时检查归属。 */
export function lockFile(file: string) {
  mkdirSync(dirname(resolve(file)), { recursive: true });
  const path = existsSync(file)
    ? realpathSync(file)
    : join(realpathSync(dirname(resolve(file))), basename(file));
  let lost: Error | undefined;
  let closed = false;
  let release: () => void;
  try {
    release = lockfile.lockSync(path, {
      realpath: false,
      stale: 60000,
      update: 10000,
      onCompromised: (error) => {
        lost = error;
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED")
      throw new Error(
        `File is in use: ${path}. Close the other writer and retry. After a crash, recovery may take up to 60 seconds.`,
      );
    throw error;
  }
  const identity = statSync(`${path}.lock`);
  const assertHeld = () => {
    if (closed) throw new Error(`Writer is closed: ${path}`);
    if (lost)
      throw new Error(`Write ownership lost: ${path}. Reopen the session before writing.`, {
        cause: lost,
      });
    // 进程暂停后恢复时,必须先识别已被另一写入者替换的锁,不能等待下一次心跳。
    const current = statSync(`${path}.lock`);
    if (current.ino !== identity.ino || current.birthtimeMs !== identity.birthtimeMs)
      throw new Error(`Write ownership changed: ${path}. Reopen before writing.`);
  };
  return {
    path,
    assertHeld,
    release() {
      if (closed) return;
      try {
        assertHeld();
        release();
      } finally {
        closed = true;
      }
    },
  };
}
