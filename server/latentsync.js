'use strict';
/**
 * LatentSync 1.5 本地口型同步客户端（ByteDance/LatentSync）
 * 音频驱动口型：输入「视频 + 音频」→ 输出口型与音频同步的视频（自带音轨）。
 *
 * 定位：与 HeyGen / LivePortrait 平行，补齐「本地 + 口型同步」能力：
 *   - HeyGen：云端，音频驱动口型（耗 credit）
 *   - LivePortrait：本地，源人像 + 驱动视频（无口型同步）
 *   - LatentSync：本地，任意含人脸视频 + 任意音频 → 对口型（8GB+ VRAM）
 *   - 组合模式：LivePortrait 出画面（照片数字人+动作）→ LatentSync 对口型 → 完整本地链路
 *
 * 关键约定：
 *   - LatentSync 1.5 与 1.6 的 UNet 架构不同，代码与权重必须配对：
 *     本模块锁定 1.5 最终代码 commit 7b380d6（configs/unet/stage2.yaml + 256 分辨率 + whisper tiny）。
 *   - 中文路径规避：与 liveportrait.js 共用项目根 junction（C:\lp_runtime），
 *     输入文件拷到 LatentSync/inputs/ 下用相对路径调用（cwd=LatentSync），双保险。
 *   - 首次推理会从 HuggingFace 自动下载 stabilityai/sd-vae-ft-mse（~335MB），
 *     通过 HF_ENDPOINT=https://hf-mirror.com 走国内镜像。
 *   - 推理无显式进度回调；unet 输出 tqdm 到 stderr，解析 step 百分比。
 */
const fs = require('fs');
const path = require('path');
const {
  ROOT, LOGS_DIR, getEnv,
  execChild, ffmpegCmd, ffprobeDuration, fsize, fmtBytes, errTail, logLine,
} = require('./utils');

const LS_DIR = path.join(ROOT, 'LatentSync');
/** 与 liveportrait.js 共用项目根 junction，规避 Windows + decord/OpenCV 中文路径问题 */
const LS_JUNCTION = process.env.LIVEPORTRAIT_JUNCTION || (process.platform === 'win32' ? 'C:\\lp_runtime' : null);
let LS_RUNTIME_DIR = LS_DIR;
if (LS_JUNCTION && fs.existsSync(path.join(LS_JUNCTION, 'LatentSync'))) {
  LS_RUNTIME_DIR = path.join(LS_JUNCTION, 'LatentSync');
}
/** LatentSync 1.5 锁定的代码版本（checkpoints 与 configs 必须配对） */
const LS_COMMIT = '7b380d6';
const LS_VENV_PY = process.env.LATENTSYNC_PYTHON || path.join(LS_DIR, 'venv', 'Scripts', 'python.exe');

/* ---------------- 环境检查 ---------------- */

function readySummary() {
  const unetOk = fsize(path.join(LS_DIR, 'checkpoints', 'latentsync_unet.pt')) > 1e9; // ~4.7GB
  const whisperOk = fsize(path.join(LS_DIR, 'checkpoints', 'whisper', 'tiny.pt')) > 1e6;
  const r = {
    repo: fs.existsSync(path.join(LS_DIR, 'scripts', 'inference.py')),
    venv: fsize(LS_VENV_PY) > 0,
    unet: unetOk,
    whisper: whisperOk,
    weightsReady: unetOk && whisperOk,
  };
  r.ready = r.repo && r.venv && r.weightsReady;
  return r;
}

async function checkPythonDeps() {
  if (!fsize(LS_VENV_PY)) return { ok: false, detail: 'venv 不存在（运行 scripts/install-latentsync.ps1）' };
  const r = await execChild(LS_VENV_PY, ['-c', 'import torch,diffusers,transformers,librosa,decord; print(torch.__version__)'],
    { shell: false, timeoutMs: 60 * 1000 });
  if (r.code !== 0) return { ok: false, detail: errTail(r.stderr || r.stdout, 400) };
  return { ok: true, detail: (r.stdout || '').trim() };
}

/* ---------------- 口型同步推理 ---------------- */

/**
 * 对视频做音频口型同步。
 * @param {object} o
 * @param {string} o.video   驱动视频（含人脸，相对项目根或绝对路径）
 * @param {string} o.audio   音频（wav）
 * @param {string} o.outPath 最终输出（已缩放到目标分辨率，含音轨）
 * @param {number} o.width / o.height 目标分辨率
 * @param {number} [o.inferenceSteps=20]  扩散步数 20-50（高=更清晰更慢）
 * @param {number} [o.guidanceScale=1.5]  口型贴合度 1.0-3.0（高=口型准但易抖动）
 */
async function runLipsync(o) {
  const log = o.log || logLine;
  const runId = o.runId || 'LS';
  const steps = Math.min(50, Math.max(10, Number(o.inferenceSteps) || 20));
  const guidance = Math.min(3.0, Math.max(1.0, Number(o.guidanceScale) || 1.5));

  // 1) 就绪校验
  const r = readySummary();
  if (!r.ready) {
    const miss = [];
    if (!r.repo) miss.push('LatentSync 仓库未找到（项目根目录下应有 LatentSync/，且 checkout 到 1.5 代码）');
    if (!r.venv) miss.push('venv 未创建（scripts/install-latentsync.ps1 或 scripts/install-latentsync-deps.sh）');
    if (!r.unet) miss.push('checkpoints/latentsync_unet.pt 缺失（~4.7GB，scripts/dl-latentsync-weights.sh）');
    if (!r.whisper) miss.push('checkpoints/whisper/tiny.pt 缺失');
    throw new Error(`LatentSync 未就绪：${miss.join('；')}`);
  }

  // 2) 输入视频解析（项目根相对 / 绝对 / 素材库 / LivePortrait 产物）
  const videoAbs = path.isAbsolute(o.video) ? o.video : path.join(ROOT, o.video);
  if (!fsize(videoAbs)) throw new Error(`驱动视频不存在：${o.video}`);
  const audioAbs = path.isAbsolute(o.audio) ? o.audio : path.join(ROOT, o.audio);
  if (!fsize(audioAbs)) throw new Error(`音频不存在：${o.audio}`);

  // 3) 拷贝到 junction 侧的 inputs/ 用相对路径调用（path.relative 跨 junction/中文路径无法解析，
  //    必须直接在 junction 目录树下操作；Python print 中文路径在 cp1252 控制台会直接崩）
  const inDir = path.join(LS_RUNTIME_DIR, 'inputs', 'lipsync');
  fs.mkdirSync(inDir, { recursive: true });
  fs.mkdirSync(path.join(LS_RUNTIME_DIR, 'outputs'), { recursive: true }); // LatentSync 不会自建输出目录（ffmpeg 报 No such file）
  const vExt = path.extname(videoAbs).toLowerCase() || '.mp4';
  const inVideo = path.join(inDir, `in${vExt}`);
  const inAudio = path.join(inDir, 'in.wav');
  fs.copyFileSync(videoAbs, inVideo);
  fs.copyFileSync(audioAbs, inAudio);
  const outRaw = path.join(inDir, 'out_raw.mp4');
  try { fs.rmSync(outRaw, { force: true }); } catch (_) {}

  // 4) 推理（cwd 走 junction 路径，参数全用相对路径）
  // 关键：LatentSync 内部用 ffmpeg-python 写输出视频，必须在子进程 PATH 里能找到 ffmpeg。
  // 本机 PATH 常无 ffmpeg（.env FFMPEG_PATH 为绝对路径），这里把其所在目录前置到 PATH。
  const ffAbs = ffmpegCmd();
  const ffDir = /[\\/]/.test(ffAbs) ? path.dirname(ffAbs) : null;
  const inferEnv = {
    ...process.env,
    PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1',
    HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com', // sd-vae-ft-mse 首次自动下载走镜像
  };
  if (ffDir) inferEnv.PATH = `${ffDir}${path.delimiter}${process.env.PATH || ''}`;
  const logFile = path.join(LOGS_DIR, 'step5_latentsync.log');
  const rel = (abs) => path.relative(LS_RUNTIME_DIR, abs);
  const args = [
    '-m', 'scripts.inference',
    '--unet_config_path', 'configs/unet/stage2.yaml',   // 1.5 专用（256 分辨率；勿用 1.6 的 stage2_512）
    '--inference_ckpt_path', 'checkpoints/latentsync_unet.pt',
    '--inference_steps', String(steps),
    '--guidance_scale', String(guidance),
    '--video_path', rel(inVideo),
    '--audio_path', rel(inAudio),
    '--video_out_path', rel(outRaw),
  ];
  log(`[${runId}] [LATENTSYNC] 推理启动：video=${path.basename(videoAbs)} steps=${steps} guidance=${guidance}`);
  logLine(`[${runId}] [LATENTSYNC] ${path.basename(LS_VENV_PY)} -m scripts.inference --unet_config_path configs/unet/stage2.yaml ...`);
  const timeoutMs = Number(getEnv().LATENTSYNC_TIMEOUT_MS || process.env.LATENTSYNC_TIMEOUT_MS || 40 * 60 * 1000);
  const r0 = await execChild(LS_VENV_PY, args, {
    cwd: LS_RUNTIME_DIR, timeoutMs, logFile,
    env: inferEnv,
  });
  if (r0.code !== 0 || r0.killed) {
    const tail = errTail(r0.stderr || r0.stdout, 800);
    let hint = '';
    if (/CUDA out of memory|OutOfMemoryError/i.test(tail)) {
      hint = `\n\n【原因】显存不足（LatentSync 1.5 推理需约 8GB）。\n【解决】关闭其他占用显存的程序后重试；或将驱动视频时长缩短（显存占用随帧数增长）。`;
    } else if (/sd-vae-ft-mse|ConnectionError|HTTPSConnectionPool|huggingface/i.test(tail)) {
      hint = `\n\n【原因】首次推理需从 HuggingFace 下载 stabilityai/sd-vae-ft-mse（~335MB），网络失败。\n【解决】确认可访问 hf-mirror.com（已在调用中设置 HF_ENDPOINT），或配置代理后重试本步骤。`;
    } else if (/No module named (\S+)/.test(tail)) {
      hint = `\n\n【原因】venv 缺依赖（${tail.match(/No module named (\S+)/)?.[1] || '?'}）。\n【解决】bash scripts/install-latentsync-deps.sh`;
    } else if (/RuntimeError|AssertionError/i.test(tail) && /face|landmark|insightface/i.test(tail)) {
      hint = `\n\n【原因】驱动视频中未检测到人脸（或人脸太小）。\n【解决】换一段人脸清晰、正面的视频（大头照/半身口播最佳）。`;
    } else if (/UnicodeEncodeError|charmap/i.test(tail)) {
      hint = `\n\n【原因】Python 子进程在 cp1252 控制台打印中文路径失败。\n【解决】确认 execChild 已传 env（PYTHONUTF8=1）且输入文件走 junction 路径（无中文）。`;
    }
    throw new Error(`LatentSync 推理失败（退出码 ${r0.code}${r0.killed ? '，超时被终止' : ''}）：${tail}${hint}`);
  }
  // junction 与真实路径指向同一文件，但为保险统一从真实侧读取校验
  if (!fsize(outRaw) && !fsize(path.join(LS_DIR, 'inputs', 'lipsync', 'out_raw.mp4'))) {
    throw new Error(`LatentSync 输出未找到：${outRaw}（详情见 logs/step5_latentsync.log）`);
  }
  const outRawReal = fsize(outRaw) ? outRaw : path.join(LS_DIR, 'inputs', 'lipsync', 'out_raw.mp4');

  // 5) 缩放到目标分辨率（LatentSync 输出已含音轨；保留原音轨，仅缩放）
  const outAbs = path.isAbsolute(o.outPath) ? o.outPath : path.join(ROOT, o.outPath);
  const { width, height } = o;
  const scaleArgs = [
    '-y', '-i', outRawReal,
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-r', '25',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    outAbs,
  ];
  const sc = await execChild(ffmpegCmd(), scaleArgs, { timeoutMs: 10 * 60 * 1000, logFile: path.join(LOGS_DIR, 'step5_ls_scale.log') });
  if (sc.code !== 0 || !fsize(outAbs)) throw new Error(`LatentSync 输出缩放失败：${errTail(sc.stderr, 400)}`);

  // 6) 校验 + 清理临时输入
  const dur = await ffprobeDuration(outAbs);
  if (!dur || dur < 0.5) throw new Error(`LatentSync 视频异常（时长 ${dur}s，大小 ${fmtBytes(fsize(outAbs))}）`);
  try { fs.rmSync(inDir, { recursive: true, force: true }); } catch (_) {}
  log(`[${runId}] [LATENTSYNC] ✅ 完成：${outAbs}（${dur.toFixed(1)}s, ${fmtBytes(fsize(outAbs))}）`);
  return { videoPath: outAbs, duration: dur, size: fsize(outAbs), steps, guidance };
}

module.exports = { readySummary, checkPythonDeps, runLipsync, LS_DIR, LS_COMMIT };
