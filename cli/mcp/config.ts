// MCP 配置(Q87):config.json 的 mcp.servers,加上项目根 .mcp.json 的 mcpServers(与 Claude Code 同形,便于复用现成文件)。
// 同名以 config.json 为准且整条覆盖。${VAR} 与 ${VAR:-default} 展开;缺失的变量原样保留并报出来。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpConfig, McpServerConfig } from "../../src/config.js";

export type { McpConfig, McpServerConfig };

/** 展开 ${VAR} / ${VAR:-default};缺失且无缺省值的原样保留。 */
export function expandVars(
  s: string,
  env: Record<string, string | undefined> = process.env,
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const value = s.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (m, name: string, def?: string) => {
      const v = env[name];
      if (v !== undefined) return v;
      if (def !== undefined) return def;
      missing.push(name);
      return m;
    },
  );
  return { value, missing };
}

function expandRecord(
  r: Record<string, string>,
  env: Record<string, string | undefined>,
  missing: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) {
    const e = expandVars(v, env);
    out[k] = e.value;
    missing.push(...e.missing);
  }
  return out;
}

export type ResolvedServer = {
  name: string;
  config: McpServerConfig;
  missing: string[];
  source: string;
};

/** 合并两处来源并展开变量。 */
export function loadMcpServers(
  mcp: McpConfig | undefined,
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): ResolvedServer[] {
  const merged = new Map<string, { config: McpServerConfig; source: string }>();
  const projectFile = join(cwd, ".mcp.json");
  if (existsSync(projectFile)) {
    try {
      const parsed = JSON.parse(readFileSync(projectFile, "utf8")) as {
        mcpServers?: Record<string, McpServerConfig & { type?: string }>;
      };
      for (const [name, c] of Object.entries(parsed.mcpServers ?? {})) {
        const { type, ...rest } = c;
        void type;
        merged.set(name, { config: rest, source: projectFile });
      }
    } catch (err) {
      throw new Error(`failed to parse ${projectFile}: ${(err as Error).message}`);
    }
  }
  for (const [name, c] of Object.entries(mcp?.servers ?? {}))
    merged.set(name, { config: c, source: "config.json" });
  const out: ResolvedServer[] = [];
  for (const [name, { config, source }] of merged) {
    if (config.enabled === false) continue;
    const missing: string[] = [];
    const resolved: McpServerConfig = { ...config };
    if (config.args)
      resolved.args = config.args.map((a) => {
        const e = expandVars(a, env);
        missing.push(...e.missing);
        return e.value;
      });
    if (config.env) resolved.env = expandRecord(config.env, env, missing);
    if (config.headers) resolved.headers = expandRecord(config.headers, env, missing);
    if (config.url) {
      const e = expandVars(config.url, env);
      resolved.url = e.value;
      missing.push(...e.missing);
    }
    if (config.cwd) resolved.cwd = join(cwd, config.cwd);
    out.push({ name, config: resolved, missing: [...new Set(missing)], source });
  }
  return out;
}
