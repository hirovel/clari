import type { AgentEvent, Usage } from "./events.js";
import { deriveMessages } from "./messages.js";

/**
 * 上下文构成投影(Q34):当前模型可见内容按类别的 token 分布。
 * 纯函数,与消息投影同源 —— 展示的就是将要发送的,没有第二套口径。
 * token 是 chars/4 估算(Q30);若有最近一次请求的实测 usage,一并带回供对照。
 */
export type ContextPart = {
  label: string;
  tokens: number;
  /** 占估算总量的比例,0-1。 */
  share: number;
  count: number;
};

export type ContextBreakdown = {
  parts: ContextPart[];
  /** 估算总量(chars/4)。 */
  estimatedTokens: number;
  window: number;
  /** 估算总量 / 窗口。 */
  usedShare: number;
  /** 最近一次请求的实测输入 token,来自 API usage;无请求时缺省。 */
  measuredTokens?: number;
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function contextBreakdown(events: readonly AgentEvent[], window: number): ContextBreakdown {
  const buckets = new Map<string, { tokens: number; count: number }>();
  const add = (label: string, tokens: number) => {
    const b = buckets.get(label) ?? { tokens: 0, count: 0 };
    b.tokens += tokens;
    b.count += 1;
    buckets.set(label, b);
  };

  for (const m of deriveMessages(events)) {
    switch (m.role) {
      case "system":
        add("system prompt", estimateTokens(m.content));
        break;
      case "user":
        add("user messages", estimateTokens(m.content));
        break;
      case "assistant":
        add(
          "assistant messages",
          estimateTokens(m.content) +
            m.toolCalls.reduce((n, tc) => n + estimateTokens(JSON.stringify(tc.args)) + 8, 0),
        );
        break;
      case "tool":
        add(`tool results ${m.name}`, estimateTokens(m.content));
        break;
    }
  }

  const estimatedTokens = [...buckets.values()].reduce((n, b) => n + b.tokens, 0);
  const measured = lastUsage(events);
  const parts = [...buckets.entries()]
    .map(([label, b]) => ({
      label,
      tokens: b.tokens,
      share: estimatedTokens > 0 ? b.tokens / estimatedTokens : 0,
      count: b.count,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  return {
    parts,
    estimatedTokens,
    window,
    usedShare: window > 0 ? estimatedTokens / window : 0,
    ...(measured && { measuredTokens: measured.inputTokens }),
  };
}

function lastUsage(events: readonly AgentEvent[]): Usage | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "assistant/message" && e.usage) return e.usage;
  }
  return undefined;
}
