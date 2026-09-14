/* 数字人视频流水线控制台 */
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let v = n;
  while (v >= 1024 && i < 3) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const fmtTime = (iso) => { if (!iso) return '-'; const d = new Date(iso); return d.toLocaleString('zh-CN', { hour12: false }); };

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.error || `请求失败 HTTP ${res.status}`);
  return data;
}

function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.className = 'toast hidden'; }, isErr ? 6000 : 2600);
}
function openModal(html) { $('modalBody').innerHTML = html; $('modal').classList.remove('hidden'); }
function closeModal() { $('modal').classList.add('hidden'); $('modalBody').innerHTML = ''; }

/* ---------------- Tab 切换 ---------------- */
let currentTab = 'create';
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tabpane').forEach((el) => el.classList.remove('active'));
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  $(`tab-${tab}`).classList.add('active');
  if (tab === 'progress') refreshStatus(true);
  if (tab === 'files') loadFiles();
  if (tab === 'materials') loadMaterials();
  if (tab === 'env') loadEnv(false);
  if (tab === 'logs') { refreshLogFiles(); loadLog(); }
}

/* ---------------- 初始化 ---------------- */
let DEFAULTS = null;
let lastRunKey = '';

async function init() {
  try {
    DEFAULTS = await api('/api/defaults');
    fillForm();
  } catch (e) { toast(`读取默认配置失败：${e.message}`, true); }
  refreshStatus();
  setInterval(() => { if (state && (state.status === 'running' || state.status === 'waiting')) refreshStatus(); }, 1500);
  setInterval(() => { if (currentTab === 'logs' && $('logFileSel').checked === false) loadLog(true); }, 3000);
}

function fillForm() {
  const d = DEFAULTS.defaults;
  const opt = (sel, val, label) => { const o = document.createElement('option'); o.value = val; o.textContent = label; sel.appendChild(o); };
  DEFAULTS.styles.forEach((s) => opt($('f_style'), s, s));
  DEFAULTS.voices.forEach((v) => opt($('f_voice'), v.id, `${v.label}（${v.id}）`));
  DEFAULTS.resolutions.forEach((r) => opt($('f_resolution'), r.id, r.label));
  DEFAULTS.qualities.forEach((q) => opt($('f_quality'), q.id, q.label));
  // 数字人 provider
  if (DEFAULTS.avatarProviders) {
    const sel = $('f_avatarProvider');
    sel.innerHTML = '';
    DEFAULTS.avatarProviders.forEach((p) => { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; sel.appendChild(o); });
    sel.value = d.avatarProvider || 'heygen';
  }
  $('f_avatar').value = d.avatarId;
  $('f_avatar').placeholder = d.avatarId ? '' : 'HeyGen 数字人 Avatar ID（可在 .env 配置默认值）';
  $('f_lpSource').value = d.lpSource || 'resources/photo1.jpg';
  $('f_lpDriving').value = d.lpDriving || 'talking.pkl';
  // LivePortrait 就绪状态徽标
  const chip = $('lp_status_chip');
  if (DEFAULTS.env && DEFAULTS.env.LIVEPORTRAIT_READY) chip.innerHTML = '<span class="pill pill-ok" style="font-size:11px">Local LivePortrait：就绪</span>';
  else if (DEFAULTS.env) chip.innerHTML = '<span class="pill pill-warn" style="font-size:11px">Local LivePortrait：未就绪（在「环境检查」查看）</span>';
  toggleAvatarProvider();
}

function toggleAvatarProvider() {
  const v = $('f_avatarProvider').value;
  $('heygenBox').classList.toggle('hidden', v !== 'heygen');
  $('liveportraitBox').classList.toggle('hidden', v !== 'liveportrait');
}

/* ---------------- 启动流水线 ---------------- */
function toggleClone() {
  $('cloneBox').classList.toggle('hidden', !$('f_clone').checked);
}

async function startRun() {
  const params = {
    topic: $('f_topic').value.trim(),
    durationSec: Number($('f_duration').value) || 60,
    style: $('f_style').value,
    language: $('f_language').value,
    extra: $('f_extra').value.trim(),
    voice: $('f_voiceCustom').value.trim() || $('f_voice').value,
    speed: Number($('f_speed').value) || 1,
    useCloneVoice: $('f_clone').checked,
    cloneSource: $('f_cloneSource').value.trim() || 'resources/voice1.m4a',
    cloneVoiceId: $('f_cloneVoiceId').value.trim(),
    avatarProvider: $('f_avatarProvider').value,
    avatarId: $('f_avatar').value.trim(),
    lpSource: $('f_lpSource').value.trim(),
    lpDriving: $('f_lpDriving').value.trim(),
    resolution: $('f_resolution').value,
    quality: $('f_quality').value,
    runMode: $('f_runmode').value,
    showTitleBar: $('f_titleBar').checked,
    titleText: $('f_titleText').value.trim(),
    showProgressBar: $('f_progressBar').checked,
    watermark: $('f_watermark').value.trim(),
    manualBrief: $('f_manualBrief').checked,
    manualReview: $('f_manualReview').checked,
  };
  if (params.topic.length < 2) { toast('请先填写视频主题', true); $('f_topic').focus(); return; }
  if (params.avatarProvider === 'heygen' && params.avatarId.length < 2) { toast('请填写 HeyGen 数字人 Avatar ID', true); $('f_avatar').focus(); return; }

  $('btnRun').disabled = true;
  try {
    await api('/api/run', { method: 'POST', body: JSON.stringify({ params }) });
    toast('流水线已启动 🚀');
    lastRunKey = '';
    switchTab('progress');
  } catch (e) {
    toast(`启动失败：${e.message}`, true);
  } finally {
    $('btnRun').disabled = false;
  }
}

async function stopRun() {
  if (!confirm('确定停止当前流水线？')) return;
  try { await api('/api/stop', { method: 'POST' }); toast('已发送停止指令'); refreshStatus(); }
  catch (e) { toast(e.message, true); }
}

/* ---------------- 状态渲染 ---------------- */
let state = null;

async function refreshStatus(force = false) {
  try { state = await api('/api/status'); } catch (e) { return; }
  renderStatus();
  if (!force) renderBadge();
}

function renderBadge() {
  const b = $('runBadge');
  const map = {
    idle: ['空闲', 'pill-idle'], running: ['运行中', 'pill-running'],
    waiting: ['等待人工 ✍️', 'pill-warn'],
    success: ['已完成 ✅', 'pill-ok'], failed: ['失败 ❌', 'pill-err'], aborted: ['已停止', 'pill-warn'],
  };
  const [txt, cls] = map[state.status] || map.idle;
  b.textContent = txt;
  b.className = `pill ${cls}`;
  $('btnRun').disabled = state.status === 'running' || state.status === 'waiting';
  $('btnRun').textContent = state.status === 'running' ? '⏳ 任务运行中…' : (state.status === 'waiting' ? '✍️ 等待人工确认…' : '🚀 启动流水线');
}

function renderStatus() {
  renderBadge();
  const st = state;
  $('runTitle').textContent = st.params ? `任务 ${st.runId || ''} · 《${st.params.topic}》` : '暂无任务';
  $('btnStop').style.display = st.status === 'running' ? '' : 'none';
  $('btnCleanup').style.display = st.status === 'success' ? '' : 'none';

  if (st.params) {
    const p = st.params;
    $('runSummary').classList.remove('hidden');
    const providerChip = p.avatarProvider === 'liveportrait'
      ? `<span class="chip">👤 LivePortrait · ${esc(p.lpSource)} + ${esc(p.lpDriving)}</span>`
      : `<span class="chip">👤 HeyGen · ${esc(p.avatarId)}</span>`;
    $('runSummary').innerHTML = `
      <span class="chip">⏱ ${p.durationSec}s</span>
      <span class="chip">🎨 ${esc(p.style)}</span>
      <span class="chip">🗣 ${p.useCloneVoice ? `克隆音色 ${esc(p.cloneVoiceId)}` : esc(p.voice)}</span>
      <span class="chip">⚡ ${p.speed}x</span>
      ${providerChip}
      <span class="chip">🖥 ${p.resolution}</span>
      <span class="chip">📦 ${p.quality}</span>
      ${p.runMode && p.runMode !== 'full' ? `<span class="chip" style="border-color:var(--warn)">🧪 调试模式：${{ script: '仅文案', tts: '文案+配音', audio: '文案+配音+字幕' }[p.runMode] || p.runMode}</span>` : ''}
      <span class="chip">🟢 ${fmtTime(st.startedAt)}</span>
      ${st.status !== 'running' ? `<span class="chip">🏁 ${fmtTime(st.finishedAt)}</span>` : ''}
      ${p.extra ? `<span class="chip chip-wide">📌 ${esc(p.extra)}</span>` : ''}`;
  } else {
    $('runSummary').classList.add('hidden');
  }

  const icon = { pending: '⏸', running: '▶️', done: '✅', failed: '❌', skipped: '⏭️', waiting: '✍️' };
  $('stepsList').innerHTML = st.steps.map((s) => {
    let body = '';
    if (s.status === 'running') {
      body = `<div class="step-run">运行中… ${s.key === 'remotion' && s.progress != null ? `（渲染进度 ${s.progress}%）` : ''}${s.key === 'heygen' ? '（数字人渲染通常 1-3 分钟）' : ''}<span class="spinner"></span></div>`;
    } else if (s.status === 'done') {
      const bits = [`<a href="/api/download?path=${encodeURIComponent(s.output)}" download>⬇️ ${esc(s.output)}</a>`];
      if (s.meta) {
        if (s.meta.voiceId) bits.push(`音色ID ${s.meta.voiceId}`);
        if (s.meta.cloned) bits.push('🎤 克隆音色');
        if (s.meta.chars) bits.push(`${s.meta.chars} 字`);
        if (s.meta.duration) bits.push(`${Number(s.meta.duration).toFixed(1)}s`);
        if (s.meta.size) bits.push(fmtBytes(s.meta.size));
        if (s.meta.cues) bits.push(`${s.meta.cues} 条字幕`);
        if (s.meta.crf) bits.push(`CRF ${s.meta.crf}/${s.meta.preset}`);
        if (s.meta.provider === 'liveportrait') bits.push(`Local LivePortrait · driving=${esc(s.meta.driving || '')}`);
        if (s.meta.provider === 'heygen' && s.meta.videoId) bits.push(`HeyGen videoId ${s.meta.videoId}`);
      }
      body = `<div>${bits.join(' · ')}</div>`;
      if (/\.(mp4|wav|txt|srt)$/.test(s.output)) {
        body += ` <a href="javascript:void(0)" onclick="previewFile('${esc(s.output)}')" class="mini">👁 预览</a>`;
      }
    } else if (s.status === 'waiting') {
      body = `<div class="step-run">⏸ 等待人工确认…（流水线已暂停）</div>
        <button class="btn primary small" onclick="openHumanEditor()">✍️ 编辑并确认</button>`;
    } else if (s.status === 'skipped') {
      body = `<div class="hint">${esc((s.meta && s.meta.note) || '已跳过')}</div>`;
    } else if (s.status === 'failed') {
      body = `<div class="step-err">${esc(s.error || '未知错误')}</div>
        <div class="step-btns">
          ${st.status !== 'running' ? `<button class="btn small" onclick="retryStep(${s.id})">↻ 从 Step${s.id} 重跑（自动续到结尾）</button>` : ''}
        </div>`;
    }
    return `
      <div class="step s-${s.status}">
        <div class="step-head">
          <span class="st-ico">${icon[s.status] || '⏸'}</span>
          <b>Step${s.id} · ${esc(s.name)}</b>
          ${s.durSec ? `<span class="dur">${s.durSec}s</span>` : ''}
        </div>
        <div class="step-body">${body}</div>
      </div>`;
  }).join('');

  // 历史任务
  if (st.history && st.history.length) {
    $('historyCard').classList.remove('hidden');
    $('historyList').innerHTML = `<table class="filetable"><tr><th>任务</th><th>主题</th><th>状态</th><th>开始</th><th>成品</th></tr>${
      st.history.map((h) => `<tr>
        <td>${esc(h.runId || '')}</td><td>${esc(h.topic || '')}</td>
        <td>${h.status === 'success' ? '✅' : h.status === 'failed' ? '❌' : '⏹'}</td>
        <td>${fmtTime(h.startedAt)}</td>
        <td>${h.finalSize ? fmtBytes(h.finalSize) : '-'}</td></tr>`).join('')
    }</table>`;
  }

  // 进入人工等待时自动弹出编辑器（每个等待点只弹一次）
  if (st.status === 'waiting' && st.waiting) {
    const wk = `${st.runId}:${st.waiting.step}`;
    if (lastWaitingKey !== wk) { lastWaitingKey = wk; openHumanEditor(); }
  } else if (st.status !== 'waiting') lastWaitingKey = '';

  // 流程结束（成功且完整流程）→ 询问是否清理临时文件（交互规则）；调试模式不弹窗
  const key = `${st.runId}:${st.status}`;
  if (st.status === 'success' && lastRunKey !== key && (!st.params || st.params.runMode === 'full' || !st.params.runMode)) { lastRunKey = key; askCleanup(); }
  else if (st.status !== 'success') lastRunKey = '';
}

async function retryStep(step) {
  try {
    await api('/api/retry', { method: 'POST', body: JSON.stringify({ step }) });
    toast(`已从 Step${step} 重跑`);
    refreshStatus();
  } catch (e) { toast(e.message, true); }
}

let lastWaitingKey = '';

function openHumanEditor() {
  const w = state && state.waiting;
  if (!w) { toast('当前没有等待确认的步骤', true); return; }
  const isBrief = w.kind === 'brief';
  openModal(`
    <h3>${isBrief ? '⌨️ 人工需求输入（Step1）' : '📝 人工审稿定稿（Step3）'}</h3>
    <p class="hint">${isBrief
      ? '确认/补充需求要点，确认后作为 Codex 写稿的输入（时长、风格等仍按表单参数）'
      : '以下是 AI 生成的口播文稿，可直接修改，确认后将用于 TTS 配音与字幕'}</p>
    <textarea id="humanEdit" rows="14" style="width:100%;font-size:14px;line-height:1.8">${esc(w.prefill || '')}</textarea>
    <div class="modal-btns">
      <button class="btn primary" onclick="confirmHuman()">✅ 确认并继续流水线</button>
      <button class="btn ghost" onclick="closeModal()">稍后再改</button>
    </div>`);
  const ta = $('humanEdit'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
}

async function confirmHuman() {
  const w = state && state.waiting;
  if (!w) { toast('当前没有等待确认的步骤', true); return; }
  const content = $('humanEdit').value;
  try {
    await api('/api/human/confirm', { method: 'POST', body: JSON.stringify({ step: w.step, content }) });
    closeModal(); toast('已确认，流水线继续 🚀'); refreshStatus(true);
  } catch (e) { toast(`确认失败：${e.message}`, true); }
}

function askCleanup() {
  openModal(`
    <h3>🎉 视频已生成完成</h3>
    <p>最终成品：<b>output/06_final_video.mp4</b>${state && state.steps ? `（${fmtBytes((state.steps[5] && state.steps[5].meta && state.steps[5].meta.size) || 0)}）` : ''}</p>
    <p>是否清理 ./output/ 临时文件（01~05 中间产物）？最终视频会保留，也可稍后在文件管理中手动删除。</p>
    <div class="modal-btns">
      <button class="btn primary" onclick="doCleanup()">🧹 清理临时文件</button>
      <button class="btn ghost" onclick="closeModal()">暂不清理</button>
    </div>
    <div id="cleanupResult"></div>`);
}
async function doCleanup() {
  try {
    const r = await api('/api/cleanup', { method: 'POST' });
    $('cleanupResult').innerHTML = `<p class="hint" style="margin-top:10px">已清理 ${r.deleted.length} 个文件：${r.deleted.map(esc).join('、')}</p>
      <div class="modal-btns"><button class="btn" onclick="previewFile('output/06_final_video.mp4');closeModal()">👁 预览成品</button>
      <button class="btn ghost" onclick="closeModal()">关闭</button></div>`;
    toast('临时文件已清理');
  } catch (e) { toast(e.message, true); }
}

/* ---------------- 文件管理 ---------------- */
let fileDir = 'output';
function renderDirbar() {
  const dirs = [['output', '📦 output 产物'], ['materials', '🗂 materials 素材'], ['resources', '📁 resources'], ['logs', '📜 logs']];
  $('fileDirs').innerHTML = dirs.map(([d, label]) =>
    `<button class="btn small ${d === fileDir ? 'primary' : ''}" onclick="setDir('${d}')">${label}</button>`).join('');
}
function setDir(d) { fileDir = d; renderDirbar(); loadFiles(); }

async function loadFiles() {
  renderDirbar();
  let data;
  try { data = await api(`/api/files?dir=${fileDir}`); } catch (e) { toast(e.message, true); return; }
  const rows = data.files.map((f) => {
    const isFile = f.type === 'file';
    const previewable = isFile && /\.(mp4|wav|mp3|m4a|txt|srt|log|png|jpe?g|webp|gif)$/i.test(f.name);
    return `<tr>
      <td>${isFile ? '📄' : '📂'} ${esc(f.name)}</td>
      <td>${isFile ? fmtBytes(f.size) : '-'}</td>
      <td>${isFile ? fmtTime(f.mtime) : '-'}</td>
      <td class="ops">
        ${isFile ? `<a href="/api/download?path=${encodeURIComponent(f.path)}" download>⬇️ 下载</a>` : ''}
        ${previewable ? `<a href="javascript:void(0)" onclick="previewFile('${esc(f.path)}')">👁 预览</a>` : ''}
        ${isFile ? `<a href="javascript:void(0)" class="danger-link" onclick="deleteFile('${esc(f.path)}')">🗑 删除</a>` : ''}
      </td></tr>`;
  }).join('');
  $('fileTable').innerHTML = `<tr><th>名称</th><th>大小</th><th>修改时间</th><th>操作</th></tr>${rows || '<tr><td colspan="4" class="hint">目录为空</td></tr>'}`;
}

async function deleteFile(p) {
  if (!confirm(`确定删除 ${p}？`)) return;
  try { await api(`/api/file?path=${encodeURIComponent(p)}`, { method: 'DELETE' }); toast('已删除'); loadFiles(); }
  catch (e) { toast(e.message, true); }
}

async function uploadFiles(input) {
  const files = [...input.files];
  input.value = '';
  for (const f of files) {
    try {
      const r = await fetch(`/api/upload?dir=materials&name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      toast(`已上传：${f.name}`);
    } catch (e) { toast(`上传失败 ${f.name}：${e.message}`, true); }
  }
  if (currentTab === 'files') loadFiles();
}

function previewFile(p) {
  const ext = (p.match(/\.(\w+)$/) || [])[1]?.toLowerCase();
  const src = `/api/download?path=${encodeURIComponent(p)}&preview=1`;
  let inner;
  if (['mp4', 'webm'].includes(ext)) inner = `<video src="${src}" controls autoplay style="max-width:100%;max-height:70vh"></video>`;
  else if (['wav', 'mp3', 'm4a'].includes(ext)) inner = `<audio src="${src}" controls autoplay style="width:100%"></audio>`;
  else if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) inner = `<img src="${src}" style="max-width:100%;max-height:70vh">`;
  else inner = '<pre class="logview" id="textPreview">加载中…</pre>';
  openModal(`<h3 style="margin-bottom:10px">${esc(p)}</h3>${inner}
    <div class="modal-btns"><a class="btn" href="/api/download?path=${encodeURIComponent(p)}" download>⬇️ 下载</a>
    <button class="btn ghost" onclick="closeModal()">关闭</button></div>`);
  if (!ext || ['txt', 'srt', 'log', 'json', 'md'].includes(ext)) {
    fetch(src).then((r) => r.text()).then((t) => {
      const el = $('textPreview');
      if (el) el.textContent = t.slice(0, 50000);
    }).catch(() => {});
  }
}

/* ---------------- HeyGen MCP ---------------- */
async function browseAvatars() {
  openModal('<h3>👤 HeyGen 数字人形象</h3><p class="hint" id="avatarLoading">加载中（需已连接 HeyGen）…</p>');
  let data;
  try { data = await api('/api/heygen/avatars?limit=100'); } catch (e) {
    $('avatarLoading').innerHTML = `<span class="step-err">${esc(e.message)}</span>`; return;
  }
  const list = data.avatars || [];
  if (!list.length) { $('avatarLoading').textContent = '账号下没有可用的数字人形象（在 HeyGen 网页端创建后重试）'; return; }
  const cur = $('f_avatar').value.trim();
  $('avatarLoading').classList.add('hidden');
  const rows = list.map((a) => `
    <div class="avatar-item">
      ${a.preview ? `<img src="${esc(a.preview)}" loading="lazy" onerror="this.style.visibility='hidden'">` : '<div class="avatar-ph">👤</div>'}
      <div class="avatar-info">
        <b>${esc(a.name)}</b>
        <span class="hint">${esc(a.group || '')} · ${esc(a.avatar_id)}</span>
      </div>
      <button class="btn small ${cur === a.avatar_id ? 'primary' : ''}" onclick="pickAvatar('${esc(a.avatar_id)}')">${cur === a.avatar_id ? '✓ 已选' : '选择'}</button>
    </div>`).join('');
  const div = document.createElement('div');
  div.className = 'avatar-list';
  div.innerHTML = rows;
  $('modalBody').appendChild(div);
}
function pickAvatar(id) {
  $('f_avatar').value = id;
  toast(`已选择数字人：${id.slice(0, 24)}${id.length > 24 ? '…' : ''}`);
  closeModal();
}

/* ---------------- LivePortrait 浏览 ---------------- */
async function browseLpSources() {
  openModal('<h3>🧑 选择 LivePortrait 源人像</h3><p class="hint">可用范围：resources/、materials/photo/、materials/image/、LivePortrait/assets/examples/source/。也可在表单输入相对路径。</p>');
  const cats = [];
  for (const c of [
    { root: 'resources', label: 'resources/' },
    { root: 'materials', label: 'materials/photo/' },
    { root: 'materials', label: 'materials/image/' },
  ]) {
    try {
      const data = await api(`/api/files?dir=${c.root}`);
      const allowExt = /\.(jpe?g|png|webp|gif)$/i;
      const files = (c.label === 'materials/photo/' || c.label === 'materials/image/')
        ? (data.files || []).filter((f) => f.type === 'file' && (f.path.startsWith(c.label) || f.path === `${c.root}/`) && allowExt.test(f.name))
        : (data.files || []).filter((f) => f.type === 'file' && allowExt.test(f.name));
      cats.push({ ...c, files });
    } catch (_) {}
  }
  $('modalBody').appendChild(Object.assign(document.createElement('div'), {
    className: 'avatar-list',
    innerHTML: cats.map((c) => `
      <h4 style="margin:14px 0 6px;color:var(--hint)">${c.label}</h4>
      ${c.files.length === 0 ? '<p class="hint">无文件。可在「文件管理」上传，或直接填入路径。</p>' :
        c.files.map((f) => `
          <div class="avatar-item">
            <div class="avatar-ph"><img src="/api/download?path=${encodeURIComponent(f.path)}&preview=1" loading="lazy" onerror="this.replaceWith(document.createTextNode('👤'))"></div>
            <div class="avatar-info"><b>${esc(f.name)}</b><span class="hint">${esc(f.path)} · ${fmtBytes(f.size)}</span></div>
            <button class="btn small" onclick="pickLpSource('${esc(f.path)}')">选择</button>
          </div>`).join('')
      }
    `).join(''),
  }));
}
function pickLpSource(p) {
  $('f_lpSource').value = p;
  toast(`已选择源人像：${p}`);
  closeModal();
}

async function browseLpDrivings() {
  openModal('<h3>🎞 选择驱动视频 / 模板</h3><p class="hint">LivePortrait 内置 driving 模板（.pkl 预提取动作）与上传的 mp4 都可使用。模板加载更快且能避免上传视频隐私。</p><p class="hint" id="lpDrvStatus">加载中…</p>');
  let builtin = [];
  try { const r = await api('/api/liveportrait/driving'); builtin = r.drivings || []; } catch (_) {}
  $('lpDrvStatus').textContent = builtin.length ? `内置 ${builtin.length} 个 driving 模板` : '未找到内置 driving（仓库可能未完整克隆）';
  let uploaded = [];
  try {
    const data = await api('/api/files?dir=materials');
    uploaded = (data.files || []).filter((f) => f.type === 'file' && /\.(mp4|mov|webm)$/i.test(f.name));
  } catch (_) {}
  $('modalBody').appendChild(Object.assign(document.createElement('div'), {
    className: 'avatar-list',
    innerHTML: `
      ${builtin.length ? `<h4 style="margin:14px 0 6px;color:var(--hint)">内置 driving（直接选）</h4>
        ${builtin.map((d) => `
          <div class="avatar-item">
            <div class="avatar-ph">🎞️</div>
            <div class="avatar-info"><b>${esc(d.name)}</b><span class="hint">${d.type === 'template' ? '动作模板（.pkl）' : '驱动视频'} · LivePortrait/assets/examples/driving/</span></div>
            <button class="btn small" onclick="pickLpDriving('${esc(d.name)}')">选择</button>
          </div>`).join('')}` : ''}
      ${uploaded.length ? `<h4 style="margin:14px 0 6px;color:var(--hint)">用户上传的驱动视频（materials/video/）</h4>
        ${uploaded.map((f) => `
          <div class="avatar-item">
            <div class="avatar-ph">🎬</div>
            <div class="avatar-info"><b>${esc(f.name)}</b><span class="hint">${esc(f.path)} · ${fmtBytes(f.size)}</span></div>
            <button class="btn small" onclick="pickLpDriving('${esc(f.path)}')">选择</button>
          </div>`).join('')}` : '<p class="hint" style="margin-top:10px">用户上传的驱动视频为空；推荐使用内置 talking.pkl / laugh.pkl 等。</p>'}`,
  }));
}
function pickLpDriving(p) {
  $('f_lpDriving').value = p;
  toast(`已选择驱动：${p}`);
  closeModal();
}

async function connectHeygen() {
  toast('正在跳转 HeyGen 授权页，请在浏览器中登录并授权…');
  window.open('/api/heygen/login', '_blank');
}

/* ---------------- 素材库 ---------------- */
let matCache = [];
let uploadCatId = null;

async function loadMaterials() {
  let data;
  try { data = await api('/api/materials'); } catch (e) { $('materialsGrid').textContent = `加载失败：${e.message}`; return; }
  matCache = data.categories || [];
  $('materialsGrid').innerHTML = matCache.map((cat) => `
    <div class="material-cat">
      <div class="mc-head">
        <span class="mc-icon">${cat.icon}</span>
        <div class="mc-title"><b>${esc(cat.name)}</b><span class="hint">${esc(cat.desc)}</span></div>
        <span class="mc-count">${cat.count} 个 · ${fmtBytes(cat.totalSize)}</span>
      </div>
      <div class="hint mc-hint">${esc(cat.hint || '')}</div>
      <div class="mc-files">${cat.files.map((f) => `
        <div class="mc-file">
          <span class="mc-fname" title="${esc(f.path)}">${esc(f.name)}</span>
          <span class="hint">${fmtBytes(f.size)}</span>
          <span class="ops">
            <a href="javascript:void(0)" onclick="previewFile('${esc(f.path)}')" title="预览">👁</a>
            <a href="/api/download?path=${encodeURIComponent(f.path)}" download title="下载">⬇️</a>
            <a href="javascript:void(0)" class="danger-link" onclick="deleteMaterial('${esc(f.path)}')" title="删除">🗑</a>
          </span>
        </div>`).join('') || '<div class="hint">暂无素材，点击下方按钮上传</div>'}
      </div>
      <button class="btn small" onclick="uploadMaterial('${cat.id}')">⬆️ 上传${cat.exts && cat.exts.length ? `（${cat.exts.slice(0, 4).join('/')}）` : '（任意格式）'}</button>
    </div>`).join('');
  // 刷新克隆源 datalist（含 resources/ 下历史录音）
  const dl = $('voiceMaterials');
  if (dl) {
    const voiceFiles = (matCache.find((c) => c.id === 'voice') || { files: [] }).files.map((f) => `<option value="${esc(f.path)}">${esc(f.name)}</option>`).join('');
    dl.innerHTML = `<option value="resources/voice1.m4a">resources/voice1.m4a（默认）</option>${voiceFiles}`;
  }
}

function uploadMaterial(catId) {
  const cat = matCache.find((c) => c.id === catId);
  if (!cat) return;
  uploadCatId = catId;
  const input = $('materialUploadInput');
  input.accept = cat.exts && cat.exts.length ? cat.exts.map((e) => `.${e}`).join(',') : '';
  input.click();
}

async function materialUploaded(input) {
  const files = [...input.files];
  input.value = '';
  const cat = matCache.find((c) => c.id === uploadCatId);
  for (const f of files) {
    try {
      const r = await fetch(`/api/upload?category=${uploadCatId}&name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      toast(`已上传到「${cat ? cat.name : uploadCatId}」：${f.name}`);
    } catch (e) { toast(`上传失败 ${f.name}：${e.message}`, true); }
  }
  loadMaterials();
}

async function deleteMaterial(p) {
  if (!confirm(`确定删除素材 ${p}？`)) return;
  try { await api(`/api/file?path=${encodeURIComponent(p)}`, { method: 'DELETE' }); toast('已删除'); loadMaterials(); }
  catch (e) { toast(e.message, true); }
}

/* ---------------- 环境检查 ---------------- */
async function loadEnv(deep) {
  $('envList').innerHTML = '<p class="hint">检测中…</p>';
  let r;
  try { r = await api(`/api/env${deep ? '?deep=1' : ''}`); } catch (e) { $('envList').innerHTML = `<p class="step-err">${esc(e.message)}</p>`; return; }
  // LivePortrait 详情（在另一接口同时拉，避免被外层 try 拖走）
  let lpDetail = null;
  try { lpDetail = await api('/api/liveportrait/status'); } catch (_) {}
  $('envList').innerHTML = `
    <p>检测时间：${fmtTime(r.checkedAt)} · 必需项 ${r.items.filter((i) => i.required && i.ok).length}/${r.items.filter((i) => i.required).length} 通过 ·
    总体：${r.ok ? '✅ 通过' : '❌ 未通过'}</p>
    ${r.items.map((it) => `
      <div class="env-item ${it.ok ? 'ok' : it.warn ? 'warn' : 'fail'}">
        <div><b>${it.ok ? '✅' : it.warn ? '⚠️' : '❌'} ${esc(it.name)}</b>
          <span class="tag">${it.required ? '必需' : '可选'}</span></div>
        <div class="hint">${esc(it.detail)}</div>
        ${!it.ok && it.fix ? `<pre class="fix">${esc(it.fix)}</pre>` : ''}
        ${!it.ok && it.autofix ? `<button class="btn small" onclick="autofix('${it.autofix}')">🔧 一键修复</button>` : ''}
        ${it.id === 'heygen' && !it.ok ? `<button class="btn small primary" onclick="connectHeygen()">🔗 连接 HeyGen（OAuth 授权）</button>` : ''}
        ${it.id === 'heygen' && it.ok ? `<button class="btn small" onclick="heygenStatus()">👤 查看账号状态</button> <button class="btn small ghost" onclick="heygenDisconnect()">断开连接</button>` : ''}
        ${it.id === 'liveportrait' && lpDetail ? `<button class="btn small" onclick="alert('LivePortrait 权重缺失：\\n' + (lpDetail.weightsMissing || []).join('\\n'))">🔎 查看缺失权重</button>` : ''}
        <span id="heygenStatusBox"></span>
      </div>`).join('')}`;
  // 顶部徽标
  const badge = $('envBadge');
  badge.textContent = r.ok ? '🧪 环境 ✅' : '🧪 环境 ❌';
  badge.className = `pill pill-click ${r.ok ? 'pill-ok' : 'pill-err'}`;
}

async function autofix(fix = 'remotion-install') {
  toast('自动修复执行中，请稍候…');
  try {
    await api('/api/env/autofix', { method: 'POST', body: JSON.stringify({ fix }) });
    toast('自动修复完成');
    loadEnv(false);
  } catch (e) { toast(`修复失败：${e.message}`, true); }
}

async function heygenStatus() {
  const box = $('heygenStatusBox');
  box.innerHTML = ' <span class="hint">查询中…</span>';
  try {
    const s = await api('/api/heygen/status');
    if (s.connected) {
      const u = s.user || {};
      box.innerHTML = ` <span class="hint">✅ 已连接：${esc(u.name || u.email || '账号')} ${u.credits != null ? `· 剩余额度 ${u.credits}` : ''}</span>`;
    } else {
      box.innerHTML = ` <span class="hint" style="color:var(--err)">令牌可能已过期：${esc(s.error || '')}</span>`;
    }
  } catch (e) { box.innerHTML = ` <span class="hint" style="color:var(--err)">${esc(e.message)}</span>`; }
}

async function heygenDisconnect() {
  if (!confirm('确定断开 HeyGen 连接（删除本地令牌）？')) return;
  try { await api('/api/heygen/logout', { method: 'POST' }); toast('已断开'); loadEnv(false); }
  catch (e) { toast(e.message, true); }
}

/* ---------------- 日志 ---------------- */
async function loadLog(silent = false) {
  const useChild = $('logFileSel').checked;
  const file = useChild ? $('logFileList').value : 'pipeline.log';
  if (!silent) $('logView').textContent = '加载中…';
  try {
    const r = await api(`/api/logs?lines=400&file=${encodeURIComponent(file)}`);
    $('logView').textContent = r.text || '（空）';
  } catch (e) { $('logView').textContent = `加载失败：${e.message}`; }
}

function refreshLogFiles() {
  // 日志页切换时刷新子步骤日志列表
  api('/api/files?dir=logs').then((d) => {
    const sel = $('logFileList');
    const prev = sel.value;
    sel.innerHTML = d.files.filter((f) => f.type === 'file' && /\.log$/.test(f.name))
      .map((f) => `<option value="${esc(f.name)}">${esc(f.name)}（${fmtBytes(f.size)}）</option>`).join('');
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  }).catch(() => {});
}

$('logFileSel').addEventListener('change', () => {
  $('logFileList').classList.toggle('hidden', !$('logFileSel').checked);
  refreshLogFiles();
  loadLog();
});

init();
