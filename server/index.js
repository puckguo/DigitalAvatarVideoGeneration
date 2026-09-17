'use strict';
/**
 * 本地控制台服务（仅监听 127.0.0.1）
 * - 静态托管 web/ 前端
 * - 流水线 API：启动/状态/重试/停止/清理
 * - 环境校验 API、日志查看、素材与产物文件管理（上传/下载/预览/删除）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const {
  ROOT, LOGS_DIR, MATERIALS_DIR, ensureDirs, logLine, fsize, fmtBytes, sanitizeName,
} = require('./utils');
const pipeline = require('./pipeline');
const { runEnvCheck, runAutofix } = require('./envcheck');
const heygen = require('./heygen_mcp');
const liveportrait = require('./liveportrait');
const latentsync = require('./latentsync');

const PORT = parseInt((pipeline.defaults().env.PORT), 10) || 7788;
const WEB_DIR = path.join(ROOT, 'web');
const ALLOWED_DIRS = ['output', 'materials', 'resources', 'logs'];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.txt': 'text/plain; charset=utf-8', '.srt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
};

/* ---------------- 工具 ---------------- */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
async function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function safePathInside(rootDir, relPath) {
  const abs = path.resolve(rootDir, relPath || '');
  const rootAbs = path.resolve(rootDir);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null && end === null) return null;
  if (start === null) { start = Math.max(0, size - (end || 1)); end = size - 1; }
  if (end === null || end >= size) end = size - 1;
  if (start > end || start < 0 || start >= size) return null;
  return { start, end };
}

/* ---------------- 文件管理 ---------------- */

function listDir(dirName) {
  const rootDir = dirName === 'materials' ? MATERIALS_DIR : path.join(ROOT, dirName);
  if (!fs.existsSync(rootDir)) return [];
  const out = [];
  const walk = (rel, depth) => {
    const abs = path.join(rootDir, rel);
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const eAbs = path.join(abs, e.name);
      if (e.isDirectory()) {
        out.push({ name: e.name, path: `${dirName}/${relPath}`, type: 'dir', size: 0, mtime: '' });
        if (depth < 2) walk(relPath, depth + 1);
      } else {
        let stat = null;
        try { stat = fs.statSync(eAbs); } catch (_) {}
        out.push({
          name: e.name, path: `${dirName}/${relPath}`, type: 'file',
          size: stat ? stat.size : 0, mtime: stat ? stat.mtime.toISOString() : '',
        });
      }
    }
  };
  walk('', 0);
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return out;
}

/* ---------------- 服务 ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  try {
    /* ---- 静态前端 ---- */
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(path.join(WEB_DIR, 'index.html')));
      return;
    }
    if (req.method === 'GET' && (p === '/app.js' || p === '/style.css')) {
      const file = path.join(WEB_DIR, p.slice(1));
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(file));
      return;
    }

    /* ---- API ---- */
    if (p === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, time: new Date().toISOString() });

    if (p === '/api/defaults' && req.method === 'GET') return json(res, 200, pipeline.defaults());

    if (p === '/api/status' && req.method === 'GET') return json(res, 200, pipeline.getStatus());

    if (p === '/api/run' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const r = pipeline.startRun(body.params || body);
      return r.error ? json(res, 400, r) : json(res, 200, r);
    }

    if (p === '/api/retry' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const r = pipeline.retryRun(body.step, body.params);
      return r.error ? json(res, 400, r) : json(res, 200, r);
    }

    if (p === '/api/history/detail' && req.method === 'GET') {
      const r = pipeline.historyDetail(url.searchParams.get('run') || '');
      return r.error ? json(res, 404, r) : json(res, 200, r);
    }

    if (p === '/api/stop' && req.method === 'POST') {
      const r = pipeline.stopRun();
      return r.error ? json(res, 400, r) : json(res, 200, r);
    }

    if (p === '/api/cleanup' && req.method === 'POST') return json(res, 200, pipeline.cleanupOutputs());

    if (p === '/api/env' && req.method === 'GET') {
      const deep = url.searchParams.get('deep') === '1';
      const report = await runEnvCheck({ deep });
      return json(res, 200, report);
    }
    if (p === '/api/env/autofix' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const r = await runAutofix(body.fix);
      if (!r.ok) return json(res, 500, r);
      return json(res, 200, await runEnvCheck({ deep: false }));
    }

    if (p === '/api/logs' && req.method === 'GET') {
      const file = (url.searchParams.get('file') || 'pipeline.log').replace(/[\\/]/g, '');
      const abs = safePathInside(LOGS_DIR, file);
      if (!abs || !fs.existsSync(abs)) return json(res, 404, { error: `日志不存在: ${file}` });
      const lines = Math.min(2000, Math.max(10, parseInt(url.searchParams.get('lines') || '400', 10) || 400));
      const text = fs.readFileSync(abs, 'utf8').split('\n').slice(-lines).join('\n');
      return json(res, 200, { file, lines, text });
    }

    if (p === '/api/files' && req.method === 'GET') {
      const dir = url.searchParams.get('dir') || 'output';
      if (!ALLOWED_DIRS.includes(dir)) return json(res, 400, { error: `不支持的目录：${dir}` });
      return json(res, 200, { dir, files: listDir(dir) });
    }

    if (p === '/api/download' && req.method === 'GET') {
      const rel = url.searchParams.get('path') || '';
      const preview = url.searchParams.get('preview') === '1';
      const abs = safePathInside(ROOT, rel);
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return json(res, 404, { error: '文件不存在' });
      const stat = fs.statSync(abs);
      const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      const headers = {
        'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
        'Content-Disposition': `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`,
      };
      // 预览模式支持 Range（video/audio 拖动进度条必需）
      if (preview) {
        const range = parseRange(req.headers.range, stat.size);
        if (range) {
          res.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
            'Content-Length': String(range.end - range.start + 1),
          });
          fs.createReadStream(abs, { start: range.start, end: range.end }).pipe(res);
          return;
        }
      }
      res.writeHead(200, { ...headers, 'Content-Length': String(stat.size) });
      fs.createReadStream(abs).pipe(res);
      return;
    }

    if (p === '/api/file' && req.method === 'DELETE') {
      const rel = url.searchParams.get('path') || '';
      const abs = safePathInside(ROOT, rel);
      if (!abs) return json(res, 400, { error: '非法路径' });
      const inAllowed = ALLOWED_DIRS.some((d) => abs.startsWith(path.resolve(ROOT, d) + path.sep));
      if (!inAllowed) return json(res, 400, { error: '仅允许删除 output/materials/resources/logs 下的文件' });
      if (!fs.existsSync(abs)) return json(res, 404, { error: '文件不存在' });
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) return json(res, 400, { error: '不支持删除目录' });
      fs.rmSync(abs, { force: true });
      logLine(`[FILES] 删除文件 ${rel}（${fmtBytes(stat.size)}）`);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/materials' && req.method === 'GET') {
      const categories = pipeline.MATERIAL_CATEGORIES.map((cat) => {
        const dirAbs = path.join(ROOT, cat.dir);
        const files = [];
        try {
          for (const e of fs.readdirSync(dirAbs, { withFileTypes: true })) {
            if (!e.isFile()) continue;
            const st = fs.statSync(path.join(dirAbs, e.name));
            files.push({ name: e.name, path: `${cat.dir}/${e.name}`, size: st.size, mtime: st.mtime.toISOString() });
          }
        } catch (_) {}
        files.sort((a, b) => b.mtime.localeCompare(a.mtime));
        return { ...cat, files, count: files.length, totalSize: files.reduce((s, f) => s + f.size, 0) };
      });
      return json(res, 200, { ok: true, categories });
    }

    if (p === '/api/upload' && req.method === 'POST') {
      const dir = url.searchParams.get('dir') || 'materials';
      const category = url.searchParams.get('category') || '';
      const name = sanitizeName(url.searchParams.get('name') || '');
      if (!name) return json(res, 400, { error: '缺少文件名' });
      let rootDir;
      let relDir;
      if (category) {
        const cat = pipeline.MATERIAL_CATEGORIES.find((c) => c.id === category);
        if (!cat) return json(res, 400, { error: `未知素材分类：${category}` });
        const ext = ((name.match(/\.(\w+)$/) || [])[1] || '').toLowerCase();
        if (cat.exts.length && !cat.exts.includes(ext)) {
          return json(res, 400, { error: `「${cat.name}」仅支持 ${cat.exts.join('/')} 格式（收到 .${ext || '无后缀'}），请选择对应分类或「其他」` });
        }
        rootDir = path.join(ROOT, cat.dir);
        relDir = cat.dir;
      } else {
        if (!ALLOWED_DIRS.includes(dir)) return json(res, 400, { error: `不支持的目录：${dir}` });
        rootDir = dir === 'materials' ? MATERIALS_DIR : path.join(ROOT, dir);
        relDir = dir;
      }
      fs.mkdirSync(rootDir, { recursive: true });
      const buf = await readBody(req, 2 * 1024 * 1024 * 1024);
      const abs = path.join(rootDir, name);
      fs.writeFileSync(abs, buf);
      logLine(`[FILES] 上传素材 ${relDir}/${name}（${fmtBytes(buf.length)}）`);
      return json(res, 200, { ok: true, path: `${relDir}/${name}`, size: buf.length });
    }

    if (p === '/api/heygen/login' && req.method === 'GET') {
      try {
        const authUrl = await heygen.beginLogin(`http://127.0.0.1:${PORT}`);
        res.writeHead(302, { Location: authUrl });
        res.end();
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h2>发起 HeyGen 授权失败</h2><pre>${String(e.message || e)}</pre><p>请确认网络可访问 mcp.heygen.com / api2.heygen.com（如需代理，在 .env 配置 HEYGEN_PROXY=http://127.0.0.1:7890 后重启控制台）</p>`);
      }
      return;
    }

    if (p === '/api/heygen/callback' && req.method === 'GET') {
      const q = {};
      for (const [k, v] of url.searchParams.entries()) q[k] = v;
      let html;
      try {
        const r = await heygen.completeLogin(q);
        if (r.ok) {
          html = `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#151a24;color:#e6e9f0;display:flex;justify-content:center;align-items:center;height:100vh;margin:0"><div style="text-align:center"><h1>✅ HeyGen 连接成功</h1><p>已绑定你的 HeyGen 账号（OAuth 令牌已保存到本地 secrets/heygen_mcp_token.json）</p><p>可以关闭本页，回到控制台点击「重新检测」</p></div></body>`;
        } else {
          html = `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#151a24;color:#e6e9f0"><div style="max-width:600px;margin:80px auto"><h1>❌ 连接失败</h1><pre>${r.error}</pre><p>请回到控制台重新点击「连接 HeyGen」</p></div></body>`;
        }
      } catch (e) {
        html = `<!doctype html><meta charset="utf-8"><body><h2>❌ 连接异常</h2><pre>${String(e.message || e)}</pre></body>`;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (p === '/api/heygen/status' && req.method === 'GET') {
      return json(res, 200, await heygen.getStatus());
    }

    if (p === '/api/heygen/avatars' && req.method === 'GET') {
      try {
        const [priv, pub] = await Promise.all([
          heygen.listAvatarLooks(50, 'private').catch(() => []),
          heygen.listAvatarLooks(50, 'public').catch(() => []),
        ]);
        return json(res, 200, { ok: true, avatars: [...priv, ...pub] });
      } catch (e) {
        return json(res, 400, { error: `获取数字人列表失败：${e.message}（若未授权请先在「环境检查」页连接 HeyGen）` });
      }
    }

    if (p === '/api/heygen/logout' && req.method === 'POST') {
      heygen.logout();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/human/confirm' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const r = pipeline.confirmHuman(Number(body.step), body.content);
      return r.error ? json(res, 400, r) : json(res, 200, r);
    }

    /* ---- LivePortrait（本地数字人推理）---- */
    if (p === '/api/liveportrait/status' && req.method === 'GET') {
      const r = liveportrait.readySummary();
      let pythonDeps = null;
      try { pythonDeps = await liveportrait.checkPythonDeps(); } catch (e) { pythonDeps = { ok: false, detail: e.message }; }
      return json(res, 200, { ...r, pythonDeps, root: path.relative(ROOT, path.join(ROOT, 'LivePortrait')) });
    }

    if (p === '/api/liveportrait/driving' && req.method === 'GET') {
      return json(res, 200, { ok: true, drivings: liveportrait.listBuiltInDrivings() });
    }
    // LatentSync 状态与可作驱动视频的素材（materials/video + LivePortrait 产物）
    if (p === '/api/latentsync/status' && req.method === 'GET') {
      const r = latentsync.readySummary();
      let pythonDeps = null;
      try { pythonDeps = await latentsync.checkPythonDeps(); } catch (e) { pythonDeps = { ok: false, detail: e.message }; }
      return json(res, 200, { ok: true, ...r, commit: latentsync.LS_COMMIT, pythonDeps });
    }
    if (p === '/api/latentsync/videos' && req.method === 'GET') {
      const vids = [];
      const push = (abs, group) => {
        try {
          if (fs.existsSync(abs) && /\.(mp4|mov|webm)$/i.test(abs)) {
            vids.push({ path: path.relative(ROOT, abs).replace(/\\/g, '/'), group, size: fs.statSync(abs).size });
          }
        } catch (_) {}
      };
      for (const d of ['materials/video', 'resources', 'LatentSync/assets', 'LivePortrait/animations']) {
        try {
          for (const f of fs.readdirSync(path.join(ROOT, d))) push(path.join(ROOT, d, f), d);
        } catch (_) {}
      }
      // LivePortrait 仓库示例驱动视频（真人口播，适合 LatentSync）
      try {
        for (const f of fsx.readdirSync(pathx.join(ROOT, 'LivePortrait', 'assets', 'examples', 'driving'))) {
          if (/\.(mp4|webm)$/i.test(f)) vids.push({ path: `LivePortrait/assets/examples/driving/${f}`, group: 'liveportrait-driving', size: 0 });
        }
      } catch (_) {}
      return json(res, 200, { ok: true, videos: vids });
    }

    return json(res, 404, { error: `未知接口：${req.method} ${p}` });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
});

ensureDirs();
server.listen(PORT, '127.0.0.1', () => {
  const banner = [
    '',
    '==========================================================',
    '  🎬 数字人视频流水线控制台已启动',
    `  地址:   http://127.0.0.1:${PORT}`,
    `  工作区: ${ROOT}`,
    '  流程:   Codex文案 → MiniMax TTS → HeyGen数字人',
    '          → Codex字幕 → Remotion合成 → FFmpeg压缩',
    '==========================================================',
    '',
  ].join('\n');
  console.log(banner);
  logLine(`[SERVER] 控制台启动 http://127.0.0.1:${PORT}`);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`端口 ${PORT} 已被占用：请关闭占用程序，或在 .env 中修改 PORT`);
  else console.error('服务启动失败：', e.message);
  process.exit(1);
});
