// 工具描述风格槽(Q89):同一套工具,三套描述文案可选,用户可逐条改。
// 描述没有最优解:各家的文案长短与语气差一个量级,效果随模型而变,所以做成槽而不是定案。
// 内核不知道这一层;buildTools 装上,/toolprompts 会话中切换,切换记 session/slot 事件,下一次请求起生效。
import type { ToolPromptStyle, ToolPromptsConfig } from "../src/config.js";
import type { Tool } from "../src/tools.js";
import { DEFAULT_TIMEOUT_S } from "./tools/bash.js";

export const TOOL_PROMPT_STYLES: ToolPromptStyle[] = ["guided", "terse", "strict"];

/** 每种风格一句话,给 /toolprompts 列表用。 */
export const STYLE_NOTES: Record<ToolPromptStyle, string> = {
  guided:
    "three or four sentences per tool: output shape and limits, when not to use it, failure causes, token-saving use (default)",
  terse: "one or two sentences per tool, behaviour and limits only, in the manner of pi",
  strict:
    "guided plus imperative rules (ALWAYS / NEVER) on tool choice, in the manner of Claude Code",
};

/** terse:只说做什么与硬限制。写在工具文件里的描述就是 guided,这里只放另外两套。 */
const TERSE: Record<string, string> = {
  read: "Read a text file as numbered lines, or list a directory. Truncated output names the offset to continue from.",
  write: "Write a text file, replacing its contents; creates missing directories.",
  edit: "Replace oldText with newText in a file. oldText must occur exactly once unless replaceAll is set.",
  bash: `Run a bash command in the working directory; returns stdout and stderr. Default timeout ${DEFAULT_TIMEOUT_S} s. Long output is truncated and saved to a temp file.`,
  grep: "Search file contents by regular expression; returns path:line:content, at most 200 results.",
  glob: "List files matching a glob pattern, e.g. src/**/*.ts; relative paths, at most 500.",
  fetch:
    "Fetch an http(s) URL as text; HTML becomes markdown, JSON is pretty-printed. Long pages are truncated; continue with offset.",
};

/** strict:guided 的内容加上工具选择的硬规则。 */
const STRICT: Record<string, string> = {
  read:
    "Read a text file as numbered lines, or list a directory (one entry per line; directories end with /, files show their size). " +
    "ALWAYS read only the part you need with offset and limit. NEVER re-read a file right after editing it; the edit result already confirms the change. " +
    "Read several files in one turn when you know which ones. Output past the limit is truncated and the note gives the offset to continue from. " +
    "Text only: binary files and images are refused.",
  write:
    "Write a text file, replacing its contents; creates missing directories. " +
    "ALWAYS read an existing file before overwriting it. NEVER use write for a partial change to an existing file; use edit. " +
    "NEVER create documentation files unless asked.",
  edit:
    "Replace text in a file. You MUST read the file in this session before editing it. " +
    "oldText MUST match the file exactly, indentation included, and MUST occur exactly once unless replaceAll is set; keep it as short as it can be while still unique. " +
    "Set replaceAll to change every occurrence, e.g. for a rename. " +
    "No match or several matches fail with the reason; a retry that ignored trailing whitespace or quote style says so in the result.",
  bash:
    "Run a bash command in the current working directory; returns stdout and stderr combined. " +
    `Default timeout ${DEFAULT_TIMEOUT_S} s; set timeout for long tasks. Output past the limit is truncated and the full output is saved to a temp file whose path is appended. ` +
    "NEVER use bash to read or search files (cat, head, grep, find, ls); use read, grep and glob. Use bash for builds, tests, git and other commands. " +
    "Quote paths that contain spaces.",
  grep:
    "Search file contents by regular expression; returns path:line:content, at most 200 results, lines cut to 500 characters. " +
    "Skips .git, node_modules and build output. ALWAYS use this instead of grep or rg in bash to find matches; run independent searches in the same turn. " +
    "For match counts or context lines only, run rg in bash.",
  glob:
    "List files matching a glob pattern, e.g. src/**/*.ts; returns relative paths, at most 500, skipping .git, node_modules and build output. " +
    "ALWAYS use this instead of find or ls in bash to locate files by name. Use grep to find files by content.",
  fetch:
    "Fetch a URL over http(s) and return its content as text. HTML is converted to markdown; JSON is pretty-printed; other text is returned as-is; binary content is refused. " +
    "GitHub blob and gist pages are rewritten to their raw form. Redirects to another host are reported, not followed. " +
    "Long pages are truncated; continue with offset (pages are cached for 15 minutes, so paging is free). " +
    "NEVER fetch a page again with raw=true unless the conversion lost something you need.",
};

const STYLES: Record<ToolPromptStyle, Record<string, string>> = {
  guided: {},
  terse: TERSE,
  strict: STRICT,
};

/** 每个工具对象第一次经手时记下原描述(guided),以后切回去用。 */
const baseline = new WeakMap<Tool, string>();

export function baselineDescription(tool: Tool): string {
  const b = baseline.get(tool);
  if (b !== undefined) return b;
  baseline.set(tool, tool.description);
  return tool.description;
}

/** 某工具在某风格下的描述:用户改过的最优先,其次风格表,表里没有的工具用原描述。 */
export function styledDescription(tool: Tool, cfg: ToolPromptsConfig | undefined): string {
  const base = baselineDescription(tool);
  const override = cfg?.descriptions?.[tool.name];
  if (override !== undefined) return override;
  return (STYLES[cfg?.style ?? "guided"] ?? {})[tool.name] ?? base;
}

/** 原地换掉 tools 里每个工具的描述。返回描述变了的工具名。 */
export function applyToolPrompts(tools: Tool[], cfg: ToolPromptsConfig | undefined): string[] {
  const changed: string[] = [];
  for (const t of tools) {
    const next = styledDescription(t, cfg);
    if (next !== t.description) {
      t.description = next;
      changed.push(t.name);
    }
  }
  return changed;
}

/** /slots 与 session/slot 的值:风格名,加上改过的工具。 */
export function describeToolPrompts(cfg: ToolPromptsConfig | undefined): string {
  const style = cfg?.style ?? "guided";
  const edited = Object.keys(cfg?.descriptions ?? {});
  return edited.length === 0 ? style : `${style}, edited: ${edited.join(" ")}`;
}

/** 一套风格下全部工具定义的 token 估算(字符数 / 4),给 /toolprompts 的对照表。 */
export function styleTokens(tools: Tool[], cfg: ToolPromptsConfig | undefined): number {
  return tools.reduce(
    (s, t) =>
      s +
      Math.ceil(
        JSON.stringify({
          name: t.name,
          description: styledDescription(t, cfg),
          parameters: t.parameters,
        }).length / 4,
      ),
    0,
  );
}

export function isToolPromptStyle(v: string): v is ToolPromptStyle {
  return (TOOL_PROMPT_STYLES as string[]).includes(v);
}
