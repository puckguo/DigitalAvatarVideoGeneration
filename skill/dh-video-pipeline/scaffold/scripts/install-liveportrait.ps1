# LivePortrait 本地部署脚本（Windows PowerShell）
# 用途：安装 LivePortrait 的 Python 依赖（推荐 conda）+ 下载预训练权重（huggingface）
# 用法：在项目根目录下执行
#   powershell -ExecutionPolicy Bypass -File scripts\install-liveportrait.ps1
# 可选参数：
#   -Python "C:\path\to\python.exe"    指定 Python 解释器（推荐 conda 3.10）
#   -Mirror "hf-mirror.com"             HuggingFace 镜像（默认 hf-mirror.com）
#   -SkipPip                             跳过 pip install（已装好）
#   -SkipDownload                        跳过权重下载（已下载好）

param(
    [string]$Python = "",
    [string]$Mirror = "hf-mirror.com",
    [switch]$SkipPip = $false,
    [switch]$SkipDownload = $false
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$lpDir = Join-Path $root "LivePortrait"
$logFile = Join-Path $root "logs\lp_install.log"
New-Item -ItemType Directory -Force -Path (Join-Path $root "logs") | Out-Null
"" | Out-File $logFile -Encoding utf8

function Log($msg) {
    $line = "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')] $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

if (-not (Test-Path $lpDir)) {
    Log "ERROR: LivePortrait/ 目录不存在，请先 git clone https://github.com/KlingTeam/LivePortrait"
    exit 1
}

# 选 Python
if ([string]::IsNullOrEmpty($Python)) {
    $Python = (Get-Command python -ErrorAction SilentlyContinue).Source
    if (-not $Python) { Log "ERROR: 未找到 python，请先安装 Python 或通过 -Python 指定路径"; exit 1 }
}
Log "使用 Python: $Python"
& $Python --version

# 网络可达性自检（避免无效等待）
Log "检查 HuggingFace 镜像连通性 ($Mirror)..."
$hf = $false
try {
    $resp = Invoke-WebRequest -Uri "https://$Mirror/KlingTeam/LivePortrait" -UseBasicParsing -TimeoutSec 15
    if ($resp.StatusCode -eq 200) { $hf = $true }
} catch {}
if (-not $hf) {
    Log "WARN: 无法直连 $Mirror，尝试代理（HEYGEN_PROXY 路径）..."
    $env:HTTPS_PROXY = (Get-Content (Join-Path $root ".env") -ErrorAction SilentlyContinue | Where-Object { $_ -match '^HEYGEN_PROXY=' } | ForEach-Object { ($_ -split '=', 2)[1] })
    if ($env:HTTPS_PROXY) {
        Log "已设置 HTTPS_PROXY=$env:HTTPS_PROXY"
    } else {
        Log "ERROR: 无法访问 $Mirror，请在 .env 配置 HEYGEN_PROXY 或检查网络"; exit 1
    }
}

# Step 1: pip install（建议在 conda LivePortrait 环境中）
if (-not $SkipPip) {
    Log "=== Step 1: pip install LivePortrait 依赖（requirements.txt）==="
    Push-Location $lpDir
    & $Python -m pip install -U pip | Out-Null
    # requirements.txt 包含 -r requirements_base.txt
    & $Python -m pip install -r requirements.txt
    $pipCode = $LASTEXITCODE
    Pop-Location
    if ($pipCode -ne 0) {
        Log "WARN: pip install 退出码 $pipCode（Python 版本不兼容时常见，可换 Python 3.10 conda 环境后重试）"
        Log "       建议：conda create -n LivePortrait python=3.10 -y && conda activate LivePortrait && cd LivePortrait && pip install -r requirements.txt"
        Log "       然后在 .env 配置 LIVEPORTRAIT_PYTHON=C:\path\to\envs\LivePortrait\python.exe"
    }
}

# Step 2: 下载预训练权重
if (-not $SkipDownload) {
    Log "=== Step 2: 下载预训练权重（HF 镜像 $Mirror）==="
    $env:HF_ENDPOINT = "https://$Mirror"
    # 直接用 python -m huggingface_hub.command.huggingface_cli 避免 cli 入口缺失
    Push-Location $lpDir
    & $Python -m pip install -U "huggingface_hub[cli]" | Out-Null
    & $Python -m huggingface_hub.commands.huggingface_cli download KlingTeam/LivePortrait --local-dir pretrained_weights --exclude "*.git*" "README.md" "docs"
    $dlCode = $LASTEXITCODE
    Pop-Location
    if ($dlCode -ne 0) {
        Log "ERROR: 权重下载失败（退出码 $dlCode），请检查网络 / 代理"; exit 1
    }
}

# Step 3: 探测
Log "=== Step 3: 依赖探测 ==="
& $Python -c "import torch, cv2, numpy, tyro; import onnxruntime; print('OK', torch.__version__, onnxruntime.__version__)"
$probeCode = $LASTEXITCODE
if ($probeCode -ne 0) {
    Log "WARN: 探测失败（Python 依赖未就绪，权重已下载），可在「环境检查」页点 🔧 自动修复"
    Log "      或手动：conda create -n LivePortrait python=3.10 -y && conda activate LivePortrait"
    Log "              && cd LivePortrait && pip install -r requirements.txt"
    Log "      然后在 .env 配置 LIVEPORTRAIT_PYTHON 指向该 Python"
} else {
    Log "✅ LivePortrait 就绪：python=$Python，权重 $lpDir\pretrained_weights"
}

Log "=== 完成 ==="
Log "下一步：控制台「环境检查」页应显示 LivePortrait: ✅；如未识别，重启控制台刷新环境"
