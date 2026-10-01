import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    maxWorkers: 2,
    include: ["tests/**/*.test.ts"],
    // 每个测试进程先把用户目录指到临时目录:发现类逻辑(AGENTS.md、skills、prompts、config)不碰真机。
    setupFiles: ["tests/helpers/setup.ts"],
  },
});
