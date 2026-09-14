# 01 · 基础流水线 + Web 控制台

> 前置：00 总规格。产出可运行的 6 步流水线雏形（Step 编号后来演进为 9 步，见 04/05）。

## 要求

### 服务端（server/，纯 Node）
- `utils.js`：.env 解析（`process.env` < `.env` < `secrets/.api_keys.json` 仅补密钥）、`execChild`（子进程封装：shell 可选/超时 kill 进程树/日志落盘/stdin 注入/**含空格括号参数自动加引号**）、ffprobe 时长、SRT 解析、状态文件读写（原子写）。
- `pipeline.js`：STEPS 表驱动串行执行；状态机 `idle/running/success/failed/aborted` + 步骤 `pending/running/done/failed`；`startRun/retryRun/stopRun`；启动归档、清理接口（删 01-05 留 06）。
- `envcheck.js`：依赖逐项校验，返回 `{ok, items:[{id,name,required,ok,detail,fix}]}`；`check-env.js` CLI 复用（`--autofix` 自动装 remotion 依赖，退出码作为启动门禁）。
- `index.js`：HTTP API（/api/run /api/status /api/retry /api/stop /api/cleanup /api/env /api/defaults /api/logs /api/files /api/download(Range 预览) /api/upload /api/file DELETE）+ 静态前端。

### 关键步骤实现要点
- **Codex 调用**：`codex exec --skip-git-repo-check --ephemeral -s read-only -o logs/stepN_last_message.txt -`，**prompt 走 stdin**；最终回复读 `-o` 文件（详见 02 的流式坑）。
- **mmx TTS**：`mmx speech synthesize --text-file - --non-interactive --quiet --format wav --out output/02_audio.wav`，文案走 stdin；退出码 3=认证失败 4=额度不足要翻译成人话。
- **Remotion**：不用 CLI（避免 npx/.cmd/引号问题），`render.mjs` 程序化 `bundle() + selectComposition() + renderMedia()`；分辨率/时长由 props + `calculateMetadata` 动态决定；视频拷入 `remotion/public/` 用 `staticFile`；进度写文件供前端轮询；`smoke-test.mjs` 安装自检（首次自动下载 Headless Chrome）。
- **FFmpeg**：libx264+aac+faststart，CRF 档位 high=20/balanced=23/small=27。

### 前端（web/，无构建）
Tab：新建任务（表单）/运行进度（步骤卡片+重试）/文件管理/环境检查/日志；toast/modal；运行中 1.5s 轮询；成功后弹「清理临时文件」确认。

### 验收标准
- `node scripts/check-env.js` 缺依赖报错退出并列出修复命令；`start.bat`/`start.sh` 一键启动并开浏览器。
- 真实跑通 Step1（codex 生成 ≥20 字文案）→ 状态机在 Step2 失败终止 → 单步重试生效。
- Remotion smoke test 渲染出 mp4；上传/下载/Range 预览/删除/路径穿越防护全部通过。

## 已知坑
- git-bash curl 发中文 JSON 会乱码 → 测试用 `node -e fetch(...)`。
- ffmpeg winget 安装后当前 shell PATH 未刷新 → envcheck 直接执行 .env 里 FFMPEG_PATH 绝对路径（shell:false）。
- Remotion 各包必须**同版本**（4.0.524）；undici 依赖加在 remotion 子工程（服务端代理需要时从 `remotion/node_modules` require）。
