'use strict';
/**
 * HeyGen Remote MCP 客户端（替代不兼容 Windows 的官方 CLI）
 *
 * - 端点: https://mcp.heygen.com/mcp/v1/ （Streamable HTTP + Bearer Token）
 * - 认证: OAuth 2.0 授权码 + PKCE(S256)，动态客户端注册(DCR)，token 落盘 secrets/heygen_mcp_token.json
 * - 网络: 支持 .env HEYGEN_PROXY / HTTPS_PROXY（经 undici ProxyAgent，例如 Clash http://127.0.0.1:7890）
 *
 * 高层能力:
 *   getStatus()          连接状态 + 账号信息（get_current_user）
 *   beginLogin(base)     发起 OAuth（返回授权 URL）
 *   completeLogin(q)     回调换 token
 *   listAvatarLooks()    数字人形象列表（avatar_id）
 *   uploadAudio(file)    上传配音 wav（create_asset_upload → PUT S3 → complete_asset_upload）
 *   createAvatarVideo()  用音频驱动数字人生成视频（create_video，按 tools/list schema 自适应参数）
 *   pollVideo(id)        轮询 get_video 直至 completed/failed
 *   downloadFile(url,to) 下载成品 mp4
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROOT, LOGS_DIR, getEnv, ensureDirs, logLine } = require('./utils');

const MCP_ENDPOINT = 'https://mcp.heygen.com/mcp/v1/';
const MCP_RESOURCE = 'https://mcp.heygen.com/mcp/v1';
const AS_BASE = 'https://api2.heygen.com';
const AUTH_ENDPOINT = `${AS_BASE}/v1/oauth/authorize`;
const TOKEN_ENDPOINT = `${AS_BASE}/v1/oauth/token`;
const REGISTER_ENDPOINT = `${AS_BASE}/v1/oauth/register`;
const SCOPES = 'openid profile email';
const TOKEN_FILE = path.join(ROOT, 'secrets', 'heygen_mcp_token.json');
const PROTOCOL_VERSION = '2025-06-18';

/* ---------------- HTTP（支持代理） ---------------- */

let _undici = null;
function undici() {
  if (_undici !== null) return _undici;
  const candidates = ['undici', path.join(ROOT, 'remotion', 'node_modules', 'undici')];
  for (const c of candidates) {
    try { _undici = require(c); return _undici; } catch (_) {}
  }
  _undici = false;
  return _undici;
}

let _dispatcher = undefined; // undefined=未初始化, null=不用代理
function getDispatcher() {
  if (_dispatcher !== undefined) return _dispatcher;
  const env = getEnv();
  const proxy = (env.HEYGEN_PROXY || env.HTTPS_PROXY || env.https_proxy || '').trim();
  if (proxy && undici()) {
    try { _dispatcher = new (undici().ProxyAgent)(proxy); return _dispatcher; } catch (e) { logLine(`[HEYGEN] ProxyAgent 创建失败：${e.message}`); }
  }
  _dispatcher = null;
  return _dispatcher;
}

async function httpFetch(url, opts = {}) {
  const u = undici();
  const dispatcher = getDispatcher();
  const finalOpts = { ...opts };
  if (dispatcher && u) finalOpts.dispatcher = dispatcher;
  const fetchFn = u ? u.fetch : fetch;
  return fetchFn(url, finalOpts);
}

/* ---------------- OAuth ---------------- */

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let pendingLogin = null; // {state, codeVerifier, clientId, redirectUri, createdAt}

function readToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch (_) { return null; }
}
function writeToken(t) {
  ensureDirs();
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), 'utf8');
}
function isConnected() {
  const t = readToken();
  return !!(t && t.access_token);
}

async function beginLogin(redirectBase) {
  const redirectUri = `${redirectBase.replace(/\/$/, '')}/api/heygen/callback`;
  // ① 动态客户端注册（RFC 7591）
  const regRes = await httpFetch(REGISTER_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'dh-pipeline（数字人视频流水线本地控制台）',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
    signal: AbortSignal.timeout(30 * 1000),
  });
  if (!regRes.ok) throw new Error(`HeyGen 客户端注册失败 HTTP ${regRes.status}：${(await regRes.text()).slice(0, 300)}`);
  const reg = await regRes.json();
  if (!reg.client_id) throw new Error('HeyGen 客户端注册响应缺少 client_id');

  // ② PKCE + state
  const codeVerifier = b64url(crypto.randomBytes(48));
  const codeChallenge = b64url(crypto.createHash('sha256').update(codeVerifier).digest());
  const state = b64url(crypto.randomBytes(24));
  pendingLogin = { state, codeVerifier, clientId: reg.client_id, redirectUri, createdAt: Date.now() };

  // ③ 授权 URL（RFC 8707 resource 指示符，把 token 锚定到 MCP 资源）
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', reg.client_id);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', MCP_RESOURCE);
  return url.toString();
}

async function completeLogin(query) {
  if (query.error) return { ok: false, error: `授权被拒绝：${query.error}${query.error_description ? `（${query.error_description}）` : ''}` };
  if (!pendingLogin) return { ok: false, error: '没有进行中的登录流程，请从控制台重新发起「连接 HeyGen」' };
  if (Date.now() - pendingLogin.createdAt > 15 * 60 * 1000) { pendingLogin = null; return { ok: false, error: '登录流程已过期（15 分钟），请重新发起' }; }
  if (query.state !== pendingLogin.state) return { ok: false, error: 'state 校验失败（可能存在跨标签页的过期回调），请重新发起连接' };
  if (!query.code) return { ok: false, error: '回调缺少授权码' };

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: query.code,
    redirect_uri: pendingLogin.redirectUri,
    client_id: pendingLogin.clientId,
    code_verifier: pendingLogin.codeVerifier,
    resource: MCP_RESOURCE,
  });
  const flow = pendingLogin;
  pendingLogin = null;

  const res = await httpFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(30 * 1000),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) {
    return { ok: false, error: `换取令牌失败 HTTP ${res.status}：${tok.error || ''} ${tok.error_description || ''}`.trim() };
  }
  writeToken({
    access_token: tok.access_token,
    refresh_token: tok.refresh_token || null,
    expires_at: Date.now() + (Number(tok.expires_in) || 3600) * 1000 - 60 * 1000,
    client_id: flow.clientId,
    redirect_uri: flow.redirectUri,
    scope: tok.scope || SCOPES,
    saved_at: new Date().toISOString(),
  });
  logLine('[HEYGEN] OAuth 授权成功，令牌已保存到 secrets/heygen_mcp_token.json');
  return { ok: true };
}

async function refreshAccessToken() {
  const t = readToken();
  if (!t || !t.refresh_token) throw new Error('HeyGen 令牌已过期且无 refresh_token，请到控制台重新连接');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: t.refresh_token,
    client_id: t.client_id,
    resource: MCP_RESOURCE,
  });
  const res = await httpFetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(30 * 1000),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) {
    throw new Error(`刷新令牌失败 HTTP ${res.status}：${tok.error || ''} ${tok.error_description || ''}（请到控制台重新连接 HeyGen）`.trim());
  }
  writeToken({ ...t, access_token: tok.access_token, refresh_token: tok.refresh_token || t.refresh_token, expires_at: Date.now() + (Number(tok.expires_in) || 3600) * 1000 - 60 * 1000 });
  return readToken();
}

async function ensureFreshToken() {
  const t = readToken();
  if (!t || !t.access_token) throw new Error('HeyGen 尚未连接：请到控制台「环境检查」页点击「连接 HeyGen」完成 OAuth 授权');
  if (t.expires_at && Date.now() > t.expires_at) return refreshAccessToken();
  return t;
}

/* ---------------- MCP 协议（Streamable HTTP） ---------------- */

let mcpSession = null; // {id, initAt}

function parseMcpResponse(contentType, text, id) {
  if (/application\/json/i.test(String(contentType || ''))) {
    return JSON.parse(text);
  }
  // text/event-stream：逐行取 data: 载荷，找匹配 id 的 JSON-RPC 响应
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (!m || !m[1].trim()) continue;
    try { events.push(JSON.parse(m[1])); } catch (_) {}
  }
  const hit = events.find((e) => e.id === id);
  if (hit) return hit;
  const err = events.find((e) => e.error);
  if (err) return err;
  return events[0] || null;
}

async function mcpPost(payload, { retried = false } = {}) {
  const token = await ensureFreshToken();
  const headers = {
    authorization: `Bearer ${token.access_token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (mcpSession && mcpSession.id) headers['mcp-session-id'] = mcpSession.id;
  if (mcpSession && mcpSession.protocol) headers['mcp-protocol-version'] = mcpSession.protocol;

  const res = await httpFetch(MCP_ENDPOINT, {
    method: 'POST', headers, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(120 * 1000),
  });
  if (res.status === 401 && !retried) {
    await refreshAccessToken().catch(() => {});
    return mcpPost(payload, { retried: true });
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try { const j = JSON.parse(text); detail = (j.error && (j.error.message || j.error.error_description)) || detail; } catch (_) {}
    const e = new Error(`MCP 请求失败 HTTP ${res.status}：${detail}`);
    e.statusCode = res.status;
    throw e;
  }
  return { res, body: parseMcpResponse(res.headers.get('content-type'), text, payload.id) };
}

async function mcpInitialize() {
  if (mcpSession && Date.now() - mcpSession.initAt < 30 * 60 * 1000) return mcpSession;
  const init = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'dh-pipeline', version: '1.0.0' },
    },
  };
  const { res, body } = await mcpPost(init);
  if (!body || body.error) throw new Error(`MCP initialize 失败：${body ? JSON.stringify(body.error) : '空响应'}`);
  const sessionId = res.headers.get('mcp-session-id') || null;
  const protocol = body.result && body.result.protocolVersion || PROTOCOL_VERSION;
  mcpSession = { id: sessionId, protocol, initAt: Date.now() };
  // initialized 通知（无响应体）
  try {
    await httpFetch(MCP_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${(await ensureFreshToken()).access_token}`,
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        'mcp-protocol-version': protocol,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(30 * 1000),
    });
  } catch (_) { /* 通知失败可容忍 */ }
  return mcpSession;
}

let _rpcId = 10;
async function callTool(name, args = {}) {
  await mcpInitialize();
  const payload = { jsonrpc: '2.0', id: ++_rpcId, method: 'tools/call', params: { name, arguments: args } };
  const { body } = await mcpPost(payload);
  if (!body) throw new Error(`MCP 工具 ${name} 返回空响应`);
  if (body.error) {
    const e = new Error(`MCP 工具 ${name} 错误：${body.error.message || JSON.stringify(body.error)}`);
    e.mcpError = body.error;
    throw e;
  }
  const r = body.result || {};
  if (r.isError) {
    const text = (r.content || []).map((c) => c.text || '').join('\n');
    throw new Error(`MCP 工具 ${name} 执行失败：${text.slice(0, 500)}`);
  }
  if (r.structuredContent !== undefined) return r.structuredContent;
  const text = (r.content || []).map((c) => c.text || '').join('\n');
  try { return JSON.parse(text); } catch (_) { return text; }
}

/* ---------------- 工具 schema 缓存（create_video 参数自适应） ---------------- */

let _toolsCache = null;
async function listTools(force = false) {
  if (_toolsCache && !force) return _toolsCache;
  await mcpInitialize();
  const payload = { jsonrpc: '2.0', id: ++_rpcId, method: 'tools/list', params: {} };
  const { body } = await mcpPost(payload);
  _toolsCache = (body.result && body.result.tools) || [];
  try { ensureDirs(); fs.writeFileSync(path.join(LOGS_DIR, 'heygen_tools.json'), JSON.stringify(_toolsCache, null, 2), 'utf8'); } catch (_) {}
  return _toolsCache;
}
function toolSchema(name) {
  const t = (_toolsCache || []).find((x) => x.name === name);
  return (t && t.inputSchema && t.inputSchema.properties) || null;
}

/* ---------------- 高层 API ---------------- */

async function getStatus() {
  try {
    const u = await callTool('get_current_user', {});
    const d = (u && u.data) || u || {};
    return {
      connected: true,
      user: {
        email: d.email || d.user?.email || '',
        name: d.name || d.username || d.user?.name || '',
        credits: d.remaining_credits ?? d.credits ?? d.balance ?? null,
      },
    };
  } catch (e) {
    return { connected: false, error: String(e.message || e) };
  }
}

async function listAvatarLooks(limit = 50, ownership) {
  const args = { limit: Math.min(50, Math.max(1, limit)) };
  if (ownership) args.ownership = ownership;
  const r = await callTool('list_avatar_looks', args);
  const d = (r && r.data) || r || {};
  const items = d.items || (Array.isArray(d) ? d : []);
  const norm = (list) => (Array.isArray(list) ? list : []).map((x) => ({
    avatar_id: x.avatar_id || x.look_id || x.id,
    name: x.display_name || x.name || x.title || x.avatar_id || x.id,
    group: (x.group_name || x.avatar_group_name || (x.group && x.group.name) || '').trim(),
    preview: x.preview_image_url || x.preview_url || x.thumbnail_url || (x.preview && x.preview.url) || '',
    status: x.status || '',
  })).filter((x) => x.avatar_id);
  const out = norm(items);
  // 追加后续页（最多 3 页），避免预置数字人被 50 条截断
  let token = d.next_token || d.nextToken;
  let page = 0;
  while (token && out.length < 150 && page < 2) {
    page++;
    const r2 = await callTool('list_avatar_looks', { ...args, token });
    const d2 = (r2 && r2.data) || r2 || {};
    out.push(...norm(d2.items || []));
    token = d2.next_token || d2.nextToken;
  }
  return out;
}

async function uploadAudio(absPath, contentType = 'audio/wav') {
  const buf = fs.readFileSync(absPath);
  const filename = path.basename(absPath);
  const up = await callTool('create_asset_upload', {
    filename, contentType, sizeBytes: buf.length,
  });
  const d = (up && up.data) || up || {};
  if (!d.upload_url || !d.asset_id) throw new Error(`上传初始化失败：${JSON.stringify(d).slice(0, 300)}`);
  // PUT 到预签名 S3 URL（带平台要求的 headers）
  const putHeaders = { 'content-type': contentType, 'content-length': String(buf.length) };
  for (const [k, v] of Object.entries(d.upload_headers || {})) putHeaders[k.toLowerCase()] = v;
  const putRes = await httpFetch(d.upload_url, {
    method: 'PUT', headers: putHeaders, body: buf,
    signal: AbortSignal.timeout(300 * 1000),
  });
  if (!putRes.ok) throw new Error(`音频 PUT 上传失败 HTTP ${putRes.status}：${(await putRes.text()).slice(0, 200)}`);
  const done = await callTool('complete_asset_upload', { assetId: d.asset_id });
  const dd = (done && done.data) || done || {};
  if (!dd.url) throw new Error(`音频上传完成确认失败：${JSON.stringify(dd).slice(0, 300)}`);
  return { asset_id: dd.asset_id || d.asset_id, url: dd.url, status: dd.status || '' };
}

/**
 * 用已上传音频驱动数字人生成视频（create_video_from_avatar，音频驱动口型）。
 * 参数为 camelCase：avatarId / audioAssetId|audioUrl / aspectRatio / title。
 */
async function createAvatarVideo({ avatarId, audioUrl, assetId, width, height, title }) {
  const ratio = width === height ? '1:1' : (height > width ? '9:16' : '16:9');
  const args = { avatarId, aspectRatio: ratio };
  if (assetId) args.audioAssetId = assetId;
  else if (audioUrl) args.audioUrl = audioUrl;
  else throw new Error('缺少音频（audioAssetId / audioUrl 至少其一）');
  if (title) args.title = String(title).slice(0, 80);

  const r = await callTool('create_video_from_avatar', args);
  const d = (r && r.data) || r || {};
  const videoId = d.video_id || d.id || (d.video && d.video.video_id);
  if (!videoId) throw new Error(`创建视频未返回 video_id：${JSON.stringify(d).slice(0, 300)}`);
  return { videoId, raw: d };
}

async function getVideo(videoId) {
  const r = await callTool('get_video', { videoId });
  return (r && r.data) || r || {};
}

async function pollVideo(videoId, timeoutMs, onTick) {
  const start = Date.now();
  let lastStatus = '';
  while (Date.now() - start < timeoutMs) {
    let v;
    try { v = await getVideo(videoId); } catch (e) { throw e; }
    const status = v.status || 'unknown';
    if (status !== lastStatus) {
      lastStatus = status;
      logLine(`[HEYGEN] 视频 ${videoId} 状态：${status}`);
    }
    if (onTick) { try { onTick({ status, elapsed: Math.round((Date.now() - start) / 1000), video: v }); } catch (_) {} }
    if (status === 'completed') return v;
    if (status === 'failed') {
      throw new Error(`HeyGen 视频生成失败：${v.failure_message || v.failure_code || '未知原因'}（详见 logs/step3_heygen.log）`);
    }
    await new Promise((r2) => setTimeout(r2, 8000));
  }
  throw new Error(`HeyGen 视频生成超时（${Math.round(timeoutMs / 60000)} 分钟），video_id=${videoId}，稍后可在 HeyGen 应用中查看`);
}

async function downloadFile(url, outPath) {
  const res = await httpFetch(url, { signal: AbortSignal.timeout(600 * 1000) });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}：${url.slice(0, 120)}`);
  const { Readable } = require('stream');
  const { pipeline } = require('stream/promises');
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(outPath));
}

function logout() {
  try { fs.rmSync(TOKEN_FILE, { force: true }); } catch (_) {}
  mcpSession = null; _toolsCache = null;
  logLine('[HEYGEN] 已断开连接（删除本地令牌）');
}

module.exports = {
  MCP_ENDPOINT, TOKEN_FILE,
  isConnected, readToken, beginLogin, completeLogin, refreshAccessToken, logout,
  getStatus, listAvatarLooks, uploadAudio, createAvatarVideo, getVideo, pollVideo, downloadFile,
  listTools,
};
