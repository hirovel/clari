// TUI 入口:读配置、匹配供应商、组装工具与压缩,然后把界面交给 tui-app。
// 用法:pnpm tui [-- --model <供应商/模型>] [--subagent] [--compaction llm|clear|pipeline]
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { clearToolResults, llmSummarize, pipeline } from "../src/compaction.js";
import {
  createProvider,
  DEFAULT_CONFIG_PATH,
  type KernelConfig,
  loadConfig,
  resolveApiKey,
  resolveModel,
  setApiKey,
  setDefaultModel,
} from "../src/config.js";
import { EventLog } from "../src/log.js";
import type { CompactionConfig } from "../src/loop.js";
import { createTaskTool } from "../src/subagent.js";
import type { Tool } from "../src/tools.js";
import { bashTool } from "./tools/bash.js";
import { editTool, readTool, writeTool } from "./tools/fs.js";
import { createTuiApp, type ModelChoice, type TuiSettings } from "./tui-app.js";

const SYSTEM_PROMPT =
  "你是一个在用户机器上工作的编程助手。工作目录即当前目录。" +
  "优先用 read/edit 做精确修改,用 bash 执行命令与搜索。回答简洁。";
const RESERVE = 32000;

const args = parseArgs(process.argv.slice(2));
const loaded = loadConfig();
let config = loaded.config;
if (loaded.created) {
  console.log(`已生成配置模板:${DEFAULT_CONFIG_PATH}`);
  console.log("填入各家的 API key(推荐环境变量),或启动后用 /key 供应商 密钥 写入配置。\n");
}

function choose(name?: string): ModelChoice {
  const r = resolveModel(config, name);
  const apiKey = resolveApiKey(r.providerName, r.provider);
  return {
    provider: createProvider(r, apiKey),
    model: r.model,
    providerName: r.providerName,
    contextWindow: r.contextWindow,
  };
}

let first: ModelChoice;
try {
  first = choose(args.model);
} catch (err) {
  console.error((err as Error).message);
  console.error("\n提示:任一供应商 key 就位后即可启动;其余供应商可在 TUI 内用 /key 设置。");
  process.exit(1);
}

const sessionFile = `sessions/${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
const log = new EventLog(sessionFile);

const STRATEGIES = {
  llm: () => llmSummarize(),
  clear: () => clearToolResults(),
  pipeline: () => pipeline(clearToolResults(), llmSummarize()),
} as const;
const strategyName = (args.compaction ?? "llm") as keyof typeof STRATEGIES;
const compaction: CompactionConfig = {
  strategy: (STRATEGIES[strategyName] ?? STRATEGIES.llm)(),
  window: first.contextWindow,
  reserveTokens: RESERVE,
};

const baseTools: Tool[] = [readTool, writeTool, editTool, bashTool];
const tools: Tool[] = args.subagent
  ? [
      ...baseTools,
      createTaskTool({ parent: log, provider: first.provider, tools: baseTools, compaction }),
    ]
  : baseTools;

const settings: TuiSettings = {
  listModels: () =>
    Object.entries(config.providers).flatMap(([pn, p]) => p.models.map((m) => `${pn}/${m}`)),
  switchModel: (name) => choose(name),
  setKey: (providerName, key) => {
    config = setApiKey(config, providerName, key);
  },
  setDefault: (model) => {
    config = setDefaultModel(config, model) as KernelConfig;
  },
};

createTuiApp({
  terminal: new ProcessTerminal(),
  log,
  provider: first.provider,
  tools,
  compaction,
  reserveTokens: RESERVE,
  info: { model: first.model, providerName: first.providerName, sessionFile },
  settings,
  systemPrompt: SYSTEM_PROMPT,
});

function parseArgs(argv: string[]): { model?: string; subagent: boolean; compaction?: string } {
  const out: { model?: string; subagent: boolean; compaction?: string } = { subagent: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--model" && next) {
      out.model = next;
      i++;
    } else if (a === "--compaction" && next) {
      out.compaction = next;
      i++;
    } else if (a === "--subagent") {
      out.subagent = true;
    }
  }
  return out;
}
