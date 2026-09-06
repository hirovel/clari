# Changelog

All notable changes to clari. The format follows Keep a Changelog; versions follow semver.
Design decisions behind each entry are recorded, with reasons and alternatives, in the internal architecture document.

## [Unreleased]

### Changed

- The TUI starts without any API key. A login dialog opens on first start and via `/login`: pick the provider, paste the key (masked), it is checked against the provider's model list, saved to `~/.clari/credentials.json` (mode 0600), then pick a model (`d` also makes it the default). `/model` without arguments and `/models` are list pickers. Key lookup order: env var, credentials file, config `apiKey`. `clari once` still exits when no key is found.
- Visual suite (`scripts/visual-suite.ts`) renders six scenarios to HTML; fixes found by it: the step-limit reason is English, a finished sub-agent view no longer counts a resumed run, the status bar usage follows the compaction-aware estimate after a manual `/compact`.
- Compaction trigger is an option: `threshold` (default), `manual` (only on `/compact`), `remind` (status-bar hint past the threshold); reserve tokens configurable. `defaults.compactionTrigger`, `defaults.compactionReserve`, `--compaction-trigger`, `--compaction-reserve`, `/compaction threshold|manual|remind`.
- Internal refactor: TUI, inspector and bootstrap split into single-purpose modules; session replay is near-linear (9000 events 48 s to 3.7 s); one token estimate; coverage 83% to 90%.
- Architecture document rewritten around reading the code; decision numbers removed from code comments.
- Fixed text the model reads is English throughout: unknown tool, truncated response, interrupted call, cleared tool result placeholder and compaction summary header.
- Sub-agents: child tool calls go through the parent's approval (`subagents.approval`: `inherit` by default, `allow`, or `{ deny }` to tighten); approval prompts name the asking sub-agent. Optional step limit (`subagents.maxSteps`, per type), resume with `task(resume: "sub-N")`, type registry (`subagents.types`: description, system, tools, model, scope, maxSteps), nesting depth (`subagents.depth`). Child view header shows id, type, resumed and a four-state status. Task descriptions, scope notes, result labels and errors are English.
- Tool descriptions are one source per tool in three parts (core, guidance, rules) composed by level: `brief`, `explain` (default), `rules`. Replaces the `guided` / `terse` / `strict` tables; the old names are rejected at startup.

## [0.1.0] - 2026-09-04

First installable release: `npx github:hirovel/clari`, `clari`, `clari once`, `clari replay`, `clari sessions`.

### Kernel

- Append-only event log as the only state; messages, screen, context statistics and compaction views are projections of it.
- Providers for OpenAI chat completions, OpenAI Responses and Anthropic Messages behind one interface; shared SSE reader with stall timeout; provider metadata kept verbatim in `extras`.
- Strategy slots with runtime switching: termination, steering, approval, execution, compaction, preservation, assemble. Every switch is a `session/slot` event.
- Compaction: LLM summary, clear old tool results, or both in a pipeline; external strategy modules; per-message provenance and omissions in `composeContext`.
- Context editing as events: `context/edit` and `context/drop`; originals stay in the log; edit consequences (recomputed messages, dropped thinking blocks, cache estimate) shown on the request card.
- Sub-agents as separate event logs; parent chooses the context scope.
- Approval policy: `all` by default, `policy` with allow/deny rules and mandatory prompt outside the working directory, `ask` for every call; denials carry a reason back to the model.
- Log recovery: a half-written last line is dropped and recorded as `session/recovered`.
- One `ext/event` type for optional modules; the kernel has no MCP-specific code.

### Tools

- read (files and directories), write, edit (exact match, whitespace and quote tolerant retry, `replaceAll`), bash (timeout, output cap, spill to temp file), grep (ripgrep first, JS fallback), glob, fetch (zero-dependency HTML to markdown, private-network refusal, size and time limits, cross-host redirects reported, GitHub raw rewrite, cache, rate limit), task (sub-agents), remember (optional cross-session memory), skill.
- Tool descriptions in three selectable styles (`guided`, `terse`, `strict`), editable per tool, saved to config.
- MCP client, hand-written: stdio and Streamable HTTP, 2026-07-28 stateless protocol and legacy handshake, tools named `mcp__server__tool`, every JSON-RPC exchange logged.

### Interface

- English TUI on a label gutter: one Request card per request (what changed, parameters, system sections, tools, every message with event number and token count) and one Response card (stop reason, timing, cost, cache hit, reply, thinking, calls, results, raw).
- Context panel (Ctrl+E) with an action menu per message: view, edit, compare, restore, drop, rewind, retry, fork.
- Request inspector (Ctrl+R): summary, decisions, sent messages, tool definitions, wire JSON, received stream, written events; event view; compaction comparison; composition view.
- Commands for every slot, `/tools`, `/toolprompts`, `/mcp`, `/sessions`, `/skills`, `/memory`, `/models`, `/fields`, `/raw N`, `/fork`.
- Prompt templates, skills (`SKILL.md` from four locations), `@path` attachments, cost and cache display, error cards with classification and next step.

### Configuration

- One file, `~/.clari/config.json`: providers with per-model capability data, `defaults` for every option, named `presets`, `approval`, `toolPrompts`, `fetch`, `mcp`, `sessionsDir`. Resolution order: command line, then preset, then `defaults`, then built-in.
- Keys from the config file, from the environment variable named in `apiKeyEnv`, or via `/key` in the UI; never logged.

### Sessions

- Files under `./sessions/` (or `sessionsDir`); `--continue`, `--resume`, `/fork`; `clari sessions` lists them, `clari sessions prune --older-than 30d | --keep N` deletes with sidecar trace and MCP folders, only with `--yes`.
