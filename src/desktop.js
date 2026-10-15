'use strict';

/**
 * 梦云 Agent —— 桌面程序启动器
 *
 * 用途：双击 / 命令行调用时，检测到 Electron 就开原生窗口，
 * 没装 Electron 就自动退回到「起服务 + 开浏览器」，保证永远能用。
 *
 * 用户不需要知道这些细节——他只会看到「双击，程序打开了」。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/**
 * 找到 Electron 可执行文件。
 * @returns {string|null} 找不到返回 null（调用方会退回浏览器模式）
 */
function findElectron() {
  // 1) 环境变量显式指定
  if (process.env.MYA_ELECTRON && fs.existsSync(process.env.MYA_ELECTRON)) {
    return process.env.MYA_ELECTRON;
  }

  // 2) node_modules 里的标准位置（devDependencies 安装的）
  const candidates = [
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  // 3) 通过 electron 包的 path.txt 找（跨平台最稳的方式）
  try {
    const mod = require.resolve('electron', { paths: [ROOT] });
    const dir = path.dirname(mod);
    const pathTxt = path.join(dir, 'path.txt');
    if (fs.existsSync(pathTxt)) {
      const rel = fs.readFileSync(pathTxt, 'utf8').trim();
      const full = path.join(dir, 'dist', rel);
      if (fs.existsSync(full)) return full;
    }
  } catch {
    /* 没装 electron，走下一步 */
  }

  // 4) 已经被打包成独立程序时，直接用当前进程（process.execPath 就是自己的 exe）
  if (process.versions.electron) return process.execPath;

  return null;
}

/** 是否具备桌面程序的条件 */
function desktopAvailable() {
  return !!findElectron();
}

/**
 * 启动桌面程序。
 * @param {object} [opts]
 * @param {string} [opts.cwd]       工作目录（agent 以此为基准操作文件）
 * @param {number} [opts.port]      期望端口
 * @param {boolean} [opts.dev]      打开开发者工具
 * @param {boolean} [opts.selftest] 自检模式：把检查结果打到当前终端，然后退出
 * @param {boolean} [opts.attach]   是否把子进程的输出接到当前终端（自检时用）
 * @returns {{ok:boolean, pid?:number, reason?:string}}
 */
function launchDesktop(opts = {}) {
  const exe = findElectron();
  if (!exe) {
    return { ok: false, reason: '没找到 Electron（未安装桌面组件）' };
  }

  const cwd = opts.cwd || process.cwd();
  const mainScript = path.join(ROOT, 'desktop', 'main.js');

  const env = {
    ...process.env,
    MYA_WORKSPACE: cwd,
    ...(opts.port ? { MYA_PORT: String(opts.port) } : {}),
  };

  // 已经是 Electron 进程了（比如从主进程里调用），直接 require 更省事
  if (process.versions.electron) {
    require(mainScript);
    return { ok: true, pid: process.pid };
  }

  const args = [mainScript];
  if (opts.dev) args.push('--dev');

  // 自检模式要能看到输出，所以不 detached、直接继承 stdio
  if (opts.selftest) {
    const { spawnSync } = require('child_process');
    const res = spawnSync(exe, [...args, '--selftest'], {
      cwd: ROOT,
      env,
      stdio: 'inherit',
      timeout: 120000,
    });
    return { ok: res.status === 0, exitCode: res.status, selftest: true };
  }

  const child = spawn(exe, args, {
    cwd: ROOT,
    env,
    detached: true, // 让命令行窗口关掉后程序继续活着
    stdio: opts.attach ? 'inherit' : 'ignore',
    windowsHide: false,
  });
  child.unref();

  return { ok: true, pid: child.pid };
}

module.exports = { findElectron, desktopAvailable, launchDesktop, ROOT };
