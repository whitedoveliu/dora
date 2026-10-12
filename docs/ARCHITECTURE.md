# Dora.ai 架构

本文从两个视角描述 Dora.ai：**横着看**的四个设计面（IM 层 / 控制面 / 执行层 / 数据面），
与**竖着看**的一次完整调用。实现侧的引用一律给到文件与符号名；
四个设计面逐条标出**强制点**与**边界**。

---

## 一、横着看：四个设计面

### IM 层

- 职责：用户从 IM 说话，主 Agent 拥有全部 IM session；Agent 自己的信箱也是入口。
- 实现：`packages/integrations/src/channels.ts`（`ChannelStore`）、
  `packages/tools/src/families/channels.ts`（`whatsappbot` / `imessage` / `agent-mail`）。
- 边界：**不在这一层**的是推理与工具执行。通道只做投递与窗口策略，不做任何决策。
- 强制点：WhatsApp 24 小时窗口关闭后只能发四个预批准模板，
  实现为 `ChannelStore.make().send()` 里的窗口检查，模板参数 `template` 是唯一的豁免通道；
  四个模板文本在 `NOTIFY_TEMPLATES`。

### 控制面

- 职责：客户端 ↔ 后端的协议与状态归属。
- 实现：会话 socket（`packages/runtime/src/tools-server.ts`）给沙箱里的 `tools` CLI 用；
  HTTP + SSE（`apps/api/src/server.ts`）给管理端与对话页用。
- 事件存储分两个查询口：主 session 走会话视图，子任务走事件流视图，
  实现为同一张 `events` 表的两种读法（`SessionStore.events` / `/api/sessions/:id/events`）。
- 关键性质：每次工具调用的完整返回内容都在服务端保存 ——
  `AgentRunner` 把 stdout/stderr/附件元数据整体写进 `tool_result` 事件（超长内容截断到 100 KB 并保留落盘路径）。
- 边界：**不在这一层**的是模型调用与工具实现。

### 执行层

- 职责：跑命令、放文件、给每个 Agent 一个工作区。
- 实现：`packages/sandbox/src/{adapter,profile,workspace,bash,filters}.ts`。
- 沙箱内的路径为 `/memory`、`/skills`、`/observations`、`/downloads`，
  每个 session 一个工作区目录（`Workspace`）。
- bash 单次 45 秒限时、两类内容过滤（形似金额的 `$` 展开、多行引号参数）。
  实现：`DoraConfig.bashTimeoutMs` 默认 45000；`inspectCommand()` 返回 `dollar_amount` / `multiline_quote` 两类拦截。
- **隔离是内核事实，不是提示词**：Dora 用 seatbelt（`buildProfile()`）把围栏写成内核规则：
  `/memory` 可读不可写、vault 与数据库不可读、只有工作区可写、只放行本 session 的 tools socket。
  `dora doctor` 与 `tests/helpers.ts` 都会实测这两条围栏。围栏是**本机**的，不是云端微虚拟机：
  宿主没有 `sandbox-exec` 时 bash 直接拒绝执行，只有显式设置 `DORA_ALLOW_UNSANDBOXED=1` 才降级为无隔离运行；
  沙箱内保留网络访问（要连本 session 的 tools socket）。
- 边界：**不在这一层**的是供应商接入；`RemoteSandboxAdapter` 是留给托管沙箱的接口占位，尚未实现。

### 数据面

见第五节。三处持久状态各自的规则不同，这是产品设计的核心之一。

---

## 二、竖着看：一次完整调用

```
[wake] 四种来源之一：用户消息 / 自定定时 / 事件订阅 / 子任务回报
   │  SessionStore.enqueueWake → markWake(delivered)
   ▼
[recall] selectRecallSnippets（按 last_modified）→ renderRecallBlock → <memory_recall>
   │  AgentRunner.buildMessages
   ▼
[prompt] ROLE_* + 动作面四档 + 工具索引 + skill description + 27 节
   │  buildSystemPrompt
   ▼
[loop]  model.complete(tools = bash | hold)
   ├── bash → 三道前置检查 → tools CLI → tool_result 事件（含附件）
   ├── hold → "Turn ended." → status=held
   └── 无工具调用 → 结束当前 run
   │
   ├─ 上下文超预算 → compact(8 节) → compaction 事件 → 后续轮次以摘要为上下文
   └─ budget 记账（每账号每日窗口）
   ▼
[finish] task agent → onTaskComplete → agent_message.send → 父级收到 task_report 唤醒
```

### 三道前置检查（顺序被强制）

| 顺序 | 检查 | 实现 | 不通过的结果 |
|---|---|---|---|
| 1 | 权限矩阵：该角色对该 trait 是 direct / partial / delegated / unavailable | `denialFor()` | 退出码 4，`ACCESS delegated` / `ACCESS unavailable` |
| 2 | connector 状态 | `ConnectorStore.isConnected()` | 退出码 5，`STATUS unavailable: <connector> is not connected` |
| 3 | Help gate：该动作的契约是否读过 | `HelpGate.isRead()` | 退出码 3，help 页全文作为附件返回，下一轮可调用 |

顺序不能换：先判"你能不能做"，再判"现在能不能做"，最后才是"你读过说明书没有"。
把 gate 放在最前面会让一个被权限拒绝的动作假装成"先去读文档"。

### 被强制的顺序（竖着看才看得见的约束）

- 租用浏览器前先读经验：`browser_guidance search` 返回的 `guidance_token` 在启用强制时
  是 `acquire` 的必填项 —— 在 `LocalBrowserService.acquire()` 里实现为数据流约束。
- 首次调用前必须读契约：拦截本身就是文档来源，见 `HelpGate`。
- 子任务开场包：recall + 任务文本 + 约 15 页预注入 help；预注入即视为已读
  （`DelegationManager.delegate()` 调 `HelpGate.markRead`），所以子任务的第一次调用不被拦。

### 终止条件

| 终止 | 表现 |
|---|---|
| 正常结束 | 模型不再调用工具；`status=completed` |
| 挂起等待 | `hold` → `status=held`，事件流写入 `hold`；等待锁或下一次唤醒 |
| 中断 | bash 超时 → `interrupt_cause=timeout` + `delivered_code=124`；`bash_blocked` → 退出码 2 |
| 预算耗尽 | 轮次上限 → `error: turn budget exhausted`，run 结束而不是静默重置 |

---

## 三、两类 Agent 与权限矩阵

角色段（`ROLE_MAIN` / `ROLE_TASK`，见 `packages/core/src/prompt.ts`）把可调用面写成两句话：
`direct-execute traits` 与 `Traits you see in the action list but cannot invoke directly`。

矩阵实现在 `TRAIT_MATRIX`（15 个 trait × 2 个角色），动作只声明 trait，角色决定能不能调：

| trait | 主 Agent | 子 Agent |
|---|---|---|
| channel.read | direct | direct |
| channel.write | direct | unavailable |
| task_agent.lifecycle | direct | unavailable |
| task_agent.read | direct | partial |
| todos.read | direct | direct |
| todos.write | direct | unavailable |
| work | delegated | direct |
| search | direct | direct |
| orchestration | direct | partial |
| resource.lifecycle | partial | direct |
| browser.drive | unavailable | direct |
| email.send | delegated | direct |
| invites | direct | unavailable |
| wake.schedule | direct | direct |
| wake.subscription | unavailable（`supervisor_subscription_wakes` 打开时 partial） | direct |

最后一行的开关由 flag 决定：`supervisor_subscription_wakes` 打开时主 Agent 拿到显式的 partial，
关闭时是 unavailable；子 Agent 始终 direct。

---

## 四、唤醒：时间信号与事件信号

订阅和定时都是"将来会有一个信号"的输入，区别只在信号从哪来：
两者最终都进 `pending_wakes` 队列，只是 source 不同。

- cadence：`--schedule-interval` 5–10080 分钟；首次触发落在一个周期内。
- clock：`--at` 本地墙钟；cron：五个字段 + 可选年，星期支持 0-7 与 SUN-SAT。
  两者都必须给 `--schedule-threshold`（可接受的迟到分钟数，0 为准点）。
- trigger：`--trigger` 是自然语言条件，触发前由模型评估（`WakeManager.evaluateTrigger`）；
  不满足则**跳过本轮**并写一条 `wake_skipped` 事件，而不是失败。
- 订阅：Gmail / 日历 / 文档 / 位置 / iMessage 五源；同一 source+filter 不重复订阅（拒绝叠加）。
- 安全自查：每个订阅自带 `check_in_frequency_minutes`，静默超时后由平台触发一次
  `safety_check_in` 唤醒，**绕过 trigger 过滤**，用途是审计订阅本身是否还值得保留。

---

## 五、数据面：三处状态，三种规则

### /memory —— 只读 git 记忆库

目录结构 `timeline/ entities/ comms/ workstreams/ knowledge/`；
文件描述当前状态而非追加日志；无 `updated` 字段（历史在 git）；单文件超约 150 行升级为目录，
`_index.md` 保留原 id 与 aliases 以免旧链接断裂；凭证不入库。

实现：`packages/memory/src/store.ts`。`shouldPromote()` 实现 150 行升级规则，
`resolveLinks()` 用 id/alias 解析 `[[wiki-link]]`，`rollup()` 把 `timeline/raw` 汇总到 hourly/daily。
写入路径包含 `vault`/`credential`/`secret` 时直接抛错。

### Observations —— 外部数据索引

`sql` 只允许 SELECT/WITH、3 秒超时、10000 行上限、不用 OFFSET、
按月分区的表必须带时间戳条件；`fetch` 按 path 取全文；禁止用 shell 直接浏览目录。

实现：`packages/observations/src/store.ts` 的 `assertAllowed()` 逐条落地这四个约束，
并使用 `StatementSync.iterate()` 在行流里检查 3 秒预算。
视图（`gmail`、`phone_messages`、`chat-sessions` 等）让模型看到的是表而不是实现细节。

### Vault —— 只代填

fill-only：只代填，内容不显示给模型；密码与卡号不进 IM；用户误贴则存入并建议更换。

实现：`packages/vault/src/store.ts` 用 AES-256-GCM 加密落盘，**整个模块没有任何返回明文的方法**：
`list()`/`status()` 只回标签与字段名，`fill()` 回 `{filled, fields}` 计数。
会员通过一次性链接（`/vault/fill/<token>`，无 admin 鉴权）自行填写，链接用过即废。

---

## 六、system prompt 与 skill 系统

- 27 节标题与顺序固定在 `PROMPT_SECTIONS` 里，Workspace / Tools CLI / Wakes 三节下的
  三级标题同样是固定文本（`### /memory/ — Read-only memory` 等）。
- 四个独立规则块：`Email permissions`、`Earned trust`、`Your contact info`、`preference collection`。
- 进入上下文的是角色段、动作面、工具索引、skill description 和这 27 节；
  **工具契约不在 prompt 里**，它们在首次调用时由 Help gate 动态带进来 ——
  提示词只带工具索引，契约按需拼出。
- skill 三层：description（何时用）→ SKILL.md（怎么做）→ references（用前再读）。
  角色限定由 frontmatter `primary-agent-roles` 决定；`{{flag:...}}` 由账号开关在编译期替换。

---

## 七、已知边界

- 托管沙箱只有接口占位：`RemoteSandboxAdapter` 未实现，执行环境是本机 seatbelt 沙箱。
- 语音动作（`speak` / `steer_voice_agent`）声明为运行时不可用，权限矩阵里也是 `UNAVAILABLE`。
- 浏览器是本地 HTTP 驱动，截图返回文本渲染；lease 与 guidance 语义完整，
  真实视觉验证需要外接浏览器或截图服务。
- 支付、机票、天气、地图等族有完整契约与守卫，但没有接外部供应商。
