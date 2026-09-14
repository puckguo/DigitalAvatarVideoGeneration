#!/usr/bin/env bash
# 重新打包 skill 脚手架：把 git HEAD 的项目文件导出到 skill/dh-video-pipeline/scaffold/
# 项目代码更新后运行一次，保持 skill 与项目同步。
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/skill/dh-video-pipeline/scaffold"
rm -rf "$OUT"
mkdir -p "$OUT"
git -C "$ROOT" archive HEAD | tar -x -C "$OUT"
echo "已导出 $(find "$OUT" -type f | wc -l) 个文件 → ${OUT#"$ROOT"/}"
