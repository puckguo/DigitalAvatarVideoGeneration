# 05 · 调试模式（runMode）+ Codex 流式截断加固

## Part A：runMode 运行范围

| 值 | 行为 |
|---|---|
| `full` | 完整 9 步 |
| `audio` | 文案+配音+字幕；Step5(heygen)/7(合成)/8(压缩) ⏭️skipped —— **不耗 HeyGen credit** |
| `tts` | 文案+配音（Step≥5 跳过） |
| `script` | 仅文案（Step≥3 跳过） |

实现：`planSkip(step, params)` 统一返回跳过原因（Step0 未启用克隆 / 人工开关 / 调试范围），executeFrom 循环头部判断后标记 skipped；前端下拉选择 + 调试模式不弹「清理临时文件」。
调试跑完后从 Step5 重跑即出片（01/02 复用，不重复消耗）。

**验收**：runMode=audio 全流程 success，HeyGen 步骤显示「跳过：节省 credit」。

## Part B：Codex 流式输出截断加固（真实事故）

**现象**：32s 文案的 SRT 只剩最后 1 条字幕。
**根因**：codex 长输出被拆成多条流式消息，`-o` 只含末段；stdout 完整但混入 CLI 分隔符——`codex` 品牌行插在 `00:00:16,700 -` 与 `-> 00:00:18,300` 之间打断时间轴，尾部还有 `tokens used\n10,170`。

### 要求
1. `cleanCodexOutput(raw)`：去 ANSI；删 `codex`/`tokens used` 行；删纯数字带千分逗行（保留 SRT 序号）；`/ -\s*\r?\n\s*->\s*/ → ' --> '` 修复时间轴。
2. `runCodex` 返回 `-o` 与清洗后 stdout 中**更完整者**。
3. SRT 后处理：按 `(start,text)` 去重 → 按开始时间排序 → 重叠修复（前一条 end 缩到下一条 start）。
4. **最少条数校验**：`dur>20s ? max(3, floor(dur/12)) : 2`，不足报错提示重试（重试一次即恢复正常）。

**验收**：构造同场景重试后得到 13 条正常字幕（时间轴单调、末条≤音频时长）。
