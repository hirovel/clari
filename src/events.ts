// 事件即真相(Q5 裁决):凡是进入模型请求的内容,必须可以从事件日志重建。
// 模型看到的消息永远是 deriveMessages(events) 的投影,没有第二份状态。

import type { Message } from "./messages.js";

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
  /** 输入中本次写入缓存的部分(Anthropic 单独计价)。 */
  cacheWriteTokens?: number;
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
      /** 系统提示词的分段构成(名称、来源、字符数),只给人看:检视器与 /context 据此按段拆分。 */
      sections?: { name: string; source?: string; chars: number }[];
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
      /**
       * reasoning 是什么:full = 模型真正读回去的那份全文(DeepSeek、Anthropic 预算模式);
       * summary = 只是给人看的摘要,模型读的正文在 opaque 里(Anthropic 自适应模式、OpenAI Responses)。
       * 决定了这段思考能不能被编辑来引导模型:只有 full 改了才有意义。
       */
      reasoningKind?: "full" | "summary";
      /**
       * 适配器私有回传物(Q53):下一轮必须原样送回、内核不解释的东西(如 Anthropic 带签名的 thinking 块)。
       * 模型可见(它会进入请求),所以必须入日志;写它和读它的是同一个适配器。
       */
      opaque?: unknown;
      /** 从发出请求到收齐响应的毫秒数。只给人看。 */
      latencyMs?: number;
      /**
       * 供应商返回的、内核不解释的元数据(Q82):响应 id、实际服务的模型、原始停止原因、stop_sequence、
       * system_fingerprint 之类。只给人看;原样保存,排查"软件自己处理出问题"时对照 raw 用。
       */
      extras?: Record<string, unknown>;
    }
  | {
      type: "tool/result";
      at: string;
      callId: string;
      name: string;
      content: string;
      /** 错误也是结果(Q9):校验失败/执行异常/被打断,一律以 result 回喂,不抛出循环。 */
      isError: boolean;
      /** 工具执行耗时;未执行(拒绝/校验失败/打断)时缺省。只给人看。 */
      durationMs?: number;
    }
  | { type: "session/interrupt"; at: string }
  /**
   * 恢复会话时发现日志末尾有一行没写完(进程被杀在写入中途),截掉了它。只给人看。
   * 半行只可能在末尾;中间的坏行仍然报错,因为那不是崩溃能造成的。
   */
  | { type: "session/recovered"; at: string; droppedBytes: number; preview: string }
  /** 会话中切换模型。只给人看(不投影):此后的 assistant 消息由新模型生成。 */
  | { type: "session/model"; at: string; model: string }
  /**
   * 会话中切换了某个策略槽(Q78)。只给人看:此后的步按新策略走。
   * slot 是槽名(compaction / preservation / execution / steering / approve),value 是新实现的名字与参数。
   */
  | { type: "session/slot"; at: string; slot: string; value: string }
  /**
   * 一次模型请求即将发出。只给人看。紧随其后的 assistant/message 就是它的响应
   * (中间可能夹 retry 事件;失败则以 request/error 收尾)。
   * 请求正文不重复落盘:它等于 deriveMessages(此事件之前的全部事件),投影是纯函数,随时可以原样重建。
   */
  | {
      type: "request";
      at: string;
      model: string;
      /** 投影出的消息条数。 */
      messages: number;
      /** 随请求发出的工具名。 */
      tools: string[];
      /** 发送前的估算 token(与自动压缩检查同一口径)。 */
      estimatedTokens: number;
      /** 自动压缩阈值;未配置压缩时缺省。 */
      threshold?: number;
      /** turn = 正常步;overflow-retry = 溢出压缩后的那一次重发;compaction = 压缩策略发出的摘要请求。 */
      reason: "turn" | "overflow-retry" | "compaction";
      /** 请求的强度级别(Q52);未设置时缺省,请求里也没有强度参数。 */
      effort?: string;
      /**
       * 正常步不记正文(它就是此前事件的投影)。策略自己发的请求(压缩摘要)发的不是纯投影,
       * 记下差异部分:前 prefixEvents 条事件的投影 + tail 里的消息 = 实际发出的全部消息。
       */
      body?: { prefixEvents: number; tail: Message[] };
    }
  /** 同一请求内的一次重试(退避等待之前记录)。只给人看。 */
  | {
      type: "retry";
      at: string;
      attempt: number;
      delayMs: number;
      error: string;
      status?: number;
    }
  /**
   * 请求最终失败(重试用尽或不可重试)。只给人看;循环随后抛出。
   * kind 是分类(鉴权、模型不存在、限流、溢出、请求错误、服务端、网络、流、打断),界面据此给下一步;
   * provider 是供应商响应体里的原话;body 是响应体原文(截到 4 KiB),排查软件自身问题时看它。
   */
  | {
      type: "request/error";
      at: string;
      error: string;
      status?: number;
      kind?: string;
      provider?: string;
      body?: string;
    }
  /**
   * 策略槽做出的、改变了走向的决定。只给人看。
   * 内核按端到端原则只有这几处会"做决定",全部记录下来,检视器据此证明中间层没有藏聪明。
   */
  | {
      type: "decision";
      at: string;
      slot: "steering";
      boundary: "step" | "turn";
      /** 本次注入的留言条数(随后的 user/message 事件即其内容)。 */
      injected: number;
    }
  | { type: "decision"; at: string; slot: "termination"; steps: number; reason: string }
  /** 执行槽把一批工具调用并行跑了(只在并行策略下、且批内多于一个调用时记)。 */
  | { type: "decision"; at: string; slot: "execution"; parallel: number; tools: string[] }
  /**
   * 编辑上下文(Q74):追加事件,不改写历史。投影把目标事件的某个字段换成新值;原文永远留在数组里。
   * 被编辑的消息不再带私有回传物(签名或密文与改后的内容不再对应);Anthropic 还会丢弃之后所有消息的思考块。
   * reasoning 只在该消息 reasoningKind 为 full 时允许编辑(摘要改了模型也看不见)。
   */
  | {
      type: "context/edit";
      at: string;
      /** 目标事件下标。 */
      target: number;
      /** 改哪个字段:text / reasoning 对 assistant;content 对 tool/result 与 user/message;system 对 session/start。 */
      field: "text" | "reasoning" | "content" | "system";
      value: string;
      note?: string;
    }
  /** 丢弃一条消息(Q74):user/message,或 assistant/message 连同它的全部工具结果。投影跳过它们。 */
  | { type: "context/drop"; at: string; target: number; note?: string }
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
      /** 摘要请求的用量与耗时(有 LLM 调用的策略才有)。只给人看。 */
      usage?: Usage;
      latencyMs?: number;
      /** 是哪个策略、什么参数做的这次压缩,如 llmSummarize(structuredFull, replay)。只给人看。 */
      strategy?: string;
    };

export function now(): string {
  return new Date().toISOString();
}
