# LivePortrait 本地部署脚本（Windows PowerShell）
# 用途：安装 LivePortrait 的 Python 依赖（GPU 版 torch + onnxruntime-gpu）+ 下载预训练权重（huggingface）
# 用法：在项目根目录下执行
#   powershell -ExecutionPolicy Bypass -File scripts\install-liveportrait.ps1
# 可选参数：
#   -Python "C:\path\to\python.exe"  指定 Python 解释器（默认 Python 3.11 winget 路径）
#   -Mirror "hf-mirror.com"            HuggingFace 镜像（默认 hf-mirror.com）
#   -SkipPip                            跳过 pip install（已装好）
#   -SkipDownload                       跳过权重下载（已下载好）

param(
    [string]$Python = "C:\Users\Administrator\AppData\Local\Programs\Python\Python311\python.exe",
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
if (-not (Test-Path $Python)) {
    Log "ERROR: 未找到 Python at $Python（先装 Python 3.11：winget install --id Python.Python.3.11 --scope user，或通过 -Python 指定其他路径）"
    exit 1
}
Log "使用 Python: $Python"
& $Python --version

# 网络可达性自检（避免无效等待）
Log "检查 HuggingFace 镜像连通性 ($Mirror)..."
$hf = $false
$resp = Invoke-WebRequest -Uri "https://$Mirror/KlingTeam/LivePortrait" -UseBasicParsing -TimeoutSec 15 -ErrorAction SilentlyContinue
if ($resp -and $resp.StatusCode -eq 200) { $hf = $true }
if (-not $hf) {
    Log "WARN: 无法直连 $Mirror，尝试代理（HEYGEN_PROXY 路径）..."
    $envLine = (Get-Content (Join-Path $root ".env") -ErrorAction SilentlyContinue | Where-Object { $_ -match '^HEYGEN_PROXY=' } | Select-Object -First 1)
    if ($envLine) {
        $env:HTTPS_PROXY = ($envLine -split '=', 2)[1].Trim()
        Log "已设置 HTTPS_PROXY=$env:HTTPS_PROXY"
    } else {
        Log "ERROR: 无法访问 $Mirror，请在 .env 配置 HEYGEN_PROXY 或检查网络"; exit 1
    }
}

# Step 1: pip install
if (-not $SkipPip) {
    Log "=== Step 1: pip install LivePortrait 依赖 ==="
    Push-Location $lpDir
    & $Python -m pip install -U pip | Out-Null

    # 1a) GPU 版 torch（cu121 兼容 CUDA 12.x / 驱动 ≥535；与你机器的 CUDA 13.2 兼容）
    Log "--- 1a) torch==2.5.0+cu121 ---"
    & $Python -m pip install torch==2.5.0 torchvision==0.20.0 torchaudio==2.5.0 --index-url https://download.pytorch.org/whl/cu121
    if ($LASTEXITCODE -ne 0) {
        Log "WARN: torch GPU 装失败（常见原因：Smart App Control 未关 → 控制面板 → Windows 安全中心 → 应用和浏览器控制 → 关闭 SAC）"
    }

    # 1b) GPU 版 onnxruntime
    Log "--- 1b) onnxruntime-gpu ---"
    & $Python -m pip uninstall -y onnxruntime | Out-Null
    & $Python -m pip install onnxruntime-gpu
    if ($LASTEXITCODE -ne 0) { Log "WARN: onnxruntime-gpu 装失败（可改 CPU 版）" }

    # 1c) LivePortrait 其他依赖（albumentations 锁 1.3.1 以避免拉 stringzilla 需 C 编译）
    Log "--- 1c) LivePortrait 剩余依赖 ---"
    & $Python -m pip install numpy opencv-python pyyaml scipy imageio imageio-ffmpeg tqdm rich tyro pillow ffmpeg-python scikit-image matplotlib pykalman insightface lmdb av transformers==4.38.0 albumentations==1.3.1
    if ($LASTEXITCODE -ne 0) {
        Log "WARN: 部分依赖装失败（详细见上方日志）。常见原因：SAC 未关 / 网络问题 / 缺 C 编译器"
    }
    Pop-Location
}

# Step 2: 下载预训练权重（与 pip 独立；可用 -SkipDownload 跳过）
if (-not $SkipDownload) {
    Log "=== Step 2: 下载预训练权重（HF 镜像 $Mirror）==="
    $env:HF_ENDPOINT = "https://$Mirror"
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
& $Python -c "import torch, cv2, numpy, tyro; import onnxruntime; print('OK', torch.__version__, 'cuda:', torch.cuda.is_available(), 'ort:', onnxruntime.__version__)"
$probeCode = $LASTEXITCODE
if ($probeCode -ne 0) {
    Log "WARN: 探测失败（Python 依赖未就绪），常见原因：SAC 未关 / torch 装失败 / 路径不对"
    Log "      重新跑本脚本（已装的会跳过），或重装 Python 3.11 + 关 SAC"
} else {
    Log "✅ LivePortrait 就绪：python=$Python，权重 $lpDir\pretrained_weights"
}

# Step 4: 写 .env
$envFile = Join-Path $root ".env"
if (Test-Path $envFile) {
    $content = Get-Content $envFile -Raw
    if ($content -notmatch '^LIVEPORTRAIT_PYTHON=') {
        Add-Content -Path $envFile -Value "`nLIVEPORTRAIT_PYTHON=$Python"
        Log "已追加 LIVEPORTRAIT_PYTHON 到 .env"
    } else {
        Log ".env 已含 LIVEPORTRAIT_PYTHON，跳过"
    }
}

Log "=== 完成 ==="
Log "下一步：重启控制台 → 「环境检查」页应显示 LivePortrait: ✅；第一次跑 Step3 GPU 推理约 30s"