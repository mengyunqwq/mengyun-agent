'use strict';

/**
 * 结构化日志测试
 *
 * 这个套件盯的是「出问题时能不能查」——日志本身坏掉（把密钥写进去、
 * 把程序搞崩、级别过滤不生效、轮转把最新日志删了）比没有日志更糟。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { Logger, createLogger, redact, mask, MAX_BYTES } = require(path.join(ROOT, 'src', 'logger.js'));

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

console.log('\n\x1b[1m\x1b[35m结构化日志\x1b[0m\n');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-log-'));
const readLines = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

test('落盘格式是 JSON Lines（一行一条，可被机器直接读）', () => {
  const dir = path.join(tmpRoot, 'basic');
  const log = new Logger({ name: 'test', dir, console: false });
  log.info('第一条', { session: 'abc', turn: 1 });
  log.warn('第二条');
  const lines = readLines(log.file);
  assert.strictEqual(lines.length, 2, `应该写了两行，实际 ${lines.length}`);
  assert.strictEqual(lines[0].level, 'info');
  assert.strictEqual(lines[0].logger, 'test');
  assert.strictEqual(lines[0].msg, '第一条');
  assert.strictEqual(lines[0].session, 'abc');
  assert.strictEqual(lines[1].level, 'warn');
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(lines[0].ts), `时间戳格式不对：${lines[0].ts}`);
});

test('级别过滤：低于阈值的级别不落盘', () => {
  const dir = path.join(tmpRoot, 'level');
  const log = new Logger({ name: 'test', dir, level: 'warn', console: false });
  log.debug('不该出现');
  log.info('也不该出现');
  log.warn('该出现');
  log.error('也该出现');
  const lines = readLines(log.file);
  assert.strictEqual(lines.length, 2, `只应有 warn/error 两条，实际 ${lines.length}`);
  assert.ok(lines.every((l) => ['warn', 'error'].includes(l.level)));
  assert.strictEqual(log.levelName, 'warn');
});

test('敏感字段自动脱敏（密钥不落日志）', () => {
  const secret = 'sk-live-abcdefghijklmnop';
  const out = redact({
    apiKey: secret,
    Authorization: secret,
    nested: { token: secret, ok: 'visible' },
    list: [{ password: secret }],
    normal: 'visible-普通字段',
  });
  assert.notStrictEqual(out.apiKey, secret, 'apiKey 没有被脱敏');
  // 只看「该脱敏的那几处」：把它们的值单独拎出来确认不含原文
  const masked = [out.apiKey, out.Authorization, out.nested.token, out.list[0].password].join('|');
  assert.ok(!masked.includes(secret), `脱敏后的值里仍然有原文：${masked}`);
  assert.strictEqual(out.normal, 'visible-普通字段', '普通字段不该被无差别打码');
  assert.strictEqual(out.nested.ok, 'visible');
  assert.ok(/^.{4}\*\*\*.{2}$/.test(out.apiKey), `打码格式不像掩码：${out.apiKey}`);
  assert.strictEqual(mask('short'), '***');
});

test('超长字符串会被截断（避免一条日志把文件撑爆）', () => {
  const out = redact({ big: 'x'.repeat(5000) });
  assert.ok(out.big.length < 2100, `应该被截断，实际 ${out.big.length}`);
  assert.ok(/截断/.test(out.big));
});

test('tail(n) 读最近 n 条，倒序返回', () => {
  const dir = path.join(tmpRoot, 'tail');
  const log = new Logger({ name: 'test', dir, console: false });
  for (let i = 1; i <= 30; i += 1) log.info(`第 ${i} 条`);
  const tail = log.tail(5);
  assert.strictEqual(tail.length, 5);
  assert.strictEqual(tail[0].msg, '第 30 条', `最新的应该在第一条：${tail[0].msg}`);
  assert.strictEqual(tail[4].msg, '第 26 条');
});

test('日志写不进去也不能把程序搞崩（错误只计数）', () => {
  // 把一个真实文件当成目录用：mkdirSync/write 一定会失败
  const filePath = path.join(tmpRoot, 'not-a-dir');
  fs.writeFileSync(filePath, 'x');
  const log = new Logger({ name: 'test', dir: filePath, console: false });
  assert.doesNotThrow(() => {
    log.info('这条写不进去');
    log.error('这条也写不进去');
  });
  assert.strictEqual(log.tail(5).length, 0);
  assert.ok(log.file.endsWith('mya.log'));
});

test('record() 只落盘、不打控制台（避免控制台出现两份）', () => {
  const dir = path.join(tmpRoot, 'fileonly');
  const log = new Logger({ name: 'test', dir, console: true, level: 'info' });
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return true;
  };
  try {
    log.record('info', '只进文件');
    log.info('两边都要');
  } finally {
    process.stdout.write = original;
  }
  const consoleText = written.join('');
  assert.ok(!consoleText.includes('只进文件'), `record() 不该打控制台：${consoleText}`);
  assert.ok(consoleText.includes('两边都要'), 'info() 应该打控制台');
  const lines = readLines(log.file);
  assert.ok(
    lines.some((l) => l.msg === '只进文件'),
    'record() 必须落盘',
  );
  assert.ok(lines.some((l) => l.msg === '两边都要'));
});

test('超过上限会轮转，且不丢最新日志', () => {
  const dir = path.join(tmpRoot, 'rotate');
  const log = new Logger({ name: 'test', dir, console: false });
  const filler = 'y'.repeat(1024);
  // 写到超过 MAX_BYTES 一点，触发一次轮转
  const rounds = Math.ceil(MAX_BYTES / filler.length) + 4;
  for (let i = 0; i < rounds; i += 1) log.info('填满', { i, filler });
  log.info('轮转之后最新的一条');
  assert.ok(fs.existsSync(`${log.file}.1`), '应该产生了轮转文件 mya.log.1');
  const latest = log.tail(1)[0];
  assert.strictEqual(latest.msg, '轮转之后最新的一条', `最新日志应该还在：${latest && latest.msg}`);
  assert.ok(fs.statSync(log.file).size < MAX_BYTES, '轮转后当前文件应该小于上限');
});

test('child() 派生日志器共享文件、名字带前缀', () => {
  const dir = path.join(tmpRoot, 'child');
  const root = new Logger({ name: 'mya', dir, console: false });
  const child = root.child('web');
  child.info('来自 web');
  const lines = readLines(root.file);
  assert.strictEqual(lines[0].logger, 'mya/web');
  assert.strictEqual(child.file, root.file);
});

test('createLogger 默认落在「工作目录/.mya/logs」里（不会污染仓库根）', () => {
  const fakeCfg = { cwd: path.join(tmpRoot, 'ws'), dataDir: path.join(tmpRoot, 'ws') };
  const log = createLogger(fakeCfg, { console: false });
  assert.strictEqual(log.file, path.join(fakeCfg.cwd, '.mya', 'logs', 'mya.log'));
  assert.ok(log.file.includes(`${path.sep}.mya${path.sep}logs${path.sep}`), `路径不对：${log.file}`);
});

test('enabled() 能省掉拼字符串的开销', () => {
  const log = new Logger({ name: 'test', dir: path.join(tmpRoot, 'enabled'), level: 'info', console: false });
  assert.strictEqual(log.enabled('error'), true);
  assert.strictEqual(log.enabled('info'), true);
  assert.strictEqual(log.enabled('debug'), false);
});

fs.rmSync(tmpRoot, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log('\n' + '─'.repeat(52));
if (failed.length) {
  console.log(`\x1b[31m\x1b[1m${failed.length} 项失败 / 共 ${results.length} 项\x1b[0m`);
  process.exitCode = 1;
} else {
  console.log(`\x1b[32m\x1b[1m全部通过：${passed} 项\x1b[0m`);
}
