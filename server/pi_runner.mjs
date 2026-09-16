#!/usr/bin/env node
/**
 * pi_runner.mjs — puck SDK 适配层（ESM 入口）
 * 作用：替代 `codex exec` 调 OpenAI/Anthropic/MiniMax 等 LLM 完成单轮 prompt。
 *
 * 与 codex exec 的输出契约保持一致（pipeline.js 的 runCodex 只看返回值与落盘文件）：
 *  - lastMessageFile 写入最终 assistant 文本（codex 用 -o 落盘）
 *  - logFile 记录完整进程日志（codex 的 logFile）
 *  - stdout 输出 `OK\n<text>`（CJS 桥回填给 pipeline.js）
 *
 * 入参协议（stdin 一行 JSON）：
 *   {
 *     "prompt": "user message 正文",
 *     "systemPrompt": "可选，agent 范式 system 角色",
 *     "model": "minimax/MiniMax-M3 或 openai/gpt-5.1；留空走系统默认优先级表",
 *     "lastMessageFile": "logs/step2_last_message.txt（相对流水线根或绝对路径）",
 *     "logFile": "logs/step2_puck.log（同上）",
 *     "apiKey": "可选显式覆盖（不推荐用，留给调试）",
 *     "cwd": "可选，puck session cwd（默认 process.cwd）"
 *   }
 *
 * 退出码：
 *  0 成功（text 已写 lastMessageFile + stdout）
 *  2 协议错误（stdin JSON 解析失败 / 缺字段）
 *  3 初始化失败（puck SDK 不可用 / 模型未配置 / 无可用 provider）
 *  4 推理失败（LLM 调用抛错）
 *  5 超时
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve as pathResolve } from 'node:path';

const require = createRequire(import.meta.url);

/** 系统默认优先级表（puck SDK 不自带「找第一个有 auth 的」逻辑，手写一份干净的）
 *  顺序含义：环境变量 / secrets 里**最先**命中的 provider 胜出
 *  - 跳过本地 provider（ollama/lmstudio/vllm 永不在云端流水线候选）
 *  - 跳过 Google Vertex（需要 ADC 凭证，CLI 不便）
 *  - 跳过 amazon-bedrock（同上）
 *  - 用户 .env 里 PUCK_MODEL 显式配的 provider 永远胜出 */
const PROVIDER_PRIORITY = [
  'minimax',          // 流水线主用 TTS provider 同一厂商，密钥可复用
  'openai',           // 兜底：国内不通但海外用户最常见
  'anthropic',        // 兜底
  'zai-coding-cn',    // GLM Coding（国内可达）
  'minimax-cn',       // 国内 MiniMax
  'groq',
  'deepseek',
  'xai',
  'mistral',
  'moonshot',
  'moonshot-cn',
  'openrouter',
  'together',
  'fireworks',
  'cerebras',
  'huggingface',
  'kimi',
  'alibaba',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'xiaomi',
  'zai',
  'vercel',
];

/** 各 provider 的「代表性默认模型」（puck SDK 启动时只验 key 不查 /models 列表，避免联网） */
const DEFAULT_MODEL_PER_PROVIDER = {
  'minimax': 'MiniMax-M3',
  'openai': 'gpt-5.1',
  'anthropic': 'claude-sonnet-4-5',
  'zai-coding-cn': 'glm-4.6',
  'minimax-cn': 'MiniMax-M3',
  'groq': 'llama-3.3-70b-versatile',
  'deepseek': 'deepseek-chat',
  'xai': 'grok-4-fast',
  'mistral': 'mistral-large-latest',
  'moonshot': 'kimi-k2-0905-preview',
  'moonshot-cn': 'kimi-k2-0905-preview',
  'openrouter': 'openai/gpt-4o-mini',
  'together': 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  'fireworks': 'accounts/fireworks/models/llama-v3p3-70b-instruct',
  'cerebras': 'llama-3.3-70b',
  'huggingface': 'meta-llama/Llama-3.3-70B-Instruct',
  'kimi': 'kimi-for-coding',
  'alibaba': 'qwen-plus',
  'qwen-token-plan': 'qwen-plus',
  'qwen-token-plan-cn': 'qwen-plus',
  'xiaomi': 'mimo-v2.5-pro',
  'zai': 'glm-4.6',
  'vercel': 'openai/gpt-4o-mini',
};

const PROVIDER_APIKEY_ENVS = {
  'minimax': ['MINIMAX_API_KEY'],
  'openai': ['OPENAI_API_KEY'],
  'anthropic': ['ANTHROPIC_API_KEY'],
  'zai-coding-cn': ['ZAI_CODING_CN_API_KEY', 'GLM_CODING_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY', 'MINIMAX_API_KEY'],
  'groq': ['GROQ_API_KEY'],
  'deepseek': ['DEEPSEEK_API_KEY'],
  'xai': ['XAI_API_KEY'],
  'mistral': ['MISTRAL_API_KEY'],
  'moonshot': ['MOONSHOT_API_KEY'],
  'moonshot-cn': ['MOONSHOT_CN_API_KEY', 'MOONSHOT_API_KEY'],
  'openrouter': ['OPENROUTER_API_KEY'],
  'together': ['TOGETHER_API_KEY'],
  'fireworks': ['FIREWORKS_API_KEY'],
  'cerebras': ['CEREBRAS_API_KEY'],
  'huggingface': ['HF_TOKEN'],
  'kimi': ['KIMI_API_KEY'],
  'alibaba': ['DASHSCOPE_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi': ['XIAOMI_API_KEY'],
  'zai': ['ZAI_API_KEY'],
  'vercel': ['AI_GATEWAY_API_KEY'],
};

function logTo(logFile, msg) {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch (_) { /* 日志失败不阻塞主流程 */ }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

function pickProviderAndModel(env, explicitModel) {
  // 1. 显式 PUCK_MODEL 形如 "minimax/MiniMax-M3"
  if (explicitModel && explicitModel.trim()) {
    const trimmed = explicitModel.trim();
    if (trimmed.includes('/')) {
      const [provider, modelId] = trimmed.split('/', 2);
      if (provider && modelId) {
        if (!hasProviderKey(provider, env)) {
          throw new Error(`PUCK_MODEL 指定 provider=${provider} 但未配置 API Key（期望环境变量：${(PROVIDER_APIKEY_ENVS[provider] || [provider + '_API_KEY']).join(' / ')}）`);
        }
        return { provider, modelId, source: 'PUCK_MODEL' };
      }
    }
    // 形如 "MiniMax-M3"（无 provider 前缀）— 走默认 provider 顺序找第一个 model id 包含此名的
    for (const p of PROVIDER_PRIORITY) {
      if (!hasProviderKey(p, env)) continue;
      const defaultId = DEFAULT_MODEL_PER_PROVIDER[p];
      if (defaultId === trimmed) return { provider: p, modelId: trimmed, source: 'PUCK_MODEL(default)' };
    }
    throw new Error(`PUCK_MODEL="${trimmed}" 未能匹配任何 provider（需要 provider/modelId 形式，或与某个 provider 默认模型名完全一致）`);
  }

  // 2. 走系统默认优先级表，找第一个有 API key 的 provider
  for (const p of PROVIDER_PRIORITY) {
    if (hasProviderKey(p, env)) {
      return { provider: p, modelId: DEFAULT_MODEL_PER_PROVIDER[p], source: 'system_default' };
    }
  }
  return null;
}

function hasProviderKey(provider, env) {
  const envVars = PROVIDER_APIKEY_ENVS[provider] || [`${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`];
  return envVars.some((k) => {
    const v = env[k];
    return typeof v === 'string' && v.trim().length > 0;
  });
}

function resolvePath(maybeRel, cwd) {
  if (isAbsolute(maybeRel)) return maybeRel;
  return pathResolve(cwd, maybeRel);
}

async function main() {
  // 1. 解析 stdin
  const raw = await readStdin();
  let req;
  try { req = JSON.parse(raw); }
  catch (e) {
    process.stderr.write(`[pi_runner] stdin 不是合法 JSON: ${e.message}\n`);
    process.exit(2);
  }
  const { prompt, systemPrompt, model: explicitModel, lastMessageFile, logFile, apiKey, cwd } = req;
  if (!prompt || !lastMessageFile || !logFile) {
    process.stderr.write(`[pi_runner] 缺字段：需要 prompt / lastMessageFile / logFile\n`);
    process.exit(2);
  }
  const baseCwd = cwd && cwd.trim() ? cwd : process.cwd();
  const lastAbs = resolvePath(lastMessageFile, baseCwd);
  const logAbs = resolvePath(logFile, baseCwd);
  logTo(logAbs, `=== pi_runner 启动 ===`);
  logTo(logAbs, `prompt 长度: ${prompt.length} 字符`);
  logTo(logAbs, `systemPrompt: ${systemPrompt ? `${systemPrompt.length} 字符` : '(空)'}`);
  logTo(logAbs, `PUCK_MODEL: ${explicitModel || '(空，走系统默认)'}`);

  // 2. 选 provider + model（MOCK 模式跳过：直接用 puck 自带 mock streamFn）
  if (process.env.PI_RUNNER_MOCK !== '1') {
    const picked = pickProviderAndModel(process.env, explicitModel);
    if (!picked) {
      const lines = [
        '未找到任何可用 provider 的 API Key。puck SDK 需要至少一个 provider 的环境变量。',
        '请在 .env 中配置以下任一密钥（按优先级排序）：',
        ...PROVIDER_PRIORITY.slice(0, 5).map((p) => `  ${p}: ${(PROVIDER_APIKEY_ENVS[p] || []).join(' / ')}`),
        '或显式设置 PUCK_MODEL=provider/modelId（例：PUCK_MODEL=minimax/MiniMax-M3）',
      ];
      const msg = lines.join('\n');
      logTo(logAbs, `[FAIL] ${msg}`);
      process.stderr.write(`[pi_runner] ${msg}\n`);
      process.exit(3);
    }
    logTo(logAbs, `provider=${picked.provider}  model=${picked.modelId}  source=${picked.source}`);
  } else {
    logTo(logAbs, `PI_RUNNER_MOCK=1，puck 走 mock streamFn 模式`);
  }

  // 3. 加载 puck SDK
  let createPuck;
  try {
    ({ createPuck } = require('@puckguo123/sdk'));
  } catch (e) {
    const msg = `puck SDK 加载失败：${e.message}。请确认已运行 npm install（流水线根 package.json 已声明 file: 依赖到 puck-agent/puck/packages/sdk）`;
    logTo(logAbs, `[FAIL] ${msg}`);
    process.stderr.write(`[pi_runner] ${msg}\n`);
    process.exit(3);
  }

  // 4. 跑
  const started = Date.now();
  let puck;
  try {
    if (process.env.PI_RUNNER_MOCK === '1') {
      // 调试用 mock：使用 puck SDK 自带的 createMockStreamFn（无需任何 API key）
      // 优先 node_modules 解析（subpath: @puckguo123/llm/mock）；失败则直接读 puck 仓库
      let mockFn;
      try {
        const mod = require('@puckguo123/llm/mock');
        mockFn = mod.createMockStreamFn([{ text: `(mock) ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}` }]);
      } catch (_) {
        // junction 安装下 subpath 可能不解析；fallback 到绝对路径
        // baseCwd 是项目根（流水线根）；puck-agent 与项目根同在 research/ 下
        // 两者没有固定相对关系（项目可能在 research/郑楠/，puck 在 research/puck-agent/）
        // 用 PUCK_REPO_ROOT 环境变量覆盖（默认 research\puck-agent\puck）
        const puckRoot = process.env.PUCK_REPO_ROOT || pathResolve(baseCwd, '..', '..', 'puck-agent', 'puck');
        const directPath = pathResolve(puckRoot, 'packages', 'llm', 'dist', 'mock.js');
        const fileUrl = (await import('node:url')).pathToFileURL(directPath).href;
        const directMod = await import(fileUrl);
        mockFn = directMod.createMockStreamFn([{ text: `(mock) ${prompt.slice(0, 80)}${prompt.length > 80 ? '…' : ''}` }]);
      }
      puck = createPuck({
        streamFn: mockFn,
        systemPrompt: systemPrompt && systemPrompt.trim() ? systemPrompt : undefined,
        tools: 'none', session: false, cwd: baseCwd,
      });
      logTo(logAbs, `[puck] MOCK 模式（PI_RUNNER_MOCK=1，无需 API key）`);
    } else {
      puck = createPuck({
        model: `${picked.provider}/${picked.modelId}`,
        systemPrompt: systemPrompt && systemPrompt.trim() ? systemPrompt : undefined,
        tools: 'none',        // 流水线 Step2/6 是纯文本生成，不要任何工具
        session: false,       // 不要持久化 session（每次单轮）
        cwd: baseCwd,
        apiKey: apiKey || undefined,
      });
    }
    logTo(logAbs, `[puck] createPuck 初始化完成`);
  } catch (e) {
    const msg = `createPuck 初始化失败：${e.message}`;
    logTo(logAbs, `[FAIL] ${msg}`);
    process.stderr.write(`[pi_runner] ${msg}\n`);
    process.exit(3);
  }

  let text = '';
  try {
    const result = await Promise.race([
      puck.run(prompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('puck run 超时（20 分钟）')), 20 * 60 * 1000)),
    ]);
    text = (result && typeof result.text === 'string') ? result.text : '';
    if (!text.trim()) throw new Error('puck.run 返回空文本（可能模型拒绝或 prompt 触发了内容过滤）');
    const dur = Math.round((Date.now() - started) / 100) / 10;
    logTo(logAbs, `[puck] run 完成（${dur}s，${text.length} 字符）`);
  } catch (e) {
    const msg = `puck.run 失败：${e.message}`;
    logTo(logAbs, `[FAIL] ${msg}`);
    process.stderr.write(`[pi_runner] ${msg}\n`);
    process.exit(4);
  }

  // 5. 写 lastMessageFile + stdout
  try {
    mkdirSync(dirname(lastAbs), { recursive: true });
    writeFileSync(lastAbs, text, 'utf8');
  } catch (e) {
    logTo(logAbs, `[FAIL] 写 lastMessageFile 失败：${e.message}`);
    process.stderr.write(`[pi_runner] 写 lastMessageFile 失败：${e.message}\n`);
    process.exit(4);
  }
  process.stdout.write(`OK\n${text}`);
  logTo(logAbs, `=== pi_runner 成功结束 ===`);
  // puck 内部可能有未清理的 timer/handler；显式退出避免流水线主进程 timeout
  // 给 stdout 一个 flush 窗口（10ms）再退
  setTimeout(() => process.exit(0), 10);
}

main().catch((e) => {
  // 兜底：任何未捕获异常都走 stderr + 退出码 1（pipeline.js 视为失败 → 走 codex fallback）
  process.stderr.write(`[pi_runner] 未捕获异常：${e && e.stack || e}\n`);
  process.exit(1);
});
