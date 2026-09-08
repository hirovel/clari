# clari

A hand-written coding-agent kernel and terminal UI in TypeScript. The kernel keeps one append-only array of events; the messages the model sees, every line on screen, the context statistics and the compaction views are all projections of that array.

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## Two principles

- **End to end.** Intelligence lives at the two ends: the model acts, the user decides. The kernel in the middle only transports reliably and hides nothing. Zero intervention by default; termination, approval, steering, compaction are explicit strategy slots.
- **Full transparency.** Anything the model can see is already in the log; any decision the kernel makes is an event. The inspector reconstructs any request byte for byte and shows any compaction as "this stretch of history became this summary".

## What it does today

- Tools: read (files and directories), write, edit with exact match and `replaceAll`, bash, grep, glob, fetch (HTML to markdown, private networks refused, size and time limits, cross-host redirects handed back to the model), sub-agents via task.
- Tool descriptions in three levels (`brief`, `explain`, `rules`) composed from one source per tool (core, guidance, rules), switched with `--tool-prompts` or `/set toolprompts`, edited per tool in your editor and saved to config. The model only ever sees the description text.
- Sub-agents (`--subagent`): the `task` tool runs a child on its own event log and session file. The child follows the parent's approval rules (`subagents.approval`: `inherit`, `allow`, or extra `deny` rules), can be capped (`subagents.maxSteps`), resumed (`task` with `resume: "sub-N"`), typed (`subagents.types`: system prompt, tools, model, scope) and nested to `subagents.depth`.
- MCP client, zero dependencies: stdio and Streamable HTTP, the 2026-07-28 stateless protocol and the legacy handshake. Configure `mcp.servers` or a project `.mcp.json`; tools are named `mcp__server__tool`, approval rules `mcp:server:tool`, every JSON-RPC exchange is an `ext/event`, `/inspect mcp` shows status. The kernel has no MCP-specific code; delete `cli/mcp/` if you do not want it.
- Three protocols (OpenAI chat completions, OpenAI Responses, Anthropic Messages), per-model capability data in config, `extraBody` pass-through, `/model` (its last row asks the provider) to detect retired models, `/inspect fields` to list what the current protocol sends and reads, provider metadata kept verbatim in `extras`.
- No status bar. Facts the model cannot compute ride on the event that produced them: a result notes a repeated failure with the same arguments or an unusually slow call (`facts` in the config), bash reports its working directory when it changes, a date change is one appended line. Task state is the model's own: the `plan` tool writes a checklist, and the kernel restates it only after a compaction or after `planReminder` steps without an update. Nothing is ever inserted before the newest message, so the cached prefix stays intact.
- The transcript prints only the conversation and the tools: `›` your message, the reply, `»` each call, `└ ✓` each result. No labels, no cards, no numbers in the body. A line appears only when the context changed in a way other tools hide: `✎` a message was edited, `≈` the context was compacted or the cached prefix was recomputed, the cache hit rate fell below half of what was expected, or the context window is an assumed value. Every request as sent and received, with parameters, system sections, tool definitions, every message's tokens and state, usage and cost, is in the inspector (`Ctrl+R`) and the context panel (`Ctrl+E`). Thinking folds to one faint line; Ctrl+T expands.
- Context workbench: Ctrl+E shows the next request as the model will receive it, in order: the system prompt, the tool definitions, every message with its tokens and a share bar, the compaction summary with the covered messages folded under it, dropped messages faint in place, and a line where the last request's cached prefix ends (it moves up and turns gold after an edit). The bottom of the screen previews the selected row. Enter on a message gives a numbered action menu (view, edit, compare, restore, drop, rewind, retry, fork) with a one-line consequence each; Enter on the system row lists the prompt sections and flips one for the session (recorded as an edit of event #0); Enter on the tools row opens `/tools`; Enter on the summary opens the compaction comparison. Typed forms: `/edit N [field] [text]`, `/edit drop N`, `/edit compare N`, `/edit restore N`, `/edit rewind N`, `/edit retry`. Edits are appended events; originals stay in the array. Full-text thinking (DeepSeek) can be edited to steer the model; summarised thinking (Claude, GPT) is refused with a pointer to appending a message.
- Compaction, automatic and manual, three built-in strategies (LLM summary, clear old tool results, both in sequence) and external modules via `--compaction ./my-strategy.mjs`.
- Sessions: `--continue`, `--resume <file>`, `/session` (new, fork from here, resume another); `clari sessions` lists them, `clari sessions prune --older-than 30d` or `--keep N` deletes old ones together with their trace and MCP sidecars, only with `--yes`. One-shot mode `clari once "task" --json` for A/B runs.
- Request inspector (Ctrl+R): one line per request, then summary, decisions, sent messages, tool definitions, wire JSON, received stream (recorded by default, `/inspect raw` jumps there), written events. `/inspect tools` lists the definitions sent with every request and their token cost.
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

`/settings` in the UI lists every switch on one screen, grouped by purpose, with its current value, a one-line meaning and where the value came from (`config`, `preset`, `flag`, `built-in`); Enter changes it, the change takes effect at once where it can (`next start` otherwise) and is written to `defaults` in the config file. `/set` is the session-only counterpart for the strategy slots. The list of switches, their groups, choices and built-in defaults is one table in the kernel (`src/settings.ts`); the config template and the palette entries are generated from it, and a test checks the command-line parser knows every key.

Every command-line option has a counterpart in `~/.clari/config.json`. The template lists each knob at its built-in value under `defaults`:

```json
"defaults": {
  "compaction": "llm",
  "approve": "all",
  "execution": "sequential",
  "steering": "step",
  "toolPrompts": "explain",
  "subagent": false,
  "trace": true,
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

The UI runs on the alternate screen: the header and status line stay put, the transcript scrolls (mouse wheel, PgUp/PgDn move between steps, Ctrl+Up/Down jump between requests, Ctrl+Shift+F searches, drag to select copies). Every request is a step; the newest three stay open and older ones fold to one ledger line (`foldSteps`). `Ctrl+K` opens a command palette. `screen: main` in the config keeps the terminal scrollback instead.

Fourteen slash commands; a command with choices opens a numbered list, so sub-commands are picked, never typed: `/inspect`, `/set`, `/settings`, `/edit`, `/model`, `/login`, `/tools`, `/session`, `/memory`, `/compact`, `/copy`, `/stop`, `/quit`, `/help`. In the UI: `Esc` interrupts, `Ctrl+R` inspector (Tab cycles requests, events, compactions, context; `s` switches session), `Ctrl+E` context workbench (with a step selected, it opens at that step), `Ctrl+O` unfolds tool results (what a result shows by default depends on the tool, `results` in the config: `read`, `edit`, `write`, `glob` and `grep` report only the line count, `bash` shows the last `foldLines` lines, everything else the first `foldLines`), `Ctrl+T` thinking, `?` shortcuts, `/help`. Approval prompts and pickers are numbered lists: `↑↓` or `1`–`9` to choose, `Enter` to confirm, `Esc` to back out (in an approval prompt `Esc` denies); the letters `y a r n` still work.

## Layout

```
src/        kernel: events, log, projections, providers, loop and slots, compaction, sub-agents, config
cli/        terminal: entries, UI, inspector, system prompt assembly, tools, MCP bridge, sessions
tests/      offline: a virtual terminal drives the full render pipeline; a local fake server drives the full HTTP/SSE path
scripts/    fake model, demo, publish
```

Every replaceable point is a plain function type: compaction strategy, preservation policy, termination, steering, approval, sub-agent context scope, provider, tool. Write another implementation, inject it at the entry, run the same task in one-shot mode, compare the two session files.

## Development

`AGENTS.md` holds the working rules for anyone, human or agent, changing this repository; `HANDOVER.md` holds the current state, a module map, the invariants, the open work and the traps.

```bash
pnpm check   # tsc + biome + vitest
```

TypeScript strict. Runtime dependencies: pi-tui as the rendering engine and TypeBox for schemas.

## Status

Kernel and UI are built and covered by offline tests end to end; live API runs are in progress. See [CHANGELOG.md](CHANGELOG.md).
