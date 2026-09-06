// 策略槽在会话中切换:每次切换记 session/slot,下一次 turn 起生效。
// 审批槽的三种形态与审批提示组件也在这里:它是唯一需要界面参与的槽。
import { type Component, Key, matchesKey } from "@earendil-works/pi-tui";
import {
  type ApprovalConfig,
  type ApproveDecision,
  DEFAULT_APPROVAL,
  describeApproval,
  policyApprove,
} from "../src/approval.js";
import { DEFAULT_CONFIG_PATH, loadConfig, saveConfig } from "../src/config.js";
import { now, type ToolCall } from "../src/events.js";
import { type ApprovePolicy, allowAll, queueToTurnEnd, steer } from "../src/loop.js";
import { isCompactionTrigger, loadCompactionStrategy, parsePreservation } from "./bootstrap.js";
import { editInExternalEditor } from "./editor.js";
import { c } from "./theme.js";
import {
  applyToolPrompts,
  describeToolPrompts,
  isToolPromptStyle,
  STYLE_NOTES,
  styleTokens,
  TOOL_PROMPT_STYLES,
} from "./tool-prompts.js";
import type { TuiAppDeps } from "./tui-app.js";
import type { ApprovalState, TuiContext } from "./tui-context.js";
import { formatArgs, toolCallDetail } from "./tui-format.js";

// ---------- 审批 ----------

type ApprovalChoice = { kind: "y" | "n" | "a"; reason?: string };

/** 审批提示里最多显示的 diff 行数。 */
const APPROVAL_DETAIL_LINES = 20;

/**
 * 审批提示:一行问题(带为什么要问)、edit/write 的 diff、一行按键说明;
 * y / n / a,r 进入输入理由,理由原样进工具结果喂回模型;Esc 视为拒绝。
 */
export class ApprovalPrompt implements Component {
  private mode: "choose" | "reason" = "choose";
  private reason = "";

  constructor(
    private readonly call: ToolCall,
    private readonly why: string,
    private readonly onDecide: (d: ApprovalChoice) => void,
    private readonly onChange: () => void = () => {},
  ) {}

  render(): string[] {
    const head = `${c.zhu("?")} ${c.bold(c.ink("run"))} ${c.bold(c.ink(this.call.name))}  ${c.soft(formatArgs(this.call.args))}  ${c.faint(`(${this.why})`)}`;
    const detail = toolCallDetail(this.call.name, this.call.args);
    const all = detail ? detail.split("\n") : [];
    const shown = all.slice(0, APPROVAL_DETAIL_LINES).map((l) => `  ${l}`);
    if (all.length > APPROVAL_DETAIL_LINES)
      shown.push(c.faint(`  … ${all.length - APPROVAL_DETAIL_LINES} more lines`));
    if (this.mode === "reason") {
      return [
        head,
        ...shown,
        `${c.soft("  reason:")} ${c.ink(this.reason)}${c.faint("▏")}`,
        c.faint("  Enter deny with this reason · Esc back"),
      ];
    }
    return [
      head,
      ...shown,
      c.faint(
        `  y allow · n deny · r deny with a reason · a always allow ${this.call.name} this session · Esc deny`,
      ),
    ];
  }

  handleInput(data: string): void {
    if (this.mode === "reason") {
      if (matchesKey(data, Key.enter)) {
        const reason = this.reason.trim();
        this.onDecide({ kind: "n", ...(reason && { reason }) });
      } else if (matchesKey(data, Key.escape)) {
        this.mode = "choose";
        this.reason = "";
      } else if (data === "\x7f" || data === "\b") this.reason = this.reason.slice(0, -1);
      else if (data.length > 0 && !data.startsWith("\x1b") && data >= " ") this.reason += data;
      this.onChange();
      return;
    }
    if (data === "y" || data === "Y") this.onDecide({ kind: "y" });
    else if (data === "a" || data === "A") this.onDecide({ kind: "a" });
    else if (data === "r" || data === "R") {
      this.mode = "reason";
      this.onChange();
    } else if (data === "n" || data === "N" || matchesKey(data, Key.escape))
      this.onDecide({ kind: "n" });
  }

  invalidate(): void {}
}

/** 审批状态的启动形态:deps.approve 是 all / ask / 规则对象。 */
export function initialApproval(approve: TuiAppDeps["approve"]): ApprovalState {
  return {
    cfg: structuredClone(typeof approve === "object" ? approve : DEFAULT_APPROVAL),
    mode: approve === undefined ? "all" : typeof approve === "string" ? approve : "policy",
    alwaysAllow: new Set(),
    skillAllow: new Set(),
    overlay: undefined,
    prompt: undefined,
  };
}

/** 问一次就是一次;a 把该工具加进本会话的放行名单。拒绝以错误结果回喂模型。 */
export function askApproval(
  ctx: TuiContext,
  call: ToolCall,
  why = "asked for every call",
): Promise<ApproveDecision> {
  const a = ctx.approval;
  if (a.alwaysAllow.has(call.name) || a.skillAllow.has(call.name)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const prompt = new ApprovalPrompt(
      call,
      why,
      (decision) => {
        a.overlay?.hide();
        a.overlay = undefined;
        a.prompt = undefined;
        ctx.tui.setFocus(ctx.editor);
        if (decision.kind === "a") {
          a.alwaysAllow.add(call.name);
          // 同时写进规则,/approve 能看到本会话放行了什么。
          a.cfg.allow = a.cfg.allow ?? [];
          if (!a.cfg.allow.includes(call.name)) a.cfg.allow.push(call.name);
        }
        const allowed = decision.kind !== "n";
        ctx.note(
          allowed
            ? c.faint(
                `· approve: allowed ${call.name}${decision.kind === "a" ? " (not asked again this session)" : ""}`,
              )
            : c.zhu(
                `· approve: denied ${call.name}${decision.reason ? `: ${decision.reason}` : ""}`,
              ),
        );
        resolve(
          allowed ? true : { allowed: false, ...(decision.reason && { reason: decision.reason }) },
        );
      },
      () => ctx.tui.requestRender(),
    );
    a.prompt = prompt;
    a.overlay = ctx.tui.showOverlay(prompt, { width: "100%", anchor: "bottom-left" });
    ctx.tui.requestRender();
  });
}

/** 审批槽的三种形态:all 不问;ask 每个调用都问;policy 按规则裁决,ask 的才问。 */
export function approveImpl(ctx: TuiContext): ApprovePolicy {
  const a = ctx.approval;
  if (a.mode === "all") return allowAll;
  const label = (why: string, origin?: { agent: string }) =>
    origin ? `${origin.agent} · ${why}` : why;
  if (a.mode === "ask")
    return (call, origin) => askApproval(ctx, call, label("asked for every call", origin));
  return policyApprove(a.cfg, (call, why, origin) => askApproval(ctx, call, label(why, origin)));
}

export function approveValue(a: ApprovalState): string {
  return a.mode === "policy" ? `policy: ${describeApproval(a.cfg)}` : a.mode;
}

// ---------- 槽的当前形态与切换 ----------

/** /slots 首屏的每个槽的名字:来自启动参数,之后由 recordSlot 更新。 */
export function initialSlotState(
  deps: TuiAppDeps,
  approval: ApprovalState,
): Record<string, string> {
  return {
    compaction: `${deps.compactionName ?? "llm"} · trigger ${deps.compaction.trigger ?? "threshold"}`,
    preservation: deps.preservationName ?? "keepRecentTokens (min(20000, window/4))",
    execution: deps.slots?.execution ?? "sequential",
    steering:
      deps.slots?.steering === queueToTurnEnd ? "turn" : deps.slots?.steering ? "custom" : "step",
    approve: approveValue(approval),
    toolPrompts: describeToolPrompts(deps.toolPrompts),
  };
}

export function recordSlot(ctx: TuiContext, slot: string, value: string): void {
  ctx.slots.state[slot] = value;
  ctx.log.append({ type: "session/slot", at: now(), slot, value });
}

/** /slots:当前每个槽的实现。全部是可切换的;切换记事件。 */
export function slotsList(ctx: TuiContext): string {
  const rows = Object.entries(ctx.slots.state).map(
    ([k, val]) => `  ${c.jin(k.padEnd(13))} ${c.ink(val)}`,
  );
  return [
    `${c.soft("Slots")}  ${c.faint("switch with /compaction /preservation /execution /steering /approve /toolprompts; each switch is a session/slot event")}`,
    ...rows,
    `  ${c.jin("termination".padEnd(13))} ${c.ink(ctx.deps.slots?.termination ? "custom" : "untilIdle")}  ${c.faint("(--max-steps N at startup)")}`,
  ].join("\n");
}

const done = (slot: string, value: string, when = "takes effect from the next turn") =>
  `${c.jin(`◇ ${slot} → ${value}`)}  ${c.faint(when)}`;

async function compactionSlot(ctx: TuiContext, v: string): Promise<string> {
  const { compaction } = ctx;
  const label = (strategy: string) => `${strategy} · trigger ${compaction.trigger ?? "threshold"}`;
  if (!v)
    return c.faint(
      `compaction is ${ctx.slots.state.compaction}. Usage: /compaction llm|clear|pipeline|./strategy.mjs (strategy) · /compaction threshold|manual|remind (trigger)`,
    );
  if (isCompactionTrigger(v)) {
    compaction.trigger = v;
    const strategy = ctx.slots.state.compaction?.split(" · ")[0] ?? "llm";
    recordSlot(ctx, "compaction", label(strategy));
    return done(
      "compaction",
      `trigger ${v}`,
      v === "threshold"
        ? "compacts automatically when usage passes the threshold"
        : v === "manual"
          ? "no automatic compaction; /compact when you decide (overflow still compacts once)"
          : "no automatic compaction; the status bar says when you are past the threshold",
    );
  }
  try {
    compaction.strategy = await loadCompactionStrategy(v);
  } catch (err) {
    return c.zhu(`✗ ${(err as Error).message}`);
  }
  recordSlot(ctx, "compaction", label(v));
  return done("compaction", v, "used by the next auto or manual compaction");
}

function preservationSlot(ctx: TuiContext, v: string): string {
  const usage = c.faint(
    `preservation is ${ctx.slots.state.preservation}. Usage: /preservation tokens 20000 | ratio 0.3`,
  );
  if (!v) return usage;
  let parsed: ReturnType<typeof parsePreservation>;
  try {
    parsed = parsePreservation(v);
  } catch (err) {
    const msg = (err as Error).message;
    return msg.startsWith("preservation must be")
      ? usage
      : c.zhu(msg.replace(/^preservation /, ""));
  }
  ctx.compaction.preservation = parsed.policy;
  recordSlot(ctx, "preservation", parsed.label);
  return done("preservation", v, "used by the next compaction");
}

function executionSlot(ctx: TuiContext, v: string): string {
  if (v !== "sequential" && v !== "parallel")
    return c.faint(
      `execution is ${ctx.slots.state.execution}. Usage: /execution sequential|parallel`,
    );
  ctx.agent.setSlot("execution", v);
  recordSlot(ctx, "execution", v);
  return done("execution", v);
}

function steeringSlot(ctx: TuiContext, v: string): string {
  if (v !== "step" && v !== "turn")
    return c.faint(
      `steering is ${ctx.slots.state.steering}. Usage: /steering step|turn  (step = inject queued messages at the next step; turn = only when the model stops calling tools)`,
    );
  ctx.agent.setSlot("steering", v === "step" ? steer : queueToTurnEnd);
  recordSlot(ctx, "steering", v);
  return done("steering", v);
}

function approveSlot(ctx: TuiContext, v: string): string {
  const a = ctx.approval;
  const [sub = "", ...restRule] = v.split(/\s+/);
  const rule = restRule.join(" ").trim();
  const show = () =>
    [
      `${c.soft("approve")} ${c.ink(a.mode)}${a.mode === "policy" ? `  ${c.faint(describeApproval(a.cfg))}` : ""}`,
      c.faint(
        "Usage: /approve all|ask|policy · /approve allow <rule> · /approve deny <rule> · /approve forget <rule> · /approve outside ask|allow|deny",
      ),
      c.faint(
        "rule = tool or tool:pattern; bash patterns match the command (bash:git *), path tools match the path (edit:src/**)",
      ),
    ].join("\n");
  const apply = (label: string) => {
    ctx.agent.setSlot("approve", approveImpl(ctx));
    recordSlot(ctx, "approve", approveValue(a));
    return done("approve", label, "applies to the next tool call");
  };
  if (!sub) return show();
  if (sub === "all" || sub === "ask" || sub === "policy") {
    a.mode = sub;
    return apply(sub);
  }
  if (sub === "allow" || sub === "deny") {
    if (!rule) return c.zhu(`Usage: /approve ${sub} <rule>`);
    const list = a.cfg[sub] ?? [];
    a.cfg[sub] = list;
    if (!list.includes(rule)) list.push(rule);
    a.mode = "policy";
    return apply(`${sub} ${rule}`);
  }
  if (sub === "forget") {
    if (!rule) return c.zhu("Usage: /approve forget <rule>");
    a.cfg.allow = (a.cfg.allow ?? []).filter((r) => r !== rule);
    a.cfg.deny = (a.cfg.deny ?? []).filter((r) => r !== rule);
    a.alwaysAllow.delete(rule);
    recordSlot(ctx, "approve", approveValue(a));
    return done("approve", `forget ${rule}`, "applies to the next tool call");
  }
  if (sub === "outside") {
    if (rule !== "ask" && rule !== "allow" && rule !== "deny")
      return c.zhu("Usage: /approve outside ask|allow|deny");
    a.cfg.outsideCwd = rule;
    a.mode = "policy";
    return apply(`outside cwd ${rule}`);
  }
  return show();
}

/** 工具描述风格槽:列表、切换、逐条编辑、写回配置。切换与编辑都原地改 tools 的描述。 */
function toolPromptsSlot(ctx: TuiContext, v: string): string {
  const cfg = ctx.slots.toolPrompts;
  const { tools } = ctx;
  const [sub, name] = v.split(/\s+/, 2);
  if (!sub) {
    const rows = TOOL_PROMPT_STYLES.map((st) => {
      const tok = styleTokens(tools, { ...cfg, style: st });
      const mark = st === cfg.style ? c.jin("●") : c.faint("○");
      return `  ${mark} ${c.ink(st.padEnd(8))} ${c.soft(String(tok).padStart(5))} ${c.faint("tok")}  ${c.faint(STYLE_NOTES[st])}`;
    });
    const edited = Object.keys(cfg.descriptions ?? {});
    return [
      `${c.soft("Tool prompts")}  ${c.faint("one description per tool in three layers (core, guidance, rules); the level picks how many the model sees")}`,
      ...rows,
      c.faint(
        edited.length > 0
          ? `  edited by you: ${edited.join(" ")}  (reset <tool> to drop; save to keep across sessions)`
          : "  edit <tool> opens the description in your editor; save writes style and edits to ~/.clari/config.json",
      ),
    ].join("\n");
  }
  if (isToolPromptStyle(sub)) {
    cfg.style = sub;
    const changed = applyToolPrompts(tools, cfg);
    recordSlot(ctx, "toolPrompts", describeToolPrompts(cfg));
    return done(
      "toolPrompts",
      `${sub} (${styleTokens(tools, cfg)} tok)`,
      changed.length > 0
        ? `${changed.length} descriptions changed; takes effect from the next request`
        : "no description changed",
    );
  }
  if (sub === "edit" || sub === "reset") {
    const t = tools.find((x) => x.name === name);
    if (!name || !t) return c.zhu(`no tool named ${name ?? "?"}; see /tools`);
    const descriptions = cfg.descriptions ?? {};
    cfg.descriptions = descriptions;
    if (sub === "reset") {
      if (!(name in descriptions)) return c.faint(`· ${name} is not edited`);
      delete descriptions[name];
    } else {
      // 长文本走外部编辑器:先让出终端,编辑器退出后再接管。
      ctx.tui.stop();
      const next = editInExternalEditor(t.description, { suffix: ".txt" });
      ctx.tui.start();
      if (next === undefined) return c.faint("· unchanged, cancelled");
      descriptions[name] = next.replace(/\s+$/, "");
    }
    applyToolPrompts(tools, cfg);
    recordSlot(ctx, "toolPrompts", describeToolPrompts(cfg));
    return done(
      "toolPrompts",
      `${sub} ${name} (${Math.ceil(t.description.length / 4)} tok)`,
      "takes effect from the next request; /tools shows the first line, Ctrl+R → tool definitions the full text",
    );
  }
  if (sub === "save") {
    const { config } = loadConfig();
    const descriptions = cfg.descriptions ?? {};
    config.toolPrompts = {
      style: cfg.style ?? "explain",
      ...(Object.keys(descriptions).length > 0 && { descriptions }),
    };
    saveConfig(config);
    return done("toolPrompts", "saved", `toolPrompts written to ${DEFAULT_CONFIG_PATH}`);
  }
  return c.zhu("Usage: /toolprompts brief|explain|rules | edit <tool> | reset <tool> | save");
}

/** 一个槽命令:返回要打到屏幕上的文本。运行中拒绝切换。 */
export async function slotCommand(ctx: TuiContext, slot: string, arg: string): Promise<string> {
  if (ctx.agent.running) return c.zhu("Cannot switch a slot while running; press Esc first.");
  const v = arg.trim();
  switch (slot) {
    case "compaction":
      return compactionSlot(ctx, v);
    case "preservation":
      return preservationSlot(ctx, v);
    case "execution":
      return executionSlot(ctx, v);
    case "steering":
      return steeringSlot(ctx, v);
    case "approve":
      return approveSlot(ctx, v);
    case "toolPrompts":
      return toolPromptsSlot(ctx, v);
    default:
      return c.zhu(`unknown slot ${slot}`);
  }
}

export type { ApprovalConfig };
