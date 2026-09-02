// 事件即真相(Q5 裁决):凡是进入模型请求的内容,必须可以从事件日志重建。
// 模型看到的消息永远是 deriveMessages(events) 的投影,没有第二份状态。

export type ToolCall = {
  id: string;
  name: string;
  /** 模型给出的参数,原样保留(可能不合 schema —— 校验是工具层的事,见 Q9)。 */
  args: unknown;
};

export type Usage = {
  /** 本次请求的全部输入 token(含命中缓存的部分)。 */
  inputTokens: number;
  outputTokens: number;
  /** 输入中命中缓存的部分。各家字段名不同,适配器归一到这里。 */
  cacheReadTokens?: number;
  /** 输出中属于推理(thinking)的部分。 */
  reasoningTokens?: number;
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
      /**
       * 推理内容(thinking 模型)。模型可见:带工具的多轮里,DeepSeek 要求原样回传,缺失即 400;
       * 对人也可见 —— 透明度第一,思考过程不隐藏。
       */
      reasoning?: string;
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
  | { type: "session/interrupt"; at: string }
  /** 会话中切换模型。只给人看(不投影):此后的 assistant 消息由新模型生成。 */
  | { type: "session/model"; at: string; model: string }
  | {
      /**
       * 压缩(Q31):追加事件,永不改写历史。投影读取它决定跳过什么、注入什么。
       * summary+coversFrom/coversUpTo = 摘要覆盖一段事件;cleared = 这些下标的工具结果换成占位文本。
       * 两组字段可以同时出现(pipeline 策略的产物)。
       */
      type: "compaction";
      at: string;
      summary?: string;
      /** 覆盖起点(含)。默认 1;首条用户消息豁免时为其下标+1。 */
      coversFrom?: number;
      /** 覆盖终点(不含)。events[coversFrom, coversUpTo) 被摘要取代。 */
      coversUpTo?: number;
      /** 被清除的 tool/result 事件下标。 */
      cleared?: number[];
      /** 压缩前的估算 token,审计用。 */
      tokensBefore?: number;
    };

export function now(): string {
  return new Date().toISOString();
}
