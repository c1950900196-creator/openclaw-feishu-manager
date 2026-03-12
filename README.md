# Diana Monitor - OpenClaw 监控面板

> 一个轻量级的 OpenClaw AI 助手运行监控工具，实时查看日志、管理会话、监控技能状态。

## 功能亮点

- **实时日志** — 实时展示 OpenClaw 运行日志，支持自动刷新
- **会话管理** — 查看活跃会话，一键停止所有会话
- **技能状态** — 查看已安装的技能列表和状态
- **轻量部署** — 零依赖，纯 Node.js 原生 HTTP 模块

## 技术栈

| 模块 | 技术 |
|------|------|
| 后端 | Node.js（原生 HTTP） |
| 前端 | 内嵌 HTML + CSS + JavaScript |
| 部署 | PM2 / systemd |

## 快速开始

```bash
# 1. 配置环境变量
cp .env.example .env
# 编辑 .env 填入访问令牌

# 2. 启动
node server.js

# 3. 打开浏览器 http://localhost:18790
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | 18790 |
| `ACCESS_TOKEN` | 访问令牌 | - |

## 许可

MIT
