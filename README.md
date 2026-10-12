# Dora.ai

> 个人 Agent 运行时：常驻的主 Agent 从 IM 接活，把需要动手的部分委派给子 Agent，
> 所有真实动作都经由一个受内核沙箱约束的 `tools` CLI 发出。

它由这些机制组成：主/任务两类 Agent、只有两个基础命令（`bash` 与 `hold`）、`tools` CLI 与 Help gate、
定时唤醒与事件订阅、8 节 compaction、`memory_recall` 注入、27 节 system prompt、
三层 skill 系统，以及 memory / observations / vault 三处持久状态。

零依赖：运行时只用 Node 内置能力（`node:sqlite`、`node:test`、原生 TypeScript 类型擦除），
唯一的三方包是构建期的 esbuild —— 它负责把 `tools` CLI 打包进沙箱工作区。

---

## 快速开始

```bash
pnpm install                   # workspace 软链（顺带装上构建期的 esbuild）
pnpm build:cli                 # 打包 tools CLI 到 packages/tools/dist，沙箱里的 agent 靠它执行动作
node bin/dora.ts init          # 建库、播种账号数据、打印 admin token
node bin/dora.ts demo          # 逐条演示 23 个机制，带 PASS/FAIL
node bin/dora.ts serve         # 起 runtime + 控制面 API + 管理端，默认 http://127.0.0.1:8420
node bin/dora.ts chat          # 用终端跟主 Agent 对话
node bin/dora.ts doctor        # 环境与隔离能力自检
node --test "tests/*.test.ts"  # 58 个测试
```

默认模型是 `mock`（确定性、离线、不需要 key）。接真实模型：

```bash
export DORA_MODEL_PROVIDER=openai
export DORA_API_KEY=sk-...
export DORA_BASE_URL=https://api.deepseek.com/v1   # 或任何 OpenAI 兼容端点
export DORA_MODEL_MAIN=deepseek-chat DORA_MODEL_SMART=deepseek-reasoner
node bin/dora.ts serve
```

## 用真实模型跑

运行时会自己找本机已有的模型凭证（环境变量 → `~/.config/dora/credentials.json` → `credentials.env` →
`~/.config/dora/credentials.yaml`），默认用 **DeepSeek V4.1**：`deepseek-v4-pro`（主）+
`deepseek-flash`（快档）。日志里只出现 key 指纹，永远不写完整 key。

```bash
dora doctor                     # 探测凭证、列出可用模型、实测沙箱围栏
dora bench --difficulty easy    # 真实模型跑一批任务，产物在 var/bench/
dora logs --channel model       # 看每次模型调用的 tokens 与耗时
```

测试与 `dora demo` 强制走离线 mock 模型（确定性、不花钱）；只有 `dora bench` 会调真实模型。

## 服务端日志

一行一个 JSON，落在 `<dataDir>/logs/dora-YYYY-MM-DD.jsonl`，按天轮转、默认留 14 天。
五个通道：`runtime`（run 生命周期）、`model`（每次调用与 tokens）、`tools`（每次 CLI 调用与退出码）、
`http`（每个请求）、`bench`（任务）。所有日志在写出前脱敏：`sk-…`、Bearer、
`--token/--password/--card-number` 等参数值都会变成 `<redacted>`。

```bash
dora logs --level warn --limit 50
dora logs --session sess_01M4...     # 追一次完整 run
```

## mock 环境与任务基准

- `apps/mockweb` 三个确定性站点（餐厅预订 / 商店结账 / 机票），无 JS 无外网，
  专门用来验收云浏览器链路；`/restaurant/botwall` 返回 429 验证"不重试机器人墙"，
  `/shop/leaks` 用来证明卡号没有经由 Agent 文本流过。
- `dora bench` 是 16 个任务（easy → extreme）：从"现在几点"到多智能体 + 浏览器 + vault +
  compaction 的长链路。评分只看事件流（调了哪些动作、退出码、是否越权、是否把决定交回会员），
  产物含每个任务的 `outcome.json` 与该任务的完整日志。
- `tools/browser-check` 用真实 Chromium 验收管理端：9 条路由的渲染判定、控制台错误、
  失败请求与截图。

## 实现了哪些机制

| 机制 | 实现 |
|---|---|
| 两类 Agent + 权限矩阵 | `packages/core/src/permissions.ts`，四档 `EXECUTABLE/DELEGATED/PARTIAL/UNAVAILABLE` |
| 只有 `bash` 与 `hold` 两个基础命令 | `packages/runtime/src/agent.ts` 的 `BASE_TOOLS` |
| bash 45 秒限时 + 两类内容过滤 | `packages/sandbox/src/filters.ts`、`adapter.ts` |
| `tools` CLI 与 Help gate（退出码 3、附 help 页） | `packages/tools/src/{cli,gate,execute}.ts` |
| 唤醒：cadence / clock / cron + threshold + trigger | `packages/runtime/src/{cron,wakes}.ts` |
| 事件订阅 + 平台托管安全自查 | `packages/runtime/src/wakes.ts` |
| 压缩成固定 8 节摘要 | `packages/core/src/compaction.ts` |
| `memory_recall` 注入 | `packages/core/src/recall.ts` |
| 27 节 system prompt | `packages/core/src/prompt.ts` |
| 三层 skill（description / SKILL.md / references） | `packages/skills`，语料 24 个 skill |
| 工具面：族 / 页 / OPTIONS / OUTPUT JSON | `packages/tools/src/families/*` |
| 未连接 connector 只回状态行 | `packages/tools/src/execute.ts` |
| /memory 只读 git 库、wiki-link、rollup | `packages/memory` |
| observations sql/fetch 与限额 | `packages/observations` |
| Vault 只代填、不可读出 | `packages/vault` |
| IM 优先、WhatsApp 24 小时窗口、四个预批准模板（`notify`） | `packages/integrations/src/channels.ts`、`packages/tools/src/families/channels.ts` |
| 云浏览器 lease 与 guidance token | `packages/integrations/src/browser.ts` |
| 子任务附件 5 文件 / 20 MB | `packages/runtime/src/delegation.ts` |
| `/agent` 受 `agent_chat` 开关控制 | `apps/api/src/server.ts`、`apps/web/agent.html` |

## 架构（横着看）

```
IM 层        通道适配器（console / WhatsApp / iMessage / agent-mail）
             主 Agent 拥有全部通道 session；网页端是管理面，不是默认对话入口
控制面       HTTP + SSE + unix socket；一个账号一个事件流；工具调用全文入库
执行层       seatbelt 沙箱：真实 shell、/memory 只读、vault 与数据库不可读
             45 秒限时、ulimit、输出预算、越界输出落盘
数据面       memory（git markdown）/ observations（SQL 索引）/ vault（AES-256-GCM 只代填）
```

## 架构（竖着看，一次调用）

```
唤醒（用户消息 / 定时 / 订阅 / 子任务回报）
  → memory_recall 注入（按 last_modified 选取记忆片段）
  → 拼 system prompt：角色段 + 动作面 + 工具索引 + skill description + 27 节
  → 模型回合，只有 bash 与 hold 两个工具
      → bash：三道前置检查（权限矩阵 → connector 状态 → Help gate）→ tools CLI
      → hold：Turn ended.
  → 上下文超预算 → 8 节 compaction 写回事件流
  → 结束：held / completed
```

## 仓库结构

```
packages/core          领域类型、事件、权限矩阵、prompt、compaction、recall、flags
packages/sandbox       seatbelt 沙箱、工作区布局、bash 执行器与内容过滤
packages/tools         tools CLI、help 页、Help gate、40 个族 / 214 个动作
packages/runtime       Agent 循环、wake 调度、订阅、委派、session socket、装配
packages/memory        git 记忆库（frontmatter、wiki-link、rollup）
packages/observations  SQL 索引与限额、fetch
packages/vault         AES-256-GCM 凭证库（只代填）
packages/integrations  connector、浏览器 lease 与 guidance、通道、检索、fixture
packages/skills        三层 skill 加载器 + 24 个 skill 语料
packages/providers     OpenAI 兼容 provider 与确定性 mock
apps/api               控制面 HTTP/SSE、管理端接口、会员填写页
apps/web               管理端 SPA 与受开关控制的对话页
bin/dora.ts            产品入口：init / serve / chat / demo / tools / doctor
docs/                  架构与机制文档
tests/                 58 个 node:test 用例
```

## 文档

- [架构](docs/ARCHITECTURE.md) —— 分层与一次完整调用
- [机制对照表](docs/MECHANISMS.md) —— 机制 → 代码 → 验收

## 已知边界

- 沙箱是本机 seatbelt（`sandbox-exec`）：隔离是内核事实而不是提示词约定，`/memory` 可读不可写、
  vault 与数据库不可读；托管沙箱只有接口占位（`RemoteSandboxAdapter` 未实现）。
- connector 是本地账号：fixture 数据集或 `add-account --token`，不需要任何厂商登录；
  未连接的 connector 只在动作面里留名字，调用只回状态行。
- 浏览器由本地 HTTP 驱动 + lease 调度器实现；截图是文本渲染，真实视觉验证需要接一个浏览器或截图服务。
- 语音通道（`speak` / `steer_voice_agent`）声明为运行时不可用。
- 工具面是 40 个族 / 214 个已路由动作；族在目录里按 579 个动作声明，未实现的动作只有声明。
- 模型是可配置的 OpenAI 兼容端点，默认 `mock`（确定性、离线）；换模型不改架构。
- 支付、机票、天气、地图等族有完整契约与守卫，但没有接外部供应商。
