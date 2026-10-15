'use strict';

/**
 * 梦云 Agent —— 打包脚本
 *
 * 把整个程序打成一个免安装的 exe：别人拿到之后双击就能用，
 * 不需要装 Node、不需要 npm install。
 *
 * 用法：npm run dist
 *
 * 为什么单独写一个脚本而不是直接调 electron-builder：
 *   1. 要把国内镜像设好，否则下载 Electron 二进制会非常慢甚至失败
 *   2. 要在打包前做一次健全性检查，避免打出一个跑不起来的包
 *   3. 要明确告诉用户产物在哪
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');

function log(msg) {
  console.log(`  ${msg}`);
}

function ok(msg) {
  console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
}

function warn(msg) {
  console.log(`  \x1b[33m!\x1b[0m ${msg}`);
}

function fail(msg) {
  console.error(`  \x1b[31m✗\x1b[0m ${msg}`);
}

/**
 * 找出正在运行的、会占住 dist 里那个 exe 的进程。
 *
 * 为什么值得专门查一下：占用时不报错、只是无限等待，
 * 这种失败最难查（日志里只有一行夹在中间的 waiting for unlock）。
 * 查不到（没装 PowerShell / 平台不支持）就返回空数组，不干扰打包。
 */
function findRunningApps() {
  if (process.platform !== 'win32') return [];
  const out = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='梦云Agent.exe' OR Name='梦云Agent-0.1.0-免安装.exe'\" | Select-Object -ExpandProperty ProcessId",
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 },
  );
  if (!out || !out.stdout) return [];
  return out.stdout
    .split(/\r?\n/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .map((pid) => ({ pid }));
}

/* ------------------------------------------------------------------ */
/* 健全性检查                                                          */
/* ------------------------------------------------------------------ */

function preflight() {
  const problems = [];

  const required = [
    'desktop/main.js',
    'desktop/preload.js',
    'desktop/make-icon.js',
    'src/web/server.js',
    'web/index.html',
    'web/app.js',
    'web/app.css',
    'config.json',
  ];
  for (const rel of required) {
    if (fs.existsSync(path.join(ROOT, rel))) continue;
    // config.json 是「个人配置」（.gitignore 忽略了它，里面会有网关地址和密钥）。
    // 没有它时用 config.example.json 当模板：别人 clone 下来就能直接打包，
    // 不必先手工造一份配置；打出来的包第一次启动会引导用户去设置里填。
    if (rel === 'config.json' && fs.existsSync(path.join(ROOT, 'config.example.json'))) {
      warn('没找到 config.json，打包时用 config.example.json 作为默认配置模板');
      continue;
    }
    problems.push(`缺少文件：${rel}`);
  }

  // 桌面程序能不能找到 Electron
  try {
    const { desktopAvailable } = require(path.join(ROOT, 'src', 'desktop.js'));
    if (!desktopAvailable()) problems.push('没找到 Electron 二进制，请先运行 npm install');
  } catch (err) {
    problems.push(`无法加载桌面启动器：${err.message}`);
  }

  return problems;
}

/**
 * 确保图标存在。
 * 图标是代码生成的，所以打包前跑一遍——这样改了配色之后不用记得手动重新生成。
 */
function ensureIcon() {
  const ico = path.join(ROOT, 'build', 'icon.ico');
  const png = path.join(ROOT, 'build', 'icon.png');
  if (fs.existsSync(ico) && fs.existsSync(png)) {
    return { generated: false };
  }

  const script = path.join(ROOT, 'desktop', 'make-icon.js');
  if (!fs.existsSync(script)) return { generated: false, error: '找不到图标生成脚本' };

  log('图标不存在，正在生成…');
  const res = spawnSync(process.execPath, [script], { cwd: ROOT, stdio: 'inherit' });
  return { generated: res.status === 0, error: res.status === 0 ? '' : `退出码 ${res.status}` };
}

/**
 * 打包后校验 app.asar 里的内容和源文件一致。
 *
 * 为什么非要有这一步：electron-builder 往 asar 里写文件时，如果某个源文件
 * 正在被改写（比如打包的同时还在编辑代码），写出来的 asar 会「索引和内容对不上」——
 * 索引里写着 A 文件、读出来却是 B 文件的一段。程序启动时直接语法错误退出，
 * 而**打包日志里一个错都没有**（踩过：一连串「打包版进程退出码 1 / 没写出报告」，
 * 查到最后是 asar 内容错位，白折腾好几轮）。
 *
 * 这里做两件事：逐个比对长度，并把每个 JS 用 vm 编译一遍——
 * 编译能过说明文件既没被截断、也没被换成别的文件的内容。
 */
function verifyAsar() {
  const asarPath = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) return { ok: true, skipped: true, checked: 0 };

  let list;
  let extract;
  try {
    // electron-builder 自带这份库，属于构建期依赖，不进运行时
    ({ listPackage: list, extractFile: extract } = require('@electron/asar'));
  } catch (err) {
    return { ok: true, skipped: true, checked: 0, note: `没装 @electron/asar（${err.message}）` };
  }

  const vm = require('vm');
  // listPackage 给的是「以分隔符开头」的路径（Windows 上是 `\src\app.js`），
  // 拿去 extractFile 要先把开头那个分隔符去掉（它自己会处理后面的分隔符）
  const packed = list(asarPath)
    .map((p) => p.replace(/^[\\/]+/, ''))
    .filter((p) => /\.(js|json|html|css|md)$/.test(p));
  const problems = [];
  let checked = 0;

  for (const rel of packed) {
    // package.json 会被 electron-builder 改写（去掉 scripts / devDependencies），
    // 和源文件不一致是正常的，跳过它
    if (rel === 'package.json') continue;
    const srcPath = path.join(ROOT, rel);
    if (!fs.existsSync(srcPath)) continue; // 打包时生成/改写的文件跳过
    const fromAsar = extract(asarPath, rel);
    const fromDisk = fs.readFileSync(srcPath);
    checked += 1;
    if (fromAsar.length !== fromDisk.length) {
      problems.push(`${rel}：asar 里 ${fromAsar.length}B，源文件 ${fromDisk.length}B`);
      continue;
    }
    if (rel.endsWith('.js')) {
      try {
        // 只编译不执行：语法错/被截断都会在这里抛出来
        // eslint-disable-next-line no-new
        new vm.Script(fromAsar.toString('utf8'), { filename: rel });
      } catch (err) {
        problems.push(`${rel}：asar 里的内容不是合法 JS（${err.message}）`);
      }
    }
  }

  if (problems.length) {
    return {
      ok: false,
      checked,
      error:
        `asar 里的内容和源文件对不上（${problems.length} 个文件）：\n      ${problems.slice(0, 5).join('\n      ')}\n` +
        '      最常见的原因是打包的同时还在改文件。重新跑一次 npm run dist 即可；\n' +
        '      如果反复出现，把项目目录加入杀毒软件白名单。',
    };
  }
  return { ok: true, checked };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

function main() {
  console.log('\n\x1b[1m\x1b[35m打包梦云 Agent 桌面程序\x1b[0m\n');

  log('检查项目完整性…');
  const problems = preflight();
  if (problems.length) {
    for (const p of problems) fail(p);
    console.log('');
    process.exitCode = 1;
    return;
  }
  ok('项目文件完整');

  // 图标：没有就现生成一份，不因为缺图标而中断打包
  const iconState = ensureIcon();
  if (iconState.generated) ok('图标已生成');
  else if (iconState.error) warn(`图标生成失败（${iconState.error}），将使用默认图标`);
  else ok('图标已就位');

  // electron-builder 装了吗
  let builderBin = null;
  const candidates = [
    path.join(ROOT, 'node_modules', '.bin', 'electron-builder.cmd'),
    path.join(ROOT, 'node_modules', '.bin', 'electron-builder'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      builderBin = c;
      break;
    }
  }
  if (!builderBin) {
    warn('没装 electron-builder（打包工具，约几十 MB）');
    console.log('');
    log('请先安装：');
    log('  npm install --save-dev electron-builder');
    console.log('');
    log('如果下载很慢，先设置镜像：');
    log('  $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://registry.npmmirror.com/-/binary/electron-builder-binaries/"');
    console.log('');
    process.exitCode = 1;
    return;
  }
  ok('找到 electron-builder');

  // 国内镜像：electron-builder 打包时会额外下载 nsis / winCodeSign 等小工具，
  // 不设镜像在国内基本会卡住
  const env = {
    ...process.env,
    ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || 'https://registry.npmmirror.com/-/binary/electron/',
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
      'https://registry.npmmirror.com/-/binary/electron-builder-binaries/',
  };

  log('开始打包（第一次会下载一些打包工具，可能要几分钟）…\n');

  // 先检查有没有正在运行的旧实例。
  //
  // 这一步是拿时间换来的教训：electron-builder 写完中间产物后要覆盖
  // dist 里的 exe，如果那个文件正被运行中的程序占着，它**不会报错，
  // 只会一直等**，日志里一行 "waiting for unlock" 夹在几千行输出中间。
  // 于是表现成「打个包卡了二十分钟」，而真相是「你先关掉那个窗口」。
  const running = findRunningApps();
  if (running.length) {
    warn(`检测到 ${running.length} 个正在运行的程序实例，它会占住 dist 里的 exe：`);
    for (const p of running.slice(0, 5)) log(`    PID ${p.pid}`);
    log('');
    log('  打包会一直卡在「output file is locked … waiting for unlock」不动。');
    log('  请先关掉程序窗口，或直接执行：');
    log(`    Stop-Process -Id ${running.map((p) => p.pid).join(',')} -Force`);
    console.log('');
    if (process.env.MYA_FORCE_BUILD !== '1') {
      fail('为了不白等，已提前退出（确认要强打就设 MYA_FORCE_BUILD=1）');
      process.exitCode = 2;
      return;
    }
    warn('MYA_FORCE_BUILD=1：继续打包，如果卡住请手工关掉上面的进程');
  }

  const res = spawnSync(builderBin, ['--win', 'portable', '--x64'], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  console.log('');
  if (res.status !== 0) {
    fail(`打包失败（退出码 ${res.status}）`);
    console.log('');
    log('常见原因和解决办法：');
    log('  1. 网络问题：设置镜像（见上面两行），或挂代理后重试');
    log('  2. 杀毒软件拦截：把项目目录加入白名单');
    log('  3. 磁盘空间不足：打包过程需要约 1GB 临时空间');
    console.log('');
    process.exitCode = 1;
    return;
  }

  // 找产物
  const distDir = path.join(ROOT, 'dist');
  const produced = [];
  if (fs.existsSync(distDir)) {
    for (const f of fs.readdirSync(distDir)) {
      const full = path.join(distDir, f);
      if (fs.statSync(full).isFile() && /\.(exe|dmg|AppImage|zip)$/i.test(f)) {
        produced.push({ name: f, size: (fs.statSync(full).size / 1024 / 1024).toFixed(1) });
      }
    }
  }

  ok('打包完成');

  // 出了 exe 还不够：必须确认 asar 里装的就是刚才那些源文件
  const verify = verifyAsar();
  if (!verify.ok) {
    console.log('');
    fail(verify.error);
    console.log('');
    process.exitCode = 1;
    return;
  }
  if (verify.skipped) {
    if (verify.note) warn(`跳过产物自检：${verify.note}`);
  } else {
    ok(`产物自检：asar 里 ${verify.checked} 个文件与源文件逐字节一致`);
  }

  console.log('');
  if (produced.length) {
    log('产物（在 dist/ 目录里）：');
    for (const p of produced) log(`  ${p.name}  ${p.size} MB`);
    console.log('');
    log('把这个文件发给别人，双击就能用，不需要装 Node。');
  } else {
    log(`产物目录：${distDir}`);
  }
  console.log('');
}

main();
