# 机制对照表

每条机制一行：代码位置 → 验收方式。
"验收"一栏里 `test:` 指自动化用例，`demo:` 指 `dora demo` 的输出行。

| # | 机制 | 代码 | 验收 |
|---|---|---|---|
| 1 | 两类 Agent 与角色段 | `packages/core/src/prompt.ts` `ROLE_MAIN`/`ROLE_TASK` | test: `prompt-skills`；demo: 无（由 #2 覆盖） |
| 2 | 能力矩阵四档 | `packages/core/src/permissions.ts` | test: `permissions`（矩阵 + 运行时拒绝） |
| 3 | 只有 bash 与 hold | `packages/runtime/src/agent.ts` `BASE_TOOLS` | test: `agent-loop`；demo: [11] |
| 4 | bash 45 秒限时 | `packages/sandbox/src/adapter.ts` | test: `agent-loop`（超时 → interrupt_cause=timeout） |
| 5 | `$` 金额与多行引号过滤 | `packages/sandbox/src/filters.ts` | test: `sandbox` |
| 6 | 输出超预算落盘 + 预览 | `packages/sandbox/src/bash.ts` | test: `sandbox` |
| 7 | Help gate（退出码 3 + 附件） | `packages/tools/src/{gate,execute}.ts` | test: `help-gate`；demo: [2] |
| 8 | help 批量上限 | `packages/tools/src/execute.ts` | test: `help-gate`（not attached (too many pages)） |
| 9 | 重定向丢附件 | `packages/sandbox/src/bash.ts` | test: `help-gate` |
| 10 | wake_schedule 三种定时 + threshold | `packages/runtime/src/cron.ts` | test: `wakes`；demo: [5] |
| 11 | trigger 条件触发（不满足则跳过） | `packages/runtime/src/wakes.ts` | test: `wakes` |
| 12 | 事件订阅五源 + 去重 | `packages/runtime/src/wakes.ts` | test: `wakes`；demo: [5] |
| 13 | 订阅安全自查（绕过 trigger） | `packages/runtime/src/wakes.ts` `tick()` | test: `wakes` |
| 14 | 8 节 compaction | `packages/core/src/compaction.ts` | test: `agent-loop`；demo: [10] |
| 15 | 第 6 节数据分级 | `packages/core/src/compaction.ts` `NEVER_SHARED_BUILD_ARTIFACTS` | test: `agent-loop` |
| 16 | memory_recall 注入 | `packages/core/src/recall.ts` | test: `agent-loop`；demo: [11] |
| 17 | 27 节 system prompt | `packages/core/src/prompt.ts` `PROMPT_SECTIONS` | test: `prompt-skills` |
| 18 | 三级标题（Workspace/Wakes/Tools CLI） | 同上 | test: `prompt-skills` |
| 19 | 四个独立规则块 | `STANDALONE_BLOCKS` | test: `prompt-skills`（渲染进 prompt） |
| 20 | 三层 skill 系统 | `packages/skills/src/library.ts` | test: `prompt-skills` |
| 21 | skill 角色限定 | `primary-agent-roles` 解析 | test: `prompt-skills` |
| 22 | `{{flag:...}}` 编译期替换 | `packages/core/src/flags.ts` | test: `prompt-skills` |
| 23 | 子任务开场包（recall + 任务 + ~15 页） | `packages/runtime/src/delegation.ts` | test: `delegation`；demo: [4] |
| 24 | 预注入即视为已读 | `HelpGate.markRead` 于 delegate | test: `delegation` |
| 25 | 附件 5 文件 / 20 MB，须 `--start now` | `packages/tools/src/families/tasks.ts` | test: `delegation` |
| 26 | 回执不含工具轨迹与文件系统 | `DelegationManager.sendToParent` | test: `delegation` |
| 27 | help 页四段式 | `packages/tools/src/help.ts` | test: `help-gate` |
| 28 | 未连接 connector 只回状态行 | `packages/tools/src/execute.ts` | test: `help-gate` |
| 29 | WhatsApp 24 小时窗口 | `packages/integrations/src/channels.ts` | test: `channels-browser`；demo: [8] |
| 30 | 四个预批准模板（`notify`） | `NOTIFY_TEMPLATES` | test: `channels-browser`；demo: [8] |
| 31 | 浏览器 lease（读写分离、写租约争用） | `packages/integrations/src/browser.ts` | test: `channels-browser` |
| 32 | guidance token 强制 | 同上 `acquire()` | test: `channels-browser` |
| 33 | lease 失效是连接类错误 | `requireLease()` | test: `channels-browser` |
| 34 | /memory 只读（内核级） | `packages/sandbox/src/profile.ts` | test: `sandbox`；demo: [6]；`dora doctor` |
| 35 | 记忆库规范（frontmatter/wiki-link/150 行升级/rollup） | `packages/memory/src/*` | test: `data-plane` |
| 36 | 凭证不入记忆库 | `MemoryStore.write` 守卫 | test: `data-plane` |
| 37 | observations SQL 四条限额 | `packages/observations/src/store.ts` | test: `data-plane`；demo: [9] |
| 38 | Vault 只代填 | `packages/vault/src/store.ts` | test: `data-plane`；demo: [7] |
| 39 | 会员填写链接为一次性 | `submitFill()` | test: `data-plane` + `api` |
| 40 | 事件流保存完整工具返回 | `AgentRunner.runInner` | test: `agent-loop` |
| 41 | `/agent` 受 `agent_chat` 控制 | `apps/api/src/server.ts` | test: `api` |
| 42 | 委派族对主 Agent 只给 ACCESS 摘要 | `denialFor()` | test: `permissions` |
| 43 | 运行时不可用型动作（语音） | `steer_voice_agent` 处理器 | test: `permissions`（矩阵） |

## 覆盖账本

| 项 | 数字 |
|---|---|
| 工具族 | 40（含 skills 族） |
| 已路由动作 | 214 |
| 目录声明动作 | 579 |
| Connector | 28 个描述符，已连接 26 个 |
| Skill | 24 个（描述 + 正文 + references） |
| 事件类型 | 14 |
| 测试 | 58（全部通过） |
| demo 步骤 | 23（全部 PASS） |
| bench 任务 | 16（easy 5 / medium 5 / hard 4 / extreme 2） |

## 实跑发现并修复的缺陷

用 DeepSeek V4.1 真跑任务后，从日志与事件流里挖出来的问题（每条都有对应回归测试）：

| # | 症状 | 根因 | 修复 | 回归测试 |
|---|---|---|---|---|
| 1 | 每个 `tools` 调用都退出 70，"runtime socket is not available" | bench 用 `listen:false` 建 runtime，从未启动 session socket | bench 在首个 bash 前 `await runtime.start()` | bench 直接暴露 |
| 2 | 相对 `--dir` 直接崩："memory path escapes the repo" | dataDir 未绝对化，MemoryStore 的 root 守卫用字符串前缀比较 | `loadConfig` 统一绝对化 + 各 store 自行 `resolve` | `regressions` |
| 3 | 模型按提示去 `cat /memory/...` 全部失败，白烧 24 轮 | 提示词广播的是预览 session 的路径 | 路径按真实 session 计算并注入 | `regressions`（prompt 路径） |
| 4 | `observations sql` 能读到 `connector_accounts.credentials` | SQL 只有语法守卫，没有关系白名单 | 只允许 observations 及其来源视图 | `regressions` |
| 5 | Agent 能读产品源码与本机凭证目录（模型 key） | seatbelt 只隐藏了 DB/vault，源码树和别人家目录里的凭证仍可读 | CLI 打包进工作区；默认隐藏源码树与常见凭证目录，可用 `DORA_HIDDEN_PATHS` 追加 | `sandbox` + 手动围栏探针 |
| 6 | 面板打印的 `?token=` URL 打开后全站 401 | `boot()` 从未读取 query 里的 token | boot 先 `readTokenFromQuery()` 再发首个请求 | `tools/browser-check`（Chromium 实测 0 错误） |
| 7 | `tools help todos.read` 只回 "unknown target" | 帮助没有"族存在但动作不存在"的分支 | 提示该族可用动作 | `regressions` |
| 8 | 读单条邮件/事件经常 "no message" | 读取处理器只取前 N 行再按 id 过滤 | `records({externalId})` 直接按 id 查 | 由 bench e4 覆盖 |
| 9 | bench 评估漏判：链式命令里的 `tools` 调用没被识别 | 只解析命令首 token | 扫描命令中每一处 `tools` 调用 | 由 bench e4 覆盖 |
| 10 | `search.search` 查了不存在的表，观察库命中全丢 | 表名写错且被 try/catch 吞掉 | 改查 `observations` | 手动验证 |
| 11 | 浏览器订餐流程 400：提交打到表单页 URL 而不是表单 action | 驱动只解析链接与输入框，完全忽略 `<form action/method>` | 解析表单并把控件归属到表单；点提交控件按 action+method 提交该表单全部字段 | `channels-browser`（真实 mock 站点订到 TRV-2172） |

**动作数只给一个口径**：已路由动作数 —— 每个动作都必须有 SUMMARY、DETAILS、USAGE、OPTIONS、OUTPUT JSON，
由 `registry` 的单测与 `/api/tools` 的 `has_output_json` 字段保证，
不存在"页面取回但结构不齐"的中间态。
