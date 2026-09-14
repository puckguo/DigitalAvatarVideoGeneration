# 02 · HeyGen Remote MCP 接入（替代 CLI）

> 背景：官方 CLI 只支持 macOS/Linux/WSL；Windows 原生 exe 未签名会被 Smart App Control 拦截。中国网络下 `mcp.heygen.com`/`api2.heygen.com` DNS 被污染，必须代理。

## 要求：实现 `server/heygen_mcp.js`

### OAuth（RFC 9728 → 8414 → 7591 → 7636 全自动）
- 发现链：MCP 端点 401 带 `resource_metadata` → `GET /.well-known/oauth-protected-resource/mcp/v1` → `authorization_servers: https://api2.heygen.com`
- AS 元数据：authorize `/v1/oauth/authorize`、token `/v1/oauth/token`、register `/v1/oauth/register`（DCR）
- 流程：DCR 注册公共客户端（redirect_uri=http://127.0.0.1:PORT/api/heygen/callback，token_endpoint_auth_method=none）→ PKCE S256 + state → 授权 URL 带 `resource=https://mcp.heygen.com/mcp/v1`（RFC 8707）→ 回调换 token → 落盘 `secrets/heygen_mcp_token.json`（含 refresh_token，过期自动刷新，401 时刷一次重试）
- 控制台路由：`GET /api/heygen/login`（302 授权页）、`/api/heygen/callback`（换 token+结果页）、`/api/heygen/status`、`/api/heygen/avatars`、`POST /api/heygen/logout`

### MCP 客户端（Streamable HTTP）
- POST JSON-RPC 到 `https://mcp.heygen.com/mcp/v1/`，头：`Authorization: Bearer`、`Accept: application/json, text/event-stream`、`Mcp-Session-Id`（initialize 响应头）、`MCP-Protocol-Version`
- 响应解析兼容 `application/json` 与 SSE（取 data: 行中匹配 id 的 JSON-RPC）
- 代理：undici `ProxyAgent`，读 `.env HEYGEN_PROXY/HTTPS_PROXY`

### 高层封装与工具名（实测真实命名）
- `uploadAudio(file)`：`create_asset_upload {filename,contentType,sizeBytes}`（camelCase！）→ PUT 预签名 URL（**带上响应的 upload_headers**）→ `complete_asset_upload {assetId}`
- `createAvatarVideo`：工具是 **`create_video_from_avatar`**（不是 create_video），参数 `{avatarId, audioAssetId|audioUrl, aspectRatio:'9:16'|'16:9'|'1:1', title}`（音频与 script 互斥）
- `pollVideo`：`get_video {videoId}`，status `pending/processing/completed/failed`，8s 轮询至超时（默认 30min，进度写 logs/heygen_progress.txt）
- `listAvatarLooks(limit≤50, ownership:'public'|'private')` + 分页 token；前端「浏览数字人」弹窗选择回填
- `tools/list` 结果缓存到 `logs/heygen_tools.json` 便于排查

### 验收标准
- 控制台一键 OAuth → `get_current_user` 返回账号 → 列出 ≥1 个 public avatar。
- 真实跑通：上传 wav → 创建视频 → completed → 下载 mp4 → ffprobe 校验时长。

## 已知坑
- 未连接/401 的报错文案必须引导用户「环境检查页 → 连接 HeyGen」。
- `list_avatar_looks` 不带 ownership 默认可能返回空；public 是预置形象库（150+），private 是自建。
- DCR 每次登录生成新 client_id，pendingLogin 状态存内存（15 分钟过期，state 校验防串扰）。
