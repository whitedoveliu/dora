# Dora.ai 管理端

纯静态、零依赖：`index.html` + `app.js` + `styles.css` 由 `apps/api` 直接托管，没有构建步骤。

- `index.html` —— 管理端外壳（`#/overview`、`#/sessions`、`#/connectors`、`#/tools`、`#/skills`、
  `#/memory`、`#/observations`、`#/vault`、`#/channels`）
- `agent.html` —— 对话页，受 `agent_chat` 开关控制；关掉时服务端直接返回
  `Agent chat feature not enabled`
- `app.js` —— 全部逻辑（hash 路由、SSE、token 处理）
- `styles.css` —— 一套样式，跟随系统深浅色

## 鉴权

所有 `/api/*` 都要 `Authorization: Bearer <token>`。token 来自
`?token=` 查询参数（首次进入后写入 `localStorage` 的 `dora.token`），或直接读 localStorage。
`GET /api/health` 与 `/vault/fill/<token>` 是唯一两个不需要 token 的入口。

启动：

```bash
node bin/dora.ts serve
# 控制台会打印带 token 的 URL
```

## 页面 → 接口

| 页面 | 接口 |
|---|---|
| #/overview | `GET /api/overview`、`POST /api/flags`、`POST /api/connectors/accounts` |
| #/sessions | `GET /api/sessions`、`GET /api/sessions/:id`、`GET /api/sessions/:id/stream`(SSE)、`POST /api/sessions/:id/messages` |
| #/connectors | `GET /api/connectors`、`POST /api/connectors/accounts`、`DELETE /api/connectors/accounts/:id` |
| #/tools | `GET /api/tools`、`GET /api/tools/:path/help`、`POST /api/tools/exec` |
| #/skills | `GET /api/skills` |
| #/memory | `GET /api/memory`、`POST /api/memory/file` |
| #/observations | `GET /api/observations`、`POST /api/observations/sql` |
| #/vault | `GET /api/vault`、`POST /api/vault/links` |
| #/channels | `GET /api/channels`、`POST /api/channels/inbound` |
| /agent | `GET /api/sessions`、`GET /api/sessions/:id/stream`、`POST /api/sessions/:id/messages` |
