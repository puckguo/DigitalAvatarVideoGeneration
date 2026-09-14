# dh-video-pipeline · Skill 说明

把「数字人视频流水线」项目封装为 AI Agent 可用的 Skill：**一套 prompt 复现整个项目 + 一条命令部署运行**。

## 目录

```
SKILL.md            Agent 入口（能力清单 / 初始化与运营 SOP / 已知坑清单）
init-prompts/       全部初始化 prompt（00 总规格 → 07 开源化，每个含验收标准与实战坑）
scripts/
  init-project.sh   一键部署（macOS/Linux/Git-Bash）
  init-project.ps1  一键部署（Windows PowerShell）
scaffold/           完整项目脚手架（由 scripts/pack-skill.sh 从 git HEAD 导出）
```

## 安装为 Agent Skill

```bash
# pi / 通用 skills 目录
cp -r skill/dh-video-pipeline ~/.agents/skills/
# 或使用 skills CLI
npx skills add <本仓库路径>/skill/dh-video-pipeline
```

安装后对 Agent 说「初始化数字人视频流水线」「生成一条数字人口播视频」即可触发。

## 部署新项目实例

```bash
bash skill/dh-video-pipeline/scripts/init-project.sh ~/my-dh-pipeline
# Windows: powershell -File skill\dh-video-pipeline\scripts\init-project.ps1 -Target .\my-dh-pipeline
```

脚本自动：复制脚手架 → 建运行时目录 → 生成 .env → 装 Remotion 依赖 → 环境校验。之后按提示填密钥、OAuth 连接 HeyGen、`start.sh` 启动。

## 维护

项目代码更新后，在项目根目录执行 `bash scripts/pack-skill.sh` 重新导出 scaffold，保持 skill 同步（当前 scaffold 来自 git HEAD，共 31 个文件）。
