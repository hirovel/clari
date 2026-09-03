# agent-kernel

一个从零手写的通用 agent 内核与终端界面。内核只维护一个只追加的事件数组;模型看到的消息、屏幕上的每一行、上下文统计、压缩对照,全部是这个数组的投影。

> A hand-written coding-agent kernel in TypeScript. The whole state is one append-only event log; everything else is a projection of it. Built for full transparency: every request, every byte sent and received, every decision the kernel makes is inspectable.

## 两条原则

- **端到端**:智能只在两端(模型执行、用户裁决),内核居中只做可靠传输,不藏聪明。默认零干预;终止、审批、插话注入、压缩都是显式的策略槽。
- **完全透明**:凡是模型可见的内容必然已在日志里;凡是内核做过的决定必然有事件。检视器能把任意一次请求还原到逐字节的请求正文,把任意一次压缩还原成"哪一大段原文变成了什么摘要"。

## 现在能做什么

- 读、写、编辑文件,跑命令,grep / glob / ls,派生子 agent
- 两种协议(OpenAI 兼容、Anthropic Messages),配置驱动的模型能力数据,`extraBody` 透传新参数,`/models` 实时发现模型下线
- 自动 / 手动压缩,三种内置策略(LLM 摘要、清除旧工具结果、两者串联),外部策略模块 `--compaction ./my-strategy.mjs`
- 会话恢复 `--continue`,一次性模式 `pnpm once -- "任务" --json`(策略 A/B 的执行器)
- 请求检视器(Ctrl+R):一行一请求 → 概要 / 决策 / 发送 / 工具定义 / 线路 JSON / 接收 / 写入
- 事件视图:内核维护的全部事件逐条查看;压缩对照:原文 ↔ 摘要,带 token 与压缩比
- 子 agent 视图:嵌套引导线、一行进度加尾窗、检视器一键切到子会话

## 快速开始

```bash
pnpm install
pnpm tui
```

首次运行会生成 `~/.agent-kernel/config.json`(环境变量 `KERNEL_CONFIG` 可改路径)。填入任一供应商的 API key(推荐环境变量 `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`),或在界面里 `/key 供应商 密钥`。`pnpm tui -- --help` 列出全部选项。

常用:

```bash
pnpm tui -- --model anthropic/claude-sonnet-5 --effort high --trace
pnpm tui -- --continue
pnpm once -- "把 src 下的 TODO 归类" --json
pnpm replay sessions/<文件>.jsonl --request 3
pnpm replay sessions/<文件>.jsonl --compaction 1 --json
```

界面内:`Esc` 打断 · `Ctrl+R` 检视器(Tab 轮换 请求 / 事件 / 压缩 三视图,`s` 切会话)· `Ctrl+O` 折叠 · `Ctrl+T` 思考 · `/help`

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
