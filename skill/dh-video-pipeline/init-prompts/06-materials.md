# 06 · 素材库（分类上传 + 本地存储）

## 要求

### 分类体系（`MATERIAL_CATEGORIES`，server/pipeline.js 导出）
| id | 目录 | 格式 | 用途 |
|---|---|---|---|
| voice | materials/voice | m4a/mp3/wav/aac/ogg | 音色克隆源（联动克隆源下拉） |
| photo | materials/photo | jpg/png/webp | 数字人照片参考 |
| image | materials/image | jpg/png/webp/gif/svg | 背景贴片 |
| audio | materials/audio | mp3/wav/m4a/ogg/flac | 音乐音效 |
| video | materials/video | mp4/mov/webm | B-roll |
| doc | materials/doc | txt/md/srt/json | 文案参考 |
| other | materials/other | 任意 | 未分类 |

每类含 icon/名称/描述/hint（引导文案），目录随服务启动自动创建。

### API
- `GET /api/materials` → 各分类定义+文件列表+统计（count/totalSize）。
- `POST /api/upload?category=<id>&name=<file>`（raw body）：**按分类校验扩展名**，不匹配 400 并提示正确分类（引导性报错）；落盘 `materials/<id>/`。

### 前端「🗃️ 素材库」Tab
- 分类卡片网格：图标+名称+描述+统计；文件列表（大小/时间 + 👁预览/⬇️下载/🗑删除，复用 previewFile 弹窗）；每卡片独立上传按钮（file input `accept` 限定格式）。
- **联动**：🎙️ 上传的录音自动填入「新建任务」克隆源 `<datalist>`（与 resources/ 历史录音并列）。
- 文件管理页保留根目录上传（改名「上传到根目录」并引导去素材库）。

### 验收标准
- 7 分类空目录展示；正确上传落盘对应目录；jpg 传 voice 被拦截并提示；上传后克隆源下拉出现新录音。
