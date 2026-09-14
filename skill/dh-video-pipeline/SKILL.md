---
name: dh-video-pipeline
description: 本地数字人短视频生产流水线（Codex文案 → MiniMax声音克隆/TTS → HeyGen数字人MCP → 字幕 → Remotion合成 → FFmpeg出片）。当用户要「初始化/搭建数字人视频流水线」「生成数字人口播视频」「克隆音色配音」「操作流水线（启动/重试/清理）」「排查流水线故障」时使用。包含全部初始化 prompt、完整项目脚手架和部署脚本。
---

# dh-video-pipeline · 数字人视频流水线 Skill

一套可完整复现的本地数字人短视频生产线：**AI 写稿 + 人工审稿定稿 + 声音克隆配音 + 数字人口播 + 自动字幕合成出片**，附带 Web 控制台。

## 三大用途

| 场景 | 做法 |
|---|---|
| ① 全新初始化项目 | `scripts/init-project.<sh\|ps1> <目标目录>` 部署脚手架 → 按 `init-prompts/00-master-spec.md` 逐阶段实施（或在已有项目上按 01-07 增量补齐） |
| ② 运营已有项目 | 按下方「运营 SOP」通过 HTTP API 操作（默认 `http://127.0.0.1:7788`） |
| ③ 故障排查 | 见「已知坑清单」（全部来自实战） |

## 项目结构速览

```
start.bat / start.sh        一键启动（环境自检，缺依赖拒绝启动）
scripts/check-env.js        环境校验（--autofix 自动装 remotion 依赖）
server/                     控制台服务（纯 Node 无第三方依赖）
  index.js                  HTTP API + 前端 + 文件流/上传 + HeyGen OAuth 回调
  pipeline.js               9 步串行流水线/状态机/人工环节/重试/归档
  heygen_mcp.js             HeyGen Remote MCP 客户端（OAuth+PKCE+DCR+代理）
  envcheck.js / utils.js
web/                        前端（原生 HTML/JS/CSS）
remotion/                   Step7 合成工程（程序化渲染，需 npm install）
materials/                  素材库（voice/photo/image/audio/video/doc/other）
output/  logs/  secrets/    产物/日志/密钥
```

## 流水线（9 步 · 严格串行）

```
Step0 声音克隆(可选) → Step1 人工需求✍️ → Step2 Codex文案 → Step3 人工审稿✍️
→ Step4 MiniMax TTS → Step5 数字人 → Step6 Codex字幕
→ Step7 Remotion合成 → Step8 FFmpeg压缩 → output/06_final_video.mp4
```

**Step5 双 Provider**：`avatarProvider`
- `heygen`（默认）：Remote MCP 音频驱动口型，耗 credit
- `liveportrait`（可选本地）：源人像 + 驱动视频 + ffmpeg 混音，免费需 GPU；**不做音频口型同步**；一键安装 `scripts/install-liveportrait.ps1`（Windows OpenCV 中文路径坑已用 junction 解决）

- 状态机：`idle / running / waiting(人工) / success / failed / aborted`；步骤 `pending/running/waiting/done/failed/skipped`
- `runMode`：`full`（全流程）/ `audio`（文案+配音+字幕，不耗 HeyGen credit）/ `tts` / `script`
- 任一步失败立即终止；支持从任意步骤重跑（上游产物校验 + 已确认内容自动复用）

## 初始化流程（Agent SOP）

1. 部署脚手架：`bash scripts/init-project.sh ~/目标目录`（Windows 用 `init-project.ps1`）
2. 进入目录，创建 `.env`（模板 `.env.example`）；中国大陆网络需设 `HEYGEN_PROXY=http://127.0.0.1:7890`
3. 环境自检：`node scripts/check-env.js --autofix`（退出码非 0 则按提示补依赖，**不要跳过校验直接启动**）
4. MiniMax：`npm i -g mmx-cli && mmx auth login --api-key <密钥>`，`mmx quota` 验证
5. HeyGen：启动控制台后打开 `http://127.0.0.1:7788/api/heygen/login` 完成一次 OAuth（令牌自动落盘 `secrets/heygen_mcp_token.json`）
6. 若需从零重建/增强项目功能，按 `init-prompts/` 编号顺序执行各 prompt（每个都含验收标准与已知坑）
7. 全部通过后 `start.bat` / `./start.sh`，浏览器自动打开控制台

## 运营 SOP（HTTP API）

```bash
BASE=http://127.0.0.1:7788

# 启动流水线（完整参数见 scaffold/agent.md §7；runMode=audio 为零 credit 调试）
curl -X POST $BASE/api/run -H "content-type: application/json" -d '{"params":{
  "topic":"主题","durationSec":30,"avatarId":"<HeyGen avatarID>","resolution":"1080x1920",
  "useCloneVoice":true,"cloneSource":"materials/voice/xxx.m4a","cloneVoiceId":"voice_001",
  "manualBrief":true,"manualReview":true,"runMode":"full"}}'

curl -s $BASE/api/status                    # 轮询状态（1.5s 间隔）
# status=waiting 时（人工环节）：前端弹窗编辑确认；等价 API：
curl -X POST $BASE/api/human/confirm -H "content-type: application/json" \
     -d '{"step":1,"content":"确认后的需求文本"}'    # step=3 为文稿定稿
curl -X POST $BASE/api/retry  -d '{"step":5}' -H "content-type: application/json"  # 从Step5重跑
curl -X POST $BASE/api/stop   ;  curl -X POST $BASE/api/cleanup    # 停止 / 清理临时文件(保留06)
curl -s $BASE/api/env?deep=1  ;  curl -s "$BASE/api/heygen/avatars"  # 环境深检 / 数字人列表
curl -s "$BASE/api/materials" ;  curl -X POST "$BASE/api/upload?category=voice&name=a.m4a" --data-binary @a.m4a
```

成品：`output/06_final_video.mp4`（中间产物 01~05 同目录；历史轮次在 `output/archive/`）。

## 已知坑清单（实战沉淀，排查先看这里）

1. **HeyGen 官方 CLI 不支持 Windows**：未签名 exe 被 Smart App Control 拦截 → 必须走 Remote MCP（`heygen_mcp.js` 已实现 OAuth+PKCE+DCR）
2. **中国大陆 DNS 污染**：`mcp.heygen.com`/`api2.heygen.com` 解析到假 IP → 必须配 `HEYGEN_PROXY`（undici ProxyAgent 走本地代理）
3. **MiniMax 声音克隆需先传文件存储**：`/v1/voice_clone` 不收 multipart 文件，要先 `mmx file upload --purpose voice_clone` 拿 `file_id`；录音 <10s 报 `voice duration too short`（流水线自动补静音到 12.5s）
4. **克隆可能静默回退默认音色**：克隆后必须合成探针比对基频（`estimateF0`，男声~90Hz/女声~230Hz）防呆
5. **codex 长输出会被拆成多条流式消息**：`-o` 只拿到末段 → 必须清洗 stdout 兜底（过滤 `codex` 分隔符/tokens 尾巴 + 修复拆行时间轴 + 去重 + 最少条数校验）
6. **Windows cmd 拼参引号坑**：含空格/括号的参数（音色 ID、路径）必须加引号（`execChild` 的 `shellQuote`）
7. **prompt 经 stdin 传给 codex**（`codex exec -`）：规避命令行长度/引号问题；`-s read-only` + `--ephemeral`
8. **MCP 工具名为细分命名**：`create_video_from_avatar`（不是 `create_video`），参数 camelCase（`avatarId/audioAssetId/aspectRatio`）；`list_avatar_looks` limit≤50，`ownership: public/private` 区分预置/自有形象
9. **git-bash 的 curl 会把中文请求体搞乱**：测试 API 用 `node -e fetch(...)` 而不是 curl -d
10. **隐私红线**：`resources/`（私人录音/照片）、`secrets/`（令牌）、`.env` 永不入库（.gitignore 已配置）
11. **LivePortrait 中文路径坑**：Windows OpenCV 读中文路径 imread 返 None → 必须经 junction（`C:\lp_runtime`）访问；且它不做音频口型同步，文档/UI 要如实标注

## 详细文档

- `scaffold/agent.md` — 完整项目规范（状态机/参数字典/API/FAQ/二次开发）
- `scaffold/README.md` — 面向使用者的说明
- `init-prompts/` — 全部初始化 prompt（00 总规格 → 08 LivePortrait provider）
