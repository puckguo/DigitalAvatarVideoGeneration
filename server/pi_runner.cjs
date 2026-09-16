'use strict';
/**
 * pi_runner.cjs — CJS 桥：把 puck SDK 调用包成 `runPiAgent(prompt, lastMessageName, logName, timeoutMs) → Promise<string>`
 * 作用：让 server/pipeline.js 的 runCodex 函数体能保持 CJS、不污染现有 require 链。
 *
 * 行为：
 *  - 通过 spawn('node', ['server/pi_runner.mjs']) 子进程化运行（puck SDK 是异步流式，stdin/stdout 协议隔离）
 *  - 失败/超时/SDK 不可用 → throw → pipeline.js 走 codex fallback
 *  - 成功 → 返回 lastMessageFile 内容（与 codex exec 的 `-o` 落盘契约一致）
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT, LOGS_DIR, getEnv, errTail } = require('./utils');

/** 解析 lastMessageName / logName 到绝对路径（pipeline.js 传的是文件名） */
function resolveFile(name) {
  if (!name) return null;
  if (path.isAbsolute(name)) return name;
  // 兼容 pipeline.js 传 "logs/xxx.log" 或纯 "xxx.log" 两种形式
  if (name.startsWith('logs/') || name.startsWith('logs\\')) return path.join(ROOT, name);
  return path.join(LOGS_DIR, name);
}

/**
 * 调 puck SDK 跑单轮 prompt
 * @param {string} promptText user message 正文
 * @param {string} systemPrompt system 角色（agent 范式）
 * @param {string} lastMessageName 落盘文件名（与 codex 兼容，例 "step2_last_message.txt"）
 * @param {string} logName 进程日志文件名（例 "step2_puck.log"）
 * @param {string} explicitModel 可选，.env PUCK_MODEL 的值
 * @param {number} timeoutMs 超时（毫秒）
 * @returns {Promise<string>} 最终 assistant 文本
 */
function runPiAgent(promptText, systemPrompt, lastMessageName, logName, explicitModel, timeoutMs) {
  const env = getEnv();
  const lastAbs = resolveFile(lastMessageName) || path.join(LOGS_DIR, 'pi_last_message.txt');
  const logAbs = resolveFile(logName) || path.join(LOGS_DIR, 'pi_runner.log');
  const runnerScript = path.join(__dirname, 'pi_runner.mjs');

  // 先把 lastMessageFile / logFile 旧文件清掉（与 codex runCodex 行为一致）
  try { fs.rmSync(lastAbs, { force: true }); } catch (_) {}

  const req = JSON.stringify({
    prompt: promptText,
    systemPrompt: systemPrompt || '',
    model: explicitModel || (env.PUCK_MODEL || ''),
    lastMessageFile: lastAbs,
    logFile: logAbs,
    cwd: ROOT,
  });

  return new Promise((resolve, reject) => {
    let child;
    try {
      // 显式 shell=false；mjs 由 node 直接解析；env 走 getEnv() 拿（含 .env 注入的密钥）
      child = spawn(process.execPath, [runnerScript], {
        cwd: ROOT,
        env,                    // 继承 .env 解出的环境（含 PUCK_MODEL / MINIMAX_API_KEY / OPENAI_API_KEY 等）
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(new Error(`spawn pi_runner.mjs 失败：${e.message}`));
      return;
    }

    const logStream = fs.createWriteStream(logAbs, { flags: 'a' });
    let stdout = '';
    let stderr = '';
    const MAX_CAP = 200 * 1024;
    let killed = false;
    let settled = false;

    child.stdout.on('data', (b) => {
      const s = Buffer.isBuffer(b) ? b.toString('utf8') : String(b);
      logStream.write(s);
      if (stdout.length < MAX_CAP) stdout += s.slice(0, MAX_CAP - stdout.length);
    });
    child.stderr.on('data', (b) => {
      const s = Buffer.isBuffer(b) ? b.toString('utf8') : String(b);
      logStream.write(s);
      if (stderr.length < MAX_CAP) stderr += s.slice(0, MAX_CAP - stderr.length);
    });

    const timer = setTimeout(() => {
      killed = true;
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGKILL');
      } catch (_) { /* ignore */ }
    }, timeoutMs || Number(env.PUCK_TIMEOUT_MS || 15 * 60 * 1000));

    child.stdin.on('error', () => {});
    child.stdin.end(req);
    logStream.write(`\n[${new Date().toISOString()}] [pi_runner.cjs] spawned pid=${child.pid}  promptLen=${promptText.length}\n`);

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { logStream.end(); } catch (_) {}
      fn();
    };

    child.on('error', (e) => finish(() => reject(new Error(`pi_runner 启动失败：${e.message}。${errTail(stderr, 400)}`))));
    child.on('close', (code) => {
      if (code === 0) {
        // 成功：读 lastMessageFile（与 codex exec 行为对齐）
        let text = '';
        try { text = fs.readFileSync(lastAbs, 'utf8'); } catch (_) {}
        if (!text.trim()) {
          // 兜底：从 stdout "OK\n..." 解析
          const idx = stdout.indexOf('OK\n');
          if (idx >= 0) text = stdout.slice(idx + 3);
        }
        if (!text.trim()) {
          finish(() => reject(new Error(`pi_runner 退出 0 但 lastMessageFile 为空（${lastAbs}）。stderr: ${errTail(stderr, 400)}`)));
          return;
        }
        finish(() => resolve(text.trim()));
        return;
      }
      // 失败：把 .mjs 退出码映射到清晰错误
      const codeMsg = {
        2: '协议错误（stdin JSON 解析失败 / 缺字段）',
        3: '初始化失败（puck SDK 不可用 / 模型未配置 / 无可用 provider 的 API Key）',
        4: '推理失败（LLM 调用抛错）',
        5: '超时（pi_runner 内部 20 分钟超时）',
      }[code] || `退出码 ${code}`;
      finish(() => reject(new Error(`pi_runner ${codeMsg}。${errTail(stderr, 500)}`)));
    });
  });
}

module.exports = { runPiAgent };
