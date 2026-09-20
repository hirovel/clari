// 系统提示词的段,会话内可开关:段的正文从 session/start 的全文按各段长度切回来(各段修剪后以空行相接),
// 当前开着哪几段看投影里的 system 含不含那一段;翻一段就是追加一条 context/edit(target 0, field system),
// 与编辑任何消息同一条路,原文永远留在事件里。旧日志的段长度对不上全文时只看不改。
import type { AgentEvent } from "../src/events.js";
import { editState } from "../src/messages.js";

export type SectionState = {
  name: string;
  source?: string | undefined;
  text: string;
  chars: number;
  on: boolean;
};

type Start = Extract<AgentEvent, { type: "session/start" }>;

function startOf(events: readonly AgentEvent[]): { e: Start; index: number } | undefined {
  const index = events.findIndex((e) => e.type === "session/start");
  const e = events[index];
  return e?.type === "session/start" ? { e, index } : undefined;
}

/** 投影里当前的系统提示词全文(编辑过就是编辑后的)。 */
export function currentSystem(events: readonly AgentEvent[]): string | undefined {
  const s = startOf(events);
  if (!s) return undefined;
  return editState(events).edits.get(s.index)?.system ?? s.e.system;
}

/**
 * 各段与开关状态。切不回来(没有分段元数据,或长度对不上)返回 undefined:调用方只列元数据,不给开关。
 */
export function sectionStates(events: readonly AgentEvent[]): SectionState[] | undefined {
  const s = startOf(events);
  if (!s) return undefined;
  let full = s.e.system;
  let sections = s.e.sections;
  for (const e of events) {
    if (e.type === "context/edit" && e.target === s.index && e.field === "system" && e.sections) {
      full = e.value;
      sections = e.sections;
    }
  }
  if (!sections?.length) return undefined;
  const expected = sections.reduce((n, x) => n + x.chars, 0) + 2 * (sections.length - 1);
  if (expected !== full.length) return undefined;
  const now = currentSystem(events) ?? full;
  const out: SectionState[] = [];
  let at = 0;
  for (let k = 0; k < sections.length; k++) {
    const m = sections[k] as { name: string; source?: string; chars: number };
    const text = full.slice(at, at + m.chars);
    const last = k === sections.length - 1;
    if (!last && full.slice(at + m.chars, at + m.chars + 2) !== "\n\n") return undefined;
    at += m.chars + 2;
    out.push({ name: m.name, source: m.source, text, chars: m.chars, on: now.includes(text) });
  }
  return out;
}

/** 翻一段之后的系统提示词全文:开着的段按原顺序以空行相接。 */
export function systemWithSections(states: SectionState[], toggled: string): string {
  return states
    .filter((x) => (x.name === toggled ? !x.on : x.on))
    .map((x) => x.text)
    .join("\n\n");
}
