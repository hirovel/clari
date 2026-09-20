# clari

一个从零手写的通用 agent 内核与终端界面。内核维护一个只追加的事件数组;模型消息、对话历史、上下文统计和压缩对照从这个数组投影。草稿、焦点和运行中的连接各有生命周期。

> A hand-written coding-agent kernel in TypeScript. The kernel keeps an append-only event log. Request inspection distinguishes captured bodies, reconstructed messages and missing evidence.

English: [README.md](README.md).

## 两条原则

- **端到端**:智能只在两端(模型执行、用户裁决),内核居中只做可靠传输,不藏聪明。默认零干预;终止、审批、插话注入、压缩都是显式的策略槽。
- **完全透明**:检视器从已记录事件重建每次请求的输入消息,把压缩呈现为"哪一大段原文变成了什么摘要"。HTTP 正文实录、重建预览与证据缺失分别标明;仅靠消息不能总是还原历史工具定义与供应商参数。

## 现在能做什么

- 工具描述三套风格可选(guided / terse / strict),`--tool-prompts` 或 `/set toolprompts` 切换,逐工具在编辑器里改并写回配置;模型只看到描述文本
- 读、写、编辑文件,跑命令,grep / glob,fetch(抓网页转文本,私网拒绝、字节与超时上限、跨主机重定向交回模型),派生子 agent
- MCP 客户端(零依赖手写,stdio 与 Streamable HTTP,2026-07-28 无状态协议与旧版握手都认):配置 `mcp.servers` 或项目根 `.mcp.json`,工具名 `mcp__server__tool`,审批规则 `mcp:server:tool`,每次 JSON-RPC 往返都是 `ext/event` 事件,`/mcp` 看状态;内核里没有 MCP 专有代码,不用就删掉 `cli/mcp/`
- 三种协议(OpenAI chat completions、OpenAI Responses、Anthropic Messages),配置驱动的模型能力数据,`extraBody` 透传新参数,`/models` 实时发现模型下线,`/fields` 列出当前协议发什么、读什么、不读什么,供应商元数据(响应 id、服务模型、原始停止原因)原样存进 `extras`
- 界面全英文,标签沟版式。每次请求一张 Request 卡:第一行 `changed` 说明相对上一次新增、编辑、摘要了哪几条与代价(多少条重算、缓存上限、丢几个思考块),再列参数、系统段、工具、每条消息(事件号、角色、token、状态、首行,未变的折叠)、离自动压缩多远;一张 Response 卡:停止原因、耗时、费用、实测与预计缓存命中并排,之下是 reply / thinking / call / result / opaque / extras / raw 各一行;思考缺省折成一行并标明全文还是摘要,Ctrl+T 展开
- 上下文工作台:Ctrl+E 一屏就是下一次请求的正文,按发送顺序:系统提示词、工具定义、每条消息(token 与占比尺)、摘要与折在它下面的被覆盖消息、淡显在原位的被丢弃消息,以及上次请求缓存到哪一条的一条线(编辑之后上移变金);底部预览选中行。消息上 Enter 出编号动作单(view / edit / compare / restore / drop / rewind / retry / fork),每项一句后果;system 行 Enter 列段并翻(记成对 #0 的编辑);tools 行 Enter 开 `/tools`;摘要行 Enter 开压缩对照。命令形式 `/edit N [字段] [文本]`、`/drop N`、`/compare N`、`/restore N`、`/rewind N`、`/retry`,追加事件改投影,原文永远留在数组里;全文思考(DeepSeek 一类)可改来引导模型,摘要思考(Claude、GPT)拒绝并指向追加消息;每次改动的后果(哪几条重算、丢几个思考块、缓存预计与实测)在卡片上明示
- 自动 / 手动压缩,三种内置策略(LLM 摘要、清除旧工具结果、两者串联),外部策略模块 `--compaction ./my-strategy.mjs`
- 会话:`--continue`、`--resume 文件`、`/session`(新建、分叉、恢复);`clari sessions` 列出会话,`clari sessions prune --older-than 30d` 或 `--keep N` 连同正文、输入、旧 trace 与 MCP 旁车一起删,加 `--yes` 才真删;一次性模式 `clari once "任务" --json`(策略 A/B 的执行器)
- 请求检视器(Ctrl+R):选择请求后按 Enter。概要串起输入、未变消息前缀、回复、工具结果与下一次请求。`1`–`7` 分别看概要、决策、输入消息、工具、HTTP JSON、回复与已记录事件;`[` / `]` 切请求,`↑↓` 选择内容块,`Enter` 仅展开当前块,`PgUp/PgDn` 阅读长正文。`/inspect raw`、`/inspect tools` 直达对应分区。没有历史实录时,工具明确标为可能与历史不同的当前定义。 检视器明确显示当前焦点和 `Ctrl+R returns to draft`。普通字符(包括 `f`、`?`)在编辑器中只输入文字;检视器打开时,导航键只交给当前视图,关闭后恢复原焦点和草稿。快捷键说明从 Ctrl+K 面板的 Keyboard shortcuts 进入。
- 事件视图:每种事件一句人读的话,右列写模型现在看不看得到它(sent / kernel / covered / cleared / dropped / edited),request 是章节,1–5 筛选,Enter 进排版页、JSON 页与"后来怎么了"页;压缩对照:原文 ↔ 摘要,带 token 与压缩比;组装视图(Ctrl+E):模型下一步看到的每条消息从哪个事件来、经过了哪些阶段(摘要 / 清除 / 编辑 / 丢弃)、落在线路正文的第几条;组装槽 `slots.assemble` 可换投影,差异照样记进请求事件
- 子 agent 视图:嵌套引导线、一行进度加尾窗、检视器一键切到子会话
- 系统提示词按段组装(角色 / 环境 / 项目指令 / 记忆 / 追加),`--prompt-sections` 选段与顺序,`--instructions-as` 决定放 system 还是首条 user 消息,`/prompt` 看各段占比;`--preset 名` 一键套用配置里的参数组合
- 跨会话记忆可选、默认关:`--memory` 打开后模型只能通过 `remember` 工具往 AGENTS.md 的记忆节写一行,屏幕可见、可审批;`/memory` 看删
- 四个策略槽:终止、插话、审批、执行(`--execution parallel` 让相邻只读调用同时跑,缺省逐个;并行批记一条决策事件)
- 留言两种投递:Enter 步边界插话,Alt+Enter 等模型做完再给;`@路径` 把文件附进消息;`/fork` 复制事件前缀成新会话
- 提示词模板 `~/.clari/prompts/*.md` → `/名 参数`;技能 `SKILL.md`(`~/.clari/skills`、`~/.claude/skills`、`.agents/skills`、`.claude/skills`):清单进系统提示词或只许用户 `/名 参数` 触发,正文作为一条 user 消息;`allowed-tools` 本 turn 免审批;`/skills` 列出;配置 `prompt.skills.list` / `load` 两个旋钮;扩展模块 `--extension ./x.mjs` 加工具、换槽、订阅事件
- 会话中切策略槽:`/set` 先选槽再选值,行上写着当前值,`/inspect slots` 看全部,每次切换记事件;请求失败时四行错误卡:分类、供应商原话、下一步、原始响应体在哪
- 费用与缓存:配置里给价格就显示每步与累计费用;Anthropic 缺省挂提示缓存断点;每步显示缓存命中率
- 生产级边界:流停滞超时与重试、bash 超时与输出上限、大文件与二进制守卫、CRLF 与宽松匹配的编辑、崩溃时还原终端并指出会话文件

写入文件的会话默认完整记录:适配器输入的消息与工具定义、内置协议每次 HTTP 尝试的请求 JSON 与实际收到的完整正文、转换或截断前的工具输出及给模型的结果。追加式 `<会话>.jsonl` 引用 `<会话>.records/` 内的正文;TUI、一次性入口、压缩与子任务共用这条保存链路。检视器默认折叠大段原文,选中内容块后按 `Enter` 展开。分叉复制引用的正文,清理会话时一同删除。

事件入库时保存独立的 JSON 快照;草稿与队列的图片对象在交接时复制,调用方和读取者不能悄悄修改待发送附件。编辑上下文通过追加事件改变投影,不改写已记录的历史。文件分隔、尾部恢复和有序重试统一由记录模块负责,恢复保留有效历史字节,只读查看不修复文件。

翻页时,选中块的标题与展开状态始终显示在固定头部。输入原文读不到时,输入页显示记录错误,并明确标注后备内容是从事件重建的。

API/工具派发前及结果完成后尝试刷盘,流式内容约每秒刷盘。保存失败不阻断工作,待写记录留在内存;磁盘恢复后自动补写,`Ctrl+S` 可立即重试,不会重做 API 或工具操作。每会话的待写原始正文缓冲为 64 MiB:耗尽后明确记录永久缺口,停止捕获该正文余下内容;恢复后新正文继续记录。事件历史仍留在内存,这不是进程总内存上限。未结束流、缺失文件、字节数不符均明确显示。正常退出报告未保存记录并提供重试或强退;强退、断电可能丢失未保存数据。写盘仍是同步实现,本次消除的是保存失败后的等待,不是所有磁盘延迟。捕获不证明远端收到或执行成功。文本视图按 UTF-8 解码,文件保留收到的字节。自定义供应商用 `options.record` 接入 HTTP 记录,自定义工具用 `ctx.output.write` 提供原始输出,否则明确标为返回文本。

检视器在展开时读取原始响应和工具正文,复用未变化的内容与排版。内部录制事件留在检视器,主对话只显示运行结果和保存失败、记录缺口提示。

恢复会话会保留已完整写入但缺少结尾换行的 JSON 事件,继续追加前通过保存队列补齐分隔符;真正不完整的尾行明确记录恢复,中间损坏仍报错。只读查看不会改写会话文件。

**图片输入**:`Alt+V` 读取剪贴板图片,终端转发 `Ctrl+V` 时也可使用。Windows 使用系统剪贴板;Linux 需要 `wl-paste` 或 `xclip`。各平台也可粘贴单个 PNG/JPEG/GIF/WebP 文件路径,支持引号,文件读取上限为 48 MiB。图片先进入草稿,`Alt+I` 查看或删除,Enter 才发送。开启输入保存时,草稿和队列图片一起保存;发送后保留在会话历史。Chat Completions、Responses、Anthropic Messages 均发送真实图片内容,不做 OCR 或缩放。模型须支持视觉。消息估算单列文本 token,不猜图片费用。macOS 暂支持路径附图,尚无原生剪贴板图片读取。

不记录鉴权头,但请求与工具内容会保存在本地,其中可能含项目秘密。模型未返回的私有推理不可见。旧的 `--trace`、`--no-trace`、`defaults.trace` 与预设内的 `trace` 已移除,已有配置需要删除这些项。旧 trace 读取器和重复的内存原始流缓存已删除,只支持会话记录格式。

## 快速开始

直接运行(Node 20+):

```bash
npx github:hirovel/clari
```

或从源码:

```bash
pnpm install
pnpm tui
```

首次运行会生成 `~/.clari/config.json`(环境变量 `CLARI_CONFIG` 可改路径)。`clari --help`(源码里是 `pnpm tui -- --help`)列出全部选项。`clari once "任务"` 一次性模式,`clari replay 文件` 回放。

缺省审批与 pi 一致:`all`,不弹确认。要审批就 `--approve policy`(只读工具放行、其余问、工作目录之外必问,规则如 `/set approve allow bash:git *` 可在会话里加或写进配置的 `approval` 字段)或 `--approve ask`(每个调用都问)。

### 所有可选项都在配置里

每个命令行选项在 `~/.clari/config.json` 里都有对应项。模板把每个旋钮的内置缺省值列在 `defaults` 下:

```json
"defaults": {
  "compaction": "llm",
  "approve": "all",
  "execution": "sequential",
  "steering": "step",
  "toolPrompts": "guided",
  "subagent": false,
  "fold": false,
  "prompt": { "sections": ["role", "env", "instructions", "memory", "skills", "append"], "instructionsAs": "system", "memory": false, "skills": { "list": "system", "load": "read" } }
}
```

`presets.<名>` 用同一组键做命名参数集,`--preset 名` 套用。解析顺序:命令行 > 预设 > `defaults` > 内置缺省。结构更大的项各有专门的块:`approval`(规则)、`toolPrompts`(风格与逐工具描述)、`fetch`、`mcp`、`sessionsDir`。

### 没有 key 先看效果

```bash
pnpm demo          # 起本机假模型,一次性模式跑一个任务,stdout 是每条事件的 JSON
pnpm demo tui      # 同一个假模型,打开界面;Ctrl+R 看检视器
```

假模型不联网、不要 key,但内核、工具、落盘、界面、检视器都是真的。

### 提供 key

三种方式,任选其一,优先级从高到低:

1. 配置文件里该供应商的 `apiKey` 字段(界面里 `/login` 对话框会写到凭据文件)。
2. `apiKeyEnv` 指向的环境变量,模板里是 `DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`。PowerShell 里 `$env:DEEPSEEK_API_KEY = "sk-xxx"` 只对当前窗口有效;要长期生效用 `setx DEEPSEEK_API_KEY sk-xxx` 再开新窗口。
3. 换一套配置:`CLARI_CONFIG=路径` 指向另一个 config.json。

key 从不进日志、不进请求正文、不进检视器;线路 JSON 分区看到的是不含鉴权头的正文。

### 接中转站

中转站就是一个"协议相同、地址不同"的供应商,在 `providers` 里加一条即可,见 `examples/config.relay.json`:

- OpenAI 兼容型(最常见,`/v1/chat/completions`):`protocol: "openai"`,`baseUrl` 填到 `/v1` 为止,`models` 列出你要用的模型名(中转站的名字,不是官方的)。
- Anthropic 协议型(`/v1/messages`):`protocol: "anthropic"`,`baseUrl` 填域名;中转站不认缓存断点时加 `"promptCache": false`。
- 中转站的 key 用 `apiKeyEnv` 指向自己的环境变量,或界面里 `/login` 对话框贴进去。
- 启动后先 `/model` 选最后一行:它会向中转站查当前可用模型,对照你配置里写的,标出不存在的。
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

界面内:`Esc` 关闭当前窗口;浏览历史时回到实时末尾,再按才中断运行 · `Ctrl+R` 检视器(Tab 轮换 请求 / 事件 / 压缩 / 上下文,`s` 切会话)· `Ctrl+E` 上下文工作台 · `/settings` Agent 组装工作台 · `Ctrl+O` 折叠 · `Ctrl+T` 思考 · `Ctrl+K` → Keyboard shortcuts浮层 · `/help`

运行区固定显示两行:当前活动与上下文用量。等待模型、接收回复、工具待完成、等待审批、重试、错误分别呈现;输入区提示随焦点与插话策略变化。长会话路径不挤占正文,窄屏优先保留操作和状态。审批中的完整参数与改动可用 PgUp/PgDn 查看,选择按钮保持可见。Enter 按已配置的插话边界投递;Alt+Enter 等本轮结束后投递。

### Agent 组装工作台

`/settings` 按模型、指令与记忆、工具与委派、上下文管理、执行与控制、显示与通知、记录七个部分组织。每项说明作用、推荐起点与生效时机。推荐值是一套可替换的开箱配置,不声称对所有模型效果最优。

缺省进入 **This session**:只改本次会话。`Tab` 切到 **Saved defaults**:保存为后续启动的默认值,本次会话不变。需要重启的设置会明确说明。显式命令行参数和 `--preset` 仍优先于默认值。打字形态 `/settings key value` 保留应用并保存的行为,`/set` 仍是会话策略的快捷入口。

方向键移动,Enter 进入或应用;`/` 搜索全部设置,`I` 阅读完整说明,`R` 预览恢复推荐值,数字或文本选单中的 `E` 原地输入自定义值。工具列表直接显示 Enabled/Disabled。长列表可滚动,窄终端把说明放在选项下方。模型可以在工作台选择,密钥仍只从 `/login` 输入。

**Save as preset** 将登记的设置与模型名存成新方案。**Load preset** 先显示变化,确认后用该方案叠加内置默认值替换已登记的 defaults,保留其余配置。重启后使用,也可通过 `clari --preset 名称` 启动。快照保留“自动”和“无限制”,不会继承后来修改的默认值:model、effort、preservation、maxSteps 的 `null` 表示明确重置,省略字段则继承。方案不打包凭据、供应商连接、外部扩展代码和未登记的策略细节;已有方案名不会被覆盖。保存失败保留编辑状态并给出错误。

“计划多步未更新后自动提醒”缺省关闭(`planReminder: 0`),已有配置中明确写出的值继续生效。压缩后恢复未完成计划的行为独立保留。

## 交接

`pnpm checkup sessions/<文件>.jsonl` 离线对比请求估算与实测用量。九条判据覆盖重建消息的前缀与条数、估算漂移、缓存用量一致性、压缩估算、失败恢复、工具错误率、思考元数据和原始流覆盖。启发式判断明确标注,证据不足则跳过;首次估算不与后续基于用量的估算混比。消息前缀估算不是缓存上限,收到思考也不能证明实际线路回传。输出不含 key。

`AGENTS.md` 是改这个仓库的人与 agent 都要守的规则;`HANDOVER.md` 是现状、模块地图、不变量、待办与坑。

## 结构

TUI 的 `/session` 打开会话操作。Enter 使用默认来源,`d` 明确选择另一套组合:新建沿用当前组合,恢复使用目标会话最后的组合,分叉使用选定事件前缀末尾的组合。三者都沿用当前显示偏好。旧配置缺失时先展示补全来源供确认和调整;准备失败保留原会话与草稿,提供重试、调整和只读历史。默认恢复保留历史系统提示词;主动选择当前组合或已保存默认值时重新生成,以编辑事件记入日志。既有用户消息仍保留在历史中,配置为用户消息的指令会明确追加。

草稿与待发送消息默认按会话保存在本地 `<session>.inputs.json`。草稿停止输入 200 ms 后保存,队列变化、正常切换和退出立即刷新;突然终止进程可能丢失这段尚未保存的输入。恢复会话不会自动发送待发送消息。Esc 中断后暂停未投递消息,普通新问题不会夹带它们。`/session inputs` 打开列表:Enter 多行编辑、`d` 移除、`c` 继续全部、`s` 重试保存。恢复时按消息 ID 排除已写入事件日志的输入;这不代表供应商已收到,也不代表重放外部工具。`/settings saveInputs off` 或 `--no-save-inputs` 关闭保存并删除该会话的旧快照,当前进程内仍保留输入。空快照自动删除,会话清理也包含输入快照。保存失败会明确显示,切换或退出不会丢弃当前工作。

恢复会话时,缺少结果记录的工具调用会标为结果未知。`/session recovery` 展示原调用、参数及记录的原因。打开会话或详情不会重跑工具或请求模型;下一次交互会提示 agent 先核实实际状态,再按原有权限决定如何继续。未知表示日志无法证实执行情况和副作用,恢复说明与实际工具结果分别记录,可在上下文检视器查看来源。

MCP 调用发出后超时、取消或连接中断,同样记录为结果未知。agent 收到原因后可以在当前轮继续核实;Esc 停止当前轮,等待你再次交互。框架不自动重试工具,不增加审批关卡。发送前已取消的请求不会发出,服务器明确返回的错误仍为错误。结束本地 HTTP 等待不能证明远端已停止。已结束请求的迟到应答会丢弃,目前不收集后台结果;旧日志也不按错误文字猜测并重新分类。

`/quit` 或 Ctrl+C 请求取消,并显示退出界面,默认等待当前轮结束和资源释放。尚无结果的调用与参数保持可见。重复 Ctrl+C 继续等待,按 `f` 明确强制退出。强退前刷新已启用的输入保存,记录退出请求和缺失结果;保存失败保留错误和重试入口。关闭输入保存时仍不持久化未发送草稿。扩展清理卡住或失败也保留退出界面,失败显示底层原因。强退结束 clari,外部进程或远端任务可能继续,尚未记录的输出可能丢失。不设置自动强退倒计时。

未捕获异常或未处理的 Promise 拒绝会进入同一退出界面,停止接收新任务。原始异常与保存、清理错误分别显示。输入保存失败时,`r` 重试保存并继续收尾,`f` 尝试保存后强退;正常收尾和手动强退都返回错误码 70。退出流程本身失效或再次出现未捕获异常时,尽力保存输入、恢复终端,报告原始及后续异常和保存错误,然后以 70 退出;这不证明外部工作已停止。普通模型请求失败或工具报错不触发致命退出。

恢复父会话后,新子 agent 会跳过已经存在子日志的编号。显式续聊旧子任务时,将缺失工具结果记为未知并交给下一次模型请求,不自动重跑原调用。当前 task 工具等待子任务结束才返回,取消沿父调用传递,尚不是后台任务句柄。

子任务每次派发或续聊取父会话当前启用的工具和模型,再应用所选子类型的配置,运行期间保持固定。内置工具和扩展工厂为子任务独立创建;MCP 调用与产物绑定子日志和目录,健康连接复用。运行结束或失败后释放资源。每次运行的 bash 从项目目录开始,续聊保留历史。嵌套任务沿用直接父任务的工具子集。

配置未变且健康的 MCP 连接默认复用,每个会话单独绑定工具、日志和产物目录。通过 `defaults.mcpReconnect`、`--mcp-reconnect server1,server2` 或组装工作台指定重连的服务器;`/inspect mcp` 展示连接方式。扩展按会话加载,可返回异步 `dispose()` 释放资源,事件订阅自动退订。扩展若共享外部资源,需自己明确管理归属;工厂在返回前抛错时需清理尚未交出的资源。

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

测试保持精简:优先扩充已有行为场景,每个用例必须保护独立风险,跨层覆盖只用于真实接线、持久化或终端行为。拒绝复刻实现及锁死文案、颜色、间距的测试;视觉检查复用预览脚本。开发中跑受影响用例,收尾跑一次完整检查。用例数和覆盖率百分比不是交付目标。

TypeScript strict,零运行时依赖(界面用 pi-tui 做渲染引擎,校验用 TypeBox)。

## 状态

内核与界面已建成,离线测试覆盖完整链路;真实 API 联调进行中。变更记录见 [CHANGELOG.md](CHANGELOG.md)。
