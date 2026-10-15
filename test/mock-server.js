'use strict';

/**
 * 梦云 Agent —— 端到端验证（用假的模型服务）
 *
 * 这个脚本会：
 *   1. 起一个本地 HTTP 服务，冒充 OpenAI 兼容接口（POST /v1/chat/completions）
 *   2. 用这个地址真的启动一次 agent（完整走通 CLI → 主循环 → 工具 → HTTP 流式）
 *   3. 验证 agent 收到了工具结果，并输出了最终答案
 *
 * 它不花一分钱、不需要 API Key，但验证的是**真实链路**：
 *   流式 SSE 解析、tool_calls 分片拼接、工具执行、结果回填，全都会被真实走一遍。
 *
 * 用法：node test/mock-server.js
 *
 * 顺带一提：这个文件也演示了「怎么把梦云 Agent 接到自己的自建网关上」——
 * 你只要让网关的请求/响应格式和下面 handleChat 一致就行。
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'mya.js');

/* ------------------------------------------------------------------ */
/* 假模型服务                                                          */
/* ------------------------------------------------------------------ */

/**
 * 模型剧本：
 *   第 1 次请求 → 要求调用 read 工具读 package.json（故意把参数拆成多个分片发送）
 *   第 2 次请求 → 检查上下文里有没有工具结果；有就给出最终答案
 */
function handleChat(body, res) {
  const messages = body.messages || [];
  const toolMessages = messages.filter((m) => m.role === 'tool');
  const hasToolResult = toolMessages.length > 0;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  if (!hasToolResult) {
    // ---- 第一轮：先吐一段思考（推理模型的思维链），再要求调用工具 ----
    // 参数故意拆成 3 个分片发送，模拟真实流式行为
    for (const piece of ['我先看看有哪些文件，', 'package.json 最可能写着项目名。']) {
      send({ choices: [{ index: 0, delta: { reasoning_content: piece } }] });
    }
    const chunks = [
      { id: 'call_abc', index: 0, type: 'function', function: { name: 'read', arguments: '{"pa' } },
      { index: 0, function: { arguments: 'th":"package' } },
      { index: 0, function: { arguments: '.json"}' } },
    ];
    for (const c of chunks) {
      send({ choices: [{ index: 0, delta: { tool_calls: [c] } }] });
    }
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    // ---- 第二轮：基于工具结果回答，顺便把内容也拆成几段，验证流式拼接 ----
    send({ choices: [{ index: 0, delta: { reasoning_content: '工具结果里有 name 字段，直接用它。' } }] });
    const content = toolMessages[0].content || '';
    const name = (content.match(/"name"\s*:\s*"([^"]+)"/) || [])[1] || '未知';
    const pieces = ['我读到了 ', 'package.json', `，项目名是 `, name, '。任务完成。'];
    for (const p of pieces) {
      send({ choices: [{ index: 0, delta: { content: p } }] });
    }
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }

  send({ choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `未实现的路径：${req.url}` } }));
        return;
      }
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        let body = {};
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400).end('bad json');
          return;
        }
        handleChat(body, res);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/* ------------------------------------------------------------------ */
/* 运行并验证                                                          */
/* ------------------------------------------------------------------ */

function runAgent(port) {
  return new Promise((resolve) => {
    // 配置目录钉在一个临时目录里：不钉的话 rootDir 会解析成程序所在目录，
    // 于是每跑一次测试就往用户真实的 .mya/sessions 里塞一条假会话
    // （标题是下面那句「先读一下 package.json…」），在界面上看起来莫名其妙。
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-mock-'));
    const child = spawn(
      process.execPath,
      [CLI, 'run', '先读一下 package.json，然后告诉我项目名'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          MYA_CONFIG_DIR: sandbox,
          MYA_PROVIDER: 'custom',
          MYA_BASE_URL: `http://127.0.0.1:${port}/v1`,
          MYA_API_KEY: 'mock-key',
          MYA_MODEL: 'mock-model',
          MYA_YES: '1',
          NO_COLOR: '1',
          MYA_TAVILY_KEY: '',
        },
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('close', (code) => {
      try {
        fs.rmSync(sandbox, { recursive: true, force: true });
      } catch {
        /* Windows 偶尔锁文件，留着也不影响 */
      }
      resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  console.log('\n\x1b[1m\x1b[35m梦云 Agent 端到端验证（假模型服务）\x1b[0m');
  console.log('\x1b[90m真实走通：CLI → HTTP 流式 → 工具调用分片拼接 → 工具执行 → 结果回填 → 最终回答\x1b[0m\n');

  const server = await startServer();
  const port = server.address().port;
  console.log(`  [1/2] 假模型服务已启动：http://127.0.0.1:${port}/v1`);

  let result;
  try {
    result = await runAgent(port);
  } finally {
    server.close();
  }

  console.log('  [2/2] agent 已跑完，开始检查输出\n');
  console.log('\x1b[90m──────────────── agent 输出 ────────────────\x1b[0m');
  console.log(result.stdout.trim());
  if (result.stderr.trim()) {
    console.log('\x1b[90m──────────────── stderr ────────────────\x1b[0m');
    console.log(result.stderr.trim());
  }
  console.log('\x1b[90m────────────────────────────────────────────\x1b[0m\n');

  const checks = [
    { name: '进程正常退出', pass: result.code === 0, detail: `退出码 ${result.code}` },
    { name: '成功调用 read 工具', pass: /读取\s+package\.json/.test(result.stdout) || /read/.test(result.stdout), detail: '应能看到工具调用记录' },
    { name: '工具参数分片被正确拼接', pass: /读取\s+package\.json/.test(result.stdout), detail: 'arguments 分 3 片发送，若能识别出路径说明拼接正确' },
    { name: '工具结果回填后模型给出最终答案', pass: result.stdout.includes('任务完成'), detail: '应包含第二轮回复' },
    { name: '从 package.json 里提取到项目名', pass: result.stdout.includes('mengyun-agent'), detail: '说明工具真的读到了文件内容' },
    // 思考内容（reasoning_content）要一路走到终端展示，而不是被默默丢掉
    {
      name: '思考内容被解析并展示',
      pass: result.stdout.includes('思考过程') && result.stdout.includes('package.json 最可能写着项目名'),
      detail: 'mock 模型发了两段 reasoning_content，终端应显示出来',
    },
    { name: '没有任何报错', pass: !/✗/.test(result.stdout), detail: '输出中不应出现错误标记' },
  ];

  let failed = 0;
  for (const c of checks) {
    if (c.pass) {
      console.log(`  \x1b[32m✓\x1b[0m ${c.name}`);
    } else {
      failed += 1;
      console.log(`  \x1b[31m✗\x1b[0m ${c.name} \x1b[90m(${c.detail})\x1b[0m`);
    }
  }

  console.log('');
  if (failed === 0) {
    console.log(`\x1b[32m\x1b[1m端到端验证通过：${checks.length} 项全部通过\x1b[0m\n`);
  } else {
    console.log(`\x1b[31m\x1b[1m${failed} 项失败 / 共 ${checks.length} 项\x1b[0m\n`);
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error('\x1b[31m验证脚本自身出错：\x1b[0m', err);
  process.exitCode = 1;
});
