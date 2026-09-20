# clari

A terminal coding agent with inspectable requests and configurable tools and context. Written in TypeScript.

[中文](README.zh-CN.md)

## Quick start

Requires Node.js 22.19 or newer and Git. Run in your project directory:

```sh
npx --yes github:hirovel/clari
```

This downloads and runs clari; it does not install a global `clari` command. On first launch, choose a provider, enter your API key and select a model. Use `/login` to change credentials and `/model` to switch models.

Windows requires Git for Windows for the bash tool. File search uses ripgrep when available and falls back to built-in search.

## Usage

Type a task in the terminal. The agent can read, write and edit files, run shell commands, search files and fetch web pages. Sub-agents are optional (`--subagent`). MCP tools can be added through configuration.

| Control | Action |
| --- | --- |
| Enter | Send; while running, queue at the configured steering boundary |
| Alt+Enter | Queue for the end of the current turn |
| Esc | Close the current view, return from history, or interrupt the active turn |
| Ctrl+R | Inspect recorded requests and responses |
| Ctrl+E | Inspect and edit the next request's context |
| Ctrl+K | Open the command palette, including keyboard shortcuts |
| Alt+V / Alt+I | Paste an image / manage draft images |
| `/settings` | Change the current setup or saved defaults |
| `/session` | Create, resume or fork a session |
| `/help` | Show commands |

In the inspector, select a body block with the arrow keys and press Enter to expand it. Printable keys in the editor remain text input.

Image input requires a vision-capable model. Clipboard images work on Windows and on Linux with `wl-paste` or `xclip`. Pasting a PNG, JPEG, GIF or WebP file path also works. macOS currently supports image paths only.

Pass command-line options after the package name:

```sh
npx --yes github:hirovel/clari --continue
npx --yes github:hirovel/clari once "Find the cause of the failing test" --json
npx --yes github:hirovel/clari --help
```

Tools run without approval prompts by default. Use `--approve policy` for rule-based approval or `--approve ask` to confirm each call. The one-shot `once` mode cannot ask interactively.

## Configuration

The first launch creates `~/.clari/config.json`. `/login` saves keys separately in `~/.clari/credentials.json`. `CLARI_HOME` changes the user directory; `CLARI_CONFIG` overrides the config path.

`/settings` opens **This session** by default. Tab switches to **Saved defaults** for future launches. Named presets can be saved there and loaded with `--preset name`. Precedence is command-line options, preset, saved defaults, then built-in defaults.

Supported protocols are OpenAI Chat Completions, OpenAI Responses and Anthropic Messages. Compatible endpoints are configured with `protocol`, `baseUrl`, `models` and `apiKeyEnv`; `extraBody` and `extraHeaders` pass through provider-specific options. See [relay configuration](examples/config.relay.json).

Customization includes:

- Tool toggles and descriptions, model settings, prompt sections and context compaction in `/settings`.
- Project instructions in `AGENTS.md`; optional memory with `--memory`.
- Prompt templates in `~/.clari/prompts/` and skills in `~/.clari/skills/` or the project's `.agents/skills/`. Skill calls send the instructions unchanged, followed by your request. `$1` and `$ARGUMENTS` substitution belongs to prompt templates. Skill metadata uses standard YAML parsing; invalid files are skipped with their path and error shown.
- Skills default to manual `/name` invocation. `/settings` offers automatic selection, a checkbox range and `read` or `skill` loading. Save `prompt.skills.include` as `"all"` to include new skills on future starts, or as a name array to fix the range. In automatic mode, `read` puts the catalog in the system prompt; `skill` puts it in the tool definition. Instructions arrive as tool results when loaded. Manual calls are user messages. Changes affect later requests; loaded instructions stay in history.
- MCP servers in `mcp.servers` or the project's `.mcp.json`.
- TypeScript/JavaScript extensions loaded with `--extension`, adding tools and replacing strategy functions.

## Sessions and context

Sessions are saved under `./sessions/` by default. Set `CLARI_SESSIONS` or `sessionsDir` to change the location. `--continue` resumes the latest session; `--resume <file>` opens a specific one.

The history is an append-only event array. Editing, excluding or compacting context changes the messages derived for the next request; the original history stays available. Context rewind does not undo file changes or other tool effects.

Each session's `.jsonl` file references bodies in its `.records/` directory: adapter input, built-in providers' HTTP request and response bodies, original tool output and model-facing results. Ctrl+R distinguishes saved bodies, reconstructed views and missing records. Authentication headers are not recorded; request and tool content is saved locally.

Drafts and queued inputs are also saved by default. Restored or interrupted queues wait for you to continue. `--no-save-inputs` disables this. Unknown tool outcomes are shown explicitly; restoring a session does not rerun tools.

Saving failures are visible and do not block work. Pending records retry in memory; raw-body buffering is limited to 64 MiB per session, with explicit gaps after exhaustion. Forced exit or power loss can lose unsaved data. `/quit` waits for cancellation and saving, with a manual force-exit option.

## Development

```sh
git clone https://github.com/hirovel/clari.git
cd clari
pnpm install
pnpm tui
```

```sh
pnpm check       # types, lint and tests
pnpm build       # clean dist and compile
pnpm demo tui    # local scripted model; no API key
```

`npm pack` builds the installable package. From the repository, `npm install -g ./clari-0.1.0.tgz` installs that package as `clari`.

| Area | Modules |
| --- | --- |
| Events and context projection | `src/events.ts`, `log.ts`, `messages.ts` |
| Persistence and request records | `src/recording.ts`, `exchange.ts` |
| Agent loop and strategies | `src/agent.ts`, `loop.ts`, `compaction.ts`, `subagent.ts` |
| Providers and tools | `src/provider.ts`, `providers/`, `tools.ts`, `cli/tools/`, `cli/mcp/` |
| Configuration and session resources | `src/settings.ts`, `setup.ts`, `cli/model-settings.ts`, `bootstrap.ts`, `session-*.ts` |
| Terminal UI | `cli/tui-*.ts`, `inspector*.ts`, `session-view.ts` |

Tests cover distinct failure risks; extend existing scenarios before adding new ones. Real API checks are separate from the default suite. Runtime dependencies are pi-tui and TypeBox.

Active development. Native terminal, clipboard and provider coverage is incomplete. See [changes](CHANGELOG.md).
