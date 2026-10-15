'use strict';

/**
 * 梦云 Agent —— 桌面程序验证
 *
 * 检查「双击之后到底能不能用」这件事，全部离线：
 *   1. Electron 是否就位、能否定位到可执行文件
 *   2. 真正启动一次桌面程序，让它自己检查：
 *      窗口标题、页面渲染、preload 桥注入、界面能连上本地服务
 *   3. 干净环境（没有 API Key）下也能打开窗口并给出配置引导
 *
 * 用法：
 *   node test/desktop-e2e.js
 *
 * 没装 Electron 时不会失败，只会明确告诉你「已跳过」——因为桌面组件
 * 是可选的，浏览器界面同样能用。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/** 图标生成器（导出的是纯函数，测试里直接用来验格式） */
const iconGen = require(path.join(ROOT, 'desktop', 'make-icon.js'));
const ICO_SIZES = iconGen.ICO_SIZES;

/* ------------------------------------------------------------------ */
/* 迷你测试框架                                                        */
/* ------------------------------------------------------------------ */

const results = [];
let group = '';

function section(name) {
  group = name;
  console.log(`\n\x1b[36m▌ ${name}\x1b[0m`);
}

async function test(name, fn) {
  try {
    await fn();
    results.push({ group, name, ok: true });
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    results.push({ group, name, ok: false, error: err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${err.message}\x1b[0m`);
  }
}

function skip(name, reason) {
  results.push({ group, name, ok: true, skipped: true });
  console.log(`  \x1b[90m○ ${name}（已跳过：${reason}）\x1b[0m`);
}

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

/**
 * 桌面自检用的沙箱：一个临时目录，同时充当工作空间与「配置目录」的宿主。
 *
 * 配置目录在这里就是 `<sandbox>/profile`——runSelftest 用 `--user-data-dir` 把
 * Electron 的 userData 隔离到这里，而程序默认把配置放在 userData 里
 * （setupConfigDir 的优先级：显式 MYA_CONFIG_DIR > userData），
 * 所以往 profile 里写 config.json 就是给它喂配置，不动用户真实数据。
 *
 * @param {{withModel?: boolean}} opts
 *   withModel=true  —— 写一份「看起来已配置」的 config.json（自检不发真实请求，
 *                      地址给占位值即可）；false —— 干净环境，验证首次使用引导。
 * @returns {string} 沙箱目录路径
 */
function makeSandbox({ withModel = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-desktop-'));
  const profile = path.join(dir, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  if (withModel) {
    // 占位地址即可：自检只会验证「报告已配置 / 本地接口可用」，不会真的调用模型。
    // 模型名要用真实厂商前缀（deepseek/gpt/…）：界面按前缀分组，
    // 分组探针断言「默认展开含当前模型的那一组」靠的就是这个前缀。
    fs.writeFileSync(
      path.join(profile, 'config.json'),
      JSON.stringify(
        {
          provider: 'custom',
          baseUrl: 'http://127.0.0.1:9/v1',
          apiKey: 'sk-selftest-placeholder',
          model: 'deepseek-chat',
        },
        null,
        2,
      ),
    );
  }
  return dir;
}

/**
 * 从 startPort 开始找一个真的空闲端口
 *
 * 为什么不能随机挑：占位测试端口写死的话，在用户自己的机器上
 * 很可能真被别的程序占着——那样测试自己就失败了。
 */
function findFreePort(startPort) {
  return new Promise((resolve, reject) => {
    let port = startPort;
    const tryOne = () => {
      if (port > startPort + 50) {
        reject(new Error('找不到空闲端口'));
        return;
      }
      const probe = http.createServer();
      probe.once('error', () => {
        port += 1;
        tryOne();
      });
      probe.listen(port, '127.0.0.1', () => {
        probe.close(() => resolve(port));
      });
    };
    tryOne();
  });
}

function runSelftest(sandbox, extraEnv = {}, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const exe = require(path.join(ROOT, 'src', 'desktop.js')).findElectron();
    if (!exe) {
      resolve({ skipped: true });
      return;
    }

    const env = {
      ...process.env,
      NO_COLOR: '1',
      MYA_WORKSPACE: sandbox,
      // 清掉可能干扰的环境变量，强制用沙箱里的配置
      MYA_API_KEY: '',
      MYA_BASE_URL: '',
      MYA_MODEL: '',
      MYA_PROVIDER: '',
      MYA_DESKTOP_SELFTEST: '1',
      ...extraEnv,
    };

    // Electron 的 profile（单实例锁、缓存、自检报告、截图）也隔离到沙箱里：
    // 不去动用户真实的 %APPDATA%，也不会被「用户正开着程序」挡住
    const profile = makeIsolatedProfile(sandbox);

    const child = spawn(
      exe,
      [path.join(ROOT, 'desktop', 'main.js'), '--selftest', `--user-data-dir=${profile}`],
      {
        cwd: ROOT,
        env,
        // Electron 在 Windows 上是 GUI 程序，不带 shell 直接跑
        windowsHide: true,
      },
    );

    let out = '';
    let err = '';
    let settled = false;

    // 每次跑之前先清掉旧报告，并记下起点时间——跑完只认这之后的报告
    clearReports();
    const startedAt = Date.now();

    const finish = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 报告是进程退出时写的，等它落盘再读
      let report = readReport(startedAt);
      for (let i = 0; i < 30 && !report; i += 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        report = readReport(startedAt);
      }
      resolve({ code: child.exitCode, out, err, report, ...extra });
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      finish({ timedOut: true });
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => finish({ code }));
    child.on('error', (e) => finish({ spawnError: e.message }));
  });
}

/** 自检报告可能落在几个位置（打包版和开发版的 userData 目录名不同，还有临时目录兜底） */
function reportCandidates() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const tmp = os.tmpdir();
  return [
    // 用 --user-data-dir 把 profile 指到沙箱时，报告就落在那里（最精确的一条）
    ...extraReportPaths,
    path.join(appData, 'mengyun-agent', 'selftest-report.txt'),
    path.join(appData, '梦云Agent', 'selftest-report.txt'),
    path.join(appData, 'Electron', 'selftest-report.txt'),
    path.join(localAppData, 'mengyun-agent', 'selftest-report.txt'),
    // 备用路径（主进程写不进 userData 时会退到这里）
    path.join(tmp, 'mya-selftest-report.txt'),
    path.join(tmp, '..', 'mya-selftest-report.txt'),
  ];
}

/**
 * 额外要盯的报告路径。
 *
 * 为什么需要它：自检（含窗口截图、单实例锁、缓存）都住在 Electron 的
 * profile 目录里。测试如果不管这个目录，就会去动用户真实的 %APPDATA%，
 * 更糟的是——用户自己开着一个实例时，程序启动后 requestSingleInstanceLock()
 * 拿不到锁会直接退出，报告一个字都不写，测试只看到「打包版没有写出自检报告」
 * 这种和真实原因毫不相干的失败（踩过）。所以两边都把 profile 指到沙箱里。
 */
const extraReportPaths = [];

/** 给某次自检准备一个隔离的 Electron profile，并把它的报告路径登记下来 */
function makeIsolatedProfile(sandbox) {
  const profile = path.join(sandbox, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  const report = path.join(profile, 'selftest-report.txt');
  if (!extraReportPaths.includes(report)) extraReportPaths.push(report);
  return profile;
}

/** 清掉旧报告，避免读到上一次的结果 */
function clearReports() {
  for (const p of reportCandidates()) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 读最新的那份报告。
 *
 * 必须按修改时间排序，而不是「取第一个存在的」——自检可能把报告写到多个
 * 候选路径（程序目录不可写时会退到备用路径），第一个存在的未必是这次的。
 * 之前就因为读到上一次的残留报告，误报了一项失败，白查半天。
 *
 * @param {number} [sinceMs] 只接受这个时间点之后写出的报告
 */
function readReport(sinceMs = 0) {
  const hits = [];
  for (const p of reportCandidates()) {
    try {
      if (!fs.existsSync(p)) continue;
      const stat = fs.statSync(p);
      hits.push({ path: p, mtime: stat.mtimeMs, size: stat.size });
    } catch {
      /* 忽略读不到的 */
    }
  }
  if (!hits.length) return '';
  hits.sort((a, b) => b.mtime - a.mtime);
  // 只要最新那份是本次跑出来的就够；否则说明程序没写出报告
  if (sinceMs && hits[0].mtime < sinceMs - 2000) return '';
  try {
    return fs.readFileSync(hits[0].path, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

/** 从自检输出里解析出每一项检查 */
function parseChecks(output) {
  const checks = [];
  for (const line of String(output).split('\n')) {
    const m = /^\s*([✓✗])\s+(.+?)\s*$/.exec(line.trim());
    if (m) checks.push({ ok: m[1] === '✓', name: m[2] });
  }
  return checks;
}

/**
 * 合并 stdout 和报告文件里的检查项。
 * 打包成 exe 之后没有 stdout，只能靠报告文件——所以两边都读。
 */
function collectChecks(result) {
  const fromStdout = parseChecks(result.out || '');
  const report = result.report || readReport();
  const fromReport = parseChecks(report);
  // 去重（两边都有时以 stdout 为准，它的信息更新）
  const seen = new Set(fromStdout.map((c) => c.name.replace(/\d+/g, '#')));
  const merged = [...fromStdout];
  for (const c of fromReport) {
    const key = c.name.replace(/\d+/g, '#');
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(c);
    }
  }
  return { checks: merged, report };
}

/* ------------------------------------------------------------------ */
/* 打包产物测试                                                        */
/* ------------------------------------------------------------------ */

/** 找 dist 目录下的免安装 exe */
function findPackagedExe() {
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) return null;
  try {
    const hits = fs.readdirSync(distDir).filter((f) => /\.exe$/i.test(f));
    if (!hits.length) return null;
    return path.join(distDir, hits[0]);
  } catch {
    return null;
  }
}

/**
 * 跑打包后的 exe，结论从报告文件读（它是 GUI 子系统进程，没有 stdout）。
 *
 * MYA_CONFIG_DIR 指向沙箱：打包版的配置默认写在用户数据目录，
 * 测试不能去动用户真实的配置，所以显式指到临时目录。
 * 这同时也验证了「配置目录可被环境变量覆盖」这条路径。
 */
function runPackagedSelftest(exePath, sandbox, timeoutMs = 120000) {
  return new Promise((resolve) => {
    clearReports();
    const cfgDir = path.join(sandbox, 'userdata');
    fs.mkdirSync(cfgDir, { recursive: true });
    // profile 也要隔离：打包版和开发版共用同一个单实例锁，
    // 用户自己开着程序时，这里的自检进程会因为拿不到锁而静默退出
    // （表现就是「没有写出自检报告」），顺手也就不会去写用户真实数据目录
    const profile = makeIsolatedProfile(sandbox);
    const child = spawn(exePath, ['--selftest', `--user-data-dir=${profile}`], {
      cwd: sandbox,
      env: {
        ...process.env,
        NO_COLOR: '1',
        MYA_WORKSPACE: sandbox,
        MYA_DESKTOP_SELFTEST: '1',
        MYA_CONFIG_DIR: cfgDir,
      },
      windowsHide: true,
    });

    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    let spawnError = '';
    let out = '';
    let err = '';
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 只认本次启动之后写出的报告，避免读到上一次的残留
      let report = readReport(startedAt);
      for (let i = 0; i < 30 && !report; i += 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        report = readReport(startedAt);
      }
      // 诊断信息：失败时最想知道的就是「它到底跑了多久、profile 里有没有落地东西」
      let profileFiles = -1;
      try {
        profileFiles = fs.existsSync(profile) ? fs.readdirSync(profile).length : -1;
      } catch {
        /* 忽略 */
      }
      resolve({
        code: child.exitCode,
        report,
        timedOut,
        spawnError,
        elapsedMs: Date.now() - startedAt,
        profileFiles,
        out,
        err,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* 忽略 */
      }
      finish();
    }, timeoutMs);

    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', () => finish());
    child.on('error', (e) => {
      spawnError = e && e.message ? e.message : String(e);
      finish();
    });
  });
}

/** 把打包版自检的失败原因说得清楚一点：进程跑了多久、profile 里有没有东西 */
function describePackagedRun(r) {
  const bits = [`进程退出码 ${r.code}`, `耗时 ${(r.elapsedMs / 1000).toFixed(1)}s`];
  if (r.spawnError) bits.push(`启动失败：${r.spawnError}`);
  bits.push(`隔离 profile 里落地了 ${r.profileFiles} 项`);
  const tail = (s) => String(s || '').trim().split('\n').slice(-3).join(' / ').slice(0, 400);
  if (tail(r.out)) bits.push(`stdout：${tail(r.out)}`);
  if (tail(r.err)) bits.push(`stderr：${tail(r.err)}`);
  return bits.join('；');
}

/**
 * 检查 exe 里嵌入的图标是不是我们生成的那个。
 *
 * 为什么要专门验这个：electron-builder 找不到图标时不会报错，
 * 只会静默用 Electron 默认图标——从日志里完全看不出来。
 * 所以唯一可靠的办法是把图标从 exe 里抠出来，和源图比像素。
 *
 * 需要 .NET（只有 Windows 有），其他平台会跳过。
 */
function checkExeIcon(exePath) {
  if (process.platform !== 'win32') return { skipped: true, reason: '只有 Windows 的 exe 才嵌图标' };

  const tmp = path.join(os.tmpdir(), `mya-icon-check-${Date.now()}.png`);
  const ps = [
    'Add-Type -AssemblyName System.Drawing;',
    `$ico = [System.Drawing.Icon]::ExtractAssociatedIcon('${exePath.replace(/'/g, "''")}');`,
    'if ($ico) {',
    '  $bmp = $ico.ToBitmap();',
    `  $bmp.Save('${tmp.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    '  Write-Output "$($bmp.Width)x$($bmp.Height)";',
    '  $bmp.Dispose(); $ico.Dispose();',
    '} else { Write-Output "none" }',
  ].join(' ');

  const res = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
    timeout: 30000,
  });
  const sizeText = (res.stdout || '').trim();
  if (!fs.existsSync(tmp)) return { ok: false, error: `没能从 exe 里提取出图标（输出：${sizeText || res.stderr}）` };

  const extracted = fs.readFileSync(tmp);
  fs.unlinkSync(tmp);

  // 和源图比像素。直接从 PNG 里解像素太麻烦，这里用「文件特征 + 尺寸」判断：
  // 我们的图标有几个特征色（青色、紫色、深色背景），Electron 默认图标是纯蓝的。
  // 更稳妥的做法是让 Electron 自己解码后比较，所以这里走 nativeImage。
  return { ok: true, sizeText, png: extracted };
}

/** 用 Electron 的解码能力把两张图转成像素，算相似度 */
function compareIcons(pngPath, extractedBuf) {
  const electronExe = findElectronForCompare();
  if (!electronExe) return { skipped: true, reason: '找不到 Electron，无法解码图片' };

  const script = path.join(os.tmpdir(), `mya-cmp-${Date.now()}.js`);
  const outFile = path.join(os.tmpdir(), `mya-cmp-${Date.now()}.json`);
  fs.writeFileSync(
    script,
    `
    const { app, nativeImage } = require('electron');
    const fs = require('fs');
    app.whenReady().then(() => {
      const a = nativeImage.createFromPath(${JSON.stringify(pngPath)});
      const b = nativeImage.createFromBuffer(Buffer.from(${JSON.stringify(extractedBuf.toString('base64'))}, 'base64'));
      const sa = a.resize({ width: 16, height: 16 }).toBitmap();
      const sb = b.resize({ width: 16, height: 16 }).toBitmap();
      let same = 0;
      let diff = 0;
      for (let i = 0; i < Math.min(sa.length, sb.length); i += 4) {
        const d = Math.abs(sa[i] - sb[i]) + Math.abs(sa[i+1] - sb[i+1]) + Math.abs(sa[i+2] - sb[i+2]);
        if (d < 90) same++; else diff++;
      }
      fs.writeFileSync(${JSON.stringify(outFile)}, JSON.stringify({ same, diff, sizeA: a.getSize(), sizeB: b.getSize() }));
      app.exit(0);
    });
    `,
    'utf8',
  );

  const res = spawnSync(electronExe, [script], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  try {
    fs.unlinkSync(script);
  } catch {
    /* 忽略 */
  }

  if (!fs.existsSync(outFile)) {
    return { ok: false, error: `比较失败：${(res.stderr || res.stdout || '').slice(-300)}` };
  }
  const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  fs.unlinkSync(outFile);
  return { ok: true, ...data };
}

function findElectronForCompare() {
  try {
    return require(path.join(ROOT, 'src', 'desktop.js')).findElectron();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('\n\x1b[1m\x1b[35m梦云 Agent 桌面程序验证\x1b[0m');

  const desktop = require(path.join(ROOT, 'src', 'desktop.js'));
  const available = desktop.desktopAvailable();

  if (!available) {
    console.log('\x1b[90m桌面组件（Electron）未安装，本次跳过。\x1b[0m');
    console.log('\x1b[90m想启用桌面程序：npm install（会下载约 100MB 的 Electron）\x1b[0m\n');
    section('桌面程序');
    skip('桌面程序能启动并自检通过', '未安装 Electron');
    console.log(`\n${'─'.repeat(52)}`);
    console.log('\x1b[33m已跳过（桌面组件未安装，浏览器界面不受影响）\x1b[0m\n');
    process.exitCode = 0;
    return;
  }

  const sandbox = makeSandbox({ withModel: true });
  const bareSandbox = makeSandbox({ withModel: false });

  try {
    section('1. 桌面组件');

    await test('能找到 Electron 可执行文件', () => {
      const exe = desktop.findElectron();
      assert(exe && fs.existsSync(exe), `找不到可执行文件：${exe}`);
      assert(/electron/i.test(path.basename(exe)), `路径不像 Electron：${exe}`);
    });

    await test('desktopAvailable() 报告可用', () => {
      assert(desktop.desktopAvailable() === true, '应该报告可用');
    });

    /* ---------------- 应用图标 ---------------- */
    section('2. 应用图标');

    await test('图标文件存在（png 源图 + 多尺寸 ico）', () => {
      const png = path.join(ROOT, 'build', 'icon.png');
      const ico = path.join(ROOT, 'build', 'icon.ico');
      const webIcon = path.join(ROOT, 'web', 'icon.png');
      assert(fs.existsSync(png), '缺少 build/icon.png（打包时的源图）');
      assert(fs.existsSync(ico), '缺少 build/icon.ico（窗口/任务栏/exe 用）');
      assert(fs.existsSync(webIcon), '缺少 web/icon.png（网页标签页图标）');
    });

    await test('PNG 是合法的 1024×1024 RGBA 图片', () => {
      const buf = fs.readFileSync(path.join(ROOT, 'build', 'icon.png'));
      // PNG 魔数
      assert(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG 魔数不对');
      // IHDR 紧跟在魔数后面
      assert(buf.subarray(12, 16).toString('ascii') === 'IHDR', '第一块应该是 IHDR');
      assert(buf.readUInt32BE(16) === 1024, `宽度应为 1024，实际 ${buf.readUInt32BE(16)}`);
      assert(buf.readUInt32BE(20) === 1024, `高度应为 1024，实际 ${buf.readUInt32BE(20)}`);
      assert(buf[24] === 8, '位深应为 8');
      assert(buf[25] === 6, '颜色类型应为 6（RGBA）');
      // 结尾必须有 IEND
      assert(buf.subarray(-8, -4).toString('ascii') === 'IEND', '缺少 IEND 结束块');
    });

    await test('ICO 结构合法且包含全部尺寸', () => {
      const buf = fs.readFileSync(path.join(ROOT, 'build', 'icon.ico'));
      const type = buf.readUInt16LE(2);
      const count = buf.readUInt16LE(4);
      assert(type === 1, `ICO 类型应为 1，实际 ${type}`);
      assert(count === ICO_SIZES.length, `应包含 ${ICO_SIZES.length} 个尺寸，实际 ${count}`);

      const seen = [];
      for (let i = 0; i < count; i += 1) {
        const e = 6 + 16 * i;
        const w = buf.readUInt8(e) || 256; // 0 表示 256
        const h = buf.readUInt8(e + 1) || 256;
        const size = buf.readUInt32LE(e + 8);
        const offset = buf.readUInt32LE(e + 12);
        assert(w === h, `第 ${i} 项不是正方形：${w}×${h}`);
        assert(size > 0, `第 ${i} 项数据长度为 0`);
        assert(offset + size <= buf.length, `第 ${i} 项数据超出文件范围`);
        seen.push(w);
      }
      const expected = [...ICO_SIZES];
      assert(
        JSON.stringify(seen) === JSON.stringify(expected),
        `尺寸列表不对：期望 ${expected.join(',')}，实际 ${seen.join(',')}`,
      );
    });

    await test('ICO 里的每一项都能被正确解码', () => {
      // 手写编码器最容易在这里出错：偏移算错、BMP 头写错、PNG 块拼错。
      // 这里把每一项按自己的格式解析一遍，确认结构是自洽的。
      const buf = fs.readFileSync(path.join(ROOT, 'build', 'icon.ico'));
      const count = buf.readUInt16LE(4);

      for (let i = 0; i < count; i += 1) {
        const e = 6 + 16 * i;
        const size = buf.readUInt8(e) || 256;
        const len = buf.readUInt32LE(e + 8);
        const offset = buf.readUInt32LE(e + 12);
        const data = buf.subarray(offset, offset + len);

        const isPng = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        if (isPng) {
          assert(size >= 48, `${size}px 应该用 BMP（小尺寸嵌 PNG 兼容性差），却用了 PNG`);
          assert(data.readUInt32BE(16) === size, `PNG 宽度应为 ${size}`);
          assert(data.readUInt32BE(20) === size, `PNG 高度应为 ${size}`);
        } else {
          // BMP：BITMAPINFOHEADER
          const headerSize = data.readUInt32LE(0);
          assert(headerSize === 40, `BMP 头大小应为 40，实际 ${headerSize}`);
          assert(data.readInt32LE(4) === size, `BMP 宽度应为 ${size}`);
          assert(data.readInt32LE(8) === size * 2, `BMP 高度应为 ${size * 2}（ICO 规定要含 AND 掩码）`);
          assert(data.readUInt16LE(14) === 32, 'BMP 位深应为 32');
          // 像素数据 + 掩码的总长度要够
          const maskRow = Math.ceil(size / 32) * 4;
          const expectedLen = 40 + size * size * 4 + maskRow * size;
          assert(
            data.length >= expectedLen,
            `${size}px 的 BMP 长度不足：需要 ${expectedLen}，实际 ${data.length}`,
          );
        }
      }
    });

    await test('图标不是全透明的空图', () => {
      // 生成的图如果画错了（比如形状全在画布外），会得到一张全透明图，
      // 而文件格式仍然合法——所以必须检查像素内容。
      const { renderIcon } = require(path.join(ROOT, 'desktop', 'make-icon.js'));
      const bmp = renderIcon(64);
      let opaque = 0;
      let colored = 0;
      for (let i = 0; i < bmp.data.length; i += 4) {
        const a = bmp.data[i + 3];
        if (a > 200) {
          opaque += 1;
          // 有明显颜色（不是纯黑）的像素
          if (bmp.data[i] > 40 || bmp.data[i + 1] > 40 || bmp.data[i + 2] > 40) colored += 1;
        }
      }
      const total = 64 * 64;
      assert(opaque / total > 0.5, `不透明像素太少（${opaque}/${total}），图标可能是空的`);
      assert(colored / total > 0.05, `彩色像素太少（${colored}/${total}），主体可能没画出来`);
    });

    /* ---------------- 真正启动一次 ---------------- */
    section('3. 启动桌面程序并自检');

    let result = null;
    await test('桌面程序能启动（进程正常退出）', async () => {
      result = await runSelftest(sandbox);
      if (result.spawnError) throw new Error(`无法启动：${result.spawnError}`);
      if (result.timedOut) {
        throw new Error(`自检超时（120s）。输出：\n${result.out.slice(-800)}\n${result.err.slice(-800)}`);
      }
      assert(
        typeof result.code === 'number',
        `进程异常结束。stdout：${result.out.slice(-500)} stderr：${result.err.slice(-500)}`,
      );
    });

    await test('窗口与页面渲染正常', () => {
      assert(result, '上一步没有结果');
      const { checks } = collectChecks(result);
      assert(checks.length > 0, `自检没有输出任何检查项：\n${result.out.slice(-600)}\n${result.report || ''}`);

      const find = (kw) => checks.find((c) => c.name.includes(kw));
      const title = find('窗口标题');
      assert(title && title.ok, `窗口标题检查失败：${JSON.stringify(title)}`);
      assert(find('对话容器') && find('对话容器').ok, '对话容器没有渲染');
      assert(find('输入框') && find('输入框').ok, '输入框没有渲染');
      assert(find('会话列表') && find('会话列表').ok, `会话列表检查失败：\n${result.out.slice(-600)}\n${result.report || ''}`);
    });

    await test('preload 桥已注入（桌面增强功能可用）', () => {
      const { checks } = collectChecks(result);
      const bridge = checks.find((c) => c.name.includes('preload'));
      assert(bridge && bridge.ok, `preload 桥没有注入成功：${JSON.stringify(bridge)}`);
      const body = checks.find((c) => c.name.includes('桌面模式'));
      assert(body && body.ok, '页面没有识别出自己跑在桌面程序里');
    });

    await test('界面能连上本地服务接口', () => {
      const { checks } = collectChecks(result);
      const api = checks.find((c) => c.name.includes('本地接口'));
      assert(api && api.ok, `接口连通性检查失败：${JSON.stringify(api)}`);
      const model = checks.find((c) => c.name.includes('当前模型'));
      assert(model && model.ok, `模型信息检查失败：${JSON.stringify(model)}`);
    });

    await test('自检整体通过（退出码 0）', () => {
      const { checks } = collectChecks(result);
      const failed = checks.filter((c) => !c.ok);
      assert(
        failed.length === 0,
        `有 ${failed.length} 项检查未通过：\n      ${failed.map((f) => f.name).join('\n      ')}` +
          // 把自检自己的诊断带上来（比如浮层状态的数字），失败时不用再猜
          `\n      —— 自检输出的最后 500 字：\n      ${(result.out || '').slice(-500).split('\n').join('\n      ')}`,
      );
      assert(result.code === 0, `退出码应为 0，实际 ${result.code}`);
    });

    /* ---------------- 干净环境 ---------------- */
    section('4. 首次使用（什么都没配）');

    await test('没配模型时窗口也能打开，并引导去配置', async () => {
      const bare = await runSelftest(bareSandbox);
      if (bare.timedOut) throw new Error('自检超时');

      const checks = parseChecks(bare.out);
      const find = (kw) => checks.find((c) => c.name.includes(kw));

      // 最关键的一条：窗口必须能打开。否则用户第一次运行会看到打不开的程序，
      // 也就永远没法进设置去配置。
      assert(find('窗口标题') && find('窗口标题').ok, `窗口应该能正常打开：\n${bare.out.slice(-600)}`);
      assert(find('preload') && find('preload').ok, 'preload 桥应该照常注入');
      assert(find('本地接口') && find('本地接口').ok, '本地接口应该可用（设置接口也要能用）');

      // 会话列表此时是空的（还没有会话），自检会因此报一项失败，
      // 但整件事是「符合预期」的——界面开着、能去配置，就够了。
      assert(
        /还没有会话|会话列表已加载/.test(bare.out),
        `界面应该正常显示空状态或会话列表：\n${bare.out.slice(-600)}`,
      );
    });

    /* ---------------- 打包产物 ---------------- */
    section('5. 打包出来的 exe');

    const exePath = findPackagedExe();
    if (!exePath) {
      skip('打包产物能独立运行', '还没打包过（先跑 npm run dist）');
    } else {
      await test(`打包产物能独立运行（${path.basename(exePath)}）`, async () => {
        const r = await runPackagedSelftest(exePath, sandbox);
        assert(
          !r.timedOut,
          '打包后的程序卡住了 —— 这是最严重的问题，用户双击会完全没反应。\n' +
            '      常见原因：package.json 的 main 字段没指向 desktop/main.js，\n' +
            '      导致 electron-builder 把别的文件当主进程启动。\n' +
            `      ${describePackagedRun(r)}`,
        );
        assert(
          r.report,
          `打包版没有写出自检报告（它没有 stdout，报告是唯一的诊断途径）。\n      ${describePackagedRun(r)}`,
        );

        const checks = parseChecks(r.report);
        assert(checks.length > 0, `报告里没有检查项：\n${r.report}`);

        const failed = checks.filter((c) => !c.ok);
        assert(
          failed.length === 0,
          `打包版有 ${failed.length} 项检查未通过：\n      ${failed.map((f) => f.name).join('\n      ')}\n${r.report}`,
        );
        assert(r.code === 0, `退出码应为 0，实际 ${r.code}`);
      });

      await test('打包版能把配置写到可写目录（不会写进只读的 app.asar）', () => {
        // 这个 bug 真实发生过：程序目录是 resources/app.asar，往里写 config.json
        // 会报 ENOENT: no such file or directory, open '...\app.asar\config.json'，
        // 用户点「保存」就失败，而且报错完全看不出该怎么修。
        const cfgDir = path.join(sandbox, 'userdata');
        if (!fs.existsSync(cfgDir)) {
          // 没跑过自检就没有这个目录，跳过（不要假装通过）
          throw new Error('没有配置目录——上一条打包版自检可能没跑起来');
        }
        // 让程序自己报出它用的配置目录，比猜可靠
        const listed = fs.readdirSync(cfgDir);
        assert(
          !listed.some((f) => /app\.asar/i.test(f)),
          `配置目录里出现了 asar 相关项：${listed.join(', ')}`,
        );
        // 而且配置真的落在这个沙箱目录里（不是只在别处转了一圈）：
        // MYA_CONFIG_DIR 显式指定时必须被尊重，setupConfigDir 会把自带的模板铺进来
        assert(
          listed.includes('config.json'),
          `沙箱配置目录里没有 config.json——说明程序没用 MYA_CONFIG_DIR 指的目录：${listed.join(', ') || '(空)'}`,
        );
        // 配置目录本身必须是可写的（不然保存还是会失败）
        const probe = path.join(cfgDir, '.write-probe');
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
      });

      await test('exe 里嵌的是我们自己的图标（不是 Electron 默认图标）', () => {        // electron-builder 找不到图标时只会静默用默认图标，日志里看不出来，
        // 所以必须把图标抠出来比一比
        const extracted = checkExeIcon(exePath);
        if (extracted.skipped) {
          console.log(`      \x1b[90m（跳过：${extracted.reason}）\x1b[0m`);
          return;
        }
        assert(extracted.ok, extracted.error);

        const cmp = compareIcons(path.join(ROOT, 'build', 'icon.png'), extracted.png);
        if (cmp.skipped) {
          console.log(`      \x1b[90m（跳过比对：${cmp.reason}）\x1b[0m`);
          return;
        }
        assert(cmp.ok, cmp.error);

        const total = cmp.same + cmp.diff;
        const ratio = cmp.same / total;
        assert(
          ratio > 0.7,
          `exe 里的图标和 build/icon.png 不像（相同像素占比 ${(ratio * 100).toFixed(0)}%）。\n` +
            '      说明打包时没用到我们的图标——检查 package.json 的 build.win.icon。',
        );
      });
    }

    /* ---------------- 端口冲突 ---------------- */
    section('6. 端口被占用时能自动换端口');

    await test('端口被占用时仍能启动（自动往后找）', async () => {
      // 找一个真正空闲的端口来占住——不能写死 3080，
      // 因为用户机器上 3080 可能本来就被别的东西占着（那样测试自己就失败了）
      const freePort = await findFreePort(3085);
      const blocker = http.createServer((req, res) => res.end('blocked'));
      await new Promise((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(freePort, '127.0.0.1', resolve);
      });

      try {
        const r = await runSelftest(sandbox, { MYA_PORT: String(freePort) });
        assert(!r.timedOut, '端口冲突时不应该卡死');

        const urlLine = /地址：(http:\/\/127\.0\.0\.1:(\d+))/.exec(r.out);
        assert(urlLine, `自检应该打印实际地址：\n${r.out.slice(-400)}`);
        const actualPort = Number(urlLine[2]);
        assert(
          actualPort !== freePort,
          `端口 ${freePort} 已被占用，应该换一个，但它仍然用了 ${actualPort}`,
        );

        const checks = parseChecks(r.out);
        const api = checks.find((c) => c.name.includes('本地接口'));
        assert(api && api.ok, '换端口后接口仍应可用');
      } finally {
        await new Promise((resolve) => blocker.close(resolve));
      }
    });
  } finally {
    for (const dir of [sandbox, bareSandbox]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows 偶尔锁文件 */
      }
    }
  }

  /* ---------------- 汇总 ---------------- */
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(52)}`);
  if (!failed.length) {
    console.log(`\x1b[32m\x1b[1m全部通过：${passed} 项\x1b[0m`);
  } else {
    console.log(`\x1b[31m\x1b[1m${failed.length} 项失败 / 共 ${passed + failed.length} 项\x1b[0m`);
    console.log('');
    for (const f of failed) {
      console.log(`\x1b[31m  ✗ [${f.group}] ${f.name}\x1b[0m`);
      console.log(`    ${String(f.error && f.error.message).split('\n').join('\n    ')}`);
    }
  }
  console.log('');
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error('\n\x1b[31m测试脚本自身出错：\x1b[0m', err);
  process.exitCode = 1;
});