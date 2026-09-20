// 连接持有协议状态,会话持有日志和工具包装。引用归零才关闭,候选会话失败不影响原会话。
import { AsyncLocalStorage } from "node:async_hooks";
import { now } from "../../src/events.js";
import type { EventLog } from "../../src/log.js";
import type { McpEvent, McpServerStatus } from "./bridge.js";
import { McpClient, type McpClientOptions, type McpToolDef } from "./client.js";
import type { McpConfig, ResolvedServer } from "./config.js";

export type ConnectionOptions = {
  log: EventLog;
  mcp?: McpConfig;
  clientVersion?: string;
  createClient?: (server: ResolvedServer, opts: McpClientOptions) => McpClient;
};

export class Connection {
  readonly status: McpServerStatus;
  readonly client: McpClient;
  definitions: McpToolDef[] = [];
  readonly listeners = new Set<() => void>();
  references = 0;
  active: EventLog | undefined;
  private readonly scope = new AsyncLocalStorage<EventLog>();
  private readonly requests = new Map<number | string, EventLog>();
  private closing: Promise<void> | undefined;
  private refresh: Promise<void> | undefined;
  private refreshAgain = false;

  constructor(
    readonly key: string,
    readonly server: ResolvedServer,
    opts: ConnectionOptions,
  ) {
    this.active = opts.log;
    this.status = {
      name: server.name,
      phase: "failed",
      transport: server.config.url ? "http" : "stdio",
      toolCount: 0,
      ms: 0,
      missingVars: server.missing,
    };
    const clientOpts: McpClientOptions = {
      ...(opts.clientVersion && { clientVersion: opts.clientVersion }),
      ...(opts.mcp?.protocolVersions && { protocolVersions: opts.mcp.protocolVersions }),
      requestTimeoutMs: server.config.toolTimeoutMs ?? 60000,
      onRpc: (direction, message) => {
        const id = message.id;
        const response = direction === "receive" && !message.method && id !== undefined;
        const log =
          direction === "send"
            ? (this.scope.getStore() ?? this.active)
            : response
              ? this.requests.get(id)
              : this.active;
        if (direction === "send" && message.method && id !== undefined && log)
          this.requests.set(id, log);
        if (response) this.requests.delete(id);
        // 已结束请求的迟到响应与客户端的 pending 表一致丢弃,不串到后来激活的会话。
        if (!log) return;
        const body = JSON.stringify(message, (k, v) =>
          k.toLowerCase() === "authorization" ? "<redacted>" : v,
        );
        const limit = opts.mcp?.maxResultChars ?? 100000;
        this.emit(
          {
            kind: "rpc",
            server: server.name,
            direction,
            ...(message.method && { method: message.method }),
            ...(id !== undefined && { id }),
            bytes: Buffer.byteLength(body),
            body: body.length > limit ? `${body.slice(0, limit)}…` : body,
          },
          log,
        );
      },
      onRequestSettled: (id) => this.requests.delete(id),
      onLog: (line) => this.emit({ kind: "log", server: server.name, line }),
      onNotification: (method) => {
        if (method === "notifications/tools/list_changed") void this.refreshTools();
      },
      onExit: (code, signal) => {
        if (this.status.phase !== "ready") return;
        this.status.phase = "closed";
        this.status.error = `process exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`;
        this.emit({
          kind: "server",
          server: server.name,
          phase: "closed",
          transport: this.status.transport,
          error: this.status.error,
        });
      },
    };
    const c = server.config;
    const transport = c.url
      ? { url: c.url, ...(c.headers && { headers: c.headers }) }
      : {
          command: c.command ?? "",
          ...(c.args && { args: c.args }),
          ...(c.env && { env: c.env }),
          ...(c.cwd && { cwd: c.cwd }),
        };
    this.client =
      opts.createClient?.(server, clientOpts) ?? new McpClient(server.name, transport, clientOpts);
  }

  emit(event: McpEvent, log = this.active): void {
    const { kind, ...payload } = event;
    log?.append({ type: "ext/event", at: now(), source: "mcp", kind, payload });
  }

  async connect(): Promise<void> {
    const started = Date.now();
    const { name, config, missing } = this.server;
    this.emit({
      kind: "server",
      server: name,
      phase: "starting",
      transport: this.status.transport,
      ...(missing.length && { warning: `unset variables kept as-is: ${missing.join(", ")}` }),
    });
    try {
      if (!config.url && !config.command)
        throw new Error("server needs either command (stdio) or url (http)");
      const info = await this.client.connect(config.startupTimeoutMs ?? 10000);
      this.definitions = await this.client.listTools();
      Object.assign(this.status, info, {
        phase: "ready",
        toolCount: this.definitions.length,
        ms: Date.now() - started,
      });
    } catch (error) {
      this.status.error = (error as Error).message;
      this.status.ms = Date.now() - started;
      this.emit({
        kind: "server",
        server: name,
        phase: "failed",
        transport: this.status.transport,
        error: this.status.error,
        ms: this.status.ms,
      });
      await this.close();
      throw error;
    }
  }

  private refreshTools(): Promise<void> {
    this.refreshAgain = true;
    this.refresh ??= (async () => {
      while (this.refreshAgain && !this.closing) {
        this.refreshAgain = false;
        try {
          const definitions = await this.client.listTools();
          if (this.closing) return;
          this.definitions = definitions;
          for (const listener of this.listeners) listener();
        } catch (error) {
          this.emit({
            kind: "log",
            server: this.server.name,
            line: `tools/list after list_changed failed: ${(error as Error).message}`,
          });
        }
      }
    })().finally(() => {
      this.refresh = undefined;
    });
    return this.refresh;
  }

  call(log: EventLog, name: string, args: unknown, signal: AbortSignal, timeoutMs: number) {
    return this.scope.run(log, () => this.client.callTool(name, args, { signal, timeoutMs }));
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.client.close();
      if (this.status.phase === "ready") this.status.phase = "closed";
      this.requests.clear();
      this.active = undefined;
      this.listeners.clear();
    })();
    return this.closing;
  }
}

/** 仅缓存仍被会话持有的连接;未激活的候选会话也持有引用,可以安全回滚。 */
export class McpConnections {
  private readonly entries = new Set<Connection>();
  private closed = false;
  async acquire(server: ResolvedServer, opts: ConnectionOptions, reconnect = false) {
    if (this.closed) throw new Error("MCP connections are closed");
    const {
      enabledTools: _enabled,
      disabledTools: _disabled,
      required: _required,
      ...identity
    } = server.config;
    const canonical = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(canonical)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => [k, canonical(v)]),
            )
          : value;
    const key = JSON.stringify(
      canonical({
        name: server.name,
        identity,
        protocolVersions: opts.mcp?.protocolVersions,
        maxResultChars: opts.mcp?.maxResultChars,
        clientVersion: opts.clientVersion,
      }),
    );
    const existing =
      !reconnect && [...this.entries].find((c) => c.key === key && c.status.phase === "ready");
    if (existing) {
      existing.references++;
      return { connection: existing, reused: true };
    }
    const connection = new Connection(key, server, opts);
    await connection.connect();
    if (this.closed) {
      await connection.close();
      throw new Error("MCP connections closed during preparation");
    }
    connection.references = 1;
    this.entries.add(connection);
    return { connection, reused: false };
  }

  async release(connection: Connection): Promise<void> {
    connection.references--;
    if (connection.references > 0) return;
    this.entries.delete(connection);
    await connection.close();
  }

  async close(): Promise<void> {
    this.closed = true;
    const entries = [...this.entries];
    this.entries.clear();
    const results = await Promise.allSettled(entries.map((c) => c.close()));
    const errors = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    if (errors.length) throw new AggregateError(errors, "MCP connection cleanup failed");
  }
}
