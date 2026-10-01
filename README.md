# Clari

Clari is a minimal, configurable AI agent for the terminal.

- **See what the model sees.** Inspect request bodies, responses, returned reasoning and tool results.
- **Change what comes next.** Edit or exclude context inside the terminal while keeping the original history.
- **Build your agent.** Choose models, tools, skills and strategies, then save your setup as a preset.

![Clari setup: independently configurable components](assets/clari-setup.png)

Configure each component in `/settings`.

[中文](README.zh-CN.md) · [Changelog](CHANGELOG.md)

## Getting started

Install Clari:

```sh
npm install -g https://github.com/hirovel/clari/releases/download/v0.1.0/clari.tgz
```

Requires Node.js 22.19+.

Start it in your project directory:

```sh
clari
```

On first launch, choose a provider, enter your API key and select a model.

Type a task and press Enter to send it. Esc interrupts the turn; `/quit` exits.

Inside Clari, use `/help` for commands and keyboard shortcuts, and `/settings` for configuration.

Run `clari --help` for startup options.

To update to the latest release, close Clari and run:

```sh
npm install -g https://github.com/hirovel/clari/releases/latest/download/clari.tgz
```

To run from GitHub without a global installation, use `npx --yes github:hirovel/clari` (requires Git).

## Using Clari

### Inspect API exchanges

Ctrl+R opens requests in order. Inspect sent messages, tool definitions, captured HTTP JSON, replies, returned reasoning and original tool output. In the sent and received views, use ↑↓ to select a block, Enter to expand it and PgUp/PgDn to page through its contents. Saved bodies, reconstructed views and missing records are labeled separately.

### Edit context

Ctrl+E opens the next request's context. Edit system instructions, messages and tool results in the internal editor. Exclude messages, restore edited text, or rewind context to an earlier step. Original content and edit records remain available for comparison.

### Configure your setup

`/settings` separates the current session from saved defaults. Select tools and automatic skills, configure skill directories, model effort and context strategies. Preview status-bar layouts and toggle individual components. Save and load named presets.

Skills are manual by default: `/name your request`. Automatic selection is optional. MCP tools and JavaScript/TypeScript extensions add capabilities or replace strategies.

### Work and resume

Built-in tools read, write and edit files, run commands, search file contents and paths, and fetch pages. The agent continues through tool calls until the model finishes; Esc interrupts the turn. `/session` creates, resumes and forks sessions. History, API bodies and original tool output are stored locally.

Providers support OpenAI Chat Completions, OpenAI Responses and Anthropic Messages. See the [relay configuration example](examples/config.relay.json) for compatible endpoints.

## Development

Clone the repository, install dependencies and run Clari from source:

```sh
git clone https://github.com/hirovel/clari.git
cd clari
pnpm install
pnpm tui
```

Before submitting changes, run:

```sh
pnpm check
```

## License

[MIT](LICENSE)
