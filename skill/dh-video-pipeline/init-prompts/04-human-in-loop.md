# 04 · 人工环节（Step1 需求输入 / Step3 审稿定稿）

> 目标：AI 写稿前后各一道人工关卡；流水线可暂停等待，确认后续跑。

## 要求

### 步骤重构（产物文件名 01-06 契约不变）
```
Step0 克隆 → Step1 人工需求✍️ → Step2 Codex文案 → Step3 人工审稿✍️
→ Step4 TTS → Step5 HeyGen → Step6 字幕 → Step7 合成 → Step8 压缩
```

### 状态机扩展
- 全局状态加 `waiting`；步骤状态加 `waiting`。
- **不挂起 Promise**：人工步骤返回 `{paused:true, waitingFor, prefill}` → executeFrom 置 `state.waiting={step,kind,prefill}`、status=waiting 后直接 return；`POST /api/human/confirm {step, content}` 落盘内容、标记 done、`executeFrom(step+1)` 继续。
  - 好处：**等待无超时、重启服务仍可确认**（状态在 state.json）。
- 轮询：前端在 running **和** waiting 时都轮询；进入 waiting 自动弹编辑器（每等待点只弹一次）。

### Step1 人工需求
- prefill = 表单主题+附加要求；确认后写 `logs/human_brief.txt`，作为 Step2 Codex 的【人工需求（用户已确认）】输入（时长/风格约束仍来自表单参数）。
- `manualBrief=false` → 跳过，直接用表单主题；**重跑场景**（currentFromStep>1 且 brief 文件存在）自动复用不再等待。

### Step3 人工审稿
- prefill = `output/01_script.txt`（AI 初稿）；可编辑；确认（≥20 字）后**回写 01_script.txt**，TTS/字幕均用定稿。
- `manualReview=false` → 跳过用 AI 原稿；重跑下游时已审过则复用（`ctx.reviewConfirmed`），**但重新生成文案后必须再次审稿**。

### 验收标准
- 全链路：waiting@Step1 → 确认 → Codex 按人工需求写稿 → waiting@Step3 → 编辑文稿确认 → 定稿进入 TTS（F0/字幕内容证明用的是修改后文本）。
- 停止/重启后 confirm 仍生效；两个人工开关独立可用。

## 已知坑
- confirm 必须校验 `state.waiting.step === body.step`（防过期回调）。
- 「停止」时若在 waiting：无子进程可 kill，直接置 aborted。
