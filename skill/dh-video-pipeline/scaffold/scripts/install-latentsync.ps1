# LatentSync 1.5 一键安装（Windows PowerShell）
# 用途：克隆 LatentSync 代码（锁定 1.5）+ 建 venv + 装依赖 + 下载权重
# 前置：NVIDIA GPU（推理需约 8GB 显存）、Python 3.11、git、可访问 hf-mirror.com
#       （如需代理下载 torch：环境变量 HTTPS_PROXY=http://127.0.0.1:7890 后再运行本脚本）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\install-latentsync.ps1
param(
    [string]$Python = "C:\Users\Administrator\AppData\Local\Programs\Python\Python311\python.exe",
    [string]$Proxy = $env:HTTPS_PROXY,   # 如 http://127.0.0.1:7890；留空则直连
    [string]$Mirror = "https://hf-mirror.com"
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
function Log($m) { Write-Host "[LatentSync] $m" -ForegroundColor Cyan }

# 1) 克隆代码并锁定 1.5 最终 commit（1.5/1.6 UNet 架构不同，代码与权重必须配对！）
if (-not (Test-Path "LatentSync")) {
    Log "克隆 ByteDance/LatentSync ..."
    git clone https://github.com/bytedance/LatentSync.git
}
Set-Location LatentSync
git fetch -q origin 7b380d6adde7aa23cba4a53bb15cd5cfb3c168e7 2>$null
git checkout -q 7b380d6adde7aa23cba4a53bb15cd5cfb3c168e7
Log "代码已锁定 1.5（commit 7b380d6，configs/unet/stage2.yaml）"

# 2) venv
if (-not (Test-Path "venv\Scripts\python.exe")) {
    Log "创建 venv（$Python）..."
    & $Python -m venv venv
}
$Py = "$PWD\venv\Scripts\python.exe"

# 3) 依赖：torch cu121（大件，走代理可选）+ requirements（清华源加速）
$proxyArgs = @(); if ($Proxy) { $proxyArgs = @("--proxy", $Proxy) }
Log "安装 torch 2.5.1+cu121（约 2.4GB，耐心等待）..."
& $Py -m pip install torch==2.5.1 torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu121 @proxyArgs --progress-bar off
Log "安装 requirements.txt（清华源）..."
& $Py -m pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cu121 -i https://pypi.tuna.tsinghua.edu.cn/simple @proxyArgs --progress-bar off

# 4) 权重（hf-mirror 直链，断点续传；共约 4.8GB）
New-Item -ItemType Directory -Force -Path "checkpoints\whisper" | Out-Null
$files = @(
    @{ url = "$Mirror/ByteDance/LatentSync-1.5/resolve/main/latentsync_unet.pt"; out = "checkpoints\latentsync_unet.pt" },
    @{ url = "$Mirror/ByteDance/LatentSync-1.5/resolve/main/whisper/tiny.pt";    out = "checkpoints\whisper\tiny.pt" }
)
foreach ($f in $files) {
    if ((Test-Path $f.out) -and (Get-Item $f.out).Length -gt 1mb) { Log "已存在 $($f.out)"; continue }
    Log "下载 $($f.out) ..."
    & curl.exe -sL -C - -o $f.out $f.url
}

# 5) 验证
& $Py -c "import torch; print('torch', torch.__version__, '| cuda:', torch.cuda.is_available())"
Log "✅ 安装完成。首次推理会自动经 $Mirror 下载 sd-vae-ft-mse（~335MB）"
Log "   集成：控制台「③ 数字人」provider 选 LatentSync（直连）或 LivePortrait + 勾选口型同步（串联）"
