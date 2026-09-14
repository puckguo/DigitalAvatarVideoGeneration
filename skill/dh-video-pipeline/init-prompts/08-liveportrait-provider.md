# 08 · LivePortrait 本地数字人 Provider（可选，与 HeyGen 并列）

> 目标：Step5 支持 `avatarProvider: heygen | liveportrait` 双方案——云端 HeyGen（音频驱动口型、耗 credit）或本地 LivePortrait（源人像+驱动视频+ffmpeg 混音、免费、需 GPU）。

## 要求

### `server/liveportrait.js`（与 heygen_mcp.js 平行，互不干扰）
- 路径：`LivePortrait/` 仓库（不入库）+ `pretrained_weights/`（8 个关键文件）。
- **中文路径坑（Windows）**：OpenCV(Python) 读含中文的路径 imread 返回 None → 创建项目根的目录接合点 `C:\lp_runtime`（`fs.symlinkSync(ROOT, junction, 'junction')`，失败则降级原路径并记日志），所有传给 python 的路径走 junction。
- `runAvatar({source, driving, audio, width, height, fps})`：`python inference.py -s <源人像> -d <驱动视频>` → 生成画面 → ffmpeg 把 TTS wav mux 进 mp4（`-c:v copy` 优先，尺寸/FPS 对齐 HeyGen 路径，保证 Step7/8 无感切换）。
- **无进度回调**：轮询输出 mp4 文件大小变化估算进度，写 `logs/liveportrait_progress.txt`。
- 辅助：`checkReady/readySummary`（repo/推理脚本/权重清单，缺失列出）、`checkPythonDeps`、`listBuiltInDrivings`（LivePortrait 内置驱动如 `talking.pkl`）。
- ⚠️ **明确限制**：LivePortrait 是「视频驱动表情动作」，**不做音频口型同步**（要口型需再接 SadTalker/Musetalk，当前不内置）——UI/文档必须如实标注。

### 流水线接入
- 参数：`avatarProvider`（默认 heygen）、`lpSource`（源人像，如 `resources/photo1.jpg` 或 materials/）、`lpDriving`（驱动视频，内置 talking.pkl 或上传 mp4）；liveportrait 模式两者必填（normalizeParams 校验）。
- Step5 分支：provider=liveportrait → `liveportrait.runAvatar(...)`，产物同样落 `output/03_heygen_raw.mp4`；meta 标 `provider:'liveportrait'`。
- 环境检查：新增**可选**项 `liveportrait`（权重缺失时 fix 指向 `scripts/install-liveportrait.ps1`）。

### 前端
「③ 数字人」卡片：Provider 下拉（HeyGen 云端 / LivePortrait 本地）+ 切换显示各自的参数区（liveportraitBox：源人像路径 + 驱动视频选择（拉 `/api/liveportrait/driving` 内置列表））；环境检查页 LivePortrait 项附「查看缺失权重」。

### `scripts/install-liveportrait.ps1`（一键安装，入库）
clone LivePortrait → 建 venv → 装依赖 → `huggingface-cli download KlingTeam/LivePortrait --local-dir pretrained_weights --exclude "*.git*" "README.md" "docs"`。

### 验收标准
- provider=heygen 时行为与 02 完全一致（回归）。
- provider=liveportrait：权重就绪时产出带配音的 mp4 且时长≈音频；未安装时环境检查仅**可选警告**，不阻塞 HeyGen 路径。

## 已知坑
- junction 需要权限，失败要降级而不是崩。
- LivePortrait 目录 709MB+权重：`.gitignore` 只放行 `server/liveportrait.js` 与 `scripts/install-liveportrait.ps1`，仓库本体/`scripts/_*.js` 实验/`lp_api.json` 全部忽略。
