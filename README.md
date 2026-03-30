# Diana Monitor

Diana Monitor 是 OpenClaw 网关的可视化监控面板，面向 Diana/Jax 两个机器人，提供日志、任务、会话、Token 用量和定时任务管理能力。

## 当前版本重点

- 拆分完成：后端与前端均已模块化，核心文件都控制在 500 行以内
- 鉴权加固：前端不再长期在 URL 里暴露 token，改为 `Authorization: Bearer`
- 稳定性修复：修复非法 bot 参数导致的服务崩溃、session 日志半行截断等问题
- 定时任务增强：
  - 新增暂停/恢复接口：`POST /api/cron-toggle`
  - 前端卡片支持一键暂停/恢复
  - 已暂停任务也会保留展示（后端改为 `cron list --all`）
- 历史任务状态修复：旧任务不再长期卡在“处理中”，超时会标记为“超时未收口”

## 目录结构

```text
.
├── server.js
├── index.html
├── diana-monitor.service
├── assets/
│   ├── css/main.css
│   └── js/
│       ├── main-chat.js
│       ├── main-runtime.js
│       ├── main-skills.js
│       └── tokens.js
└── lib/
    ├── config.js
    ├── api-basic.js
    ├── api-heavy.js
    ├── feishu-service.js
    ├── watchers.js
    ├── ws.js
    ├── parsers.js
    ├── http-utils.js
    ├── skills.js
    └── cost-utils.js
```

## 运行要求

- Node.js 18+
- OpenClaw CLI（diana 使用 CLI 拉取 cron/usage 数据）
- systemd user service（线上推荐）
- 服务模板：`diana-monitor.service.example`（无明文密钥）

## 环境变量

以下变量由 `lib/config.js` 强依赖，缺失会启动失败：

- `DIANA_MONITOR_PORT`（默认 `18790`）
- `DIANA_MONITOR_ACCESS_TOKEN`
- `DIANA_FEISHU_APP_ID`
- `DIANA_FEISHU_APP_SECRET`
- `DIANA_OPENCLAW_TOKEN`
- `JAX_FEISHU_APP_ID`
- `JAX_FEISHU_APP_SECRET`
- `OPENAI_API_KEY`（语音识别链路需要）

## 启动方式

### 方式 1：直接启动

```bash
node server.js
```

### 方式 2：systemd（推荐）

```bash
systemctl --user daemon-reload
systemctl --user restart diana-monitor
systemctl --user status diana-monitor
```

## 访问与鉴权

- 页面：`GET /`（允许匿名访问 HTML 与静态资源）
- API：需要 `Authorization: Bearer <token>`
- WebSocket：`/ws?token=<token>&bot=<botId>`

前端行为：

- 首次支持从 URL 读取 `token`
- 读取后会立即写入 `sessionStorage` 并从地址栏移除
- 后续请求统一走 Header 鉴权

## 主要 API

### 基础 API（`lib/api-basic.js`）

- `GET /api/bots`
- `GET /api/history`
- `GET /api/names`
- `GET /api/chats`
- `GET /api/group-names`
- `GET /api/chat-messages`
- `GET /api/logs`
- `GET /api/log-dates`

### 重型 API（`lib/api-heavy.js`）

- `POST /api/stop-all`
- `GET /api/skills`
- `GET /api/skills/:id/download`
- `GET /api/skills/:id/readme`
- `GET /api/cron-usage`
- `POST /api/cron-toggle?jobId=<id>&enabled=0|1`
- `GET /api/token-usage`

## 定时任务按钮说明

- 运行中任务显示“暂停”
- 已停止任务显示“恢复”
- 按钮与任务头部同一行展示，不再单独占一行
- 操作后会自动刷新列表

## 运维建议

- 不要把真实密钥直接提交到仓库，建议改为 `EnvironmentFile`
- 若发现“旧任务处理中”异常，先强刷页面再检查 `history.json` 与当日日志
- 线上排障优先看：
  - `journalctl --user -u diana-monitor -f`
  - `/api/health` 与 `/api/cron-usage` 返回

## 相关文档

- `docs/运维与发布说明.md`
