#!/usr/bin/env bash
# 修复 stringzilla 构建失败：insightface 拉最新 albumentations → albucore → stringzilla（需 C 编译器）
# 方案：先锁 albumentations==1.3.1（无 albucore 依赖），再装其余 requirements
cd "$(dirname "$0")/../LatentSync" || exit 1
PY=venv/Scripts/python.exe
echo "[1/2 $(date +%T)] 锁 albumentations 1.3.1 + 补装关键包..."
"$PY" -m pip install "albumentations==1.3.1" -i https://pypi.tuna.tsinghua.edu.cn/simple --progress-bar off --proxy http://127.0.0.1:7890 || exit 1
echo "[2/2 $(date +%T)] 继续装 requirements（pip 对已装包不降级，albumentations 保持 1.3.1）..."
"$PY" -m pip install -r requirements.txt \
  --extra-index-url https://download.pytorch.org/whl/cu121 \
  -i https://pypi.tuna.tsinghua.edu.cn/simple --proxy http://127.0.0.1:7890 --progress-bar off \
  && echo "[req OK]" || { echo "[req FAIL]"; exit 1; }
"$PY" -c "import torch,diffusers,transformers,librosa,decord,insightface; print('VERIFIED torch',torch.__version__,'cuda',torch.cuda.is_available(),torch.cuda.get_device_name(0))"
echo "[ALL DONE]"
