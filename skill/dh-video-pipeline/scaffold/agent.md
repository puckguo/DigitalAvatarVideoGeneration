# agent.md — 数字人视频流水线 · 项目说明与流程规范

> 本文件是本项目的**总规范文档**。Agent / 开发者 / 使用者在改动本仓库前必须先读完本文件。
> 流水线：**Codex 文案 → MiniMax TTS (mmx-cli) → HeyGen 数字人 (heygen cli) → Codex 字幕分析 → Remotion 本地合成 → FFmpeg 本地输出**

---

## 1. 项目简介

一套**本地运行的数字人短视频生产流水线 + Web 控制台**：

- 用户在 Web 前端填写需求（视频主题、时长、TTS 音色、HeyGen Avatar ID、输出分辨率、画面元素、压缩质量等）；
- 后端严格**串行**执行 6 个步骤，任一步失败立即终止，支持**单步重试/从任意步骤重跑**；
- 所有中间产物与成品统一存放在 `./output/`，运行日志写入 `./logs/pipeline.log`；
- 流程结束后前端主动询问是否清理临时文件（保留最终视频）。

## 2. 目录结构

```
自媒体数字人工作流/
├── agent.md                  ← 本规范文档
├── README.md                 ← 快速上手
├── .env                      ← API 密钥与流水线配置（不入库）
├── .env.example              ← 配置模板
├── start.bat / start.sh      ← 一键启动脚本（内置环境校验，缺依赖直接退出）
├── scripts/
│   ├── check-env.js          ← 环境校验 CLI（--autofix 可自动装 Remotion 依赖）
│   └── install-liveportrait.ps1 ← LivePortrait 一键安装（Python 依赖 + 预训练权重）
├── server/                   ← 控制台服务（纯 Node 内置模块，无第三方依赖）
│   ├── index.js              ← HTTP 服务：API + 静态前端 + 文件流/上传 + HeyGen OAuth 回调
│   ├── pipeline.js           ← 流水线执行器（9 步串行、状态机、重试、清理）
│   ├── heygen_mcp.js         ← HeyGen Remote MCP 客户端（OAuth+PKCE / 代理 / 工具调用）
│   ├── liveportrait.js       ← LivePortrait 本地推理客户端（子进程调 inference.py + ffmpeg mux）
│   ├── envcheck.js           ← 环境校验逻辑（与 check-env.js 共用）
│   └── utils.js              ← .env 解析、子进程、ffprobe、SRT 解析、日志
├── web/                      ← 前端（原生 HTML/JS/CSS，无构建）
│   ├── index.html / app.js / style.css
├── remotion/                 ← Step5 合成渲染子项目（需 npm install）
│   ├── render.mjs            ← 程序化渲染入口（bundler + renderer API）
│   ├── smoke-test.mjs        ← 安装自检（渲染 30 帧测试片）
│   ├── src/index.js          ← Composition 注册（分辨率/时长由 props 动态决定）
│   ├── src/Video.jsx         ← 数字人合成画面（视频+字幕+标题+水印+进度条）
│   └── public/               ← 运行时存放拷贝进来的 HeyGen 原始视频
├── LivePortrait/             ← 集成在本地仓库里的开源数字人推理引擎（git clone 后免装）
│   ├── inference.py          ← 本地数字人推理入口（被 server/liveportrait.js 调用）
│   ├── pretrained_weights/   ← 预训练权重（HF 下载：liveportrait/* + insightface/*）
│   ├── animations/           ← 推理产物（中间 .mp4 + --looped 拼接版）
│   └── assets/examples/{source,driving}/  ← 示例人像/驱动视频/动作模板
├── output/                   ← 所有步骤产物（01~06，见下表）
│   └── archive/              ← 每次新任务启动时自动归档上一轮产物
├── materials/                ← 素材库（Web「🗃️ 素材库」页分类上传管理）
│   ├── voice/                ← 🎙️ 原始录音（音色克隆源，可在克隆源下拉选用）
│   ├── photo/                ← 🧑 数字人照片参考
│   ├── image/  audio/  video/  doc/  other/   ← 🖼️🎵🎬📄📦 其他分类素材
├── secrets/
│   ├── heygen_mcp_token.json ← HeyGen OAuth 令牌（连接后自动生成，不入库）
│   └── .api_keys.json        ← 密钥集中存放（可选，字段见 .api_keys.example.json）
└── logs/                     ← pipeline.log、state.json、各步骤子进程日志
```

## 3. 快速开始

```bash
# 1) 配置密钥（二选一）
#    a. 编辑 .env（推荐，见 .env.example 注释）
#    b. 或创建 secrets/.api_keys.json（字段：minimax / heygen / openai）

# 2) 一键启动（Windows 双击 start.bat；macOS/Linux 运行 ./start.sh）
start.bat
#    脚本内置：环境校验(--autofix 自动装 remotion 依赖) → 校验失败直接退出
#    → 启动控制台 → 自动打开 http://127.0.0.1:7788

# 3) 手动方式
node scripts/check-env.js --autofix   # 环境校验（退出码 0 才能启动）
node server/index.js                  # 启动控制台（默认 7788 端口）
```

## 4. 环境要求与安装指引

启动脚本会自动校验以下依赖，**任一"必需"项缺失 → 报错并拒绝启动流水线**。其中 LivePortrait 为**可选**数字人 provider，不使用本地推理可忽略；本项目已包含 GitHub 仓库代码，**仅需补充 Python 依赖 + 预训练权重**即可启用。

| 依赖 | 校验命令 | 用途 | 缺失时的安装方法 |
|---|---|---|---|

| 依赖 | 校验命令 | 用途 | 缺失时的安装方法 |
|---|---|---|---|
| Node.js ≥ 18 | `node --version` | 控制台/Remotion 渲染 | https://nodejs.org/ 或 `winget install OpenJS.NodeJS.LTS` |
| .env | 文件存在 | API 密钥读取（核心规则 1） | `copy .env.example .env` 后填写 |
| Codex CLI | `codex --version` | Step1 文案、Step4 字幕 | `npm install -g @openai/codex`，然后 `codex login` |
| MiniMax CLI | `mmx --version` | Step2 TTS | 见下方「三步安装」 |
| MiniMax 登录 | `mmx quota` | 确认密钥生效 | `mmx auth login --api-key <密钥>` |
| HeyGen MCP | 控制台「环境检查」页显示已连接 | Step3 数字人 | 控制台点击「🔗 连接 HeyGen」完成 OAuth（见下方「HeyGen MCP 接入」） |
| FFmpeg/FFprobe | `ffmpeg -version` | Step6 压缩 + 全程媒体校验 | `winget install Gyan.FFmpeg`（或 scoop/choco） |
| Remotion 依赖 | `remotion/node_modules` 存在 | Step5 合成 | 启动脚本 `--autofix` 自动 `npm install` |
| LivePortrait 仓库 | `LivePortrait/inference.py` 存在 | Step3 可选本地数字人 | `git clone https://github.com/KlingTeam/LivePortrait` （仓库已包含） |
| LivePortrait 权重 | `LivePortrait/pretrained_weights/` 8 个关键文件 | 本地推理必需 | `powershell -File scripts\install-liveportrait.ps1` （一键安装 + 下载）；手动：`huggingface-cli download KlingTeam/LivePortrait --local-dir LivePortrait/pretrained_weights --exclude "*.git*" "README.md" "docs"` |
| LivePortrait Python | `python -c "import torch,cv2,tyro,onnxruntime"` | 推理进程 | 推荐 Python 3.10 conda 环境：`conda create -n LivePortrait python=3.10 -y && conda activate LivePortrait && cd LivePortrait && pip install -r requirements.txt`，然后在 .env 配置 `LIVEPORTRAIT_PYTHON=C:\path\to\envs\LivePortrait\python.exe`（详下文 4.x） |

### MiniMax CLI 官方三步安装（来自 https://github.com/MiniMax-AI/cli）

```bash
# ① 全局安装 CLI，完成后用 mmx --version 验证
npm install -g mmx-cli

# ② 登录并配置 API Key（密钥从 ./secrets/.api_keys.json 获取）
mmx auth login --api-key sk-xxxxx

# ③ 安装官方 SKILL
npx skills add MiniMax-AI/cli -y -g

# 配置完成校验：查看 Token 余额确认生效
mmx quota
```

> 也可以不走 `auth login`：在 `.env` 中配置 `MINIMAX_API_KEY`，流水线调用 mmx 时会注入该环境变量。
> Remotion 项目脚手架官方命令为 `npx create-video@latest`；本项目已内置裁剪版合成工程，直接 `cd remotion && npm install` 即可。

### 密钥读取优先级（核心规则 1）

`process.env` → `.env` 文件 → `secrets/.api_keys.json`（仅补充密钥字段）；
HeyGen 走 OAuth，令牌单独存 `secrets/heygen_mcp_token.json`。

### HeyGen MCP 接入（Step3，Windows 替代 CLI 的官方方案）

官方 HeyGen CLI 只支持 macOS/Linux/WSL（Windows 原生 exe 未签名，会被 Smart App Control 拦截），
本项目改用 **HeyGen Remote MCP**（`https://mcp.heygen.com/mcp/v1/`，OAuth 授权、免 API Key、消耗套餐额度）：

1. 启动控制台 → 「环境检查」页 → 点「🔗 连接 HeyGen」（即打开 `http://127.0.0.1:7788/api/heygen/login`）；
2. 浏览器登录 HeyGen 账号并授权（自动完成 DCR 动态注册 + PKCE，回调到本地 7788 端口）；
3. 令牌落盘 `secrets/heygen_mcp_token.json`（含 refresh_token，自动续期）；
4. 「新建任务」页点「👤 浏览数字人」可直接列出账号下的 Avatar 形象并回填 Avatar ID。

网络：mcp.heygen.com / api2.heygen.com 在国内直连受 DNS 污染影响，需代理 —— 在 `.env` 配置
`HEYGEN_PROXY=http://127.0.0.1:7890`（默认已按本机 Clash 预填；请求经 undici ProxyAgent 发出）。
Step3 调用的 MCP 工具：`create_asset_upload`→PUT S3→`complete_asset_upload`→`create_video`（音频驱动口型，
参数按 `tools/list` schema 自适应）→轮询 `get_video`→下载 mp4。工具清单快照存 `logs/heygen_tools.json`。

### LivePortrait 本地数字人接入（Step3 可选 provider）

[LivePortrait](https://github.com/KlingTeam/LivePortrait) (快手/KlingTeam 开源) 是**视频驱动**的人像动画框架：
给定一张源人像 + 一段驱动视频/动作模板，生成源人像照着驱动动作动起来的高质量视频。
本项目把它作为 Step3 **本地**数字人 provider，与 HeyGen（云端）并列，由表单 `avatarProvider` 选择。

**与 HeyGen 的区别：**
- HeyGen 是**音频驱动**（上传 TTS 配音 → 云端对口型 → 出视频），一步到位、不露原片。
- LivePortrait 是**视频驱动**（源人像 + 驱动视频 → 本地推理 → 出静音视频）；本项目额外用 ffmpeg 把 TTS 配音合成到画面上，**不与口型同步**（要口型同步需另接 SadTalker/Musetalk，超出本 pipeline 范围）。

**一、源码与仓库布局**

仓库已 `git clone` 到项目根 `LivePortrait/`（含 `app.py` / `inference.py` / `requirements.txt`）。后续可 `git pull` 更新。
仓库本身是 100% Python + PyTorch；本项目用 `server/liveportrait.js` 调子进程跑 `inference.py`。

**二、依赖安装（Windows）**

推荐 conda 3.10 环境（LivePortrait 的 InsightFace / ONNX runtime 在 3.14 可能不兼容）：

```bash
conda create -n LivePortrait python=3.10 -y
conda activate LivePortrait
cd LivePortrait
pip install -U pip
pip install -r requirements.txt
# .env 里填写解释器路径：
#   LIVEPORTRAIT_PYTHON=C:\Users\Administrator\miniconda3\envs\LivePortrait\python.exe
```

不愿意装 conda 可试用本机 Python 3.14 跑 `pip install -r requirements.txt`（不一定成功，环境检查会给出原始错误）。

**三、预训练权重（必需）**

仓库要求 8 个关键文件在 `LivePortrait/pretrained_weights/`：

```
pretrained_weights
├── insightface/models/buffalo_l/{2d106det.onnx, det_10g.onnx}
└── liveportrait/{base_models/{appearance_feature_extractor,motion_extractor,spade_generator,warping_module}.pth,
                  landmark.onnx,
                  retargeting_models/stitching_retargeting_module.pth}
```

**一键安装脚本**（含 pip 装 + 权重下载，从 hf-mirror.com 镜像，国内可达）：

```bash
powershell -ExecutionPolicy Bypass -File scripts\install-liveportrait.ps1
# 可选参数：-Python "C:\path\to\python.exe" -Mirror "hf-mirror.com" -SkipPip -SkipDownload
```

**手动下载权重：**

```bash
pip install -U "huggingface_hub[cli]"
# 国内镜像（默认）
set HF_ENDPOINT=https://hf-mirror.com
huggingface-cli download KlingTeam/LivePortrait --local-dir LivePortrait/pretrained_weights --exclude "*.git*" "README.md" "docs"
# 或走代理（与 .env HEYGEN_PROXY 共享）
# set HF_HUB_ENABLE_HF_TRANSFER=0
# huggingface-cli download ...（会自动走 HTTPS_PROXY 环境变量）
```

权重总体约 ~1.5GB，首次需联网；之后 `pretrained_weights/` 可随仓库提交备份。

**四、环境检查与启用**

控制台 → 「环境检查」页：
- `LivePortrait` 一行会显示 `🧪 仓库 OK / Python 依赖 OK / 权重就绪`，全部绿则可作为 provider 选用。
- 顶部「数字人 provider」下拉多了「LivePortrait（本地）」选项；切换后表单会出现「源人像 + 驱动视频/模板」两个字段。
- 「源人像」路径默认 `resources/photo1.jpg`（已提供 1 张示例），点「🧑 选人像」可从 resources / materials/photo / materials/image 浏览。
- 「驱动视频/模板」默认 `talking.pkl`（LivePortrait 内置动作模板），点「🎞 选驱动」可从 30 个内置 .pkl/.mp4 模板或用户上传的 materials/video 选。

**五、运行流程**

Step3 provider=liveportrait 时流水线行为：
1. `server/liveportrait.js` 用子进程调 `python LivePortrait/inference.py -s <源> -d <驱动> -o animations/`；
2. LivePortrait 输出 `<source>--<driving>.mp4`（默讴 512x512 @ driving fps，时长与驱动一致）；
3. ffmpeg 循环拼接该视频到 TTS 配音时长（音频为准），同时缩放到表单分辨率（1080x1920 等）；
4. ffmpeg 合成 TTS 音频 + libx264 重编码，输出 `output/03_heygen_raw.mp4`（与 HeyGen 产物路径一致，下游 Remotion/FFmpeg 步骤无感）；
5. 过程中会写进度到 `logs/liveportrait_progress.txt`，并产生 `LivePortrait/animations/<name>--<name>--looped.mp4` 中间产物。

**六、限制与跟进步骤**

- **口型不同步**（不与音频 lip-sync）是当前设计的明确代价；本 pipeline 主打「以低门槛跑通本地数字人」，对口型同步有需求可后续接 SadTalker/Musetalk。
- **驱动视频/模板质量 = 数字人表现上限**。talking.pkl、laugh.pkl、wink.pkl 等内置模板能覆盖主要场景，复杂动作需自己拍驱动视频。
- **GPU 加速**：LivePortrait 默认 CUDA；首次推理会下载 InsightFace 模型。CPU 模式极慢（几小时/分钟级），不推荐。
- **非口播场景**：若不需要 TTS 对口型，仅用 LivePortrait 生成人物动画，可直接用项目根 `LivePortrait/app.py` 启 Gradio 界面手动玩。

## 5. 流水线规范（Step0 可选 + 9 步串行，含两个人工环节）

| 步骤 | 引擎 | 输入 | 产物 | 校验规则（不通过即失败） | 超时默认 |
|---|---|---|---|---|---|
| Step0 MiniMax 音色克隆（可选） | `mmx file upload --purpose voice_clone` + `POST /v1/voice_clone`（密钥自动从 .env/~/.mmx 取）；克隆后自动合成探针比对基频（estimateF0）验证生效 | 原始录音（默认 `resources/voice1.m4a`）+ 自定义音色ID | `logs/cloned_voice.json`（voice_id 缓存，后续运行直接复用） | 录音 < 10s 自动补静音到 12.5s；克隆接口 status_code≠0 时给出中文提示；基频差异 >1.5 倍时附警告；已克隆则标记⏭️跳过 | 5 分钟 |
| **Step1 人工需求输入（可选）** | 流水线**暂停等待**：控制台弹窗预填表单主题/附加要求，人工确认/补充需求要点 → `POST /api/human/confirm` | 表单主题/附加要求（预填） | `logs/human_brief.txt` | 确认时需求 ≥ 2 字；不启用则跳过（直接用表单主题）；重跑下游步骤时自动复用已确认需求 | 无限期等待（可关机，重启控制台后仍可确认） |
| **Step2 Codex 生成口播文案** | 本地 `codex exec`（stdin 传 prompt，`-o` 取最终回复 + stdout 兜底清洗） | **Step1 人工需求** + 时长/风格/语言 | `output/01_script.txt` | 正文 ≥ 20 字 | 10 分钟 |
| **Step3 人工审稿（可选）** | 流水线**暂停等待**：弹窗展示 AI 初稿（可编辑），确认后回写定稿 → TTS/字幕均用定稿 | 01_script.txt（AI 初稿预填） | `output/01_script.txt`（定稿） | 确认时定稿 ≥ 20 字；不启用则跳过；重跑下游时若已审过则复用 | 无限期等待 |
| Step4 MiniMax TTS 配音 | `mmx speech synthesize --text-file - --format wav --out ...`（stdin 传定稿；启用克隆时 --voice 用 Step0 的 voice_id） | 定稿 01 + 音色/语速 | `output/02_audio.wav` | 文件存在且 ffprobe 时长 ≥ 0.5s；退出码 3=认证失败、4=额度不足 | 15 分钟 |
| Step5 数字人视频（provider 分派） | **HeyGen**（Remote MCP，OAuth）：上传音频 → `create_video_from_avatar`（音频驱动口型）→ 轮询 → 下载 <br>**LivePortrait**（本地推理）：`python inference.py -s <源人像> -d <驱动视频/模板>` → ffmpeg 循环 + 缩放 + mux TTS 配音 | 02_audio.wav + Avatar ID（HeyGen）<br>**或** 02_audio.wav + lpSource + lpDriving（LivePortrait） | `output/03_heygen_raw.mp4` | HeyGen：未连接/过期给提示；下载后 ffprobe ≥ 0.5s。LivePortrait：依赖/权重未就绪给一键安装提示；`python inference.py` 退出码 ≠ 0 时按 stderr 尾部报错。 | 30 分钟 |
| Step6 Codex 字幕+时间轴 | 本地 `codex exec`（输入：定稿全文 + 音频总时长；stdout 兜底解析/去重/重叠修复） | 定稿 01 + 02 音频时长 | `output/04_subtitle.srt` | 条数合理性校验（32s 至少 ~3 条）；末条超界按比例缩放 | 10 分钟 |
| Step7 Remotion 合成渲染 | `node remotion/render.mjs`（bundler + renderer 程序化 API，进度写入 logs/remotion_progress.txt） | 03 视频 + 04 字幕 + 分辨率/画面元素 | `output/05_remotion_composed.mp4` | 文件存在且时长与 03 相差 ≤ 5s | 45 分钟 |
| Step8 FFmpeg 编码压缩 | `ffmpeg ... -c:v libx264 -crf <质量> -preset <档位> -c:a aac -movflags +faststart` | 05 + 压缩质量 | `output/06_final_video.mp4` | 文件存在 | 20 分钟 |

### 交互规则（核心规则 4）

1. 每一步执行后记录状态：✅成功+文件路径 / ❌失败+错误信息 / ⏭️跳过+原因 / ✍️等待人工；失败**立即终止**流水线，等待用户指令（前端可单步重试）。
2. **人工环节（Step1 需求、Step3 审稿）**：流水线进入 `waiting` 状态暂停，控制台自动弹出编辑器，确认后继续；等待期间可关闭浏览器/重启控制台，状态持久化在 state.json，重启后仍可确认。表单可分别开关两个人工环节（默认开启）。
3. 支持单步重试：前端可「重试失败步骤」，也可「从 Step N 重跑到结尾」（重跑前校验上游产物存在；被跳过的步骤不检查；重跑时可覆盖部分参数）；重跑上游时：已确认的需求/文稿自动复用，但重新生成文案后会再次要求审稿。
4. 运行日志写入 `./logs/pipeline.log`；每步子进程完整输出另存 `logs/step{N}_*.log`；状态机持久化在 `logs/state.json`（服务重启不丢）。
5. 流程成功结束 → 前端弹窗询问「是否清理 ./output/ 临时文件（01~05）」，保留最终视频（调试模式不弹窗）。
6. 新任务启动时，上一轮产物自动归档到 `output/archive/<时间戳>/`。

### 状态机

`state.status ∈ {idle, running, waiting, success, failed, aborted}`；每个 step ∈ `{pending, running, waiting, done, failed, skipped}`。
同一时刻只允许一个运行任务；「停止」按钮会 kill 整个进程树并标记 `aborted`；`waiting` 无超时，人工确认（`POST /api/human/confirm {step, content}`）后从下一处继续。

## 6. 素材库（Web「🗃️ 素材库」页）

按分类引导上传，本地落盘 `./materials/<分类>/`，服务启动时自动建目录：

| 分类 | 目录 | 格式 | 用途说明 |
|---|---|---|---|
| 🎙️ 原始录音 | materials/voice | m4a/mp3/wav/aac/ogg | **Step0 音色克隆源**：上传后自动出现在「新建任务」克隆源下拉（与 resources/voice1.m4a 并列） |
| 🧑 数字人照片 | materials/photo | jpg/png/webp | HeyGen 照片数字人参考 |
| 🖼️ 图片素材 | materials/image | jpg/png/webp/gif/svg | 背景/贴片/封面（入库备用） |
| 🎵 音乐/音效 | materials/audio | mp3/wav/m4a/ogg/flac | 背景音乐（入库备用） |
| 🎬 视频素材 | materials/video | mp4/mov/webm | 片头/B-roll（入库备用） |
| 📄 文案/参考 | materials/doc | txt/md/srt/json | 文案草稿（可在 Step1 人工需求时引用） |
| 📦 其他 | materials/other | 任意 | 未分类 |

分类定义在 `server/pipeline.js` 的 `MATERIAL_CATEGORIES`；上传接口按分类校验扩展名，不匹配时给出引导提示。

## 7. 表单参数字典

| 参数 | 说明 | 默认 | 约束 |
|---|---|---|---|
| topic | 视频主题（必填） | - | ≤600 字 |
| durationSec | 目标时长（秒） | 60 | 5–600；文案字数按 4.3 字/秒 × 语速估算 |
| style | 内容风格 | 知识科普讲解 | 预设 6 种 + 自定义 |
| language | 语言 | zh | zh / en |
| voice / speed | MiniMax 音色 ID / 语速 | Warm Girl / 1.0 | 音色可自定义；语速 0.5–2.0 |
| avatarProvider | 数字人 provider | `heygen` | `heygen`（云端） / `liveportrait`（本地） |
| avatarId | HeyGen 数字人 Avatar ID（仅 provider=heygen） | 取 `.env` HEYGEN_AVATAR_ID | provider=heygen 时必填 |
| lpSource | LivePortrait 源人像（仅 provider=liveportrait） | `resources/photo1.jpg` | jpg/png；项目内路径或 materials/photo/xxx.jpg |
| lpDriving | LivePortrait 驱动视频/模板（仅 provider=liveportrait） | `talking.pkl` | LivePortrait 内置 .pkl 模板名或 mp4 路径 |
| resolution | 输出分辨率 | 1080x1920 | 1080x1920 / 720x1280 / 1920x1080 / 1080x1080 |
| quality | 压缩质量 | balanced | high=CRF20 / balanced=CRF23 / small=CRF27 |
| showTitleBar / titleText | 顶部标题栏 | 开 / 主题前 18 字 | - |
| showProgressBar | 底部进度条 | 开 | - |
| watermark | 右下角水印 | 空 | ≤24 字 |
| useCloneVoice / cloneSource / cloneVoiceId | 是否启用音色克隆；原始录音路径；自定义克隆音色ID（小写字母/数字/下划线） | false / resources/voice1.m4a / voice1_zhengnan_001 | 克隆结果缓存在 logs/cloned_voice.json，重复运行自动复用；改 ID 或删缓存文件可重新克隆 |
| manualBrief / manualReview | 人工需求输入（Step1）/人工审稿（Step3）开关 | true / true | 关闭后对应步骤⏭️跳过，直接用表单主题/AI 原稿 |
| runMode | 流水线范围 | full | full=完整；audio=文案+配音+字幕（跳过 HeyGen 及依赖它的合成/压缩，不耗 credit）；tts=文案+配音；script=仅生成文案 |
| extra | 附加要求（透传给文案 Codex） | 空 | ≤2000 字 |

## 8. 控制台 API 一览（仅监听 127.0.0.1）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | /api/status | 流水线状态（含步骤、进度、历史） |
| GET | /api/defaults | 表单预设（音色/分辨率/质量/风格/env 摘要） |
| POST | /api/run | 启动流水线 `{params:{...}}` |
| POST | /api/retry | 重试/重跑 `{step:N, params?:{覆盖}}` |
| POST | /api/human/confirm | 人工环节确认 `{step:1\|3, content}`（需求定稿/文稿定稿并继续） |
| POST | /api/stop | 停止当前任务（kill 进程树） |
| POST | /api/cleanup | 清理 01–05 临时文件，保留 06 |
| GET | /api/env[?deep=1] | 环境校验（deep 含 `mmx quota` 登录校验） |
| POST | /api/env/autofix | 自动修复（如安装 remotion 依赖） |
| GET | /api/heygen/login | 发起 HeyGen OAuth（302 到授权页，本地回调 /api/heygen/callback） |
| GET | /api/heygen/status | 连接状态 + 账号信息（get_current_user） |
| GET | /api/heygen/avatars | 列出账号下数字人形象（list_avatar_looks） |
| POST | /api/heygen/logout | 断开连接（删除本地令牌） |
| GET | /api/liveportrait/status | LivePortrait 仓库 / 权重 / Python 依赖就绪情况 |
| GET | /api/liveportrait/driving | 列出 LivePortrait 内置 driving 模板/视频（.pkl/.mp4） |
| GET | /api/logs?lines=N&file=xx.log | 日志尾部 |
| GET | /api/materials | 素材库全量：各分类定义 + 文件列表（名称/大小/时间） |
| GET | /api/download?path=xx[&preview=1] | 下载/预览（预览支持 Range 流式播放） |
| DELETE | /api/file?path=xx | 删除文件（仅限四个白名单目录） |
| GET | /api/files?dir=output\|materials\|resources\|logs | 文件目录递归列表 |
| POST | /api/upload?dir=materials&name=xx | 上传到目录根（旧接口；分类上传见下） |
| POST | /api/upload?category=voice&name=xx | **分类上传素材**（voice/photo/image/audio/video/doc/other；按分类校验扩展名，保存到 materials/<分类>/） |

## 9. 关键实现约定

1. **Codex 调用**：`codex exec --skip-git-repo-check --ephemeral -s read-only -o logs/stepN_last_message.txt -`，prompt 走 **stdin**（规避 Windows shell 引号/长度坑），最终回复从 `-o` 文件读取，失败兜底解析 stdout。
2. **mmx 调用**：`mmx speech synthesize --text-file - --non-interactive --quiet --format wav`，文案同样走 stdin；模型默认 `speech-2.8-hd`（`.env` 可改）。
3. **HeyGen MCP**：不装 CLI，直接以 MCP 协议（Streamable HTTP + Bearer）调 `https://mcp.heygen.com/mcp/v1/`；OAuth 授权码+PKCE+DCR 全自动，回调页由控制台承接；`create_video` 入参按服务器返回的 schema 自适应（audio/dimension 等字段名变化无需改代码）。
4. **Remotion**：不依赖 CLI（避免 npx/.cmd/引号问题），直接用 `@remotion/bundler` + `@remotion/renderer` 程序化渲染；分辨率/帧率/时长由 `calculateMetadata` 根据 props 动态决定；首次渲染自动下载 Headless Chrome（约 100–200MB，仅一次）。自检命令：`cd remotion && npm run smoke`。
5. **FFmpeg**：`libx264 + aac + faststart`，CRF 由质量档位决定；ffprobe 贯穿全程做产物完整性校验。
6. **安全**：服务只绑 127.0.0.1；文件接口全部限制在项目根目录白名单内，防路径穿越。

## 10. 常见问题（FAQ）

- **Step2 报退出码 3**：mmx 未登录 → `mmx auth login --api-key <密钥>` 或在 `.env` 配 `MINIMAX_API_KEY`。
- **听起来还是默认音色？**：① 确认听的是最新一轮成品（旧轮次可能被浏览器缓存，重新打开预览或强制刷新）；② 看 Step0/Step2 的 meta：Step2 应显示 `🎤 克隆音色` 与克隆 voice_id；③ Step0 首次克隆后会自动做基频验证（源录音 vs 探针合成），不一致会在步骤里附警告；④ 排查工具：`python scripts/f0.py output/02_audio.wav resources/voice1.m4a`（男声~90Hz、女声~230Hz）。
- **想重新克隆音色**：删除 `logs/cloned_voice.json` 后从 Step0 重跑；或换一个「克隆音色 ID」。
- **Step0 报「录音时长不足 10s」**：流水线会自动补静音到 12.5s；若仍失败请提供 ≥10s 的清晰人声录音（m4a/mp3/wav）。
- **Step3 报「HeyGen 未连接/令牌过期」**：控制台「环境检查」页重新点「🔗 连接 HeyGen」；若打不开授权页，检查 `.env` 的 `HEYGEN_PROXY` 是否指向可用代理。
- **Step5 首次很慢**：正在下载 Headless Chrome 与打包工程，之后有缓存会明显变快。
- **重试报"缺少上游产物"**：说明上游文件已被清理/归档 → 从更早步骤重跑，或到 `output/archive/` 找回。
- **改端口**：`.env` 中 `PORT=xxxx`。
- **换 Codex 模型**：`.env` 中 `CODEX_MODEL=xxx`。

## 11. 二次开发指引

- 新增流水线步骤：在 `server/pipeline.js` 的 `STEPS` 与 `STEP_IMPLS` 注册（实现返回 `{meta}`，抛错即失败），前端进度条自动渲染。
- 新增画面元素：改 `remotion/src/Video.jsx`，props 由 Step5 组装（`pipeline.js` → `remotion_props.json`）。
- 新增环境校验项：改 `server/envcheck.js`，启动脚本与前端环境页自动生效。
- 改前端表单：`web/index.html` + `web/app.js`（纯静态，无构建）。
