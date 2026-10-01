import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, updateConfig } from "../../src/config.js";
import { type ProjectMcpFile, readProjectMcpFile } from "./config.js";

export type ProjectMcpReview = {
  file: string;
  root: string;
  digest: string;
  snapshot: ProjectMcpFile;
  servers: {
    name: string;
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    envKeys?: string[];
    headerKeys?: string[];
  }[];
};

/** 用文件原文计算信任版本;展示原始参数,不展开可能含密钥的环境变量。 */
export function projectMcpReview(cwd: string): ProjectMcpReview | undefined {
  const snapshot = readProjectMcpFile(cwd);
  if (!snapshot) return undefined;
  const servers = Object.entries(snapshot.servers)
    .filter(([, config]) => config.enabled !== false)
    .map(([name, config]) => ({
      name,
      ...(config.command && { command: config.command }),
      ...(config.args && { args: config.args }),
      ...(config.cwd && { cwd: config.cwd }),
      ...(config.url && { url: config.url }),
      ...(config.env && { envKeys: Object.keys(config.env) }),
      ...(config.headers && { headerKeys: Object.keys(config.headers) }),
    }));
  return {
    file: snapshot.file,
    root: process.platform === "win32" ? realpathSync(cwd).toLowerCase() : realpathSync(cwd),
    digest: createHash("sha256").update(snapshot.raw).digest("hex"),
    snapshot,
    servers,
  };
}

export function projectMcpTrusted(review: ProjectMcpReview): boolean {
  const trusted = loadConfig().config.mcp?.trustedProjects as Record<string, string> | undefined;
  return trusted?.[review.root] === review.digest;
}

export function trustProjectMcp(review: ProjectMcpReview): void {
  if (projectMcpReview(resolve(review.root))?.digest !== review.digest)
    throw new Error(`${review.file} changed during review; inspect it again before connecting`);
  updateConfig((current) => ({
    ...current,
    mcp: {
      ...current.mcp,
      trustedProjects: {
        ...(current.mcp?.trustedProjects as Record<string, string> | undefined),
        [review.root]: review.digest,
      },
    },
  }));
}
