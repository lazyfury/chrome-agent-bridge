#!/bin/bash
# 启动 Agent Bridge 本地服务端(幂等)
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${BRIDGE_PORT:-9333}"
LOG="/tmp/chrome-agent-bridge.log"

# 已在运行则复用
if curl -s --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || lsof -i :"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✅ Agent Bridge server 已在运行 (127.0.0.1:${PORT})"
  exit 0
fi

[ -d node_modules ] || { echo "📦 安装依赖..."; npm install --registry https://registry.npmmirror.com; }

nohup node server/bridge-server.mjs > "$LOG" 2>&1 &
disown
sleep 1
if lsof -i :"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✅ Agent Bridge server 已启动: ws://127.0.0.1:${PORT} (日志: $LOG)"
else
  echo "❌ 启动失败,查看日志: $LOG" >&2
  exit 1
fi
