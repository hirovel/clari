// 事件即真相(Q5 裁决):凡是进入模型请求的内容,必须可以从事件日志重建。
// 模型看到的消息永远是 deriveMessages(events) 的投影,没有第二份状态。

export type ToolCall = {
  id: string;
  name: string;
  /** 模型给出的参数,原样保留(可能不合 schema —— 校验是工具层的事,见 Q9)。 */
  args: unknown;
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
};

export type StopReason =
  | "end" // 模型自然结束,不再调工具 —— 循环的终点(Q8 untilIdle)
  | "tool" // 模型请求了工具调用,循环继续
  | "aborted" // 用户打断(Q11):已流出的半截文本仍然入日志,不丢真相
  | "length"; // 输出被 token 上限截断(Q26):工具调用一律不执行,回喂重发指令

export type AgentEvent =
  | {
      type: "session/start";
      at: string;
      model: string;
      /** 解析后的完整系统提示词。入日志的理由:模型可见即必须入日志。 */
      system: string;
    }
  | { type: "user/message"; at: string; text: string }
  | {
      type: "assistant/message";
      at: string;
      text: string;
      toolCalls: ToolCall[];
      stopReason: StopReason;
      usage?: Usage;
    }
  | {
      type: "tool/result";
      at: string;
      callId: string;
      name: string;
      content: string;
      /** 错误也是结果(Q9):校验失败/执行异常/被打断,一律以 result 回喂,不抛出循环。 */
      isError: boolean;
    }
  | { type: "session/interrupt"; at: string };

export function now(): string {
  return new Date().toISOString();
}
