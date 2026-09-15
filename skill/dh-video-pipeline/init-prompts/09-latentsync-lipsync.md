# 09 · LatentSync 1.5 本地口型同步（可选，与 HeyGen/LivePortrait 并列）

> 目标：`avatarProvider=latentsync`（驱动视频+TTS 直连对口型）+ `lpLipSync`（LivePortrait 画面 → LatentSync 串联，照片数字人全本地链路）。VRAM ≥8GB。

## 部署（scripts/install-latentsync.ps1 一键 / 分步 sh）

1. **代码锁定 1.5**：`git clone bytedance/LatentSync && git checkout 7b380d6`（1.5 最终 commit）。⚠️ 1.5/1.6 UNet 架构不同（1.5=stage2.yaml 256 分辨率 + whisper tiny 384 维；1.6=stage2_512 + small 768 维），**代码与权重必须配对**，main 分支是 1.6！16GB 显卡选 1.5（1.6 需 18GB）。
2. **venv**（Python 3.11，勿与 LivePortrait 全局环境混）：torch 2.5.1+cu121（走代理 download.pytorch.org ~3MB/s）+ requirements（清华源）。
3. **权重**：hf-mirror 直链断点续传（unet ~4.7GB + whisper tiny）：`curl -C - https://hf-mirror.com/ByteDance/LatentSync-1.5/resolve/main/latentsync_unet.pt`。
4. **推理另需** `stabilityai/sd-vae-ft-mse`（~335MB，首次自动下载，子进程设 `HF_ENDPOINT=https://hf-mirror.com`）。

## 集成（server/latentsync.js，仿 liveportrait.js）

- `runLipsync({video,audio,outPath,width,height,inferenceSteps=20,guidanceScale=1.5})`：拷输入到 junction 侧 `inputs/lipsync/` → `python -m scripts.inference --unet_config_path configs/unet/stage2.yaml --inference_ckpt_path checkpoints/latentsync_unet.pt ...`（cwd=LatentSync，**参数全相对路径**）→ 输出缩放到目标分辨率。
- `readySummary()`（repo/venv/unet>1e9/whisper）+ `checkPythonDeps()`；API：`/api/latentsync/status|videos`；envcheck 可选项；前端 provider 下拉 + `lpLipSync` 复选（参数区共用 lsSteps/lsGuidance）。
- pipeline：Step5 分派三路；串联模式给 `liveportrait.runAvatar` 加 `noMux:true`（只出画面）→ `latentsync.runLipsync(r.lpOutput, audio)` → 覆盖 03；meta.provider=`latentsync` / `liveportrait+latentsync`。

## 实战坑（全部踩过，按频次排序）

0. **口型完全对不上的三大根因（2025-09 实战诊断，均已固化修复）**：
   - **帧率漂移**：推理端 `read_video(change_fps=False)` 不重采样，音频-视频窗口按 25fps 对齐；喂 30fps 手机视频/29fps LP 产物 → 每秒漂 20%，片尾错位数秒。修复：输入统一 `ffmpeg -r 25` 重采样。
   - **guidance 太低**：默认 1.5 时口型跟随弱（有声/无声嘴部开合效应量 d≈0.2）；提到 3.0 后 d≈0.49~0.64（官方 demo 基线仅 0.21），抖动可控。默认已改 3.0。
   - **人脸占比小**：横版半身/全身视频里脸小，LatentSync 在 256×256 人脸区生成口型后贴回，嘴动视觉幅度被缩小一半。修复：`scripts/face_crop.py`（LivePortrait insightface buffalo_l 检测中间帧）自动裁到脸高 2.6 倍近景正方形，失败降级整画面。
   - 客观诊断方法：mediapipe MAR（嘴部开合）vs 音频 RMS 的 VAD 效应量（有声/无声段均值差/std），比 Pearson 相关鲁棒。⚠️ mediapipe 在中文 site-packages 路径下 C++ 层读不到模型（os.path.exists=True 但报 not found），需拷到 ASCII 路径 + PYTHONPATH。

1. **execChild 曾不支持自定义 env**：PYTHONUTF8/PYTHONIOENCODING/HF_ENDPOINT/PATH 全被丢弃 → Python 在 cp1252 控制台 print 中文直接 `UnicodeEncodeError` 崩。utils.execChild 已加 `opts.env`（合并 getEnv()）。
2. **junction 与相对路径**：`path.relative(junction路径, 真实路径)` 返回**绝对路径**（含中文项目名）→ 同样炸 cp1252。所有输入/输出必须直接放在 junction 目录树下用相对路径。
3. **venv 里找不到 ffmpeg**：LatentSync 内部用 ffmpeg-python 写输出，需在子进程 PATH 前置 .env FFMPEG_PATH 的 bin 目录。
4. **outputs/ 目录不存在**：LatentSync 不自建输出目录，ffmpeg 报 `Error opening output files`，调用前 mkdir。
5. **stringzilla 构建失败**：insightface→最新 albumentations→albucore→stringzilla 需 C 编译器。先 `pip install albumentations==1.3.1` 再装 requirements（pip 不降级已装包）。
6. **pip 直连慢**：download.pytorch.org 直连可能 <500KB/s，走 Clash 代理可达 3MB/s（pip `--proxy` 参数）。
7. **venv 建错位置**：`python -m venv venv` 必须先 `cd LatentSync`（曾误建项目根）。

## 验收标准

- 官方 demo：demo1_video+demo1_audio → 1080×1920/25fps/h264+aac 出片。
- 端到端：audio 模式出 01/02 → retry Step5（provider=latentsync + 素材驱动视频）→ 03 时长≈TTS、meta.provider=latentsync → 06 成品。
- 未安装时 envcheck 仅可选警告，不阻塞 HeyGen/LivePortrait 路径。
