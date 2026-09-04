import type { AgentEvent, ToolCall } from "./events.js";

/**
 * 内部消息模型(Q4b 裁决):自有类型,不绑任何 provider 的 wire 格式。
 * 它只描述"模型将看到什么",翻译成 OpenAI/Anthropic 格式是适配器的事。
 */
export type Message =
  | { role: "system"; content: string; edited?: true }
  | { role: "user"; content: string; edited?: true }
  | {
      role: "assistant";
      content: string;
      toolCalls: ToolCall[];
      reasoning?: string;
      reasoningKind?: "full" | "summary";
      /** 适配器私有回传物(Q53),原样透传。 */
      opaque?: unknown;
      /** 这条消息被 context/edit 改过(Q74):回传物已丢弃;适配器据此决定之后的思考块要不要丢。 */
      edited?: true;
    }
  | {
      role: "tool";
      callId: string;
      name: string;
      content: string;
      isError: boolean;
      edited?: true;
    };

/** 编辑状态(Q74):每个目标事件各字段的最新值,以及被丢弃的事件下标。 */
export function editState(events: readonly AgentEvent[]): {
  edits: Map<number, Partial<Record<"text" | "reasoning" | "content" | "system", string>>>;
  dropped: Set<number>;
} {
  const edits = new Map<
    number,
    Partial<Record<"text" | "reasoning" | "content" | "system", string>>
  >();
  const dropped = new Set<number>();
  for (const e of events) {
    if (e.type === "context/edit") {
      const cur = edits.get(e.target) ?? {};
      cur[e.field] = e.value;
      edits.set(e.target, cur);
    } else if (e.type === "context/drop") {
      dropped.add(e.target);
      const t = events[e.target];
      if (t?.type === "assistant/message") {
        // 丢一条带调用的助手消息,它的应答也得一起走,否则序列非法。
        const ids = new Set(t.toolCalls.map((c) => c.id));
        events.forEach((x, i) => {
          if (x.type === "tool/result" && ids.has(x.callId)) dropped.add(i);
        });
      }
    }
  }
  return { edits, dropped };
}

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
  return composeContext(events).messages;
}

/**
 * 一条消息的来历(Q81):它来自哪个事件,经过了哪些组装阶段。
 * stages 用固定词:summary(压缩摘要合成)、covered(原文被摘要取代,不出现)、cleared(工具结果换占位)、
 * edited:<字段>(context/edit 改过)、dropped(context/drop 丢弃,不出现)。
 */
export type Provenance = {
  /** 来源事件下标;摘要消息指向 compaction 事件。 */
  event: number;
  stages: string[];
};

export type Composition = {
  messages: Message[];
  /** 与 messages 一一对应。 */
  provenance: Provenance[];
  /** 没进投影的事件下标与原因(covered / dropped),给组装视图列"少了什么"。 */
  omitted: { event: number; reason: "covered" | "dropped" }[];
};

/**
 * 上下文组装(Q81):事件数组 → 模型可见的消息序列,带每条的来历。
 * 阶段固定且逐条可见:投影(事件→消息)→ 压缩(覆盖区跳过、切点注入摘要、清除占位)→ 编辑(换字段、丢弃)。
 * 纯函数,同一日志永远同一结果;deriveMessages 只是它的 messages 一列。
 */
export function composeContext(events: readonly AgentEvent[]): Composition {
  const c = compactionState(events);
  const ed = editState(events);
  const messages: Message[] = [];
  const provenance: Provenance[] = [];
  const omitted: Composition["omitted"] = [];
  const summaryEvent = events.findIndex(
    (e) => e.type === "compaction" && e.summary !== undefined && e.coversUpTo === c.coversUpTo,
  );
  const push = (m: Message, event: number, stages: string[]) => {
    messages.push(m);
    provenance.push({ event, stages });
  };
  for (let i = 0; i < events.length; i++) {
    if (c.summary && i === c.coversFrom) {
      // 摘要是合成的消息,它改变了此后所有消息的前缀:与编辑同等对待(Q76),
      // Anthropic 适配器据此不再回传之后的思考块(签名绑定前缀,否则新账号 400)。
      push(
        { role: "user", content: `[会话前段已压缩,以下为摘要]\n${c.summary}`, edited: true },
        summaryEvent,
        [`summary(covers #${c.coversFrom}–#${c.coversUpTo - 1})`],
      );
    }
    const e = events[i];
    if (!e) continue;
    if (c.summary && i >= c.coversFrom && i < c.coversUpTo) {
      if (isProjected(e)) omitted.push({ event: i, reason: "covered" });
      continue;
    }
    if (ed.dropped.has(i)) {
      if (isProjected(e)) omitted.push({ event: i, reason: "dropped" });
      continue;
    }
    const edit = ed.edits.get(i);
    const editedStages = Object.keys(edit ?? {}).map((f) => `edited:${f}`);
    switch (e.type) {
      case "session/start":
        push(
          {
            role: "system",
            content: edit?.system ?? e.system,
            ...(edit?.system !== undefined && { edited: true }),
          },
          i,
          editedStages,
        );
        break;
      case "user/message":
        push(
          {
            role: "user",
            content: edit?.content ?? e.text,
            ...(edit?.content !== undefined && { edited: true }),
          },
          i,
          editedStages,
        );
        break;
      case "assistant/message": {
        const edited = edit?.text !== undefined || edit?.reasoning !== undefined;
        const reasoning = edit?.reasoning ?? e.reasoning;
        push(
          {
            role: "assistant",
            content: edit?.text ?? e.text,
            toolCalls: e.toolCalls,
            ...(reasoning && { reasoning }),
            ...(e.reasoningKind && { reasoningKind: e.reasoningKind }),
            // 改过的消息不带回传物:签名或密文与改后的内容不再对应,发回去只会被拒。
            ...(!edited && e.opaque !== undefined && { opaque: e.opaque }),
            ...(edited && { edited: true }),
          },
          i,
          [...editedStages, ...(edited && e.opaque !== undefined ? ["opaque-dropped"] : [])],
        );
        break;
      }
      case "tool/result": {
        // 被清除换成占位文本,同样是改了前缀。
        const cleared = c.cleared.has(i);
        push(
          {
            role: "tool",
            callId: e.callId,
            name: e.name,
            content: cleared ? CLEARED_PLACEHOLDER : (edit?.content ?? e.content),
            isError: e.isError,
            ...((cleared || edit?.content !== undefined) && { edited: true }),
          },
          i,
          [...(cleared ? ["cleared"] : []), ...editedStages],
        );
        break;
      }
      case "session/interrupt":
      case "session/recovered":
      case "mcp/server":
      case "mcp/rpc":
      case "mcp/log":
      case "mcp/tools":
      case "session/model":
      case "session/slot":
      case "compaction":
      case "context/edit":
      case "context/drop":
      case "request":
      case "retry":
      case "request/error":
      case "decision":
        break;
    }
  }
  return { messages, provenance, omitted };
}

function isProjected(e: AgentEvent): boolean {
  return (
    e.type === "session/start" ||
    e.type === "user/message" ||
    e.type === "assistant/message" ||
    e.type === "tool/result"
  );
}
