# clari

终端里的 coding agent，可以查看每次请求，调整工具和上下文。使用 TypeScript 编写。

[English](README.md)

## 快速开始

需要 Node.js 22.19 或更高版本，以及 Git。在项目目录运行：

```sh
npx --yes github:hirovel/clari
```

这条命令下载并运行 clari，不安装全局 `clari` 命令。首次启动选择供应商、输入 API key，再选择模型。之后用 `/login` 管理凭据，用 `/model` 切换模型。

Windows 的 bash 工具需要 Git for Windows。文件搜索优先使用 ripgrep，未安装时使用内置搜索。

## 使用

在终端输入任务。Agent 可以读写和编辑文件、执行 shell 命令、搜索文件和获取网页。子任务通过 `--subagent` 开启，MCP 工具通过配置接入。

| 操作 | 作用 |
| --- | --- |
| Enter | 发送；运行中按当前插话策略排队 |
| Alt+Enter | 排队，等当前轮结束后发送 |
| Esc | 关闭当前视图、从历史回到实时末尾，或中断当前轮 |
| Ctrl+R | 检视已记录的请求与响应 |
| Ctrl+E | 查看并编辑下一次请求的上下文 |
| Ctrl+K | 打开命令面板，包括快捷键说明 |
| Alt+V / Alt+I | 粘贴图片 / 管理草稿图片 |
| `/settings` | 调整当前组合或保存默认值 |
| `/session` | 新建、恢复或分叉会话 |
| `/help` | 查看命令 |

检视器内用方向键选择内容块，Enter 展开当前块。编辑器内的普通字符仍作为输入。

图片需要支持视觉的模型。Windows 支持剪贴板图片，Linux 需要 `wl-paste` 或 `xclip`。也可以粘贴 PNG、JPEG、GIF 或 WebP 文件路径。macOS 暂时只支持图片路径。

命令行参数放在包名后：

```sh
npx --yes github:hirovel/clari --continue
npx --yes github:hirovel/clari once "查找测试失败的原因" --json
npx --yes github:hirovel/clari --help
```

默认执行工具不弹审批。`--approve policy` 按规则审批，`--approve ask` 逐次确认。一次性 `once` 模式不能交互审批。

## 配置

首次启动生成 `~/.clari/config.json`。`/login` 将 key 单独保存到 `~/.clari/credentials.json`。`CLARI_HOME` 修改用户目录，`CLARI_CONFIG` 指定配置文件。

`/settings` 默认进入 **This session**，只修改当前会话。Tab 切到 **Saved defaults**，保存后供后续启动使用。可以保存命名方案，通过 `--preset 名称` 加载。优先级依次是命令行参数、方案、已保存默认值、内置默认值。

支持 OpenAI Chat Completions、OpenAI Responses 和 Anthropic Messages。兼容端点通过 `protocol`、`baseUrl`、`models` 和 `apiKeyEnv` 配置；`extraBody`、`extraHeaders` 透传供应商参数。参见[中转配置示例](examples/config.relay.json)。

可定制的部分：

- `/settings` 中的工具开关与描述、模型设置、提示词分段和上下文压缩。
- `AGENTS.md` 中的项目指令；`--memory` 开启可选记忆。
- `~/.clari/prompts/` 中的提示词模板，以及 `~/.clari/skills/` 或项目 `.agents/skills/` 中的技能。调用技能时发送原文指令，后接本次要求；`$1`、`$ARGUMENTS` 替换只用于提示词模板。技能元数据使用标准 YAML 解析；无效文件单独跳过，并显示路径和原因。
- 技能默认用 `/名称` 手动调用。`/settings` 可开启自动选择、勾选范围，选择 `read` 或 `skill` 加载。`prompt.skills.include` 保存为 `"all"` 时包含后续启动发现的新技能，名称数组则固定范围。自动模式的 `read` 把目录放入 system 提示词，`skill` 把目录放入工具定义，加载后的正文作为工具结果进入上下文。手动调用作为用户消息。修改影响后续请求，已加载的正文保留在历史中。
- `mcp.servers` 或项目 `.mcp.json` 中的 MCP 服务。
- `--extension` 加载的 TypeScript/JavaScript 扩展，用于添加工具、替换策略函数。

## 会话与上下文

会话默认保存在 `./sessions/`。通过 `CLARI_SESSIONS` 或 `sessionsDir` 修改位置。`--continue` 恢复最近的会话，`--resume <文件>` 恢复指定会话。

历史是一个追加式事件数组。编辑、排除或压缩上下文，会改变下一次请求从历史生成的消息，原文仍然保留。上下文回退不会撤销文件修改或其他工具副作用。

会话 `.jsonl` 引用 `.records/` 目录里的正文，包括适配器输入、内置供应商的 HTTP 请求与响应、工具原始输出和送给模型的结果。Ctrl+R 区分已保存正文、重建视图与记录缺口。不记录鉴权头；请求与工具内容会保存在本地。

草稿和待发送消息默认也保存。恢复会话或中断后，队列等你主动继续；`--no-save-inputs` 关闭输入保存。无法确认的工具结果明确显示为未知，恢复会话不会自动重跑工具。

保存失败会提示，工作继续。待写记录在内存中重试；原始正文缓冲每会话最多 64 MiB，耗尽后明确记录缺口。强退或断电可能丢失未保存的数据。`/quit` 等待取消和保存，同时提供手动强退入口。

## 开发

```sh
git clone https://github.com/hirovel/clari.git
cd clari
pnpm install
pnpm tui
```

```sh
pnpm check       # 类型、格式和测试
pnpm build       # 清理 dist 后编译
pnpm demo tui    # 本地脚本模型，不需要 API key
```

`npm pack` 构建安装包。在仓库内运行 `npm install -g ./clari-0.1.0.tgz`，安装后可直接使用 `clari`。

| 职责 | 模块 |
| --- | --- |
| 事件与上下文投影 | `src/events.ts`、`log.ts`、`messages.ts` |
| 保存与请求记录 | `src/recording.ts`、`exchange.ts` |
| Agent 循环与策略 | `src/agent.ts`、`loop.ts`、`compaction.ts`、`subagent.ts` |
| 供应商与工具 | `src/provider.ts`、`providers/`、`tools.ts`、`cli/tools/`、`cli/mcp/` |
| 配置与会话资源 | `src/settings.ts`、`setup.ts`、`cli/model-settings.ts`、`bootstrap.ts`、`session-*.ts` |
| 终端交互 | `cli/tui-*.ts`、`inspector*.ts`、`session-view.ts` |

测试保护独立故障风险，优先扩充已有场景。真实 API 验收独立于默认测试集合。运行时依赖是 pi-tui 和 TypeBox。

项目仍在开发。原生终端、剪贴板和供应商验收尚未覆盖完整。参见[变更记录](CHANGELOG.md)。
