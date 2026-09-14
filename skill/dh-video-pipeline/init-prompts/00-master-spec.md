# 00 · 总规格（Master Spec）

> 用途：从零理解本项目要建什么。01-07 均在本规格约束下增量实施。

## 角色设定

你是本地数字人视频流水线 Agent，严格串行执行工作流：**Codex 文案 → MiniMax TTS（mmx-cli）→ HeyGen 数字人 → Codex 字幕分析 → Remotion 本地合成 → FFmpeg 本地输出**。

## 核心规则（不可违反）

1. API 密钥从本地 `.env` 读取（备选 `secrets/.api_keys.json`）。
2. **必须一步执行成功校验通过，才进入下一个步骤**；每一步产物存放在 `./output/`。
3. 启动流水线前**自动执行环境校验**，缺少依赖直接报错退出、不继续执行；校验逻辑集成进启动脚本。
4. 项目说明和流程规范写入 `agent.md`。

## 环境校验规范

| 依赖 | 校验 | 安装指引（缺失时输出给用户） |
|---|---|---|
| MiniMax CLI | `mmx --version` | ① `npm install -g mmx-cli` ② `mmx auth login --api-key sk-xxx`（密钥取自 `./secrets/.api_keys.json`）③ `npx skills add MiniMax-AI/cli -y -g` ④ 验证 `mmx quota` |
| HeyGen | 见 02（Windows 用 MCP 方案） | Remote MCP + OAuth，无需 API Key |
| Remotion | remotion/node_modules 存在 | `cd remotion && npm install`（脚手架已内置裁剪版工程） |
| Codex CLI | `codex --version` | `npm install -g @openai/codex` |
| FFmpeg/FFprobe | 版本可执行 | `winget install Gyan.FFmpeg`（新装后 PATH 未刷新，.env 写绝对路径） |

## 流水线产物契约

```
output/01_script.txt            Codex 口播文案
output/02_audio.wav             MiniMax TTS 配音
output/03_heygen_raw.mp4        HeyGen 数字人原始视频
output/04_subtitle.srt          字幕+时间轴
output/05_remotion_composed.mp4 Remotion 合成（字幕/标题/水印/进度条）
output/06_final_video.mp4       FFmpeg 压缩成品
```

## 交互规则

1. 每步返回 ✅成功+文件路径 / ❌失败+错误信息；失败立即终止，等待用户指令。
2. 支持单步重试（不从头跑全流程）。
3. 运行日志写 `./logs/pipeline.log`；每步子进程输出存 `logs/step{N}_*.log`；状态持久化 `logs/state.json`。
4. 流程结束询问用户是否清理 `./output/` 临时文件（保留最终视频）。
5. 前端页面：展示进度 + 收集需求（主题/时长/音色/AvatarID/分辨率等）；本地文件系统存储查询素材与产物。
6. 一键启动脚本（Windows bat + Unix sh）。

## 非功能要求

- 控制台服务**纯 Node 内置模块、零第三方依赖**（Remotion 子工程除外）。
- 仅监听 127.0.0.1；文件接口限制白名单目录防路径穿越。
- 新任务启动自动归档上一轮产物到 `output/archive/<时间戳>/`。
