@echo off
chcp 65001 >nul
title 数字人视频流水线控制台
cd /d "%~dp0"

echo ============================================================
echo    数字人视频流水线 - 一键启动
echo    Puck Agent (主) / Codex (fallback) - MiniMax TTS - HeyGen - Remotion - FFmpeg
echo ============================================================
echo.

echo [1/2] 环境校验（缺少依赖将直接报错退出，不会启动流水线）...
node scripts\check-env.js --autofix
if errorlevel 1 (
  echo.
  echo [FAIL] 环境校验未通过，请按上方提示安装缺失依赖后重新运行本脚本。
  pause
  exit /b 1
)

echo.
echo [2/2] 启动控制台服务（保持本窗口开启，Ctrl+C 退出）...
timeout /t 1 /nobreak >nul
start "" http://127.0.0.1:7788
node server\index.js
pause
