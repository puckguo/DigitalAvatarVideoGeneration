'use strict';
/**
 * 通用工具：目录/环境变量/.env 解析、子进程执行、SRT 解析、ffprobe、日志与状态文件
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
const LOGS_DIR = path.join(ROOT, 'logs');
const MATERIALS_DIR = path.join(ROOT, 'materials');
const STATE_FILE = path.join(LOGS_DIR, 'state.json');
const LOG_FILE = path.join(LOGS_DIR, 'pipeline.log');
const REMOTION_DIR = path.join(ROOT, 'remotion');

let _envCache = null;

/** 读取环境变量：process.env < .env < secrets/.api_keys.json（后者仅补充密钥字段） */
function getEnv(force = false) {
  if (_envCache && !force) return _envCache;
  const env = { ...process.env };
  try {
    const text = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      env[k] = v;
    }
  } catch (_) { /* .env 可选 */ }
  try {
    const secrets = JSON.parse(fs.readFileSync(path.join(ROOT, 'secrets', '.api_keys.json'), 'utf8'));
    const map = { minimax: 'MINIMAX_API_KEY', heygen: 'HEYGEN_API_KEY', openai: 'OPENAI_API_KEY' };
    for (const [k, envKey] of Object.entries(map)) {
      if (secrets[k] && !env[envKey]) env[envKey] = secrets[k];
    }
  } catch (_) { /* secrets 文件可选 */ }
  _envCache = env;
  return env;
}

function ensureDirs() {
  for (const d of [
    OUTPUT_DIR, LOGS_DIR, MATERIALS_DIR,
    path.join(ROOT, 'resources'), path.join(ROOT, 'secrets'),
    path.join(OUTPUT_DIR, 'archive'), path.join(REMOTION_DIR, 'public'),
    ...['voice', 'photo', 'image', 'audio', 'video', 'doc', 'other'].map((c) => path.join(MATERIALS_DIR, c)),
  ]) fs.mkdirSync(d, { recursive: true });
}

function nowIso() { return new Date().toISOString(); }
function ts() { return new Date().toLocaleString('sv-CH', { hour12: false }); }

function logLine(msg) {
  ensureDirs();
  fs.appendFileSync(LOG_FILE, `[${ts()}] ${msg}\n`, 'utf8');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJsonAtomic(file, obj) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(file + '.tmp', file);
}

function fsize(f) { try { return fs.statSync(f).size; } catch (_) { return 0; } }
function exists(f) { return fsize(f) > 0; }
function fmtBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
function sanitizeName(name) {
  return path.basename(String(name || 'file')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_');
}

/* ---------------- 子进程执行 ---------------- */

const runningChilds = new Map(); // pid -> child

function killTree(child) {
  try {
    if (!child || child.killed) return;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { child.kill('SIGKILL'); }
    }
  } catch (_) { /* ignore */ }
}
function killAllChilds() { for (const c of runningChilds.values()) killTree(c); }

/** 参数含空格/括号等特殊字符时加双引号（cmd 仅用于首段命令字符串） */
const shellQuote = (a) => (/^[\w@%+=:,./\-]+$/.test(a) ? a : `"${a}"`);

/**
 * 执行子进程。
 * @param {string} cmd   命令；shell=true 时可含完整命令行（args 传 []）
 * @param {string[]} args 参数
 * @param {object} opts { shell, timeoutMs, logFile, input(stdin), cwd, onOutput }
 * @returns {Promise<{code,stdout,stderr,killed,error?}>}
 */
function execChild(cmd, args = [], opts = {}) {
  const {
    shell = false,
    timeoutMs = 20 * 60 * 1000,
    logFile = null,
    input = null,
    cwd = ROOT,
    onOutput = null,
  } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      const env = getEnv();
      child = shell
        ? spawn([cmd, ...args.map(shellQuote)].join(' '), { shell: true, cwd, windowsHide: true, env })
        : spawn(cmd, args, { cwd, windowsHide: true, env });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: '', killed: false, error: e.message });
      return;
    }
    const logStream = logFile ? fs.createWriteStream(logFile, { flags: 'w' }) : null;
    let stdout = '';
    let stderr = '';
    let killed = false;
    let settled = false;
    const MAX_CAP = 200 * 1024;

    const sink = (buf, isErr) => {
      const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
      if (logStream) logStream.write(s);
      if (onOutput) { try { onOutput(s); } catch (_) {} }
      if (isErr) { if (stderr.length < MAX_CAP) stderr += s.slice(0, MAX_CAP - stderr.length); }
      else if (stdout.length < MAX_CAP) stdout += s.slice(0, MAX_CAP - stdout.length);
    };
    if (child.stdout) child.stdout.on('data', (b) => sink(b, false));
    if (child.stderr) child.stderr.on('data', (b) => sink(b, true));

    const timer = timeoutMs ? setTimeout(() => {
      killed = true;
      killTree(child);
    }, timeoutMs) : null;

    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      runningChilds.delete(child.pid);
      if (logStream) { try { logStream.end(); } catch (_) {} }
      resolve({ ...res, killed });
    };

    if (input != null) {
      child.stdin.on('error', () => {});
      child.stdin.write(Buffer.from(String(input), 'utf8'));
      child.stdin.end();
    } else if (child.stdin) {
      try { child.stdin.end(); } catch (_) {}
    }

    child.on('error', (e) => finish({ code: -1, stdout, stderr, error: e.message }));
    child.on('close', (code) => finish({ code: code == null ? -1 : code, stdout, stderr }));
  });
}

/** 取进程输出的最后 N 个字符，用于错误提示 */
function errTail(text, max = 700) {
  const s = String(text || '').replace(/\r/g, '').trim();
  if (!s) return '';
  return s.length > max ? `…${s.slice(-max)}` : s;
}

/* ---------------- 媒体工具 ---------------- */

function ffprobeCmd() { return (getEnv().FFPROBE_PATH || 'ffprobe').trim(); }
function ffmpegCmd() { return (getEnv().FFMPEG_PATH || 'ffmpeg').trim(); }

async function ffprobeDuration(file) {
  const r = await execChild(ffprobeCmd(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file], { timeoutMs: 30 * 1000 });
  if (r.code !== 0) return null;
  try { return parseFloat(JSON.parse(r.stdout).format.duration); } catch (_) { return null; }
}

/* ---------------- SRT ---------------- */

function srtTimeToSec(t) {
  const m = String(t).trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + Number(`0.${(m[4] + '000').slice(0, 3)}`);
}
function secToSrtTime(sec) {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600); const mi = Math.floor((s % 3600) / 60); const se = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(h)}:${pad(mi)}:${pad(se)},${pad(ms, 3)}`;
}
function parseSrt(text) {
  const cues = [];
  const blocks = String(text || '').replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    if (!lines.length) continue;
    let i = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
    const tm = lines[i] && lines[i].match(/(\d+:\d+:\d+[,.]\d+)\s*-->\s*(\d+:\d+:\d+[,.]\d+)/);
    if (!tm) continue;
    const start = srtTimeToSec(tm[1]);
    const end = srtTimeToSec(tm[2]);
    if (start == null || end == null || end < start) continue;
    const cueText = lines.slice(i + 1).join('\n').replace(/\n{2,}/g, '\n').trim();
    if (cueText) cues.push({ start, end, text: cueText });
  }
  return cues;
}
function serializeSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${secToSrtTime(c.start)} --> ${secToSrtTime(c.end)}\n${c.text}`).join('\n\n') + '\n';
}

/** WAV(PCM16) 自相关法估基频 F0(Hz)；用于克隆音色验证（男声~90Hz / 女声~230Hz 量级） */
function estimateF0(wavFile) {
  try {
    const buf = fs.readFileSync(wavFile);
    if (buf.length < 64 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    let off = 12; let ch = 1; let rate = 16000; let bits = 16; let dataOff = -1; let dataLen = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const sz = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') { ch = buf.readUInt16LE(off + 10) || 1; rate = buf.readUInt32LE(off + 12) || 16000; bits = buf.readUInt16LE(off + 22) || 16; }
      else if (id === 'data') { dataOff = off + 8; dataLen = Math.min(sz, buf.length - dataOff); break; }
      off += 8 + sz + (sz % 2);
    }
    if (dataOff < 0 || bits !== 16) return null;
    // 抽单声道采样并降到 ~8kHz
    const dec = Math.max(1, Math.round(rate / 8000));
    const effRate = Math.floor(rate / dec);
    const mono = [];
    for (let i = 0; i + 1 < dataLen; i += 2 * ch) mono.push(buf.readInt16LE(dataOff + i));
    const s = [];
    for (let i = 0; i < mono.length; i += dec) s.push(mono[i]);
    const win = effRate;
    if (s.length < win) return null;
    // 取能量最高的 1 秒窗口
    let best = -1; let bi = 0;
    for (let i = 0; i + win <= s.length; i += Math.floor(win / 2)) {
      let e = 0;
      for (let j = i; j < i + win; j += 8) e += s[j] * s[j];
      if (e > best) { best = e; bi = i; }
    }
    const seg = s.slice(bi, bi + win);
    let rms = 0;
    for (const x of seg) rms += x * x;
    rms = Math.sqrt(rms / seg.length);
    if (rms < 100) return null;
    const m = seg.reduce((a, b) => a + b, 0) / seg.length;
    const seg0 = seg.map((x) => x - m);
    const e0 = seg0.reduce((a, b) => a + b * b, 0) / seg0.length;
    const lo = Math.floor(effRate / 400); const hi = Math.ceil(effRate / 60);
    let bestLag = 0; let bestR = 0;
    for (let lag = lo; lag <= Math.min(hi, Math.floor(seg0.length / 2)); lag++) {
      let sum = 0; let n = 0;
      for (let j = 0; j + lag < seg0.length; j += 4) { sum += seg0[j] * seg0[j + lag]; n++; }
      if (!n) continue;
      const r = sum / n;
      if (r > bestR) { bestR = r; bestLag = lag; }
    }
    if (!bestLag || !e0) return null;
    const conf = bestR / e0;
    if (conf < 0.25) return null;
    return Math.round((effRate / bestLag) * 10) / 10;
  } catch (_) { return null; }
}

module.exports = {
  ROOT, OUTPUT_DIR, LOGS_DIR, MATERIALS_DIR, REMOTION_DIR, STATE_FILE, LOG_FILE,
  getEnv, ensureDirs, nowIso, ts, logLine, readJson, writeJsonAtomic,
  fsize, exists, fmtBytes, sanitizeName,
  execChild, errTail, killAllChilds, runningChilds,
  ffprobeCmd, ffmpegCmd, ffprobeDuration,
  srtTimeToSec, secToSrtTime, parseSrt, serializeSrt, estimateF0,
};
