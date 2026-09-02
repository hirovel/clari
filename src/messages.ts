import type { AgentEvent, ToolCall } from "./events.js";

/**
 * 内部消息模型(Q4b 裁决):自有类型,不绑任何 provider 的 wire 格式。
 * 它只描述"模型将看到什么",翻译成 OpenAI/Anthropic 格式是适配器的事。
 */
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[]; reasoning?: string }
  | { role: "tool"; callId: string; name: string; content: string; isError: boolean };

export const CLEARED_PLACEHOLDER = "[此工具结果已被清除以节省上下文;原文完整保留在会话日志中]";

/** 从事件里汇总当前生效的压缩状态:摘要覆盖范围 + 被清除的工具结果下标。 */
export function compactionState(events: readonly AgentEvent[]): {
  summary?: string;
  coversFrom: number;
  coversUpTo: number;
  cleared: Set<number>;
} {
  let summary: string | undefined;
  let coversFrom = 1;
  let coversUpTo = 0;
  const cleared = new Set<number>();
  for (const e of events) {
    if (e.type !== "compaction") continue;
    if (e.summary && (e.coversUpTo ?? 0) > coversUpTo) {
      summary = e.summary;
      coversUpTo = e.coversUpTo ?? 0;
      coversFrom = e.coversFrom ?? 1;
    }
    for (const idx of e.cleared ?? []) cleared.add(idx);
  }
  return { ...(summary && { summary }), coversFrom, coversUpTo, cleared };
}

/**
 * 唯一的状态投影:事件日志 → 模型可见的消息序列。
 * 纯函数(同一日志永远投出同一序列),回放与测试都建立在这条性质上。
 *
 * interrupt 事件不投影 —— 打断本身不是模型可见内容。
 * compaction 事件不直接投影,但决定投影:被覆盖的事件跳过、在覆盖起点注入摘要、
 * 被清除的工具结果换成占位文本(Q31/Q32)。
 */
export function deriveMessages(events: readonly AgentEvent[]): Message[] {
  const c = compactionState(events);
  const messages: Message[] = [];
  for (let i = 0; i < events.length; i++) {
    if (c.summary && i === c.coversFrom) {
      messages.push({ role: "user", content: `[会话前段已压缩,以下为摘要]\n${c.summary}` });
    }
    if (c.summary && i >= c.coversFrom && i < c.coversUpTo) continue;
    const e = events[i];
    if (!e) continue;
    switch (e.type) {
      case "session/start":
        messages.push({ role: "system", content: e.system });
        break;
      case "user/message":
        messages.push({ role: "user", content: e.text });
        break;
      case "assistant/message":
        messages.push({
          role: "assistant",
          content: e.text,
          toolCalls: e.toolCalls,
          ...(e.reasoning && { reasoning: e.reasoning }),
        });
        break;
      case "tool/result":
        messages.push({
          role: "tool",
          callId: e.callId,
          name: e.name,
          content: c.cleared.has(i) ? CLEARED_PLACEHOLDER : e.content,
          isError: e.isError,
        });
        break;
      case "session/interrupt":
      case "session/model":
      case "compaction":
        break;
    }
  }
  return messages;
}
