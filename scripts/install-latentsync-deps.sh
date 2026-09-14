#!/usr/bin/env bash
# LatentSync venv 依赖安装（torch cu121 走代理 + requirements 走清华源）
cd "$(dirname "$0")/../LatentSync" || exit 1   # LatentSync/
PY=venv/Scripts/python.exe
PROXY=http://127.0.0.1:7890

echo "[1/3 $(date +%T)] torch 2.5.1+cu121（走代理）..."
"$PY" -m pip install torch==2.5.1 torchvision==0.20.1 \
  --index-url https://download.pytorch.org/whl/cu121 --proxy $PROXY --progress-bar off \
  && echo "[torch OK]" || { echo "[torch FAIL]"; exit 1; }

echo "[2/3 $(date +%T)] requirements.txt（清华源）..."
"$PY" -m pip install -r requirements.txt \
  --extra-index-url https://download.pytorch.org/whl/cu121 \
  -i https://pypi.tuna.tsinghua.edu.cn/simple --proxy $PROXY --progress-bar off \
  && echo "[req OK]" || { echo "[req FAIL]"; exit 1; }

echo "[3/3 $(date +%T)] 验证..."
"$PY" -c "import torch,diffusers,transformers,librosa,decord,insightface; print('VERIFIED torch',torch.__version__,'cuda',torch.cuda.is_available(),torch.cuda.get_device_name(0))"
echo "[ALL DONE]"
