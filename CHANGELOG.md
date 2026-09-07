# Changelog

All notable changes to clari. The format follows Keep a Changelog; versions follow semver.
Design decisions behind each entry are recorded, with reasons and alternatives, in the internal architecture document.

## [Unreleased]

### Added

- Facts the model cannot compute are attached to the event that produced them, never to a status bar: a tool result says when the same call with the same arguments failed before in this session, and when the call took at least 30 s and more than five times this session's median for that tool (`facts` in the config switches each one); a date change is appended as one user message before the next request. The bash working directory persists across calls and the result says `[cwd is now …]` when it changed.
- `plan` tool: the model writes its own plan (steps with pending / in_progress / done / cancelled); the newest call replaces the previous one and the transcript shows it as a checklist. The plan is restated at the end of the context only after a compaction and after `planReminder` steps (8) without an update while steps are still open, as an appended user message with a `decision` event; `planReminder: 0` never restates. `plan: false` in the config removes the tool entirely (its definition costs 170 to 250 tokens per request depending on the description level).
- Model capability data (context window, output limit, effort levels, price) now comes from the models.dev registry by default: a snapshot ships in the package (`pnpm models:update` refreshes it), a cached copy refreshes daily, and the config only holds overrides. Order: model entry in config, then models.dev, then provider-level config, then an assumed 64k. The header shows the window and its source (`1M ctx (models.dev)`, red `assumed`), the request card's limit line carries the source, `/models` and the login dialog show the effective values per row. The template no longer pre-fills windows or prices.
- Models the server lists but the config does not know are now selectable in the login dialog and `/models`: their context window, output limit, effort levels and price come from the models.dev registry (cached a day in `~/.clari/models.dev.json`), else are copied from the most similar configured model, else assumed at 64k; the row says which, and choosing one writes it into the config. Configured models whose window disagrees with the registry get a note.
- The start screen is one line; the login dialog has no intro sentence and no duplicate error line; the thesis moved to the top of `/help`.
- Alt-screen viewport by default: fixed header and status line, own scrolling, mouse wheel, select-to-copy, Ctrl+Shift+F search, Ctrl+Up/Down jumps between requests (`screen: main` keeps the terminal scrollback; `--screen`).
- Ledger: every request is a step; the newest `foldSteps` (3) stay open, older ones fold to one ledger line (stop reason, calls, tokens, cache hit rate, first line of the reply or the first call). PgUp/PgDn move a step cursor and scroll that step to the top, Enter unfolds or folds it, Esc releases; `foldSteps: 0` never folds.
- Ctrl+K command palette: fuzzy search over commands, configured models, provider logins, skills and templates.
- Desktop notification (OSC 9/777 and bell) when a turn ends or approval is needed while the terminal is unfocused (`notify: unfocused | always | off`); the terminal title follows the state.
- `/copy` copies the last reply, `/copy N` its Nth code block (OSC 52). Ctrl+G writes the message in `$EDITOR`. Shift+Enter inserts a newline.
- File paths in tool calls are OSC 8 `file://` links; clicking them in the alt screen opens the file.
- The seal in the header breathes while the model works; the status line shows a context pulse (last ten requests as a tiny bar chart).
- Streaming coalesced to 30 frames per second.

### Changed

- Thirty-nine slash commands became thirteen, and a command with choices opens a numbered list instead of expecting a typed sub-command: `/inspect` (requests, events, context, usage, compactions, edits, prompt, tools, slots, skills, mcp, fields, sessions, raw), `/set` (approve, compaction, trigger, preservation, execution, steering, effort, toolprompts: pick the slot, then the value; the current value is on the row), `/edit` (context panel, retry, list), `/model` (the last row asks the provider), `/login`, `/tools` (Enter flips a tool on or off for the session; `tools.disable` in the config switches some off at start), `/session` (new, fork, resume, list), `/memory` (show, forget one, clear with a confirmation), `/compact`, `/copy` (picks a code block when there are any), `/stop`, `/quit`, `/help` (grouped, one screen). Typed forms such as `/set approve ask` still work for scripts. `/key` is gone: keys are entered only in the login dialog. Unknown commands point to `/help` and Ctrl+K.
- The transcript prints only the conversation and the tools. The Request and Response cards are gone from the stream: no label column, no `changed` / `params` / `messages` / `limit` rows, no usage or cost on the reply, no `opaque`, `extras` or `raw` rows (all of it stays in the inspector and the context panel). Lines start in a two-column sign column: `›` you, `»` call, `└ ✓` result, `·` thinking and notes, `≡` a folded step. A note appears only when the context changed in a way the stream would otherwise hide: `✎ N edited (#…)`, `≈ compacted`, `≈ prefix recomputed from #N`, `≈ cache 31% … expected ≤…` when the hit rate is under half of the prediction, `≈ summary request`, `≈ overflow retry`, and `? context window assumed` on the first request. Result visibility is per tool (`results` in the config): `read`, `edit`, `write`, `glob`, `grep` report the line count only, `bash` shows the last `foldLines` lines, other tools the first `foldLines`; errors always show their body. Thinking is one faint line with `(N lines · Ctrl+T)`. Prose wraps at 96 columns at most; tool output and diffs never wrap, long lines are cut with `…`. The status line shows the session cost as `≈$0.0044` (two significant digits: it is measured tokens times list price, not a bill); per-step cost left the ledger lines, which now carry the cache hit rate instead. The OSC 133 prompt mark sits on the user message, so Ctrl+Up/Down jump between prompts.
- Palette and hierarchy after a design review. Morandi palette derived in OKLCH (rules in `cli/theme.ts`): ink scale with equal lightness steps (faint text now 4.6:1), two accents only, ochre red `#c87a70` for tool actions and errors, oat gold `#c7ad82` for the brand and for what changed; green is only the diff-add foreground and ✓ is ink-coloured. One glyph family: `›` you, `»` call, `└` result, `≈` compaction, `·` note, `▸` cursor, `┆` guide, `▪` seal in the header. Markdown headings and inline code are ink (code on a band), links underline only; the context bar is a thin faint line that turns red past 70%; picker and inspector titles, cursors and section names are ink.
- Screen redesign against the conventions shared by opencode, Codex CLI, pi, gemini-cli and Claude Code. Wrapped lines keep a hanging indent (label column, guide line, marker). Tool results start folded to 5 lines (`fold`, `foldLines` in config; `--fold`; Ctrl+O toggles), the first body line carries `└`, the tail says `… +N lines · Ctrl+O`. Approval prompts are a numbered vertical list (Allow once / Allow for this session / Deny with a reason / Deny) driven by `↑↓`, `1`–`4`, the letters or Enter; Esc denies. Pickers are numbered and the selected row is bold. The working line shows elapsed seconds and `Esc to interrupt`. The status line is split: state and context bar on the left, session totals and `? shortcuts` on the right; the second header line is gone. Card titles drop to the secondary colour so gold marks only what changed; `⚙` is red like every tool mark; the `reply` label sits on the reply's first line. User messages sit on a full-width band; edit/write diffs get dark green and dark red backgrounds.
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
