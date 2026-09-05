// MCP 工具桥接(Q87):每个 MCP 工具映射成内核的 Tool,名字 mcp__<server>__<tool>;
// 服务器的启动、失败、每次往返、stderr、工具表变化都记成 ext/event(source "mcp")。内核不知道 MCP 的存在。
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TSchema } from "@sinclair/typebox";
import { type AgentEvent, now } from "../../src/events.js";
import type { EventLog } from "../../src/log.js";
import type { Tool } from "../../src/tools.js";
import {
  McpClient,
  type McpClient as McpClientType,
  type McpContent,
  type McpToolDef,
} from "./client.js";
import type { McpConfig, ResolvedServer } from "./config.js";

export type McpServerStatus = {
  name: string;
  phase: "ready" | "failed" | "closed";
  transport: "stdio" | "http";
  era?: "modern" | "legacy";
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  toolCount: number;
  error?: string;
  ms: number;
  missingVars: string[];
};

export type McpBridge = {
  statuses(): McpServerStatus[];
  /** 全部工具名(桥接后的)。 */
  toolNames(): string[];
  close(): Promise<void>;
};

/** 桥接记的四种事件,装在 ext/event 的 payload 里;kind 是判别字段。 */
export type McpEvent =
  | {
      kind: "server";
      server: string;
      phase: "starting" | "ready" | "failed" | "closed";
      transport: "stdio" | "http";
      era?: "modern" | "legacy";
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
      toolCount?: number;
      /** 服务器列出的工具数(过滤前)。 */
      listed?: number;
      instructions?: string;
      error?: string;
      warning?: string;
      ms?: number;
    }
  | {
      kind: "rpc";
      server: string;
      direction: "send" | "receive";
      method?: string;
      id?: number | string;
      bytes: number;
      /** 原文,Authorization 已遮蔽。 */
      body: string;
    }
  | { kind: "log"; server: string; line: string }
  | { kind: "tools"; server: string; added: string[]; removed: string[]; total: number };

function emit(log: EventLog, ev: McpEvent): void {
  const { kind, ...payload } = ev;
  log.append({ type: "ext/event", at: now(), source: "mcp", kind, payload });
}

/** 从日志事件读回桥接事件;不是 MCP 的返回 undefined。 */
export function mcpEvent(e: AgentEvent): McpEvent | undefined {
  if (e.type !== "ext/event" || e.source !== "mcp") return undefined;
  return { kind: e.kind, ...e.payload } as McpEvent;
}

/** 主屏与检视器的一行;rpc 与 log 不上屏(检视器的事件视图有全文)。 */
export function renderMcpEvent(
  e: AgentEvent,
): { tone: "jin" | "zhu" | "faint"; text: string } | undefined {
  const m = mcpEvent(e);
  if (!m) return undefined;
  if (m.kind === "server") {
    if (m.phase === "ready")
      return {
        tone: "jin",
        text: `◇ mcp ${m.server}: ready · ${m.transport} · ${m.era ?? ""} ${m.protocolVersion ?? ""} · ${m.toolCount ?? 0} tools${m.listed !== undefined && m.listed !== m.toolCount ? ` of ${m.listed} listed` : ""} · ${m.ms ?? 0}ms`,
      };
    if (m.phase === "failed" || m.phase === "closed")
      return {
        tone: "zhu",
        text: `◇ mcp ${m.server}: ${m.phase}${m.error ? ` · ${m.error}` : ""}`,
      };
    if (m.warning) return { tone: "faint", text: `· mcp ${m.server}: ${m.warning}` };
    return undefined;
  }
  if (m.kind === "tools") {
    if (m.added.length + m.removed.length === 0 || m.total === m.added.length) return undefined;
    return {
      tone: "jin",
      text: `◇ mcp ${m.server}: tools changed · +${m.added.length} −${m.removed.length} · ${m.total} total · applies from the next request`,
    };
  }
  return undefined;
}

const MAX_NAME = 128;

export function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** 桥接后的工具名:mcp__server__tool;超过 128 就截断并附 sha1 前 12 位。 */
export function bridgedName(server: string, tool: string): string {
  const full = `mcp__${sanitizeName(server)}__${sanitizeName(tool)}`;
  if (full.length <= MAX_NAME) return full;
  const hash = createHash("sha1").update(`${server}/${tool}`).digest("hex").slice(0, 12);
  return `${full.slice(0, MAX_NAME - 13)}_${hash}`;
}

function wildcard(pattern: string): RegExp {
  return new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
}

export function toolAllowed(name: string, enabled?: string[], disabled?: string[]): boolean {
  if (enabled && enabled.length > 0 && !enabled.some((p) => wildcard(p).test(name))) return false;
  if (disabled?.some((p) => wildcard(p).test(name))) return false;
  return true;
}

function redact(message: unknown): string {
  return JSON.stringify(message, (k, v) =>
    k.toLowerCase() === "authorization" && typeof v === "string" ? "<redacted>" : v,
  );
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
};

/** 工具结果 content[] → 文本。二进制块落盘(有目录时),文本里留一行路径。 */
export function contentToText(
  content: McpContent[],
  opts: { dir?: string; callId?: string } = {},
): string {
  const parts: string[] = [];
  content.forEach((c, i) => {
    if (c.type === "text") parts.push((c as { text: string }).text);
    else if (c.type === "image" || c.type === "audio") {
      const b = c as { data: string; mimeType: string };
      const bytes = Buffer.from(b.data, "base64");
      if (opts.dir) {
        mkdirSync(opts.dir, { recursive: true });
        const file = join(opts.dir, `${opts.callId ?? "result"}-${i}.${EXT[b.mimeType] ?? "bin"}`);
        writeFileSync(file, bytes);
        parts.push(`[${c.type} ${b.mimeType}, ${bytes.length} bytes, saved to ${file}]`);
      } else parts.push(`[${c.type} ${b.mimeType}, ${bytes.length} bytes, not saved]`);
    } else if (c.type === "resource") {
      const r = (c as { resource: { uri: string; text?: string; mimeType?: string } }).resource;
      parts.push(
        r.text !== undefined
          ? `[resource ${r.uri}]\n${r.text}`
          : `[resource ${r.uri}${r.mimeType ? ` ${r.mimeType}` : ""}, binary not inlined]`,
      );
    } else if (c.type === "resource_link") {
      const l = c as { uri: string; name?: string };
      parts.push(`[resource link ${l.name ? `${l.name} ` : ""}${l.uri}]`);
    } else parts.push(`[${c.type} content, not rendered]`);
  });
  return parts.join("\n");
}

export type ConnectOptions = {
  log: EventLog;
  /** 二进制结果落盘目录;没有就不落盘。 */
  artifactsDir?: string;
  /** 被桥接的工具追加到这里(原地改,list_changed 时也原地换)。 */
  tools: Tool[];
  mcp?: McpConfig;
  clientVersion?: string;
  /** 测试注入:自定义客户端工厂。 */
  createClient?: (
    server: ResolvedServer,
    opts: ConstructorParameters<typeof McpClient>[2],
  ) => McpClientType;
};

/** 连接全部服务器。required 的失败抛错;其余失败只记事件。 */
export async function connectMcpServers(
  servers: ResolvedServer[],
  opts: ConnectOptions,
): Promise<McpBridge> {
  const { log, tools } = opts;
  const maxChars = opts.mcp?.maxResultChars ?? 100000;
  const statuses: McpServerStatus[] = [];
  const clients: McpClient[] = [];
  const owned = new Map<string, string[]>();

  const bridge = (server: ResolvedServer, client: McpClient, def: McpToolDef): Tool => ({
    name: bridgedName(server.name, def.name),
    description: def.description ?? def.title ?? "",
    parameters: (def.inputSchema ?? { type: "object", properties: {} }) as unknown as TSchema,
    concurrency: "sequential",
    async execute(args, ctx) {
      const r = await client.callTool(def.name, args, {
        signal: ctx.signal,
        timeoutMs: server.config.toolTimeoutMs ?? 60000,
      });
      let text = contentToText(r.content, {
        ...(opts.artifactsDir && { dir: opts.artifactsDir }),
        ...(ctx.callId && { callId: ctx.callId }),
      });
      if (r.structuredContent !== undefined && !text.trim())
        text = JSON.stringify(r.structuredContent, null, 2);
      if (text.length > maxChars)
        text = `${text.slice(0, maxChars)}\n[truncated to ${maxChars} chars of ${text.length}]`;
      if (r.isError) throw new Error(text || "tool reported an error without a message");
      return text;
    },
  });

  const install = (server: ResolvedServer, client: McpClient, defs: McpToolDef[]): string[] => {
    const before = owned.get(server.name) ?? [];
    const kept = defs.filter((d) =>
      toolAllowed(d.name, server.config.enabledTools, server.config.disabledTools),
    );
    const fresh = kept.map((d) => bridge(server, client, d));
    const names = fresh.map((t) => t.name);
    for (let i = tools.length - 1; i >= 0; i--)
      if (before.includes(tools[i]?.name ?? "")) tools.splice(i, 1);
    tools.push(...fresh);
    owned.set(server.name, names);
    const added = names.filter((n) => !before.includes(n));
    const removed = before.filter((n) => !names.includes(n));
    if (before.length > 0 || added.length > 0)
      emit(log, { kind: "tools", server: server.name, added, removed, total: names.length });
    return names;
  };

  for (const server of servers) {
    const started = Date.now();
    const transport: "stdio" | "http" = server.config.url ? "http" : "stdio";
    const status: McpServerStatus = {
      name: server.name,
      phase: "failed",
      transport,
      toolCount: 0,
      ms: 0,
      missingVars: server.missing,
    };
    statuses.push(status);
    emit(log, {
      kind: "server",
      server: server.name,
      phase: "starting",
      transport,
      ...(server.missing.length > 0 && {
        warning: `unset variables kept as-is: ${server.missing.join(", ")}`,
      }),
    });
    const clientOpts: ConstructorParameters<typeof McpClient>[2] = {
      ...(opts.clientVersion && { clientVersion: opts.clientVersion }),
      ...(opts.mcp?.protocolVersions && { protocolVersions: opts.mcp.protocolVersions }),
      requestTimeoutMs: server.config.toolTimeoutMs ?? 60000,
      onRpc: (direction, message) => {
        const body = redact(message);
        emit(log, {
          kind: "rpc",
          server: server.name,
          direction,
          ...(message.method && { method: message.method }),
          ...(message.id !== undefined && { id: message.id }),
          bytes: Buffer.byteLength(body),
          body: body.length > maxChars ? `${body.slice(0, maxChars)}…` : body,
        });
      },
      onLog: (line) => emit(log, { kind: "log", server: server.name, line }),
      onNotification: (method) => {
        if (method === "notifications/tools/list_changed") {
          client
            .listTools()
            .then((defs) => {
              const names = install(server, client, defs);
              status.toolCount = names.length;
            })
            .catch((err) =>
              emit(log, {
                kind: "log",
                server: server.name,
                line: `tools/list after list_changed failed: ${(err as Error).message}`,
              }),
            );
        }
      },
      onExit: (code, signal) => {
        if (status.phase === "ready") {
          status.phase = "closed";
          status.error = `process exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`;
          emit(log, {
            kind: "server",
            server: server.name,
            phase: "closed",
            transport,
            error: status.error,
          });
        }
      },
    };
    const transportCfg = server.config.url
      ? { url: server.config.url, ...(server.config.headers && { headers: server.config.headers }) }
      : {
          command: server.config.command ?? "",
          ...(server.config.args && { args: server.config.args }),
          ...(server.config.env && { env: server.config.env }),
          ...(server.config.cwd && { cwd: server.config.cwd }),
        };
    const client = opts.createClient
      ? (opts.createClient(server, clientOpts) as McpClient)
      : new McpClient(server.name, transportCfg, clientOpts);
    clients.push(client);
    try {
      if (!server.config.url && !server.config.command)
        throw new Error("server needs either command (stdio) or url (http)");
      const info = await client.connect(server.config.startupTimeoutMs ?? 10000);
      const defs = await client.listTools();
      const names = install(server, client, defs);
      Object.assign(status, {
        phase: "ready",
        era: info.era,
        protocolVersion: info.protocolVersion,
        ...(info.serverInfo && { serverInfo: info.serverInfo }),
        toolCount: names.length,
        ms: Date.now() - started,
      });
      emit(log, {
        kind: "server",
        server: server.name,
        phase: "ready",
        transport,
        era: info.era,
        protocolVersion: info.protocolVersion,
        ...(info.serverInfo && { serverInfo: info.serverInfo }),
        toolCount: names.length,
        listed: defs.length,
        ms: status.ms,
        ...(info.instructions && { instructions: info.instructions }),
      });
    } catch (err) {
      status.error = (err as Error).message;
      status.ms = Date.now() - started;
      emit(log, {
        kind: "server",
        server: server.name,
        phase: "failed",
        transport,
        error: status.error,
        ms: status.ms,
      });
      await client.close().catch(() => {});
      if (server.config.required)
        throw new Error(`mcp server ${server.name} is required but failed: ${status.error}`);
    }
  }

  return {
    statuses: () => statuses,
    toolNames: () => [...owned.values()].flat(),
    close: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
      for (const s of statuses) if (s.phase === "ready") s.phase = "closed";
    },
  };
}

/** 一行状态,/mcp 与 /slots 用。 */
export function describeStatus(s: McpServerStatus): string {
  const head = `${s.name.padEnd(12)} ${s.phase.padEnd(7)}`;
  if (s.phase === "failed") return `${head} ${s.error ?? "unknown error"} (${s.ms}ms)`;
  const info = [
    s.transport,
    s.era ?? "",
    s.protocolVersion ?? "",
    `${s.toolCount} tools`,
    `${s.ms}ms`,
  ]
    .filter(Boolean)
    .join(" · ");
  return `${head} ${info}${s.error ? ` · ${s.error}` : ""}${s.missingVars.length > 0 ? ` · unset: ${s.missingVars.join(", ")}` : ""}`;
}
