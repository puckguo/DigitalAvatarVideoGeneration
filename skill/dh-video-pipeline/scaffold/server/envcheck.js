'use strict';
/**
 * 环境校验：node/.env/codex/mmx/heygen/ffmpeg/remotion
 * 供 scripts/check-env.js（启动前硬校验）与 /api/env（前端展示）共用
 */
const fs = require('fs');
const path = require('path');
const { ROOT, execChild, getEnv } = require('./utils');
const liveportrait = require('./liveportrait');
const latentsync = require('./latentsync');

async function checkCommand(cmdLine, timeoutMs = 15000) {
  const r = await execChild(cmdLine, [], { shell: true, timeoutMs });
  const out = `${r.stdout || ''}${r.stderr || ''}`.split('\n').map((s) => s.trim()).filter(Boolean);
  const detail = out[0] || (r.error ? String(r.error) : `exit code ${r.code}`);
  return { ok: r.code === 0, detail: detail.slice(0, 200) };
}

async function checkCommandPath(exePath, args, timeoutMs = 15000) {
  if (!fs.existsSync(exePath)) return { ok: false, detail: `文件不存在：${exePath}` };
  const r = await execChild(exePath, args, { shell: false, timeoutMs });
  const out = `${r.stdout || ''}${r.stderr || ''}`.split('\n').map((s) => s.trim()).filter(Boolean);
  return { ok: r.code === 0, detail: out[0] ? out[0].slice(0, 200) : (r.error || `exit ${r.code}`) };
}

async function runEnvCheck(opts = {}) {
  const { deep = false } = opts;
  const items = [];

  // 1. Node.js
  const nodeV = process.versions.node;
  const nodeMajor = parseInt(nodeV.split('.')[0], 10);
  items.push({
    id: 'node', name: 'Node.js ≥ 18（控制台服务）', required: true,
    ok: nodeMajor >= 18, detail: `v${nodeV}`,
    fix: '安装 Node.js LTS：https://nodejs.org/ 或 winget install OpenJS.NodeJS.LTS',
  });

  // 2. .env 配置
  const envOk = fs.existsSync(path.join(ROOT, '.env'));
  items.push({
    id: 'dotenv', name: '.env 配置文件（API 密钥）', required: true,
    ok: envOk, detail: envOk ? '已找到（密钥也可放 secrets/.api_keys.json）' : '缺少 .env',
    fix: '复制模板：copy .env.example .env（或 cp .env.example .env），按需填写密钥',
  });

  // 3. secrets 密钥库（可选，仅提示）
  const secretsOk = fs.existsSync(path.join(ROOT, 'secrets', '.api_keys.json'));
  items.push({
    id: 'secrets', name: 'secrets/.api_keys.json 密钥库', required: false,
    ok: secretsOk, warn: !secretsOk,
    detail: secretsOk ? '已找到' : '未找到（可选：mmx/heygen 密钥集中存放处）',
    fix: '参考 secrets/.api_keys.example.json 创建，字段：minimax / heygen / openai',
  });

  // 4. AI 文本生成：puck SDK 优先（必需），codex CLI 仅作 fallback（可选）
  //    puck SDK 通过 file: 引用本地 puck-agent/puck/packages/sdk，需确认 dist/ 存在
  const puckPkg = (() => {
    try { return require('@puckguo123/sdk/package.json'); } catch (_) { return null; }
  })();
  const puckOk = !!puckPkg;
  // env 在 ffmpeg 段才赋值（见下文）；这里先 getEnv() 兜底
  const apiKeys = getEnv();
  const hasAnyKey = ['MINIMAX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ZAI_CODING_CN_API_KEY', 'MINIMAX_CN_API_KEY'].some((k) => apiKeys[k] && String(apiKeys[k]).trim());
  items.push({
    id: 'puck', name: 'Puck Agent SDK（Step1 文案 / Step4 字幕，主路径）', required: true,
    ok: puckOk && hasAnyKey,
    detail: !puckOk
      ? 'puck SDK 未就绪：请确认已运行 npm install（流水线根 package.json 已声明 @puckguo123/sdk file: 依赖到 puck-agent/puck/packages/sdk）'
      : !hasAnyKey
        ? 'puck SDK 已加载，但未配置任何 provider 的 API Key（需在 .env 配置 MINIMAX_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY 等至少一个）'
        : `puck SDK v${puckPkg.version} 已就绪，已检测到 API Key`,
    fix: !puckOk
      ? 'cd 项目根 && npm install（会从 puck-agent/puck/packages/sdk 安装 @puckguo123/sdk）'
      : '在 .env 中配置至少一个 provider 的 API Key（推荐 MINIMAX_API_KEY；其他可选：OPENAI_API_KEY / ANTHROPIC_API_KEY / ZAI_CODING_CN_API_KEY）',
  });
  // codex CLI：fallback，required=false（puck 失败时才用到）
  const codex = await checkCommand('codex --version');
  items.push({
    id: 'codex', name: 'Codex CLI（fallback，已弃用）', required: false,
    ok: codex.ok, warn: !codex.ok,
    detail: codex.ok
      ? `${codex.detail}（仅在 puck SDK 失败时自动回退，强烈建议改用 puck）`
      : '未安装（puck 失败时无 fallback；如需安装：npm install -g @openai/codex && codex login）',
    fix: '已弃用：流水线默认走 puck SDK，codex CLI 仅作应急。安装：npm install -g @openai/codex && codex login',
  });

  // 5. MiniMax CLI（mmx）
  const mmx = await checkCommand('mmx --version');
  items.push({
    id: 'mmx', name: 'MiniMax CLI（Step2 TTS 配音）', required: true,
    ok: mmx.ok, detail: mmx.detail,
    fix: [
      '① npm install -g mmx-cli   （完成后 mmx --version 验证）',
      '② mmx auth login --api-key sk-xxx   （密钥取自 ./secrets/.api_keys.json 的 minimax 字段）',
      '③ npx skills add MiniMax-AI/cli -y -g   （安装官方 SKILL）',
      '④ 验证生效：mmx quota',
    ].join('\n'),
  });
  if (mmx.ok) {
    let auth = null;
    if (deep) {
      const q = await execChild('mmx quota show --output json --quiet', [], { shell: true, timeoutMs: 45 * 1000 });
      const text = `${q.stdout || ''}\n${q.stderr || ''}`.replace(/\s+/g, ' ').trim();
      auth = { ok: q.code === 0, warn: false, detail: (q.code === 0 ? '已登录，额度查询成功' : '额度查询失败') + (text ? `：${text.slice(0, 260)}` : '') };
    } else {
      auth = { ok: true, warn: true, detail: 'CLI 已安装；未做额度深度校验（可在控制台「环境检查」页点「深度校验」执行 mmx quota）' };
    }
    items.push({
      id: 'mmx-auth', name: 'MiniMax 登录/额度（mmx quota）', required: true,
      ok: auth.ok, warn: auth.warn, detail: auth.detail,
      fix: 'mmx auth login --api-key <密钥>，然后 mmx quota 验证；密钥见 secrets/.api_keys.json 或 ~/.mmx/config.json',
    });
  }

  // 6. HeyGen MCP 连接（官方 CLI 不支持 Windows，改用 Remote MCP + OAuth）
  const hgToken = (() => {
    try { return JSON.parse(require('fs').readFileSync(path.join(ROOT, 'secrets', 'heygen_mcp_token.json'), 'utf8')); } catch (_) { return null; }
  })();
  items.push({
    id: 'heygen', name: 'HeyGen MCP 连接（Step3 数字人视频）', required: true,
    ok: !!(hgToken && hgToken.access_token),
    detail: hgToken && hgToken.access_token
      ? `已连接（令牌保存于 secrets/heygen_mcp_token.json${hgToken.refresh_token ? '，支持自动续期' : ''}）`
      : '未连接：需要在控制台完成一次 OAuth 浏览器授权',
    fix: '启动控制台 → 「环境检查」页 → 点击「🔗 连接 HeyGen」，浏览器登录 HeyGen 账号并授权即可（无需 API Key）。若网络受限，在 .env 配置 HEYGEN_PROXY=http://127.0.0.1:7890',
  });

  // 7. FFmpeg（优先用 .env 配置的绝对路径，避免新装后 PATH 未刷新）
  const env = getEnv();
  const ffPath = (env.FFMPEG_PATH || 'ffmpeg').trim();
  const fpPath = (env.FFPROBE_PATH || 'ffprobe').trim();
  const ffAbs = /^[a-zA-Z]:[\\/]/.test(ffPath);
  const fpAbs = /^[a-zA-Z]:[\\/]/.test(fpPath);
  const ff = ffAbs
    ? await checkCommandPath(ffPath, ['-version'])
    : await checkCommand('ffmpeg -version');
  const fp = fpAbs
    ? await checkCommandPath(fpPath, ['-version'])
    : await checkCommand('ffprobe -version');
  items.push({
    id: 'ffmpeg', name: 'FFmpeg / FFprobe（Step6 编码压缩 + 媒体校验）', required: true,
    ok: ff.ok && fp.ok,
    detail: `${ff.detail}${fp.ok ? '' : ' / ffprobe 缺失'}`,
    fix: 'winget install Gyan.FFmpeg 或 scoop install ffmpeg 或 choco install ffmpeg（需 ffmpeg + ffprobe 同时可用），或在 .env 中配置 FFMPEG_PATH / FFPROBE_PATH 绝对路径',
  });

  // 8. Remotion 依赖
  const remotionOk = fs.existsSync(path.join(ROOT, 'remotion', 'node_modules', 'remotion'));
  items.push({
    id: 'remotion', name: 'Remotion 依赖（Step5 合成渲染）', required: true,
    ok: remotionOk, detail: remotionOk ? 'remotion/node_modules 已就绪' : 'remotion/node_modules 缺失',
    fix: 'cd remotion && npm install（启动脚本会带 --autofix 自动安装；首次渲染会自动下载 Headless Chrome）',
    autofix: 'remotion-install',
  });

  // 9. LivePortrait 本地推理（可选；只有选择 avatarProvider=liveportrait 才必需）
  const lp = liveportrait.readySummary();
  const lpPyOk = lp.repo && lp.inference ? await liveportrait.checkPythonDeps().then((r) => r.ok).catch(() => false) : false;
  const lpReady = lp.repo && lp.inference && lp.weightsReady && lpPyOk;
  items.push({
    id: 'liveportrait', name: 'LivePortrait 本地推理（Step3 可选数字人 provider）', required: false,
    ok: lpReady, warn: !lpReady,
    detail: !lp.repo
      ? '未找到 LivePortrait/ 目录（按本项目文档集成后启用本地数字人；本项可选）'
      : !lp.inference
        ? 'LivePortrait/inference.py 缺失，仓库可能未完整克隆'
        : !lp.weightsReady
          ? `预训练权重未就绪（缺失 ${lp.weightsMissing.length}/${liveportrait.LP_REQUIRED_WEIGHTS ? 9 : 9} 个）。运行：huggingface-cli download KlingTeam/LivePortrait --local-dir pretrained_weights --exclude "*.git*" "README.md" "docs"`
          : !lpPyOk
            ? 'Python 依赖未就绪：在 LivePortrait 目录下 conda create -n LivePortrait python=3.10 && conda activate LivePortrait && pip install -r requirements.txt，然后在 .env 配置 LIVEPORTRAIT_PYTHON=python 可执行路径'
            : 'LivePortrait 权重 + Python 依赖都已就绪，可作为数字人 provider 选用',
  });

  // 10. LatentSync 本地口型同步（可选；avatarProvider=latentsync 或 lpLipSync 串联时才必需）
  const ls = latentsync.readySummary();
  const lsPyOk = ls.repo && ls.venv ? await latentsync.checkPythonDeps().then((r) => r.ok).catch(() => false) : false;
  const lsReady = ls.ready && lsPyOk;
  items.push({
    id: 'latentsync', name: 'LatentSync 1.5 本地口型同步（可选数字人 provider）', required: false,
    ok: lsReady, warn: !lsReady,
    detail: !ls.repo
      ? '未找到 LatentSync/ 目录。安装：powershell -File scripts/install-latentsync.ps1（含克隆代码@1.5、venv、依赖与权重下载）'
      : !ls.venv
        ? 'venv 未创建。运行：bash scripts/install-latentsync-deps.sh（或 scripts/install-latentsync.ps1）'
        : !ls.unet || !ls.whisper
          ? `权重未就绪（${ls.unet ? '' : 'latentsync_unet.pt(~4.7GB) '}${ls.whisper ? '' : 'whisper/tiny.pt'}缺失）。运行：bash scripts/dl-latentsync-weights.sh`
          : !lsPyOk
            ? 'Python 依赖未就绪：bash scripts/install-latentsync-deps.sh（torch2.5.1+cu121 等见 LatentSync/requirements.txt）'
            : 'LatentSync 1.5 权重 + venv 依赖就绪，可对口型同步（需约 8GB 显存）',
  });

  const ok = items.filter((i) => i.required).every((i) => i.ok);
  return { ok, deep, checkedAt: new Date().toISOString(), items };
}

/** 自动修复项（目前仅 remotion 依赖安装） */
async function runAutofix(fixId) {
  if (fixId !== 'remotion-install') return { ok: false, error: `未知修复项：${fixId}` };
  const r = await execChild('npm install', [], {
    shell: true, cwd: path.join(ROOT, 'remotion'), timeoutMs: 15 * 60 * 1000,
    logFile: path.join(ROOT, 'logs', 'remotion_install.log'),
  });
  return { ok: r.code === 0, code: r.code, log: 'logs/remotion_install.log', tail: (r.stdout || r.stderr || '').slice(-800) };
}

module.exports = { runEnvCheck, runAutofix };
