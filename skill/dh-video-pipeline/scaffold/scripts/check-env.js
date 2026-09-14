#!/usr/bin/env node
'use strict';
/**
 * 环境校验 CLI（启动脚本调用；也可单独运行）
 * 用法：node scripts/check-env.js [--autofix] [--json]
 * - 任一“必需项”未通过 → 退出码 1（流水线拒绝启动）
 * - --autofix: 自动执行可自动修复的项（如 remotion 依赖安装）后再校验
 */
const path = require('path');
const { runEnvCheck, runAutofix } = require('../server/envcheck');
const { ensureDirs, logLine, ROOT } = require('../server/utils');

const ICONS = { ok: '✅', fail: '❌', warn: '⚠️ ' };

function print(report) {
  console.log('\n========== 数字人视频流水线 · 环境校验 ==========\n');
  for (const it of report.items) {
    const icon = it.ok ? ICONS.ok : (it.warn ? ICONS.warn : ICONS.fail);
    const tag = it.required ? '必需' : '可选';
    console.log(`${icon} [${tag}] ${it.name}`);
    console.log(`      状态: ${it.detail}`);
    if (!it.ok && it.fix) {
      console.log('      修复:');
      for (const line of String(it.fix).split('\n')) console.log(`        ${line}`);
    }
    console.log('');
  }
  const required = report.items.filter((i) => i.required);
  const pass = required.filter((i) => i.ok).length;
  console.log(`---------- 必需项 ${pass}/${required.length} 通过 ----------`);
  if (report.ok) console.log('✅ 环境校验通过，可以启动流水线\n');
  else console.log('❌ 环境校验未通过：请按上方「修复」提示安装/配置后重试（流水线不会启动）\n');
}

(async () => {
  ensureDirs();
  const args = process.argv.slice(2);
  const autofix = args.includes('--autofix');
  const asJson = args.includes('--json');

  let report = await runEnvCheck({ deep: false });

  if (autofix && !report.ok) {
    const fixables = report.items.filter((i) => !i.ok && i.autofix);
    for (const it of fixables) {
      console.log(`🔧 自动修复：${it.name} ...`);
      const r = await runAutofix(it.autofix);
      console.log(r.ok ? '   修复完成（详见 logs/remotion_install.log）' : `   修复失败：${r.error || r.tail || ''}`);
      logLine(`[ENV] autofix ${it.autofix}: ${r.ok ? 'ok' : 'failed'}`);
    }
    if (fixables.length) report = await runEnvCheck({ deep: false });
  }

  if (asJson) {
    console.log(JSON.stringify(report));
  } else {
    print(report);
  }
  process.exit(report.ok ? 0 : 1);
})().catch((e) => {
  console.error('环境校验执行异常：', e);
  process.exit(1);
});
