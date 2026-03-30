# Diana Monitor（OpenClaw Feishu Manager）

Diana Monitor 是一套面向 OpenClaw 机器人的监控后台，支持 **Diana / Jax 多 Bot 视角**，核心能力包含：

- 实时日志流（WebSocket + tail/watch）
- 会话与任务状态可视化
- 用户聊天列表与消息预览
- Token 成本统计与趋势分析
- 定时任务（cron）可视化、暂停、恢复
- Skills 列表、详情和打包下载

本仓库现在是已经完成模块化重构后的版本，目标是「可维护、可排障、可交接」。

---

## 1. 版本亮点（本次重构后）

### 1.1 架构与可维护性

- 前后端拆分完成，核心文件控制在合理长度
- 后端从单体 `server.js` 拆为路由、服务、解析器、watchers 等模块
- 前端从大脚本拆为聊天、运行时、技能、token 四个子模块

### 1.2 稳定性与安全

- 修复非法 `bot` 参数可导致进程崩溃的问题
- 请求处理增加全局 `try/catch`，防止未处理异常导致服务退出
- 修复 session JSONL 半行读取导致的日志事件丢失
- 历史回填增强：启动时扫描全部日志文件，避免只看最近 2 天

### 1.3 鉴权改造

- API 请求统一改为 `Authorization: Bearer <token>`
- 页面首次可从 URL 读取 `token`，随后立即写入 `sessionStorage` 并移除 URL 参数
- 防止 token 长期暴露在浏览器历史、日志和分享链接中

### 1.4 定时任务体验升级

- 新增 `POST /api/cron-toggle`，支持暂停/恢复
- 卡片按钮已改为和标题同一行，不再单独占行
- 后端改为 `cron list --all`，暂停任务不会“消失”
- 老任务状态增加收口逻辑，避免长期显示“处理中”

---

## 2. 技术栈与运行依赖

- Node.js 18+
- OpenClaw CLI（Diana 模式依赖 CLI 查询 cron/usage）
- Linux + systemd user service（推荐线上方案）
- 可访问 Feishu API（消息、会话、群名解析等）

---

## 3. 目录结构与职责

```text
.
├── server.js                          # 入口：HTTP + WebSocket + 启动流程
├── index.html                         # 页面骨架
├── diana-monitor.service              # 服务文件（已去敏占位）
├── diana-monitor.service.example      # 推荐模板（占位符）
├── assets/
│   ├── css/main.css                   # 全局样式
│   └── js/
│       ├── main-chat.js               # 聊天列表/任务历史/详情
│       ├── main-runtime.js            # 实时日志、任务状态、Tab 运行时
│       ├── main-skills.js             # Skills 交互
│       └── tokens.js                  # Token 用量 + cron 展示与控制
└── lib/
    ├── config.js                      # 环境变量与 bot 配置
    ├── api-basic.js                   # 轻量 API
    ├── api-heavy.js                   # 重计算/CLI API（token、cron、skills）
    ├── feishu-service.js              # Feishu/OpenAI 相关服务
    ├── watchers.js                    # 日志与会话文件监听
    ├── ws.js                          # WebSocket 鉴权与分发
    ├── parsers.js                     # 日志/会话事件解析
    ├── http-utils.js                  # 响应、缓存、静态资源、token 提取
    ├── skills.js                      # skill 扫描/打包
    └── cost-utils.js                  # token 成本估算
```

---

## 4. 配置说明（必填环境变量）

由 `lib/config.js` 强依赖，缺失会直接启动失败：

- `DIANA_MONITOR_PORT`（默认 `18790`）
- `DIANA_MONITOR_ACCESS_TOKEN`
- `DIANA_FEISHU_APP_ID`
- `DIANA_FEISHU_APP_SECRET`
- `DIANA_OPENCLAW_TOKEN`
- `JAX_FEISHU_APP_ID`
- `JAX_FEISHU_APP_SECRET`
- `OPENAI_API_KEY`（语音识别链路需要）

> 生产建议：使用 `EnvironmentFile` 管理密钥，不要把真实密钥提交进仓库。

---

## 5. 启动方式

### 5.1 直接运行（开发/临时）

```bash
node server.js
```

### 5.2 systemd user service（推荐）

```bash
systemctl --user daemon-reload
systemctl --user restart diana-monitor
systemctl --user status diana-monitor
```

日志查看：

```bash
journalctl --user -u diana-monitor -f
```

---

## 6. 鉴权与访问规则

- 页面入口：`GET /`（允许匿名访问页面与静态文件）
- API：必须携带 `Authorization: Bearer <token>`
- WebSocket：`/ws?token=<token>&bot=<botId>`

前端 token 流程：

1. 首次可用 `?token=...` 打开
2. 页面启动后写入 `sessionStorage`
3. 立刻从地址栏移除 token
4. 后续请求全部走 Header

---

## 7. API 总览

### 7.1 基础 API（`lib/api-basic.js`）

- `GET /api/bots`：bot 列表
- `GET /api/history`：历史事件
- `GET /api/names`：用户名映射
- `GET /api/chats`：chatId 映射
- `GET /api/group-names`：群名映射
- `GET /api/chat-messages`：消息详情
- `GET /api/logs`：按日期读取日志
- `GET /api/log-dates`：可选日志日期

### 7.2 重型 API（`lib/api-heavy.js`）

- `POST /api/stop-all`：停止活跃会话
- `GET /api/skills`：技能列表
- `GET /api/skills/:id/download`：下载技能包
- `GET /api/skills/:id/readme`：技能说明
- `GET /api/token-usage`：token 成本统计
- `GET /api/cron-usage`：cron 与执行统计
- `POST /api/cron-toggle?jobId=<id>&enabled=0|1`：暂停/恢复任务

---

## 8. 定时任务（Cron）说明

### 8.1 展示逻辑

- 后端使用 `openclaw cron list --all --json`
- 因此启用与停用任务都会显示

### 8.2 按钮逻辑

- `运行中` -> 显示 `暂停`
- `已停止` -> 显示 `恢复`
- 点击后按钮原位进入处理中状态，并自动刷新列表

### 8.3 常见疑问

- **为什么暂停后任务会消失？**  
  旧逻辑只查启用任务，现在已改为 `--all`，不会再消失。

---

## 9. 数据与缓存策略（简要）

- 历史事件：内存 + `history.json`，默认上限 `MAX_HISTORY=2000`
- 启动回填：扫描日志并补齐 chat/user 关系
- 启动预热：自动触发 token usage 缓存，减少首屏慢请求
- `cron-usage` 缓存较短（秒级）以兼顾实时性与性能

---

## 10. 常见问题排障

### 10.1 页面显示 Unauthorized

确认访问的是 `/` 而不是 API；前端首次进入需携带 token 参数或已有 sessionStorage。

### 10.2 旧任务一直“处理中”

已增加状态收口与超时兜底；若仍异常，建议强刷页面并检查 `history.json` 与当日日志。

### 10.3 cron 操作点了没变化

先看 `GET /api/cron-usage` 是否返回 `ok=true`，再看服务日志是否有 CLI 超时或 token 错误。

---

## 11. 安全基线建议

- 仓库内只保留去敏模板（本仓库已处理）
- 统一从环境变量注入密钥
- 定期轮转 token / app secret / API key
- 禁止把真实密钥写入 `.service`、README、脚本或截图

---

## 12. 发布与回滚

请优先参考：`docs/运维与发布说明.md`

- 发布：语法检查 -> 重启服务 -> 冒烟验证
- 回滚：回退到上一个稳定 commit 后重启

---

## 13. 快速验证命令

```bash
curl -s http://localhost:18790/health
curl -s -H "Authorization: Bearer <token>" "http://localhost:18790/api/bots"
curl -s -H "Authorization: Bearer <token>" "http://localhost:18790/api/cron-usage?bot=diana"
curl -s -H "Authorization: Bearer <token>" -X POST "http://localhost:18790/api/cron-toggle?bot=diana&jobId=<jobId>&enabled=0"
```

---

## 14. 相关文档

- `docs/运维与发布说明.md`
- `diana-monitor.service.example`

---

## 支持项目

如果这个项目对你有帮助，欢迎点一个 Star ⭐，这会帮助更多需要 OpenClaw + Feishu 监控方案的人找到它。
