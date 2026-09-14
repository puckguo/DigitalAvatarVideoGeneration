#!/usr/bin/env bash
# LatentSync 1.5 权重下载（hf-mirror，断点续传）
cd "$(dirname "$0")/.." || exit 1   # 项目根
cd LatentSync || exit 1
echo "[start $(date +%T)] latentsync_unet.pt"
curl -sL -C - -o checkpoints/latentsync_unet.pt "https://hf-mirror.com/ByteDance/LatentSync-1.5/resolve/main/latentsync_unet.pt" && echo "[done $(date +%T)] unet"
echo "[start $(date +%T)] whisper/tiny.pt"
curl -sL -C - -o checkpoints/whisper/tiny.pt "https://hf-mirror.com/ByteDance/LatentSync-1.5/resolve/main/whisper/tiny.pt" && echo "[done $(date +%T)] whisper"
echo "[ALL DONE]"
