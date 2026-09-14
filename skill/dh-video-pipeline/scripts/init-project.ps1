# 初始化部署（Windows PowerShell）
# 用法: powershell -ExecutionPolicy Bypass -File init-project.ps1 [-Target 目录]
param([string]$Target = ".\dh-pipeline-project")
$ErrorActionPreference = "Stop"
$SkillDir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "=========================================="
Write-Host "  数字人视频流水线 · 初始化部署"
Write-Host "=========================================="
New-Item -ItemType Directory -Force -Path $Target | Out-Null
Copy-Item -Path "$SkillDir\scaffold\*" -Destination $Target -Recurse -Force
Push-Location $Target

foreach ($d in @("output\archive","logs","materials\voice","materials\photo","materials\image",
                 "materials\audio","materials\video","materials\doc","materials\other",
                 "resources","secrets","remotion\public")) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}
if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env"; Write-Host "已生成 .env（请填写密钥）" }

Write-Host "`n[1/3] 安装 Remotion 依赖（含 undici 代理支持）..."
Push-Location remotion; npm install --no-audit --no-fund; Pop-Location

Write-Host "`n[2/3] 环境校验（外部依赖缺失会列出安装指引）..."
try { node scripts\check-env.js --autofix } catch { Write-Host "（存在缺失依赖：请按上方提示安装后重跑 start.bat）" }

Write-Host "`n[3/3] 完成 ✅  目录: $Target"
Write-Host "下一步：`n  1. 编辑 .env（MiniMax 密钥 / HEYGEN_PROXY / HeyGen 默认 Avatar 等）`n  2. mmx auth login --api-key <密钥>   # 或写入 .env MINIMAX_API_KEY`n  3. 双击 start.bat → 控制台「环境检查」页点「连接 HeyGen」完成 OAuth"
Pop-Location
