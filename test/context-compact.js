'use strict';

/**
 * 上下文压缩插件的针对性验证。
 * 用法：node test/context-compact.js
 *
 * 为什么单独一个文件：这个插件的正确性全在边界上——
 * 什么时候该压、切点会不会拆散 tool/assistant 对、摘要失败会不会拖垮对话。
 * 这些用一两个断言说不清，值得单独跑。
 */

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { Session, estimateTokens, resolveContextWindow } = require(path.join(ROOT, 'src', 'session.js'));
const { PluginHost } = require(path.join(ROOT, 'src', 'plugins.js'));
const { ToolRegistry } = require(path.join(ROOT, 'src', 'tools.js'));
const { EventBus } = require(path.join(ROOT, 'src', 'events.js'));

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

/** 建一个宿主，只加载 context-compact */
function makeHost(overrides = {}) {
  const cfg = {
    cwd: ROOT,
    model: 'deepseek-chat',
    provider: 'deepseek',
    contextWindow: 1000,
    compact: { enabled: true, auto: false, threshold: 0.5, keepRecent: 4, minMessages: 4 },
    pluginDirs: [path.join(ROOT, 'plugins')],
    plugins: { enabled: true, dirs: [path.join(ROOT, 'plugins')], disabled: [], config: {} },
    tools: { autoApprove: [], deny: [], maxOutputChars: 30000 },
    shell: { allowDangerous: false, timeoutSec: 10 },
    session: { save: false, dir: ROOT, maxHistoryMessages: 200 },
  };
  const merged = { ...cfg, ...overrides, plugins: { ...cfg.plugins, ...(overrides.plugins || {}) } };
  const bus = new EventBus();
  const registry = new ToolRegistry(merged, bus);
  const host = new PluginHost(merged, bus, registry, { ui: null, log: () => {} });
  return { cfg: merged, bus, registry, host };
}

/** 假的模型：只用来生成摘要 */
function fakeProvider(replyText, opts = {}) {
  const calls = [];
  return {
    calls,
    async chat(req) {
      calls.push(req);
      if (opts.throwError) throw new Error(opts.throwError);
      return { text: replyText, toolCalls: [], usage: { total_tokens: 42 }, finishReason: 'stop' };
    },
  };
}

/** 造一段够长的历史 */
function makeSession(cfg, rounds = 10) {
  const s = new Session(cfg);
  s.setSystemPrompt('你是助手');
  for (let i = 0; i < rounds; i += 1) {
    s.addUser(`第${i}个问题：把 utils.js 里的函数改一下`);
    s.addAssistant('', [{ id: `c${i}`, name: 'read', args: { path: 'utils.js' }, rawArgs: '{"path":"utils.js"}' }], `思考第${i}轮`);
    s.addToolResult(`c${i}`, 'read', `文件内容${i}`.repeat(30));
    s.addAssistant(`第${i}轮完成`);
  }
  return s;
}

(async () => {
  console.log('\n\x1b[1m\x1b[35m上下文压缩插件测试\x1b[0m');

  /* ---------------- 1. 基础度量 ---------------- */

  section('1. 用量估算');

  await test('中文按字估算、英文按 4 字符估算', () => {
    assert.strictEqual(estimateTokens('你好世界'), 4, '中文应 1 字 1 token');
    assert.strictEqual(estimateTokens('hello world'), 3, '英文 11 字符应约 3 token');
    assert.strictEqual(estimateTokens(''), 0);
    assert.ok(estimateTokens('中文 mixed 内容 with english'.repeat(10)) > 0);
  });

  await test('上下文窗口按模型推断，可被配置覆盖', () => {
    assert.strictEqual(resolveContextWindow({ provider: 'deepseek', model: 'deepseek-chat' }), 128000);
    assert.strictEqual(resolveContextWindow({ provider: 'openai', model: 'gpt-4o-mini' }), 128000);
    assert.strictEqual(resolveContextWindow({ provider: 'ollama', model: 'qwen2.5-coder:7b' }), 131072);
    assert.strictEqual(resolveContextWindow({ provider: 'ollama', model: '某个没见过的模型' }), 8192);
    assert.strictEqual(resolveContextWindow({ model: 'x', contextWindow: 4096 }), 4096, '显式配置优先');
  });

  await test('measureContext 记录用量与比例', () => {
    const cfg = { session: { maxHistoryMessages: 200 }, model: 'test', provider: 'custom', contextWindow: 1000 };
    const s = new Session(cfg);
    s.setSystemPrompt('sys');
    s.addUser('你好'.repeat(50));
    const ctx = s.measureContext(s.toMessages());
    assert.ok(ctx.used > 50, `应估算出用量，实际 ${ctx.used}`);
    assert.strictEqual(ctx.window, 1000);
    assert.ok(s.contextRatio() > 0 && s.contextRatio() <= 1);
  });

  /* ---------------- 2. 压缩的切点 ---------------- */

  section('2. 历史压缩的切点');

  await test('压缩保留 system 和最近若干条，插入摘要说明', () => {
    const cfg = { session: { maxHistoryMessages: 200 }, model: 't', provider: 'custom' };
    const s = makeSession(cfg, 10);
    const before = s.messages.length;
    const res = s.compactHistory(4, '早先改了 utils.js 的 humanSize');
    assert.ok(res, '应发生压缩');
    assert.ok(res.removed > 0);
    assert.strictEqual(s.messages[0].role, 'system', 'system 必须保留在最前');
    assert.strictEqual(s.messages[1].role, 'user', '摘要以 user 消息注入（兼容性最好）');
    assert.ok(s.messages[1].content.includes('上下文压缩'));
    assert.ok(s.messages[1].content.includes('humanSize'));
    assert.ok(s.messages.length < before, '压缩后应该更短');
  });

  await test('压缩不会留下孤儿 tool 消息', () => {
    const cfg = { session: { maxHistoryMessages: 200 }, model: 't', provider: 'custom' };
    const s = makeSession(cfg, 10);
    s.compactHistory(3, '摘要');
    const msgs = s.toMessages();
    for (let i = 0; i < msgs.length; i += 1) {
      if (msgs[i].role === 'tool') {
        const ok = msgs.slice(0, i).some((m) => m.tool_calls && m.tool_calls.some((t) => t.id === msgs[i].tool_call_id));
        assert.ok(ok, `tool ${msgs[i].tool_call_id} 找不到父级 tool_calls`);
      }
    }
  });

  await test('历史太短时不压缩（压了反而亏）', () => {
    const cfg = { session: { maxHistoryMessages: 200 }, model: 't', provider: 'custom' };
    const s = new Session(cfg);
    s.setSystemPrompt('sys');
    s.addUser('一');
    s.addAssistant('二');
    assert.strictEqual(s.compactHistory(4, '摘要'), null, '短历史应返回 null');
    assert.strictEqual(s.messages.length, 3, '短历史不应被改动');
  });

  await test('保留条数比历史还多时不动手（也不崩）', () => {
    const cfg = { session: { maxHistoryMessages: 200 }, model: 't', provider: 'custom' };
    const s = makeSession(cfg, 3);
    assert.strictEqual(s.compactHistory(999, '摘要'), null, '可压缩内容不足时应返回 null');
    assert.ok(s.messages.length > 0, '消息不应丢失');
  });

  await test('思考内容不会发给模型', () => {
    const cfg = { session: { maxHistoryMessages: 200 }, model: 't', provider: 'custom' };
    const s = new Session(cfg);
    s.setSystemPrompt('sys');
    s.addUser('问题');
    s.addAssistant('答案', null, '这是我内心的想法');
    assert.ok(s.messages[2]._reasoning, '思考内容应存在会话里');
    assert.ok(!JSON.stringify(s.toMessages()).includes('内心的想法'), '思考内容不应进请求');
  });

  /* ---------------- 3. 插件行为 ---------------- */

  section('3. 插件行为');

  const loadPlugin = async (overrides = {}) => {
    const { host, bus, cfg } = makeHost(overrides);
    await host.loadAll();
    assert.ok(host.plugins.has('context-compact'), `插件应加载成功：${JSON.stringify(host.errors)}`);
    return { host, bus, cfg };
  };

  await test('用量没超阈值时不动上下文', async () => {
    const { bus, cfg } = await loadPlugin({
      contextWindow: 10000000,
      compact: { enabled: true, auto: true, threshold: 0.5, keepRecent: 4, minMessages: 4 },
    });
    const s = makeSession(cfg, 4);
    const provider = fakeProvider('不该被调用');
    const messages = s.toMessages();
    const before = JSON.stringify(messages);
    await bus.emit('messages:before', { messages, session: s, provider, emit: (e, p) => bus.emit(e, p) });
    assert.strictEqual(provider.calls.length, 0, '不该请求模型写摘要');
    assert.strictEqual(JSON.stringify(messages), before, '消息应原样不动');
  });

  await test('默认（手动模式）用量再高也不自动压', async () => {
    // 用户明确要求「压缩改成按键触发」：压缩会改写对话历史，
    // 不该在用户没要求的时候悄悄动它
    const { bus, cfg } = await loadPlugin({ contextWindow: 1000 });
    const s = makeSession(cfg, 14);
    const provider = fakeProvider('这段摘要不该被生成');
    const messages = s.toMessages();
    const before = JSON.stringify(messages);
    const beforeLen = s.messages.length;

    await bus.emit('messages:before', { messages, session: s, provider, emit: (e, p) => bus.emit(e, p) });

    assert.strictEqual(provider.calls.length, 0, '手动模式下不该自己请求摘要');
    assert.strictEqual(JSON.stringify(messages), before, '消息应原样不动');
    assert.strictEqual(s.messages.length, beforeLen, '会话历史也不该变');
  });

  await test('手动触发命令能压缩，并广播压缩事件', async () => {
    const { host, bus, cfg } = await loadPlugin({ contextWindow: 1000 });
    const s = makeSession(cfg, 12);
    const provider = fakeProvider('交接说明：已经修改 utils.js 的 humanSize 函数，新增 TB 支持；尚未跑测试。');
    const beforeLen = s.messages.length;

    const events = [];
    bus.on('context:compacted', (e) => events.push(e));

    const out = await host.commands.get('compact').handler('', {
      session: s,
      provider,
      emit: (e, p) => bus.emit(e, p),
    });

    assert.strictEqual(provider.calls.length, 1, '应该请求一次摘要');
    assert.ok(provider.calls[0].messages[0].content.includes('压缩'), '摘要提示词应说明任务');
    assert.ok(events.length === 1, '应广播一次 context:compacted');
    assert.ok(events[0].removed > 0);
    assert.ok(events[0].savedTokens > 0, `应报告省下的 token，实际 ${events[0].savedTokens}`);
    assert.strictEqual(events[0].reason, 'manual', '要标明是手动触发的');
    assert.ok(s.messages.length < beforeLen, '会话内部历史应被压缩');
    assert.ok(String(out).includes('已压缩'), `命令应返回结果说明，实际：${out}`);
  });

  await test('打开 auto 之后仍然会自动压（开关没被删掉）', async () => {
    const { bus, cfg } = await loadPlugin({
      contextWindow: 1200,
      compact: { enabled: true, auto: true, threshold: 0.5, keepRecent: 4, minMessages: 4 },
    });
    const s = makeSession(cfg, 12);
    const provider = fakeProvider('交接说明：已经修改 utils.js，尚未跑测试。');
    const messages = s.toMessages();
    const beforeLen = messages.length;

    const events = [];
    bus.on('context:compacted', (e) => events.push(e));
    await bus.emit('messages:before', { messages, session: s, provider, emit: (e, p) => bus.emit(e, p) });

    assert.strictEqual(provider.calls.length, 1, 'auto 模式应该请求摘要');
    assert.ok(events.length === 1, '应广播一次 context:compacted');
    assert.strictEqual(events[0].reason, 'auto');
    assert.ok(messages.length < beforeLen, '发出去的消息应该变短');
    assert.ok(
      messages.some((m) => typeof m.content === 'string' && m.content.includes('交接说明')),
      '摘要应该出现在发出去的消息里',
    );
  });

  await test('摘要请求失败时保持原样，不影响对话', async () => {
    const { host, bus, cfg } = await loadPlugin({ contextWindow: 1200 });
    const s = makeSession(cfg, 12);
    const provider = fakeProvider('', { throwError: '模拟网络错误' });
    const messages = s.toMessages();
    const before = JSON.stringify(messages);
    const errors = [];
    bus.on('error', (e) => errors.push(e));
    const failures = [];
    bus.on('context:compact-failed', (e) => failures.push(e));

    // 手动路径：失败不能靠解析中文判断，要有一个明确的事件
    const run = await host.runCommand('compact', '', {
      session: s,
      provider,
      emit: (e, p) => bus.emit(e, p),
    });
    assert.strictEqual(failures.length, 1, '应发出一次 context:compact-failed');
    assert.ok(/模拟网络错误/.test(failures[0].error), `原因要带上，实际：${failures[0].error}`);
    assert.ok(/模拟网络错误/.test(String(run.result)), `给人看的文字里也要说明，实际：${run.result}`);
    assert.strictEqual(JSON.stringify(messages), before, '失败时消息应原样保留');
    assert.ok(errors.length >= 1, '应把错误转成 error 事件，而不是静默');
  });

  await test('模型没给出可用摘要时不乱压', async () => {
    const { host, cfg } = await loadPlugin({ contextWindow: 1200 });
    const s = makeSession(cfg, 12);
    const provider = fakeProvider('好');
    const lenBefore = s.messages.length;
    const failures = [];
    const run = await host.runCommand('compact', '', {
      session: s,
      provider,
      emit: (e, p) => (e === 'context:compact-failed' ? failures.push(p) : undefined),
    });
    assert.strictEqual(failures.length, 1, '摘要太短应报失败');
    assert.ok(String(run.result).includes('没有压缩'), `应说明没压，实际：${run.result}`);
    assert.strictEqual(s.messages.length, lenBefore, '历史不该被改动');
  });

  await test('压缩后请求里没有内部字段', async () => {
    const { host, cfg } = await loadPlugin({ contextWindow: 1200 });
    const s = makeSession(cfg, 12);
    const provider = fakeProvider('交接说明：'.repeat(5));
    await host.runCommand('compact', '', { session: s, provider });
    const dump = JSON.stringify(s.toMessages());
    assert.ok(!dump.includes('_compacted'), '内部字段不能发出去');
    assert.ok(!dump.includes('_reasoning'), '思考内容不能发出去');
    assert.ok(!dump.includes('_usage'), '每步用量也不能发出去');
    assert.ok(!dump.includes('_ts'), '_ts 不能发出去');
  });

  await test('注册了手动压缩命令和统计命令', async () => {
    const { host } = await loadPlugin();
    assert.ok(host.commands.has('compact'), '应有 /compact（界面按钮也走它）');
    assert.ok(host.commands.has('compact_stats'), '应有 /compact_stats');
    const out = await host.commands.get('compact_stats').handler('', {});
    assert.ok(String(out).includes('手动'), `统计里应说明当前是手动模式，实际：${out}`);
  });

  /* ---------------- 汇总 ---------------- */

  const failed = results.filter((r) => !r.ok);
  console.log('\n' + '─'.repeat(50));
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
