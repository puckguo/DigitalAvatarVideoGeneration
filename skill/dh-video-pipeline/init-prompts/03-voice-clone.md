# 03 · 音色克隆（Step0，可选）

> 目标：≥10 秒原始录音 → MiniMax 声音复刻 → 之后每条视频用克隆音色配音。

## 要求

### 参数
`useCloneVoice`（bool）、`cloneSource`（默认 `resources/voice1.m4a`，前端下拉可选素材库 `materials/voice/`）、`cloneVoiceId`（自定义小写字母/数字/下划线）。

### Step0 实现（`stepClone`）
1. 未启用 → 步骤标记 ⏭️skipped（不失败）。
2. 缓存复用：`logs/cloned_voice.json` 存 `{voice_id, file_id, source, created_at}`，命中同 voice_id 直接复用（重跑场景）。
3. 录音 <10.5s → ffmpeg `apad=pad_dur=4 -t 12.5` 自动补静音（MiniMax 下限 10s，报错 `voice duration too short`）。
4. 上传：`mmx file upload --file <相对路径> --purpose voice_clone --output json --quiet`（**stdout 末行是 file_id**）。
5. 克隆：`POST {MINIMAX_BASE}/v1/voice_clone`，JSON `{voice_id, file_id}`，Bearer 密钥（读取顺序 `.env MINIMAX_API_KEY` → `~/.mmx/config.json`，region cn=`api.minimaxi.com` / global=`api.minimax.io`）。
   - ⚠️ 接口**不收 multipart 文件**，必须先传文件存储拿 file_id（直接传 file 报 `file_id or audio_url is required`）。
   - `status_code≠0` 翻译：2013 参数错 / 2037 时长不足 / 1004 鉴权失败 / 1027 克隆权限未开通；**"voice id exist" 类错误视为成功复用**。
6. **生效验证（防静默回退默认音色）**：克隆后立刻用新音色合成探针 `声音克隆验证测试。`，与源录音（ffmpeg 转 16k 单声道 wav）分别算基频 `estimateF0`（WAV PCM16 自相关法，窗口取能量最高 1s，搜索 60-400Hz，置信度>0.25）；比值 >1.5 或 <0.67 → 步骤附 warning（不 fail）。

### Step4(TTS) 联动
`voice = (useCloneVoice && ctx.clonedVoiceId) ? clonedVoiceId : 表单音色`；meta 标记 `cloned:true`。

### 验收标准
- 首跑：真实克隆成功 + 基频验证通过（如源 88Hz/探针 83Hz）；二跑：直接复用缓存。
- `python scripts/f0.py output/02_audio.wav <源录音>` 人工复核男声~90Hz/女声~230Hz。

## 已知坑
- 音色 ID 含空格括号（如 `Chinese (Mandarin)_Warm_Girl`）在 cmd 拼接时必须加引号，否则被拆散报 "voice id not exist"（execChild 的 shellQuote 已处理）。
- 用户报告「还是默认女声」时，先用 F0 比对确认听的不是旧视频（浏览器缓存），再怀疑克隆未生效。
