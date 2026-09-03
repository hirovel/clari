import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

/**
 * 可执行工具(Q24):ToolDef(wire 层纯描述)加 execute。
 * 契约(Q18):返回纯文本;失败一律 throw,由循环捕获转成 tool/result{isError:true}。
 * ctx.signal 必须被长任务工具响应,否则即时打断(Q11)到不了子进程。
 */
export type ToolContext = {
  signal: AbortSignal;
  /** 本次调用在模型响应里的 id;工具据此把自己派生的东西(如子 agent 会话)关联回调用行。 */
  callId?: string;
};

export type Tool<S extends TSchema = TSchema> = {
  name: string;
  description: string;
  /** TypeBox schema,本身就是 JSON Schema 对象,原样进 wire 请求(Q19)。 */
  parameters: S;
  execute(args: Static<S>, ctx: ToolContext): Promise<string>;
};

/** 定义处获得 Static<S> 的参数类型推导;运行期原样返回。 */
export function defineTool<S extends TSchema>(tool: Tool<S>): Tool<S> {
  return tool;
}

export type ValidationResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * 参数校验(Q19,循环在执行前统一调用):
 * Value.Convert 先做类型强转(模型爱把数字发成字符串),再 Check。
 * 错误文本仿 pi:逐路径列错误,末尾附收到的参数原文,让模型看见自己发了什么。
 */
export function validateArgs(schema: TSchema, raw: unknown): ValidationResult {
  if (typeof raw === "object" && raw !== null && "__unparsed" in raw) {
    return {
      ok: false,
      error: `参数不是合法 JSON,无法解析。收到的原文:\n${String((raw as { __unparsed: unknown }).__unparsed)}`,
    };
  }
  // Clone:raw 已作为事件入日志,Convert 不许碰历史。
  const converted = Value.Convert(schema, Value.Clone(raw));
  if (Value.Check(schema, converted)) return { ok: true, value: converted };

  const lines = [...Value.Errors(schema, converted)].map(
    (e) => `  - ${e.path || "/"}: ${e.message}`,
  );
  return {
    ok: false,
    error: `参数校验失败:\n${lines.join("\n")}\n收到的参数:\n${JSON.stringify(raw, null, 2)}`,
  };
}
