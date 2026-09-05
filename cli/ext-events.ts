// 可选装模块的事件如何画(Q87 修订):内核只有一种 ext/event,来源自己决定哪些值得在主屏与检视器露一行。
// 新模块在这里登记一个渲染函数;没登记的来源画成 "source/kind"。
import type { AgentEvent } from "../src/events.js";
import { renderMcpEvent } from "./mcp/bridge.js";

export type ExtLine = { tone: "jin" | "zhu" | "faint"; text: string };

type Renderer = (e: Extract<AgentEvent, { type: "ext/event" }>) => ExtLine | undefined;

const renderers: Record<string, Renderer> = { mcp: renderMcpEvent };

/** 值得给人看的一行;undefined = 这条只进日志,不上屏(如每次 RPC 往返)。 */
export function renderExtEvent(e: AgentEvent): ExtLine | undefined {
  if (e.type !== "ext/event") return undefined;
  const r = renderers[e.source];
  if (r) return r(e);
  return { tone: "faint", text: `· ${e.source}/${e.kind}` };
}
