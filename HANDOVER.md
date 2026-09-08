# clari 交接文档

写给接手这个仓库的下一个 agent。先读 [AGENTS.md](AGENTS.md)(规则),再读本文(现状、地图、不变量、待办、坑),需要设计依据时查 `docs/architecture.html`。

## 1 现状(2026-09-07)

- 本地 master 最新提交 71e8038;公开仓库 github.com/hirovel/clari 落后约 90 个提交,自 2026-09-06 的界面改版起全部未发布。发布命令在 AGENTS.md。
- 测试 54 个文件、367 个用例,全绿;tsc strict 与 biome 干净。语句覆盖约 90%(`pnpm coverage`)。
- 版本 0.1.0(`npx github:hirovel/clari` 可装)。CHANGELOG 的 Unreleased 段积累了整个界面改版,发布时应升到 0.2.0。
- **从未用真实供应商 key 跑过长会话**。所有验证都是本机假服务器、虚拟终端与子进程入口。用户有 DeepSeek key,会自己跑;不要向用户要 key。
- LICENSE 文件还没有,等用户定。

## 2 地图

内核 `src/`(不认识终端,不认识 MCP):

| 文件 | 管什么 |
|---|---|
| `events.ts` | 事件类型。凡是模型可见的内容都在事件里;只给人看的事件(request、retry、decision、session/*)不投影 |
| `log.ts` | 追加式日志,落盘 JSONL,半行恢复 |
| `messages.ts` | 唯一的投影 `composeContext(events)`:事件数组 → 模型可见消息序列,带来历与省略;`editState`、`compactionState` |
| `context.ts` | token 估算(chars/4)与占用分桶 |
| `loop.ts` | `runTurn`:请求、执行工具、回喂、槽(termination、steering、approve、execution、compaction、preservation、assemble);事实附注与计划复述 |
| `agent.ts` | 薄类层:留言队列、打断、`setSlot`、`setTools`、`configure` |
| `compaction.ts` | 三种策略与触发三件套 |
| `provider.ts`、`providers/` | 三种协议(OpenAI chat、Responses、Anthropic),共用 SSE 读流与重试 |
| `approval.ts` | 审批规则 |
| `subagent.ts` | task 工具与子日志 |
| `config.ts` | 配置文件形状、模板(`defaults` 由登记表生成)、key 查找 |
| `settings.ts` | 开关登记表:每个可选项的键、分组、类型、可选值、说明、内置缺省、生效范围 |
| `facts.ts`、`plan.ts`、`cost.ts` | 事实附注、plan 工具、费用 |

终端层 `cli/`:

| 文件 | 管什么 |
|---|---|
| `tui.ts` | 入口:配置、真实终端、换会话(`launch`) |
| `tui-app.ts` | 组装:组件树、Agent、ctx、按键、检视器接线 |
| `tui-context.ts` | ctx 的形状(view、req、approval、slots、dialog、inspector) |
| `tui-render.ts`、`cards.ts`、`tui-block.ts`、`tui-steps.ts` | 事件 → 屏幕:直印流、记号列、变化说明、账簿折叠 |
| `tui-commands.ts`、`tui-menu.ts` | 十四个命令与选单;`command()` 在选单一打开就返回 |
| `tui-edit.ts` | 编辑上下文的命令、面板动作、段开关 |
| `tui-settings.ts` | `/settings` 全屏表与落地 |
| `inspector.ts` | Ctrl+R 覆盖层组件:模式、按键、行缓存 |
| `inspector-requests.ts`、`-events.ts`、`-compactions.ts`、`-composition.ts`、`-workbench.ts` | 各视图的行:请求七分区、事件视图、压缩对照、组装行、上下文工作台 |
| `prompt.ts`、`prompt-sections.ts` | 系统提示词分段组装;段的切回与开关 |
| `tools/`、`mcp/` | 内置工具(read、write、edit、bash、grep、glob、fetch、remember、skill)与 MCP 桥接 |
| `bootstrap.ts`、`args.ts`、`registry.ts`、`sessions.ts` | 两入口共用的组装、参数解析、models.dev 登记簿、会话文件 |

测试 `tests/`:按模块命名;`helpers/virtual-terminal.ts` 用 xterm 无头模拟器实现 pi-tui 的终端接口,`helpers/mcp-server.mjs` 是假 MCP 服务器,`e2e.test.ts` 与 `cli.test.ts` 跑本机假 HTTP/SSE 与真实子进程入口。`scripts/visual-suite.ts` 十个场景渲染成 HTML,浏览器里核对样式。

## 3 不变量(改代码前对一遍)

1. 事件数组是唯一状态。屏幕、统计、压缩对照都是投影;出现第二个要与数组同步维护的变量就是错的。
2. `composeContext` 是纯函数:同一日志永远投出同一序列。编辑、丢弃、压缩都是追加事件,原文永远留在数组里。
3. 前缀不变:内核永远不在最新消息之前插入东西,缓存前缀只因用户的编辑、丢弃或压缩而断。事实附注贴在产生它的事件上,计划复述追加在末尾。
4. 中间层可以忠实,不可以聪明:内核的每个决定都是 `decision` 事件,检视器据此证明没有藏聪明。
5. key 不进日志、trace、线路 JSON、配置文件(配置里只有环境变量名)。
6. 模型看到的固定文本是英文;每个可选项在配置里且登记在 `src/settings.ts`。
7. 屏幕规则:安静的流,响的变化。正文只印对话与工具;只有上下文以别的工具看不见的方式变了(编辑、压缩、前缀重算、缓存率掉一半、窗口是假设值)才多一行说明;金色只给变化,朱色只给工具与错误。

## 4 用户与工作方式

- 用户是研究生,目标 2026 秋招 LLM 应用与 Agent 岗;这个项目是修行项目,标准是任何一层都能被拷问到底。
- 用户裁决机制,设计口味问一次方向后由你定并写成规则。每个新增机制单独问,选项文案里不要夹带自己的提案。
- 用户批评过的事:未经裁决就实现(fetch、MCP)、核心变重、命令太多不清晰、界面和别的工具没区别、文档 AI 味、状态栏太琐碎。
- 汇报三段(见 AGENTS.md)。汇报里给数字与示例,不只给结论。
- 用户会自己跑真实 key;安全规则见 AGENTS.md。

## 5 已定的设计(查 docs/architecture.html 对应节)

| 主题 | 节 |
|---|---|
| 视觉专项与真实供应商清单 | 6.1 |
| 界面对照五家的改版、调色板与层次 | 6.2、6.3 |
| 备用屏、账簿、Ctrl+K 等现代终端能力 | 6.4 |
| 模型自配置(models.dev 登记簿) | 6.5 |
| 对话屏显示规则:安静的流,响的变化 | 6.6 |
| 事实附注与计划复述(不做状态栏) | 6.7 |
| 十四个命令与选单 | 6.8 |
| 上下文工作台、事件视图、/settings 登记表 | 6.9 |
| 逐块审核记录(事件、投影、供应商、循环、压缩、子 agent、风格槽) | 11.1 到 11.7 |
| 全部裁决与备选 | 附录 |

## 6 待办(按用户提过的优先级)

1. **发布**:等用户一句话,`bash scripts/publish-public.sh origin main`;发布前把 CHANGELOG 的 Unreleased 升版本。
2. **真实供应商测试(C 层)**:不带 key 的几轮已经用 `pnpm rehearsal` 彩排过(对着假模型真跑 HTTP、工具、压缩、重试,判据全过,画面逐张核对过)。计划与判据在 `docs/architecture.html` 的 6.10 节,八轮,每轮写了怎么跑、看什么、通过判据、不过改哪里。工具是 `pnpm checkup sessions/<文件>.jsonl`:离线只读一份会话文件,把发请求前的预测与供应商的实测摆成一张表,再跑八条判据(最要紧的是 A 前缀不变量)。用户自己带 key 在 `pnpm tui` 里跑,跑完把 checkup 的输出贴回来;脚本不碰 key,输出里也没有 key。
3. **LICENSE**:用户定。
4. **plan 缺省**:现在缺省开;建议缺省关、`long` 预设开。用户未定。
5. **技能**:三档(name、brief、full)与 `/skills probe`;兼容 Claude Code 格式的技能(`references/`、`scripts/`、`/skills install <github>`)。
6. **图片输入**:剪贴板 Ctrl+V 粘贴,需要多模态消息类型进 `Message`,是内核层改动。
7. **hooks 槽与后台任务**:用户提过,未设计。
8. **自写渲染引擎**:原型在分支 `proto/engine-ui`(`pnpm proto`、`pnpm proto:design`),格子引擎已验证(xterm 回放一致,流式帧约 1 ms);用户裁定全部自写含输入与编辑器,但按风险排最后。主干仍用 pi-tui 当渲染引擎。
9. 小项:换会话后扩展模块的 `onEvent` 仍订阅旧日志、MCP 桥接不重连;命令行解析没有从登记表生成(靠测试守);段开关在旧日志上只读(段长度对不上全文);事件视图与工作台的 token 是 chars/4 估算。

## 7 坑

- Windows:文件多是 CRLF,用 node 脚本或 Edit 工具打补丁,bash heredoc 会吃掉 `\x1b`、`\r` 与引号;biome 会重排格式,打补丁后再核锚点。
- `findLast`、`findLastIndex` 不在 tsconfig 的 lib 里,自己写循环。
- 覆盖层有两种:检视器(`ctx.inspector`,整屏)与对话框(`ctx.dialog`,底部,同一时间只有一个)。选单用 `tui-menu.ts` 的 `choose()`,它开的是对话框;检视器里要开选单先关检视器(工作台的 tools 行就是这么做的)。
- `command()` 在选单打开时就返回,测试用 `app.dialogInput` 逐键驱动,不要 await 一个等人的 Promise。
- 检视器的行有缓存(`lineCache`、`wbCache`),键里含事件数;改了行的算法但事件数不变时记得 `invalidate()`。
- `saveConfig` 整文件写回;`/settings` 只改 `defaults` 下那一个键。`session/start.sections.chars` 是修剪后的长度,段开关靠它切回全文。
- 视觉核对:预览服务器 `.claude/launch.json` 的 `tui-preview`(:4174)提供 `.preview/`;本工具环境的浏览器截图常超时,用页面文本核对。
- 长会话性能有守卫(`tests/perf.test.ts`、`perf-tui.test.ts`):投影按事件对象缓存,账簿折叠只换节点;不要在每个按键上重算全文。
