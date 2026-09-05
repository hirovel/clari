# Changelog

All notable changes to clari. The format follows Keep a Changelog; versions follow semver.
Design decisions behind each entry are numbered Q1 to Q90 in the internal architecture document.

## [Unreleased]

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
