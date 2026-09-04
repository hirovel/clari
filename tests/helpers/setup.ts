// 测试隔离:用户目录指向一个临时目录,任何没显式给 home 的发现(AGENTS.md、skills、prompts、config)都碰不到真机。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "clari-test-home-"));
process.env.CLARI_HOME = join(home, ".clari");
process.env.CLARI_CONFIG = join(home, ".clari", "config.json");
