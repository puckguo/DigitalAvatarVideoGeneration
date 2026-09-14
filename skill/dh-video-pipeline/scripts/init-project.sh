#!/usr/bin/env bash
# 初始化部署：将 skill 内的 scaffold 完整部署到目标目录并完成基础安装
# 用法: bash init-project.sh [目标目录]   （默认 ./dh-pipeline-project）
set -e
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-./dh-pipeline-project}"

echo "=========================================="
echo "  数字人视频流水线 · 初始化部署"
echo "=========================================="
mkdir -p "$TARGET"
cp -r "$SKILL_DIR/scaffold/." "$TARGET/"
cd "$TARGET"

# 运行时目录
mkdir -p output/archive logs materials/voice materials/photo materials/image \
         materials/audio materials/video materials/doc materials/other \
         resources secrets remotion/public
touch output/.gitkeep logs/.gitkeep

# 本地配置
if [ ! -f .env ]; then cp .env.example .env; echo "已生成 .env（请填写密钥）"; fi

echo ""
echo "[1/3] 安装 Remotion 依赖（含 undici 代理支持）..."
( cd remotion && npm install --no-audit --no-fund )

echo ""
echo "[2/3] 环境校验（外部依赖缺失会列出安装指引）..."
node scripts/check-env.js --autofix || echo "（存在缺失依赖：请按上方提示安装后重跑 start 脚本）"

echo ""
echo "[3/3] 完成 ✅  目录: $(pwd)"
echo "下一步："
echo "  1. 编辑 .env（MiniMax 密钥 / HEYGEN_PROXY / HeyGen 默认 Avatar 等）"
echo "  2. mmx auth login --api-key <密钥>   # 或写入 .env MINIMAX_API_KEY"
echo "  3. ./start.sh  → 控制台「环境检查」页点「连接 HeyGen」完成 OAuth"
