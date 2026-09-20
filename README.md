# clari

A hand-written coding-agent kernel and terminal UI in TypeScript. The kernel keeps one append-only array of events; model messages, conversation history, context statistics and compaction views are projections of that array. Drafts, focus and live connections have their own lifetimes.

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## Two principles

- **End to end.** Intelligence lives at the two ends: the model acts, the user decides. The kernel in the middle only transports reliably and hides nothing. Zero intervention by default; termination, approval, steering, compaction are explicit strategy slots.
- **Full transparency.** The inspector reads each request's saved input and uses labeled event reconstruction for older sessions and shows compaction as "this stretch of history became this summary". Captured HTTP bodies, reconstructed previews, and missing evidence are labeled separately; historical tool definitions and provider settings cannot always be recovered from messages alone.

## What it does today

- Tools: read (files and directories), write, edit with exact match and `replaceAll`, bash, grep, glob, fetch (HTML to markdown, private networks refused, size and time limits, cross-host redirects handed back to the model), sub-agents via task.
- Tool descriptions in three levels (`brief`, `explain`, `rules`) composed from one source per tool (core, guidance, rules), switched with `--tool-prompts` or `/set toolprompts`, edited per tool in your editor and saved to config. The model only ever sees the description text.
- Sub-agents (`--subagent`): the `task` tool runs a child on its own event log and session file. The child follows the parent's approval rules (`subagents.approval`: `inherit`, `allow`, or extra `deny` rules), can be capped (`subagents.maxSteps`), resumed (`task` with `resume: "sub-N"`), typed (`subagents.types`: system prompt, tools, model, scope) and nested to `subagents.depth`.
- MCP client, zero dependencies: stdio and Streamable HTTP, the 2026-07-28 stateless protocol and the legacy handshake. Configure `mcp.servers` or a project `.mcp.json`; tools are named `mcp__server__tool`, approval rules `mcp:server:tool`, every JSON-RPC exchange is an `ext/event`, `/inspect mcp` shows status. The kernel has no MCP-specific code; delete `cli/mcp/` if you do not want it.
- Three protocols (OpenAI chat completions, OpenAI Responses, Anthropic Messages), per-model capability data in config, `extraBody` pass-through, `/model` (its last row asks the provider) to detect retired models, `/inspect fields` to list what the current protocol sends and reads, provider metadata kept verbatim in `extras`.
- No model-facing status bar. Facts the model cannot compute ride on the event that produced them: a result notes a repeated failure with the same arguments or an unusually slow call (`facts` in the config), bash reports its working directory when it changes, a date change is one appended line. Task state is the model's own: the `plan` tool writes a checklist, and the kernel restates it only after a compaction or after `planReminder` steps without an update. Nothing is ever inserted before the newest message, so the cached prefix stays intact.
- The transcript prints only the conversation and the tools: `›` your message, the reply, `»` each call, `└ ✓` each result. No labels, no cards, no numbers in the body. A line appears only when the context changed in a way other tools hide: `✎` a message was edited, `≈` the context was compacted or the cached prefix was recomputed, the cache hit rate fell below half of what was expected, or the context window is an assumed value. Every request as sent and received, with parameters, system sections, tool definitions, every message's tokens and state, usage and cost, is in the inspector (`Ctrl+R`) and the context panel (`Ctrl+E`). Thinking folds to one faint line; Ctrl+T expands.
- Context workbench: Ctrl+E shows the next request as the model will receive it, in order: the system prompt, the tool definitions, every message with its tokens and a share bar, the compaction summary with the covered messages folded under it, dropped messages faint in place, and a line where the last request's cached prefix ends (it moves up and turns gold after an edit). The bottom of the screen previews the selected row. Enter on a message gives a numbered action menu (view, edit, compare, restore, drop, rewind, retry, fork) with a one-line consequence each; Enter on the system row lists the prompt sections and flips one for the session (recorded as an edit of event #0); Enter on the tools row opens `/tools`; Enter on the summary opens the compaction comparison. Typed forms: `/edit N [field] [text]`, `/edit drop N`, `/edit compare N`, `/edit restore N`, `/edit rewind N`, `/edit retry`. Edits are appended events; originals stay in the array. Full-text thinking (DeepSeek) can be edited to steer the model; summarised thinking (Claude, GPT) is refused with a pointer to appending a message.
- Compaction, automatic and manual, three built-in strategies (LLM summary, clear old tool results, both in sequence) and external modules via `--compaction ./my-strategy.mjs`.
- Sessions: `--continue`, `--resume <file>`, `/session` (new, fork from here, resume another); `clari sessions` lists them, `clari sessions prune --older-than 30d` or `--keep N` deletes old ones together with their recording, input, legacy trace and MCP sidecars, only with `--yes`. One-shot mode `clari once "task" --json` for A/B runs.
- Request inspector (Ctrl+R): select a request and press Enter. The summary connects its input, unchanged message prefix, response, tool results and next request. Sections `1`–`7` show summary, decisions, input messages, tools, HTTP JSON, response and recorded events; `[` / `]` change requests, `↑↓` selects a body block, `Enter` expands only that block, and `PgUp/PgDn` reads long bodies. `/inspect raw` and `/inspect tools` jump to the corresponding sections. Without captured definitions, tools are explicitly shown as current definitions that may differ from history.

Disk-backed sessions always save the adapter input (messages and tool definitions), each built-in HTTP attempt's request JSON and full received body, and tool output before conversion or truncation alongside the model-facing result. The append-only `<session>.jsonl` references bodies in `<session>.records/`; TUI, one-shot, compaction and child runs share this path. Original bodies are folded in the inspector; select a block and press `Enter` to expand. Forks copy their referenced bodies and pruning removes them with their session.

Events are captured as independent JSON snapshots. Draft and queued image objects are copied at handoff, so callers and readers cannot silently modify pending attachments. Context edits append events instead of rewriting recorded history. One recording module owns file framing, tail recovery and ordered retries; recovery preserves valid history bytes and read-only inspection never repairs files.

The selected block's title and expansion state stay visible while paging. If saved input cannot be read, the input view shows the recording error and labels the fallback as reconstructed from events.

Session recovery preserves a complete final JSON event even if its newline was not written. Before continuing, it queues the missing separator; an incomplete tail is reported as recovered, while corruption in the middle remains an error. Read-only inspection does not rewrite the session file.

Before API/tool dispatch and after results, clari attempts to flush records to disk; streaming data is flushed about once a second. Saving failure leaves work running and pending records in memory. Automatic retries backfill retained data when storage recovers; `Ctrl+S` retries now. Neither reruns API requests or tools. Pending raw bodies have a 64 MiB buffer per session: exhaustion marks a permanent gap and stops capturing the rest of that body. New bodies resume after recovery. Event history remains in memory; this is not a total process-memory limit. Unfinished streams, missing files and size mismatches are explicit. Graceful exit reports unsaved records and offers retry or force exit. Force exit or power loss can lose unsaved data. Disk writes are synchronous; this policy removes failure waits, not all disk latency. HTTP capture does not prove remote delivery or execution success. Text viewers decode UTF-8; files retain received bytes. Custom providers use `options.record` for HTTP capture; custom tools use `ctx.output.write` for original output, otherwise returned text is identified as the source.

The inspector reads original response/tool bodies on expansion and caches unchanged content and layout. Internal recording events stay in the inspector; the transcript shows runtime results and saving/gap warnings.

**Image input:** `Alt+V` reads an image from the clipboard (`Ctrl+V` also works if forwarded by your terminal). Windows uses its native clipboard; Linux needs `wl-paste` or `xclip`. Pasting a single PNG/JPEG/GIF/WebP file path, optionally quoted, also attaches it on all platforms. File reads are limited to 48 MiB. Images stay in the draft until Enter; `Alt+I` lists/removes them. Enabled input saving retains draft and queued images. Sent images remain in session history and pass through Chat Completions, Responses and Anthropic Messages as image content, without OCR or resizing. The chosen model must support vision. Image token cost is not guessed; message estimates identify text tokens separately. macOS currently supports file-path attachment, not native image clipboard reading.

Recording excludes authentication headers, but request/tool content is saved locally and can contain project secrets. It does not reveal unreturned private model reasoning. The old `--trace`, `--no-trace`, `defaults.trace` and preset `trace` options are removed: delete these entries from existing configuration. Legacy trace reading and its duplicate in-memory raw-stream cache are deleted; only the session recording format is supported.
- Event view: one readable line per kernel event (a request says model, messages, tokens, cache hit and latency; a result says tool, size and duration; a compaction says range and ratio; an edit says field and tokens before and after), the right column says what the model sees of it now (`sent`, `kernel`, `covered`, `cleared`, `dropped`, `edited`), requests are chapters, `1`–`5` filter (all, conversation, kernel, changes, extensions), Enter opens a view page with the JSON and a projection page ("what became of it") behind it. Compaction comparison: original versus summary with tokens and ratio.
- System prompt assembled from sections (role, environment, project instructions, memory, skills, append) with `--prompt-sections` and `--instructions-as`; `/inspect prompt` shows each section's share.
- Optional cross-session memory, off by default: with `--memory` the model can only write one line at a time through the `remember` tool into the memory section of AGENTS.md, visible on screen and subject to approval; `/memory` shows, forgets one or clears.
- Strategy slots switchable in session with `/set` (pick the slot, then the value; `/inspect slots` shows them all); each switch is an event. Failed requests get a four-line error card: class, provider message, next step, where the raw body is.
- Prompt templates `~/.clari/prompts/*.md` as `/name args`; skills from `SKILL.md` in `~/.clari/skills`, `~/.claude/skills`, `.agents/skills`, `.claude/skills`; `allowed-tools` skip approval for that turn; extension modules `--extension ./x.mjs` add tools, replace slots, subscribe to events.
- Cost and cache: give prices in config and every step shows its cost and the running total; Anthropic prompt caching breakpoints by default; cache hit rate per step.
- Production edges: stream stall timeout and retry, bash timeout and output cap, large and binary file guards, CRLF-preserving and whitespace-tolerant edits, terminal restored on crash with the session file named.

## Quick start

Node 20 or newer:

```bash
npx github:hirovel/clari
```

Or from source:

```bash
pnpm install
pnpm tui
```

The first run writes `~/.clari/config.json` (`CLARI_CONFIG` changes the path). `clari --help` lists every option. `clari once "task"` runs one turn and exits, `clari replay <file>` replays a session, `clari sessions` lists sessions.

Approval defaults to `all`, as in pi: no confirmation prompts. Use `--approve policy` for rules (read-only tools pass, everything else asks, anything outside the working directory always asks; add rules like `/set approve allow bash:git *` in session or under `approval` in config) or `--approve ask` to confirm every call.

### Every option lives in config

`/settings` opens **Agent setup**: model, instructions and memory, tools and delegation, context management, execution and control, display and notifications, and recording. Start with the recommended values, then replace the parts you want to change. Each setting explains its effect, recommendation and when a change will take effect. Recommendations are starting points, not claims of optimal performance for every model.

The workspace starts in **This session**: changes are temporary. `Tab` switches to **Saved defaults**, where edits are saved for future starts and do not change the current session. Settings that need a restart say so. An existing `--preset` or explicit command-line option still takes precedence over saved defaults. `/settings key value` retains its direct apply-and-save behavior; `/set` remains a shortcut for session strategies.

Use the arrow keys and Enter to navigate; `/` searches all settings; `I` opens the full explanation; `R` previews restoring a setting's recommendation; `E` in a number or text picker opens an inline editor. Tool lists show Enabled and Disabled directly. Long lists scroll, and narrow terminals stack the explanation below the choices. Model selection uses the same workspace; provider keys still enter only through `/login`.

**Save as preset** captures the registered settings and model name under a new name. **Load preset** previews the changes, then replaces registered defaults with that preset over the built-in starting values; other saved configuration is retained. Restart to use them, or launch `clari --preset name`. Saved snapshots preserve automatic and unlimited choices even if defaults change later (`null` explicitly resets model, effort, preservation or maxSteps; an omitted field inherits defaults). Presets do not bundle credentials, provider connections, external extension code, or unregistered policy details. Saving never overwrites an existing preset name. A failed save keeps the workspace open and reports the failure.

The setting registry (`src/settings.ts`) generates the configuration template and palette entries. `src/setup.ts` holds the client-independent composition and explanations. The stale-plan reminder defaults to **off** (`planReminder: 0`); an existing explicit value is preserved. Recovery of an open plan after compaction remains separate.

Every command-line option has a counterpart in `~/.clari/config.json`. The template lists each knob at its built-in value under `defaults`:

```json
"defaults": {
  "compaction": "llm",
  "approve": "all",
  "execution": "sequential",
  "steering": "step",
  "toolPrompts": "explain",
  "subagent": false,
  "fold": true,
  "foldLines": 5,
  "foldSteps": 3,
  "screen": "alt",
  "notify": "unfocused",
  "prompt": { "sections": ["role", "env", "instructions", "memory", "skills", "append"], "instructionsAs": "system", "memory": false, "skills": { "list": "system", "load": "read" } }
}
```

`presets.<name>` holds the same keys as a named set for `--preset name`. Resolution order: command line, then preset, then `defaults`, then built-in. Dedicated blocks hold the richer structures: `approval` (rules), `toolPrompts` (level plus per-tool descriptions), `subagents` (approval, maxSteps, depth, types), `fetch`, `mcp`, `sessionsDir`.

### Try it without a key

```bash
pnpm demo          # start a local fake model and run one task; stdout is one JSON event per line
pnpm demo tui      # same fake model, open the UI; Ctrl+R opens the inspector
```

The fake model needs no network and no key; the kernel, tools, session files, UI and inspector are real.

### Provide a key

`pnpm tui` starts without any key. Context windows, output limits, effort levels and prices come from [models.dev](https://models.dev) (a snapshot ships in the package, a cached copy refreshes daily); the config only holds overrides, and the header shows where the window came from (`1M ctx (models.dev)`, red when assumed). Models the server lists but the config does not know can be picked too: their capability data comes from [models.dev](https://models.dev) (else copied from the most similar configured model, else assumed), the row says which, and picking one writes it into the config. On first start a dialog opens: pick the provider, paste the key (masked), it is checked with the provider's model list and saved, then pick a model. `/login` opens the same dialog any time; `/model` and `/models` are pickers too.

Where a key can come from, highest priority first:

1. The environment variable named by `apiKeyEnv`; the template uses `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.
2. `~/.clari/credentials.json`, written by the login dialog (`CLARI_CREDENTIALS=path` moves it). The config file never holds a key.
3. The provider's `apiKey` field in the config file, for throwaway setups such as the demo config.

Keys never enter the log, the request body shown in the inspector, or the wire JSON view.

### Relays and proxies

A relay is a provider with the same protocol and a different address. Add one under `providers`; see `examples/config.relay.json`:

- OpenAI-compatible (`/v1/chat/completions`): `protocol: "openai"`, `baseUrl` up to `/v1`, `models` with the relay's model names.
- Anthropic-compatible (`/v1/messages`): `protocol: "anthropic"`, `baseUrl` as the host; add `"promptCache": false` if the relay rejects cache breakpoints.
- Keys via `/login` in the UI (or `apiKeyEnv`).
- Open `/model` after start and pick its last row: it asks the relay which models exist and marks the ones in your config that do not.
- Extra parameters or headers the relay wants go through `extraBody` and `extraHeaders` verbatim.
- If a relay's stream goes quiet for long stretches, raise `stallTimeoutMs` or set it to 0.

Then `clari --model relay/claude-sonnet-5`, or make it the `default`.

Common invocations:

```bash
clari --model anthropic/claude-sonnet-5 --effort high
clari --continue
clari once "classify the TODOs under src" --json
clari replay sessions/<file>.jsonl --request 3
clari replay sessions/<file>.jsonl --compaction 1 --json
clari sessions prune --older-than 30d --yes
```

The UI runs on the alternate screen: a one-line header and two-line runtime area stay put while the transcript scrolls. Runtime shows waiting for a model, receiving output, pending tools, approval, retries and errors; context usage and session totals fit the available width. Input hints follow the current focus and steering setting. Printable characters, including `f` and `?`, stay in the draft. The inspector owns its navigation keys while open and shows `Ctrl+R returns to draft`; closing a view restores the previous focus. Mouse wheel scrolls, PgUp/PgDn select steps, Ctrl+Up/Down jump between user prompts, Ctrl+Shift+F searches, and dragging selects and copies. From history, Esc returns to the live end; a subsequent Esc interrupts the running turn. Every request is a step; the newest three stay open and older ones fold to one ledger line (`foldSteps`). `Ctrl+K` opens a command palette. `screen: main` keeps terminal scrollback.

Fourteen slash commands; a command with choices opens a numbered list, so sub-commands are picked, never typed: `/inspect`, `/set`, `/settings`, `/edit`, `/model`, `/login`, `/tools`, `/session`, `/memory`, `/compact`, `/copy`, `/stop`, `/quit`, `/help`. In the UI: `Esc` interrupts, `Ctrl+R` inspector (Tab cycles requests, events, compactions, context; `s` switches session), `Ctrl+E` context workbench (with a step selected, it opens at that step), `Ctrl+O` unfolds tool results (what a result shows by default depends on the tool, `results` in the config: `read`, `edit`, `write`, `glob` and `grep` report only the line count, `bash` shows the last `foldLines` lines, everything else the first `foldLines`), `Ctrl+T` thinking, `Ctrl+K` → Keyboard shortcuts, `/help`. Approval prompts and pickers are numbered lists: `↑↓` or `1`–`9` to choose, `Enter` to confirm, `Esc` to back out (in an approval prompt `Esc` denies); the letters `y a r n` still work.

## Layout

In the TUI, `/session` opens session actions. Enter uses the usual setup source; `d` opens an explicit choice: new sessions inherit the current composition, resumes use the target's last composition, and forks use the composition at the selected event prefix. Current display preferences carry across all three. Missing historical settings show proposed defaults before you continue; failed preparation keeps the current session and draft, with retry, adjustment and read-only history. Restoring history preserves its recorded system prompt; choosing the current composition or saved defaults regenerates the prompt as a logged edit. Existing user messages remain history; instructions configured as user messages are appended visibly.

Drafts and pending messages save locally per session by default, in `<session>.inputs.json`. Draft typing is saved after 200 ms of inactivity; queue changes, normal switches and exits flush immediately. A hard crash can lose that unsaved typing window. Restoring a session never sends pending inputs automatically. Esc pauses undelivered messages; an ordinary new prompt leaves them paused. `/session inputs` shows the queue: Enter edits a multiline message, `d` removes it, `c` continues all, and `s` retries saving. Message IDs exclude inputs already written to the event log on restore; this is not a guarantee of provider receipt or a replay policy for external tools. `/settings saveInputs off` or `--no-save-inputs` disables saving and removes the session's existing snapshot, while retaining input in memory during the current process. Empty snapshots are removed automatically; session pruning includes input snapshots. A saving failure remains visible and keeps switching or exit from discarding the current work.

When restoring a session with missing tool-result records, clari records an unknown outcome. `/session recovery` shows the original calls, arguments and recorded reasons. Opening the session or this view does not rerun tools or contact the model; your next interaction tells the agent to check actual state before deciding how to continue, with existing permissions. Unknown means that execution and side effects cannot be confirmed from the log. Recovery notices are separate from actual tool results and retain their provenance in the context inspector.

MCP calls that time out, are cancelled or lose their connection after dispatch also record an unknown outcome. The agent receives the reason and can continue checking during the current turn; Esc stops the turn until you interact again. The framework does not retry tools automatically or add approval steps. Requests cancelled before dispatch are not sent, and explicit server errors remain errors. Ending local HTTP waiting does not confirm remote cancellation. Late responses to settled requests are discarded; this is not a background result collector. Earlier logs are not reclassified by matching error text.

`/quit` or Ctrl+C requests cancellation and shows an exit view while waiting for the turn and resource cleanup. Calls without results remain visible with their arguments. Repeated Ctrl+C keeps waiting; `f` explicitly forces exit. Force exit flushes input saving when enabled and records the request and missing outcomes; saving failures remain visible for retry. Turning input saving off still means unsaved drafts are not persisted. The view stays available if an extension's cleanup hangs or fails, including the underlying cleanup error. Force exit ends clari; external processes or remote work may continue, and unrecorded output may be lost. There is no automatic force-exit timer.

An uncaught exception or unhandled rejection enters the same exit view and blocks new work. The original failure stays separate from saving or cleanup errors. If input saving fails, `r` retries saving and continues shutdown; `f` tries saving before forcing exit. Graceful and manual exits return code 70. If shutdown itself fails or another uncaught error occurs, clari attempts to save inputs and restore the terminal, reports both failures and any saving error, then exits with code 70. This does not confirm that external work stopped. Ordinary model or tool errors do not trigger this fatal-exit path.

New sub-agent tasks skip IDs with existing child-session logs, including after restoring the parent session. Explicit continuation of a child records missing tool outcomes as unknown and presents that context to its next model request; it does not automatically rerun the missing calls. The task tool currently waits for its child to finish and shares the parent's cancellation signal; it is not a background job handle.

Each child dispatch or continuation uses the parent's currently enabled tools and model, subject to the selected sub-agent type. That selection stays fixed for the run. Built-in tools and extension factories are instantiated for the child; MCP calls and artifacts use its own log and directory while healthy connections are shared. Resources are released when the run ends, including on failure. Each run starts bash in the project directory; child history survives continuation. Nested tasks inherit their immediate parent's tool subset.

Healthy MCP connections with unchanged configuration are reused, with separate tool wrappers, logs and artifact directories per session. Select servers to reconnect using `defaults.mcpReconnect`, `--mcp-reconnect server1,server2`, or the setup workbench. `/inspect mcp` shows the connection decision. Extensions load per session and can return an async `dispose()`; subscriptions detach automatically. An extension that shares external resources manages their ownership explicitly, and a factory that throws before returning must clean up its partial initialization.

```
src/        kernel: events, log, projections, providers, loop and slots, compaction, sub-agents, config
cli/        terminal: entries, UI, inspector, system prompt assembly, tools, MCP bridge, sessions
tests/      offline: a virtual terminal drives the full render pipeline; a local fake server drives the full HTTP/SSE path
scripts/    fake model, demo, publish
```

Every replaceable point is a plain function type: compaction strategy, preservation policy, termination, steering, approval, sub-agent context scope, provider, tool. Write another implementation, inject it at the entry, run the same task in one-shot mode, compare the two session files.

## Development

`pnpm checkup sessions/<file>.jsonl` compares request estimates with reported usage offline. Its nine checks cover reconstructed message prefixes and counts, estimate drift, cache-usage consistency, compaction estimates, recovery, tool errors, thinking metadata, and recorded response coverage. Heuristics are labeled; insufficient evidence is skipped. Initial estimates are excluded from usage-based drift comparisons. Message-prefix estimates are not cache limits, and received thinking records do not prove an outbound round trip. No key is printed.

`AGENTS.md` holds the working rules for anyone, human or agent, changing this repository; `HANDOVER.md` holds the current state, a module map, the invariants, the open work and the traps.

```bash
pnpm check   # tsc + biome + vitest
```

TypeScript strict. Runtime dependencies: pi-tui as the rendering engine and TypeBox for schemas.

Tests stay small and risk-driven: extend an existing scenario first, cover each distinct failure at its appropriate layer, and keep cross-layer tests for actual integration risks. Do not add tests that mirror implementation or freeze cosmetic copy and spacing. Visual review uses the existing preview scripts. Run focused checks during implementation and one full `pnpm check` at completion; test count and coverage percentages are not targets.

## Status

Kernel and UI are built and covered by offline tests end to end; live API runs are in progress. See [CHANGELOG.md](CHANGELOG.md).
