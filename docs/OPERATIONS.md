# 运维手册

面向"把 Dora 跑起来并验收"的操作面：模型凭证、日志、mock 环境、任务基准、浏览器验收。

## 1. 模型凭证

运行时会自己找凭证，不需要你把 key 写进环境变量。查找顺序：

| 顺序 | 位置 | 说明 |
|---|---|---|
| 1 | `DORA_API_KEY` / `DEEPSEEK_API_KEY` | 环境变量优先 |
| 2 | `~/.config/dora/credentials.json` | 本机已有的凭证文件 |
| 3 | `~/.config/dora/credentials.env` | `KEY="value"` 形式 |
| 4 | `~/.config/dora/credentials.yaml` | 本机凭证库（refs 段） |

日志里只会出现指纹（如 `sk-7…77c(35 chars)`），永远不写完整 key。
`DORA_MODEL_PROVIDER=mock` 可强制离线确定性模型（测试与 demo 默认如此）。

默认模型（DeepSeek V4.1 家族，1M 上下文，均支持 tool calling）：

| 档位 | 模型 | 用途 |
|---|---|---|
| main | `deepseek-v4-pro` | 主 Agent 的回合 |
| smart | `deepseek-v4-pro` | `--model-mode smart` 的子任务 |
| fast | `deepseek-flash` | `--model-mode fast` 的子任务、trigger 评估、compaction |

`dora doctor` 会探测凭证并列出可用模型。

## 2. 服务端日志

- 位置：`<dataDir>/logs/dora-YYYY-MM-DD.jsonl`（按天分文件，默认保留 14 天）
- 格式：一行一个 JSON：`{ts, level, channel, msg, ...fields}`
- 通道（channel）：`runtime`、`model`、`tools`、`http`、`bench`
- 脱敏：`sk-…`、Bearer、`--token/--password/--card-number` 等参数值一律替换为 `<redacted>`

关键字段：

| 通道 | 记录 | 关键字段 |
|---|---|---|
| model | 每次模型调用 | model, purpose, attempt, duration_ms, input_tokens, output_tokens, cached_tokens, reasoning_tokens, tool_calls |
| runtime | 一次 run 的生命周期 | wake delivered, model turn, bash call/result, run failed(+stack) |
| tools | 每次 CLI 调用 | argv(脱敏), action, exit_code, duration_ms, attachments |
| http | 每个请求 | method, path, status, duration_ms, authenticated |
| bench | 每个任务 | task start/phase2/threw |

用法：

```bash
dora logs --level warn --limit 50
dora logs --channel model --limit 20
dora logs --session sess_01M4...       # 按 session 追一次 run
DORA_LOG_LEVEL=debug dora serve         # 更细的级别
DORA_LOG_ECHO=0 dora bench              # 只写文件，不刷屏
```

## 3. mock 环境

`apps/mockweb` 提供三个确定性站点（无 JavaScript、无外网）：

| 站点 | 关键路径 | 用途 |
|---|---|---|
| 餐厅 | `/restaurant`, `/restaurant/book`, `/restaurant/confirm`, `/restaurant/availability`, `/restaurant/botwall` | 表单填写与确认号；party≥5 返回 409 押金；botwall 返回 429 用来验证"不重试机器人墙" |
| 商店 | `/shop`, `/shop/item/<sku>`, `/shop/checkout`, `/shop/pay`, `/shop/leaks` | 结账表单；`confirm` 缺失返回 400；`/shop/leaks` 用于证明卡号没有经由 Agent 文本流过 |
| 机票 | `/flights`, `/flights/results`, `/flights/book` | 结果表与"最终状态"页 |

```bash
node apps/mockweb/src/index.ts        # 默认 127.0.0.1:8610
MOCKWEB_PORT=8611 node apps/mockweb/src/index.ts
```

## 4. 任务基准

```bash
dora bench --list                                   # 16 个任务
dora bench --difficulty easy                        # 只跑 easy
dora bench --only m3-browser-booking --dir var/bench/one
dora bench --mock                                   # 离线模型跑通链路
```

产物：`<dir>/report.md`、`<dir>/report.json`、每个任务一份 `<dir>/<task>/outcome.json`
（含全部工具调用、退出码、tokens、耗时）与 `<dir>/<task>/logs/`（该任务的完整服务端日志）。

评分只看事件流：动作是否被调用、契约是否读过、是否越权、是否把决定交回会员，
不看模型的措辞。

## 5. 浏览器验收

`tools/browser-check` 里有一个独立的 Playwright 工程（只在那个目录里装依赖）：

```bash
DORA_DATA_DIR=/tmp/bc dora serve --port 8555 &
cd tools/browser-check
node check-console.mjs http://127.0.0.1:8555 "$(cat /tmp/bc/admin.token)" /tmp/browser-check
```

输出：每条路由的渲染判定、控制台错误、失败请求与截图（`/tmp/browser-check/*.png`）。
注意 SSE 会让"networkidle"永不触发，脚本用 `domcontentloaded` + 固定等待。
