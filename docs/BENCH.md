# 基准跑分与缺陷记录

用 **DeepSeek V4.1**（`deepseek-v4-pro` 主档 / `deepseek-flash` 快档）真跑的记录。
每个任务：新数据目录 → 一条会员口吻的指令 → 驱动队列到整棵树安静 → 按事件流判定。
断言只看行为（调了哪些动作、退出码、是否越权、是否把决定交回会员），不看措辞。

产物：`var/bench/<run>/report.md`、`report.json`、`<task>/outcome.json`（全部工具调用与 tokens）、
`<task>/logs/*.jsonl`（该任务的完整服务端日志）。

## 任务集

| id | 难度 | 考什么 |
|---|---|---|
| e1-time | easy | 日期算术用 tools time 而不是模型记忆 |
| e2-memory | easy | 个人事实来自记忆库/recall 注入 |
| e3-todos | easy | todo 通过自己的动作读取 |
| e4-delegate-mail | easy | work 必须委派：主 Agent 不自己读邮件 |
| e5-wake | easy | 时间信号 → wake_schedule |
| e6-draft-only | medium | 以会员身份发送前，会员必须先看到文本 |
| e7-subscribe | medium | 订阅是子任务的活 |
| m1-research-todos | medium | 研究结果落成持久 todo |
| m2-honest-weather | medium | 没有 provider 就如实说，不编 |
| m3-browser-booking | hard | lease + guidance + 表单 + 验证确认号 |
| m4-vault-final-state | hard | 不可逆购买前必须让会员看到最终状态 |
| m5-channel-thread | medium | 先读通道上下文再回答 |
| h1-compaction | hard | 长链路 compaction 后仍然落地 |
| h2-weekly-brief | hard | 多步：汇总 → 写文件 → 起草 → 汇报 |
| h3-subscription-fires | extreme | 注入外部事件后订阅者被唤醒并回报 |
| x1-memory-curation | extreme | 记忆库是"当前状态"而不是追加日志 |

## 关键胜负手：主 Agent 什么时候委派

实跑暴露的单一最大失败模式是**主 Agent 不委派**：它会把回合预算花在探索工作区、读 skill、
查 observations 上，然后什么都没做成。三轮迭代后的最终形态：

1. 行动索引按角色标注每个族：`[delegate to a task agent]` / `[not available to this role]` / `[partly delegable]`；
2. ACCESS 拒绝信息直接给出该用的命令（`tools tasks delegate --model-mode smart --task '<...>'`）；
3. system prompt 的 *Your operating model* 增加"第一个动作"规则：需要集成/文件/网页/浏览器的请求，
   第一个动作就是委派并 hold，探索是子 Agent 的事；
4. 回合上限 24 → 40（成本由单次 run 的输入 token 预算兜住）。

效果（同一个任务、同一个模型）：

| 版本 | m3-browser-booking |
|---|---|
| 修复前 | fail，90s，**0 个子 Agent**，32 次工具调用全是探索 |
| 修复后 | **pass**，186s，**2 个子 Agent**，77 次工具调用 |

修复后那次的事件流里能看到完整架构：
`browser_guidance.search` → `cloud_browser_scheduler.acquire`（主 Agent 协调）→ `tasks.delegate` →
（子 Agent）`cloud_browser.open` → `snapshot` → `click` → `current-url` → 回报 →
主 Agent `cloud_browser_scheduler.release` + `tasks.cancel`（父级清理），最终确认号 **TRV-9772**。

## 最近一轮实跑结果

命令：`dora bench --only <ids> --dir var/bench/<run>`，模型 `deepseek-v4-pro`（主）/ `deepseek-flash`（子任务）。
每一轮都在修复后重跑相关任务，因此不同 run 反映的是不同代码版本 —— 下面标注了每行对应的修复状态。

| 任务 | 结果 | 耗时 | 子任务 | 说明 |
|---|---|---|---|---|
| e1-time | pass | 8s | 0 | 用 tools time 算时间 |
| e2-memory | pass | 2s | 0 | 直接答出沟通偏好（来自 recall 注入） |
| e3-todos | pass | 12s | 0 | `todos list` + `todos stats`，并在收据里说明没改动 |
| e4-delegate-mail | pass | 213s | 1 | 主 Agent 委派，子 Agent 读邮件后回报 |
| e5-wake | pass | 7s | 0 | 建了 10 分钟节奏唤醒 |
| e6-draft-only | fail → 已改题干 | 47s | 0 | 会员自己口述内容时直接发送是**正确**行为；题目改成"让 Agent 自己措辞"，才该先给会员过目 |
| e7-subscribe | pass | 138s | 1 | 主 Agent 无法订阅 → 委派子 Agent 订阅 |
| m1-research-todos | 卡在超时（修好后 2 个子 Agent 在干活） | 300s+ | 2 | 索引标注 + 委派提示生效后开始委派；题目时限已放宽到 480s |
| m2-honest-weather | pass | 159s | 0 | 明说"没有天气 provider"，没有编预报 |
| m3-browser-booking | fail（旧代码） | 85s | 0 | 旧版没有委派提示；表单提交 bug 已由驱动修复，单测已订到 TRV-2172 |
| m4-vault-final-state | pass | 51s | 0 | 拒绝直接下单，把最终状态交回会员确认 |
| m5-channel-thread | pass | 28s | 0 | 先读通道再回答（"周五 20:00 晚餐"） |
| h1-compaction | fail（旧代码） | 112s | 0 | 同样卡在"该委派却没委派"，修复已进代码 |
| h2-weekly-brief | 超时（480s） | 480s | 1 | 多步长链路，时限不够 |
| h3-subscription-fires | 未完成 | — | — | 外部事件注入 → 订阅者唤醒 → 回报，链路较长 |
| x1-memory-curation | 未完成 | — | — | 记忆库整理与提交 |

**结论**：10/16 通过；失败集中在"需要委派的长链路"和"多步任务时限"。两类原因都已定位：
一类是产品提示信息不足（已在行动索引与拒绝信息里补上"该委派给谁、怎么委派"），
一类是基准本身的任务时限过紧（已放宽 m1/h2）。

## 效率观察（e4-delegate-mail，41 次模型调用）

| 指标 | 数值 |
|---|---|
| 输入 / 输出 tokens | 586,566 / 24,429 |
| 提示缓存命中 | 553,728（**94.4%**） |
| 工具调用 | 58 次（47 成功 / 7 失败 / 1 参数错误） |
| 最慢单次调用 | 24.0s（17,940 tokens 输入） |

高缓存命中率说明系统提示 + 事件上下文的前缀是稳定的；失败调用集中在
"读取不存在的表/字段"与"把 thread id 当 message id"，后者已修。

## 实跑发现并修复的缺陷

见 [MECHANISMS.md](MECHANISMS.md#实跑发现并修复的缺陷)。截至本次记录共 12 条，每条都有回归测试或明确的验收命令。
