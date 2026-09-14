# 07 · 开源化（README / LICENSE / 隐私治理 / Git）

## 要求

1. **README.md**（面向开源用户）：居中标题+一句标语、特性（人机协作/声音克隆/HeyGen MCP/调试模式/工程化）、ASCII 工作流图、快速开始（依赖表+三步接入）、素材库、.env 配置表、9 步产物表、目录结构、折叠 FAQ（重点解释「HeyGen CLI 不支持 Windows 的解法」「克隆未生效自查 f0.py」）、Roadmap、致谢、License+合规提示。
2. **LICENSE**：MIT。
3. **隐私治理（.gitignore 必须覆盖）**：
   - `resources/*`（私人录音/照片，仅留 .gitkeep）
   - `.env`、`secrets/.api_keys.json`、`secrets/heygen_mcp_token.json`（OAuth 令牌！）
   - `LivePortrait/`、`lp_api.json`、`scripts/_*.js`、`server/liveportrait.js`（无关的本地实验）
   - `.puck/`、`output/*`、`logs/*`、`node_modules/`（负模式：目录要用 `output/*` 而非 `output/` 才能反选 .gitkeep）
4. **敏感信息扫描**后再 git init + 首次提交；README 示例中不得出现真实邮箱/avatarID/密钥。

## 已知坑
- git index 曾因大文件 mmap 损坏 → `rm .git/index` 重建即可。
- 内嵌 git 仓库（LivePortrait）会被当作 submodule 警告，必须 ignore。

## 验收标准
- `git status` 干净；提交列表仅项目文件（~30 个），无任何隐私内容。
- 新机器按 README 三步可启动。
