#!/usr/bin/env bash
# 数字人视频流水线 · 一键启动（macOS / Linux）
cd "$(dirname "$0")"

echo "============================================================"
echo "  数字人视频流水线 - 一键启动"
echo "  Codex -> MiniMax TTS -> HeyGen -> Remotion -> FFmpeg"
echo "============================================================"

echo "[1/2] 环境校验（缺少依赖将直接报错退出）..."
node scripts/check-env.js --autofix
if [ $? -ne 0 ]; then
  echo "[FAIL] 环境校验未通过，请按上方提示安装缺失依赖后重试。"
  exit 1
fi

echo "[2/2] 启动控制台服务（Ctrl+C 退出）..."
( sleep 1; open http://127.0.0.1:7788 2>/dev/null || xdg-open http://127.0.0.1:7788 >/dev/null 2>&1 ) &
node server/index.js
