# clari

一个从零手写的通用 agent 内核与终端界面。内核只维护一个只追加的事件数组;模型看到的消息、屏幕上的每一行、上下文统计、压缩对照,全部是这个数组的投影。

> A hand-written coding-agent kernel in TypeScript. The whole state is one append-only event log; everything else is a projection of it. Built for full transparency: every request, every byte sent and received, every decision the kernel makes is inspectable.

## 两条原则

- **端到端**:智能只在两端(模型执行、用户裁决),内核居中只做可靠传输,不藏聪明。默认零干预;终止、审批、插话注入、压缩都是显式的策略槽。
- **完全透明**:凡是模型可见的内容必然已在日志里;凡是内核做过的决定必然有事件。检视器能把任意一次请求还原到逐字节的请求正文,把任意一次压缩还原成"哪一大段原文变成了什么摘要"。

## 现在能做什么

- 读、写、编辑文件,跑命令,grep / glob / ls,派生子 agent
- 三种协议(OpenAI chat completions、OpenAI Responses、Anthropic Messages),配置驱动的模型能力数据,`extraBody` 透传新参数,`/models` 实时发现模型下线,`/fields` 列出当前协议发什么、读什么、不读什么,供应商元数据(响应 id、服务模型、原始停止原因)原样存进 `extras`
- 界面全英文,标签沟版式。每次请求一张 Request 卡:第一行 `changed` 说明相对上一次新增、编辑、摘要了哪几条与代价(多少条重算、缓存上限、丢几个思考块),再列参数、系统段、工具、每条消息(事件号、角色、token、状态、首行,未变的折叠)、离自动压缩多远;一张 Response 卡:停止原因、耗时、费用、实测与预计缓存命中并排,之下是 reply / thinking / call / result / opaque / extras / raw 各一行;思考缺省折成一行并标明全文还是摘要,Ctrl+T 展开
- 编辑上下文:Ctrl+E 打开上下文面板,选中一条按 Enter 出动作菜单(view / edit / compare / restore / drop / rewind / retry / fork),每项一句后果;命令形式 `/edit N [字段] [文本]`、`/drop N`、`/compare N`、`/restore N`、`/rewind N`、`/retry`,追加事件改投影,原文永远留在数组里;全文思考(DeepSeek 一类)可改来引导模型,摘要思考(Claude、GPT)拒绝并指向追加消息;每次改动的后果(哪几条重算、丢几个思考块、缓存预计与实测)在卡片上明示
- 自动 / 手动压缩,三种内置策略(LLM 摘要、清除旧工具结果、两者串联),外部策略模块 `--compaction ./my-strategy.mjs`
- 会话恢复 `--continue`,一次性模式 `pnpm once -- "任务" --json`(策略 A/B 的执行器)
- 请求检视器(Ctrl+R):一行一请求 → 概要 / 决策 / 发送 / 工具定义 / 线路 JSON / 接收(含原始流,缺省记录,`/raw N` 直达)/ 写入;`/tools` 列出随请求发出的工具定义与 token
- 事件视图:内核维护的全部事件逐条查看;压缩对照:原文 ↔ 摘要,带 token 与压缩比;组装视图(Ctrl+E):模型下一步看到的每条消息从哪个事件来、经过了哪些阶段(摘要 / 清除 / 编辑 / 丢弃)、落在线路正文的第几条;组装槽 `slots.assemble` 可换投影,差异照样记进请求事件
- 子 agent 视图:嵌套引导线、一行进度加尾窗、检视器一键切到子会话
- 系统提示词按段组装(角色 / 环境 / 项目指令 / 记忆 / 追加),`--prompt-sections` 选段与顺序,`--instructions-as` 决定放 system 还是首条 user 消息,`/prompt` 看各段占比;`--preset 名` 一键套用配置里的参数组合
- 跨会话记忆可选、默认关:`--memory` 打开后模型只能通过 `remember` 工具往 AGENTS.md 的记忆节写一行,屏幕可见、可审批;`/memory` 看删
- 四个策略槽:终止、插话、审批、执行(`--execution parallel` 让相邻只读调用同时跑,缺省逐个;并行批记一条决策事件)
- 留言两种投递:Enter 步边界插话,Alt+Enter 等模型做完再给;`@路径` 把文件附进消息;`/fork` 复制事件前缀成新会话
- 提示词模板 `~/.clari/prompts/*.md` → `/名 参数`;技能 `SKILL.md`(`~/.clari/skills`、`~/.claude/skills`、`.agents/skills`、`.claude/skills`):清单进系统提示词或只许用户 `/名 参数` 触发,正文作为一条 user 消息;`allowed-tools` 本 turn 免审批;`/skills` 列出;配置 `prompt.skills.list` / `load` 两个旋钮;扩展模块 `--extension ./x.mjs` 加工具、换槽、订阅事件
- 会话中切策略槽:`/slots` 看当前,`/compaction` `/preservation` `/execution` `/steering` `/approve` 切换,每次切换记事件;请求失败时四行错误卡:分类、供应商原话、下一步、原始响应体在哪
- 费用与缓存:配置里给价格就显示每步与累计费用;Anthropic 缺省挂提示缓存断点;每步显示缓存命中率
- 生产级边界:流停滞超时与重试、bash 超时与输出上限、大文件与二进制守卫、CRLF 与宽松匹配的编辑、崩溃时还原终端并指出会话文件

## 快速开始

```bash
pnpm install
pnpm tui
```

首次运行会生成 `~/.clari/config.json`(环境变量 `CLARI_CONFIG` 可改路径)。`pnpm tui -- --help` 列出全部选项。

### 没有 key 先看效果

```bash
pnpm demo          # 起本机假模型,一次性模式跑一个任务,stdout 是每条事件的 JSON
pnpm demo tui      # 同一个假模型,打开界面;Ctrl+R 看检视器
```

假模型不联网、不要 key,但内核、工具、落盘、界面、检视器都是真的。

### 提供 key

三种方式,任选其一,优先级从高到低:

1. 配置文件里该供应商的 `apiKey` 字段(界面里 `/key deepseek sk-xxx` 会写到这里)。
2. `apiKeyEnv` 指向的环境变量,模板里是 `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`。PowerShell 里 `$env:DEEPSEEK_API_KEY = "sk-xxx"` 只对当前窗口有效;要长期生效用 `setx DEEPSEEK_API_KEY sk-xxx` 再开新窗口。
3. 换一套配置:`CLARI_CONFIG=路径` 指向另一个 config.json。

key 从不进日志、不进请求正文、不进检视器;线路 JSON 分区看到的是不含鉴权头的正文。

### 接中转站

中转站就是一个"协议相同、地址不同"的供应商,在 `providers` 里加一条即可,见 `examples/config.relay.json`:

- OpenAI 兼容型(最常见,`/v1/chat/completions`):`protocol: "openai"`,`baseUrl` 填到 `/v1` 为止,`models` 列出你要用的模型名(中转站的名字,不是官方的)。
- Anthropic 协议型(`/v1/messages`):`protocol: "anthropic"`,`baseUrl` 填域名;中转站不认缓存断点时加 `"promptCache": false`。
- 中转站的 key 用 `apiKeyEnv` 指向自己的环境变量,或界面里 `/key 供应商名 密钥`。
- 启动后先 `/models`:它会向中转站查当前可用模型,对照你配置里写的,标出不存在的。
- 中转站要求的额外参数或头,用 `extraBody` / `extraHeaders` 逐字透传,不必等代码改。
- 有些中转站流式响应会长时间没字节,`stallTimeoutMs` 调大或设 0。

用法:`pnpm tui -- --model relay/claude-sonnet-5`,或把 `default` 改成它。

常用:

```bash
pnpm tui -- --model anthropic/claude-sonnet-5 --effort high
pnpm tui -- --continue
pnpm once -- "把 src 下的 TODO 归类" --json
pnpm replay sessions/<文件>.jsonl --request 3
pnpm replay sessions/<文件>.jsonl --compaction 1 --json
```

界面内:`Esc` 打断 · `Ctrl+R` 检视器(Tab 轮换 请求 / 事件 / 压缩 / 上下文,`s` 切会话)· `Ctrl+E` 上下文面板 · `Ctrl+O` 折叠 · `Ctrl+T` 思考 · `?` 快捷键 · `/help`

## 结构

```
src/        内核:事件、日志、投影、provider、循环与策略槽、压缩、子 agent、配置
cli/        终端:入口、界面、检视器、系统提示词组装、工具(文件 / bash / 搜索)
tests/      离线可验证:虚拟终端跑完整渲染管线,本机假服务器跑完整 HTTP/SSE 链路
scripts/    观感预览生成
```

可换点都是普通函数类型:压缩策略、保留策略、终止、插话注入、审批、子 agent 上下文范围、provider、工具。写一个新实现、在入口注入、用一次性模式跑同一任务、比较两份会话文件。

## 开发

```bash
pnpm check   # tsc + biome + vitest
```

TypeScript strict,零运行时依赖(界面用 pi-tui 做渲染引擎,校验用 TypeBox)。

## 状态

内核与界面已建成,离线测试覆盖完整链路;真实 API 联调进行中。路线见提交记录。
