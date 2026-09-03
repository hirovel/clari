// subagent:可选装能力(Q40)。内核任何模块都不引用本文件;组装者按需 import 并挂成一个工具。
// 子 agent = 同一内核的递归实例化:独立事件日志、独立会话文件,replay 与构成投影零改动可用。
import { type TSchema, Type } from "@sinclair/typebox";
import { Agent } from "./agent.js";
import { type AgentEvent, now } from "./events.js";
import { EventLog } from "./log.js";
import type { CompactionConfig, TurnDeps } from "./loop.js";
import type { Provider } from "./provider.js";
import { defineTool, type Tool, validateArgs } from "./tools.js";

// ---------- 上下文范围槽(Q43):子启动时看到父的什么,由父模型在调用时选 ----------

export type ParentSnapshot = {
  events: readonly AgentEvent[];
  system: string;
  model: string;
};

/** 返回子日志的起始事件序列。任务简报由 task 工具统一追加在其后。 */
export type ContextScope = (parent: ParentSnapshot) => AgentEvent[];

/** 注册表条目:实现 + 给父模型看的说明(会拼进工具描述,决定模型何时选它)。 */
export type ScopeEntry = { scope: ContextScope; description: string };
export type ScopeRegistry = Record<string, ScopeEntry>;

/** 零继承:只有系统提示词。系统提示词缺省沿用父的。 */
export function taskOnly(system?: string): ContextScope {
  return (parent) => [
    { type: "session/start", at: now(), model: parent.model, system: system ?? parent.system },
  ];
}

/**
 * 完整继承:复制父日志到干净截点 —— 发起本次派活的那条 assistant 消息之前。
 * 那条消息带着尚未应答的工具调用,进了子历史就是非法序列;它之前的内容即父此刻的完整所见。
 * 复制事件而非消息,子日志因此自洽、可回放。
 */
export function fork(): ContextScope {
  return ({ events }) => {
    let cut = events.length;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === "assistant/message") {
        cut = i;
        break;
      }
    }
    return events.slice(0, cut).map((e) => ({ ...e }));
  };
}

/**
 * 只继承用户说过的话:去掉工具结果与助手推理。
 * 压缩事件按下标引用历史,过滤后下标失效,一并去掉。
 */
export function userMessagesOnly(): ContextScope {
  return ({ events }) =>
    events
      .filter((e) => e.type === "session/start" || e.type === "user/message")
      .map((e) => ({ ...e }));
}

export const DEFAULT_SCOPES: ScopeRegistry = {
  taskOnly: {
    scope: taskOnly(),
    description: "全新上下文,只有系统提示词与你的任务简报。适合边界清楚、可独立完成的子任务。",
  },
  fork: {
    scope: fork(),
    description:
      "继承本会话到当前为止的完整对话。适合没有大量背景就无法理解的子任务;成本与本会话同量级。",
  },
  userMessagesOnly: {
    scope: userMessagesOnly(),
    description:
      "只继承用户说过的话,不带工具结果与助手过程。适合需要用户原始意图、不需要过程细节的子任务。",
  },
};

// ---------- 运行方式槽(Q40):子怎么跑 ----------

export type SubagentRequest = {
  task: string;
  startEvents: AgentEvent[];
  provider: Provider;
  tools: Tool[];
  signal: AbortSignal;
  sessionPath?: string;
  slots?: TurnDeps["slots"];
  compaction?: CompactionConfig;
  /** 子日志一创建就交出去(界面据此实时订阅)。runner 实现应在开跑前调用。 */
  onLog?: (log: EventLog) => void;
};

/** 交给界面的子 agent 信息(Q62):子只是另一个数组,界面拿到日志即可订阅。 */
export type ChildInfo = {
  log: EventLog;
  task: string;
  scope: string;
  /** 父会话里 task 工具调用的 id,用来把子块挂到那一行下面。 */
  callId?: string;
  /** 从 1 起的序号。 */
  index: number;
};

/** 返回契约(Q41):最终文本 + 完成状态 + 深挖句柄。所有 runner 实现必须产出同一形态。 */
export type SubagentResult = {
  text: string;
  status: "completed" | "partial";
  sessionPath?: string;
};

export type SubagentRunner = (req: SubagentRequest) => Promise<SubagentResult>;

/** 进程内递归实例化:子就是另一个 Agent。 */
export const inProcessRunner: SubagentRunner = async (req) => {
  const log = new EventLog(req.sessionPath);
  for (const e of req.startEvents) log.append(e);
  req.onLog?.(log);
  if (req.signal.aborted)
    return { text: "", status: "partial", ...(log.path && { sessionPath: log.path }) };

  const agent = new Agent({
    log,
    provider: req.provider,
    tools: req.tools,
    ...(req.slots && { slots: req.slots }),
    ...(req.compaction && { compaction: req.compaction }),
  });
  const onAbort = () => agent.interrupt();
  req.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const outcome = await agent.prompt(req.task);
    return {
      text: lastAssistantText(log.events),
      status: outcome === "idle" ? "completed" : "partial",
      ...(log.path && { sessionPath: log.path }),
    };
  } finally {
    req.signal.removeEventListener("abort", onAbort);
  }
};

function lastAssistantText(events: readonly AgentEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === "assistant/message" && e.text.trim()) return e.text.trim();
  }
  return "";
}

// ---------- task 工具:把上面两个槽组装成一个模型可调用的能力 ----------

export type TaskToolOptions = {
  parent: EventLog;
  provider: Provider;
  /** 子的工具集。task 工具本身默认被剔除(Q42 一层封顶),allowNested 可放开。 */
  tools: Tool[];
  runner?: SubagentRunner;
  scopes?: ScopeRegistry;
  defaultScope?: string;
  /** 给了就要求子以符合此 schema 的 JSON 收尾,并校验后随结果返回。 */
  outputSchema?: TSchema;
  allowNested?: boolean;
  slots?: TurnDeps["slots"];
  compaction?: CompactionConfig;
  /** 子 agent 一开跑就通知(Q62):界面订阅子日志,实时显示。 */
  onChild?: (child: ChildInfo) => void;
};

export function createTaskTool(opts: TaskToolOptions) {
  const scopes = opts.scopes ?? DEFAULT_SCOPES;
  const scopeNames = Object.keys(scopes);
  const defaultScope = opts.defaultScope ?? scopeNames[0] ?? "taskOnly";
  if (!scopes[defaultScope]) throw new Error(`默认 scope "${defaultScope}" 不在注册表中`);
  const runner = opts.runner ?? inProcessRunner;
  const childTools = opts.allowNested ? opts.tools : opts.tools.filter((t) => t.name !== "task");
  let counter = 0;

  const scopeLines = scopeNames
    .map((n) => `- ${n}${n === defaultScope ? "(默认)" : ""}:${scopes[n]?.description ?? ""}`)
    .join("\n");

  return defineTool({
    name: "task",
    description:
      "派生一个子 agent 在独立上下文中完成子任务,返回它的最终回复;子的中间过程不进入本会话。\n" +
      "适合:调研、检索、验证等读密集且边界清楚的任务。不适合:需要与当前工作共享决策上下文的并行修改代码。\n" +
      "任务简报必须包含四项:目标、期望的输出格式、可用工具与来源的指引、任务边界。大产物让子写入文件并回传路径。\n" +
      `scope 决定子能看到本会话的多少内容:\n${scopeLines}\n` +
      "返回文本末尾附子会话日志路径,需要细节时可 read 该文件。",
    parameters: Type.Object({
      task: Type.String({ description: "任务简报:目标、输出格式、工具与来源指引、任务边界" }),
      scope: Type.Optional(
        Type.Union(
          scopeNames.map((n) => Type.Literal(n)),
          { description: `子的上下文范围,缺省 ${defaultScope}` },
        ),
      ),
    }),
    async execute(args, ctx) {
      const entry = scopes[args.scope ?? defaultScope];
      if (!entry) throw new Error(`未知 scope "${args.scope}",可选:${scopeNames.join(", ")}`);

      const head = opts.parent.events[0];
      const parentSnapshot: ParentSnapshot = {
        events: opts.parent.events,
        system: head?.type === "session/start" ? head.system : "",
        model: head?.type === "session/start" ? head.model : opts.provider.model,
      };
      const startEvents = entry.scope(parentSnapshot);

      counter += 1;
      const parentPath = opts.parent.path;
      const sessionPath = parentPath
        ? `${parentPath.replace(/\.jsonl$/, "")}-sub-${counter}.jsonl`
        : undefined;

      const task = opts.outputSchema
        ? `${args.task}\n\n完成后,最后以一个 \`\`\`json 代码块给出符合以下 JSON Schema 的结果:\n${JSON.stringify(opts.outputSchema)}`
        : args.task;

      const index = counter;
      const scopeName = args.scope ?? defaultScope;
      const res = await runner({
        task,
        startEvents,
        provider: opts.provider,
        tools: childTools,
        signal: ctx.signal,
        ...(opts.onChild && {
          onLog: (log: EventLog) =>
            opts.onChild?.({
              log,
              task: args.task,
              scope: scopeName,
              index,
              ...(ctx.callId && { callId: ctx.callId }),
            }),
        }),
        ...(sessionPath && { sessionPath }),
        ...(opts.slots && { slots: opts.slots }),
        ...(opts.compaction && { compaction: opts.compaction }),
      });

      let out = res.text;
      let structuredError: string | undefined;
      if (opts.outputSchema) {
        const parsed = extractJson(res.text);
        const checked = parsed === undefined ? null : validateArgs(opts.outputSchema, parsed);
        if (checked?.ok) out += `\n\n结构化结果:\n${JSON.stringify(checked.value)}`;
        else structuredError = checked ? checked.error : "子的回复末尾没有 JSON 代码块";
      }
      if (res.sessionPath) out += `\n\n子会话日志: ${res.sessionPath}`;

      if (res.status === "partial") {
        throw new Error(`子任务未完成(被打断或叫停),以下为已有输出,不可全信:\n${out}`);
      }
      if (structuredError) {
        throw new Error(`${out}\n\n结构化结果校验失败:\n${structuredError}`);
      }
      return out;
    },
  });
}

/** 取回复中最后一个 ```json 代码块,或末尾的裸 JSON 对象。 */
function extractJson(text: string): unknown {
  const fence = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].at(-1)?.[1];
  const candidate = fence ?? text.slice(text.lastIndexOf("{"));
  if (!candidate) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}
