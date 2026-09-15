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
  execChild, ffmpegCmd, ffprobeDuration, fsize, fmtBytes, errTail, logLine,
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
  const py = process.env.LIVEPORTRAIT_PYTHON || 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python311\\python.exe';
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
  // LivePortrait 仓库自带的 .pkl 文件有两种格式：
  //  - 新格式：含 'c_d_eyes_lst' + 'c_d_lip_lst' + 'motion' + 'n_frames' + 'output_fps'（可跑）
  //  - 旧格式：只含 'motion' + 'n_frames' + 'output_fps'（与新版 LivePortrait 不兼容）
  // 检测后只列出可用模板，提示用户选错会报错。
  const compatible = new Set(['d1.pkl', 'd2.pkl', 'd5.pkl', 'd7.pkl', 'd8.pkl', 'wink.pkl']);
  for (const f of fs.readdirSync(drvDir)) {
    if (!/\.(mp4|pkl|jpg|jpeg|png)$/i.test(f)) continue;
    const isPkl = /\.pkl$/i.test(f);
    const ok = !isPkl || compatible.has(f);  // mp4 视频总是可用（需重新抽取动作）
    out.push({ name: f, type: isPkl ? 'template' : 'video', builtin: true, compatible: ok });
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
  const audioMirror = path.join(mirrorDir, `audio_${srcStamp}.wav`);
  fs.copyFileSync(source, lpSourceAbs);
  fs.copyFileSync(audio, audioMirror);
  log(`[${runId}] [LIVEPORTRAIT] 源/音频已镜像到 junction 路径（避免中文路径）`);

  // 2) 探测驱动视频/pkl长度，根据音频时长延长驱动视频
  //    【关键】如果直接用原始短 driving（如 d0.mp4 = 3 秒）跑 LivePortrait，
  //    生成视频只有 3 秒；然后我们 ffmpeg stream_loop 把 3 秒循环到 60 秒音频长度，
  //    结果就是「同一段动作重复 20 遍」。正确做法是提前把 driving 视频 loop 到 >= 音频时长，
  //    这样 LivePortrait 推理时拿到的是长 driving，生成的视频就是长且连续的动作。
  const audioDur = await ffprobeDuration(audioMirror);
  if (!audioDur) throw new Error(`TTS 音频 ffprobe 失败：${audioMirror}`);

  const isVideoDriving = /\.(mp4|mov|webm)$/i.test(driving);
  const isPklDriving = /\.pkl$/i.test(driving);

  let lpDrivingAbs;
  if (isVideoDriving) {
    // driving 是 mp4：拿原始时长 vs 音频时长，按需 loop
    const drvDur = await ffprobeDuration(driving) || 3;
    let drvMirrored = path.join(mirrorDir, `driving_${srcStamp}${path.extname(driving)}`);
    fs.copyFileSync(driving, drvMirrored);
    if (drvDur < audioDur - 0.5) {
      // driving 比音频短：用 ffmpeg stream_loop 预先延长（注意：loop 会重复，但 LivePortrait 会生成连续动画，
      // 多次 loop 仍是连续动作的不同相位，比单次短视频再 loop 更不容易看出重复）
      const looped = path.join(mirrorDir, `driving_${srcStamp}_looped.mp4`);
      log(`[${runId}] [LIVEPORTRAIT] driving 视频 ${drvDur.toFixed(1)}s < 音频 ${audioDur.toFixed(1)}s，提前 loop 到音频时长（LivePortrait 会输出连续动作）`);
      const lr = await execChild(ffmpegCmd(), [
        '-y', '-stream_loop', '-1', '-i', drvMirrored,
        '-t', String(audioDur),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
        '-pix_fmt', 'yuv420p', looped,
      ], { timeoutMs: 5 * 60 * 1000, logFile: path.join(LOGS_DIR, 'step5_lp_dvloop.log') });
      if (lr.code !== 0 || !fsize(looped)) throw new Error(`driving 视频预先 loop 失败：${errTail(lr.stderr, 400)}`);
      drvMirrored = looped;
    }
    lpDrivingAbs = drvMirrored;
  } else if (isPklDriving) {
    // driving 是 pkl：它本身就是「完整动作序列」，长度由 driving_n_frames 决定
    // 直接给 LivePortrait 用，输出视频时长 = pkl 帧数 / fps
    // 如果 pkl 比音频短，LivePortrait 会自己 loop 整个动作序列直到音频长度（n_frames 不变，重复 action）
    // 这个「重复」是 pkl 模型本身的限制——pkl 是预提取动作模板，不含 audio 对齐信息
    // 改进建议：用户应该上传真人 mp4（而不是 pkl）
    lpDrivingAbs = path.join(mirrorDir, `driving_${srcStamp}${path.extname(driving)}`);
    fs.copyFileSync(driving, lpDrivingAbs);
    log(`[${runId}] [LIVEPORTRAIT] driving 是 pkl 模板（单动作循环），如果比音频短会重复。建议上传真人说话 mp4。`);
  } else {
    throw new Error(`不支持的 driving 格式：${driving}`);
  }

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
  // 默认走 GPU。tyro 用 --flag_x true/false（不带值会被当 True）。
  // 自动裁剪驱动视频到1:1头部区域（处理非方形的上传视频）+ expression-friendly 模式
  // （expression-friendly 让唇部动作幅度更明显，适合口播场景）
  const isVideo = /\.(mp4|mov|webm)$/i.test(lpDrivingAbs);
  const args = [
    path.join(LP_RUNTIME_DIR, '_lp_wrapper.py'),
    '-s', lpSourceAbs, '-d', lpDrivingAbs,
    '-o', 'animations/',
    '--driving_option', 'expression-friendly',
  ];
  if (isVideoDriving) {
    // 上传的驱动视频可能是16:9/9:16，自动裁头部
    args.push('--flag_crop_driving_video');
  }
  const logFile = path.join(LOGS_DIR, 'step5_liveportrait.log');
  log(`[${runId}] [LIVEPORTRAIT] 推理启动：source=${path.basename(lpSourceAbs)} driving=${path.basename(lpDrivingAbs)}`);
  logLine(`[${runId}] [LIVEPORTRAIT] python inference.py -s "${lpSourceAbs}" -d "${lpDrivingAbs}" -o animations/`);
  const py = process.env.LIVEPORTRAIT_PYTHON || 'C:\\Users\\Administrator\\AppData\\Local\\Programs\\Python\\Python311\\python.exe';
  // LivePortrait 默认带 rich 进度条（stderr），不需要解析进度文本
  // env: PYTHONIOENCODING/PYTHONUTF8=1 避免 rich 在 cp1252 控制台上报 UnicodeEncodeError
  // （Windows 下 Python 3.14 rich + 中文路径会报这个错）
  // PATH 前置 ffmpeg bin：LivePortrait 的 inference.py 依赖 ffmpeg/ffprobe（服务器进程 PATH 常无 ffmpeg）
  const ffDirLP = /[\\/]/.test(ffmpegCmd()) ? path.dirname(ffmpegCmd()) : null;
  const lpEnv = { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
  if (ffDirLP) lpEnv.PATH = `${ffDirLP}${path.delimiter}${process.env.PATH || ''}`;
  const r0 = await execChild(py, args, {
    cwd: LP_RUNTIME_DIR, timeoutMs: 30 * 60 * 1000, logFile,
    env: lpEnv,
  });
  if (r0.code !== 0 || r0.killed) {
    const tail = errTail(r0.stderr || r0.stdout, 800);
    // 友好的特殊错误提示：老版本 .pkl 文件与新版 LivePortrait 不兼容
    let hint = '';
    if (/c_d_eyes_lst|c_d_lip_lst/.test(tail)) {
      hint = `\n\n【原因】驱动模板是旧版格式（缺 c_d_eyes_lst/c_d_lip_lst 字段），与本仓库代码不兼容。\n` +
             `【解决】在表单驱动项里换一个兼容的模板：d1.pkl / d2.pkl / d5.pkl / d7.pkl / d8.pkl / wink.pkl，或者上传你自己的 mp4 驱动视频（会自动抽取动作）。`;
    } else if (/CUDAExecutionProvider|cublasLt|onnxruntime_providers_cuda/.test(tail)) {
      hint = `\n\n【原因】onnxruntime-gpu 需要额外 CUDA 依赖。LivePortrait 本身不依赖该 DLL，本错误不影响后续运行，可忽略。`;
    } else if (/AssertionError.*CUDA|Torch not compiled with CUDA/.test(tail)) {
      hint = `\n\n【原因】PyTorch 是 CPU 版；请在 .env 里配置 LIVEPORTRAIT_PYTHON 指向装了 torch==2.5.0+cu121 的 Python。`;
    }
    throw new Error(`LivePortrait 推理失败（退出码 ${r0.code}${r0.killed ? '，超时被终止' : ''}）：${tail}${hint}`);
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

  // 5) 把 LivePortrait 视频缩放到目标分辨率 + 把 TTS 音频合成上去（noMux=true 时跳过：音频由 LatentSync 生成）
  if (opts.noMux) {
    log(`[${runId}] [LIVEPORTRAIT] ✅ 画面完成（未混音，交由 LatentSync 对口型）：${lpVideo}（${lpDur.toFixed(1)}s）`);
    return { videoPath: lpVideo, duration: lpDur, size: fsize(lpVideo), lpOutput: lpVideo, unmuxed: true };
  }
  //    LivePortrait 输出视频时长已经 = 音频时长（提前 loop driving 保证），所以这里只做 scale + mux。
  //    若 LivePortrait 输出短了一点点（实际常见±0.3s），用 -shortest 让音频截断视频来匹配，保证音画同步。
  //    【旧设计错误】之前用 ffmpeg stream_loop -1 loop LivePortrait 输出，会重复同表情。现改为提前 loop driving。
  const loopedVideo = lpVideo;  // 保持向后兼容的变量名；不再额外 loop
  // 跳过中间的 loop 步骤，直接 mux
  const muxArgs = [
    '-y', '-i', lpVideo, '-i', audioMirror,
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
      const keep = new Set([path.basename(lpVideo)]);
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