<div align="center">

# Dora.ai：开源版 Instinct

[English](README.md) · **简体中文**

<a href="#-快速开始"><img src="https://img.shields.io/badge/快速开始-3_步-blue?style=for-the-badge" alt="快速开始"></a>
<a href="#-参考"><img src="https://img.shields.io/badge/工具面-214_个动作_%2F_40_个族-green?style=for-the-badge" alt="工具面"></a>
<a href="#-验证"><img src="https://img.shields.io/badge/测试-59_项通过-brightgreen?style=for-the-badge" alt="测试"></a>
<a href="#-架构"><img src="https://img.shields.io/badge/沙箱-seatbelt_%28本机%29-red?style=for-the-badge" alt="沙箱"></a>
<a href="#-许可证"><img src="https://img.shields.io/badge/许可证-待选定-lightgrey?style=for-the-badge" alt="许可证"></a>
<img src="https://img.shields.io/badge/Node-%E2%89%A522.6-339933?logo=node.js&logoColor=white" alt="Node ≥ 22.6">

</div>

## 📌 这是什么

Dora 是一个常驻的个人 Agent。主 Agent 收消息、维护记忆，动手的活派给子 Agent，
所有真实动作都在沙箱里由 `tools` CLI 发出。

它是 **Instinct** 那套架构的开源实现：机制一模一样，用 TypeScript 在 Node 标准库上从零重写，
并把执行位置从云端搬到了你自己的机器上。

```text
唤醒（用户消息 · 定时 · 订阅 · 子任务回报）
  → memory_recall 注入              按 last_modified 选取记忆片段
  → system prompt                   角色 · 动作面 · 工具索引 · 27 节
  → 模型回合，恰好两个工具            bash | hold
  → bash 在围栏里执行 `tools …`       权限矩阵 → connector 状态 → help gate
  → tool_result 事件                 stdout / stderr / 附件全文入库
  → hold
```

## ✨ 核心特性

| | |
|---|---|
| 🧠 **两类角色，一张能力矩阵** | 主 Agent / 子 Agent × 15 个 trait × 四档模式——越权调用返回 `ACCESS delegated` / `ACCESS unavailable`（退出码 4） |
| 🔒 **内核级围栏，不是提示词约定** | macOS seatbelt：`/memory` 只读、vault 与数据库不可读、每个 session 一个工作区；宿主没有 `sandbox-exec` 时 bash 直接拒绝执行 |
| 🧰 **只有两个基础工具** | `bash` 与 `hold`。其余全是 `tools` CLI 调用，且首次调用前必须先读契约（help gate，退出码 3） |
| ⏰ **四种唤醒，一个队列** | 用户消息 · cadence/clock/cron 定时 · 事件订阅 · 子任务回报——另有 trigger 条件评估与订阅安全自查 |
| 🗜️ **8 节 compaction** | 上下文超预算时压成固定 8 节摘要，且永远不会丢掉 system prompt |
| 🧩 **三层 skill** | 24 个 skill：`description` → `SKILL.md` → `references`，按 frontmatter 限定角色，按账号经 `{{flag:…}}` 编译 |
| 🗃️ **三处数据面，三种规则** | `/memory` 只读 git markdown · observations 只读 SQL 索引 · vault AES-256-GCM 只代填（没有任何接口会返回明文） |
| 📊 **可运行即可验证** | 59 个 `node:test` 用例、`dora demo` 逐条演示 23 个机制并给 PASS/FAIL、16 个 bench 任务按事件流评分 |

## 🤔 和 Instinct 的区别

| 维度 | Instinct（按已知文档） | Dora |
|---|---|---|
| 执行环境 | E2B / Firecracker 微虚拟机（`e2b.local`，用户 `sandbox`） | 宿主自身内核上的 macOS `sandbox-exec`；`RemoteSandboxAdapter` 是声明式的接口占位 |
| 集成方式 | 厂商 OAuth（Google、Microsoft、Slack、Notion…） | 本地账号：fixture 数据集或粘贴 token——**不存在 OAuth 流程** |
| 浏览器 | 云端租用实例 | 本地 HTTP 驱动 + lease 调度器；截图是**文本渲染** |
| 工具面 | 目录 576 个动作 | 40 个族实际路由 214 个动作；目录仍声明 579 个 |
| 模型 | 未公开 | 任何 OpenAI 兼容端点；默认 `mock`（确定性、离线） |
| 语音 | realtime 语音会话 | `speak` / `steer_voice_agent` 直接报 `UNAVAILABLE` |
| 交付通道 | WhatsApp / SMS / iMessage 优先 | 通道是本地的：发送落 SQLite，入站靠 `POST /api/channels/inbound` 注入 |
| 数据 | 托管控制面 | 一个 SQLite 文件、一个 git 仓库、一个加密 blob，全在 `DORA_DATA_DIR` 下 |

## 🧩 想达到 Instinct 的效果，你需要自己补什么

每一件都需要真实账号、手机号或云资源。

| 你想要的"效果" | Dora 现在的样子 | 你需要补上 |
|---|---|---|
| 一个能收发 WhatsApp / 短信的号码 | 本地通道存储，没有网关 | Twilio 或 Meta Cloud API（24 小时窗口的强制已经在代码里）；入站打到本地 webhook |
| 你真实的 Gmail / 日历 / Drive | 28 个 connector 描述符，背后是 44 条夹具记录 | 注册 OAuth 应用，把每个 connector 的真实 API 客户端接到 `connectors.records/put` 后面 |
| 云端沙箱 | 本机 seatbelt | 实现 `RemoteSandboxAdapter.exec`，接 E2B、Firecracker、gVisor 或你自己的虚拟机 |
| 真实浏览器 | 本地驱动、文本渲染截图 | 把驱动指向 Playwright 或托管浏览器服务 |
| 可用的搜索 | 无 key 的 DuckDuckGo HTML 端点（开箱可用） | 设置 `DORA_SEARCH_ENDPOINT` 指向付费 API |
| 支付、机票、天气、地图、图片 | 契约与守卫齐全，没有供应商 | 每个族接一个供应商；现在它们回 `no … provider configured` |
| 语音输入输出 | 声明为运行时不可用 | 一个 realtime 语音会话 |
| 365 个"只声明未实现"的动作 | help 索引知道名字；调用返回 `unknown action`（退出码 64） | 按各自契约逐个实现 |

## 🚀 快速开始

前置：**Node ≥ 22.6**（原生 TypeScript、`node:sqlite`）、**git**，以及 macOS（seatbelt 围栏需要）。

```bash
# 1 —— 链接 workspace，并构建沙箱里要用的 tools CLI
pnpm install && pnpm build:cli

# 2 —— 建库、播种账号数据、打印 admin token
node bin/dora.ts init

# 3 —— 逐条演示机制（PASS/FAIL），然后起运行时
node bin/dora.ts demo
node bin/dora.ts serve        # 控制台 + 控制面 API：http://127.0.0.1:8420
```

可选：接真实模型（默认 `mock` 是确定性、离线的）。

```bash
export DORA_MODEL_PROVIDER=openai DORA_API_KEY=sk-… DORA_BASE_URL=https://api.deepseek.com/v1
node bin/dora.ts chat         # 同一个运行时，在终端里对话
```

## 🏗️ 架构

```text
bin/dora.ts            init · serve · chat · demo · tools · bench · logs · doctor
apps/api               HTTP + SSE 控制面、管理端、vault 填写页
apps/web               管理端 SPA，以及受 agent_chat 开关控制的 /agent 对话页
packages/core          类型、事件、能力矩阵、prompt、compaction、recall、flags
packages/sandbox       seatbelt profile、工作区布局、bash 执行器、输出预算
packages/tools         tools CLI、help 页、help gate、40 个族
packages/runtime       Agent 循环、唤醒、订阅、委派、session socket
packages/{memory,observations,vault}   三处数据面
packages/{integrations,providers,skills}
```

边界规则：模型在看到契约之前不知道工具存在；每次工具调用都是围栏内的一个进程。
委派由主 Agent 负责，浏览器由子 Agent 驱动，子 Agent 不能写通道。

## 📊 参考

命令（都在仓库根目录执行）：

| 命令 | 作用 |
|---|---|
| `node bin/dora.ts init` | 准备 `DORA_DATA_DIR`、播种账号数据、打印 admin token |
| `node bin/dora.ts demo` | 逐条演示 23 个机制，带 PASS/FAIL，离线确定性 |
| `node bin/dora.ts serve` | 运行时 + 控制面 API + 控制台（`--port`，默认 8420） |
| `node bin/dora.ts chat` | 在终端里跟主 session 对话 |
| `node bin/dora.ts tools …` | tools CLI，和 Agent 看到的完全一样 |
| `node bin/dora.ts doctor` | 环境与隔离能力探测 |
| `node bin/dora.ts bench` | 用真实模型跑 16 个任务（**只有这条会花钱**） |
| `node bin/dora.ts logs` | 结构化服务端日志（`--level`、`--channel`、`--session`） |

环境变量：

| 变量 | 默认 | 含义 |
|---|---|---|
| `DORA_DATA_DIR` | `~/.dora` | 数据库、工作区、记忆库、vault、日志 |
| `DORA_MODEL_PROVIDER` | 自动（找不到凭证则 `mock`） | `mock` 或 `openai` |
| `DORA_API_KEY` / `DORA_BASE_URL` | — / DeepSeek | 任意 OpenAI 兼容端点 |
| `DORA_MODEL_MAIN` / `_FAST` / `_SMART` | `deepseek-v4-pro` / `-flash` / `-pro` | 各档模型 id |
| `DORA_ALLOW_UNSANDBOXED` | 未设置 | 设为 `1` 时在无围栏的宿主上裸跑 bash |
| `DORA_SEARCH_ENDPOINT` | DuckDuckGo lite | `search.search` / `web_fetch.fetch` 的后端 |
| `DORA_LOG_LEVEL` | `info` | `debug` · `info` · `warn` · `error` |

数据面：`/memory` 是 Agent 只读的 git 仓库 · observations 只接受 `SELECT`/`WITH`，3 秒、10000 行上限 ·
vault 用 AES-256-GCM 加密，只能代填表单，永远读不回明文。

## ✅ 验证

```bash
pnpm test                    # 59 个 node:test 用例，离线，约 9 秒
node bin/dora.ts demo        # 23 个机制
node bin/dora.ts doctor      # node · sqlite · seatbelt · git · 围栏 · 模型 · skill · 工具面
```

有两种失败是环境导致、不是回归。没有 `/usr/bin/sandbox-exec` 时 bash 拒绝执行，这正是围栏在生效；
真实 `bench` 需要模型凭证，而测试与 `demo` 不需要。

## 📄 许可证

**尚未选定许可证**，目前保留所有权利。代码可以随意阅读，但复用需要一份还不存在的许可证；
想用的话开个 issue 说一声。

架构说明、机制对照表与运维手册在 [`docs/`](docs/)。
