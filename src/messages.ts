import type { AgentEvent, ToolCall } from "./events.js";

/**
 * 内部消息模型(Q4b 裁决):自有类型,不绑任何 provider 的 wire 格式。
 * 它只描述"模型将看到什么",翻译成 OpenAI/Anthropic 格式是适配器的事。
 */
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; callId: string; name: string; content: string; isError: boolean };

/**
 * 唯一的状态投影:事件日志 → 模型可见的消息序列。
 * 纯函数(同一日志永远投出同一序列),回放与测试都建立在这条性质上。
 *
 * interrupt 事件不投影 —— 打断本身不是模型可见内容;打断造成的后果
 * (半截 assistant 消息、未执行工具的 aborted result)由循环写成事件,自然被投影。
 */
export function deriveMessages(events: readonly AgentEvent[]): Message[] {
  const messages: Message[] = [];
  for (const e of events) {
    switch (e.type) {
      case "session/start":
        messages.push({ role: "system", content: e.system });
        break;
      case "user/message":
        messages.push({ role: "user", content: e.text });
        break;
      case "assistant/message":
        messages.push({ role: "assistant", content: e.text, toolCalls: e.toolCalls });
        break;
      case "tool/result":
        messages.push({
          role: "tool",
          callId: e.callId,
          name: e.name,
          content: e.content,
          isError: e.isError,
        });
        break;
      case "session/interrupt":
        break;
    }
  }
  return messages;
}
