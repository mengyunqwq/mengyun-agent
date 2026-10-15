'use strict';

/**
 * 并行子任务调度器（src/tasks.js）的单元测试。
 *
 * 这一套不接模型：runSubtask 是注入进来的，所以可以精确控制
 * 「谁什么时候完成、谁卡住、谁超时」——并发上限、深度限制、超时、
 * 中断级联、预算这些正是最容易写错又最难在真实模型上复现的部分。
 *
 * 跑：node test/tasks.js
 */

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const { TaskManager, TASK_DEFAULTS, createSilentIO } = require(path.join(ROOT, 'src', 'tasks.js'));
const { ToolRegistry } = require(path.join(ROOT, 'src', 'tools.js'));
const { EventBus } = require(path.join(ROOT, 'src', 'events.js'));

const results = [];
let failures = 0;

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    results.push({ name, ok: false, error: err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${err.message}\x1b[0m`);
    if (process.env.MYA_DEBUG) console.log(err.stack);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}

function section(name) {
  console.log(`\n\x1b[36m▌ ${name}\x1b[0m`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 造一个可控的执行器：默认立刻返回，可以按标题定制行为 */
function makeRunner(spec = {}) {
  const calls = [];
  const runner = async (task, signal, hooks) => {
    calls.push({ id: task.id, title: task.title, allowTools: task.allowTools, depth: task.depth });
    const behavior = spec[task.title] || spec.default || {};
    hooks.activity(`开始：${task.title}`);
    if (behavior.activity) hooks.activity(behavior.activity);
    if (behavior.progress) hooks.progress(behavior.progress);
    if (behavior.waitForever) {
      await new Promise((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      // 被中断的子任务：agent.run 在中断时是「正常返回 + aborted 标记」
      return { text: '（被中断）', usage: { totalTokens: 10 }, turns: 1, toolCalls: 0, aborted: true };
    }
    if (behavior.sleep) {
      await Promise.race([
        sleep(behavior.sleep),
        new Promise((r) => signal.addEventListener('abort', () => r(), { once: true })),
      ]);
    }
    if (behavior.throw) throw new Error(behavior.throw);
    return {
      text: behavior.text || `结论：${task.title}`,
      usage: { totalTokens: behavior.tokens === undefined ? 100 : behavior.tokens },
      turns: behavior.turns === undefined ? 2 : behavior.turns,
      toolCalls: behavior.toolCalls === undefined ? 1 : behavior.toolCalls,
    };
  };
  runner.calls = calls;
  return runner;
}

function makeManager(cfgPatch = {}, spec = {}) {
  const bus = new EventBus();
  const events = [];
  for (const name of ['task:spawned', 'task:progress', 'task:finished']) {
    bus.on(name, (p) =>
      events.push({ name, taskId: p.taskId, status: p.task && p.task.status, hasSession: !!p.session }),
    );
  }
  const runner = makeRunner(spec);
  const cfg = { cwd: ROOT, tasks: { ...TASK_DEFAULTS, subTimeoutSec: 60, ...cfgPatch } };
  const manager = new TaskManager({ cfg, bus, runSubtask: runner });
  return { manager, runner, events, bus };
}

const SESSION = { id: 'sess-1', cwd: ROOT };

/* ------------------------------------------------------------------ */

async function main() {
  console.log('\x1b[1m梦云 Agent —— 并行子任务调度器\x1b[0m');

  section('1. 拆分与并发池');

  await test('spawn 立刻返回，不等子任务跑完', async () => {
    const { manager } = makeManager({}, { default: { sleep: 30 } });
    const t0 = Date.now();
    const res = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, title: 'A', goal: '做事 A' });
    const cost = Date.now() - t0;
    assert(res.ok === true, `spawn 应该成功：${res.error}`);
    assert(res.task.id, '应该返回 taskId');
    assert(cost < 20, `spawn 必须立刻返回（实际 ${cost}ms）`);
    await manager.wait(undefined, { parentRunId: 'r1', timeoutMs: 2000 });
  });

  await test('并发上限：maxParallel=2 时第 3 个排队，不会一起开跑', async () => {
    const { manager, runner } = makeManager({ maxParallel: 2 }, { default: { sleep: 40 } });
    for (const n of ['A', 'B', 'C'])
      manager.spawn({ parentRunId: 'r1', parentSession: SESSION, title: n, goal: `做 ${n}` });
    await sleep(15);
    const stats = manager.stats('r1');
    assert(stats.running === 2, `同时应该只有 2 个在跑，实际 ${stats.running}`);
    assert(stats.queued === 1, `第 3 个应该在排队，实际 queued=${stats.queued}`);
    assert(runner.calls.length === 2, `执行器只应被调用 2 次，实际 ${runner.calls.length}`);
    await manager.wait(undefined, { parentRunId: 'r1', timeoutMs: 3000 });
    assert(manager.stats('r1').peakRunning === 2, '峰值并发应该是 2');
    assert(manager.stats('r1').done === 3, '最终三个都应该完成');
  });

  await test('一次拆太多会被拒绝（maxTasks）', async () => {
    const { manager } = makeManager({ maxTasks: 2 }, { default: { sleep: 10 } });
    assert(manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '一' }).ok, '第 1 个应该成功');
    assert(manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '二' }).ok, '第 2 个应该成功');
    const third = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '三' });
    assert(third.ok === false, '第 3 个应该被拒绝');
    assert(/最多拆 2 个/.test(third.error), `拒绝原因要说清上限：${third.error}`);
    await manager.wait(undefined, { parentRunId: 'r1', timeoutMs: 2000 });
  });

  await test('goal 为空会被拒绝（避免拆出一个没有目标的任务）', async () => {
    const { manager } = makeManager();
    const res = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, title: '空的', goal: '   ' });
    assert(res.ok === false && /goal/.test(res.error), `应该拒绝空 goal：${JSON.stringify(res)}`);
  });

  section('2. 深度限制');

  await test('子任务不能再拆子任务（maxDepth=1）', async () => {
    const { manager } = makeManager({ maxDepth: 1 });
    const parent = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '父层', depth: 0 });
    assert(parent.ok && parent.task.depth === 1, '子任务 depth 应该是 1');
    const grand = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '孙层', depth: 1 });
    assert(grand.ok === false, '孙任务必须被拒绝');
    assert(/最大拆分深度/.test(grand.error), `拒绝原因要可读：${grand.error}`);
    await manager.wait(undefined, { parentRunId: 'r1', timeoutMs: 2000 });
  });

  await test('maxDepth=2 时允许孙任务', async () => {
    const { manager } = makeManager({ maxDepth: 2 });
    const a = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '父', depth: 0 });
    const b = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '子', depth: 1 });
    const c = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '孙', depth: 2 });
    assert(a.ok && b.ok, '前两层应该可以');
    assert(c.ok === false, '第三层应该被拒绝（2 > maxDepth=2）');
    await manager.wait(undefined, { parentRunId: 'r1', timeoutMs: 2000 });
  });

  section('3. 收结果');

  await test('wait 不带 id 时收「这一轮拆出去的全部」，并带回摘要', async () => {
    const { manager } = makeManager({}, { default: { text: '我读完了三个文件' } });
    manager.spawn({ parentRunId: 'r1', parentSession: SESSION, title: '读 A', goal: '读 A' });
    manager.spawn({ parentRunId: 'r1', parentSession: SESSION, title: '读 B', goal: '读 B' });
    const res = await manager.wait(undefined, { parentRunId: 'r1', timeoutMs: 3000 });
    assert(res.tasks.length === 2, `应该收到 2 个，实际 ${res.tasks.length}`);
    assert(
      res.tasks.every((t) => t.status === 'done'),
      '两个都应该是 done',
    );
    assert(
      res.tasks.every((t) => t.summary.includes('我读完了')),
      '摘要要带回来',
    );
    assert(res.tasks[0].turns === 2 && res.tasks[0].tokens === 100, '轮数和 token 要记下来');
  });

  await test('wait 超时：返回值里如实说明「还有几个没结束」', async () => {
    const { manager } = makeManager({}, { default: { sleep: 200 } });
    manager.spawn({ parentRunId: 'r1', parentSession: SESSION, title: '慢的', goal: '慢' });
    const res = await manager.wait(undefined, { parentRunId: 'r1', timeoutMs: 30 });
    assert(res.tasks[0].status === 'running', `超时后状态应该还是 running，实际 ${res.tasks[0].status}`);
    assert(/还有 1 个子任务没结束/.test(res.note), `要有明确提示：${res.note}`);
    await manager.wait(undefined, { parentRunId: 'r1', timeoutMs: 2000 });
  });

  await test('子任务抛异常 → 状态 failed，错误进 summary，不会把调度器带崩', async () => {
    const { manager } = makeManager({}, { default: { throw: '读文件失败：没有权限' } });
    manager.spawn({ parentRunId: 'r1', parentSession: SESSION, title: '坏的', goal: '坏' });
    const res = await manager.wait(undefined, { parentRunId: 'r1', timeoutMs: 2000 });
    assert(res.tasks[0].status === 'failed', `状态应该 failed，实际 ${res.tasks[0].status}`);
    assert(/没有权限/.test(res.tasks[0].summary + res.tasks[0].error), '失败原因要留着');
    assert(manager.pendingCount('r1') === 0, '失败的任务不该继续占着');
  });

  section('4. 超时与中断');

  await test('超时会自己收掉子任务（不拖死父任务）', async () => {
    const { manager } = makeManager({ subTimeoutSec: 1 }, { default: { waitForever: true } });
    manager.spawn({ parentRunId: 'r1', parentSession: SESSION, title: '卡住了', goal: '卡' });
    const res = await manager.wait(undefined, { parentRunId: 'r1', timeoutMs: 5000 });
    assert(res.tasks[0].status === 'timeout', `应该被判为 timeout，实际 ${res.tasks[0].status}`);
    assert(/超时/.test(res.tasks[0].summary), `摘要要说明超时：${res.tasks[0].summary}`);
    assert(manager.pendingCount('r1') === 0, '超时之后不该还占着并发位');
  });

  await test('cancelAll：父任务中断 → 子任务一起停', async () => {
    const { manager } = makeManager({ maxParallel: 3 }, { default: { waitForever: true } });
    for (const n of ['A', 'B', 'C']) manager.spawn({ parentRunId: 'r1', parentSession: SESSION, title: n, goal: n });
    await sleep(20);
    assert(manager.pendingCount('r1') === 3, '三个都应该在跑');
    const n = manager.cancelAll('r1', 'parent_aborted');
    assert(n === 3, `应该收掉 3 个，实际 ${n}`);
    await sleep(20);
    assert(manager.pendingCount('r1') === 0, '中断之后不该还有活着的子任务');
    assert(manager.stats('r1').aborted === 3, '状态都应该是 aborted');
  });

  await test('cancel 单个：排队中的也能取消（不用等它开跑）', async () => {
    const { manager } = makeManager({ maxParallel: 1 }, { default: { sleep: 40 } });
    const a = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, title: 'A', goal: 'A' });
    const b = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, title: 'B', goal: 'B' });
    await sleep(10);
    const res = manager.cancel(b.task.id, 'model');
    assert(res.ok === true, '排队中的任务也应该能取消');
    assert(manager.view(manager.tasks.get(b.task.id)).status === 'aborted', '状态应该是 aborted');
    await manager.wait([a.task.id], { parentRunId: 'r1', timeoutMs: 2000 });
    assert(manager.pendingCount('r1') === 0, '最后不该有残留');
  });

  await test('父任务结束后（closeParent）不能再拆，防止跨轮串台', async () => {
    const { manager } = makeManager();
    manager.closeParent('r1', 'parent_gone');
    const res = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '再来一个' });
    assert(res.ok === false && /已经结束/.test(res.error), `应该拒绝：${JSON.stringify(res)}`);
    // 换一轮（新的 runId）必须恢复正常——同一会话的第二轮不能被上一轮影响
    const ok = manager.spawn({ parentRunId: 'r2', parentSession: SESSION, goal: '新一轮' });
    assert(ok.ok === true, `新一轮应该可以拆：${ok.error}`);
    await manager.wait(undefined, { parentRunId: 'r2', timeoutMs: 2000 });
  });

  await test('runId 换了，预算重新算（不会把上一轮的花费算到这一轮）', async () => {
    const { manager } = makeManager({}, { default: { tokens: 500 } });
    manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '一' });
    await manager.wait(undefined, { parentRunId: 'r1', timeoutMs: 2000 });
    manager.closeParent('r1');
    manager.spawn({ parentRunId: 'r2', parentSession: SESSION, goal: '二' });
    await manager.wait(undefined, { parentRunId: 'r2', timeoutMs: 2000 });
    assert(manager.stats('r2').tokens === 500, `第二轮应该只算自己的 500，实际 ${manager.stats('r2').tokens}`);
  });

  section('5. 预算');

  await test('token 预算用完 → 拒绝新的 spawn，并说清原因', async () => {
    const { manager } = makeManager({ budgetTokens: 500 }, { default: { tokens: 900 } });
    const a = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '一' });
    assert(a.ok, '第一个应该成功');
    await manager.wait([a.task.id], { parentRunId: 'r1', timeoutMs: 2000 });
    assert(manager.stats('r1').tokens === 900, `账要记上：${JSON.stringify(manager.stats('r1'))}`);
    const b = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '二' });
    assert(b.ok === false, '预算用完必须拒绝');
    assert(/token 预算/.test(b.error), `原因要可读：${b.error}`);
  });

  await test('跑到一半就超预算的任务会被就地收掉（不是等它跑完）', async () => {
    const { manager } = makeManager({ budgetTokens: 1000 }, { default: { waitForever: true } });
    const a = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '烧钱的' });
    const task = manager.tasks.get(a.task.id);
    await sleep(10);
    manager.progress(task, { turns: 2, tokens: 5000 });
    await sleep(20);
    assert(task.status === 'aborted', `超预算应该被收掉，实际 ${task.status}`);
    assert(/预算/.test(task.summary + task.activity.join(' ')), `要说明是预算问题：${task.summary}`);
  });

  await test('轮数预算用完 → 拒绝（budgetTurns）', async () => {
    const { manager } = makeManager({ budgetTurns: 2 }, { default: { turns: 2, tokens: 10 } });
    const a = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '一' });
    await manager.wait([a.task.id], { parentRunId: 'r1', timeoutMs: 2000 });
    const b = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '二' });
    assert(b.ok === false && /轮数预算/.test(b.error), `应该拒绝：${JSON.stringify(b)}`);
  });

  await test('单个子任务超过 subTurns 会被就地收掉', async () => {
    const { manager } = makeManager({ subTurns: 3 }, { default: { waitForever: true } });
    const a = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '话太多' });
    const task = manager.tasks.get(a.task.id);
    await sleep(10);
    manager.progress(task, { turns: 3, tokens: 20 });
    await sleep(20);
    assert(task.status === 'aborted', `超过轮数上限应该被收掉，实际 ${task.status}`);
    assert(
      task.activity.some((l) => /轮数上限/.test(l)),
      `活动记录里要说明原因：${JSON.stringify(task.activity)}`,
    );
  });

  section('6. 事件与视图');

  await test('事件都带父会话对象（Web 层靠它判断属于哪个会话）', async () => {
    const { manager, events } = makeManager({}, { default: { text: '好了' } });
    manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '一' });
    await manager.wait(undefined, { parentRunId: 'r1', timeoutMs: 2000 });
    assert(
      events.some((e) => e.name === 'task:spawned'),
      '应该发过 task:spawned',
    );
    assert(
      events.some((e) => e.name === 'task:finished'),
      '应该发过 task:finished',
    );
    assert(
      events.every((e) => e.hasSession),
      '每条事件都要带 session 对象',
    );
    assert(events.find((e) => e.name === 'task:finished').status === 'done', '结束事件里状态要是 done');
  });

  await test('view 不泄露内部字段（controller / promise / parentSession）', async () => {
    const { manager } = makeManager({}, { default: { sleep: 10 } });
    const res = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '一' });
    const keys = Object.keys(res.task);
    assert(!keys.includes('controller'), 'view 里不能有 controller');
    assert(!keys.includes('promise'), 'view 里不能有 promise');
    assert(!keys.includes('parentSession'), 'view 里不能带 session 对象');
    assert(keys.includes('summary') && keys.includes('activity'), 'view 要带界面上要用的字段');
    await manager.wait(undefined, { parentRunId: 'r1', timeoutMs: 2000 });
  });

  await test('activity 有上限，长任务不会把内存堆爆', async () => {
    const { manager } = makeManager({}, { default: { activity: 'x' } });
    const res = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '一' });
    const task = manager.tasks.get(res.task.id);
    for (let i = 0; i < 200; i += 1) manager.activity(task, `第 ${i} 行`);
    assert(task.activity.length <= 40, `activity 应该被截断，实际 ${task.activity.length}`);
    assert(task.activity[task.activity.length - 1].includes('199'), '截断时要保留最新的');
    await manager.wait(undefined, { parentRunId: 'r1', timeoutMs: 2000 });
  });

  section('7. 工具集掩码（子任务只读的落点）');

  await test('registry.clone 只放行白名单里的工具', async () => {
    const bus = new EventBus();
    const registry = new ToolRegistry({ tools: { deny: [], autoApprove: [] } }, bus);
    registry.register({
      name: 'read',
      description: '读',
      parameters: { type: 'object', properties: {} },
      run: async () => 'ok',
    });
    registry.register({
      name: 'write',
      description: '写',
      parameters: { type: 'object', properties: {} },
      run: async () => 'ok',
    });
    registry.register({
      name: 'shell',
      description: '跑命令',
      parameters: { type: 'object', properties: {} },
      run: async () => 'ok',
    });
    const child = registry.clone(['read']);
    assert(child.has('read'), '白名单里的工具要在');
    assert(!child.has('write'), 'write 不该出现在子任务的工具集里');
    assert(!child.has('shell'), 'shell 不该出现在子任务的工具集里');
    assert(child.list().length === 1, `子任务应该只看到 1 个工具，实际 ${child.list().length}`);
    // 主注册表不受影响：掩码只是「给子任务另一份视图」
    assert(registry.has('write') && registry.list().length === 3, '主注册表不该被改动');
  });

  await test('子任务拿到的是只读默认工具集（跟配置一致）', async () => {
    const { manager, runner } = makeManager({}, { default: { text: 'ok' } });
    manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '一' });
    await manager.wait(undefined, { parentRunId: 'r1', timeoutMs: 2000 });
    const got = runner.calls[0].allowTools;
    assert(
      JSON.stringify(got) === JSON.stringify(['read', 'glob', 'grep']),
      `默认应该是只读三件套，实际 ${JSON.stringify(got)}`,
    );
  });

  await test('显式 allow_tools 会透传给执行器', async () => {
    const { manager, runner } = makeManager({}, { default: { text: 'ok' } });
    manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '一', allowTools: ['read', 'write'] });
    await manager.wait(undefined, { parentRunId: 'r1', timeoutMs: 2000 });
    assert(JSON.stringify(runner.calls[0].allowTools) === JSON.stringify(['read', 'write']), '显式白名单要生效');
  });

  section('8. 装配细节');

  await test('enabled=false 时直接拒绝，并给出可执行的建议', async () => {
    const { manager } = makeManager({ enabled: false });
    const res = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '一' });
    assert(res.ok === false && /自己按顺序完成/.test(res.error), `应该拒绝并给建议：${res.error}`);
  });

  await test('没有装配执行器时拒绝（而不是抛异常）', async () => {
    const manager = new TaskManager({ cfg: { tasks: { ...TASK_DEFAULTS } } });
    const res = manager.spawn({ parentRunId: 'r1', parentSession: SESSION, goal: '一' });
    assert(res.ok === false && /执行器/.test(res.error), `应该优雅拒绝：${JSON.stringify(res)}`);
  });

  await test('静默 io 不打印任何东西（三个子任务同时跑也不会淹掉主输出）', async () => {
    const io = createSilentIO();
    const out = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      out.push(String(chunk));
      return orig(chunk, ...rest);
    };
    try {
      io.spinner().start();
      io.assistantDelta('这是一段不该出现的话');
      io.warn('警告也不该出现');
      io.toolCall('read', {});
      io.toolResult('read', {});
      io.dim('dim');
      io.log.ok('ok');
    } finally {
      process.stdout.write = orig;
    }
    assert(out.length === 0, `静默 io 不该写任何东西，实际写了：${out.join('')}`);
  });

  /* ---------------- 汇总 ---------------- */
  const passed = results.filter((r) => r.ok).length;
  console.log(
    `\n${failures === 0 ? '\x1b[32m\x1b[1m全部通过' : '\x1b[31m\x1b[1m有失败'}\x1b[0m：${passed} 项${failures ? ` / ${failures} 项失败` : ''}\n`,
  );
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error('测试自身出错：', err);
  process.exitCode = 1;
});
