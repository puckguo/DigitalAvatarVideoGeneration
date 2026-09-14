'use strict';
/**
 * LivePortrait 本地推理客户端（KlingTeam/LivePortrait）
 * 通过子进程调用 LivePortrait/inference.py（source 肖像 + driving 视频 → 数字人视频），
 * 再用 ffmpeg 把 TTS 配音合成到生成的视频上。
 *
 * 设计目标：
 *   - 与 HeyGen MCP 客户端平行存在，互不干扰；
 *   - 单一函数 runAvatar(opts) 返回音频驱动后的最终 mp4；
 *   - 输出尺寸 / FPS 与 HeyGen 路径完全一致，便于后续 Remotion/FFmpeg 步骤无感切换。
 *
 * 重要约定：
 *   - LivePortrait 输入是「源人像 + 驱动视频」，不是音频。
 *     本项目原流程是「TTS 音频驱动」，因此这里把 TTS 配音用 ffmpeg mux 到 LivePortrait 生成的画面上。
 *     如果想要对口型同步，需要外加音频驱动模型（如 SadTalker/Musetalk），本项目当前不内置。
 *   - LivePortrait 不提供明显进度回调；通过监控 inference.py 输出的 .mp4 文件大小变化来估算进度。
 *   - 仅 Windows / CUDA GPU 路径实测；macOS / CPU 不在本流水线验证范围内。
 */
const fs = require('fs');
const path = require('path');
const {
  ROOT, LOGS_DIR, OUTPUT_DIR, MATERIALS_DIR,
  execChild, ffprobeDuration, fsize, fmtBytes, errTail, logLine,
} = require('./utils');

const LP_DIR = path.join(ROOT, 'LivePortrait');
const RESOURCES_DIR = path.join(ROOT, 'resources');

/** Windows OpenCV 5.0 (Python 3.14) 读中文路径会闷错（imread 返 None），
 *  解决方案：创建到项目根的目录接合点（junction） `C:\lp_runtime`，
 *  LivePortrait 的所有路径都走 junction，规避中文路径问题。 */
const LP_JUNCTION = process.env.LIVEPORTRAIT_JUNCTION || (process.platform === 'win32' ? 'C:\\lp_runtime' : null);
let LP_RUNTIME_DIR = LP_DIR; // 实际运行时的 cwd（与传给 python 的路径一致）
if (LP_JUNCTION) {
  try {
    if (!fs.existsSync(LP_JUNCTION)) {
      // 需要 node 创建 junction 的权限：尝试 fs.symlink；如果权限不够则降级用原路径
      try { fs.symlinkSync(ROOT, LP_JUNCTION, 'junction'); }
      catch (e) { logLine(`[LIVEPORTRAIT] junction 创建失败（${e.message}），继续用原路径（可能在中文路径上会失败）`); }
    }
    if (fs.existsSync(LP_JUNCTION)) {
      LP_RUNTIME_DIR = path.join(LP_JUNCTION, 'LivePortrait');
      logLine(`[LIVEPORTRAIT] 使用 junction 规避中文路径：${LP_RUNTIME_DIR}`);
    }
  } catch (e) {
    logLine(`[LIVEPORTRAIT] junction 检查异常：${e.message}`);
  }
}
const LP_OUTPUT_DIR = path.join(LP_DIR, 'animations'); // LivePortrait 默认输出目录
const LP_REQUIRED_WEIGHTS = [
  // 必须存在的最小权重集（人像模式）
  'liveportrait/base_models/appearance_feature_extractor.pth',
  'liveportrait/base_models/motion_extractor.pth',
  'liveportrait/base_models/spade_generator.pth',
  'liveportrait/base_models/warping_module.pth',
  'liveportrait/landmark.onnx',
  'liveportrait/retargeting_models/stitching_retargeting_module.pth',
  'insightface/models/buffalo_l/2d106det.onnx',
  'insightface/models/buffalo_l/det_10g.onnx',
];

/* ---------------- 环境检查 ---------------- */

/** LivePortrait 是否就绪：目录存在 + 关键权重文件齐全 + Python 依赖 + 推理脚本可达 */
async function checkReady() {
  const items = {
    repo: fs.existsSync(LP_DIR),
    weights: [],
    inference: fs.existsSync(path.join(LP_DIR, 'inference.py')),
    pythonDeps: null, // 延迟到首次 runAvatar 时探测
  };
  for (const rel of LP_REQUIRED_WEIGHTS) {
    items.weights.push({ path: rel, ok: fsize(path.join(LP_DIR, 'pretrained_weights', rel)) > 0 });
  }
  return items;
}

function readySummary() {
  const r = {
    repo: fs.existsSync(LP_DIR),
    weightsReady: false,
    weightsMissing: [],
    inference: fs.existsSync(path.join(LP_DIR, 'inference.py')),
  };
  for (const rel of LP_REQUIRED_WEIGHTS) {
    if (fsize(path.join(LP_DIR, 'pretrained_weights', rel)) <= 0) r.weightsMissing.push(rel);
  }
  r.weightsReady = r.repo && r.weightsMissing.length === 0;
  return r;
}

/** 探测 LivePortrait Python 依赖（首次调用时跑一次，失败给出明确指引） */
async function checkPythonDeps() {
  const py = process.env.LIVEPORTRAIT_PYTHON || 'python';
  const r = await execChild(py, ['-c', 'import torch, cv2, numpy, tyro; import onnxruntime; print(torch.__version__, onnxruntime.__version__)'],
    { shell: false, timeoutMs: 60 * 1000 });
  if (r.code !== 0) return { ok: false, detail: errTail(r.stderr || r.stdout, 400) };
  return { ok: true, detail: (r.stdout || '').trim() };
}

/* ---------------- 驱动素材库 ---------------- */

/** 列出 LivePortrait 内置 / 用户上传的可用驱动视频与模板（.pkl） */
function listBuiltInDrivings() {
  const out = [];
  const drvDir = path.join(LP_DIR, 'assets', 'examples', 'driving');
  if (!fs.existsSync(drvDir)) return out;
  for (const f of fs.readdirSync(drvDir)) {
    if (/\.(mp4|pkl|jpg|jpeg|png)$/i.test(f)) {
      out.push({ name: f, type: /\.pkl$/i.test(f) ? 'template' : 'video', builtin: true });
    }
  }
  return out;
}

/** 把用户填写的相对路径 / 内置模板名 / 用户上传的文件 解析为绝对路径（并在必要时拷贝到 LivePortrait 可见位置） */
function resolveSource(input, kind) {
  // kind: 'source' | 'driving'
  if (!input) throw new Error(`缺少${kind === 'source' ? '源人像' : '驱动视频'}`);
  // 1) 内置模板（仅 driving）
  if (kind === 'driving' && !/[\\/]/.test(input)) {
    const builtin = path.join(LP_DIR, 'assets', 'examples', 'driving', input);
    if (fsize(builtin) > 0) return builtin;
    // 兼容仅文件名（无 .pkl/.mp4 后缀）
    for (const ext of ['.pkl', '.mp4']) {
      const cand = path.join(LP_DIR, 'assets', 'examples', 'driving', input + ext);
      if (fsize(cand) > 0) return cand;
    }
  }
  // 2) 项目内相对路径（resources / materials / LivePortrait 内任意位置）
  const roots = [
      ROOT, MATERIALS_DIR, RESOURCES_DIR, path.join(ROOT, 'resources'), path.join(ROOT, 'materials'),
      LP_DIR, path.join(LP_DIR, 'assets', 'examples', kind === 'source' ? 'source' : 'driving'),
    ];
  const rel = String(input).replace(/\\/g, '/');
  for (const r of roots) {
    const abs = path.isAbsolute(rel) ? rel : path.join(r, rel);
    if (fsize(abs) > 0) return abs;
  }
  throw new Error(`${kind === 'source' ? '源人像' : '驱动视频'}未找到：${input}（已检查项目内 / LivePortrait 内置 / resources / materials）`);
}

/* ---------------- 主流程 ---------------- */

/**
 * LivePortrait 数字人生成（音频驱动）
 * @param {object} opts
 *   - source: string       源人像路径（jpg/png/mp4）
 *   - driving: string      驱动视频路径或 .pkl 模板名（如 talking.pkl）
 *   - audio: string        TTS 音频路径（output/02_audio.wav），会被合成到生成的视频上
 *   - outPath: string      输出最终视频绝对路径（默认 output/03_heygen_raw.mp4）
 *   - width/height: int    输出尺寸（LivePortrait 默认 512x512，本项目按表单参数缩放）
 *   - runId: string        当前流水线 runId（用于日志归属）
 *   - log: (line)=>void    进度回调（写到 pipeline.log + 前端进度条）
 * @returns {Promise<{ videoPath, duration, size }>}
 */
async function runAvatar(opts) {
  const source = resolveSource(opts.source, 'source');
  const driving = resolveSource(opts.driving, 'driving');
  const audio = path.resolve(opts.audio);
  const outPath = path.resolve(opts.outPath || path.join(OUTPUT_DIR, '03_heygen_raw.mp4'));
  const width = parseInt(opts.width, 10) || 1080;
  const height = parseInt(opts.height, 10) || 1920;
  const runId = opts.runId || 'liveportrait';
  const log = opts.log || (() => {});

  if (!fsize(audio)) throw new Error(`TTS 配音不存在：${audio}`);
  if (!fsize(source)) throw new Error(`源人像不存在：${source}`);
  if (!fsize(driving)) throw new Error(`驱动视频不存在：${driving}`);

  // 1) 镜像原文件到 junction 路径（Windows 避免 OpenCV 中文路径问题）
  //    项目内文件（resources/materials） → 镜像到 junction 根目录对应路径
  //    LivePortrait 内置文件 → 走 LP_RUNTIME_DIR（junction 下）
  const mirrorDir = path.join(LP_RUNTIME_DIR, 'inputs');
  fs.mkdirSync(mirrorDir, { recursive: true });
  const srcStamp = `${Date.now()}_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const lpSourceAbs = path.join(mirrorDir, `source_${srcStamp}${path.extname(source)}`);
  const lpDrivingAbs = path.join(mirrorDir, `driving_${srcStamp}${path.extname(driving)}`);
  fs.copyFileSync(source, lpSourceAbs);
  fs.copyFileSync(driving, lpDrivingAbs);
  const audioMirror = path.join(mirrorDir, `audio_${srcStamp}.wav`);
  fs.copyFileSync(audio, audioMirror);
  log(`[${runId}] [LIVEPORTRAIT] 源/驱动/音频已镜像到 junction 路径（避免中文路径）`);

  // 1) 预检：依赖与权重
  const deps = await checkPythonDeps();
  if (!deps.ok) {
    throw new Error(
      'LivePortrait Python 依赖未就绪。\n' +
      '请在 LivePortrait 目录下创建 conda 环境（推荐 Python 3.10）并执行：\n' +
      '  conda create -n LivePortrait python=3.10 -y && conda activate LivePortrait\n' +
      '  cd LivePortrait && pip install -r requirements.txt\n' +
      '然后在 .env 中配置 LIVEPORTRAIT_PYTHON=LivePortrait 里的 python 解释器路径，或将其加入 PATH。\n' +
      `原始错误：${deps.detail}`,
    );
  }
  const r = readySummary();
  if (!r.repo) throw new Error('LivePortrait 仓库未找到（项目根目录下应有 LivePortrait/）');
  if (!r.inference) throw new Error('LivePortrait/inference.py 不存在');
  if (!r.weightsReady) {
    throw new Error(
      `LivePortrait 预训练权重未就绪（缺失 ${r.weightsMissing.length} 个文件）。\n` +
      '在 LivePortrait 目录下执行：\n' +
      '  pip install -U "huggingface_hub[cli]"\n' +
      '  huggingface-cli download KlingTeam/LivePortrait --local-dir pretrained_weights --exclude "*.git*" "README.md" "docs"\n' +
      `缺失文件：${r.weightsMissing.join(', ')}`,
    );
  }

  // 2) 准备 LivePortrait 输出目录 & 清旧（同时清原路径与 junction 路径的输出）
  for (const d of [LP_OUTPUT_DIR, path.join(LP_RUNTIME_DIR, 'animations')]) {
    fs.mkdirSync(d, { recursive: true });
    try {
      for (const old of fs.readdirSync(d)) {
        try { fs.rmSync(path.join(d, old), { recursive: true, force: true }); } catch (_) {}
      }
    } catch (_) {}
  }

  // 3) 调用 inference.py（走 _lp_wrapper.py 避开 Windows + Python 3.14 + OpenCV 5.0 + 中文路径问题）
  // 关键参数：-s 源人像 -d 驱动视频/模板 -o 输出目录
  // 使用镜像后的非中文路径（junction 下）
  const args = [
    path.join(LP_RUNTIME_DIR, '_lp_wrapper.py'),
    '-s', lpSourceAbs, '-d', lpDrivingAbs,
    '-o', 'animations/',
    '--flag_force_cpu',  // 默认走 CPU；有 GPU 可改 liveportrait.js 后面几个步骤
  ];
  const logFile = path.join(LOGS_DIR, 'step5_liveportrait.log');
  log(`[${runId}] [LIVEPORTRAIT] 推理启动：source=${path.basename(lpSourceAbs)} driving=${path.basename(lpDrivingAbs)}`);
  logLine(`[${runId}] [LIVEPORTRAIT] python inference.py -s "${lpSourceAbs}" -d "${lpDrivingAbs}" -o animations/`);
  const py = process.env.LIVEPORTRAIT_PYTHON || 'python';
  // LivePortrait 默认带 rich 进度条（stderr），不需要解析进度文本
  // env: PYTHONIOENCODING/PYTHONUTF8=1 避免 rich 在 cp1252 控制台上报 UnicodeEncodeError
  // （Windows 下 Python 3.14 rich + 中文路径会报这个错）
  const r0 = await execChild(py, args, {
    cwd: LP_RUNTIME_DIR, timeoutMs: 30 * 60 * 1000, logFile,
    env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  if (r0.code !== 0 || r0.killed) {
    const tail = errTail(r0.stderr || r0.stdout, 800);
    throw new Error(`LivePortrait 推理失败（退出码 ${r0.code}${r0.killed ? '，超时被终止' : ''}）：${tail}`);
  }

  // 4) LivePortrait 输出文件名：<source_basename>--<driving_basename>.mp4 + _concat.mp4
  //    输出写在 LP_RUNTIME_DIR/animations/（junction 路径），找到后按 basename 在原路径上走
  const srcBase = path.basename(lpSourceAbs).replace(/\.[^.]+$/, '');
  const drvBase = path.basename(lpDrivingAbs).replace(/\.[^.]+$/, '');
  const lpVideoRuntime = path.join(LP_RUNTIME_DIR, 'animations', `${srcBase}--${drvBase}.mp4`);
  if (!fsize(lpVideoRuntime)) throw new Error(`LivePortrait 输出未找到：${lpVideoRuntime}（请查看 logs/step5_liveportrait.log）`);
  // 复制回原项目路径（junction 上的文件被 Windows 视为同一文件，但为避免下下游依赖原始路径统一拷贝）
  const lpVideo = path.join(LP_DIR, 'animations', `${srcBase}--${drvBase}.mp4`);
  fs.mkdirSync(path.dirname(lpVideo), { recursive: true });
  fs.copyFileSync(lpVideoRuntime, lpVideo);
  const lpDur = await ffprobeDuration(lpVideo);
  if (!lpDur) throw new Error(`LivePortrait 输出 ffprobe 失败：${lpVideo}`);

  // 5) 把 LivePortrait 视频缩放到目标分辨率 + 把 TTS 音频合成上去
  //    LivePortrait 默认 512x512 @ 30fps（或 driving fps），这里一次性做缩放+mux
  const audioDur = await ffprobeDuration(audioMirror);
  if (!audioDur) throw new Error(`TTS 音频 ffprobe 失败：${audioMirror}`);

  // 决定最终时长：以音频为准（TTS 是真实口播时长）。LivePortrait 视频用 loop 凑齐音频时长。
  const loopedVideo = path.join(LP_DIR, 'animations', `${srcBase}--${drvBase}--looped.mp4`);
  const loopR = await execChild(ffmpegCmd(), [
    '-y', '-stream_loop', '-1', '-i', lpVideo, '-t', String(audioDur),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-r', '30', loopedVideo,
  ], { timeoutMs: 10 * 60 * 1000, logFile: path.join(LOGS_DIR, 'step5_lp_loop.log') });
  if (loopR.code !== 0 || !fsize(loopedVideo)) throw new Error(`LivePortrait 视频循环失败：${errTail(loopR.stderr, 400)}`);

  // 缩放到目标分辨率 + mux 音频
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  try { fs.rmSync(outPath, { force: true }); } catch (_) {}
  const muxArgs = [
    '-y', '-i', loopedVideo, '-i', audioMirror,
    '-map', '0:v:0', '-map', '1:a:0',
    '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '128k', '-shortest',
    '-movflags', '+faststart',
    outPath,
  ];
  const muxR = await execChild(ffmpegCmd(), muxArgs, { timeoutMs: 10 * 60 * 1000, logFile: path.join(LOGS_DIR, 'step5_lp_mux.log') });
  if (muxR.code !== 0 || !fsize(outPath)) throw new Error(`LivePortrait 视频合成失败：${errTail(muxR.stderr, 400)}`);
  const finalDur = await ffprobeDuration(outPath);
  if (!finalDur) throw new Error(`最终视频 ffprobe 失败：${outPath}`);

  // 6) 清理 LivePortrait 临时输出，保留本次合成结果（原路径与 junction 路径都清）
  for (const d of [LP_OUTPUT_DIR, path.join(LP_RUNTIME_DIR, 'animations')]) {
    try {
      const keep = new Set([path.basename(lpVideo), path.basename(loopedVideo)]);
      for (const f of fs.readdirSync(d)) {
        if (!keep.has(f)) {
          try { fs.rmSync(path.join(d, f), { recursive: true, force: true }); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  log(`[${runId}] [LIVEPORTRAIT] ✅ 完成：${outPath}（${finalDur.toFixed(1)}s, ${fmtBytes(fsize(outPath))}）`);
  return { videoPath: outPath, duration: finalDur, size: fsize(outPath), lpOutput: lpVideo };
}

module.exports = { checkReady, readySummary, checkPythonDeps, listBuiltInDrivings, runAvatar, LP_DIR, LP_REQUIRED_WEIGHTS };