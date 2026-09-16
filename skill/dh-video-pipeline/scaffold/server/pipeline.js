'use strict';
/**
 * 数字人视频流水线执行器
 * Step1 Codex文案 → Step2 MiniMax TTS → Step3 HeyGen数字人
 *   → Step4 Codex字幕 → Step5 Remotion合成 → Step6 FFmpeg压缩
 * 严格串行：任一步失败立即终止；支持从任意步骤重试/重跑。
 */
const fs = require('fs');
const path = require('path');
const {
  ROOT, OUTPUT_DIR, LOGS_DIR, REMOTION_DIR, STATE_FILE,
  getEnv, ensureDirs, nowIso, logLine, readJson, writeJsonAtomic,
  exists, fsize, fmtBytes, execChild, errTail, killAllChilds,
  ffprobeCmd, ffmpegCmd, ffprobeDuration, parseSrt, serializeSrt, estimateF0,
} = require('./utils');
const heygen = require('./heygen_mcp');
const liveportrait = require('./liveportrait');
const latentsync = require('./latentsync');
const { runPiAgent } = require('./pi_runner.cjs');

/* ---------------- 常量与预设 ---------------- */

const STEPS = [
  { id: 0, key: 'clone', name: 'MiniMax 音色克隆（可选）', output: 'logs/cloned_voice.json' },
  { id: 1, key: 'brief', name: '人工需求输入', output: 'logs/human_brief.txt' },
  { id: 2, key: 'script', name: 'Codex 生成口播文案', output: 'output/01_script.txt' },
  { id: 3, key: 'review', name: '人工审稿（编辑/确认）', output: 'output/01_script.txt' },
  { id: 4, key: 'tts', name: 'MiniMax TTS 配音', output: 'output/02_audio.wav' },
  { id: 5, key: 'heygen', name: 'HeyGen 数字人视频', output: 'output/03_heygen_raw.mp4' },
  { id: 6, key: 'subtitle', name: 'Codex 字幕+时间轴', output: 'output/04_subtitle.srt' },
  { id: 7, key: 'remotion', name: 'Remotion 合成渲染', output: 'output/05_remotion_composed.mp4' },
  { id: 8, key: 'ffmpeg', name: 'FFmpeg 编码压缩', output: 'output/06_final_video.mp4' },
];
const CLONE_CACHE = path.join(LOGS_DIR, 'cloned_voice.json');
let currentFromStep = 0; // 当前 executeFrom 的起点（人工步骤据此判断重跑场景复用已确认内容）

const VOICES = [
  { id: 'Chinese (Mandarin)_Warm_Girl', label: '中文 · 温暖女声 Warm Girl' },
  { id: 'Chinese (Mandarin)_Gentleman', label: '中文 · 绅士男声 Gentleman' },
  { id: 'Chinese (Mandarin)_News_Anchor', label: '中文 · 新闻主播 News Anchor' },
  { id: 'Chinese (Mandarin)_Male_Announcer', label: '中文 · 男播音员 Male Announcer' },
  { id: 'Chinese (Mandarin)_Mature_Woman', label: '中文 · 成熟知性女性' },
  { id: 'Chinese (Mandarin)_Sweet_Lady', label: '中文 · 甜美女声 Sweet Lady' },
  { id: 'Chinese (Mandarin)_Southern_Young_Man', label: '中文 · 南方青年男声' },
  { id: 'male-qn-qingse', label: '中文 · 青涩青年男声' },
  { id: 'male-qn-jingying', label: '中文 · 精英青年男声' },
  { id: 'male-qn-badao', label: '中文 · 霸道青年男声' },
  { id: 'male-qn-daxuesheng', label: '中文 · 大学生男声' },
  { id: 'female-shaonv', label: '中文 · 少女女声' },
  { id: 'female-yujie', label: '中文 · 御姐女声' },
  { id: 'female-chengshu', label: '中文 · 成熟女声' },
  { id: 'female-tianmei', label: '中文 · 甜美女声' },
  { id: 'English_expressive_narrator', label: 'English · Expressive Narrator' },
];

const RESOLUTIONS = [
  { id: '1080x1920', label: '1080×1920 竖屏 9:16（抖音/快手/视频号，推荐）' },
  { id: '720x1280', label: '720×1280 竖屏 9:16（小文件）' },
  { id: '1920x1080', label: '1920×1080 横屏 16:9（B站/YouTube）' },
  { id: '1080x1080', label: '1080×1080 方形 1:1' },
];

const QUALITIES = [
  { id: 'high', label: '高清优先（CRF 20）', crf: 20, preset: 'medium' },
  { id: 'balanced', label: '均衡（CRF 23）', crf: 23, preset: 'medium' },
  { id: 'small', label: '小体积（CRF 27）', crf: 27, preset: 'veryfast' },
];

const STYLES = [
  '抖音快节奏涨粉', '知识科普讲解', '产品种草介绍', '热点观点评论', 'B站中速讲解', '自定义（见附加要求）',
];

/** 素材库分类体系（本地目录 ./materials/<id>/） */
const MATERIAL_CATEGORIES = [
  { id: 'voice', name: '原始录音', icon: '🎙️', dir: 'materials/voice', exts: ['m4a', 'mp3', 'wav', 'aac', 'ogg'],
    desc: '音色克隆源录音（≥10 秒清晰人声）', hint: '用于 Step0 声音复刻：建议 10s-5min 单人清晰口播；上传后在「新建任务」的克隆源下拉可直接选用' },
  { id: 'photo', name: '数字人照片', icon: '🧑', dir: 'materials/photo', exts: ['jpg', 'jpeg', 'png', 'webp'],
    desc: 'HeyGen 照片数字人形象参考', hint: '正面清晰、光线良好的人物照；可用于在 HeyGen 创建照片数字人后同步到形象列表' },
  { id: 'image', name: '图片素材', icon: '🖼️', dir: 'materials/image', exts: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg'],
    desc: '背景图 / 贴片 / 封面', hint: '建议 ≥1080p；当前版本入库保存，供后续画面合成版本使用' },
  { id: 'audio', name: '音乐 / 音效', icon: '🎵', dir: 'materials/audio', exts: ['mp3', 'wav', 'm4a', 'ogg', 'flac'],
    desc: '背景音乐与音效', hint: 'MP3/WAV/M4A；当前版本入库保存，供后续配音混音版本使用' },
  { id: 'video', name: '视频素材', icon: '🎬', dir: 'materials/video', exts: ['mp4', 'mov', 'webm'],
    desc: '片头 / 背景 / B-roll', hint: 'MP4/MOV/WebM；当前版本入库保存，供后续合成版本使用' },
  { id: 'doc', name: '文案 / 参考', icon: '📄', dir: 'materials/doc', exts: ['txt', 'md', 'srt', 'json'],
    desc: '文案草稿、参考资料', hint: 'TXT/MD/SRT/JSON；可在 Step1 人工需求输入时引用内容' },
  { id: 'other', name: '其他', icon: '📦', dir: 'materials/other', exts: [],
    desc: '未分类素材', hint: '任意格式' },
];

/* ---------------- 状态 ---------------- */

function defaultState() {
  return {
    version: 1, runId: null, status: 'idle', params: null, currentStep: 0,
    steps: [], ctx: {}, startedAt: null, finishedAt: null, lastError: null, history: [],
  };
}
let state = null;
function getState() {
  if (!state) state = { ...defaultState(), ...readJson(STATE_FILE, {}) };
  if (!Array.isArray(state.steps)) state.steps = [];
  if (!state.ctx) state.ctx = {};
  if (!Array.isArray(state.history)) state.history = [];
  return state;
}
function saveState() { ensureDirs(); writeJsonAtomic(STATE_FILE, state); }

function freshStep(s) {
  return { id: s.id, key: s.key, name: s.name, output: s.output, status: 'pending', startedAt: null, endedAt: null, durSec: null, error: null, meta: {}, progress: null };
}

/* ---------------- 参数校验 ---------------- */

function cleanStr(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function normalizeParams(input = {}) {
  const topic = cleanStr(input.topic, 600);
  if (topic.length < 2) return { error: '请填写视频主题（至少 2 个字）' };

  const durationSec = Math.min(600, Math.max(5, parseInt(input.durationSec, 10) || 60));
  const language = input.language === 'en' ? 'en' : 'zh';
  const speed = Math.min(2, Math.max(0.5, Math.round((parseFloat(input.speed) || 1) * 100) / 100));

  let voice = cleanStr(input.voice, 80);
  if (!voice) voice = language === 'en' ? 'English_expressive_narrator' : 'Chinese (Mandarin)_Warm_Girl';
  if (!/^[\w\s()\-.'\u4e00-\u9fa5]+$/.test(voice)) return { error: 'TTS 音色 ID 含有非法字符' };

  const avatarId = cleanStr(input.avatarId, 80);
  // 数字人 provider：heygen（云端） / liveportrait（本地源人像+驱动视频，无口型） / latentsync（本地口型同步）
  const avatarProvider = ['heygen', 'liveportrait', 'latentsync'].includes(input.avatarProvider) ? input.avatarProvider : 'heygen';
  const lpSource = cleanStr(input.lpSource, 200) || 'resources/photo1.jpg';
  // 默认驱动：d0.mp4 是仓库官方推荐的 driving video 示范（真人说话动作，不是循环表情）
  // 仓库里的 .pkl 都是「单表情短循环」（wink/laugh/眨眼），不适合口播；只有 .mp4 才是自然动作
  const lpDriving = cleanStr(input.lpDriving, 200) || 'd0.mp4';
  // LivePortrait + LatentSync 串联：LP 出画面后 LS 对口型（完整本地链路，需两者都就绪）
  const lpLipSync = avatarProvider === 'liveportrait' && input.lpLipSync === true;
  // LatentSync 直连：驱动视频必填（真人正面口播 mp4 最佳）
  const lsVideo = cleanStr(input.lsVideo, 200);
  const lsInferenceSteps = Math.min(50, Math.max(10, Number(input.lsInferenceSteps) || 20));
  const lsGuidanceScale = Math.min(3.0, Math.max(1.0, Number(input.lsGuidanceScale) || 3.0)); // 默认 3.0：口型跟随实测显著更强
  if (avatarProvider === 'heygen' && avatarId.length < 2) return { error: '请填写 HeyGen 数字人 Avatar ID（可在 .env 中配置默认值 HEYGEN_AVATAR_ID）' };
  if (avatarProvider === 'liveportrait' && !lpSource) return { error: 'LivePortrait 需要选择源人像（resources/photo1.jpg 或上传到 materials/）' };
  if (avatarProvider === 'liveportrait' && !lpDriving) return { error: 'LivePortrait 需要选择驱动视频：推荐 d0.mp4（仓库示例）或上传你拍的真人说话 mp4。仓库里的 .pkl 都是「单表情短循环」，不适合做口播；如必须用 .pkl 可选 d5/wink/d1-d8' };
  if (avatarProvider === 'latentsync' && !lsVideo) return { error: 'LatentSync 需要驱动视频：一段含清晰正面人脸的口播 mp4（可上传到素材库 video 分类后选择）。提示：若想用「照片数字人」请选 LivePortrait 并勾选口型同步，会自动串联 LatentSync' };

  const resMatch = /^(\d{3,4})x(\d{3,4})$/.exec(String(input.resolution || ''));
  if (!resMatch) return { error: '输出分辨率参数不合法' };
  const width = +resMatch[1]; const height = +resMatch[2];

  const quality = QUALITIES.some((q) => q.id === input.quality) ? input.quality : 'balanced';
  const style = cleanStr(input.style, 60) || '知识科普讲解';
  const showTitleBar = !!input.showTitleBar;
  const titleText = cleanStr(input.titleText, 40) || topic.slice(0, 18);
  const showProgressBar = input.showProgressBar !== false;
  const watermark = cleanStr(input.watermark, 24);
  const extra = cleanStr(input.extra, 2000);
  // 运行范围：full=完整；script=到文案；tts=到配音；audio=到字幕（后三者不耗 HeyGen credit）
  const runMode = ['full', 'script', 'tts', 'audio'].includes(input.runMode) ? input.runMode : 'full';
  // 人工环节：需求输入（Step1）与文稿审稿（Step3）
  const manualBrief = input.manualBrief !== false;
  const manualReview = input.manualReview !== false;

  // 音色克隆（Step0，可选）
  const useCloneVoice = !!input.useCloneVoice;
  const cloneSource = cleanStr(input.cloneSource, 200) || 'resources/voice1.m4a';
  let cloneVoiceId = cleanStr(input.cloneVoiceId, 60).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (useCloneVoice && !cloneVoiceId) cloneVoiceId = `voice_${Date.now().toString(36)}`;

  return {
    params: {
      topic, durationSec, language, speed, voice, avatarId,
      avatarProvider, lpSource, lpDriving, lpLipSync,
      lsVideo, lsInferenceSteps, lsGuidanceScale,
      resolution: `${width}x${height}`, width, height, quality, style,
      showTitleBar, titleText, showProgressBar, watermark, extra,
      useCloneVoice, cloneSource, cloneVoiceId, runMode, manualBrief, manualReview,
    },
  };
}

/* ---------------- 归档与清理 ---------------- */

const TEMP_OUTPUTS = ['01_script.txt', '02_audio.wav', '03_heygen_raw.mp4', '04_subtitle.srt', '05_remotion_composed.mp4'];

function archiveOutputs() {
  ensureDirs();
  const hasAny = TEMP_OUTPUTS.concat(['06_final_video.mp4']).some((f) => exists(path.join(OUTPUT_DIR, f)));
  if (!hasAny) return;
  const dir = path.join(OUTPUT_DIR, 'archive', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  for (const f of TEMP_OUTPUTS.concat(['06_final_video.mp4'])) {
    const src = path.join(OUTPUT_DIR, f);
    if (exists(src)) { try { fs.renameSync(src, path.join(dir, f)); } catch (_) {} }
  }
  logLine(`[ARCHIVE] 上一轮产物已归档至 ${path.relative(ROOT, dir)}`);
}

/** 清理临时产物，保留最终视频（交互规则第 4 条） */
function cleanupOutputs() {
  ensureDirs();
  const deleted = [];
  for (const f of TEMP_OUTPUTS) {
    const p = path.join(OUTPUT_DIR, f);
    if (fsize(p) > 0) { fs.rmSync(p, { force: true }); deleted.push(`output/${f}`); }
  }
  for (const f of ['remotion_props.json', 'remotion_progress.txt', 'step2_last_message.txt', 'step2_codex.log', 'step2_puck.log', 'step6_last_message.txt', 'step6_subtitle.log', 'step6_puck.log', 'human_brief.txt', 'f0_source.wav', 'f0_probe.wav', 'clone_upload_padded.m4a', 'heygen_progress.txt']) {
    const p = path.join(LOGS_DIR, f);
    if (fsize(p) > 0) { fs.rmSync(p, { force: true }); deleted.push(`logs/${f}`); }
  }
  const publicVideo = path.join(REMOTION_DIR, 'public', 'video.mp4');
  if (fsize(publicVideo) > 0) { fs.rmSync(publicVideo, { force: true }); deleted.push('remotion/public/video.mp4'); }
  logLine(`[CLEANUP] 已清理 ${deleted.length} 个临时文件（保留 output/06_final_video.mp4）`);
  return { deleted, kept: exists(path.join(OUTPUT_DIR, '06_final_video.mp4')) ? 'output/06_final_video.mp4' : null };
}

/* ---------------- AI 文本生成（puck 优先 / codex fallback） ---------------- */

/** 清洗 codex 非交互 stdout：去掉 ANSI 码、流式分隔符「codex」、tokens used 尾巴，修复被拆行的 SRT 时间戳 */
function cleanCodexOutput(raw) {
  let t = String(raw || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const lines = t.split(/\r?\n/).filter((l) => {
    const s = l.trim();
    if (s === 'codex' || s === 'tokens used') return false;
    if (/^[\d,]+$/.test(s) && s.includes(',')) return false; // tokens used 的计数行
    return true;
  });
  t = lines.join('\n');
  // 修复被流式分隔打断的时间轴："00:00:16,700 -\n-> 00:00:18,300"
  t = t.replace(/ -\s*\r?\n\s*->\s*/g, ' --> ');
  return t.trim();
}

/** codex CLI 旧路径（fallback 用，已弃用但保留以便 puck 失败时降级） */
async function runCodexCli(promptText, lastMessageName, logName, timeoutMs) {
  const env = getEnv();
  const lastFile = path.join(LOGS_DIR, lastMessageName);
  try { fs.rmSync(lastFile, { force: true }); } catch (_) {}
  const args = [
    'exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only',
  ];
  if (env.CODEX_MODEL) args.push('-m', env.CODEX_MODEL);
  args.push('-o', `logs/${lastMessageName}`, '-');
  const r = await execChild('codex', args, {
    shell: true, input: promptText, timeoutMs: timeoutMs || Number(env.CODEX_TIMEOUT_MS || 10 * 60 * 1000),
    logFile: path.join(LOGS_DIR, logName),
  });
  if (r.code !== 0) {
    throw new Error(`codex exec 退出码 ${r.code}${r.killed ? '（超时被终止）' : ''}。${errTail(r.stderr || r.stdout)}`);
  }
  let text = '';
  try { text = fs.readFileSync(lastFile, 'utf8'); } catch (_) {}
  // 兜底：codex 长输出可能拆成多条流式消息，-o 只含末段；用清洗后的完整 stdout 补齐
  const stdoutClean = cleanCodexOutput(r.stdout);
  if (!text.trim() || text.trim().length < Math.min(200, stdoutClean.length)) text = stdoutClean;
  return text.trim();
}

/** 主入口：puck 优先，puck 失败自动回退 codex CLI（已弃用）。
 *  签名与旧 runCodex 完全一致，Step2/Step6 调用点零改动。
 *  @param {string} promptText      user message 正文（不含 system 部分）
 *  @param {string} lastMessageName 落盘文件名（"step2_last_message.txt"）
 *  @param {string} logName         进程日志文件名（"step2_puck.log"，puck 失败时改为 codex 兼容 logName）
 *  @param {number} timeoutMs       超时
 *  @param {string} [systemPrompt]  可选 system 角色（agent 范式拆分）
 */
async function runCodex(promptText, lastMessageName, logName, timeoutMs, systemPrompt) {
  // 1) 主路径：puck SDK
  try {
    const text = await runPiAgent(promptText, systemPrompt || '', lastMessageName, logName, undefined, timeoutMs);
    return text;
  } catch (puckErr) {
    // 2) Fallback：codex CLI（已弃用，保留仅作应急）
    logLine(`[RUN ${state.runId}] [AI] ⚠️ puck 失败，自动回退 codex CLI（已弃用）：${String(puckErr.message || puckErr).split('\n')[0]}`);
    try {
      return await runCodexCli(promptText, lastMessageName, logName, timeoutMs);
    } catch (codexErr) {
      // 3) 都失败：抛聚合错误（puck 错 + codex 错）
      const msg = `puck 与 codex 均失败。\npuck: ${String(puckErr.message || puckErr)}\ncodex: ${String(codexErr.message || codexErr)}`;
      throw new Error(msg);
    }
  }
}


function stripFences(text) {
  let t = String(text || '').trim();
  const m = t.match(/^```[a-zA-Z]*\r?\n([\s\S]*?)\r?\n```$/);
  if (m) t = m[1].trim();
  return t;
}

/* ---------------- 各步骤实现 ---------------- */

/** MiniMax API Key：.env → secrets → ~/.mmx/config.json */
function minimaxKey() {
  const env = getEnv();
  if (env.MINIMAX_API_KEY) return { key: env.MINIMAX_API_KEY, base: (env.MINIMAX_REGION === 'global' ? 'https://api.minimax.io' : 'https://api.minimaxi.com') };
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(require('os').homedir(), '.mmx', 'config.json'), 'utf8'));
    if (cfg.api_key) return { key: cfg.api_key, base: cfg.region === 'global' ? 'https://api.minimax.io' : 'https://api.minimaxi.com' };
  } catch (_) {}
  return null;
}

/** Step0（可选）：MiniMax 音色克隆 —— 上传原始录音 → /v1/voice_clone → 缓存 voice_id
 *  已克隆过（logs/cloned_voice.json 与目标 ID 一致）则直接复用跳过；
 *  录音不足 10s 自动补静音到 12.5s（MiniMax 克隆下限 10s）。 */
async function stepClone(p, ctx) {
  if (!p.useCloneVoice) return { skipped: true, note: '未启用克隆音色（使用预设/自定义音色）' };

  const cache = readJson(CLONE_CACHE, null);
  if (cache && cache.voice_id === p.cloneVoiceId) {
    ctx.clonedVoiceId = cache.voice_id;
    return { skipped: true, note: `已有克隆音色 ${cache.voice_id}（${String(cache.created_at || '').slice(0, 19)} 克隆自 ${cache.source}），直接复用；如需重新克隆请删除 logs/cloned_voice.json` };
  }

  const srcAbs = path.join(ROOT, p.cloneSource);
  if (!fsize(srcAbs)) throw new Error(`原始录音不存在：${p.cloneSource}（可在表单中修改路径，或把录音放到 materials/ 后填写 materials/xxx.m4a）`);
  let dur = await ffprobeDuration(srcAbs);
  if (!dur) throw new Error(`无法读取录音时长（ffprobe 失败）：${p.cloneSource}`);

  // 不足 10s 自动补静音
  let uploadAbs = srcAbs;
  if (dur < 10.5) {
    const padded = path.join(LOGS_DIR, 'clone_upload_padded.m4a');
    const pad = await execChild(ffmpegCmd(), ['-y', '-i', srcAbs, '-af', 'apad=pad_dur=4', '-t', '12.5', '-c:a', 'aac', '-b:a', '128k', path.relative(ROOT, padded)], { timeoutMs: 60 * 1000, logFile: path.join(LOGS_DIR, 'step0_pad.log') });
    if (pad.code !== 0 || !fsize(padded)) throw new Error(`录音仅 ${dur.toFixed(1)}s（低于 MiniMax 10s 下限），自动补静音失败：${errTail(pad.stderr, 300)}`);
    uploadAbs = padded;
    logLine(`[RUN ${state.runId}] [CLONE] 录音 ${dur.toFixed(1)}s 低于 10s 下限，已自动补静音至 12.5s`);
    dur = 12.5;
  }

  // 上传到 MiniMax 文件存储
  const up = await execChild('mmx', ['file', 'upload', '--file', path.relative(ROOT, uploadAbs).split(path.sep).join('/'), '--purpose', 'voice_clone', '--output', 'json', '--quiet', '--non-interactive'],
    { shell: true, timeoutMs: 5 * 60 * 1000, logFile: path.join(LOGS_DIR, 'step0_upload.log') });
  const fileId = String(up.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  if (up.code !== 0 || !/^\d+$/.test(fileId.trim())) {
    throw new Error(`录音上传 MiniMax 失败（退出码 ${up.code}）：${errTail(up.stderr || up.stdout, 300)}`);
  }
  logLine(`[RUN ${state.runId}] [CLONE] 录音已上传 file_id=${fileId.trim()}`);

  // 调用克隆接口
  const auth = minimaxKey();
  if (!auth) throw new Error('未找到 MiniMax API Key（.env MINIMAX_API_KEY 或 ~/.mmx/config.json）');
  const res = await fetch(`${auth.base}/v1/voice_clone`, {
    method: 'POST',
    headers: { authorization: `Bearer ${auth.key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ voice_id: p.cloneVoiceId, file_id: Number(fileId.trim()) }),
    signal: AbortSignal.timeout(120 * 1000),
  });
  const j = await res.json().catch(() => ({}));
  const st = (j && j.base_resp) || {};
  if (!res.ok || st.status_code !== 0) {
    // 已存在的音色 ID 视为成功（可直接用于 TTS）
    const msg = String(st.status_msg || '');
    if (/exist|已存在|duplicate/i.test(msg)) {
      writeJsonAtomic(CLONE_CACHE, { voice_id: p.cloneVoiceId, source: p.cloneSource, file_id: fileId.trim(), duration: dur, created_at: nowIso(), reused: true });
      ctx.clonedVoiceId = p.cloneVoiceId;
      return { meta: { voiceId: p.cloneVoiceId, source: p.cloneSource, note: '音色ID已存在于 MiniMax 账号，直接复用' } };
    }
    const hints = { 2013: '参数错误（检查录音格式/时长）', 2037: '录音时长不足 10s', 1004: '鉴权失败（检查 MINIMAX_API_KEY / mmx auth login）', 1027: '音色克隆权限未开通（需在 MiniMax 平台实名并开通声音复刻）' };
    throw new Error(`MiniMax 音色克隆失败（status_code=${st.status_code}）：${st.status_msg || res.status}。${hints[st.status_code] || ''}`);
  }

  writeJsonAtomic(CLONE_CACHE, { voice_id: p.cloneVoiceId, source: p.cloneSource, file_id: fileId.trim(), duration: dur, created_at: nowIso() });
  ctx.clonedVoiceId = p.cloneVoiceId;
  logLine(`[RUN ${state.runId}] [CLONE] ✅ 音色克隆成功 voice_id=${p.cloneVoiceId}（源 ${p.cloneSource}，file_id=${fileId.trim()}）`);

  // 克隆生效验证：用新音色合成探针，与源录音比对基频（防止未生效时静默回退默认音色）
  const meta = { voiceId: p.cloneVoiceId, fileId: fileId.trim(), source: p.cloneSource, duration: Math.round(dur * 10) / 10 };
  try {
    const srcWav = path.join(LOGS_DIR, 'f0_source.wav');
    const probeWav = path.join(LOGS_DIR, 'f0_probe.wav');
    await execChild(ffmpegCmd(), ['-y', '-i', srcAbs, '-ac', '1', '-ar', '16000', path.relative(ROOT, srcWav)], { timeoutMs: 30 * 1000 });
    const pv = await execChild('mmx', ['speech', 'synthesize', '--text-file', '-', '--model', (getEnv().MINIMAX_TTS_MODEL || 'speech-2.8-hd'), '--voice', p.cloneVoiceId, '--format', 'wav', '--sample-rate', '16000', '--out', path.relative(ROOT, probeWav), '--non-interactive', '--quiet'], { shell: true, input: '声音克隆验证测试。', timeoutMs: 90 * 1000, logFile: path.join(LOGS_DIR, 'step0_probe.log') });
    const f0s = estimateF0(srcWav); const f0p = estimateF0(probeWav);
    if (f0s && f0p) {
      meta.f0Source = f0s; meta.f0Probe = f0p;
      const ratio = f0p / f0s;
      if (ratio > 1.5 || ratio < 0.67) {
        meta.warning = `克隆音色基频(${f0p}Hz)与源录音(${f0s}Hz)差异较大，克隆可能未完全生效；若 Step2 配音听起来像默认音色，请等待 1-2 分钟后从 Step2 重跑`;
        logLine(`[RUN ${state.runId}] [CLONE] ⚠️ 基频验证不匹配：源 ${f0s}Hz / 探针 ${f0p}Hz`);
      } else {
        meta.verified = true;
        logLine(`[RUN ${state.runId}] [CLONE] 基频验证通过：源 ${f0s}Hz / 探针 ${f0p}Hz`);
      }
    }
  } catch (_) { /* 验证失败不影响主流程 */ }
  return { meta };
}

/** Step1：人工需求输入（暂停等待用户确认，写入 logs/human_brief.txt） */
async function stepBrief(p, ctx) {
  const briefFile = path.join(LOGS_DIR, 'human_brief.txt');
  if (currentFromStep > 1 && exists(briefFile)) {
    ctx.humanBrief = fs.readFileSync(briefFile, 'utf8');
    return { skipped: true, note: '复用已确认的需求（logs/human_brief.txt，重跑场景）' };
  }
  return { paused: true, waitingFor: 'brief', prefill: `${p.topic}${p.extra ? `\n【附加要求】${p.extra}` : ''}` };
}

async function stepScript(p, ctx) {
  const charsPerSec = 4.3 * (p.speed || 1);
  const target = Math.round(p.durationSec * charsPerSec);
  const brief = String(ctx.humanBrief || '').trim() || `${p.topic}${p.extra ? `\n【附加要求】${p.extra}` : ''}`;

  // agent 范式：system 放角色 + 风格 + 语言 + 硬性要求（不变），user 放具体 brief + 时长约束
  const systemPrompt = [
    '你是资深短视频口播文案编剧，为“数字人对镜口播”视频撰写文案。',
    `【内容风格】${p.style}`,
    `【语言】${p.language === 'en' ? 'English' : '简体中文口语'}`,
    '',
    '硬性要求：',
    '1. 只输出可直接口播的正文：不要标题、不要分镜/镜头指示、不要表情动作标注、不要任何解释或前后缀；',
    '2. 开头 3 秒必须有强钩子；口语化、有节奏、像真人对着镜头说话；',
    '3. 不虚构具体数据、统计、名人名言；',
    '4. 结尾视主题给一句自然的行动号召（点赞/关注/评论等）。',
  ].join('\n');
  const userPrompt = [
    `【人工需求（用户已确认）】\n${brief}`,
    `【目标时长】约 ${p.durationSec} 秒（中文语速约 ${charsPerSec.toFixed(1)} 字/秒，全文约 ${target} 字，允许 ±15%）`,
    '',
    '现在直接输出文案正文，除此之外一个字都不要多。',
  ].join('\n');

  const text = stripFences(await runCodex(userPrompt, 'step2_last_message.txt', 'step2_puck.log', undefined, systemPrompt));
  if (text.replace(/\s/g, '').length < 20) throw new Error(`生成的文案过短（${text.length} 字），请在「运行进度」页重试本步骤`);
  const outPath = path.join(OUTPUT_DIR, '01_script.txt');
  fs.writeFileSync(outPath, `${text.trim()}\n`, 'utf8');
  ctx.scriptChars = text.replace(/\s/g, '').length;
  return { meta: { chars: ctx.scriptChars, size: fsize(outPath) } };
}

/** Step3：人工审稿（暂停等待用户编辑/确认，确认后回写 output/01_script.txt） */
async function stepReview(p, ctx) {
  const scriptFile = path.join(OUTPUT_DIR, '01_script.txt');
  if (!exists(scriptFile)) throw new Error('缺少上游产物 output/01_script.txt，请从 Step2 重跑');
  if (currentFromStep > 3 && ctx.reviewConfirmed) {
    return { skipped: true, note: '文稿已人工确认过（重跑场景），直接复用 output/01_script.txt' };
  }
  const content = fs.readFileSync(scriptFile, 'utf8');
  return { paused: true, waitingFor: 'review', prefill: content };
}

async function stepTts(p, ctx) {
  const env = getEnv();
  const scriptPath = path.join(OUTPUT_DIR, '01_script.txt');
  if (!exists(scriptPath)) throw new Error('缺少上游产物 output/01_script.txt，请从 Step2 重跑');
  const script = fs.readFileSync(scriptPath, 'utf8').trim();
  if (!script) throw new Error('output/01_script.txt 为空');

  const model = (env.MINIMAX_TTS_MODEL || 'speech-2.8-hd').trim();
  // 优先使用 Step0 克隆出的音色
  const useVoice = (p.useCloneVoice && ctx.clonedVoiceId) ? ctx.clonedVoiceId : p.voice;
  const outRel = 'output/02_audio.wav';
  const args = [
    'speech', 'synthesize',
    '--text-file', '-',
    '--model', model,
    '--voice', useVoice,
    '--speed', String(p.speed),
    '--format', 'wav',
    '--sample-rate', '32000',
    '--out', outRel,
    '--non-interactive', '--quiet',
  ];
  const r = await execChild('mmx', args, {
    shell: true, input: script, timeoutMs: Number(env.MINIMAX_TTS_TIMEOUT_MS || 15 * 60 * 1000),
    logFile: path.join(LOGS_DIR, 'step4_tts.log'),
  });
  const outAbs = path.join(ROOT, outRel);
  if (r.code !== 0 || !exists(outAbs)) {
    const hints = {
      3: '认证失败：请执行 mmx auth login --api-key <密钥>（密钥见 secrets/.api_keys.json），或在 .env 中配置 MINIMAX_API_KEY',
      4: 'MiniMax 额度不足：请执行 mmx quota 查看余额并充值',
    };
    throw new Error(`mmx TTS 失败（退出码 ${r.code}）${r.killed ? '，超时被终止' : ''}。${hints[r.code] || ''} ${errTail(r.stderr || r.stdout)}`);
  }
  const dur = await ffprobeDuration(outAbs);
  if (dur == null || dur < 0.5) throw new Error(`TTS 音频异常（时长 ${dur}s，大小 ${fmtBytes(fsize(outAbs))}），请重试本步骤`);
  ctx.audioDuration = Math.round(dur * 1000) / 1000;
  return { meta: { duration: ctx.audioDuration, size: fsize(outAbs), model, voice: useVoice, cloned: useVoice !== p.voice } };
}

/** Step3：数字人视频（provider 分派）
 *  - HeyGen（云端，OAuth + Remote MCP）：上传配音 → create_video → 轮询 → 下载
 *  - LivePortrait（本地 PyTorch 推理）：源人像 + 驱动视频 → 推理 → ffmpeg 合成 TTS 配音
 */
async function stepHeygen(p, ctx) {
  const audioAbs = path.join(OUTPUT_DIR, '02_audio.wav');
  if (!exists(audioAbs)) throw new Error('缺少上游产物 output/02_audio.wav，请从 Step4 重跑');

  if (p.avatarProvider === 'liveportrait') {
    return stepLivePortrait(p, ctx, audioAbs);
  }
  if (p.avatarProvider === 'latentsync') {
    return stepLatentSync(p, ctx, audioAbs);
  }
  return stepHeygenRemote(p, ctx, audioAbs);
}

/** HeyGen Remote MCP：上传音频 → create_video → 轮询 → 下载
 *  官方 CLI 不支持 Windows（未签名 exe 被 Smart App Control 拦截），改用 Remote MCP + OAuth。 */
async function stepHeygenRemote(p, ctx, audioAbs) {
  const env = getEnv();
  const st = await heygen.getStatus();
  if (!st.connected) {
    throw new Error(`HeyGen 未连接：${st.error || '无有效令牌'}。请到控制台「环境检查」页点击「🔗 连接 HeyGen」完成 OAuth 授权后重试本步骤`);
  }
  logLine(`[RUN ${state.runId}] [HEYGEN] 上传配音音频（${fmtBytes(fsize(audioAbs))}）...`);
  const asset = await heygen.uploadAudio(audioAbs, 'audio/wav');
  logLine(`[RUN ${state.runId}] [HEYGEN] 音频上传完成 asset_id=${asset.asset_id}`);
  const created = await heygen.createAvatarVideo({
    avatarId: p.avatarId,
    audioUrl: asset.url,
    assetId: asset.asset_id,
    width: p.width,
    height: p.height,
    title: p.titleText || p.topic.slice(0, 30),
  });
  logLine(`[RUN ${state.runId}] [HEYGEN] 视频创建成功 video_id=${created.videoId}，开始轮询渲染状态...`);
  const timeoutMs = Number(env.HEYGEN_TIMEOUT_MS || 30 * 60 * 1000);
  const progressFile = path.join(LOGS_DIR, 'heygen_progress.txt');
  const v = await heygen.pollVideo(created.videoId, timeoutMs, (info) => {
    try { fs.writeFileSync(progressFile, `${info.status} · 已等待 ${info.elapsed}s`); } catch (_) {}
  });
  if (!v.video_url) throw new Error(`HeyGen 返回 ${v.status} 但缺少 video_url：${JSON.stringify(v).slice(0, 300)}`);
  const outAbs = path.join(OUTPUT_DIR, '03_heygen_raw.mp4');
  try { fs.rmSync(outAbs, { force: true }); } catch (_) {}
  await heygen.downloadFile(v.video_url, outAbs);
  if (!exists(outAbs)) throw new Error('HeyGen 视频下载失败（文件为空）');
  const dur = await ffprobeDuration(outAbs);
  if (dur == null || dur < 0.5) throw new Error(`HeyGen 视频异常（时长 ${dur}s，大小 ${fmtBytes(fsize(outAbs))}）`);
  ctx.videoDuration = Math.round(dur * 1000) / 1000;
  ctx.avatarProvider = 'heygen';
  return { meta: { videoId: created.videoId, duration: ctx.videoDuration, size: fsize(outAbs), avatar: p.avatarId, provider: 'heygen' } };
}

/** LatentSync 本地口型同步：驱动视频 + TTS 配音 → 对口型视频
 *  驱动视频优先级：表单 lsVideo（素材库/上传/本地路径） */
async function stepLatentSync(p, ctx, audioAbs) {
  const outAbs = path.join(OUTPUT_DIR, '03_heygen_raw.mp4');
  const progressFile = path.join(LOGS_DIR, 'latentsync_progress.txt');
  let cancelled = false;
  const startTs = Date.now();
  try { fs.writeFileSync(progressFile, 'LatentSync 加载模型中（首次会下载 sd-vae-ft-mse，约 1-2 分钟）…'); } catch (_) {}
  const ticker = setInterval(() => {
    if (cancelled) return;
    try { fs.writeFileSync(progressFile, `LatentSync 扩散推理中… 已等待 ${Math.round((Date.now() - startTs) / 1000)}s`); } catch (_) {}
  }, 5000);
  try {
    const r = await latentsync.runLipsync({
      video: p.lsVideo, audio: audioAbs, outPath: outAbs,
      width: p.width, height: p.height,
      inferenceSteps: p.lsInferenceSteps, guidanceScale: p.lsGuidanceScale,
      runId: `RUN ${state.runId}`, log: logLine,
    });
    cancelled = true; clearInterval(ticker);
    if (!r.duration || r.duration < 0.5) throw new Error(`LatentSync 视频异常（时长 ${r.duration}s，大小 ${fmtBytes(r.size)}）`);
    ctx.videoDuration = Math.round(r.duration * 1000) / 1000;
    ctx.avatarProvider = 'latentsync';
    return { meta: { duration: ctx.videoDuration, size: r.size, provider: 'latentsync', video: p.lsVideo, steps: r.steps, guidance: r.guidance } };
  } catch (e) {
    cancelled = true; clearInterval(ticker);
    throw e;
  }
}

/** LivePortrait 本地推理：源人像 + 驱动视频/模板 → LivePortrait → ffmpeg 合成 TTS 配音
 *  lpLipSync=true：LivePortrait 只出画面（不混音）→ LatentSync 对口型 → 完整本地链路 */
async function stepLivePortrait(p, ctx, audioAbs) {
  const env = getEnv();
  const timeoutMs = Number(env.LIVEPORTRAIT_TIMEOUT_MS || 30 * 60 * 1000);
  logLine(`[RUN ${state.runId}] [LIVEPORTRAIT] 启动本地推理：source=${p.lpSource} driving=${p.lpDriving}`);
  const outAbs = path.join(OUTPUT_DIR, '03_heygen_raw.mp4');
  // LivePortrait 不提供原生进度回调，用占位 progress 文件维持前端渲染
  const progressFile = path.join(LOGS_DIR, 'liveportrait_progress.txt');
  try { fs.writeFileSync(progressFile, 'LivePortrait 推理中（首跑会下载模型，约 1-3 分钟）'); } catch (_) {}
  let cancelled = false;
  const ticker = setInterval(() => {
    if (cancelled) return;
    try { fs.writeFileSync(progressFile, `LivePortrait 推理中… 已等待 ${Math.round((Date.now() - startTs) / 1000)}s`); } catch (_) {}
  }, 5000);
  const startTs = Date.now();
  let r;
  try {
    r = await liveportrait.runAvatar({
      source: p.lpSource, driving: p.lpDriving, audio: audioAbs,
      outPath: outAbs, width: p.width, height: p.height,
      runId: `RUN ${state.runId}`, log: logLine,
      noMux: p.lpLipSync === true, // 串联 LatentSync 时只出画面，音频由 LS 生成（避免二次混音）
    });
    cancelled = true;
    clearInterval(ticker);
    // 串联 LatentSync：对 LivePortrait 画面做音频口型同步，输出带音轨的最终视频
    if (p.lpLipSync === true && r.unmuxed) {
      logLine(`[RUN ${state.runId}] [LATENTSYNC] LivePortrait 画面完成，串联口型同步（steps=${p.lsInferenceSteps} guidance=${p.lsGuidanceScale}）…`);
      try { fs.writeFileSync(progressFile, 'LivePortrait 完成，LatentSync 口型同步中…'); } catch (_) {}
      const ls = await latentsync.runLipsync({
        video: r.lpOutput, audio: audioAbs, outPath: outAbs,
        width: p.width, height: p.height,
        inferenceSteps: p.lsInferenceSteps, guidanceScale: p.lsGuidanceScale,
        runId: `RUN ${state.runId}`, log: logLine,
      });
      ctx.videoDuration = Math.round(ls.duration * 1000) / 1000;
      ctx.avatarProvider = 'liveportrait+latentsync';
      return { meta: { duration: ctx.videoDuration, size: ls.size, provider: 'liveportrait+latentsync', source: p.lpSource, driving: p.lpDriving, lpOutput: r.lpOutput, steps: ls.steps, guidance: ls.guidance } };
    }
    const dur = r.duration;
    if (dur == null || dur < 0.5) throw new Error(`LivePortrait 视频异常（时长 ${dur}s，大小 ${fmtBytes(r.size)}）`);
    ctx.videoDuration = Math.round(dur * 1000) / 1000;
    ctx.avatarProvider = 'liveportrait';
    return { meta: { duration: ctx.videoDuration, size: r.size, provider: 'liveportrait', source: p.lpSource, driving: p.lpDriving, lpOutput: r.lpOutput } };
  } catch (e) {
    cancelled = true;
    clearInterval(ticker);
    throw e;
  }
}

async function stepSubtitle(p, ctx) {
  const scriptPath = path.join(OUTPUT_DIR, '01_script.txt');
  const audioPath = path.join(OUTPUT_DIR, '02_audio.wav');
  if (!exists(scriptPath)) throw new Error('缺少上游产物 output/01_script.txt，请从 Step2 重跑');
  const script = fs.readFileSync(scriptPath, 'utf8').trim();

  let dur = ctx.audioDuration;
  if (!dur || !exists(audioPath)) dur = await ffprobeDuration(audioPath);
  if (!dur) throw new Error('无法获取音频时长（ffprobe 失败或缺少 output/02_audio.wav）');

  const prompt = [
    '你是字幕制作助手。把下面的口播文案切分为字幕条目，生成标准 SRT 字幕（数字人视频口播，画面与文案完全一致）。',
    `【音频总时长】${dur.toFixed(2)} 秒（时间轴必须从 00:00:00,000 开始，到 ${dur.toFixed(2)} 秒附近结束，均匀合理地按文字量分配时间）`,
    p.language === 'en'
      ? '【规则】每条字幕不超过 10 个英文单词，按语义断句。'
      : '【规则】每条字幕 1 行、不超过 18 个汉字，按语义断句。',
    '【格式】标准 SRT：序号从 1 开始；时间行形如 00:00:01,000 --> 00:00:04,200；最后一条结束时间不得超过音频总时长；时间单调递增不重叠。',
    '【输出】只输出 SRT 内容本身，不要解释、不要代码块、不要首尾空行以外的东西。',
    '',
    '【文案开始】',
    script,
    '【文案结束】',
  ].join('\n');

  // Step6 字幕 prompt 是「规则 + 文案」一整块上下文，结构上不易拆 system/user；保持原样整段作为 user 传
  let text = stripFences(await runCodex(prompt, 'step6_last_message.txt', 'step6_puck.log'));
  let cues = parseSrt(text);
  if (!cues.length) {
    // 兜底：截取第一个 "1\n00:00" 开始的片段
    const idx = text.search(/1\r?\n\d{2}:\d{2}:\d{2}/);
    if (idx >= 0) cues = parseSrt(text.slice(idx));
  }
  if (!cues.length) throw new Error('Codex 输出无法解析为 SRT，请在「运行进度」页重试本步骤');

  // 去重（流式输出可能重复末段）并按时间排序、修复重叠
  const seen = new Set();
  cues = cues.filter((c) => {
    const k = `${c.start.toFixed(2)}|${c.text}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start < cues[i - 1].end) cues[i - 1].end = Math.max(cues[i - 1].start + 0.2, cues[i].start);
  }
  // 条数合理性：防长音频只切出一两条字幕（输出被截断的信号）
  const minCues = dur > 20 ? Math.max(3, Math.floor(dur / 12)) : 2;
  if (cues.length < minCues) {
    throw new Error(`字幕条数过少（仅 ${cues.length} 条，音频 ${dur.toFixed(0)}s 至少应约 ${minCues} 条）：Codex 输出可能被截断，请在「运行进度」页重试本步骤`);
  }

  let prev = null;
  for (const c of cues) {
    if (c.end <= c.start) throw new Error(`字幕时间轴非法：第 ${cues.indexOf(c) + 1} 条 end<=start`);
    prev = c;
  }
  if (cues[cues.length - 1].end > dur + 1) {
    // 轻度越界：按比例缩放到音频时长
    const k = dur / cues[cues.length - 1].end;
    for (const c of cues) { c.start = Math.round(c.start * k * 1000) / 1000; c.end = Math.round(c.end * k * 1000) / 1000; }
  }
  const outPath = path.join(OUTPUT_DIR, '04_subtitle.srt');
  fs.writeFileSync(outPath, serializeSrt(cues), 'utf8');
  return { meta: { cues: cues.length, duration: dur } };
}

async function stepRemotion(p, ctx) {
  const videoPath = path.join(OUTPUT_DIR, '03_heygen_raw.mp4');
  const srtPath = path.join(OUTPUT_DIR, '04_subtitle.srt');
  if (!exists(videoPath)) throw new Error('缺少上游产物 output/03_heygen_raw.mp4，请从 Step5 重跑');
  if (!exists(srtPath)) throw new Error('缺少上游产物 output/04_subtitle.srt，请从 Step6 重跑');

  let dur = ctx.videoDuration;
  if (!dur) dur = await ffprobeDuration(videoPath);
  if (!dur) throw new Error('无法获取 HeyGen 视频时长（ffprobe 失败）');

  const cues = parseSrt(fs.readFileSync(srtPath, 'utf8'));
  if (!cues.length) throw new Error('output/04_subtitle.srt 解析不到字幕条目');

  ensureDirs();
  fs.copyFileSync(videoPath, path.join(REMOTION_DIR, 'public', 'video.mp4'));

  const props = {
    videoFile: 'video.mp4', cues,
    title: p.showTitleBar ? p.titleText : '',
    showTitleBar: !!p.showTitleBar,
    showProgressBar: !!p.showProgressBar,
    watermark: p.watermark || '',
    fps: 30, durationSeconds: dur, width: p.width, height: p.height,
  };
  const propsPath = path.join(LOGS_DIR, 'remotion_props.json');
  fs.writeFileSync(propsPath, JSON.stringify(props), 'utf8');
  const progressPath = path.join(LOGS_DIR, 'remotion_progress.txt');
  try { fs.rmSync(progressPath, { force: true }); } catch (_) {}

  const r = await execChild(process.execPath, [
    'render.mjs',
    path.relative(REMOTION_DIR, propsPath),
    path.relative(REMOTION_DIR, path.join(OUTPUT_DIR, '05_remotion_composed.mp4')),
    path.relative(REMOTION_DIR, path.join(LOGS_DIR, 'step7_remotion.log')),
    path.relative(REMOTION_DIR, progressPath),
  ], {
    cwd: REMOTION_DIR, timeoutMs: 45 * 60 * 1000,
    logFile: path.join(LOGS_DIR, 'step7_remotion_cli.log'),
  });

  const outAbs = path.join(OUTPUT_DIR, '05_remotion_composed.mp4');
  if (r.code !== 0 || !exists(outAbs)) {
    throw new Error(`Remotion 渲染失败（退出码 ${r.code}）${r.killed ? '，超时被终止' : ''}。详见 logs/step7_remotion.log。${errTail(r.stderr || r.stdout, 400)}`);
  }
  const outDur = await ffprobeDuration(outAbs);
  if (outDur == null || Math.abs(outDur - dur) > 5) throw new Error(`合成视频时长异常：期望≈${dur.toFixed(1)}s，实际 ${outDur}s`);
  return { meta: { duration: outDur, size: fsize(outAbs), resolution: p.resolution, cues: cues.length } };
}

async function stepFfmpeg(p) {
  const inRel = 'output/05_remotion_composed.mp4';
  if (!exists(path.join(ROOT, inRel))) throw new Error('缺少上游产物 output/05_remotion_composed.mp4，请从 Step7 重跑');
  const q = QUALITIES.find((x) => x.id === p.quality) || QUALITIES[1];

  const r = await execChild(ffmpegCmd(), [
    '-y', '-i', inRel,
    '-c:v', 'libx264', '-preset', q.preset, '-crf', String(q.crf),
    '-c:a', 'aac', '-b:a', '128k',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    'output/06_final_video.mp4',
  ], { timeoutMs: 20 * 60 * 1000, logFile: path.join(LOGS_DIR, 'step8_ffmpeg.log') });

  const outAbs = path.join(OUTPUT_DIR, '06_final_video.mp4');
  if (r.code !== 0 || !exists(outAbs)) {
    throw new Error(`FFmpeg 失败（退出码 ${r.code}）${r.killed ? '，超时被终止' : ''}。${errTail(r.stderr, 500)}`);
  }
  const dur = await ffprobeDuration(outAbs);
  return { meta: { duration: dur, size: fsize(outAbs), crf: q.crf, preset: q.preset } };
}

const STEP_IMPLS = { clone: stepClone, brief: stepBrief, script: stepScript, review: stepReview, tts: stepTts, heygen: stepHeygen, subtitle: stepSubtitle, remotion: stepRemotion, ffmpeg: stepFfmpeg };

/* ---------------- 运行控制 ---------------- */

let executing = false;

function beginStep(step) {
  const st = state.steps.find((s) => s.id === step.id);
  st.status = 'running'; st.startedAt = nowIso(); st.endedAt = null; st.durSec = null; st.error = null; st.meta = {}; st.progress = null;
  state.currentStep = step.id;
  saveState();
  logLine(`[RUN ${state.runId}] Step${step.id} ${step.name} ▶ 开始`);
}
function endStep(step, patch) {
  const st = state.steps.find((s) => s.id === step.id);
  st.endedAt = nowIso();
  if (st.startedAt) st.durSec = Math.round((new Date(st.endedAt) - new Date(st.startedAt)) / 100) / 10;
  Object.assign(st, patch);
  saveState();
  if (patch.status === 'done') logLine(`[RUN ${state.runId}] Step${step.id} ${step.name} ✅ 完成（${st.durSec}s，${patch.output || ''}${st.meta && st.meta.size ? '，' + fmtBytes(st.meta.size) : ''}）`);
  else if (patch.status === 'skipped') logLine(`[RUN ${state.runId}] Step${step.id} ${step.name} ⏭️ 跳过：${st.meta && st.meta.note ? st.meta.note : ''}`);
  else if (patch.status === 'failed') logLine(`[RUN ${state.runId}] Step${step.id} ${step.name} ❌ 失败：${st.error}`);
}
function pushHistory() {
  state.history.unshift({
    runId: state.runId, topic: state.params ? state.params.topic : '',
    status: state.status, startedAt: state.startedAt, finishedAt: state.finishedAt,
    finalSize: fsize(path.join(OUTPUT_DIR, '06_final_video.mp4')),
    resolution: state.params ? state.params.resolution : '',
  });
  state.history = state.history.slice(0, 20);
}

/** 运行范围规划：返回跳过原因，null 表示需要执行 */
function planSkip(step, p) {
  if (!p) return null;
  if (step.id === 0 && !p.useCloneVoice) return '未启用克隆音色（使用预设/自定义音色）';
  if (step.key === 'brief' && !p.manualBrief) return '未启用人工需求输入：直接使用表单主题与附加要求';
  if (step.key === 'review' && !p.manualReview) return '未启用人工审稿：直接使用 AI 原稿';
  if (p.runMode === 'audio') {
    if (step.key === 'heygen') return '调试模式（文案+配音+字幕）：跳过 HeyGen，节省 credit';
    if (step.key === 'remotion' || step.key === 'ffmpeg') return '调试模式：依赖 HeyGen 视频，已跳过';
  }
  if (p.runMode === 'script' && step.id >= 3) return '调试模式（仅生成文案）：后续步骤已跳过';
  if (p.runMode === 'tts' && step.id >= 5) return '调试模式（文案+配音）：后续步骤已跳过';
  return null;
}

async function executeFrom(fromStep) {
  executing = true;
  currentFromStep = fromStep;
  try {
    for (const step of STEPS.filter((s) => s.id >= fromStep)) {
      // 按运行范围跳过（Step0 未启用克隆 / 调试模式不跑 HeyGen 等）
      const skipNote = planSkip(step, state.params);
      if (skipNote) {
        const st = state.steps.find((x) => x.id === step.id);
        if (st) { Object.assign(st, { status: 'skipped', meta: { note: skipNote }, startedAt: null, endedAt: null, durSec: null }); saveState(); }
        logLine(`[RUN ${state.runId}] Step${step.id} ${step.name} ⏭️ 跳过：${skipNote}`);
        continue;
      }
      beginStep(step);
      try {
        const result = await STEP_IMPLS[step.key](state.params, state.ctx);
        if (result && result.paused) {
          // 人工环节：暂停流水线，等待 /api/human/confirm 确认后继续
          const st = state.steps.find((x) => x.id === step.id);
          if (st) st.status = 'waiting';
          state.waiting = { step: step.id, kind: result.waitingFor, prefill: result.prefill || '' };
          state.status = 'waiting';
          state.currentStep = step.id;
          saveState();
          logLine(`[RUN ${state.runId}] Step${step.id} ${step.name} ✍️ 等待人工确认（控制台「运行进度」页可编辑并确认）`);
          return;
        }
        if (result && result.skipped) endStep(step, { status: 'skipped', meta: { note: result.note || '' } });
        else endStep(step, { status: 'done', output: step.output, meta: result && result.meta ? result.meta : {} });
      } catch (e) {
        state.status = 'failed';
        state.lastError = String((e && e.message) || e);
        state.finishedAt = nowIso();
        endStep(step, { status: 'failed', error: state.lastError });
        pushHistory(); saveState();
        logLine(`[RUN ${state.runId}] ❌ 流水线在 Step${step.id} 终止：${state.lastError}`);
        return;
      }
    }
    state.status = 'success';
    state.finishedAt = nowIso();
    // 成功时 currentStep 指向最后一个非跳过的已执行步骤（runMode=audio 时为 Step6）
    const lastDone = [...state.steps].reverse().find((s) => s.status === 'done');
    state.currentStep = lastDone ? lastDone.id : null;
    pushHistory(); saveState();
    const finalSize = fsize(path.join(OUTPUT_DIR, '06_final_video.mp4'));
    logLine(`[RUN ${state.runId}] 🎉 全流程完成，成品 output/06_final_video.mp4（${fmtBytes(finalSize)}）`);
  } finally {
    executing = false;
  }
}

/** 人工确认（Step1 需求 / Step3 审稿）：保存内容并从下一处继续流水线（服务重启后仍可确认） */
function confirmHuman(stepId, content) {
  const st = getState();
  if (st.status !== 'waiting' || !st.waiting || st.waiting.step !== stepId) {
    return { error: '当前没有等待确认的该步骤（可能已确认或已停止）' };
  }
  const text = String(content == null ? '' : content).replace(/\r\n/g, '\n').trim();
  const stepDef = STEPS.find((x) => x.id === stepId);
  if (stepId === 1) {
    if (text.replace(/\s/g, '').length < 2) return { error: '需求内容为空：请填写主题/要点后确认' };
    ensureDirs();
    fs.writeFileSync(path.join(LOGS_DIR, 'human_brief.txt'), `${text}\n`, 'utf8');
    st.ctx.humanBrief = text;
    st.waiting = null;
    endStep(stepDef, { status: 'done', output: stepDef.output, meta: { chars: text.replace(/\s/g, '').length } });
    logLine(`[RUN ${st.runId}] Step1 人工需求已确认（${text.replace(/\s/g, '').length} 字）`);
  } else if (stepId === 3) {
    if (text.replace(/\s/g, '').length < 20) return { error: '文稿过短（少于 20 字），请补充后再确认' };
    fs.writeFileSync(path.join(OUTPUT_DIR, '01_script.txt'), `${text}\n`, 'utf8');
    st.ctx.scriptChars = text.replace(/\s/g, '').length;
    st.ctx.reviewConfirmed = true;
    st.waiting = null;
    endStep(stepDef, { status: 'done', output: stepDef.output, meta: { chars: st.ctx.scriptChars, note: '已人工审阅定稿' } });
    logLine(`[RUN ${st.runId}] Step3 文稿已人工审阅定稿（${st.ctx.scriptChars} 字）`);
  } else {
    return { error: `Step${stepId} 不支持人工确认` };
  }
  st.status = 'running';
  saveState();
  executeFrom(stepId + 1).catch((e) => {
    state.status = 'failed'; state.lastError = String(e); saveState(); executing = false;
  });
  return { ok: true };
}

/** 启动新一轮流水线（会归档上一轮产物） */
function startRun(rawParams) {
  const st = getState();
  if (st.status === 'running' || executing) return { error: '已有任务在运行，请先停止或等待完成' };
  const { params, error } = normalizeParams(rawParams);
  if (error) return { error };

  archiveOutputs();
  state.runId = `run_${Date.now()}`;
  state.params = params;
  state.ctx = {};
  state.steps = STEPS.map(freshStep);
  state.status = 'running';
  state.startedAt = nowIso();
  state.finishedAt = null;
  state.lastError = null;
  saveState();
  logLine(`[RUN ${state.runId}] 🚀 启动流水线${params.runMode !== 'full' ? `（调试模式：${{ script: '仅文案', tts: '文案+配音', audio: '文案+配音+字幕（跳过 HeyGen）' }[params.runMode]}）` : ''}：主题《${params.topic}》 时长≈${params.durationSec}s 音色=${params.useCloneVoice ? `克隆(${params.cloneVoiceId}，源 ${params.cloneSource})` : params.voice} avatar=${params.avatarId} 分辨率=${params.resolution}`);
  executeFrom(0).catch((e) => {
    state.status = 'failed';
    state.lastError = String(e);
    saveState();
    executing = false;
  });
  return { ok: true, runId: state.runId };
}

/* ---------------- 任意步骤重试：参数→影响步骤映射 ---------------- */

/** 重试时改了某参数，其效果最早体现在哪一步（重跑起点会自动前移到该步）。
 *  未列出的参数（runMode 等）不触发前移，由 planSkip 在执行时重新评估。 */
const PARAM_AFFECTS = {
  // 人工环节
  manualBrief: 1, manualReview: 3,
  // 文案生成（Step2）
  topic: 2, extra: 2, style: 2, language: 2, durationSec: 2,
  // 配音（Step0 克隆可选 / Step4 TTS）
  useCloneVoice: 0, cloneSource: 0, cloneVoiceId: 0,
  voice: 4, speed: 4,
  // 数字人视频（Step5；分辨率同时影响 Remotion 画布，取更早的 5）
  avatarProvider: 5, avatarId: 5, lpSource: 5, lpDriving: 5, lpLipSync: 5,
  lsVideo: 5, lsInferenceSteps: 5, lsGuidanceScale: 5,
  resolution: 5, width: 5, height: 5,
  // 合成渲染（Step7）：仅字幕样式/画布相关；resolution 已在上面取 5
  showTitleBar: 7, titleText: 7, showProgressBar: 7, watermark: 7,
  // 最终压缩（Step8）
  quality: 8,
};

/** 计算 override 中发生实质变化的参数及最小受影响步骤。
 *  返回 { fromStep, changes: [{param, fromStep}] }；无实质变化返回 fromStep=null。 */
function smartFromStep(oldParams, newParams, overrideKeys) {
  const changes = [];
  for (const key of overrideKeys) {
    const affects = PARAM_AFFECTS[key];
    if (!affects) continue;
    const a = oldParams ? oldParams[key] : undefined;
    const b = newParams ? newParams[key] : undefined;
    if (String(a) !== String(b)) changes.push({ param: key, fromStep: affects });
  }
  if (!changes.length) return { fromStep: null, changes };
  return { fromStep: Math.min(...changes.map((c) => c.fromStep)), changes };
}

/** 从指定步骤重试/重跑（支持覆盖部分参数，例如只改压缩质量重跑 Step8）。
 *  智能起点：改动的参数若影响更早的步骤（如重跑 Step5 时换了音色，TTS 必须重配），
 *  起点自动前移到最早受影响步骤；支持 script 直改文案（写入 01_script.txt，起点=Step4）。 */
function retryRun(stepId, paramOverride) {
  const st = getState();
  if (st.status === 'running' || executing) return { error: '已有任务在运行，无法重试' };
  if (!st.params) return { error: '尚无历史任务参数，请先完整跑一次' };
  let step = Math.min(8, Math.max(0, parseInt(stepId, 10) || 0));

  // script 直改文案：不入 params（normalizeParams 不认识），单独处理
  const override = { ...(paramOverride || {}) };
  const scriptOverride = cleanStr(override.script, 6000);
  delete override.script;

  let params = st.params;
  if (Object.keys(override).length) {
    const merged = normalizeParams({ ...st.params, ...override });
    if (merged.error) return { error: merged.error };
    params = merged.params;
  }

  // 智能前移：参数实质变化 → 起点取 min(用户step, 最早受影响步)；runMode 放大时补齐未跑步骤
  const autoAdjusted = [];
  const smart = smartFromStep(st.params, params, Object.keys(override));
  if (smart.fromStep != null && smart.fromStep < step) {
    step = smart.fromStep;
    autoAdjusted.push(...smart.changes.map((c) => `「${c.param}」→ Step${c.fromStep}`));
  }
  // runMode 从调试切换到更完整档位：找第一个「旧轮被跳过且新档位会执行」的步骤，纳入前移
  if (override.runMode && override.runMode !== st.params.runMode) {
    for (const s of STEPS) {
      if (s.id >= step) break;
      const oldRec = state.steps.find((x) => x.id === s.id);
      const willRun = planSkip(s, params) == null;
      if (willRun && oldRec && oldRec.status === 'skipped') {
        step = s.id; autoAdjusted.push(`「runMode: ${st.params.runMode}→${params.runMode}」→ Step${s.id} 补齐未跑步骤`); break;
      }
    }
  }
  // script 直改：写入文案并视为已审稿，起点至少 Step4
  if (scriptOverride.replace(/\s/g, '').length >= 20) {
    ensureDirs();
    fs.writeFileSync(path.join(OUTPUT_DIR, '01_script.txt'), `${scriptOverride}\n`, 'utf8');
    st.ctx.scriptChars = scriptOverride.replace(/\s/g, '').length;
    st.ctx.reviewConfirmed = true;
    if (step < 4) { step = 4; autoAdjusted.push(`「script 直改文案」→ Step4（已写入 output/01_script.txt，跳过重新审稿）`); }
    else autoAdjusted.push(`「script 直改文案」（已写入 output/01_script.txt）`);
  } else if (scriptOverride.length) {
    return { error: '直改文案过短（少于 20 字），未生效' };
  }

  // 改了主题/附加要求：旧人工需求已过时，清空让 Step2 直接用新 topic（若从 Step1 重跑则会重新等待输入）
  if (['topic', 'extra'].some((k) => override[k] != null && String(st.params[k]) !== String(params[k]))) {
    st.ctx.humanBrief = null;
    try { fs.rmSync(path.join(LOGS_DIR, 'human_brief.txt'), { force: true }); } catch (_) {}
    if (step > 2 && st.params.manualBrief) autoAdjusted.push(`提示：主题已变更，人工需求已清空（如需重新输入需求请从 Step1 重跑）`);
  }

  // 上游产物检查（Step0 克隆为可选缓存不参与；被跳过的步骤产物不检查；归档过的产物不可用）
  for (const s of STEPS.filter((x) => x.id >= 1 && x.id < step)) {
    const rec = state.steps.find((x) => x.id === s.id);
    if (rec && rec.status === 'skipped') continue;
    if (!exists(path.join(ROOT, s.output))) {
      return { error: `缺少上游产物 ${s.output}（可能已被清理/归档），请从 Step${s.id} 或更早的步骤重跑` };
    }
  }

  state.params = params;
  // 强制重新探测时长（旧 ctx 可能对应已被覆盖的产物）+ 清理人工等待残留
  st.ctx.audioDuration = null;
  st.ctx.videoDuration = null;
  st.waiting = null;
  for (const s of state.steps) { if (s.id >= step) Object.assign(s, freshStep(s), { status: 'pending' }); }
  if (!state.steps.length) state.steps = STEPS.map(freshStep);
  state.status = 'running';
  state.startedAt = nowIso();
  state.finishedAt = null;
  state.lastError = null;
  saveState();
  logLine(`[RUN ${state.runId}] 🔁 从 Step${step} 重跑（${STEPS.find((x) => x.id === step).name}）${autoAdjusted.length ? `；参数变更自动前移：${autoAdjusted.join('，')}` : ''}`);
  executeFrom(step).catch((e) => {
    state.status = 'failed'; state.lastError = String(e); saveState(); executing = false;
  });
  return { ok: true, fromStep: step, requestedStep: Math.min(8, Math.max(0, parseInt(stepId, 10) || 0)), autoAdjusted };
}

function stopRun() {
  const st = getState();
  if (st.status !== 'running') return { error: '当前没有运行中的任务' };
  killAllChilds();
  const cur = state.steps.find((s) => s.status === 'running');
  if (cur) endStep(cur, { status: 'failed', error: '用户手动停止' });
  state.status = 'aborted';
  state.finishedAt = nowIso();
  state.lastError = '用户手动停止';
  pushHistory(); saveState();
  logLine(`[RUN ${state.runId}] ⏹ 用户停止流水线`);
  executing = false;
  return { ok: true };
}

/** Remotion 渲染进度（0-100），供前端展示 */
function remotionProgress() {
  try {
    const txt = fs.readFileSync(path.join(LOGS_DIR, 'remotion_progress.txt'), 'utf8').trim();
    const n = parseInt(txt, 10);
    return Number.isFinite(n) ? n : null;
  } catch (_) { return null; }
}

function getStatus() {
  const st = getState();
  const out = { ...st };
  const cur = st.steps.find((s) => s.status === 'running');
  if (cur && cur.key === 'remotion') cur.progress = remotionProgress();
  out.serverTime = nowIso();
  return out;
}

function defaults() {
  const env = getEnv();
  const lp = liveportrait.readySummary();
  return {
    voices: VOICES, resolutions: RESOLUTIONS, qualities: QUALITIES, styles: STYLES,
    steps: STEPS.map((s) => ({ id: s.id, name: s.name })),
    avatarProviders: [
      { id: 'heygen', label: 'HeyGen（云端，按 Avatar ID 选择形象；需 OAuth 连接）' },
      { id: 'liveportrait', label: 'LivePortrait（本地，源人像 + 驱动视频；勾选「口型同步」自动串联 LatentSync）' },
      { id: 'latentsync', label: 'LatentSync（本地，驱动视频 + 配音直接对口型；需安装 Python 依赖并下载权重）' },
    ],
    defaults: {
      avatarProvider: 'heygen',
      avatarId: env.HEYGEN_AVATAR_ID || '',
      lpSource: 'resources/photo1.jpg',
      lpDriving: 'd0.mp4',
      voice: 'Chinese (Mandarin)_Warm_Girl',
      durationSec: 60, speed: 1, resolution: '1080x1920', quality: 'balanced',
      language: 'zh', style: STYLES[1], showTitleBar: true, showProgressBar: true,
    },
    env: {
      PORT: env.PORT || 7788,
      CODEX_MODEL: env.CODEX_MODEL || '',
      MINIMAX_TTS_MODEL: env.MINIMAX_TTS_MODEL || 'speech-2.8-hd',
      HEYGEN_PROXY: env.HEYGEN_PROXY || '',
      HEYGEN_CONNECTED: heygen.isConnected(),
      LIVEPORTRAIT_READY: lp.weightsReady && lp.repo && lp.inference,
      LIVEPORTRAIT_PYTHON: env.LIVEPORTRAIT_PYTHON || 'python',
    },
  };
}

module.exports = {
  STEPS, VOICES, RESOLUTIONS, QUALITIES, STYLES, MATERIAL_CATEGORIES,
  getState, getStatus, startRun, retryRun, stopRun, confirmHuman, cleanupOutputs, defaults,
};
