# clari · 给在这个仓库里工作的 agent

clari 是一个从零手写的 coding-agent 内核与终端界面(TypeScript)。内核只维护一个追加式事件数组;模型看到的消息、屏幕上的每一行、上下文统计与压缩对照都是这个数组的投影。交接细节在 [HANDOVER.md](HANDOVER.md),设计裁决在 `docs/architecture.html`(内部文档,不推送)。

## 命令

```bash
pnpm check                      # tsc + biome + vitest,提交前必须全绿
pnpm test                       # 只跑测试
pnpm tui                        # 交互界面(需要 key;没有 key 会弹登录对话框)
pnpm demo tui                   # 本机假模型跑界面,不需要 key
FORCE_COLOR=1 pnpm exec tsx scripts/visual-suite.ts   # 十个场景渲染成 .preview/visual/*.html
pnpm checkup sessions/<文件>.jsonl                    # 跑完一次真实会话之后的对照:预测 vs 实测,八条判据
pnpm replay sessions/<文件>.jsonl                     # 按请求组织地打印一份会话
```

测试跑 grep 相关用例需要 ripgrep 在 PATH 里:`export PATH="$PWD/node_modules/@vscode/ripgrep/bin:$PATH"`。本工具环境的 `NO_COLOR=1` 会关掉颜色,生成预览时加 `FORCE_COLOR=1`。

## 规则

- 界面文案、模型看到的固定文本一律英文;给用户的解释与代码注释用中文。
- 技术细节写原因,不写来源;代码、提示词、文案里永远不出现"某家怎么做"或论文编号。证据链只存在于 `docs/architecture.html` 的裁决表。
- 每个可选项都进配置,并且登记在 `src/settings.ts`:配置模板的 `defaults`、`/settings` 屏、Ctrl+K 条目都从这张表生成;`tests/settings.test.ts` 逐项核对命令行解析认得每个键。
- 真正可权衡的才做成槽或选项;有明确更优解就直接采用。加一个新机制先问用户,用户选了一个选项不等于批准了塞在里面的细节。
- 不做兼容层、不做别名:旧名启动报错,文档改掉。
- 提交信息不写署名与生成工具。发布只走 `bash scripts/publish-public.sh origin main`(把 master 剔除 `docs/` 后推到公开分支),不直接 push。
- 文档只有三处:`README.md` 与 `README.zh-CN.md`(用户能看到的能力)、`CHANGELOG.md`(Unreleased 段)、`docs/architecture.html`(每轮一节:问题、做法、理由、备选与代价、验证;附录只追加行)。
- 文风:短句直给。禁反问、禁破折号尾注、禁教练腔、禁比喻当解释。设计点按"做法、理由、备选与代价"三段写。

## 安全

- 永远不读、不打印、不粘贴 API key:不 cat `~/.clari/config.json` 或 `~/.clari/credentials.json`,测试输出里出现 `sk-…` 一律遮掉。key 只经过 TUI 的 `/login` 对话框一个入口。
- 测试进程由 `tests/helpers/setup.ts` 把用户目录指到临时目录;涉及凭据的测试必须设 `CLARI_CREDENTIALS` 指向不存在的文件。
- 日志、trace、检视器的线路 JSON 按设计不含 key;改供应商层时保持这一点。

## 汇报

每轮开发的汇报三段:①加入了什么(文件、函数、测试清单);②代码设计(结构与决策);③真实实现与功能(具体行为、数字、示例)。设计口味类的问题问一次方向,值自己定并写成规则;机制类改动用选择题问用户。
