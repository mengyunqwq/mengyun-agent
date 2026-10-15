'use strict';

/**
 * 三种 API 协议的离线验证。
 * 用法：node test/provider-formats.js
 *
 * 为什么单独一个文件：协议适配最容易错在「格式翻译」上——
 * 工具定义形状、工具结果的表达、system 的位置、流式事件的组织方式。
 * 这些都是纯数据变换，用假服务器就能完整覆盖，不需要真的调模型。
 *
 * 覆盖：openai / anthropic / gemini 三种格式 ×（流式 / 非流式 / 工具调用 / 思考内容）
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const {
  createProvider,
  detectApiFormat,
  resolveApiFormat,
  API_FORMATS,
  FORMAT_KEYS,
} = require(path.join(ROOT, 'src', 'provider.js'));
const {
  toAnthropicMessages,
  toAnthropicTools,
  mapStopReason,
  clampTemperature,
} = require(path.join(ROOT, 'src', 'providers', 'anthropic.js'));
const {
  toGeminiContents,
  toGeminiTools,
  stripUnsupported,
} = require(path.join(ROOT, 'src', 'providers', 'gemini.js'));
const { classifyError, explainHttpError } = require(path.join(ROOT, 'src', 'providers', 'base.js'));

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${err.message}\x1b[0m`);
    if (process.env.MYA_DEBUG) console.log(err.stack);
  }
}

function section(name) {
  console.log(`\n\x1b[36m▌ ${name}\x1b[0m`);
}

/* ------------------------------------------------------------------ */
/* 假服务：按请求路径判断是哪家的协议，并按该协议的格式回话                  */
/* ------------------------------------------------------------------ */

function startFakeGateway() {
  const seen = [];
  const server = http.createServer((req, res) => {
    // 模型列表是 GET，和对话的 POST 分开处理
    if (req.method === 'GET' && /\/models(\?|$)/.test(req.url)) {
      seen.push({ url: req.url, headers: req.headers, body: null, method: 'GET' });
      return modelsReply(req, res);
    }

    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        /* 忽略 */
      }
      seen.push({ url: req.url, headers: req.headers, body, method: 'POST' });

      const isStream = body.stream === true || /streamGenerateContent/.test(req.url);
      const wantsTools = /agent 实际会这么发|echo|tools/i.test(JSON.stringify(body.tools || body.functions || ''));

      if (req.url.includes('/messages')) return anthropicReply(res, body, isStream);
      // 注意 :streamGenerateContent 里并不包含子串 ':generateContent'，
      // 而 action 前面紧挨的是模型名（models/xxx:generateContent），没有斜杠，
      // 所以这里用两种 action 分别匹配，别用 includes、也别加斜杠
      if (/:streamGenerateContent|:generateContent/.test(req.url)) return geminiReply(res, body, isStream);
      return openaiReply(res, body, isStream, wantsTools);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

function sse(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  return (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

/**
 * 模型列表：按各家真实形状返回，用来验证解析和鉴权都对。
 *   Anthropic  { data: [{ id, display_name }] }
 *   Gemini     { models: [{ name: 'models/xxx' }] }（name 带前缀，必须剥掉）
 *   OpenAI     { data: [{ id }] }
 */
function modelsReply(req, res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (req.url.includes('/messages') || req.headers['x-api-key']) {
    res.end(
      JSON.stringify({
        data: [
          { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' },
          { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' },
        ],
      }),
    );
    return;
  }
  if (/v1beta/.test(req.url)) {
    res.end(
      JSON.stringify({
        models: [
          { name: 'models/gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
          { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
        ],
      }),
    );
    return;
  }
  res.end(
    JSON.stringify({
      object: 'list',
      data: [
        { id: 'deepseek-flash', object: 'model' },
        { id: 'deepseek-v4-pro', object: 'model' },
        { id: 'agnes-image-2.5-flash', object: 'model' },
      ],
    }),
  );
}

/* ---- OpenAI 格式 ---- */
function openaiReply(res, body, isStream, wantsTools) {
  const hasToolResult = (body.messages || []).some((m) => m.role === 'tool');
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  if (!isStream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const message = { role: 'assistant', content: '你好，我是假模型。' };
    if (hasTools && !hasToolResult) {
      message.tool_calls = [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"hi"}' },
        },
      ];
    }
    message.reasoning_content = '先想一下再答。';
    res.end(
      JSON.stringify({
        choices: [{ message, finish_reason: hasTools && !hasToolResult ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    );
    return;
  }

  const send = sse(res);
  send({ choices: [{ index: 0, delta: { reasoning_content: '先想' } }] });
  send({ choices: [{ index: 0, delta: { reasoning_content: '一下。' } }] });
  send({ choices: [{ index: 0, delta: { content: '你好' } }] });
  if (hasTools && !hasToolResult) {
    // 参数分三片，验证拼接
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"te' } }] } }] });
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'xt":"' } }] } }] });
    send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'hi"}' } }] } }] });
  }
  send({ choices: [{ index: 0, delta: { content: '，世界。' } }] });
  send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  send({ choices: [{ index: 0, delta: {}, finish_reason: null }], usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

/* ---- Anthropic 格式 ---- */
function anthropicReply(res, body, isStream) {
  if (!isStream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        content: [
          { type: 'thinking', thinking: '先想一下再答。' },
          { type: 'text', text: '你好，我是假模型。' },
          { type: 'tool_use', id: 'toolu_1', name: 'echo', input: { text: 'hi' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 12, output_tokens: 7 },
      }),
    );
    return;
  }
  const send = sse(res);
  send({ type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 0 } } });
  send({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
  send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先想' } });
  send({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '一下。' } });
  send({ type: 'content_block_stop', index: 0 });
  send({ type: 'content_block_start', index: 1, content_block: { type: 'text' } });
  send({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } });
  send({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '，世界。' } });
  send({ type: 'content_block_stop', index: 1 });
  send({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'echo' } });
  send({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"te' } });
  send({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'xt":"hi"}' } });
  send({ type: 'content_block_stop', index: 2 });
  send({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } });
  send({ type: 'message_stop' });
  res.end();
}

/* ---- Gemini 格式 ---- */
function geminiReply(res, body, isStream) {
  const parts = [
    { thought: true, text: '先想一下再答。' },
    { text: '你好，我是假模型。' },
    { functionCall: { name: 'echo', args: { text: 'hi' } } },
  ];
  const json = {
    candidates: [{ content: { parts, role: 'model' }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 13, candidatesTokenCount: 8, totalTokenCount: 21 },
  };
  if (!isStream) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
    return;
  }
  const send = sse(res);
  send({ candidates: [{ content: { parts: [{ thought: true, text: '先想' }], role: 'model' } }] });
  send({ candidates: [{ content: { parts: [{ thought: true, text: '一下。' }], role: 'model' } }] });
  send({ candidates: [{ content: { parts: [{ text: '你好' }], role: 'model' } }] });
  send({ candidates: [{ content: { parts: [{ text: '，世界。' }], role: 'model' } }] });
  send({ candidates: [{ content: { parts: [{ functionCall: { name: 'echo', args: { text: 'hi' } } }], role: 'model' } }] });
  send({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: json.usageMetadata });
  res.end();
}

/* ------------------------------------------------------------------ */

(async () => {
  console.log('\n\x1b[1m\x1b[35mAPI 协议格式测试\x1b[0m');
  const gw = await startFakeGateway();
  const base = `http://127.0.0.1:${gw.port}`;

  const makeCfg = (format, extra = {}) => ({
    provider: 'custom',
    apiFormat: format,
    baseUrl: format === 'gemini' ? `${base}/v1beta` : `${base}/v1`,
    apiKey: 'sk-test-key',
    model: 'test-model',
    temperature: 0.3,
    stream: true,
    timeoutSec: 10,
    ...extra,
  });

  /* ---------------- 1. 格式清单与识别 ---------------- */

  section('1. 格式清单与自动识别');

  await test('三种格式都在清单里', () => {
    assert.strictEqual(FORMAT_KEYS.length, 3);
    for (const key of ['openai', 'anthropic', 'gemini']) {
      assert.ok(FORMAT_KEYS.includes(key), `缺少格式：${key}`);
    }
    for (const f of API_FORMATS) {
      assert.ok(f.label && f.hint, `格式 ${f.key} 缺少 label/hint（界面要显示）`);
    }
  });

  await test('按地址自动识别格式', () => {
    assert.strictEqual(detectApiFormat('https://api.deepseek.com/v1'), 'openai');
    assert.strictEqual(detectApiFormat('https://api.anthropic.com/v1'), 'anthropic');
    assert.strictEqual(detectApiFormat('https://relay.example.com/v1/messages'), 'anthropic');
    assert.strictEqual(detectApiFormat('https://generativelanguage.googleapis.com/v1beta'), 'gemini');
    assert.strictEqual(detectApiFormat('https://x.com/v1beta/models/gemini-2.0-flash:generateContent'), 'gemini');
    assert.strictEqual(detectApiFormat(''), 'openai', '空地址应回落到 openai');
  });

  await test('显式配置优先于自动识别', () => {
    const cfg = { baseUrl: 'https://relay.example.com/v1', apiFormat: 'anthropic' };
    assert.strictEqual(resolveApiFormat(cfg).format, 'anthropic');
    assert.strictEqual(resolveApiFormat(cfg).source, 'explicit');
    assert.strictEqual(resolveApiFormat({ baseUrl: 'https://x/v1', apiFormat: 'auto' }).format, 'openai');
  });

  await test('未知格式值回落到 auto（不会把配置写坏）', () => {
    const { loadConfig } = require(path.join(ROOT, 'src', 'config.js'));
    const fs = require('fs');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-fmt-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"t"}');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ apiFormat: 'gpt-5-turbo-ultra' }));
    const cfg = loadConfig({ rootDir: dir });
    assert.strictEqual(cfg.apiFormat, 'auto');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* ---------------- 2. 协议翻译（纯函数） ---------------- */

  section('2. 协议翻译（纯函数）');

  const sampleMessages = [
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '读一下 a.js' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a.js"}' } }],
    },
    { role: 'tool', tool_call_id: 'c1', name: 'read', content: '文件内容' },
    { role: 'assistant', content: '读完了' },
  ];

  await test('Anthropic：system 提到顶层，tool 结果变成 user 里的 tool_result', () => {
    const out = toAnthropicMessages(sampleMessages);
    assert.strictEqual(out.system, '你是助手', 'system 必须在顶层');
    assert.ok(!out.messages.some((m) => m.role === 'system'), 'messages 里不能再有 system');
    assert.strictEqual(out.messages[0].role, 'user');

    const toolResult = out.messages.find(
      (m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'),
    );
    assert.ok(toolResult, 'tool 消息应转成 tool_result 块');
    assert.ok(toolResult.content.some((b) => b.tool_use_id === 'c1' && b.content === '文件内容'));

    const assistantWithTool = out.messages.find(
      (m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_use'),
    );
    assert.ok(assistantWithTool, 'assistant.tool_calls 应转成 tool_use 块');
    const use = assistantWithTool.content.find((b) => b.type === 'tool_use');
    assert.strictEqual(use.name, 'read');
    assert.deepStrictEqual(use.input, { path: 'a.js' });
  });

  await test('Anthropic：角色严格交替（相邻同角色会合并）', () => {
    const out = toAnthropicMessages([
      { role: 'user', content: '第一条' },
      { role: 'user', content: '第二条' },
      { role: 'assistant', content: '回答' },
      { role: 'assistant', content: '补充' },
    ]);
    const roles = out.messages.map((m) => m.role);
    for (let i = 1; i < roles.length; i += 1) {
      assert.notStrictEqual(roles[i], roles[i - 1], `第 ${i} 条与前一条角色相同：${roles.join(',')}`);
    }
  });

  await test('Anthropic：不会以 assistant 开头（会被 400 拒）', () => {
    const out = toAnthropicMessages([
      { role: 'assistant', content: '我先说了句话' },
      { role: 'user', content: '你好' },
    ]);
    assert.strictEqual(out.messages[0].role, 'user');
  });

  await test('Anthropic：工具定义用 input_schema，temperature 被夹到 0~1', () => {
    const tools = toAnthropicTools([
      { type: 'function', function: { name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
    ]);
    assert.strictEqual(tools[0].name, 'read');
    assert.ok(tools[0].input_schema, '必须是 input_schema，不是 parameters');
    assert.strictEqual(tools[0].parameters, undefined);
    assert.strictEqual(clampTemperature(1.8), 1, '超过 1 要夹住');
    assert.strictEqual(clampTemperature(-1), 0);
    assert.strictEqual(clampTemperature(0.3), 0.3);
  });

  await test('Anthropic：stop_reason 映射正确', () => {
    assert.strictEqual(mapStopReason('tool_use'), 'tool_calls');
    assert.strictEqual(mapStopReason('max_tokens'), 'length');
    assert.strictEqual(mapStopReason('end_turn'), 'stop');
    assert.strictEqual(mapStopReason(null), 'stop');
  });

  await test('Gemini：assistant→model，system→systemInstruction，工具结果用 functionResponse', () => {
    const out = toGeminiContents(sampleMessages);
    assert.ok(out.systemInstruction, 'system 应放进 systemInstruction');
    assert.ok(
      out.systemInstruction.parts.some((p) => p.text === '你是助手'),
      'systemInstruction 内容不对',
    );
    assert.ok(!out.contents.some((c) => c.role === 'system'), 'contents 里不能有 system');
    for (const c of out.contents) {
      assert.ok(c.role === 'user' || c.role === 'model', `非法角色：${c.role}`);
    }
    const hasFnResponse = out.contents.some((c) => c.parts.some((p) => p.functionResponse));
    assert.ok(hasFnResponse, 'tool 消息应转成 functionResponse');
    const hasFnCall = out.contents.some((c) => c.parts.some((p) => p.functionCall));
    assert.ok(hasFnCall, 'assistant.tool_calls 应转成 functionCall');
  });

  await test('Gemini：工具定义剥掉不支持的关键字（additionalProperties）', () => {
    const tools = toGeminiTools([
      {
        type: 'function',
        function: {
          name: 'read',
          description: '读文件',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', default: 'x' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
    ]);
    const json = JSON.stringify(tools);
    assert.ok(!json.includes('additionalProperties'), 'additionalProperties 会被 Gemini 400 拒掉');
    assert.ok(!json.includes('"default"'), 'default 也不被接受');
    assert.ok(tools[0].parameters.properties.path, '正常的属性要保留');
  });

  await test('stripUnsupported 只删不支持字段，不动结构', () => {
    const cleaned = stripUnsupported({
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'string', examples: ['x'], default: 1 } },
      required: ['a'],
    });
    assert.deepStrictEqual(cleaned, {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    });
  });

  /* ---------------- 3. 真实请求链路（假网关） ---------------- */

  section('3. 真实请求链路（三种格式 × 两种模式）');

  for (const format of FORMAT_KEYS) {
    await test(`${format}：非流式响应能被正确解析`, async () => {
      const p = createProvider(makeCfg(format, { stream: false }));
      const reply = await p.chat({
        messages: [{ role: 'user', content: '你好' }],
        tools: [],
        stream: false,
      });
      assert.ok(reply.text.includes('你好'), `文本不对：${reply.text}`);
      assert.ok(reply.reasoning.includes('先想'), `思考内容没解析出来：${reply.reasoning}`);
      assert.ok(reply.usage && reply.usage.total_tokens > 0, '用量应被归一化');
    });

    await test(`${format}：流式增量被正确拼接`, async () => {
      const p = createProvider(makeCfg(format));
      const deltas = [];
      const thoughts = [];
      const reply = await p.chat({
        messages: [{ role: 'user', content: '你好' }],
        tools: [],
        onDelta: (_d, full) => deltas.push(full),
        onReasoning: (_d, full) => thoughts.push(full),
      });
      assert.strictEqual(reply.text, '你好，世界。', `流式拼接结果不对：${JSON.stringify(reply.text)}`);
      assert.strictEqual(reply.reasoning, '先想一下。', `思考拼接结果不对：${JSON.stringify(reply.reasoning)}`);
      assert.ok(deltas.length >= 2, '应该收到多次增量回调');
      assert.ok(thoughts.length >= 2, '思考也应该有多次增量回调');
      assert.ok(reply.usage && reply.usage.total_tokens > 0, '流式也要能拿到用量');
    });

    await test(`${format}：工具调用能被解析出来`, async () => {
      const p = createProvider(makeCfg(format, { stream: false }));
      const reply = await p.chat({
        messages: [{ role: 'user', content: '帮我读文件' }],
        tools: [
          {
            type: 'function',
            function: { name: 'echo', description: '回显', parameters: { type: 'object', properties: { text: { type: 'string' } } } },
          },
        ],
        stream: false,
      });
      assert.strictEqual(reply.toolCalls.length, 1, `工具调用数量不对：${JSON.stringify(reply.toolCalls)}`);
      assert.strictEqual(reply.toolCalls[0].name, 'echo');
      assert.deepStrictEqual(reply.toolCalls[0].args, { text: 'hi' }, '工具参数没解析对');
      assert.strictEqual(reply.finishReason, 'tool_calls');
    });

    await test(`${format}：流式工具参数分片被拼接`, async () => {
      const p = createProvider(makeCfg(format));
      const calls = [];
      const reply = await p.chat({
        messages: [{ role: 'user', content: '帮我读文件' }],
        tools: [
          {
            type: 'function',
            function: { name: 'echo', description: '回显', parameters: { type: 'object', properties: { text: { type: 'string' } } } },
          },
        ],
        onToolCall: (tc) => calls.push(tc),
      });
      assert.ok(reply.toolCalls.length >= 1, `流式下应能拿到工具调用：${JSON.stringify(reply.toolCalls)}`);
      assert.strictEqual(reply.toolCalls[0].name, 'echo');
      assert.deepStrictEqual(reply.toolCalls[0].args, { text: 'hi' }, '分片参数没拼对');
      assert.ok(calls.length >= 1, 'onToolCall 回调应被触发');
    });
  }

  /* ---------------- 4. 请求发对了地方（鉴权与地址） ---------------- */

  section('4. 请求地址与鉴权');

  await test('OpenAI：打到 /chat/completions，用 Bearer', async () => {
    gw.seen.length = 0;
    const p = createProvider(makeCfg('openai', { stream: false }));
    await p.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], stream: false });
    const req = gw.seen[gw.seen.length - 1];
    assert.ok(req.url.endsWith('/v1/chat/completions'), `地址不对：${req.url}`);
    assert.strictEqual(req.headers.authorization, 'Bearer sk-test-key');
  });

  await test('Anthropic：打到 /messages，用 x-api-key + anthropic-version', async () => {
    gw.seen.length = 0;
    const p = createProvider(makeCfg('anthropic', { stream: false }));
    await p.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], stream: false });
    const req = gw.seen[gw.seen.length - 1];
    assert.ok(req.url.endsWith('/v1/messages'), `地址不对：${req.url}`);
    assert.strictEqual(req.headers['x-api-key'], 'sk-test-key');
    assert.ok(req.headers['anthropic-version'], '必须带 anthropic-version');
    // max_tokens 是必填，不发会被 400
    assert.ok(req.body.max_tokens > 0, 'Anthropic 必须发 max_tokens');
  });

  await test('Gemini：模型名进 URL，用 x-goog-api-key', async () => {
    gw.seen.length = 0;
    const p = createProvider(makeCfg('gemini', { stream: false }));
    await p.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], stream: false });
    const req = gw.seen[gw.seen.length - 1];
    assert.ok(req.url.includes('/v1beta/models/test-model:generateContent'), `地址不对：${req.url}`);
    assert.strictEqual(req.headers['x-goog-api-key'], 'sk-test-key');
    assert.ok(Array.isArray(req.body.contents), 'Gemini 用 contents 而不是 messages');
  });

  await test('自定义请求头能覆盖（自建网关常要）', async () => {
    gw.seen.length = 0;
    const p = createProvider(makeCfg('openai', { stream: false, extraHeaders: { 'X-Custom-Auth': 'abc' } }));
    await p.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], stream: false });
    const req = gw.seen[gw.seen.length - 1];
    assert.strictEqual(req.headers['x-custom-auth'], 'abc');
  });

  /* ---------------- 4.5 推理等级（按各家官方定义发字段） ---------------- */

  section('4.5 推理等级：各按官方字段与取值发出去');

  await test('默认（auto）一个推理字段都不发（行为不变）', async () => {
    for (const format of ['openai', 'anthropic', 'gemini']) {
      gw.seen.length = 0;
      const p = createProvider(makeCfg(format, { stream: false, reasoning: { level: 'auto' } }));
      await p.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], stream: false });
      const req = gw.seen[gw.seen.length - 1];
      const body = JSON.stringify(req.body);
      assert.ok(
        !/reasoning_effort|"thinking"|thinkingConfig/.test(body),
        `${format} 的默认档不该发推理字段：${body}`,
      );
    }
  });

  await test('OpenAI 兼容：发官方的 reasoning_effort（minimal/low/medium/high 原样发）', async () => {
    for (const level of ['minimal', 'low', 'medium', 'high']) {
      gw.seen.length = 0;
      const p = createProvider(makeCfg('openai', { stream: false, reasoning: { level } }));
      await p.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], stream: false });
      const req = gw.seen[gw.seen.length - 1];
      assert.strictEqual(req.body.reasoning_effort, level, `reasoning_effort 应该就是官方取值 ${level}`);
    }
  });

  await test('Anthropic：用官方的 thinking.budget_tokens，并自动去掉 temperature', async () => {
    gw.seen.length = 0;
    const p = createProvider(makeCfg('anthropic', { stream: false, reasoning: { level: 'medium' } }));
    await p.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], stream: false });
    const req = gw.seen[gw.seen.length - 1];
    assert.ok(req.body.thinking, 'anthropic 应该发 thinking 字段');
    assert.strictEqual(req.body.thinking.type, 'enabled');
    assert.ok(req.body.thinking.budget_tokens >= 1024, `预算不能小于 1024：${req.body.thinking.budget_tokens}`);
    assert.ok(
      req.body.thinking.budget_tokens < req.body.max_tokens,
      `预算必须小于 max_tokens（官方硬性要求）：${req.body.thinking.budget_tokens} vs ${req.body.max_tokens}`,
    );
    assert.strictEqual(req.body.temperature, undefined, '开 thinking 时不能带 temperature（官方要求）');
  });

  await test('Gemini：用官方的 generationConfig.thinkingConfig.thinkingBudget', async () => {
    gw.seen.length = 0;
    const p = createProvider(makeCfg('gemini', { stream: false, reasoning: { level: 'high' } }));
    await p.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], stream: false });
    const req = gw.seen[gw.seen.length - 1];
    const gen = req.body.generationConfig || {};
    assert.ok(gen.thinkingConfig, 'gemini 应该发 thinkingConfig');
    assert.strictEqual(gen.thinkingConfig.thinkingBudget, 24576, `「高」这一档的预算是 24576，实际 ${gen.thinkingConfig.thinkingBudget}`);

    // minimal 在 Gemini 官方语义里就是 0（关掉思考）
    gw.seen.length = 0;
    const p2 = createProvider(makeCfg('gemini', { stream: false, reasoning: { level: 'minimal' } }));
    await p2.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], stream: false });
    const req2 = gw.seen[gw.seen.length - 1];
    assert.strictEqual(req2.body.generationConfig.thinkingConfig.thinkingBudget, 0, 'minimal 在 Gemini 是 0（关掉思考）');
  });

  await test('选项表按协议生成，且不认识的取值收敛成 auto', () => {
    const reasoning = require(path.join(ROOT, 'src', 'reasoning.js'));
    assert.deepStrictEqual(
      reasoning.optionsFor('openai').map((o) => o.value),
      ['auto', 'minimal', 'low', 'medium', 'high'],
      'OpenAI 兼容的档位要和官方取值一致',
    );
    assert.deepStrictEqual(
      reasoning.optionsFor('anthropic').map((o) => o.value),
      ['auto', 'low', 'medium', 'high'],
      'Anthropic 没有 minimal（官方没有等级概念，只有 token 预算）',
    );
    assert.ok(/budget_tokens/.test(reasoning.optionsFor('anthropic')[2].hint), 'Anthropic 的档位要说清发的是 token 预算');
    assert.ok(/thinkingBudget/.test(reasoning.optionsFor('gemini')[3].hint), 'Gemini 的档位要说清发的是 thinkingBudget');
    assert.strictEqual(reasoning.normalize('max'), 'auto', '不认识的取值必须收敛成 auto，绝不发野字段出去');
    assert.strictEqual(reasoning.describe({ reasoning: { level: 'HIGH' } }, 'openai').level, 'high', '取值大小写不敏感');
  });

  await test('baseUrl 里已经带了完整路径时不会被拼重复', () => {
    const a = createProvider({ baseUrl: 'https://x.com/v1/chat/completions', model: 'm', apiFormat: 'openai' });
    assert.strictEqual(a.endpoint(), 'https://x.com/v1/chat/completions');
    const b = createProvider({ baseUrl: 'https://x.com/v1/messages', model: 'm', apiFormat: 'anthropic' });
    assert.strictEqual(b.endpoint(), 'https://x.com/v1/messages');
    const c = createProvider({ baseUrl: 'https://x.com/v1beta/models/m:generateContent', model: 'm', apiFormat: 'gemini' });
    assert.strictEqual(c.endpoint(), 'https://x.com/v1beta/models/m:generateContent');
  });

  /* ---------------- 5. 错误与边界 ---------------- */

  section('5. 错误与边界');

  await test('没有 baseUrl 时报错说得清怎么配', () => {
    assert.throws(
      () => createProvider({ baseUrl: '', model: 'm' }),
      /baseUrl/,
      '错误信息里要提到 baseUrl',
    );
  });

  await test('未知格式不会静默走错协议', () => {
    // 未知值在 config 层已被归一到 auto，这里验证 provider 层对 auto 的处理
    const p = createProvider({ baseUrl: 'https://x.com/v1', model: 'm', apiFormat: 'auto' });
    assert.strictEqual(p.formatName, 'openai', 'auto + 无特征地址应回落 openai');
  });

  await test('HTTP 错误里带上格式信息，方便判断是不是选错了协议', async () => {
    const bad = http.createServer((req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    });
    await new Promise((r) => bad.listen(0, '127.0.0.1', r));
    const port = bad.address().port;
    try {
      const p = createProvider({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'bad',
        model: 'm',
        apiFormat: 'anthropic',
        timeoutSec: 5,
      });
      await assert.rejects(
        () => p.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], stream: false }),
        (err) => {
          assert.ok(/401/.test(err.message), `应提到 401：${err.message}`);
          assert.ok(/anthropic/i.test(err.message), `应提到当前格式，便于判断选错了：${err.message}`);
          assert.ok(/invalid api key/.test(err.message), '应带上服务端原文');
          return true;
        },
      );
    } finally {
      bad.close();
    }
  });

  /* ---------------- 6. 错误归因：别把人带偏 ---------------- */

  section('6. 错误归因（模型名 / 鉴权 / 额度 / 端点）');

  // 背景：中转站报「模型 X 不在分组中，可用：a, b, c」时，
  // 如果一律按「404 = 地址不对」提示，用户会去折腾地址和协议格式，
  // 而真正要改的是模型名。这一组测试就是钉住这个判断。

  const FAKE_PROVIDER = {
    formatName: 'openai',
    formatLabel: 'OpenAI 兼容',
    baseUrl: 'https://api.example.com/v1',
    model: 'LLM',
  };

  await test('中转站「模型不在分组」被认成模型名错误，并提取出可用模型', () => {
    const message =
      '模型 "LLM" 不在分组「LLM」中。可用：agnes-2.5-flash, agnes-3.0-flash, ' +
      'agnes-image-2.5-flash, agnes-video-2.5-flash, deepseek-flash, deepseek-v4-pro';
    const info = classifyError(404, message);
    assert.strictEqual(info.kind, 'model', '应归类为模型名错误，而不是地址错误');
    assert.ok(info.models.length >= 5, `应提取出可用模型列表，实际 ${JSON.stringify(info.models)}`);
    assert.ok(info.models.includes('deepseek-flash'));
  });

  await test('模型名错误的提示会列出可用模型，并提醒非对话模型', () => {
    const body = JSON.stringify({
      error: { message: '模型 "LLM" 不在分组「LLM」中。可用：agnes-image-2.5-flash, deepseek-flash' },
    });
    const out = explainHttpError(404, body, FAKE_PROVIDER);
    assert.strictEqual(out.kind, 'model');
    assert.ok(out.message.includes('deepseek-flash'), '提示里应列出可用模型');
    assert.ok(/图片|图像|video|非对话/.test(out.message), '应提醒 image/video 类模型不适合 agent');
    assert.ok(!/接口地址不对/.test(out.message), '不该再说「地址不对」，那是错误的方向');
    assert.ok(!/baseUrl 一般应形如/.test(out.message), '不该再提 baseUrl 的写法');
  });

  await test('英文写法的模型错误也能认出来', () => {
    assert.strictEqual(classifyError(400, 'The model `gpt-9` does not exist').kind, 'model');
    assert.strictEqual(classifyError(404, 'invalid model: foo').kind, 'model');
    assert.strictEqual(classifyError(400, 'model not found').kind, 'model');
  });

  await test('真正的地址错误不会被误判成模型错误', () => {
    assert.strictEqual(classifyError(404, 'Cannot POST /v1/chat/completions').kind, 'endpoint');
    assert.strictEqual(classifyError(404, 'no route matched the request path').kind, 'endpoint');
  });

  await test('鉴权与额度错误各自归类', () => {
    assert.strictEqual(classifyError(401, 'Incorrect API key provided').kind, 'auth');
    assert.strictEqual(classifyError(401, 'invalid api key').kind, 'auth');
    assert.strictEqual(classifyError(403, '您的账户余额不足').kind, 'quota');
    assert.strictEqual(classifyError(429, 'You exceeded your current quota').kind, 'quota');
  });

  await test('错误对象带上 kind，界面才能给对建议', async () => {
    const bad = http.createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: '模型 "LLM" 不在分组「LLM」中。可用：deepseek-flash' } }));
    });
    await new Promise((r) => bad.listen(0, '127.0.0.1', r));
    try {
      const p = createProvider({
        baseUrl: `http://127.0.0.1:${bad.address().port}/v1`,
        apiKey: 'k',
        model: 'LLM',
        apiFormat: 'openai',
        timeoutSec: 5,
      });
      await assert.rejects(
        () => p.chat({ messages: [{ role: 'user', content: 'x' }], tools: [], stream: false }),
        (err) => {
          assert.strictEqual(err.kind, 'model', 'ProviderError 必须带上 kind');
          assert.ok(err.message.includes('deepseek-flash'), '消息里应含可用模型');
          return true;
        },
      );
    } finally {
      bad.close();
    }
  });

  /* ---------------- 7. 模型列表 ---------------- */

  section('7. 模型列表（自动拉取）');

  // 让用户手打模型名是反人类的：错一个字符就是 404，而服务端明明知道自己有哪些模型。
  // 这一组验证三种协议都能把列表拉回来、并且形状解析正确。

  for (const format of FORMAT_KEYS) {
    await test(`${format}：能拉到模型列表`, async () => {
      const p = createProvider(makeCfg(format));
      const r = await p.listModels();
      assert.ok(r.ok, `应拉取成功：${r.error || ''}`);
      assert.ok(r.models.length >= 2, `模型数量不对：${JSON.stringify(r.models)}`);
      for (const m of r.models) {
        assert.ok(m.id && typeof m.id === 'string', `模型项缺少 id：${JSON.stringify(m)}`);
      }
    });
  }

  await test('Gemini 的 models/ 前缀被剥掉', async () => {
    const p = createProvider(makeCfg('gemini'));
    const r = await p.listModels();
    const ids = r.models.map((m) => m.id);
    assert.ok(ids.includes('gemini-2.0-flash'), `应剥掉 models/ 前缀：${JSON.stringify(ids)}`);
    assert.ok(!ids.some((id) => id.startsWith('models/')), `不该残留前缀：${JSON.stringify(ids)}`);
  });

  await test('列表去重并按名字排序（界面才整齐）', async () => {
    const p = createProvider(makeCfg('openai'));
    const r = await p.listModels();
    const ids = r.models.map((m) => m.id);
    assert.deepStrictEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)), '应按名字排序');
    assert.strictEqual(new Set(ids).size, ids.length, '不应有重复');
  });

  await test('模型列表用对了地址与鉴权（三家各不相同）', async () => {
    for (const format of FORMAT_KEYS) {
      gw.seen.length = 0;
      const p = createProvider(makeCfg(format));
      await p.listModels();
      const req = gw.seen[gw.seen.length - 1];
      assert.strictEqual(req.method, 'GET', `${format} 应该用 GET`);
      assert.ok(/\/models/.test(req.url), `${format} 地址应指向 /models，实际 ${req.url}`);
      if (format === 'anthropic') {
        assert.strictEqual(req.headers['x-api-key'], 'sk-test-key', 'Anthropic 要用 x-api-key');
      } else if (format === 'gemini') {
        assert.strictEqual(req.headers['x-goog-api-key'], 'sk-test-key', 'Gemini 要用 x-goog-api-key');
      } else {
        assert.strictEqual(req.headers.authorization, 'Bearer sk-test-key', 'OpenAI 要用 Bearer');
      }
    }
  });

  await test('宽容解析各种奇怪的响应形状', () => {
    const p = createProvider(makeCfg('openai'));
    // 纯字符串数组
    assert.deepStrictEqual(p.parseModels(['a', 'b']).map((m) => m.id), ['a', 'b']);
    // { models: [...] }
    assert.deepStrictEqual(p.parseModels({ models: [{ name: 'x' }] }).map((m) => m.id), ['x']);
    // { result: [...] }
    assert.deepStrictEqual(p.parseModels({ result: [{ id: 'y' }] }).map((m) => m.id), ['y']);
    // 单个模型
    assert.deepStrictEqual(p.parseModels({ model: 'z' }).map((m) => m.id), ['z']);
    // 认不出来时返回空数组，而不是抛错
    assert.deepStrictEqual(p.parseModels({ nothing: 1 }), []);
    assert.deepStrictEqual(p.parseModels(null), []);
  });

  await test('网关不支持 /models 时给出可读原因，而不是崩掉', async () => {
    const noModels = http.createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not implemented' } }));
    });
    await new Promise((r) => noModels.listen(0, '127.0.0.1', r));
    try {
      const p = createProvider({
        baseUrl: `http://127.0.0.1:${noModels.address().port}/v1`,
        apiKey: 'k',
        model: 'm',
        apiFormat: 'openai',
        timeoutSec: 5,
      });
      const r = await p.listModels();
      assert.strictEqual(r.ok, false, '应返回 ok:false 而不是抛错');
      assert.ok(/404/.test(r.error), `错误里应带上状态码：${r.error}`);
      assert.ok(/手动填/.test(r.error), '应告诉用户可以手填模型名');
      assert.deepStrictEqual(r.models, []);
    } finally {
      noModels.close();
    }
  });

  await test('连不上时也返回原因，不抛异常', async () => {
    const p = createProvider({
      baseUrl: 'http://127.0.0.1:1/v1', // 1 号端口必然连不上
      apiKey: 'k',
      model: 'm',
      apiFormat: 'openai',
      timeoutSec: 3,
    });
    const r = await p.listModels();
    assert.strictEqual(r.ok, false);
    assert.ok(r.error && r.error.length > 0, '要给出原因');
  });

  await test('baseUrl 已带 /models 时不会拼成 /models/models', () => {
    const p = createProvider({
      baseUrl: 'https://x.com/v1/models',
      model: 'm',
      apiFormat: 'openai',
      apiKey: 'k',
    });
    assert.ok(!/\/models\/models/.test(p.modelsEndpoint()), `地址拼错了：${p.modelsEndpoint()}`);
  });

  /* ---------------- 汇总 ---------------- */

  gw.server.close();
  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '─'.repeat(52));
  if (failed.length) {
    console.log(`\x1b[31m\x1b[1m${failed.length} 项失败 / 共 ${results.length} 项\x1b[0m`);
    process.exitCode = 1;
  } else {
    console.log(`\x1b[32m\x1b[1m全部通过：${results.length} 项\x1b[0m`);
  }
})().catch((err) => {
  console.error('\n测试脚本本身出错：', err);
  process.exitCode = 1;
});
