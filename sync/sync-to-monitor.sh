#!/bin/bash
# Jax OpenClaw -> Diana Monitor 数据同步脚本
# 部署到 jax 电脑: ~/.openclaw/sync-to-monitor.sh

REMOTE="ubuntu@124.156.206.156"
REMOTE_DIR="/home/ubuntu/diana-monitor/bots/jax"
OPENCLAW_DIR="$HOME/.openclaw"
OPENCLAW_BIN="$(which openclaw 2>/dev/null || echo "$HOME/.npm-global/bin/openclaw")"
GATEWAY_TOKEN=""  # 如果需要 token，在这里填写

# 如果找不到 openclaw，尝试常见路径
if [ ! -x "$OPENCLAW_BIN" ]; then
  for p in /usr/local/bin/openclaw /opt/homebrew/bin/openclaw "$HOME/.npm-global/bin/openclaw"; do
    [ -x "$p" ] && OPENCLAW_BIN="$p" && break
  done
fi

LOG_FILE="/tmp/jax-monitor-sync.log"
exec >> "$LOG_FILE" 2>&1
echo "=== $(date '+%Y-%m-%d %H:%M:%S') sync start ==="

# 确保远程目录存在
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$REMOTE" \
  "mkdir -p $REMOTE_DIR/sessions $REMOTE_DIR/logs" 2>/dev/null

# 1. 同步会话文件
if [ -d "$OPENCLAW_DIR/agents/main/sessions" ]; then
  rsync -az --timeout=10 \
    "$OPENCLAW_DIR/agents/main/sessions/" \
    "$REMOTE:$REMOTE_DIR/sessions/"
  echo "sessions synced"
fi

# 2. 同步 user-chats.json
if [ -f "$OPENCLAW_DIR/agents/main/user-chats.json" ]; then
  rsync -az --timeout=10 \
    "$OPENCLAW_DIR/agents/main/user-chats.json" \
    "$REMOTE:$REMOTE_DIR/user-chats.json"
  echo "user-chats synced"
fi

# 3. 同步日志文件（只同步当天和昨天的）
for logdir in /tmp/openclaw-*/; do
  [ -d "$logdir" ] || continue
  today=$(date '+%Y-%m-%d')
  yesterday=$(date -v-1d '+%Y-%m-%d' 2>/dev/null || date -d 'yesterday' '+%Y-%m-%d')
  for f in "$logdir"openclaw-"$today".log "$logdir"openclaw-"$yesterday".log; do
    [ -f "$f" ] || continue
    fname=$(basename "$f")
    rsync -az --timeout=10 "$f" "$REMOTE:$REMOTE_DIR/logs/$fname"
  done
  echo "logs synced from $logdir"
done

# 4. 预生成 usage-cost JSON
if [ -x "$OPENCLAW_BIN" ]; then
  TOKEN_ARG=""
  [ -n "$GATEWAY_TOKEN" ] && TOKEN_ARG="--token $GATEWAY_TOKEN"
  
  "$OPENCLAW_BIN" gateway usage-cost --days 30 --json $TOKEN_ARG 2>/dev/null \
    > /tmp/jax-usage-cost.json && \
    rsync -az --timeout=10 /tmp/jax-usage-cost.json "$REMOTE:$REMOTE_DIR/usage-cost.json"
  echo "usage-cost synced"

  # 5. 预生成 cron list JSON
  "$OPENCLAW_BIN" cron list --json $TOKEN_ARG 2>/dev/null \
    > /tmp/jax-cron-list.json && \
    rsync -az --timeout=10 /tmp/jax-cron-list.json "$REMOTE:$REMOTE_DIR/cron-list.json"
  echo "cron-list synced"
fi

echo "=== sync done ==="
