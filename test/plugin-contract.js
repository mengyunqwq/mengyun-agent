'use strict';

/**
 * 插件接口契约测试
 *
 * 为什么单独一个套件：插件宿主是「可插拔」的卖点，但接口一直只有 README 上的散文。
 * 演化过程中最容易出的事是——宿主 ctx 上加了/改了成员，类型文件（types/plugin.d.ts）
 * 和文档没跟上，插件作者照文档写完却不生效，而且**不会有任何测试报错**。
 *
 * 这里不做「跑一遍插件」那种功能测试（那些在 selftest / web-e2e 里），
 * 只做一件事：把宿主**真正给出去的 ctx 成员**逐个和 types/plugin.d.ts 对上。
 * 以后谁在 makeContext 里加了东西忘了写类型，这个套件立刻红。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { PluginHost } = require(path.join(ROOT, 'src', 'plugins.js'));
const { EventBus, EVENTS } = require(path.join(ROOT, 'src', 'events.js'));
const { ToolRegistry } = require(path.join(ROOT, 'src', 'tools.js'));
const { loadConfig } = require(path.join(ROOT, 'src', 'config.js'));

let passed = 0;
const results = [];
const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    results.push({ name, ok: true });
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${err.message}\x1b[0m`);
  }
};

console.log('\n\x1b[1m\x1b[35m插件接口契约\x1b[0m\n');

const dtsPath = path.join(ROOT, 'types', 'plugin.d.ts');
const dts = fs.existsSync(dtsPath) ? fs.readFileSync(dtsPath, 'utf8') : '';

test('类型契约文件存在（types/plugin.d.ts）', () => {
  assert.ok(fs.existsSync(dtsPath), '缺少 types/plugin.d.ts——插件作者没有可用的类型提示');
  assert.ok(dts.length > 1500, `types/plugin.d.ts 内容太短（${dts.length} 字节），像是占位文件`);
  assert.ok(/export interface PluginContext/.test(dts), '缺少 PluginContext 接口');
  assert.ok(/export interface ToolDefinition/.test(dts), '缺少 ToolDefinition 接口');
  assert.ok(/export interface MyaPlugin/.test(dts), '缺少 MyaPlugin（插件导出对象）接口');
});

test('宿主 ctx 上的每个成员都写进了类型契约', () => {
  // 真起一个宿主，拿真实的 ctx（而不是从源码里正则猜）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-plugin-contract-'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ model: '', baseUrl: '' }));
  const cfg = loadConfig({ rootDir: tmp });
  const bus = new EventBus();
  const host = new PluginHost(cfg, bus, new ToolRegistry(cfg, bus), { log: () => {} });
  const ctx = host.makeContext({ name: 'contract-probe', version: '0.0.0', dir: tmp, state: {} });
  fs.rmSync(tmp, { recursive: true, force: true });

  const members = Object.keys(ctx);
  assert.ok(members.length >= 15, `ctx 成员太少（${members.length} 个），可能没拿到真实上下文`);
  const missing = members.filter((k) => !new RegExp(`\\b${k}\\s*[:(]`).test(dts));
  assert.strictEqual(
    missing.length,
    0,
    `这些 ctx 成员在 types/plugin.d.ts 里没有声明：${missing.join(', ')}\n` +
      '      在 src/plugins.js 的 makeContext 里加了成员，就要同步补类型',
  );
});

test('所有钩子事件名都在类型契约里（EVENTS 是唯一真相）', () => {
  const missing = EVENTS.filter((name) => !dts.includes(`'${name}'`));
  assert.strictEqual(missing.length, 0, `这些事件没有写进类型：${missing.join(', ')}`);
});

test('工具定义里那些「会影响行为」的字段都声明了', () => {
  // 这些字段宿主真的在用：漏掉任何一个，插件作者都会「写了不生效」
  const usedByHost = [
    'name',
    'description',
    'parameters',
    'aliases',
    'tags',
    'autoApprove',
    'needsConfirm',
    'dangerous',
    'needsConfirmation',
    'run',
  ];
  const missing = usedByHost.filter((k) => !new RegExp(`\\b${k}\\??\\s*[:)]`).test(dts));
  assert.strictEqual(missing.length, 0, `ToolDefinition 缺字段：${missing.join(', ')}`);
});

test('类型契约里说明「插件不是沙箱」这件事', () => {
  // 权限只是声明 + 告警，不是沙箱——这条必须让插件作者在自己的编辑器里就看到
  assert.ok(/沙箱|告警/.test(dts), '类型契约里没有说明 permissions 只是声明（容易被误当成沙箱）');
});

test('jsconfig.json 让插件作者能直接获得类型提示', () => {
  const jsconfigPath = path.join(ROOT, 'jsconfig.json');
  assert.ok(fs.existsSync(jsconfigPath), '缺少 jsconfig.json');
  const jsconfig = JSON.parse(fs.readFileSync(jsconfigPath, 'utf8'));
  const include = JSON.stringify(jsconfig.include || []);
  assert.ok(include.includes('types'), 'jsconfig.json 没有把 types/ 纳入');
});

const failed = results.filter((r) => !r.ok);
console.log('\n' + '─'.repeat(52));
if (failed.length) {
  console.log(`\x1b[31m\x1b[1m${failed.length} 项失败 / 共 ${results.length} 项\x1b[0m`);
  process.exitCode = 1;
} else {
  console.log(`\x1b[32m\x1b[1m全部通过：${passed} 项\x1b[0m`);
}
