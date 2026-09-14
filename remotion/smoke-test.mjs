/**
 * Remotion 安装自检：渲染 30 帧静态合成到 ../logs/smoke_test.mp4
 * 首次运行会自动下载 Headless Chrome（较慢，仅需一次）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, selectComposition, renderMedia } from '@remotion/renderer';

const A = (p) => path.resolve(process.cwd(), p);
const logFile = A('../logs/smoke_test.log');
const log = (m) => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${m}\n`); } catch {} };

try {
  log('确保 Headless Chrome 可用 ...');
  await ensureBrowser();
  log('打包 ...');
  const serveUrl = await bundle({ entryPoint: A('src/index.js'), webpackOverride: (c) => c });
  const composition = await selectComposition({ serveUrl, id: 'SmokeTest', inputProps: {} });
  const out = A('../logs/smoke_test.mp4');
  log(`渲染 SmokeTest (${composition.durationInFrames} 帧) -> ${out}`);
  await renderMedia({ composition, serveUrl, codec: 'h264', outputLocation: out, inputProps: {} });
  log('SMOKE_OK');
  console.log('SMOKE_OK ->', out);
  process.exit(0);
} catch (err) {
  log(`SMOKE_FAILED: ${err && err.stack ? err.stack : err}`);
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
