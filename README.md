# clari

A hand-written coding-agent kernel and terminal UI in TypeScript. The kernel keeps one append-only array of events; the messages the model sees, every line on screen, the context statistics and the compaction views are all projections of that array.

中文说明见 [README.zh-CN.md](README.zh-CN.md)。

## Two principles

- **End to end.** Intelligence lives at the two ends: the model acts, the user decides. The kernel in the middle only transports reliably and hides nothing. Zero intervention by default; termination, approval, steering, compaction are explicit strategy slots.
- **Full transparency.** Anything the model can see is already in the log; any decision the kernel makes is an event. The inspector reconstructs any request byte for byte and shows any compaction as "this stretch of history became this summary".

## What it does today

- Tools: read (files and directories), write, edit with exact match and `replaceAll`, bash, grep, glob, fetch (HTML to markdown, private networks refused, size and time limits, cross-host redirects handed back to the model), sub-agents via task.
- Tool descriptions in three styles (`guided`, `terse`, `strict`), switched with `--tool-prompts` or `/toolprompts`, edited per tool in your editor and saved to config. The model only ever sees the description text.
- MCP client, zero dependencies: stdio and Streamable HTTP, the 2026-07-28 stateless protocol and the legacy handshake. Configure `mcp.servers` or a project `.mcp.json`; tools are named `mcp__server__tool`, approval rules `mcp:server:tool`, every JSON-RPC exchange is an `ext/event`, `/mcp` shows status. The kernel has no MCP-specific code; delete `cli/mcp/` if you do not want it.
- Three protocols (OpenAI chat completions, OpenAI Responses, Anthropic Messages), per-model capability data in config, `extraBody` pass-through, `/models` to detect retired models, `/fields` to list what the current protocol sends and reads, provider metadata kept verbatim in `extras`.
- One Request card per request: a `changed` line first (which messages are new, edited or summarised and what it costs: messages recomputed, cache ceiling, thinking blocks dropped), then parameters, system sections, tools, every message with event number, role, tokens and first line, and the distance to auto-compaction. One Response card: stop reason, timing, cost, measured versus predicted cache hit, then reply, thinking, call, result, opaque, extras and raw rows. Thinking folds to one line; Ctrl+T expands.
- Context editing: Ctrl+E opens the context panel; Enter on a message gives an action menu (view, edit, compare, restore, drop, rewind, retry, fork) with a one-line consequence each. Commands `/edit N [field] [text]`, `/drop N`, `/compare N`, `/restore N`, `/rewind N`, `/retry`. Edits are appended events; originals stay in the array. Full-text thinking (DeepSeek) can be edited to steer the model; summarised thinking (Claude, GPT) is refused with a pointer to appending a message.
- Compaction, automatic and manual, three built-in strategies (LLM summary, clear old tool results, both in sequence) and external modules via `--compaction ./my-strategy.mjs`.
- Sessions: `--continue`, `--resume <file>`, `/fork`; `clari sessions` lists them, `clari sessions prune --older-than 30d` or `--keep N` deletes old ones together with their trace and MCP sidecars, only with `--yes`. One-shot mode `clari once "task" --json` for A/B runs.
- Request inspector (Ctrl+R): one line per request, then summary, decisions, sent messages, tool definitions, wire JSON, received stream (recorded by default, `/raw N` jumps there), written events. `/tools` lists the definitions sent with every request and their token cost.
- Event view for every kernel event, compaction comparison (original versus summary with tokens and ratio), composition view (which event each message comes from, which stages it passed, where it lands in the wire body).
- System prompt assembled from sections (role, environment, project instructions, memory, skills, append) with `--prompt-sections` and `--instructions-as`; `/prompt` shows each section's share.
- Optional cross-session memory, off by default: with `--memory` the model can only write one line at a time through the `remember` tool into the memory section of AGENTS.md, visible on screen and subject to approval; `/memory` lists and deletes.
- Strategy slots switchable in session: `/slots`, `/compaction`, `/preservation`, `/execution`, `/steering`, `/approve`, `/toolprompts`; each switch is an event. Failed requests get a four-line error card: class, provider message, next step, where the raw body is.
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

Approval defaults to `all`, as in pi: no confirmation prompts. Use `--approve policy` for rules (read-only tools pass, everything else asks, anything outside the working directory always asks; add rules like `/approve allow bash:git *` in session or under `approval` in config) or `--approve ask` to confirm every call.

### Every option lives in config

Every command-line option has a counterpart in `~/.clari/config.json`. The template lists each knob at its built-in value under `defaults`:

```json
"defaults": {
  "compaction": "llm",
  "approve": "all",
  "execution": "sequential",
  "steering": "step",
  "toolPrompts": "guided",
  "subagent": false,
  "trace": true,
  "fold": false,
  "prompt": { "sections": ["role", "env", "instructions", "memory", "skills", "append"], "instructionsAs": "system", "memory": false, "skills": { "list": "system", "load": "read" } }
}
```

`presets.<name>` holds the same keys as a named set for `--preset name`. Resolution order: command line, then preset, then `defaults`, then built-in. Dedicated blocks hold the richer structures: `approval` (rules), `toolPrompts` (style plus per-tool descriptions), `fetch`, `mcp`, `sessionsDir`.

### Try it without a key

```bash
pnpm demo          # start a local fake model and run one task; stdout is one JSON event per line
pnpm demo tui      # same fake model, open the UI; Ctrl+R opens the inspector
```

The fake model needs no network and no key; the kernel, tools, session files, UI and inspector are real.

### Provide a key

Three ways, highest priority first:

1. The provider's `apiKey` field in the config file (`/key deepseek sk-xxx` in the UI writes it there).
2. The environment variable named by `apiKeyEnv`; the template uses `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.
3. Another config file: `CLARI_CONFIG=path`.

Keys never enter the log, the request body shown in the inspector, or the wire JSON view.

### Relays and proxies

A relay is a provider with the same protocol and a different address. Add one under `providers`; see `examples/config.relay.json`:

- OpenAI-compatible (`/v1/chat/completions`): `protocol: "openai"`, `baseUrl` up to `/v1`, `models` with the relay's model names.
- Anthropic-compatible (`/v1/messages`): `protocol: "anthropic"`, `baseUrl` as the host; add `"promptCache": false` if the relay rejects cache breakpoints.
- Keys via `apiKeyEnv` or `/key provider secret` in the UI.
- Run `/models` after start: it asks the relay which models exist and marks the ones in your config that do not.
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

In the UI: `Esc` interrupts, `Ctrl+R` inspector (Tab cycles requests, events, compactions, context; `s` switches session), `Ctrl+E` context panel, `Ctrl+O` folds tool results, `Ctrl+T` thinking, `?` shortcuts, `/help`.

## Layout

```
src/        kernel: events, log, projections, providers, loop and slots, compaction, sub-agents, config
cli/        terminal: entries, UI, inspector, system prompt assembly, tools, MCP bridge, sessions
tests/      offline: a virtual terminal drives the full render pipeline; a local fake server drives the full HTTP/SSE path
scripts/    fake model, demo, publish
```

Every replaceable point is a plain function type: compaction strategy, preservation policy, termination, steering, approval, sub-agent context scope, provider, tool. Write another implementation, inject it at the entry, run the same task in one-shot mode, compare the two session files.

## Development

```bash
pnpm check   # tsc + biome + vitest
```

TypeScript strict. Runtime dependencies: pi-tui as the rendering engine and TypeBox for schemas.

## Status

Kernel and UI are built and covered by offline tests end to end; live API runs are in progress. See [CHANGELOG.md](CHANGELOG.md).
