/**
 * Remotion 程序化渲染入口（由流水线 Step5 调用，也可手动运行）
 * 用法：node render.mjs <props.json> <output.mp4> <render.log> <progress.txt>
 * 路径均相对于本目录（remotion/）解析。
 */
import fs from 'node:fs';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { ensureBrowser, selectComposition, renderMedia } from '@remotion/renderer';

const argv = process.argv.slice(2);
if (argv.length < 4) {
  console.error('用法: node render.mjs <props.json> <output.mp4> <render.log> <progress.txt>');
  process.exit(2);
}
const A = (p) => path.resolve(process.cwd(), p);
const [, outFile, logFile, progressFile] = argv.map(A);
const log = (m) => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${m}\n`); } catch {} };

try {
  const inputProps = JSON.parse(fs.readFileSync(A(argv[0]), 'utf8'));
  const compositionId = inputProps.__composition || 'DigitalHuman';
  delete inputProps.__composition;

  log('确保 Headless Chrome 可用 ...');
  await ensureBrowser();

  log('打包 Remotion 项目（src/index.js）...');
  const serveUrl = await bundle({
    entryPoint: A('src/index.js'),
    onProgress: (n) => {},
    webpackOverride: (c) => c,
  });
  log(`打包完成: ${serveUrl}`);

  const composition = await selectComposition({ serveUrl, id: compositionId, inputProps });
  log(`合成 ${compositionId}: ${composition.width}x${composition.height} @${composition.fps}fps, ${composition.durationInFrames} 帧`);

  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: outFile,
    inputProps,
    onProgress: (p) => { try { fs.writeFileSync(progressFile, String(Math.round(p * 100))); } catch {} },
    onBrowserLog: (l) => { try { log(`[browser] ${String(l.text || '').slice(0, 300)}`); } catch {} },
  });

  log('RENDER_DONE');
  console.log('RENDER_DONE');
  process.exit(0);
} catch (err) {
  log(`RENDER_FAILED: ${err && err.stack ? err.stack : err}`);
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
}
