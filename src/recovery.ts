import { type AgentEvent, now, type ToolCall } from "./events.js";
import type { EventLog } from "./log.js";

type UnresolvedCall = {
  event: number;
  call: ToolCall;
  recovery?: { event: number; content: string };
  result?: { event: number; content: string };
};

/** 无结果只表示缺少证据;不能据此断言工具没有启动或没有副作用。 */
export function unresolvedCalls(
  events: readonly AgentEvent[],
  upTo = events.length,
): UnresolvedCall[] {
  const pending = new Map<string, UnresolvedCall>();
  const latest = new Map<string, string>();
  for (let i = 0; i < upTo; i++) {
    const e = events[i];
    if (e?.type === "assistant/message") {
      for (const call of e.toolCalls) {
        const key = `${i}:${call.id}`;
        pending.set(key, { event: i, call });
        latest.set(call.id, key);
      }
    } else if (e?.type === "tool/result") {
      const key = latest.get(e.callId);
      if (key) {
        const item = pending.get(key);
        if (e.outcome === "unknown" && item) item.result = { event: i, content: e.content };
        else pending.delete(key);
      }
    } else if (e?.type === "tool/unresolved") {
      const item = pending.get(`${e.callEvent}:${e.callId}`);
      if (item) item.recovery = { event: i, content: e.content };
    }
  }
  return [...pending.values()];
}

/** 显式恢复或强制退出时记录事实,不触发模型或工具;已有说明不重复追加。 */
export function recordUnresolvedCalls(log: EventLog, reason: "restore" | "exit" = "restore"): void {
  for (const { event, call, recovery, result } of unresolvedCalls(log.events)) {
    if (recovery || result) continue;
    log.append({
      type: "tool/unresolved",
      at: now(),
      callEvent: event,
      callId: call.id,
      name: call.name,
      content: `No result was recorded for this tool call ${reason === "exit" ? "when force exit was requested" : "before the session was restored"}. Its execution outcome is unknown; it may have produced side effects. No automatic retry was performed. Check the actual state before deciding whether to retry or continue, using the existing tool permissions.`,
    });
  }
}
