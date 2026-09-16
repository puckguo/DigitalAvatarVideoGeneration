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

  // 自检内置 compositor：Windows Code Integrity / Smart App Control 会拦截未签名 DLL
  // （avcodec-61.dll），ffprobe/ffmpeg/compositor spawn 即崩（exit 0xC0E90002=3236495362，
  // 且 SAC 关闭后需重启才完全卸载策略）。提前检测并给出明确提示，而不是深埋在渲染错误里。
  const { execFile } = await import('node:child_process');
  const ffprobeExe = A('node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe');
  if (fs.existsSync(ffprobeExe)) {
    await new Promise((resolve) => {
      execFile(ffprobeExe, ['-version'], { timeout: 15 * 1000 }, (err) => {
        if (err && (Number(err.code) === 3236495362 || Number(err.code) === 3221225781)) {
          const msg = 'Windows 安全策略（Code Integrity / Smart App Control）拦截了 Remotion 内置的未签名组件 avcodec-61.dll：ffprobe/compositor 无法启动(exit ' + err.code + ')。解决：重启系统（若最近关闭过 Smart App Control，重启后策略才会完全卸载），重启后重跑本步骤即可。';
          log('RENDER_FAILED: ' + msg);
          console.error('COMPOSITOR_BLOCKED_BY_CODE_INTEGRITY exit=' + err.code);
          process.exit(3);
        }
        resolve();
      });
      setTimeout(resolve, 16 * 1000); // 超时兑底：不让自检卡死渲染
    });
  }

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
    // swangle（软件 GL）：GPU 长时间跑 LatentSync/LivePortrait 推理后驱动可能不稳定
    // （compositor 提帧偶发 0xC0E90602 崩溃），软件渲染慢一点但稳定， 1080p×30s 可接受
    chromiumOptions: { gl: 'swangle' },
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
