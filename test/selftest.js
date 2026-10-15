'use strict';

/**
 * 梦云 Agent —— 自测脚本
 *
 * 全部离线运行，不需要 API Key、不需要联网。
 * 用法：node test/selftest.js   或   npm run selftest
 *
 * 它做的事：把核心模块挨个拉起来验一遍，
 * 所以每次改完代码跑一下，就能知道自己有没有改坏东西。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'mya.js');

/* ------------------------------------------------------------------ */
/* 迷你测试框架                                                        */
/* ------------------------------------------------------------------ */

const results = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[36m▌ ${name}\x1b[0m`);
}

async function test(name, fn) {
  try {
    await fn();
    results.push({ group: currentGroup, name, ok: true });
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    results.push({ group: currentGroup, name, ok: false, error: err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${err.message}\x1b[0m`);
    if (process.env.MYA_DEBUG) console.log(err.stack);
  }
}

/* ------------------------------------------------------------------ */
/* 临时环境                                                            */
/* ------------------------------------------------------------------ */

/** 建一个临时项目目录，避免污染真实工作区 */
function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-test-'));
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'tmp', version: '0.0.0' }));
  return dir;
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 偶尔会锁文件，忽略 */
  }
}

/** 保存并清空相关环境变量，测完再还原 */
function withCleanEnv(names, fn) {
  const saved = {};
  for (const n of names) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  try {
    return fn();
  } finally {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  }
}

const ENV_KEYS = [
  'MYA_PROVIDER', 'MYA_API_KEY', 'MYA_BASE_URL', 'MYA_MODEL', 'MYA_STREAM',
  'MYA_MAX_TURNS', 'MYA_TEMPERATURE', 'MYA_TIMEOUT', 'MYA_YES', 'MYA_LANG',
  'MYA_ALLOW_DANGEROUS', 'MYA_TAVILY_KEY', 'MYA_PLUGIN_DIRS', 'MYA_DATA_DIR',
  'MYA_SYSTEM_PROMPT_FILE', 'MYA_TOOLS_AUTO_APPROVE', 'MYA_TOOLS_DENY',
];

/* ------------------------------------------------------------------ */
/* 1. 配置系统                                                         */
/* ------------------------------------------------------------------ */

async function testConfig() {
  const { loadConfig, parseEnvText, parseList, parseBool, deepMerge } = require(path.join(ROOT, 'src', 'config.js'));

  group('1. 配置系统');

  await test('.env 文本解析：注释 / 引号 / export 前缀', () => {
    const env = parseEnvText(`
# 这是注释
MYA_API_KEY=sk-abc123
export MYA_MODEL=deepseek-chat
MYA_BASE_URL="https://api.deepseek.com/v1"   # 行尾注释
QUOTED='单引号值'
EMPTY=
WITH_COMMENT=value # 注释
    `);
    assert.strictEqual(env.MYA_API_KEY, 'sk-abc123');
    assert.strictEqual(env.MYA_MODEL, 'deepseek-chat');
    assert.strictEqual(env.MYA_BASE_URL, 'https://api.deepseek.com/v1');
    assert.strictEqual(env.QUOTED, '单引号值');
    assert.strictEqual(env.EMPTY, '');
    assert.strictEqual(env.WITH_COMMENT, 'value');
  });

  await test('布尔/列表解析容错', () => {
    assert.strictEqual(parseBool('1'), true);
    assert.strictEqual(parseBool('false'), false);
    assert.strictEqual(parseBool('乱写'), undefined);
    assert.deepStrictEqual(parseList('a, b ,c'), ['a', 'b', 'c']);
    assert.deepStrictEqual(parseList(['x', ' y ']), ['x', 'y']);
    assert.deepStrictEqual(parseList(''), []);
  });

  await test('深合并：对象递归、数组替换、跳过 $ 注释键', () => {
    const merged = deepMerge(
      { a: 1, nested: { x: 1, y: 2 }, list: [1, 2, 3] },
      { $注释: '忽略我', nested: { y: 99 }, list: [9] },
    );
    assert.strictEqual(merged.a, 1);
    assert.deepStrictEqual(merged.nested, { x: 1, y: 99 });
    assert.deepStrictEqual(merged.list, [9]);
    assert.strictEqual(merged.$注释, undefined);
  });

  await test('分层覆盖：默认 < config.json < 环境变量', () => {
    const dir = makeTempProject();
    try {
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({ model: '来自文件', temperature: 0.9, maxTurns: 7 }),
      );
      withCleanEnv(ENV_KEYS, () => {
        process.env.MYA_MODEL = '来自环境变量';
        const cfg = loadConfig({ rootDir: dir });
        assert.strictEqual(cfg.model, '来自环境变量', '环境变量应覆盖 config.json');
        assert.strictEqual(cfg.temperature, 0.9, 'config.json 应覆盖默认值');
        assert.strictEqual(cfg.maxTurns, 7);
        assert.strictEqual(cfg.provider, 'deepseek', '未指定时应落到默认值');
      });
    } finally {
      cleanup(dir);
    }
  });

  /* ---- 配置目录：打包版不能往只读的 asar 里写 ---- */

  await test('config.local.json 真的参与分层（被忽略但以前没人读，等于骗人的配置项）', () => {
    const dir = makeTempProject();
    try {
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({ model: '可以提交的默认值', temperature: 0.4, maxTurns: 9 }),
      );
      fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({ model: '我本机的网关模型' }));
      withCleanEnv(ENV_KEYS, () => {
        const cfg = loadConfig({ rootDir: dir });
        assert.strictEqual(cfg.model, '我本机的网关模型', 'config.local.json 应覆盖 config.json');
        assert.strictEqual(cfg.temperature, 0.4, '没被本地覆盖的字段要保留');
        assert.strictEqual(cfg.maxTurns, 9, '同上');
        // 环境变量仍然是最高优先级
        process.env.MYA_MODEL = '环境变量说了算';
        const cfg2 = loadConfig({ rootDir: dir });
        assert.strictEqual(cfg2.model, '环境变量说了算', '环境变量必须压过本地覆盖');
      });
    } finally {
      cleanup(dir);
    }
  });

  await test('config.local.json 写坏了只是忽略这一层，不能把启动搞崩', () => {
    const dir = makeTempProject();
    try {
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ model: '好的那份' }));
      fs.writeFileSync(path.join(dir, 'config.local.json'), '{ 这不是合法 JSON');
      withCleanEnv(ENV_KEYS, () => {
        const cfg = loadConfig({ rootDir: dir });
        assert.strictEqual(cfg.model, '好的那份', '坏掉的本机覆盖层应该被跳过');
      });
    } finally {
      cleanup(dir);
    }
  });

  await test('MYA_CONFIG_DIR 指定配置目录时优先用它', () => {
    const dir = makeTempProject();
    const previous = process.env.MYA_CONFIG_DIR;
    try {
      fs.writeFileSync(
        path.join(dir, 'config.json'),
        JSON.stringify({ provider: 'custom', baseUrl: 'https://from-config-dir/v1', model: 'm-in-dir' }),
      );
      process.env.MYA_CONFIG_DIR = dir;
      withCleanEnv(ENV_KEYS, () => {
        const cfg = loadConfig();
        // 核心行为：配置目录被采纳，且配置确实是从这里读的
        assert.strictEqual(cfg.rootDir, dir, 'rootDir 应是 MYA_CONFIG_DIR');
        assert.strictEqual(cfg.model, 'm-in-dir', '应读到该目录里的 config.json');
        // 数据/会话目录绝不能落到只读的 asar 里（这才是这个 bug 的本质）
        assert.ok(!/app\.asar/i.test(cfg.dataDir), `数据目录不能落到 asar：${cfg.dataDir}`);
        assert.ok(!/app\.asar/i.test(cfg.session.dir), `会话目录不能落到 asar：${cfg.session.dir}`);
        assert.strictEqual(cfg.dataDir, path.join(dir, '.mya'), '数据目录应挂在配置目录下');
      });
    } finally {
      if (previous === undefined) delete process.env.MYA_CONFIG_DIR;
      else process.env.MYA_CONFIG_DIR = previous;
      cleanup(dir);
    }
  });

  await test('能识别 asar 内路径与不可写目录', () => {
    const { isInsideAsar, isWritableDir } = require(path.join(ROOT, 'src', 'config.js'));
    // 打包后程序目录就是这种形状，往里写必然 ENOENT
    assert.ok(isInsideAsar('C:\\app\\resources\\app.asar'), 'Windows 反斜杠路径要能认出来');
    assert.ok(isInsideAsar('/opt/app/resources/app.asar/config.json'));
    assert.ok(!isInsideAsar('C:\\projects\\梦云Agent'), '普通目录不能被误判');

    const dir = makeTempProject();
    try {
      assert.ok(isWritableDir(dir), '能写的目录应返回 true');
    } finally {
      cleanup(dir);
    }
    assert.strictEqual(isWritableDir('C:\\不存在的目录\\mya-x'), false, '写不进去要返回 false');
  });

  await test('程序目录不可写时自动回退到用户目录（不会写进 asar）', () => {
    const { resolveConfigDir } = require(path.join(ROOT, 'src', 'config.js'));
    const previous = process.env.MYA_CONFIG_DIR;
    try {
      // 用一个必然不可写的路径冒充「程序目录」是不行的（findRootDir 从 __dirname 找），
      // 所以这里直接验证「不设 MYA_CONFIG_DIR 时也不会落到 asar 里」
      delete process.env.MYA_CONFIG_DIR;
      const dir = resolveConfigDir();
      assert.ok(!/app\.asar/i.test(dir), `配置目录绝不能在 asar 里：${dir}`);
      assert.ok(path.isAbsolute(dir), '应该是绝对路径');
      assert.ok(fs.existsSync(dir), `配置目录应该已经被创建：${dir}`);
    } finally {
      if (previous !== undefined) process.env.MYA_CONFIG_DIR = previous;
    }
  });

  await test('provider 预设能自动补全 baseUrl 与 model', () => {    const dir = makeTempProject();
    try {
      fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ provider: 'ollama' }));
      withCleanEnv(ENV_KEYS, () => {
        const cfg = loadConfig({ rootDir: dir });
        assert.strictEqual(cfg.baseUrl, 'http://127.0.0.1:11434/v1');
        assert.ok(cfg.model.includes('qwen'), `ollama 默认模型不对：${cfg.model}`);
        assert.strictEqual(cfg.apiKey, 'ollama', '本地服务应自动给占位 key');
      });
    } finally {
      cleanup(dir);
    }
  });

  await test('config.json 损坏时不崩溃，回退默认值', () => {
    const dir = makeTempProject();
    const originalError = console.error;
    console.error = () => {}; // 静音预期中的告警
    try {
      fs.writeFileSync(path.join(dir, 'config.json'), '{ 这不是合法 JSON');
      withCleanEnv(ENV_KEYS, () => {
        const cfg = loadConfig({ rootDir: dir });
        assert.strictEqual(cfg.maxTurns, 25);
      });
    } finally {
      console.error = originalError;
      cleanup(dir);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 2. 工具函数                                                         */
/* ------------------------------------------------------------------ */

async function testUtils() {
  const u = require(path.join(ROOT, 'src', 'utils.js'));
  group('2. 工具函数');

  await test('truncate 保留头尾并标注省略量', () => {
    const out = u.truncate(`START${'a'.repeat(1000)}END`, 100);
    assert.ok(out.length < 400, '截断后不应该还很长');
    assert.ok(out.includes('省略'), `缺少省略说明：${out.slice(0, 120)}`);
    assert.ok(out.startsWith('START'), '应保留开头');
    assert.ok(out.endsWith('END'), '应保留结尾');
  });

  await test('resolvePath 阻止越出工作目录', () => {
    const cwd = path.join(ROOT, 'src');
    assert.strictEqual(u.resolvePath('config.js', cwd, true), path.join(cwd, 'config.js'));
    assert.throws(() => u.resolvePath('../../etc/passwd', cwd, true), /越出工作目录/);
    // 关闭限制时可以越界
    assert.ok(u.resolvePath('../package.json', cwd, false).endsWith('package.json'));
  });

  await test('glob 转正则：** 跨目录、* 单层、? 单字符', () => {
    assert.ok(u.globToRegExp('src/**/*.js').test('src/a/b/c.js'));
    assert.ok(u.globToRegExp('src/**/*.js').test('src/a.js'));
    assert.ok(!u.globToRegExp('*.js').test('src/a.js'), '* 不应跨目录');
    assert.ok(u.globToRegExp('a?.js').test('ab.js'));
    assert.ok(!u.globToRegExp('a?.js').test('abc.js'));
  });

  await test('isIgnored 默认忽略 node_modules / .git', () => {
    assert.ok(u.isIgnored('node_modules/foo/index.js'));
    assert.ok(u.isIgnored('.git/config'));
    assert.ok(!u.isIgnored('src/index.js'));
  });

  await test('closest 能做「你是不是想用 X」纠错', () => {
    const hit = u.closest('reed', ['read', 'write', 'edit', 'glob']);
    assert.deepStrictEqual(hit, ['read']);
  });

  await test('humanSize / humanMs 可读化', () => {
    assert.strictEqual(u.humanSize(0), '0B');
    assert.strictEqual(u.humanSize(2048), '2.0KB');
    assert.strictEqual(u.humanMs(500), '500ms');
    assert.strictEqual(u.humanMs(2500), '2.5s');
  });
}

/* ------------------------------------------------------------------ */
/* 3. 工具注册表                                                       */
/* ------------------------------------------------------------------ */

async function testRegistry() {
  const { ToolRegistry, validateArgs } = require(path.join(ROOT, 'src', 'tools.js'));
  const { EventBus } = require(path.join(ROOT, 'src', 'events.js'));
  group('2.5 git 检查点（改动前自动打点，崩了能回去）');

  const ckpt = require(path.join(ROOT, 'src', 'checkpoint.js'));
  const gitBin = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  const hasGit = !gitBin.error && gitBin.status === 0;
  const runGit = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).stdout.trim();
  const makeRepo = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-ckpt-'));
    runGit(dir, ['init', '-q']);
    runGit(dir, ['config', 'user.email', 'selftest@local']);
    runGit(dir, ['config', 'user.name', 'selftest']);
    fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 1;\n');
    runGit(dir, ['add', '-A']);
    runGit(dir, ['commit', '-qm', 'init']);
    return dir;
  };
  const skipGit = (name) => console.log(`  ${name} —— 环境里没有 git，跳过`);

  await test('检查点：不碰 HEAD / 暂存区 / 工作区 / 用户历史', () => {
    if (!hasGit) return skipGit('检查点不变量');
    const dir = makeRepo();
    try {
      // 故意把工作区弄成脏状态（改一个 + 暂存一个 + 一个未跟踪）
      fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 2; // 脏\n');
      fs.writeFileSync(path.join(dir, 'staged.js'), '// 已暂存\n');
      runGit(dir, ['add', 'staged.js']);
      fs.writeFileSync(path.join(dir, 'untracked.js'), '// 未跟踪\n');
      const snap = () => ({
        head: runGit(dir, ['rev-parse', 'HEAD']),
        status: runGit(dir, ['status', '--porcelain']),
        staged: runGit(dir, ['diff', '--cached', '--name-only']),
        reflog: runGit(dir, ['reflog', '--format=%H']),
      });
      const before = snap();
      const ck = ckpt.createCheckpoint(dir, { label: '改 a.js', sessionId: 'sess-1' });
      const after = snap();
      assert.ok(ck.ok, `打点应成功：${ck.reason || ''}`);
      assert.ok(/^refs\/mya\/checkpoints\/\d{14}-[0-9a-f]{7}$/.test(ck.ref), `ref 命名要干净：${ck.ref}`);
      assert.strictEqual(before.head, after.head, '打点不能动 HEAD');
      assert.strictEqual(before.status, after.status, '打点不能改工作区状态');
      assert.strictEqual(before.staged, after.staged, '打点不能动暂存区');
      assert.strictEqual(before.reflog, after.reflog, '打点不能往用户的历史里写东西');
      assert.ok(ck.files.includes('untracked.js'), `未跟踪文件也要进检查点：${ck.files.join(',')}`);
      assert.ok(ck.files.includes('a.js'), '已跟踪的改动也要在');
      assert.ok(/file|files|insertion|deletion/.test(ck.summary), `应当给出改动概览：${ck.summary}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('检查点：尊重 .gitignore（不把噪声文件塞进去）', () => {
    if (!hasGit) return skipGit('检查点 gitignore');
    const dir = makeRepo();
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), 'noise/\n*.log\n');
      fs.mkdirSync(path.join(dir, 'noise'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'noise', 'big.bin'), 'x'.repeat(100));
      fs.writeFileSync(path.join(dir, 'debug.log'), 'debug\n');
      fs.writeFileSync(path.join(dir, 'src.js'), '// 真的源码\n');
      const ck = ckpt.createCheckpoint(dir, { label: 'gitignore' });
      assert.ok(ck.ok, '打点应成功');
      assert.ok(ck.files.includes('src.js'), '未忽略的文件要在');
      assert.ok(!ck.files.some((f) => f.startsWith('noise/')), `被忽略的目录不该进：${ck.files.join(',')}`);
      assert.ok(!ck.files.includes('debug.log'), '被忽略的文件不该进');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('检查点：能回滚（边界：回滚后新建的文件不会被删）', () => {
    if (!hasGit) return skipGit('检查点回滚');
    const dir = makeRepo();
    try {
      const ck = ckpt.createCheckpoint(dir, { label: '回滚前' });
      assert.ok(ck.ok, '打点应成功');
      fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 999; // 被改坏\n');
      fs.writeFileSync(path.join(dir, 'after.js'), '// 打点之后新建的\n');
      const res = ckpt.restoreCheckpoint(dir, ck.ref);
      assert.ok(res.ok, `回滚应成功：${res.reason || ''}`);
      assert.strictEqual(fs.readFileSync(path.join(dir, 'a.js'), 'utf8').replace(/\r\n/g, '\n'), 'const a = 1;\n', '文件内容要恢复');
      // 已知边界：restore 只恢复 ref 里存在的路径，不负责删新文件——这条要保证"如实地按设计走"
      assert.ok(fs.existsSync(path.join(dir, 'after.js')), '回滚后新建的文件应当还在（已知边界）');
      assert.strictEqual(runGit(dir, ['rev-parse', 'HEAD']), runGit(dir, ['rev-parse', `${ck.ref}^`]), '回滚不能移动 HEAD');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('检查点：不是 git 仓库时安静跳过（不抛异常，也不偷偷 git init）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-nogit-'));
    try {
      const ck = ckpt.createCheckpoint(dir, { label: 'x' });
      assert.strictEqual(ck.ok, false, '不是仓库应当返回 ok:false');
      assert.ok(['not-a-repo', 'no-git'].includes(ck.reason), `reason 要可读：${ck.reason}`);
      assert.strictEqual(fs.existsSync(path.join(dir, '.git')), false, '绝不能替用户 git init');
      assert.strictEqual(ckpt.listCheckpoints(dir).length, 0, '列不出来任何东西');
      assert.strictEqual(ckpt.restoreCheckpoint(dir, 'HEAD').ok, false, '不是仓库时回滚也要安静失败');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('检查点：只保留最近 N 个（ref 攒多了会拖慢遍历）', async () => {
    if (!hasGit) return skipGit('检查点清理');
    const dir = makeRepo();
    try {
      for (let i = 0; i < 5; i += 1) {
        fs.writeFileSync(path.join(dir, 'a.js'), `const a = ${i};\n`);
        const ck = ckpt.createCheckpoint(dir, { label: `第 ${i} 次` });
        assert.ok(ck.ok, `第 ${i} 次打点应成功：${ck.reason || ''}`);
        // ref 名带秒级时间戳：同秒内打多个点会撞名，所以等一秒（这是 ref 设计的已知代价）
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 1100));
      }
      assert.strictEqual(ckpt.listCheckpoints(dir, 99).length, 5, '应该有 5 个');
      const removed = ckpt.pruneCheckpoints(dir, 2);
      assert.strictEqual(removed, 3, `应当清掉 3 个旧点，实际 ${removed}`);
      assert.strictEqual(ckpt.listCheckpoints(dir, 99).length, 2, '只留最近 2 个');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('检查点：show 能列出改动的文件（M/A/D + 状态）', () => {
    if (!hasGit) return skipGit('检查点 show');
    const dir = makeRepo();
    try {
      const ck = ckpt.createCheckpoint(dir, { label: 'show' });
      assert.ok(ck.ok, '打点应成功');
      fs.writeFileSync(path.join(dir, 'a.js'), 'const a = 42;\n');
      fs.writeFileSync(path.join(dir, 'b.js'), '// 新增\n');
      const ck2 = ckpt.createCheckpoint(dir, { label: 'show2' });
      const diff = ckpt.checkpointDiff(dir, ck2.ref);
      const paths = diff.files.map((f) => f.path);
      assert.ok(paths.includes('b.js'), `新增文件要出现：${paths.join(',')}`);
      assert.ok(diff.stat.includes('file'), `要有统计行：${diff.stat}`);
      const files = ckpt.checkpointFiles(dir, ck.ref);
      assert.ok(files.includes('a.js'), 'checkpointFiles 要能列出内容');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  group('2.6 改动预览（diff）');

  const { diffLines, formatDiff } = require(path.join(ROOT, 'src', 'diff.js'));

  await test('diff：单行修改、纯新增、没变化 三种基本形状', () => {
    const one = diffLines('a\nb\nc\n', 'a\nB\nc\n');
    assert.strictEqual(one.added, 1);
    assert.strictEqual(one.removed, 1);
    const f = formatDiff('a\nb\nc\n', 'a\nB\nc\n', { path: 'x.txt' });
    assert.ok(f.text.includes('- b') && f.text.includes('+ B'), `要有 -/+ 行：\n${f.text}`);
    assert.ok(f.text.includes('+1 行  -1 行'), `标题要有统计：${f.text.split('\n')[0]}`);

    const created = formatDiff('', 'line1\nline2\n', { path: 'new.txt' });
    assert.strictEqual(created.added, 2, '新文件应当全是 +，且不因为末尾换行多出一行');

    const same = formatDiff('same\n', 'same\n');
    assert.ok(same.text.includes('没有变化'), `内容没变要说清楚：${same.text}`);
  });

  await test('diff：两万行文件改一行要快，且只显示改动附近', () => {
    const big = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join('\n');
    const changed = big.replace('line 10000', 'LINE 10000 CHANGED');
    const t0 = Date.now();
    const f = formatDiff(big, changed, { context: 3 });
    const ms = Date.now() - t0;
    assert.ok(ms < 300, `2 万行改一行不该要 ${ms}ms（先掐公共首尾是关键）`);
    assert.ok(f.text.split('\n').length < 20, `输出应当很短，实际 ${f.text.split('\n').length} 行`);
    assert.strictEqual(f.added, 1);
    assert.strictEqual(f.removed, 1);
  });

  await test('diff：整段重写退化成整段替换，而不是卡死或假装完美', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n');
    const b = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n');
    const r = diffLines(a, b);
    assert.strictEqual(r.degraded, true, '超过 DP 上限应当走退化路径');
    const f = formatDiff(a, b, { maxLines: 40 });
    assert.ok(/还有 \d+ 行没显示/.test(f.text), `限行时要如实说还有多少：${f.text.split('\n').slice(-1)[0]}`);
  });

  await test('diff：CRLF 与 LF 视为同一份内容（否则 Windows 上全是假改动）', () => {
    const r = diffLines('a\r\nb\r\n', 'a\nb\n');
    assert.strictEqual(r.added, 0);
    assert.strictEqual(r.removed, 0);
    const indent = diffLines('  x\n', '    x\n');
    assert.strictEqual(indent.added, 1, '缩进变了要算改动');
  });

  await test('确认闸门会把 diff 作为 detail 递给用户（write/edit）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-preview-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.js'), 'function f() {\n  return 1;\n}\n');
      const { ToolRegistry } = require(path.join(ROOT, 'src', 'tools.js'));
      const { EventBus } = require(path.join(ROOT, 'src', 'events.js'));
      const { builtinTools } = require(path.join(ROOT, 'src', 'tools', 'builtin.js'));
      const reg = new ToolRegistry(
        { cwd: dir, approval: { mode: 'ask' }, tools: { autoApprove: [], deny: [] }, shell: {} },
        new EventBus(),
      );
      reg.registerAll(builtinTools, 'builtin');

      let seen = null;
      const ctx = { cwd: dir, cfg: reg.cfg, session: { id: 's1' }, confirm: async (q, o) => { seen = { q, o }; return false; } };

      await reg.execute('edit', { path: 'a.js', old_string: '  return 1;', new_string: '  return 42;' }, ctx);
      assert.ok(seen, '应当问了用户');
      assert.ok(seen.o && seen.o.detail, '确认时应当带上改动预览（detail）');
      assert.ok(seen.o.detail.includes('-   return 1;'), `diff 要含被删的行：\n${seen.o.detail}`);
      assert.ok(seen.o.detail.includes('+   return 42;'), `diff 要含新增的行：\n${seen.o.detail}`);

      // 被拒绝 → 文件不能被改（闸门的底线）
      assert.strictEqual(fs.readFileSync(path.join(dir, 'a.js'), 'utf8'), 'function f() {\n  return 1;\n}\n', '拒绝后文件必须原样');

      // 新建文件的预览
      seen = null;
      await reg.execute('write', { path: 'b.js', content: 'const x = 1;\n' }, ctx);
      assert.ok(seen.o.detail.includes('新文件'), `新文件要说清楚：${seen.o.detail}`);
      assert.ok(seen.o.detail.includes('+ const x = 1;'), `新文件全是 +：\n${seen.o.detail}`);

      // 追加模式：只显示新增
      fs.writeFileSync(path.join(dir, 'c.log'), 'first\n');
      seen = null;
      await reg.execute('write', { path: 'c.log', content: 'second\n', append: true }, ctx);
      assert.ok(seen.o.detail.includes('+ second'), `追加要显示新增行：\n${seen.o.detail}`);
      assert.ok(seen.o.detail.includes('first'), '追加时旧内容作为上下文出现');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('预览失败不能挡住执行（拿不到 diff 就照旧问）', async () => {
    const { ToolRegistry } = require(path.join(ROOT, 'src', 'tools.js'));
    const { EventBus } = require(path.join(ROOT, 'src', 'events.js'));
    const reg = new ToolRegistry({ cwd: ROOT, approval: { mode: 'ask' }, tools: { autoApprove: [], deny: [] } }, new EventBus());
    reg.register(
      {
        name: 'boom_preview',
        description: 'x',
        parameters: { type: 'object', properties: {} },
        preview() {
          throw new Error('故意炸');
        },
        async run() {
          return { ok: true, content: 'still-ran' };
        },
      },
      'builtin',
    );
    let detail = null;
    const ctx = { cwd: ROOT, cfg: reg.cfg, confirm: async (q, o) => { detail = o && o.detail; return true; } };
    const res = await reg.execute('boom_preview', {}, ctx);
    assert.strictEqual(res.ok, true, '预览出错不该拦住工具执行');
    assert.ok(String(detail).includes('生成改动预览失败'), `要把失败原因如实告诉用户：${detail}`);
  });

  group('2.65 错误人话化（协议 / 源站 / Key 占位符）');

  const { classifyError, explainHttpError } = require(path.join(ROOT, 'src', 'providers', 'base.js'));
  const { apiKeyIssue } = require(path.join(ROOT, 'src', 'config.js'));

  const fakeProvider = { formatName: 'openai', formatLabel: 'OpenAI 兼容', baseUrl: 'https://gw.example/v1', model: 'gpt-6-luna' };

  await test('协议不匹配：给的建议必须是「换接口格式」，而不是去查模型名', () => {
    // OpenCode Go 的真实报错原样（实测拿到过）：grok / gpt-luna 系列只走 Responses
    const info = classifyError(400, '{"type":"error","error":{"type":"ModelProtocolUnsupported","message":"Model does not support this protocol."}}');
    assert.strictEqual(info.kind, 'protocol', `应当识别为 protocol，实际 ${info.kind}`);
    const msg = explainHttpError(400, 'Model does not support this protocol.', fakeProvider).message;
    assert.ok(msg.includes('接口格式'), `建议要指向「换接口格式」：${msg.slice(0, 140)}`);
    assert.ok(msg.includes('测试连接'), `要告诉用户用测试连接验证：${msg.slice(0, 160)}`);
    assert.ok(!/改成上面列表里的可用模型名为唯一建议/.test(msg), '不能只让人改模型名');
  });

  await test('源站不可达（Cloudflare 530）：要说「网关服务器的问题」，不是配置错', () => {
    // 你另一个网关的真实症状：CF 錯误页 + HTTP 530
    const cfBody = '<!doctype html><html><head><title>gw.example.com | Error 1033</title></head>' +
      '<body>Ray ID: </span><span>9abc123def456 · cdn-cgi/scripts</body></html>';
    const info = classifyError(530, cfBody);
    assert.strictEqual(info.kind, 'origin', `530 应当识别为 origin，实际 ${info.kind}`);

    const info2 = classifyError(502, 'Error 1016: Origin DNS error · cdn-cgi');
    assert.strictEqual(info2.kind, 'origin', `正文含 1016/cdn-cgi 也应识别，实际 ${info2.kind}`);

    const msg = explainHttpError(530, cfBody, fakeProvider).message;
    assert.ok(msg.includes('源站不可达'), `要点明源站问题：${msg.slice(0, 140)}`);
    assert.ok(msg.includes('不是你的配置'), `要明确免责：${msg.slice(0, 160)}`);
    assert.ok(msg.includes('浏览器'), `要给出自查动作：${msg.slice(0, 180)}`);
  });

  await test('网络层错误：占位符 Key 的请求根本没出门，要说清这一点', () => {
    const { humanNetworkError } = require(path.join(ROOT, 'src', 'providers', 'base.js'));
    // .env 里躺着 sk-在这里填你的key 时的真实报错
    const raw = 'Cannot convert argument to a ByteString because the character at index 10 has a value of 22312 which is greater than 255.';
    const human = humanNetworkError({ message: raw });
    assert.ok(human.includes('没有发出去') || human.includes('没有出门'), `要点破「根本没发出去」：${human.slice(0, 120)}`);
    assert.ok(human.includes('占位符') || human.includes('API Key'), `要指向 Key 的问题：${human.slice(0, 160)}`);
    // 其它常见网络错误也要有人话
    assert.ok(humanNetworkError({ message: 'getaddrinfo ENOTFOUND gw.example' }).includes('域名解析'), 'ENOTFOUND 要说「域名解析」');
    assert.ok(humanNetworkError({ message: 'connect ECONNREFUSED 127.0.0.1:8000' }).includes('没人听'), 'ECONNREFUSED 要说「端口没人听」');
  });

  await test('Key 占位符检测：模板文本 / 非 ASCII 命中，真 Key 不命中', () => {
    for (const bad of ['sk-在这里填你的key', 'sk-你的密钥', 'sk-xxplaceholderxx', 'sk-粘贴你的Key', 'sk-在这里填你的密钥']) {
      const r = apiKeyIssue(bad);
      assert.strictEqual(r.issue, 'placeholder', `${bad} 应当被判为占位符，实际 ${JSON.stringify(r)}`);
    }
    const cjk = apiKeyIssue('sk-密钥sk');
    assert.strictEqual(cjk.issue, 'non-ascii', '含中文的 Key 要标非 ASCII');
    assert.ok(cjk.hint.includes('发不出'), '提示要说明后果');
    assert.strictEqual(apiKeyIssue('sk-fake-0123456789abcdef').issue, null, '正常形态的 Key 不该命中');
    assert.strictEqual(apiKeyIssue('').issue, null, '空值交给「未检测到 Key」那条说，不重复报');
  });


  group('2.7 局域网访问令牌闸门');

  const { makeLanGate, isLoopbackHost, parseCookies } = require(path.join(ROOT, 'src', 'web', 'lan-gate.js'));

  await test('什么算「本机」：0.0.0.0 不算（它是监听所有网卡，不是只有本机能连）', () => {
    for (const h of ['127.0.0.1', '127.0.0.5', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
      assert.strictEqual(isLoopbackHost(h), true, `${h} 应当算本机`);
    }
    for (const h of ['0.0.0.0', '192.168.1.5', '10.0.0.7', 'example.com', '', '::']) {
      assert.strictEqual(isLoopbackHost(h), false, `${h} 不该算本机`);
    }
  });

  await test('局域网闸门：URL 令牌 / 请求头 / Cookie 三条路都能进来，其它一律拒绝', () => {
    const gate = makeLanGate({ token: 'tok123', displayHost: '0.0.0.0', port: 3080 });
    const url = (q) => new URL(`http://192.168.1.5:3080/${q}`);
    const reqWith = (headers) => ({ headers });

    // ① 地址栏带令牌 → 要种 cookie 并跳转（不是直接放行）
    assert.strictEqual(gate.decide(reqWith({ host: '192.168.1.5:3080' }), url('?token=tok123')), 'authorize');
    // ② 请求头（给 curl / 脚本用）
    assert.strictEqual(gate.decide(reqWith({ 'x-mya-token': 'tok123' }), url('')), 'ok');
    // ③ Cookie（浏览器后续请求自动带）
    assert.strictEqual(gate.decide(reqWith({ cookie: 'mya_token=tok123; other=1' }), url('')), 'ok');
    // ④ 其余：没有、错的、只有别的前缀 —— 全部拒绝
    assert.strictEqual(gate.decide(reqWith({}), url('')), 'deny');
    assert.strictEqual(gate.decide(reqWith({ 'x-mya-token': 'wrong' }), url('')), 'deny');
    assert.strictEqual(gate.decide(reqWith({ cookie: 'mya_token=wrong' }), url('')), 'deny');
    assert.strictEqual(gate.decide(reqWith({}), url('?token=wrong')), 'deny');

    // Cookie 必须是 HttpOnly + SameSite：否则页面上的脚本能读到它
    const cookie = gate.cookieHeader();
    assert.ok(/HttpOnly/.test(cookie) && /SameSite=Strict/.test(cookie), `Cookie 要有 HttpOnly/SameSite：${cookie}`);

    // 拒绝时的文案：要说清「怎么进来」，而不是「来源不是本机页面」这种误导
    assert.ok(gate.denyJson().error.includes('访问令牌'), 'API 拒绝文案要提到访问令牌');
    assert.ok(gate.denyJson().needToken === true, 'API 要给出 needToken 标记，前端才能提示');
    const page = gate.denyPage('192.168.1.5:3080');
    assert.ok(page.includes('?token='), '页面拒绝时要告诉用户带 token 的链接长什么样');
    assert.ok(!page.includes('来源不是本机'), '不能再用误导性的旧文案');

    // 本机监听时闸门是关的（那种情况交给 Host/Origin 校验）
    assert.strictEqual(makeLanGate({ token: '' }).enabled, false, '没有令牌时闸门应当是关的');
    assert.strictEqual(makeLanGate({ token: '' }).decide(reqWith({}), url('')), 'ok');
  });

  await test('Cookie 解析：值里有等号、空格也能正确取到', () => {
    const c = parseCookies('a=1; mya_token=tok%2F123 ; b=2=3');
    assert.strictEqual(c.mya_token, 'tok/123', `要能解码：${JSON.stringify(c)}`);
    assert.strictEqual(c.b, '2=3', '值里的等号不能被切断');
  });

  await test('畸形 Cookie 不抛异常（%zz 以前会让请求在半路炸掉、连接挂住）', () => {
    const c = parseCookies('mya_token=%zz; ok=1');
    assert.strictEqual(c.ok, '1', '其它 cookie 仍要解析出来');
    assert.strictEqual(c.mya_token, '%zz', '解不出来就原样留着（它不可能通过令牌比较）');
    const gate = makeLanGate({ token: 'tok123', displayHost: '0.0.0.0', port: 3080 });
    const verdict = gate.decide({ headers: { cookie: 'mya_token=%zz' } }, new URL('http://192.168.1.5:3080/'));
    assert.strictEqual(verdict, 'deny', '畸形 cookie 应当被拒，而不是抛异常');
  });

  await test('局域网拒绝页：显示真实局域网 IP（不是 0.0.0.0），Host 头不会被拼进 HTML', () => {
    const gate = makeLanGate({ token: 'tok123', displayHost: '0.0.0.0', port: 3080 });
    const page = gate.denyPage('<img src=x onerror=alert(1)>');
    assert.ok(!page.includes('0.0.0.0'), '0.0.0.0 对手机毫无意义，不该出现在示例地址里');
    assert.ok(page.includes('?token='), '要给出可照抄的链接形状');
    assert.ok(!page.includes('onerror'), 'Host 头是客户端可控的，绝不能原样插进 HTML');
    assert.ok(page.includes('&lt;img') || !page.includes('<img'), '注入内容要么被转义要么根本没用到');
  });

  group('2.8 安全加固（路径限域 / 白名单 / 敏感文件 / 子进程环境）');

  const { isSafeCommand, isAlwaysDangerous, childEnv } = require(path.join(ROOT, 'src', 'tools', 'builtin.js'));
  const { isSensitivePath, resolveRealPath, resolvePath, DEFAULT_IGNORE: IGNORES } = require(path.join(ROOT, 'src', 'utils.js'));
  const { ToolRegistry: SecRegistry } = require(path.join(ROOT, 'src', 'tools.js'));
  const { EventBus: SecBus } = require(path.join(ROOT, 'src', 'events.js'));

  const secHost = (cwd, mode) => {
    const reg = new SecRegistry(
      {
        cwd,
        approval: { mode },
        tools: { autoApprove: ['read', 'glob', 'grep'], deny: [], guardSensitive: true },
        shell: { allowDangerous: false, timeoutSec: 20 },
      },
      new SecBus(),
    );
    reg.registerAll(require(path.join(ROOT, 'src', 'tools', 'builtin.js')).builtinTools, 'builtin');
    return reg;
  };

  await test('路径限域：junction / 符号链接绕不过去（以前字符串比较能绕过）', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-link-'));
    try {
      const ws = path.join(base, 'ws');
      const outside = path.join(base, 'outside');
      fs.mkdirSync(ws);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'data.txt'), '外面的数据');

      let linked = false;
      try {
        fs.symlinkSync(outside, path.join(ws, 'jump'), 'junction');
        linked = true;
      } catch {
        /* 环境不允许建链接就只测字面越界 */
      }
      if (linked) {
        assert.throws(() => resolvePath('jump/data.txt', ws, true), /越出工作目录/, 'junction 必须被拦下');
        assert.strictEqual(fs.existsSync(path.join(ws, 'jump', 'data.txt')), true, '（前提）这个文件确实经 junction 可达');
        const real = resolveRealPath(path.join(ws, 'jump'));
        // 用同一种解析方式比对：Windows 上 realpathSync 与 .native 可能分别给出短名/长名
        const expect = fs.realpathSync.native ? fs.realpathSync.native(outside) : fs.realpathSync(outside);
        assert.strictEqual(path.resolve(real), path.resolve(expect), 'realpath 应当展开 junction');
      }
      assert.throws(() => resolvePath('../outside/data.txt', ws, true), /越出工作目录/);
      assert.ok(resolvePath('sub/a.js', ws, true).startsWith(ws), '工作目录内应当放行');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  await test('路径限域：glob / grep / shell.cwd 也受限（以前只有 read/write/edit 受限）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-scope-'));
    try {
      const reg = secHost(dir, 'ask');
      const ctx = { cwd: dir, cfg: reg.cfg, session: {}, confirm: async () => true };
      const outsidePath = path.join(os.tmpdir(), 'definitely-outside');

      const g1 = await reg.execute('glob', { pattern: '*', path: outsidePath }, ctx);
      assert.strictEqual(g1.ok, false, 'glob 越界必须失败');
      assert.ok(/越出工作目录/.test(g1.content), `错误要说清原因：${g1.content}`);

      const g2 = await reg.execute('grep', { pattern: 'key', path: 'C:/Windows' }, ctx);
      assert.strictEqual(g2.ok, false, 'grep 越界必须失败');

      const s1 = await reg.execute('shell', { command: 'echo hi', cwd: outsidePath }, ctx);
      assert.strictEqual(s1.ok, false, 'shell 的 cwd 越界必须失败');

      // tools.insideOnly=false 是显式选择：应当放行（用户自己承担）
      const loose = secHost(dir, 'ask');
      loose.cfg.tools.insideOnly = false;
      const g3 = await loose.execute('glob', { pattern: '*', path: outsidePath }, { cwd: dir, cfg: loose.cfg, session: {}, confirm: async () => true });
      assert.notStrictEqual(/越出工作目录/.test(String(g3.content)), true, '显式关掉限域后不该再拦');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('命令白名单：能执行代码 / 能读任意文件内容的命令一律不免问', () => {
    for (const c of ['ls -la', 'pwd', 'git status', 'git log', 'node --version', 'go version']) {
      assert.strictEqual(isSafeCommand(c), true, `${c} 应当仍算只读`);
    }
    const bad = [
      ['node -p "process.env.X"', '通用解释器 = 任意代码执行'],
      ['find . -exec cat {} +', 'find -exec 能执行任意命令'],
      ['cat .env', 'cat 能读任意文件内容'],
      ['type C:/Users/x/.ssh/id_rsa', 'type 同上'],
      ['Get-Content config.json', 'PowerShell 读文件'],
      ['Select-String -Path .env -Pattern .', '同上'],
      ['head -100 /etc/passwd', 'head 读文件'],
      ['git show HEAD~1', 'git show 会打印文件内容'],
      ['git diff', 'git diff 会打印文件内容'],
      ['echo $env:PATH', '$ 变量展开'],
      ['ls a\nnode -e "1"', '多行命令会被依次执行'],
      ['npm test', '不是只读查询'],
    ];
    for (const [c, why] of bad) {
      assert.strictEqual(isSafeCommand(c), false, `${JSON.stringify(c)} 不该免问（${why}）`);
    }
    for (const c of ['rm -fr /', 'rm -r -f /', 'git push -f origin main', 'del /s /q C:\\', 'Format-Volume']) {
      assert.strictEqual(isAlwaysDangerous(c), true, `${c} 应当被硬黑名单拦下`);
    }
  });

  await test('确认语义三档：ask 白名单免问 / workspace 命令不问但敏感要问 / full 只拦黑名单', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-sem-'));
    try {
      const ask = secHost(dir, 'ask');
      const ws = secHost(dir, 'workspace');
      const full = secHost(dir, 'full');
      const ctx = { cwd: dir };
      const q = (reg, args) => reg.needsConfirmation(reg.tools.get('shell'), args, ctx);
      const readQ = (reg, args) => reg.needsConfirmation(reg.tools.get('read'), args, ctx);

      assert.strictEqual(q(ask, { command: 'ls -la' }), false, 'ask 档下只读白名单应当免问');
      assert.strictEqual(q(ask, { command: 'node -p "1"' }), true, 'ask 档下解释器必须问');
      assert.strictEqual(q(ask, { command: 'cat .env' }), true, 'ask 档下读 .env 必须问');
      assert.strictEqual(q(ws, { command: 'npm test' }), false, 'workspace 档下普通命令免问');
      assert.strictEqual(q(ws, { command: 'cat .env' }), true, 'workspace 档下点名敏感文件要问');
      assert.strictEqual(q(ws, { command: 'rm -fr /' }), true, '硬黑名单任何档位都拦');
      assert.strictEqual(q(full, { command: 'cat .env' }), false, 'full 档按设计不再问');
      assert.strictEqual(q(full, { command: 'git push -f origin main' }), true, '硬黑名单在 full 档也要拦');

      assert.strictEqual(readQ(ask, { path: '.env' }), true, '读 .env 要问');
      assert.strictEqual(readQ(ask, { path: 'config.json' }), true, '读 config.json 要问');
      assert.strictEqual(readQ(ask, { path: 'src/index.js' }), false, '普通文件不该被这道闸门拦住');
      assert.strictEqual(readQ(ws, { path: '.env' }), true, 'workspace 档同样要问');
      assert.strictEqual(readQ(full, { path: '.env' }), false, 'full 档不再问');
      ask.cfg.tools.guardSensitive = false;
      assert.strictEqual(ask.needsConfirmation(ask.tools.get('read'), { path: '.env' }, ctx), false, 'guardSensitive=false 应当能关掉');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('敏感文件判定与忽略名单：.env / config.json / 私钥 命中，普通文件不命中', () => {
    for (const p of ['.env', '.env.local', 'config.json', 'config.local.json', 'a/b/.npmrc', 'C:/Users/x/.ssh/id_rsa', 'k.pem', 'id_ed25519', '.aws/credentials']) {
      assert.strictEqual(isSensitivePath(p), true, `${p} 应当判定为敏感`);
    }
    for (const p of ['src/index.js', 'README.md', 'config.example.json', 'a-config.json', 'env.txt']) {
      assert.strictEqual(isSensitivePath(p), false, `${p} 不该判定为敏感`);
    }
    for (const name of ['.env', 'config.json', 'config.local.json', '.ssh', '.aws', 'id_rsa']) {
      assert.ok(IGNORES.includes(name), `DEFAULT_IGNORE 缺少 ${name}`);
    }
  });

  await test('grep 默认不会把 .env / config.json 搜出来（忽略名单生效）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-ignore-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'MYA_API_KEY=sk-should-not-appear\n');
      fs.writeFileSync(path.join(dir, 'config.json'), '{"apiKey":"sk-also-not"}\n');
      fs.writeFileSync(path.join(dir, 'normal.js'), 'const apiKey = "in-code";\n');
      const reg = secHost(dir, 'ask');
      const r = await reg.execute('grep', { pattern: 'apiKey|API_KEY', path: '.' }, { cwd: dir, cfg: reg.cfg, session: {}, confirm: async () => true });
      assert.ok(String(r.content).includes('normal.js'), '普通文件里的匹配应当在');
      assert.ok(!String(r.content).includes('sk-should-not-appear'), '.env 的内容不该被搜出来');
      assert.ok(!String(r.content).includes('sk-also-not'), 'config.json 的内容不该被搜出来');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('grep 的回溯炸弹：超时中止，而不是把主进程钉死', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-redos-'));
    try {
      fs.writeFileSync(path.join(dir, 'evil.txt'), `${'a'.repeat(60)}!\n`);
      const reg = secHost(dir, 'ask');
      const t0 = Date.now();
      const r = await reg.execute('grep', { pattern: '(a+)+$', path: '.' }, { cwd: dir, cfg: reg.cfg, session: {}, confirm: async () => true });
      const ms = Date.now() - t0;
      assert.ok(ms < 15000, `必须在超时内返回（实际 ${ms}ms）—— 返回不了就说明主进程被钉死了`);
      assert.ok(/超时被中止/.test(String(r.content)), `必须如实说明结果不完整：${r.content}`);
      const ok = await reg.execute('grep', { pattern: 'a{5}', path: 'evil.txt' }, { cwd: dir, cfg: reg.cfg, session: {}, confirm: async () => true });
      assert.ok(ok.ok, '超时之后工具仍应可用');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('grep 的超长模式直接拒绝', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-longpat-'));
    try {
      const reg = secHost(dir, 'ask');
      const r = await reg.execute('grep', { pattern: 'x'.repeat(600), path: '.' }, { cwd: dir, cfg: reg.cfg, session: {}, confirm: async () => true });
      assert.strictEqual(r.ok, false, '超长模式应当被拒');
      assert.ok(/太长了/.test(String(r.content)), `要说清原因：${r.content}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('子进程环境变量白名单：密钥不进命令（不再整体继承 process.env）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-env-'));
    const saved = { MYA_API_KEY: process.env.MYA_API_KEY, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY };
    try {
      process.env.MYA_API_KEY = 'sk-parent-secret';
      process.env.AWS_SECRET_ACCESS_KEY = 'aws-parent-secret';
      const env = childEnv({});
      assert.strictEqual(env.MYA_API_KEY, undefined, 'MYA_API_KEY 不该进子进程');
      assert.strictEqual(env.AWS_SECRET_ACCESS_KEY, undefined, '看起来像密钥的变量一律不给');
      assert.ok(env.PATH || env.Path, 'PATH 必须留着，否则什么都跑不起来');

      const reg = secHost(dir, 'full');
      const r = await reg.execute(
        'shell',
        { command: 'node -p "JSON.stringify({k: process.env.MYA_API_KEY||null, a: process.env.AWS_SECRET_ACCESS_KEY||null, p: !!process.env.PATH})"' },
        { cwd: dir, cfg: reg.cfg, session: {}, confirm: async () => true },
      );
      assert.ok(/\{"k":null,"a":null,"p":true\}/.test(String(r.content)), `命令看不到密钥、PATH 还在：${r.content}`);
    } finally {
      if (saved.MYA_API_KEY === undefined) delete process.env.MYA_API_KEY;
      else process.env.MYA_API_KEY = saved.MYA_API_KEY;
      if (saved.AWS_SECRET_ACCESS_KEY === undefined) delete process.env.AWS_SECRET_ACCESS_KEY;
      else process.env.AWS_SECRET_ACCESS_KEY = saved.AWS_SECRET_ACCESS_KEY;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('edit 两种模式对 $ 的处理一致（以前 $$ 会被悄悄吃掉一个）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-dollar-'));
    try {
      const reg = secHost(dir, 'ask');
      const ctx = { cwd: dir, cfg: reg.cfg, session: {}, confirm: async () => true };
      const target = path.join(dir, 'a.txt');

      fs.writeFileSync(target, 'PRICE = 100;\n');
      await reg.execute('edit', { path: 'a.txt', old_string: '100', new_string: '$$5' }, ctx);
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'PRICE = $$5;\n', '单个替换不该解释 $ 模式');

      fs.writeFileSync(target, 'A=1\nB=1\n');
      await reg.execute('edit', { path: 'a.txt', old_string: '1', new_string: '$&x', replace_all: true }, ctx);
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'A=$&x\nB=$&x\n', 'replace_all 也不该解释 $ 模式');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  group('2.9 工作区（文件夹）与会话归档');

  const workspaces = require(path.join(ROOT, 'src', 'workspaces.js'));
  const wsCfgOf = (dir) => ({ rootDir: dir, session: { dir: path.join(dir, '.mya', 'sessions') } });

  await test('工作区：注册表 + 会话 cwd 的并集（升级后老会话不会凭空消失）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-ws-'));
    try {
      const cfg = wsCfgOf(dir);
      const a = path.join(dir, 'proj-a');
      const b = path.join(dir, 'proj-b');
      fs.mkdirSync(a);
      fs.mkdirSync(b);

      assert.strictEqual(workspaces.list(cfg, []).length, 0, '一开始没有工作区');

      const added = workspaces.add(cfg, a);
      assert.ok(added.ok && !added.existed, `新增应当成功：${JSON.stringify(added)}`);
      assert.strictEqual(workspaces.add(cfg, a).existed, true, '重复新增要如实说「已存在」，不能加两条');

      // 会话所在的文件夹自动算工作区：这条保证「升级之后历史会话还在」
      const list = workspaces.list(cfg, [
        { cwd: a, archived: false },
        { cwd: a, archived: true },
        { cwd: b, archived: false },
      ]);
      const byName = Object.fromEntries(list.map((w) => [w.name, w]));
      assert.ok(byName['proj-a'], 'A 必须在列表里');
      assert.strictEqual(byName['proj-a'].sessionCount, 2, 'A 下有 2 个会话');
      assert.strictEqual(byName['proj-a'].archivedCount, 1, '其中 1 个已归档');
      assert.ok(byName['proj-b'], 'B 没注册过，但会话在里面，也要出现');
      assert.strictEqual(byName['proj-b'].registered, false, 'B 是自动归位的');

      fs.rmSync(b, { recursive: true, force: true });
      const after = workspaces.list(cfg, [{ cwd: b }]).find((w) => w.name === 'proj-b');
      assert.strictEqual(after.exists, false, '目录没了要标 exists=false（界面上会划掉）');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('工作区：有会话时不允许移除（否则会话会立刻把它带回来，等于骗人）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-ws2-'));
    try {
      const cfg = wsCfgOf(dir);
      const p = path.join(dir, 'proj');
      fs.mkdirSync(p);
      workspaces.add(cfg, p);

      const blocked = workspaces.remove(cfg, p, 2);
      assert.strictEqual(blocked.ok, false, '有会话时应当拒绝');
      assert.ok(/还有 2 个会话/.test(blocked.error), `要说清为什么：${blocked.error}`);

      assert.strictEqual(workspaces.remove(cfg, p, 0).ok, true, '没有会话时可以移除');
      assert.strictEqual(workspaces.list(cfg, []).length, 0, '移除后列表里不该再有它');

      const missing = workspaces.add(cfg, path.join(dir, '不存在'));
      assert.strictEqual(missing.ok, false, '目录不存在应当失败');
      assert.ok(/目录不存在/.test(missing.error), `错误要说清：${missing.error}`);
      const created = workspaces.add(cfg, path.join(dir, '新目录'), { create: true });
      assert.strictEqual(created.ok, true, 'create=true 时应当把目录建出来');
      assert.ok(fs.existsSync(path.join(dir, '新目录')), '目录要真的存在');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('会话归档：内存与磁盘两条路都能存能读（不删会话）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-arch-'));
    try {
      // Session 在这个位置还没被 require 进来（下面的会话分组才 require），所以这里单独取一次
      const { Session: S } = require(path.join(ROOT, 'src', 'session.js'));
      const cfg = { cwd: dir, session: { save: true, dir: path.join(dir, 'sessions') }, model: 'm', provider: 'p' };
      const s = new S(cfg, { title: '归档我' });
      s.addUser('你好');
      s.save();

      const file = path.join(cfg.session.dir, `${s.id}.json`);
      assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).archived, false, '默认不是归档');

      s.archived = true;
      s.save();
      assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).archived, true, '归档要落盘');

      const loaded = S.load(cfg, s.id);
      assert.strictEqual(loaded.archived, true, '从磁盘读回来还是归档状态');
      assert.ok(
        loaded.messages.some((m) => m.role === 'user' && m.content === '你好'),
        '归档不影响消息历史（内容要原样在）',
      );

      const head = S.list(cfg, 10).find((x) => x.id === s.id);
      assert.strictEqual(head.archived, true, 'Session.list 也要带 archived（大文件走头部解析那条路）');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });


  group('2.95 API 配置库（多套接入存档与一键切换）');

  const apiProfiles = require(path.join(ROOT, 'src', 'api-profiles.js'));
  const profCfg = (dir) => ({
    rootDir: dir,
    session: { dir: path.join(dir, '.mya', 'sessions') },
    provider: 'custom', baseUrl: 'https://gw.example/v1', model: 'm1', apiKey: 'sk-current', apiFormat: 'auto',
  });

  await test('API 库：存档增改删、只回掩码、改名不清空 Key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-prof-'));
    try {
      const cfg = profCfg(dir);
      assert.deepStrictEqual(apiProfiles.list(cfg).profiles, [], '一开始是空库');

      const a = apiProfiles.upsert(cfg, {
        name: '官方 Key', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1/',
        model: 'deepseek-chat', apiFormat: 'openai', apiKey: 'sk-real-abcdefghij',
      });
      assert.ok(a.ok && a.created, `新增应当成功：${JSON.stringify(a).slice(0, 80)}`);
      assert.strictEqual(a.profile.baseUrl, 'https://api.deepseek.com/v1', '地址末尾斜杠要去掉（否则拼出 //chat/completions）');

      // 界面形态不能带明文 Key
      const list = apiProfiles.list(cfg);
      const view = apiProfiles.publicView(list.profiles[0], '');
      assert.ok(!JSON.stringify(view).includes('sk-real-abcdefghij'), '界面形态绝不能含明文 Key');
      assert.strictEqual(view.hasKey, true, '要如实说明"有 Key"');
      assert.ok(/^sk-r\*\*\*ghij$/.test(view.keyMasked), `掩码只露头尾：${view.keyMasked}`);

      // 只改模型名 → Key 必须留着（否则用户"改个模型就把 Key 弄丢了"）
      const up = apiProfiles.upsert(cfg, { id: a.profile.id, name: '官方 Key', model: 'deepseek-reasoner' });
      assert.strictEqual(up.profile.apiKey, 'sk-real-abcdefghij', '没重填 Key 时必须沿用旧的');
      assert.strictEqual(up.profile.model, 'deepseek-reasoner', '模型要改掉');

      // 重填 Key → 替换
      const up2 = apiProfiles.upsert(cfg, { id: a.profile.id, name: '官方 Key', apiKey: 'sk-new-key-000111' });
      assert.strictEqual(up2.profile.apiKey, 'sk-new-key-000111', '重填就该替换');

      // 名字的两种"没填"要分开：空字符串拒绝；完全不传则自动起名
      const blankName = apiProfiles.upsert(cfg, { name: '', provider: 'custom', baseUrl: 'https://x/v1', model: 'm' });
      assert.strictEqual(blankName.ok, false, '名字传空字符串应当拒绝');
      const noName = apiProfiles.upsert(cfg, { provider: 'custom', baseUrl: 'https://x/v1', model: 'm2' });
      assert.strictEqual(noName.ok, true, '完全没传名字应当自动起名（「存为一条」的场景）');
      assert.ok(noName.profile.name.includes('m2'), `自动名字要能认出来：${noName.profile.name}`);
      apiProfiles.remove(cfg, noName.profile.id);

      // 删除 + 不存在的 id 要有话说
      assert.strictEqual(apiProfiles.remove(cfg, a.profile.id).ok, true, '删除应当成功');
      assert.strictEqual(apiProfiles.remove(cfg, 'nope').ok, false, '删不存在的要如实报错');
      assert.strictEqual(apiProfiles.list(cfg).profiles.length, 0, '删完就是空的');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('API 库：激活载荷带真 Key、activeId 落盘、坏文件不致命', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-prof2-'));
    try {
      const cfg = profCfg(dir);
      const p1 = apiProfiles.upsert(cfg, {
        name: '网关 A', provider: 'custom', baseUrl: 'https://a.example/v1', model: 'ma', apiKey: 'sk-aaa-111222',
      });

      // 激活载荷：服务端要靠它去重建 provider，所以必须有真 Key
      const act = apiProfiles.activationPayload(cfg, p1.profile.id);
      assert.ok(act.ok, '激活载荷应当能取到');
      assert.strictEqual(act.payload.apiKey, 'sk-aaa-111222', '激活载荷必须含真 Key（否则切过去连不上）');
      assert.strictEqual(act.payload.baseUrl, 'https://a.example/v1', '地址要一起带过去');

      // 没有 Key 的存档（本地 Ollama）不传 apiKey，避免把当前 Key 清成空
      const p2 = apiProfiles.upsert(cfg, { name: '本地 Ollama', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b' });
      const act2 = apiProfiles.activationPayload(cfg, p2.profile.id);
      assert.ok(!('apiKey' in act2.payload), '存档没 Key 就不该传 apiKey（别把当前 Key 清空）');

      // activeId 落盘 + 删除激活项后自动清空
      apiProfiles.setActive(cfg, p1.profile.id);
      assert.strictEqual(apiProfiles.list(cfg).activeId, p1.profile.id, 'activeId 要落盘');
      apiProfiles.remove(cfg, p1.profile.id);
      assert.strictEqual(apiProfiles.list(cfg).activeId, '', '删掉正在用的那条后 activeId 要清掉（避免指向不存在）');

      // 取不存在的存档 → 明确报错，而不是给个空载荷
      assert.strictEqual(apiProfiles.activationPayload(cfg, 'ghost').ok, false, '激活不存在的存档要报错');

      // 存档文件坏了 → 当空库，程序照常能起
      fs.writeFileSync(apiProfiles.storeFile(cfg), '{ 这不是 JSON', 'utf8');
      assert.deepStrictEqual(apiProfiles.list(cfg).profiles, [], '坏文件当空库，不能因此起不来');
      assert.ok(apiProfiles.upsert(cfg, { name: '恢复', provider: 'custom', baseUrl: 'https://x/v1', model: 'm' }).ok, '坏文件之后还能继续写');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });


  group('3. 工具注册表');


  const cfg = {
    tools: { autoApprove: ['safe_read'], deny: ['forbidden'], maxOutputChars: 100 },
    shell: { allowDangerous: false },
  };

  await test('参数校验：必填 / 类型纠偏 / 枚举', () => {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        n: { type: 'integer' },
        flag: { type: 'boolean' },
        mode: { type: 'string', enum: ['a', 'b'] },
      },
      required: ['path'],
    };
    assert.ok(!validateArgs(schema, {}).ok, '缺必填应失败');
    assert.ok(validateArgs(schema, { path: 'x' }).ok);
    // 数字被写成字符串应被纠正
    assert.strictEqual(validateArgs(schema, { path: 'x', n: '42' }).value.n, 42);
    // "true" 应转成 true
    assert.strictEqual(validateArgs(schema, { path: 'x', flag: 'true' }).value.flag, true);
    // 枚举外应失败
    assert.ok(!validateArgs(schema, { path: 'x', mode: 'c' }).ok);
    // 坏 JSON 应给出可读错误
    const bad = validateArgs(schema, { __parseError: true, __raw: 'oops' });
    assert.ok(!bad.ok && bad.error.includes('JSON'));
  });

  await test('注册 / 查找 / 别名 / 按 deny 禁用', () => {
    const reg = new ToolRegistry(cfg, new EventBus());
    reg.register({ name: 'safe_read', description: 'x', run: async () => 'ok' }, 'builtin');
    reg.register({ name: 'forbidden', description: 'x', run: async () => 'ok' }, 'builtin');
    reg.register({ name: 'alias_tool', aliases: ['at'], description: 'x', run: async () => 'ok' }, 'builtin');

    assert.ok(reg.has('safe_read'));
    assert.ok(!reg.has('forbidden'), '被 deny 的工具不应注册成功');
    assert.ok(reg.skipped.some((s) => s.name === 'forbidden'));
    assert.ok(reg.get('at'), '别名应能查到工具');
    assert.ok(!reg.has('不存在的工具'));
  });

  await test('插件工具不能顶替内置工具', () => {
    const reg = new ToolRegistry(cfg, new EventBus());
    reg.register({ name: 'read', description: '内置', run: async () => 'builtin' }, 'builtin');
    const result = reg.register({ name: 'read', description: '插件', run: async () => 'plugin' }, 'plugin:evil');
    assert.strictEqual(result, null, '插件重名注册应被拒绝');
    assert.ok(reg.skipped.some((s) => s.reason.includes('重名')));
  });

  await test('执行：输出被截断到 maxOutputChars', async () => {
    const reg = new ToolRegistry(cfg, new EventBus());
    reg.register({ name: 'verbose', description: 'x', run: async () => 'x'.repeat(5000) }, 'builtin');
    const res = await reg.execute('verbose', {}, { confirm: async () => true, cfg });
    assert.ok(res.ok);
    assert.ok(res.content.length < 2000, `输出未截断：${res.content.length}`);
    assert.ok(res.meta.truncated);
  });

  await test('执行：工具不存在时给出相近建议', async () => {
    const reg = new ToolRegistry(cfg, new EventBus());
    reg.register({ name: 'read', description: 'x', run: async () => 'ok' }, 'builtin');
    const res = await reg.execute('reed', {}, { confirm: async () => true, cfg });
    assert.ok(!res.ok);
    assert.ok(res.content.includes('read'), `缺少建议：${res.content}`);
  });

  await test('确认闸门：拒绝后不执行，并把「用户拒绝」告知模型', async () => {
    const reg = new ToolRegistry(cfg, new EventBus());
    let executed = false;
    reg.register(
      { name: 'dangerous_one', dangerous: true, description: 'x', run: async () => { executed = true; return 'done'; } },
      'builtin',
    );
    const res = await reg.execute('dangerous_one', {}, { confirm: async () => false, cfg });
    assert.strictEqual(executed, false, '用户拒绝后不应执行');
    assert.ok(res.content.includes('拒绝'));
  });

  await test('确认闸门：autoApprove 白名单免确认', async () => {
    const reg = new ToolRegistry(cfg, new EventBus());
    let asked = false;
    reg.register({ name: 'safe_read', dangerous: true, description: 'x', run: async () => 'ok' }, 'builtin');
    const res = await reg.execute('safe_read', {}, { confirm: async () => { asked = true; return false; }, cfg });
    assert.strictEqual(asked, false, '白名单工具不应弹确认');
    assert.ok(res.ok);
  });

  /* ---- 权限档位：询问 / 工作区内 / 完全权限 ----
     这三档是界面上那个常驻按钮，直接决定「agent 能不能不问就动手」，
     所以每一档的边界都要有用例钉住，尤其是「越界仍然问」。 */
  const modeCfgOf = (mode) => ({
    tools: { autoApprove: [], deny: [], maxOutputChars: 100000 },
    shell: { allowDangerous: false },
    cwd: ROOT,
    ...(mode ? { approval: { mode } } : {}),
  });
  const { approvalMode } = require(path.join(ROOT, 'src', 'tools.js'));

  await test('权限档位：默认是询问（最保守）', () => {
    assert.strictEqual(approvalMode({}), 'ask', '没有 approval 配置时必须退回 ask');
    assert.strictEqual(approvalMode({ approval: { mode: '乱写' } }), 'ask', '非法值也要退回 ask');
    assert.strictEqual(approvalMode({ approval: { mode: 'full' } }), 'full', '正常值要认');
  });

  await test('权限档位：工作区内 → 工作目录里的写操作免问，越界仍然问', async () => {
    const modeCfg = modeCfgOf('workspace');
    const reg = new ToolRegistry(modeCfg, new EventBus());
    let wrote = null;
    reg.register({ name: 'write', dangerous: true, description: 'x', run: async (a) => { wrote = a.path; return 'ok'; } }, 'builtin');

    let asked = false;
    const inside = await reg.execute(
      'write',
      { path: 'tmp-guard-inside.txt' },
      { confirm: async () => { asked = true; return true; }, cfg: modeCfg, cwd: ROOT },
    );
    assert.ok(inside.ok, `工作区内的写应该直接执行：${inside.content}`);
    assert.strictEqual(asked, false, '工作区内的写不该弹确认');
    assert.ok(wrote && wrote.includes('tmp-guard-inside'), '工具应该真的被调用');

    asked = false;
    let outsideRun = false;
    reg.register({ name: 'write2', dangerous: true, description: 'x', run: async () => { outsideRun = true; return 'ok'; } }, 'builtin');
    const outside = await reg.execute(
      'write2',
      { path: path.join(ROOT, '..', '越界目录', 'x.txt') },
      { confirm: async () => { asked = true; return false; }, cfg: modeCfg, cwd: ROOT },
    );
    assert.strictEqual(asked, true, '越界的写必须弹确认');
    assert.strictEqual(outsideRun, false, '用户拒绝后不该执行');
    assert.ok(outside.content.includes('拒绝'), `拒绝文案要能回给模型：${outside.content}`);

    // 探测不到路径的工具（不知道它要动哪儿）也要继续问
    asked = false;
    reg.register({ name: 'mystery', dangerous: true, description: 'x', run: async () => 'ok' }, 'builtin');
    await reg.execute('mystery', {}, { confirm: async () => { asked = true; return false; }, cfg: modeCfg, cwd: ROOT });
    assert.strictEqual(asked, true, '拿不到路径的写类工具必须问');
  });

  await test('权限档位：完全权限 → 不再问，但工具自己坚持要问的仍然拦', async () => {
    const modeCfg = modeCfgOf('full');
    const reg = new ToolRegistry(modeCfg, new EventBus());
    let asked = false;
    reg.register({ name: 'write', dangerous: true, description: 'x', run: async () => 'ok' }, 'builtin');
    const res = await reg.execute('write', { path: '不管在哪都行.txt' }, { confirm: async () => { asked = true; return true; }, cfg: modeCfg, cwd: ROOT });
    assert.ok(res.ok && !asked, '完全权限下不该弹确认');

    // 硬黑名单（比如 rm -rf /）走的是工具自己的 needsConfirmation，任何档位都要拦
    const strict = new ToolRegistry(modeCfg, new EventBus());
    let hardAsked = false;
    strict.register(
      {
        name: 'hard',
        dangerous: true,
        description: 'x',
        needsConfirmation: () => true,
        run: async () => 'ok',
      },
      'builtin',
    );
    const hard = await strict.execute('hard', {}, { confirm: async () => { hardAsked = true; return false; }, cfg: modeCfg, cwd: ROOT });
    assert.strictEqual(hardAsked, true, '工具自己说「必须问」时，完全权限也要问');
    assert.ok(!hard.ok, '被拒绝就不该执行');
  });

  await test('权限档位：工作区内不放松「永远危险」的命令', () => {
    const modeCfg = modeCfgOf('workspace');
    const shell = require(path.join(ROOT, 'src', 'tools', 'builtin.js')).builtinTools.find((t) => t.name === 'shell');
    assert.ok(shell, '找不到 shell 工具');
    assert.strictEqual(shell.needsConfirmation({ command: 'ls -la' }, modeCfg, 'workspace'), false, '普通命令免问');
    assert.strictEqual(
      shell.needsConfirmation({ command: 'rm -rf /' }, modeCfg, 'workspace'),
      true,
      '高破坏性命令在工作区档也必须问',
    );
    assert.strictEqual(
      shell.needsConfirmation({ command: 'git push --force origin main' }, modeCfg, 'full'),
      true,
      '完全权限档也拦得住 git push --force',
    );
  });

  await test('钩子能拦截工具执行（tool:before 返回 false）', async () => {
    const bus = new EventBus();
    const reg = new ToolRegistry(cfg, bus);
    let executed = false;
    reg.register({ name: 'x', autoApprove: true, description: 'x', run: async () => { executed = true; return 'ok'; } }, 'builtin');
    bus.on('tool:before', () => false);
    const res = await reg.execute('x', {}, { confirm: async () => true, cfg });
    assert.strictEqual(executed, false);
    assert.ok(res.content.includes('拦截'));
  });

  await test('钩子抛错不会拖垮主流程', async () => {
    const bus = new EventBus();
    const reg = new ToolRegistry(cfg, bus);
    reg.register({ name: 'x', autoApprove: true, description: 'x', run: async () => 'ok' }, 'builtin');
    bus.on('tool:before', () => {
      throw new Error('钩子炸了');
    });
    const res = await reg.execute('x', {}, { confirm: async () => true, cfg });
    assert.ok(res.ok, '钩子异常时工具仍应正常执行');
  });

  await test('工具描述能转成 OpenAI tools 协议', () => {
    const reg = new ToolRegistry(cfg, new EventBus());
    reg.register(
      {
        name: 'demo',
        description: '示例',
        parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        run: async () => 'ok',
      },
      'builtin',
    );
    const [tool] = reg.toOpenAITools();
    assert.strictEqual(tool.type, 'function');
    assert.strictEqual(tool.function.name, 'demo');
    assert.ok(tool.function.parameters.properties.a);
    // strict 有硬性前提（全必填 + additionalProperties:false）：不满足时绝不能带，
    // 否则官方 OpenAI 会在请求阶段直接 400（Invalid schema for function）
    assert.strictEqual(tool.function.strict, undefined, '不满足 strict 前提时不能带');
    reg.register(
      {
        name: 'strict_ok',
        description: '满足 strict 前提的示例',
        parameters: {
          type: 'object',
          properties: { a: { type: 'string' } },
          required: ['a'],
          additionalProperties: false,
        },
        run: async () => 'ok',
      },
      'builtin',
    );
    const strictTool = reg.toOpenAITools().find((t) => t.function.name === 'strict_ok');
    assert.strictEqual(strictTool.function.strict, true, '满足前提时应带上 strict');
  });
}

/* ------------------------------------------------------------------ */
/* 4. 插件系统                                                         */
/* ------------------------------------------------------------------ */

async function testPlugins() {
  const { PluginHost } = require(path.join(ROOT, 'src', 'plugins.js'));
  const { ToolRegistry } = require(path.join(ROOT, 'src', 'tools.js'));
  const { EventBus } = require(path.join(ROOT, 'src', 'events.js'));
  group('4. 插件系统');

  /**
   * 建一个插件宿主。
   * @param {string} pluginDir 插件目录
   * @param {object} [extra]   额外配置覆盖
   * @param {string} [cwd]     工作目录（插件里的相对路径以它为基准），默认项目根
   */
  function makeHost(pluginDir, extra = {}, cwd = ROOT) {
    const cfg = {
      cwd,
      pluginDirs: [pluginDir],
      plugins: { enabled: true, dirs: [pluginDir], disabled: [], config: {} },
      tools: { autoApprove: [], deny: [], maxOutputChars: 30000 },
      shell: { allowDangerous: false, timeoutSec: 10 },
      ...extra,
    };
    const bus = new EventBus();
    const registry = new ToolRegistry(cfg, bus);
    const host = new PluginHost(cfg, bus, registry, { ui: null, log: () => {} });
    return { cfg, bus, registry, host };
  }

  await test('真实示例插件能全部加载（5 个）', async () => {
    const { host, registry } = makeHost(path.join(ROOT, 'plugins'));
    const stats = await host.loadAll();
    assert.strictEqual(stats.loaded, 5, `应加载 5 个插件，实际 ${stats.loaded}；错误：${JSON.stringify(host.errors)}`);
    assert.strictEqual(stats.failed, 0);

    // 每个插件注册的工具都应真的进了注册表
    for (const p of host.list()) {
      for (const t of p.toolNames) {
        assert.ok(registry.has(t), `插件 ${p.name} 的工具 ${t} 没进注册表`);
      }
    }
  });

  await test('示例插件的工具可以真正执行', async () => {
    const { host, registry, cfg } = makeHost(path.join(ROOT, 'plugins'));
    await host.loadAll();
    // 注意 cwd 要设成项目根，这样插件里的相对路径 "src" 才能找到
    const ctx = { cwd: ROOT, cfg: { ...cfg, model: 'test' }, confirm: async () => true };

    const echo = await registry.execute('hello_echo', { text: '你好', upper: true }, ctx);
    assert.ok(echo.ok, echo.content);
    assert.ok(echo.content.includes('你好'.toUpperCase()), echo.content);

    const tree = await registry.execute('list_tree', { path: 'src', depth: 1 }, ctx);
    assert.ok(tree.ok, tree.content);
    assert.ok(tree.content.includes('agent.js'), tree.content);

    const info = await registry.execute('file_info', { path: 'package.json' }, ctx);
    assert.ok(info.ok, info.content);
    assert.ok(info.content.includes('行数'));
  });

  await test('插件命令注册成功', async () => {
    const { host } = makeHost(path.join(ROOT, 'plugins'));
    await host.loadAll();
    assert.ok(host.commands.has('hello'), '应注册 /hello 命令');
    assert.ok(host.commands.has('audit'), '应注册 /audit 命令');
    const out = await host.commands.get('hello').handler('测试');
    assert.ok(String(out).includes('测试'));
  });

  await test('钩子生效：audit 插件能拦截危险命令', async () => {
    const { host, registry, cfg } = makeHost(path.join(ROOT, 'plugins'));
    // 注册真实的 shell 工具，才能验证插件的拦截钩子
    registry.registerAll(require(path.join(ROOT, 'src', 'tools', 'builtin.js')).builtinTools, 'builtin');
    await host.loadAll();

    const res = await registry.execute(
      'shell',
      { command: 'rm -rf / --no-preserve-root' },
      { cwd: ROOT, cfg: { ...cfg, shell: { ...cfg.shell, allowDangerous: true } }, confirm: async () => true },
    );
    assert.ok(!res.ok, '危险命令应被拦截');
    assert.ok(res.content.includes('拦截'), res.content);
  });

  await test('插件工具按声明权限决定要不要确认（内置的才问、插件的不问 —— 那是反的）', async () => {
    const dir = makeTempProject();
    try {
      const pluginsDir = path.join(dir, 'plugins');
      const mk = (name, manifest, toolDef) => {
        const pdir = path.join(pluginsDir, name);
        fs.mkdirSync(pdir, { recursive: true });
        fs.writeFileSync(path.join(pdir, 'manifest.json'), JSON.stringify({ name, entry: 'index.js', ...manifest }));
        fs.writeFileSync(path.join(pdir, 'index.js'), `module.exports = { name: '${name}', setup(ctx) { ctx.registerTool(${toolDef}); } };`);
      };
      const toolBody = (name, extra) =>
        `{ name: '${name}', description: 'x', parameters: { type: 'object', properties: { path: { type: 'string' } } }, ${extra} async run() { return 'ok'; } }`;

      // 声明了写文件的权限 → 必须问
      mk('writer', { permissions: ['fs:write'] }, toolBody('w_tool', ''));
      // 什么都没声明 → 当只读，免问
      mk('reader', { permissions: [] }, toolBody('r_tool', ''));
      // 工具自己标了 dangerous → 必须问
      mk('danger', { permissions: ['fs:read'] }, toolBody('d_tool', 'dangerous: true, '));
      // 工具自己声明 autoApprove → 免问（插件的显式意图优先）
      mk('trusted', { permissions: ['fs:write'] }, toolBody('t_tool', 'autoApprove: true, '));

      const { host, registry, cfg } = makeHost(pluginsDir);
      await host.loadAll();
      for (const n of ['w_tool', 'r_tool', 'd_tool', 't_tool']) assert.ok(registry.has(n), `${n} 应注册`);

      // 权限档位来自注册表自己的配置（不是每次调用的 ctx），所以按档位各建一个注册表来测
      const cfgOf = (mode) => ({ ...cfg, approval: { mode }, tools: { autoApprove: [] } });
      const probe = (mode) => {
        const reg = new ToolRegistry(cfgOf(mode), new EventBus());
        for (const name of ['w_tool', 'r_tool', 'd_tool', 't_tool']) {
          const t = registry.tools.get(name);
          // 按定义重建一次：顺便验证 permissions 是跟着定义走的（临时属性在这里就会丢）
          reg.register(
            { name: t.name, description: t.description, permissions: t.permissions, dangerous: t.dangerous, autoApprove: t.autoApprove, parameters: t.parameters, run: async () => ({ ok: true, content: 'ok' }) },
            t.source,
          );
        }
        return reg;
      };
      const ctx = { cwd: dir, cfg: cfgOf('ask') };
      const askReg = probe('ask');
      assert.strictEqual(askReg.needsConfirmation(askReg.tools.get('w_tool'), { path: 'a.js' }, ctx), true, '声明了 fs:write 的插件工具必须先问');
      assert.strictEqual(askReg.needsConfirmation(askReg.tools.get('r_tool'), { path: 'a.js' }, ctx), false, '没声明权限的只读插件工具不该弹窗');
      assert.strictEqual(askReg.needsConfirmation(askReg.tools.get('d_tool'), { path: 'a.js' }, ctx), true, '工具自己标了 dangerous 必须问');
      assert.strictEqual(askReg.needsConfirmation(askReg.tools.get('t_tool'), { path: 'a.js' }, ctx), false, '工具自己的 autoApprove 优先');

      // 工作区档下：落在工作目录内的路径免问（和内置 write 的行为一致）
      const wsReg = probe('workspace');
      const wsCtx = { cwd: dir, cfg: cfgOf('workspace') };
      const inside = path.join(dir, 'sub', 'a.js');
      assert.strictEqual(wsReg.needsConfirmation(wsReg.tools.get('w_tool'), { path: inside }, wsCtx), false, '工作区内免问');
      assert.strictEqual(
        wsReg.needsConfirmation(wsReg.tools.get('w_tool'), { path: path.join(os.tmpdir(), 'outside.js') }, wsCtx),
        true,
        '越界仍然要问',
      );
    } finally {
      cleanup(dir);
    }
  });

  await test('插件没声明权限却注册工具时会给出告警（权限是声明不是沙箱）', async () => {
    const dir = makeTempProject();
    try {
      const pluginsDir = path.join(dir, 'plugins');
      const pdir = path.join(pluginsDir, 'quiet');
      fs.mkdirSync(pdir, { recursive: true });
      fs.writeFileSync(path.join(pdir, 'manifest.json'), JSON.stringify({ name: 'quiet', entry: 'index.js' }));
      fs.writeFileSync(
        path.join(pdir, 'index.js'),
        "module.exports = { name: 'quiet', setup(ctx) { ctx.registerTool({ name: 'q_tool', description: 'x', parameters: { type: 'object', properties: {} }, async run() { return 'ok'; } }); } };",
      );
      const warnings = [];
      const { host } = makeHost(pluginsDir);
      host.warn = (msg) => warnings.push(String(msg));
      await host.loadAll();
      assert.ok(
        warnings.some((w) => w.includes('没有声明任何权限却注册了')),
        `应当给出告警，实际：${warnings.join(' | ')}`,
      );
    } finally {
      cleanup(dir);
    }
  });


  await test('插件目录不存在时安静跳过', async () => {
    const { host } = makeHost(path.join(ROOT, '不存在的目录'));
    const stats = await host.loadAll();
    assert.deepStrictEqual(stats, { loaded: 0, failed: 0 });
  });

  /* ---- 卸载 / 重载：这两个 bug 以前是「查不出原因」的典型 ---- */

  const writeLifecyclePlugin = (pluginsDir, version) => {
    const pdir = path.join(pluginsDir, 'lifecycle');
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(
      path.join(pdir, 'manifest.json'),
      JSON.stringify({ name: 'lifecycle', version: '0.0.1', entry: 'index.js', permissions: ['fs:read'] }),
    );
    fs.writeFileSync(
      path.join(pdir, 'index.js'),
      `module.exports = {
  name: 'lifecycle',
  version: '${version}',
  setup(ctx) {
    ctx.on('tool:before', () => true);
    ctx.on('session:start', () => {});
    ctx.registerTool({
      name: 'life_probe',
      description: '返回插件版本',
      parameters: { type: 'object', properties: {} },
      async run() { return '${version}'; },
    });
    ctx.registerCommand('life', {}, () => 'life-ok');
  },
};`,
    );
    return pdir;
  };

  await test('插件卸载：钩子 / 工具 / 命令一起摘净（禁用掉的插件不该还在拦命令）', async () => {
    const dir = makeTempProject();
    try {
      const pluginsDir = path.join(dir, 'plugins');
      writeLifecyclePlugin(pluginsDir, 'v1');
      const { host, bus, registry } = makeHost(pluginsDir);
      const baseHooks = bus.count();
      await host.loadAll();
      assert.strictEqual(host.list().length, 1, '应当加载 1 个插件');
      assert.ok(registry.has('life_probe'), '工具应注册进注册表');
      assert.ok(host.commands.has('life'), '命令应注册');
      assert.strictEqual(bus.count(), baseHooks + 2, `应挂上 2 个钩子，实际 ${bus.count() - baseHooks}`);

      const one = await host.unload('lifecycle');
      assert.ok(one.ok, '卸载应成功');
      assert.strictEqual(one.hooks, 2, `应当摘掉 2 个钩子，实际 ${one.hooks}`);
      assert.strictEqual(one.tools, 1, '应当注销 1 个工具');
      assert.strictEqual(one.commands, 1, '应当注销 1 个命令');
      assert.strictEqual(bus.count(), baseHooks, `卸载后监听器要回到基线（实际 ${bus.count()}，基线 ${baseHooks}）`);
      assert.ok(!registry.has('life_probe'), '工具应从注册表消失');
      assert.ok(!host.commands.has('life'), '命令应消失');
      assert.strictEqual(host.list().length, 0, '插件列表应为空');
      assert.strictEqual((await host.unload('lifecycle')).ok, false, '已经卸掉的插件再卸应当返回 ok:false');
    } finally {
      cleanup(dir);
    }
  });

  await test('插件重载：改过的代码真的生效（require 缓存必须清掉）', async () => {
    const dir = makeTempProject();
    try {
      const pluginsDir = path.join(dir, 'plugins');
      const pdir = writeLifecyclePlugin(pluginsDir, 'v1');
      const { host, registry } = makeHost(pluginsDir);
      await host.loadAll();
      const ctx = { cwd: dir, cfg: { ...host.cfg }, confirm: async () => true };
      const first = await registry.execute('life_probe', {}, ctx);
      assert.strictEqual(String(first.content), 'v1', `第一次应当是 v1，实际 ${first.content}`);

      const entryFile = path.join(pdir, 'index.js');
      assert.ok(require.cache[entryFile], '加载后插件入口应当在 require 缓存里（这是缓存问题的前提）');

      // 模拟用户改了插件代码，然后点「重扫插件」
      await host.unload('lifecycle');
      assert.strictEqual(require.cache[entryFile], undefined, '卸载后必须清掉模块缓存，否则重载还是旧代码');
      writeLifecyclePlugin(pluginsDir, 'v2');
      await host.loadAll();
      const second = await registry.execute('life_probe', {}, ctx);
      assert.strictEqual(String(second.content), 'v2', `改动后重载应当生效（拿到 ${second.content}）`);
    } finally {
      cleanup(dir);
    }
  });

  await test('插件反复重载：钩子不会越挂越多（以前 6 → 12 → 18）', async () => {
    const dir = makeTempProject();
    try {
      const pluginsDir = path.join(dir, 'plugins');
      writeLifecyclePlugin(pluginsDir, 'v1');
      const { host, bus } = makeHost(pluginsDir);
      const baseHooks = bus.count();
      await host.loadAll();
      const afterFirst = bus.count();
      for (let i = 0; i < 3; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await host.unloadAll();
        // eslint-disable-next-line no-await-in-loop
        await host.loadAll();
        assert.strictEqual(bus.count(), afterFirst, `第 ${i + 2} 次加载后监听器数应保持 ${afterFirst}，实际 ${bus.count()}`);
      }
      assert.strictEqual(afterFirst, baseHooks + 2, '一共只该有 2 个钩子');
      const total = await host.unloadAll();
      assert.strictEqual(bus.count(), baseHooks, '全卸载后要回到基线');
      assert.strictEqual(total.plugins, 1);
      assert.strictEqual(total.hooks, 2);
    } finally {
      cleanup(dir);
    }
  });

  /* ---- npm 可分发性：不能把用户的配置打进包里 ---- */

  await test('package.json 具备 npm 分发所需的字段，且不会把 config.json 打进去', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    // ① 入口分两路：Electron 认 main，库用户认 exports
    assert.strictEqual(pkg.main, 'desktop/main.js', 'main 必须留在桌面入口（electron-builder 靠它找主进程）');
    assert.strictEqual(pkg.exports['.'], './src/index.js', 'exports 应当把包根指向库入口');
    assert.ok(fs.existsSync(path.join(ROOT, 'src', 'index.js')), '库入口文件要真的存在');
    assert.strictEqual(pkg.bin.mya, 'bin/mya.js', 'bin 要指向 CLI');
    assert.strictEqual(pkg.private, undefined, 'private:true 会让 npm publish 直接失败');
    assert.ok(pkg.publishConfig && pkg.publishConfig.access === 'public', '公开包应当声明 publishConfig');
    // ② files 白名单必须覆盖运行时需要的目录，且**排除**用户私有数据
    const needed = ['bin/', 'src/', 'web/', 'prompts/', 'plugins/', 'catalog/', 'types/', 'docs/'];
    for (const dir of needed) {
      assert(pkg.files.some((f) => f.startsWith(dir)), `files 里缺少 ${dir}`);
    }
    assert(pkg.files.includes('config.example.json'), '要带上配置模板');
    assert(!pkg.files.includes('config.json'), '绝不能把用户真实配置打进 npm 包');
    assert(!pkg.files.some((f) => f.includes('.env')), '不能带 .env');
    assert(!pkg.files.some((f) => f.includes('.mya')), '不能带运行时数据目录');
  });

  await test('npm pack 的文件清单里没有敏感文件（真的跑一遍打包清单）', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    let out = null;
    try {
      out = spawnSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: ROOT,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        timeout: 60000,
      });
    } catch {
      out = null;
    }
    if (!out || out.status !== 0 || !out.stdout) {
      // 没有 npm / 离线环境：退回上一条静态断言保护的姿势，不让整套测试挂掉
      console.log('      （环境里没有可用的 npm，跳过实际打包清单检查）');
      return;
    }
    const parsed = JSON.parse(out.stdout);
    const files = (parsed[0] && parsed[0].files) || [];
    assert(files.length > 30, `打包清单太小，可能没带上源码：${files.length}`);
    const names = files.map((f) => f.path);
    assert(!names.includes('config.json'), '打包清单里出现了 config.json');
    assert(!names.some((n) => n.startsWith('.env')), '打包清单里出现了 .env');
    assert(!names.some((n) => n.startsWith('.mya/')), '打包清单里出现了 .mya 数据');
    assert(names.some((n) => n === 'bin/mya.js'), '缺少 CLI 入口');
    assert(names.some((n) => n === 'src/index.js'), '缺少库入口');
    assert(!names.some((n) => n.startsWith('test/')), '测试不该进包（体积和噪声）');
    void pkg;
  });

  await test('审计日志是批量异步写的：热路径不阻塞，批次会落盘', async () => {
    // tool:after 是热路径，同步 appendFileSync 会被慢盘拖住整个 agent。
    // 这里验两件事：① 事件刚发完时不落盘（说明真的在攒批）；② 一段时间后落盘。
    const dir = makeTempProject();
    try {
      fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
      fs.cpSync(path.join(ROOT, 'plugins', 'audit'), path.join(dir, 'plugins', 'audit'), { recursive: true });
      const { host, bus } = makeHost(path.join(dir, 'plugins'), { cwd: dir });
      await host.loadAll();
      const logFile = path.join(dir, '.mya', 'audit.log');
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

      await bus.emit('tool:after', { toolName: 'read', ok: true, ms: 3, summary: '读了文件' });
      assert.ok(!fs.existsSync(logFile), '事件刚发完不该已经同步落盘（那说明还是同步写）');

      await sleep(400);
      assert.ok(fs.existsSync(logFile), '攒批之后应当落盘');
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      assert.strictEqual(lines.length, 1, `应当恰好一条，实际 ${lines.length}`);
      const entry = JSON.parse(lines[0]);
      assert.strictEqual(entry.tool, 'read');
      assert.strictEqual(entry.ok, true);

      // 一轮结束时应当立刻推进批次（用户可能马上去看日志）
      await bus.emit('tool:after', { toolName: 'write', ok: false, ms: 5, summary: '失败了' });
      await bus.emit('session:end', { sessionId: 's1', usage: {}, context: {} });
      await sleep(60);
      const lines2 = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      assert.strictEqual(lines2.length, 2, `session:end 应当把第二条推下去，实际 ${lines2.length}`);
    } finally {
      cleanup(dir);
    }
  });

  await test('坏插件（语法错误）不会导致加载崩溃', async () => {
    const dir = makeTempProject();
    try {
      const bad = path.join(dir, 'plugins', 'bad-plugin');
      fs.mkdirSync(bad, { recursive: true });
      fs.writeFileSync(path.join(bad, 'manifest.json'), JSON.stringify({ name: 'bad', entry: 'index.js' }));
      fs.writeFileSync(path.join(bad, 'index.js'), 'this is not valid javascript at all (((');
      const { host } = makeHost(path.join(dir, 'plugins'));
      const stats = await host.loadAll();
      assert.strictEqual(stats.failed, 1, '坏插件应被记为失败');
      assert.strictEqual(host.errors.length, 1);
      assert.strictEqual(stats.loaded, 0);
    } finally {
      cleanup(dir);
    }
  });

  await test('manifest 缺失时按约定找入口', async () => {
    const dir = makeTempProject();
    try {
      const p = path.join(dir, 'plugins', 'no-manifest');
      fs.mkdirSync(p, { recursive: true });
      fs.writeFileSync(
        path.join(p, 'index.js'),
        "module.exports = { name: 'no-manifest', setup(ctx) { ctx.registerTool({ name: 'nm_tool', description: 'x', autoApprove: true, parameters: { type: 'object', properties: {} }, async run() { return 'ok'; } }); } };",
      );
      const { host, registry } = makeHost(path.join(dir, 'plugins'));
      const stats = await host.loadAll();
      assert.strictEqual(stats.loaded, 1);
      assert.ok(registry.has('nm_tool'));
    } finally {
      cleanup(dir);
    }
  });

  await test('plugins.disabled 能禁用指定插件', async () => {
    const { host } = makeHost(path.join(ROOT, 'plugins'), {
      plugins: { enabled: true, dirs: [path.join(ROOT, 'plugins')], disabled: ['hello'], config: {} },
    });
    const stats = await host.loadAll();
    assert.strictEqual(stats.loaded, 4, '5 个插件里禁掉 hello，应剩 4 个');
    assert.ok(!host.plugins.has('hello'));
  });

  await test('脚手架能生成可加载的新插件', async () => {
    const dir = makeTempProject();
    try {
      const created = PluginHost.scaffold(path.join(dir, 'plugins'), '我的插件', { description: '测试用' });
      assert.ok(fs.existsSync(path.join(created.dir, 'manifest.json')));
      assert.ok(fs.existsSync(path.join(created.dir, 'index.js')));
      // 中文插件名要能保留，同时生成合规的 ASCII 工具名前缀
      assert.strictEqual(created.name, '我的插件');
      assert.ok(/^[a-z0-9_]+$/.test(created.toolPrefix), `工具名前缀应只含 ASCII：${created.toolPrefix}`);

      const { host, registry } = makeHost(path.join(dir, 'plugins'));
      const stats = await host.loadAll();
      assert.strictEqual(stats.loaded, 1, `生成的插件应能加载：${JSON.stringify(host.errors)}`);
      assert.ok(registry.has(`${created.toolPrefix}_demo`), `工具应注册成功，实际：${registry.list().map((t) => t.name)}`);
    } finally {
      cleanup(dir);
    }
  });

  await test('脚手架拒绝非法插件名', () => {
    const dir = makeTempProject();
    try {
      assert.throws(() => PluginHost.scaffold(path.join(dir, 'plugins'), '!!!'), /不含任何可用字符/);
    } finally {
      cleanup(dir);
    }
  });
}

/* ------------------------------------------------------------------ */
/* 4.5 插件市场：网络错误翻译 + 「装进来的是不是插件」                  */
/* ------------------------------------------------------------------ */

async function testMarket() {
  const { describeFetchError, detectInstalledPluginShape, looksLikePluginSource } = require(
    path.join(ROOT, 'src', 'web', 'plugin-market.js'),
  );
  group('4.5 插件市场');

  await test('证书类连不上时给出能照做的提示（而不是「可能需要代理」）', () => {
    // 这是本机真实踩到的：浏览器能打开 GitHub，Node 报 fetch failed，
    // 真因是中间人证书（UNABLE_TO_VERIFY_LEAF_SIGNATURE）。
    // 含糊地提示「配置代理」会把人带到完全错误的方向。
    const tls = describeFetchError({ message: 'fetch failed', cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } }, 'api.github.com');
    assert.ok(tls.includes('证书'), `要说清是证书问题：${tls}`);
    assert.ok(tls.includes('NODE_EXTRA_CA_CERTS'), '要给出导出根证书的办法');
    assert.ok(tls.includes('MYA_INSECURE_TLS'), '要给出应急开关');

    const dns = describeFetchError({ message: 'fetch failed', cause: { code: 'ENOTFOUND' } }, 'api.github.com');
    assert.ok(dns.includes('域名解析失败'), `DNS 问题要说清：${dns}`);

    const timeout = describeFetchError({ message: 'fetch failed', cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }, 'api.github.com');
    assert.ok(timeout.includes('超时') && timeout.includes('MYA_PROXY'), `超时要提示代理：${timeout}`);

    // 认不出来的错误也要原样带出来，不能吞掉
    const other = describeFetchError({ message: 'fetch failed', cause: { code: 'EUNKNOWNTHING' } }, 'api.github.com');
    assert.ok(other.includes('EUNKNOWNTHING'), `未知错误要带原始 code：${other}`);
  });

  await test('插件特征识别认得出 hook-only 插件', () => {
    // 只挂钩子、不注册工具的插件也是合法插件，不能被当成「不是插件」
    assert.ok(looksLikePluginSource('module.exports={name:"a",setup(ctx){ctx.on("tool:before",()=>{})}}'), 'setup(ctx) + 钩子要算插件');
    assert.ok(looksLikePluginSource('module.exports={name:"a",setup(ctx){ctx.registerTool({})}}'), '注册工具要算插件');
    assert.ok(looksLikePluginSource('module.exports={name:"a",setup(ctx){ctx.addPrompt("x")}}'), '加提示词要算插件');
    assert.ok(!looksLikePluginSource('const express = require("express"); module.exports = express;'), '普通项目不能被误判');
  });

  await test('装进来之前先确认它真的是插件', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-shape-'));
    const make = (name, files) => {
      const d = path.join(dir, name);
      fs.mkdirSync(d, { recursive: true });
      for (const [n, c] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(d, n)), { recursive: true });
        fs.writeFileSync(path.join(d, n), c);
      }
      return d;
    };

    const good = make('good', {
      'manifest.json': JSON.stringify({ name: 'good', version: '1.0.0', entry: 'index.js' }),
      'index.js': 'module.exports = { name: "good", setup() {} };',
    });
    assert.strictEqual(detectInstalledPluginShape(good).ok, true, '带 entry 的 manifest 插件应通过');

    const hookOnly = make('hook', { 'index.js': 'module.exports={name:"h",setup(ctx){ctx.on("tool:before",()=>{})}}' });
    assert.strictEqual(detectInstalledPluginShape(hookOnly).ok, true, '只有钩子的插件也要通过');

    // 浏览器扩展的 manifest.json 也在这个目录名上，但启用后「什么都没发生」
    const ext = make('ext', {
      'manifest.json': JSON.stringify({ manifest_version: 3, name: 'ext', version: '1.0' }),
      'main.js': 'chrome.runtime.onInstalled.addListener(() => {});',
    });
    const extResult = detectInstalledPluginShape(ext);
    assert.strictEqual(extResult.ok, false, '浏览器扩展不能被当成插件');
    assert.ok(/浏览器扩展/.test(extResult.error), `要说清为什么：${extResult.error}`);

    const plain = make('plain', { 'index.js': 'module.exports = require("./lib/app");' });
    assert.strictEqual(detectInstalledPluginShape(plain).ok, false, '普通 Node 项目要被拒绝');

    const noEntry = make('noentry', { 'manifest.json': JSON.stringify({ name: 'x', version: '1.0.0' }) });
    const noEntryResult = detectInstalledPluginShape(noEntry);
    assert.strictEqual(noEntryResult.ok, false, '有清单没入口要拒绝');
    assert.ok(/入口文件/.test(noEntryResult.error), '要说明缺入口');

    // 拒绝时的提示必须告诉用户「本项目的插件长什么样」
    assert.ok(/setup\(ctx\)/.test(plain === '' ? '' : detectInstalledPluginShape(plain).error), '错误提示要给出插件最小形态');
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

/* ------------------------------------------------------------------ */
/* 5. 会话                                                             */
/* ------------------------------------------------------------------ */

async function testSession() {
  const { Session, buildSystemPrompt, resolveContextWindowInfo } = require(path.join(ROOT, 'src', 'session.js'));
  const { setContextWindow, extractContextWindow } = require(path.join(ROOT, 'src', 'model-info.js'));
  group('5. 会话');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-session-'));
  const cfg = {
    model: 'test-model',
    provider: 'test',
    cwd: tmpDir,
    session: { save: true, dir: tmpDir, maxHistoryMessages: 200 },
    systemPromptFile: path.join(ROOT, 'prompts', 'system.zh.md'),
  };

  await test('消息追加顺序与角色正确', () => {
    const s = new Session(cfg);
    s.setSystemPrompt('你是助手');
    s.addUser('你好');
    s.addAssistant('', [{ id: 'c1', name: 'read', args: { path: 'a.js' }, rawArgs: '{"path":"a.js"}' }]);
    s.addToolResult('c1', 'read', '文件内容');
    s.addAssistant('做完了');
    const msgs = s.toMessages();
    assert.deepStrictEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'assistant']);
    assert.strictEqual(msgs[2].tool_calls[0].function.name, 'read');
    assert.strictEqual(msgs[3].tool_call_id, 'c1');
  });

  await test('发给模型的消息里没有内部字段（_ts）', () => {
    const s = new Session(cfg);
    s.setSystemPrompt('sys');
    s.addUser('hi');
    for (const m of s.toMessages()) {
      assert.strictEqual(m._ts, undefined, '_ts 不应发给模型');
    }
  });

  await test('上下文计量：拿到上游实测 usage 后按较大值算（估算对中文偏低）', () => {
    const s = new Session(cfg);
    s.setSystemPrompt('sys');
    s.addUser('请读一下这个文件并总结');
    // 上游实际报的是 5000 输入 + 800 输出；字符估算对这种短文本会明显偏小
    s.addAssistant('好的，我看完了', null, '', { prompt_tokens: 5000, completion_tokens: 800, total_tokens: 5800 });
    const ctx = s.measureContext(s.toMessages());
    assert.strictEqual(ctx.anchorUsed, true, '应该用上了实测锚点');
    assert.ok(ctx.used >= 5800, `用于计量时不能小于实测的 5800，实际 ${ctx.used}`);
    assert.ok(ctx.estimated > 0 && ctx.estimated < ctx.used, `估算值（${ctx.estimated}）应当小于等于实测锚点`);
    assert.strictEqual(s.contextRatio() > 0, true, '比例应可计算');
  });

  await test('上下文计量：压缩之后旧锚点作废（否则压了也白压）', () => {
    const s = new Session(cfg);
    s.setSystemPrompt('sys');
    for (let i = 0; i < 12; i += 1) {
      s.addUser(`第 ${i} 个问题`);
      s.addAssistant(`第 ${i} 个回答`, null, '', { prompt_tokens: 90000, completion_tokens: 1000, total_tokens: 91000 });
    }
    const before = s.measureContext(s.toMessages());
    assert.ok(before.used >= 90000, `压缩前应当带上实测锚点，实际 ${before.used}`);
    const removed = s.compactHistory(4, '这是交接说明：前面做了很多事情，细节见文件。');
    assert.ok(removed && removed.removed > 0, '应该真的压掉了内容');
    const after = s.measureContext(s.toMessages());
    assert.ok(after.used < before.used, `压缩后用量必须真的降下来（${before.used} → ${after.used}）`);
    assert.strictEqual(after.anchorUsed, false, '压缩点之后的锚点应当作废');
  });

  await test('历史裁剪不会留下孤儿 tool 消息', () => {
    const s = new Session({ ...cfg, session: { ...cfg.session, maxHistoryMessages: 6 } });
    s.setSystemPrompt('sys');
    for (let i = 0; i < 5; i += 1) {
      s.addUser(`问题${i}`);
      s.addAssistant('', [{ id: `c${i}`, name: 'read', args: {}, rawArgs: '{}' }]);
      s.addToolResult(`c${i}`, 'read', `结果${i}`);
      s.addAssistant(`回答${i}`);
    }
    const msgs = s.toMessages();
    assert.ok(msgs.length <= 6, `裁剪后条数应受控，实际 ${msgs.length}`);
    // 第一条非 system 消息不能是 tool
    const firstNonSystem = msgs.find((m) => m.role !== 'system');
    assert.notStrictEqual(firstNonSystem.role, 'tool', '裁剪后不应以 tool 消息开头');
    // 每个 tool 消息都必须有其 assistant.tool_calls 在前
    for (let i = 0; i < msgs.length; i += 1) {
      if (msgs[i].role === 'tool') {
        const hasParent = msgs.slice(0, i).some((m) => m.tool_calls && m.tool_calls.some((t) => t.id === msgs[i].tool_call_id));
        assert.ok(hasParent, `tool 消息 ${msgs[i].tool_call_id} 找不到对应的 tool_calls`);
      }
    }
  });

  await test('保存 / 恢复会话', () => {
    const s = new Session(cfg, { title: '测试会话' });
    s.setSystemPrompt('sys');
    s.addUser('记住这个');
    s.recordUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    assert.ok(s.save(), '保存应成功');

    const loaded = Session.load(cfg, s.id);
    assert.ok(loaded, '应能恢复会话');
    assert.strictEqual(loaded.title, '测试会话');
    assert.strictEqual(loaded.messages.length, s.messages.length);
    assert.strictEqual(loaded.usage.totalTokens, 15);
  });

  await test('会话列表按更新时间倒序', () => {
    const list = Session.list(cfg, 10);
    assert.ok(list.length >= 1);
    assert.ok(list[0].id);
  });

  await test('会话列表带上工作目录与用量（界面要用）', () => {
    const s = new Session(cfg, { title: '带目录', cwd: tmpDir });
    s.setSystemPrompt('sys');
    s.addUser('你好');
    s.save();
    const item = Session.list(cfg, 50).find((x) => x.id === s.id);
    assert.ok(item, '应能列出刚保存的会话');
    assert.strictEqual(item.cwd, tmpDir, '工作目录要一起列出来');
    assert.ok(item.usage, '用量要带出来，界面列表能显示规模');
    assert.ok(item.messageCount >= 2, '消息条数要带出来');
    assert.ok(!/app\.asar/.test(JSON.stringify(item)), '不能出现 asar 路径');
  });

  await test('删掉磁盘上的会话文件', () => {
    const s = new Session(cfg, { title: '待删除' });
    s.setSystemPrompt('sys');
    s.save();
    assert.ok(fs.existsSync(s.filePath), '前置条件：文件应存在');
    assert.strictEqual(Session.removeFile(cfg, s.id), true, '应删除成功');
    assert.ok(!fs.existsSync(s.filePath), '文件应被删除');
    assert.strictEqual(Session.removeFile(cfg, s.id), false, '重复删除应返回 false（不报错）');
  });

  /* ---------------- 上下文窗口的来源 ---------------- */

  await test('上下文窗口：用户配置 > 网关 > 推断', () => {
    const project = makeTempProject();
    const base = { ...cfg, dataDir: path.join(project, '.mya'), provider: 'custom', model: 'some-model-x' };
    // 1) 谁都没说 → 推断
    let info = resolveContextWindowInfo(base);
    assert.strictEqual(info.source, 'estimate', '没有别的信息时按模型名推断');
    assert.ok(info.window > 0);

    // 2) 网关说了 → 用网关的（这是权威值）
    setContextWindow(base, 'some-model-x', 32000, 'gateway');
    info = resolveContextWindowInfo(base);
    assert.strictEqual(info.window, 32000, '网关给的值要优先于推断');
    assert.strictEqual(info.source, 'gateway');

    // 3) 用户显式配了 → 用户最大
    info = resolveContextWindowInfo({ ...base, contextWindow: 4096 });
    assert.strictEqual(info.window, 4096);
    assert.strictEqual(info.source, 'config');
  });

  await test('网关的窗口缓存按「地址 + 模型」区分', () => {
    const project = makeTempProject();
    const dir = path.join(project, '.mya');
    const a = { ...cfg, dataDir: dir, provider: 'custom', baseUrl: 'https://a.example/v1', model: 'm1' };
    const b = { ...cfg, dataDir: dir, provider: 'custom', baseUrl: 'https://b.example/v1', model: 'm1' };
    setContextWindow(a, 'm1', 8000, 'gateway');
    assert.strictEqual(resolveContextWindowInfo(a).window, 8000, 'a 网关的值要读得到');
    assert.strictEqual(resolveContextWindowInfo(b).source, 'estimate', '换了网关就不该沿用别人的窗口');
    setContextWindow(b, 'm1', 200000, 'gateway');
    assert.strictEqual(resolveContextWindowInfo(a).window, 8000, '两个网关各记各的');
    assert.strictEqual(resolveContextWindowInfo(b).window, 200000);
  });

  await test('认得出各家网关的窗口字段，但不认「输出上限」', () => {
    assert.strictEqual(extractContextWindow({ context_length: 128000 }), 128000, 'OpenRouter 风格');
    assert.strictEqual(extractContextWindow({ inputTokenLimit: 1048576 }), 1048576, 'Gemini 风格');
    assert.strictEqual(extractContextWindow({ max_context_length: '32000' }), 32000, '字符串数字也要认');
    // max_tokens / outputTokenLimit 说的是「最多输出多少」，拿它当窗口会小得离谱
    assert.strictEqual(extractContextWindow({ max_tokens: 4096 }), 0, '输出上限不能当窗口');
    assert.strictEqual(extractContextWindow({ outputTokenLimit: 8192 }), 0, '同理');
    assert.strictEqual(extractContextWindow(null), 0);
    assert.strictEqual(extractContextWindow({}), 0);
  });

  await test('模型列表会把网关给的窗口大小一起解析出来', () => {
    const { OpenAICompatProvider } = require(path.join(ROOT, 'src', 'providers', 'openai.js'));
    const p = new OpenAICompatProvider({ ...cfg, baseUrl: 'https://x.example/v1', model: 'm' });
    const models = p.parseModels({
      data: [
        { id: 'plain-model' },
        { id: 'big-model', context_length: 200000 },
        { id: 'models/gemini-2.0-flash', inputTokenLimit: 1048576 },
      ],
    });
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    assert.ok(byId['big-model'].contextWindow === 200000, `应解析出窗口：${JSON.stringify(byId['big-model'])}`);
    assert.ok(byId['gemini-2.0-flash'].contextWindow === 1048576, 'Gemini 的前缀要去掉、窗口要认');
    assert.ok(byId['plain-model'].contextWindow === undefined, '没给就不编造');
  });

  await test('系统提示词模板变量被替换', () => {
    const prompt = buildSystemPrompt(cfg, { toolNames: ['read', 'write'] });
    assert.ok(prompt.includes(tmpDir.replace(/\\/g, '\\')) || prompt.includes(tmpDir), '应替换 {{cwd}}');
    assert.ok(prompt.includes('read, write'), '应替换 {{toolNames}}');
    assert.ok(!prompt.includes('{{'), '不应残留未替换的变量');
  });

  await test('提示词文件缺失时回退到内置默认', () => {
    const prompt = buildSystemPrompt({ ...cfg, systemPromptFile: path.join(tmpDir, '不存在.md') }, { toolNames: ['read'] });
    assert.ok(prompt.includes('梦云 Agent'));
    assert.ok(prompt.includes('read'));
  });

  await test('导出 Markdown', () => {
    const s = new Session(cfg);
    s.setSystemPrompt('sys');
    s.addUser('问题');
    s.addAssistant('答案');
    const md = s.toMarkdown();
    assert.ok(md.includes('## 用户') && md.includes('## 助手'));
  });

  cleanup(tmpDir);
}

/* ------------------------------------------------------------------ */
/* 6. Agent 主循环（用假模型）                                          */
/* ------------------------------------------------------------------ */

async function testAgentLoop() {
  const { ChatAgent } = require(path.join(ROOT, 'src', 'agent.js'));
  const { ToolRegistry } = require(path.join(ROOT, 'src', 'tools.js'));
  const { EventBus } = require(path.join(ROOT, 'src', 'events.js'));
  group('6. Agent 主循环');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-agent-'));

  function makeCfg(overrides = {}) {
    return {
      model: 'fake-model',
      provider: 'fake',
      cwd: tmpDir,
      maxTurns: 5,
      session: { save: false, dir: tmpDir, maxHistoryMessages: 200 },
      tools: { autoApprove: ['read'], deny: [], maxOutputChars: 30000 },
      plugins: { enabled: false, dirs: [], disabled: [], config: {} },
      systemPromptFile: '',
      ...overrides,
    };
  }

  /** 假模型：按脚本依次返回预设回复，并记录收到的请求 */
  function fakeProvider(script) {
    const calls = [];
    return {
      calls,
      model: 'fake-model',
      /** 想让每一步的用量不同时，往这里塞几个 usage（测试「累计」用） */
      usageQueue: [],
      async chat(req) {
        calls.push({ messages: JSON.parse(JSON.stringify(req.messages)), toolNames: (req.tools || []).map((t) => t.function.name) });
        const step = script.shift() || { text: '（脚本用完了）', toolCalls: [] };
        // 推理模型的思维链：分两段回调，模拟真实流式（累积文本要一起给）
        if (step.reasoning && req.onReasoning) {
          const whole = String(step.reasoning);
          const cut = Math.ceil(whole.length / 2);
          req.onReasoning(whole.slice(0, cut), whole.slice(0, cut));
          req.onReasoning(whole.slice(cut), whole);
        }
        if (req.onDelta && step.text) req.onDelta(step.text, step.text);
        return {
          text: step.text || '',
          reasoning: step.reasoning || '',
          toolCalls: step.toolCalls || [],
          usage: this.usageQueue.length ? this.usageQueue.shift() : { total_tokens: 10 },
          finishReason: 'stop',
        };
      },
    };
  }

  function makeAgent(cfg, script) {
    const bus = new EventBus();
    const registry = new ToolRegistry(cfg, bus);
    registry.register(
      { name: 'read', autoApprove: true, description: '读', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, async run(args) { return `内容:${args.path}`; } },
      'builtin',
    );
    registry.register(
      { name: 'slow_write', dangerous: true, description: '写', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, async run(args) { return `已写:${args.path}`; } },
      'builtin',
    );
    const provider = fakeProvider(script);
    const agent = new ChatAgent({ cfg, provider, registry, plugins: null, bus });
    return { agent, registry, provider, bus };
  }

  await test('无工具调用时直接结束，返回最终文本', async () => {
    const cfg = makeCfg();
    const { agent, provider } = makeAgent(cfg, [{ text: '这是最终答案' }]);
    const session = agent.createSession();
    const result = await agent.run(session, '你好', { verbose: false });
    assert.strictEqual(result.text, '这是最终答案');
    assert.strictEqual(result.toolCalls, 0);
    assert.strictEqual(provider.calls.length, 1);
  });

  await test('一次工具调用后继续推理，最终给出答案', async () => {
    const cfg = makeCfg();
    const { agent, provider } = makeAgent(cfg, [
      { text: '', toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.js' }, rawArgs: '{"path":"a.js"}' }] },
      { text: '文件内容我看过了，是内容:a.js' },
    ]);
    const session = agent.createSession();
    const result = await agent.run(session, '读一下 a.js', { verbose: false });

    assert.strictEqual(provider.calls.length, 2, '应该问两次模型');
    assert.strictEqual(result.toolCalls, 1);
    assert.ok(result.text.includes('内容:a.js'));

    // 第二次请求里应该带上工具执行结果
    const secondMsgs = provider.calls[1].messages;
    const toolMsg = secondMsgs.find((m) => m.role === 'tool');
    assert.ok(toolMsg, '第二次请求必须包含 tool 结果消息');
    assert.strictEqual(toolMsg.content, '内容:a.js');
    assert.strictEqual(toolMsg.tool_call_id, 'c1');
  });

  await test('思考过程会推事件、也会存进会话，但不进下一次请求', async () => {
    const cfg = makeCfg();
    const { agent, provider, bus } = makeAgent(cfg, [
      { reasoning: '我需要先读文件才能回答', text: '这是最终答案' },
    ]);
    const reasoningEvents = [];
    const doneEvents = [];
    bus.on('assistant:reasoning', (p) => reasoningEvents.push(p.text));
    bus.on('assistant:done', (p) => doneEvents.push(p));

    const session = agent.createSession();
    const result = await agent.run(session, '读文件', { verbose: false });

    assert.strictEqual(reasoningEvents.length, 2, '两段思考应各推一次事件');
    assert.strictEqual(reasoningEvents[1], '我需要先读文件才能回答', '最后一次事件应带完整思考');
    assert.strictEqual(doneEvents[0].reasoning, '我需要先读文件才能回答', 'assistant:done 应带上完整思考');
    assert.strictEqual(result.reasoning, '我需要先读文件才能回答', '返回值里也要有');

    // 思考要能回放（刷新页面后还在），但不能发给模型
    const stored = session.messages.find((m) => m.role === 'assistant');
    assert.ok(stored._reasoning, '思考内容应存进会话历史');
    const sent = JSON.stringify(provider.calls[0].messages);
    assert.ok(!sent.includes('我需要先读文件'), '思考内容不能出现在请求里');
  });

  await test('每一步都会报 token（含累计值）', async () => {
    const cfg = makeCfg({ maxTurns: 10 });
    const { agent, provider, bus } = makeAgent(cfg, [
      { text: '', toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a.js' }, rawArgs: '{}' }] },
      { text: '读完了' },
    ]);
    // 两次请求给不同的用量，才能看出「每一步」和「累计」的区别
    provider.usageQueue = [
      { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 },
    ];

    const steps = [];
    bus.on('step:usage', (p) => steps.push(p));
    const session = agent.createSession();
    await agent.run(session, '读个文件', { verbose: false });

    assert.strictEqual(steps.length, 2, `两步应各报一次，实际 ${steps.length}`);
    assert.strictEqual(steps[0].usage.totalTokens, 120, '第一步是这一步的量');
    assert.strictEqual(steps[0].cumulative.totalTokens, 120, '第一步累计也是 120');
    assert.strictEqual(steps[1].usage.totalTokens, 340, '第二步应报第二步的量');
    assert.strictEqual(steps[1].cumulative.totalTokens, 460, `累计应该是 120+340，实际 ${steps[1].cumulative.totalTokens}`);
    assert.strictEqual(steps[1].turn, 2, '要带上这是第几步');

    // 每一步的用量要落进会话，否则刷新页面就看不见了
    const assistants = session.messages.filter((m) => m.role === 'assistant');
    assert.ok(assistants[0]._usage, '第一步的用量应存进 assistant 消息');
    assert.strictEqual(assistants[0]._usage.totalTokens, 120);
    assert.ok(!JSON.stringify(session.toMessages()).includes('_usage'), '内部字段不能发给模型');
  });

  await test('会话可以用自己的工作目录', async () => {
    const cfg = makeCfg();
    const { agent } = makeAgent(cfg, [{ text: '好' }]);
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-workdir-'));

    const session = agent.createSession({ title: '在别处干活', cwd: other });
    assert.strictEqual(session.cwd, other, 'createSession 不能把用户选的目录覆盖成全局 cwd');
    assert.ok(session.getSystemPrompt().includes(other), '系统提示词里要写这个会话的目录，否则模型会按错的路径找文件');

    // 工具拿到的 cwd 也必须是这个会话的目录（路径越界检查以此为准）
    const ctx = agent.makeRunContext(session, {});
    assert.strictEqual(path.resolve(ctx.cwd), path.resolve(other), `工具的运行目录不对：${ctx.cwd}`);
    ctx.cwd = undefined;

    // 没传目录时回落到全局配置
    const fallback = agent.createSession({});
    assert.strictEqual(fallback.cwd, cfg.cwd, '不指定时用全局工作目录');
  });

  await test('每轮请求前会广播上下文用量', async () => {
    const cfg = makeCfg({ contextWindow: 4096 });
    const { agent, bus } = makeAgent(cfg, [{ text: '好' }]);
    const contexts = [];
    bus.on('turn:context', (p) => contexts.push(p.context));

    const session = agent.createSession();
    await agent.run(session, '随便说点什么', { verbose: false });

    assert.strictEqual(contexts.length, 1, '每轮应广播一次上下文用量');
    assert.strictEqual(contexts[0].window, 4096, '窗口大小应来自配置');
    assert.ok(contexts[0].used > 0, '应估算出用量');
    assert.ok(contexts[0].messages >= 2, `应记录消息条数，实际 ${contexts[0].messages}`);
  });

  await test('连续三轮工具调用（多步任务）', async () => {
    const cfg = makeCfg({ maxTurns: 10 });
    const { agent, provider } = makeAgent(cfg, [
      { text: '', toolCalls: [{ id: 'c1', name: 'read', args: { path: '1.js' }, rawArgs: '{}' }] },
      { text: '', toolCalls: [{ id: 'c2', name: 'read', args: { path: '2.js' }, rawArgs: '{}' }] },
      { text: '', toolCalls: [{ id: 'c3', name: 'read', args: { path: '3.js' }, rawArgs: '{}' }] },
      { text: '三个文件都读完了' },
    ]);
    const session = agent.createSession();
    const result = await agent.run(session, '读三个文件', { verbose: false });
    assert.strictEqual(result.toolCalls, 3);
    assert.strictEqual(provider.calls.length, 4);
    assert.ok(result.text.includes('三个文件'));
  });

  await test('同一轮多个工具并行执行', async () => {
    const cfg = makeCfg();
    const { agent, provider } = makeAgent(cfg, [
      {
        text: '',
        toolCalls: [
          { id: 'c1', name: 'read', args: { path: 'a' }, rawArgs: '{}' },
          { id: 'c2', name: 'read', args: { path: 'b' }, rawArgs: '{}' },
        ],
      },
      { text: '都读完了' },
    ]);
    const session = agent.createSession();
    const result = await agent.run(session, '读 a 和 b', { verbose: false });
    assert.strictEqual(result.toolCalls, 2);
    const toolMsgs = provider.calls[1].messages.filter((m) => m.role === 'tool');
    assert.strictEqual(toolMsgs.length, 2);
    assert.ok(toolMsgs.some((m) => m.content === '内容:a'));
    assert.ok(toolMsgs.some((m) => m.content === '内容:b'));
  });

  await test('工具参数不合法时把错误回填给模型，而不是崩溃', async () => {
    const cfg = makeCfg();
    const { agent, provider } = makeAgent(cfg, [
      { text: '', toolCalls: [{ id: 'c1', name: 'read', args: {}, rawArgs: '{}' }] },
      { text: '抱歉，我漏了 path 参数' },
    ]);
    const session = agent.createSession();
    const result = await agent.run(session, '读文件', { verbose: false });
    const toolMsg = provider.calls[1].messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg.content.includes('缺少必填参数'), toolMsg.content);
    assert.ok(result.text.includes('漏了'));
  });

  await test('用户拒绝工具后，模型收到拒绝原因', async () => {
    const cfg = makeCfg({ assumeYes: false });
    const { agent, provider } = makeAgent(cfg, [
      { text: '', toolCalls: [{ id: 'c1', name: 'slow_write', args: { path: 'x' }, rawArgs: '{}' }] },
      { text: '好的，那我不写文件了' },
    ]);
    // 模拟用户拒绝
    const ui = require(path.join(ROOT, 'src', 'ui.js'));
    const originalConfirm = ui.confirm;
    ui.confirm = async () => false;
    try {
      const session = agent.createSession();
      await agent.run(session, '写文件', { verbose: false });
      const toolMsg = provider.calls[1].messages.find((m) => m.role === 'tool');
      assert.ok(toolMsg.content.includes('拒绝'), toolMsg.content);
    } finally {
      ui.confirm = originalConfirm;
    }
  });

  await test('达到 maxTurns 上限时主动停下并说明', async () => {
    const cfg = makeCfg({ maxTurns: 2 });
    const script = [];
    for (let i = 0; i < 5; i += 1) {
      script.push({ text: '', toolCalls: [{ id: `c${i}`, name: 'read', args: { path: `${i}` }, rawArgs: '{}' }] });
    }
    const { agent, provider } = makeAgent(cfg, script);
    const session = agent.createSession();
    const result = await agent.run(session, '一直读', { verbose: false });
    assert.strictEqual(provider.calls.length, 2, '不应超过 maxTurns 次模型调用');
    assert.ok(result.text.includes('最大工具调用轮数'), result.text);
  });

  await test('模型报错时向上抛出，且会话被保存', async () => {
    const cfg = makeCfg();
    const { agent } = makeAgent(cfg, []);
    agent.provider.chat = async () => {
      throw new Error('接口炸了');
    };
    const session = agent.createSession();
    let threw = false;
    try {
      await agent.run(session, '你好', { verbose: false });
    } catch (err) {
      threw = true;
      assert.ok(err.message.includes('接口炸了'));
    }
    assert.ok(threw, '模型错误应该抛出来');
    assert.strictEqual(agent.isRunning, false, '异常后 running 标志要复位');
  });

  await test('事件总线按顺序抛出关键事件', async () => {
    const cfg = makeCfg();
    const { agent, bus } = makeAgent(cfg, [
      { text: '', toolCalls: [{ id: 'c1', name: 'read', args: { path: 'a' }, rawArgs: '{}' }] },
      { text: '完成' },
    ]);
    const seen = [];
    for (const ev of ['session:start', 'turn:start', 'assistant:done', 'tool:after', 'turn:end', 'session:end']) {
      bus.on(ev, () => seen.push(ev));
    }
    const session = agent.createSession();
    await agent.run(session, '读文件', { verbose: false });
    assert.ok(seen.includes('session:start'));
    assert.ok(seen.includes('tool:after'));
    assert.ok(seen.includes('turn:end'));
    assert.strictEqual(seen[seen.length - 1], 'session:end', '最后一个事件应是 session:end');
    assert.strictEqual(seen.filter((e) => e === 'turn:end').length, 2, '两轮应抛两次 turn:end');
  });

  await test('messages:before 钩子能注入上下文', async () => {
    const cfg = makeCfg();
    const { agent, provider, bus } = makeAgent(cfg, [{ text: '好的' }]);
    bus.on('messages:before', (e) => {
      e.messages.push({ role: 'system', content: '插件注入的额外指令' });
    });
    const session = agent.createSession();
    await agent.run(session, '你好', { verbose: false });
    assert.ok(
      provider.calls[0].messages.some((m) => m.content === '插件注入的额外指令'),
      '注入的消息应出现在请求中',
    );
  });

  cleanup(tmpDir);
}

/* ------------------------------------------------------------------ */
/* 7. CLI 冒烟测试                                                     */
/* ------------------------------------------------------------------ */

function testCli() {
  group('7. CLI 冒烟测试');

  const run = (args, opts = {}) =>
    spawnSync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
      ...opts,
    });

  const cases = [
    { name: 'mya --version', args: ['--version'], expect: /v\d+\.\d+\.\d+/ },
    { name: 'mya --help', args: ['--help'], expect: /用法/ },
    { name: 'mya tools', args: ['tools'], expect: /可用工具/ },
    { name: 'mya plugins', args: ['plugins'], expect: /已加载插件/ },
    { name: 'mya config', args: ['config'], expect: /当前生效配置/ },
    { name: 'mya sessions', args: ['sessions'], expect: /历史会话/ },
  ];

  const pending = [];
  for (const c of cases) {
    pending.push(
      (async () => {
        await test(c.name, () => {
          const res = run(c.args);
          const output = `${res.stdout || ''}${res.stderr || ''}`;
          assert.ok(!res.error, `执行出错：${res.error && res.error.message}`);
          assert.strictEqual(res.status, 0, `退出码应为 0，实际 ${res.status}\n${output.slice(0, 800)}`);
          assert.ok(c.expect.test(output), `输出不符合预期（期望 ${c.expect}）：\n${output.slice(0, 800)}`);
        });
      })(),
    );
  }
  return Promise.all(pending);
}

/* ------------------------------------------------------------------ */
/* 汇总                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const startedAt = Date.now();
  console.log('\n\x1b[1m\x1b[35m梦云 Agent 自测\x1b[0m');
  console.log('\x1b[90m全部离线运行，不消耗 API 额度\x1b[0m');

  await testConfig();
  await testUtils();
  await testRegistry();
  await testPlugins();
  await testMarket();
  await testSession();
  await testAgentLoop();
  await testCli();

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  const ms = Date.now() - startedAt;

  console.log(`\n${'─'.repeat(50)}`);
  if (failed.length === 0) {
    console.log(`\x1b[32m\x1b[1m全部通过：${passed} 项测试（${ms}ms）\x1b[0m`);
  } else {
    console.log(`\x1b[31m\x1b[1m${failed.length} 项失败 / 共 ${passed + failed.length} 项（${ms}ms）\x1b[0m`);
    console.log('');
    for (const f of failed) {
      console.log(`\x1b[31m  ✗ [${f.group}] ${f.name}\x1b[0m`);
      console.log(`    ${String(f.error && f.error.message).split('\n').join('\n    ')}`);
    }
    console.log('');
    console.log('\x1b[90m提示：加 MYA_DEBUG=1 可以看到完整堆栈\x1b[0m');
  }
  console.log('');

  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error('\n\x1b[31m自测脚本自身出错：\x1b[0m', err);
  process.exitCode = 1;
});
