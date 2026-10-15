'use strict';

/**
 * 梦云 Agent —— 桌面程序主进程（Electron）
 *
 * 它做的事：
 *   1. 在进程内启动本地 HTTP 服务（复用 src/web/server.js，不另起一个 node 进程）
 *   2. 开一个原生窗口加载它 —— 看起来就是个正常程序，没有浏览器地址栏
 *   3. 中文菜单、快捷键、窗口位置记忆、单实例锁
 *   4. 关掉窗口 = 退出程序（服务跟着一起停）
 *
 * 为什么用「进程内起服务 + 窗口加载 http://127.0.0.1」而不是 file:// 直接开网页：
 *   前端的 /api 请求是相对路径，走 http 才正常；而且 SSE、剪贴板这些在
 *   http 源下行为更一致。多开一个端口没有任何坏处——它只监听本机。
 *
 * 开发调试：ELECTRON_DEV=1 启动可以打开开发者工具。
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ */
/* 懒加载 electron（这样这个文件也能被普通 node 直接 require 而不炸）    */
/* ------------------------------------------------------------------ */

let electronModule = null;
try {
  // eslint-disable-next-line global-require
  electronModule = require('electron');
} catch {
  electronModule = null;
}

const { app, BrowserWindow, Menu, shell, dialog, nativeImage, ipcMain, nativeTheme } = electronModule || {};

/** 开发模式：ELECTRON_DEV=1 或命令行带 --dev */
const DEV = process.env.ELECTRON_DEV === '1' || process.argv.includes('--dev');

/** 自检模式：桌面程序是否真的正常工作，把结论打到控制台然后退出 */
const SELF_TEST = process.env.MYA_DESKTOP_SELFTEST === '1' || process.argv.includes('--selftest');

/* ------------------------------------------------------------------ */
/* 窗口状态持久化（位置 / 大小 / 最大化）                               */
/* ------------------------------------------------------------------ */

function stateFile() {
  try {
    return path.join(app.getPath('userData'), 'window-state.json');
  } catch {
    return path.join(ROOT, '.mya', 'window-state.json');
  }
}

function loadWindowState() {
  const fallback = { width: 1360, height: 880 };
  try {
    const data = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    // 尺寸做个下限保护，免得被拖成一条缝之后再也点不开
    return {
      x: Number.isFinite(data.x) ? data.x : undefined,
      y: Number.isFinite(data.y) ? data.y : undefined,
      width: Math.max(900, Number(data.width) || fallback.width),
      height: Math.max(600, Number(data.height) || fallback.height),
      maximized: !!data.maximized,
    };
  } catch {
    return fallback;
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.getNormalBounds ? win.getNormalBounds() : win.getBounds();
    const data = { ...bounds, maximized: win.isMaximized() };
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(data, null, 2));
  } catch {
    /* 存不下就算了，不影响使用 */
  }
}

/* ------------------------------------------------------------------ */
/* 启动内部服务                                                        */
/* ------------------------------------------------------------------ */

/**
 * 把关键步骤写进日志文件。
 *
 * 为什么需要这个：打包成 exe 之后是 Windows GUI 子系统进程，没有可写的
 * stdout/stderr，一旦启动阶段出错用户只会看到「双击没反应」。
 * 有了这个日志（和自检报告），至少能知道卡在哪一步。
 *
 * 带 UTF-8 BOM：这样 Windows 记事本、PowerShell 打开时不会把中文显示成乱码。
 */
function logToFile(text) {
  try {
    const base = app && app.getPath ? app.getPath('userData') : path.join(ROOT, '.mya');
    fs.mkdirSync(base, { recursive: true });
    const file = path.join(base, 'main.log');
    const isNew = !fs.existsSync(file);
    fs.appendFileSync(file, `${isNew ? '\uFEFF' : ''}[${new Date().toISOString()}] ${text}\n`, 'utf8');
  } catch {
    /* 写不了就算了 */
  }
}

/**
 * 决定工作目录。
 *
 * 默认用「启动它时所在的目录」——把程序放进某个项目文件夹里双击，
 * agent 就会操作那个项目，这符合直觉。
 *
 * 但有个坑：从开始菜单、任务栏固定项启动时，工作目录可能是
 * C:\Windows\System32 这种系统目录，在那里写 .mya/ 会失败。
 * 所以这里做一次可写性检查，不可写就退到「文档」目录。
 */
function resolveWorkspace() {
  /** 每一项带一个标记：这个候选是不是「进程的启动目录」 */
  const candidates = [];
  const add = (dir, isProcessDir = false) => {
    if (dir) candidates.push({ dir, isProcessDir });
  };

  add(process.env.MYA_WORKSPACE);

  // 免安装版（portable exe）每次运行都会把自己解压到 %TEMP%\<28 位随机串>，
  // 并在**那个目录里**启动进程 —— 于是 process.cwd() 就是这个临时目录。
  // 它有两个致命问题：每次启动都不一样，而且程序退出后会被清理掉。
  // 一旦拿它当工作目录，下次打开旧会话就指向一个不存在的路径，
  // 文件读写和命令执行全部失败，而报错还是误导性的 spawn ENOENT
  // （只提可执行文件名，完全不提 cwd），模型会朝「powershell 没装」查半天。
  //
  // electron-builder 的 portable 启动器会把 exe 真正所在的目录放进
  // PORTABLE_EXECUTABLE_DIR —— 那才是「把程序放进项目文件夹里双击」时
  // 用户期待的那个目录。
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  add(portableDir);

  // 只有不是 portable 启动时（源码模式 / 安装版），启动目录才可信
  if (!portableDir) add(process.cwd(), true);

  try {
    if (app && app.getPath) add(path.join(app.getPath('documents'), '梦云Agent'));
  } catch {
    /* 忽略 */
  }

  for (const { dir, isProcessDir } of candidates) {
    if (!dir) continue;
    try {
      const resolved = path.resolve(dir);
      if (!fs.existsSync(resolved)) {
        // 不存在就试着建（比如「文档/梦云Agent」）。
        // 但「进程启动目录」不建：它不存在说明环境本身不对劲，
        // 我们凭空造一个空目录只会把问题掩盖掉。
        if (isProcessDir) continue;
        fs.mkdirSync(resolved, { recursive: true });
      }
      // 真的写一下试试——有些目录存在但没权限
      const probe = path.join(resolved, '.mya-write-test');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return resolved;
    } catch {
      logToFile(`工作目录 ${dir} 不可写，试下一个`);
    }
  }

  // 全都不行就用系统临时目录，至少能跑起来
  logToFile('所有候选工作目录都不可写，退回临时目录');
  return require('os').tmpdir();
}

/**
 * 起本地服务。
 * 端口固定 3080：这样刷新页面、书签、甚至你在浏览器里另开一个标签都能用同一个地址。
 * 万一被占用（比如同时开着命令行版的 mya web），就自动往后找。
 */
async function bootServer() {
  logToFile('开始启动本地服务');
  const { createApp } = require(path.join(ROOT, 'src', 'app.js'));
  const { startWebServer } = require(path.join(ROOT, 'src', 'web', 'server.js'));

  const cwd = resolveWorkspace();
  logToFile(`工作目录：${cwd}`);

  // needProvider: false —— 界面必须先能打开，用户才有机会去配置模型
  const app_ = await createApp({ cwd, quiet: true, needProvider: false });
  logToFile('应用组装完成，正在监听端口');

  const server = await startWebServer(app_, {
    port: Number(process.env.MYA_PORT) || 3080,
    host: '127.0.0.1',
    open: false,
    quiet: true,
  });
  logToFile(`服务已启动：${server.url}`);

  return { app: app_, server };
}

/* ------------------------------------------------------------------ */
/* 窗口                                                               */
/* ------------------------------------------------------------------ */

let mainWindow = null;
let serverHandle = null;

function createWindow(baseUrl) {
  const state = loadWindowState();

  // 任务栏/标题栏图标。
  // 优先用 .ico（Windows 上各尺寸都清晰），退而求其次用 .png。
  // 打包后这些文件在 asar 里，nativeImage 也能正确读到。
  let icon = undefined;
  const iconCandidates = [
    'build/icon.ico',
    'build/icon.png',
    'web/icon.png',
  ];
  for (const rel of iconCandidates) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    try {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        icon = img;
        break;
      }
    } catch {
      /* 换下一个候选 */
    }
  }

  mainWindow = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 900,
    minHeight: 600,
    title: '梦云 Agent',
    // 无边框：Windows 会在窗口外面画一圈浅色边框和阴影，深色界面下很显眼。
    // 去掉之后由页面里的 .titlebar 自己画（见 web/index.html）。
    frame: false,
    // 和界面底色一致，启动瞬间不会闪一下别的颜色。
    // 跟着系统主题走：浅色系统给白色，深色系统给深色。
    backgroundColor: nativeTheme && nativeTheme.shouldUseDarkColors ? '#0b0f14' : '#ffffff',
    icon,
    show: false, // 先藏着，等页面加载好再显示，避免看到白屏
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  if (state.maximized) mainWindow.maximize();

  // 最大化状态变了就告诉页面，好切换按钮图标
  const notifyMaximize = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-maximized', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', notifyMaximize);
  mainWindow.on('unmaximize', notifyMaximize);

  // 页面准备好再显示
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  // 自检：检查 preload 注入、页面加载、本地服务是否都正常
  if (SELF_TEST) runSelfTest(mainWindow, baseUrl);

  mainWindow.on('resize', () => saveWindowState(mainWindow));
  mainWindow.on('move', () => saveWindowState(mainWindow));
  mainWindow.on('close', () => saveWindowState(mainWindow));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 外链走系统浏览器，不要在应用窗口里打开（否则就回不去了）
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // 页面内的导航也拦一下：只允许留在本地服务里
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(baseUrl) && /^https?:\/\//i.test(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  // 加载失败时给一个能看懂的页面，而不是 electron 默认的错误页
  mainWindow.webContents.on('did-fail-load', (event, code, description) => {
    if (code === -3) return; // -3 是「用户主动取消」，不是错误
    showFatal(
      '界面加载失败',
      `无法连接到本地服务（${description}）\n\n地址：${baseUrl}`,
    );
  });

  // 自检时打开页面内的交互追踪：设置浮层如果被意外打开，
  // 界面和 console 都看不出原因，把点击记下来才查得动（见 web/app.js 的 traceStart）
  mainWindow.loadURL(SELF_TEST ? `${baseUrl}?myaTrace=1` : baseUrl);
  return mainWindow;
}

/** 用原生对话框报错，比在窗口里塞 HTML 更直观 */
function showFatal(title, message) {
  if (dialog) {
    dialog.showErrorBox(title, `${message}\n\n如果反复出现，请在命令行里运行：\n  mya doctor`);
  } else {
    console.error(`[${title}] ${message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 渲染进程请求主进程做的事（通道很窄，只开放需要的）                   */
/* ------------------------------------------------------------------ */

function registerIpc() {
  if (!ipcMain) return;

  // 用系统默认程序打开本地目录（界面上的「打开插件目录」按钮用）
  ipcMain.handle('open-path', async (_event, target) => {
    if (typeof target !== 'string' || !target) return { ok: false, error: '路径为空' };

    // 只允许打开工作目录、数据目录、插件目录这几个地方，
    // 避免页面被注入之后拿它当任意文件打开器用
    if (serverHandle) {
      const allowed = [
        serverHandle.app.cfg.cwd,
        serverHandle.app.cfg.workspace, // 用户在设置里指定的工作目录
        serverHandle.app.cfg.dataDir,
        ...serverHandle.app.cfg.pluginDirs,
      ].filter(Boolean);
      const resolved = path.resolve(target);
      const inside = allowed.some((a) => resolved === path.resolve(a) || resolved.startsWith(path.resolve(a) + path.sep));
      if (!inside) return { ok: false, error: '不在允许打开的目录范围内' };
    }

    const err = await shell.openPath(target);
    return err ? { ok: false, error: err } : { ok: true };
  });

  /**
   * 选工作目录（新建会话时用）。
   *
   * 这是一个「只读的用户选择」——对话框返回什么就是什么，
   * 主进程不替页面做任何文件操作，所以不构成权限放大。
   */
  ipcMain.handle('choose-directory', async (event, defaultPath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    try {
      const startDir = defaultPath && fs.existsSync(defaultPath) ? defaultPath : undefined;
      const result = await dialog.showOpenDialog(win || undefined, {
        title: '选一个工作目录（agent 只能在这里读写文件）',
        defaultPath: startDir,
        properties: ['openDirectory', 'createDirectory'],
        buttonLabel: '用这个目录',
      });
      if (result.canceled || !result.filePaths || !result.filePaths.length) {
        return { ok: false, canceled: true };
      }
      return { ok: true, path: result.filePaths[0] };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  /** 选插件压缩包（本地安装用） */
  ipcMain.handle('choose-archive', async (event, defaultPath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    try {
      const startDir = defaultPath && fs.existsSync(path.dirname(defaultPath)) ? defaultPath : undefined;
      const result = await dialog.showOpenDialog(win || undefined, {
        title: '选插件压缩包（.zip / .tar.gz）',
        defaultPath: startDir,
        properties: ['openFile'],
        filters: [
          { name: '插件压缩包', extensions: ['zip', 'gz', 'tgz', 'tar'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePaths || !result.filePaths.length) {
        return { ok: false, canceled: true };
      }
      return { ok: true, path: result.filePaths[0] };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  /**
   * 选聊天附件：文件 / 文件夹 / 压缩包。
   *
   * 为什么不复用上面两个：它们的对话框标题写死了「工作目录」「插件压缩包」，
   * 在聊天场景里会让人以为选错了地方。这里按 kind 给对应的标题和过滤器，
   * 其余行为一致——**只回路径，不替页面读文件**（读文件仍然走 agent 的工具闸门）。
   */
  ipcMain.handle('choose-attachment', async (event, kind, defaultPath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const k = ['file', 'directory', 'archive'].includes(kind) ? kind : 'file';
    const config = {
      file: {
        title: '选一个文件（把路径加进输入框，让 agent 去读）',
        properties: ['openFile'],
        filters: [{ name: '所有文件', extensions: ['*'] }],
        buttonLabel: '加入',
      },
      directory: {
        title: '选一个文件夹（整个目录交给 agent 读）',
        properties: ['openDirectory'],
        buttonLabel: '加入',
      },
      archive: {
        title: '选一个压缩包（.zip / .tar.gz）',
        properties: ['openFile'],
        filters: [
          { name: '压缩包', extensions: ['zip', 'gz', 'tgz', 'tar', '7z', 'rar'] },
          { name: '所有文件', extensions: ['*'] },
        ],
        buttonLabel: '加入',
      },
    }[k];
    try {
      const start = defaultPath && fs.existsSync(k === 'directory' ? defaultPath : path.dirname(defaultPath))
        ? defaultPath
        : undefined;
      const result = await dialog.showOpenDialog(win || undefined, {
        title: config.title,
        defaultPath: start,
        properties: config.properties,
        filters: config.filters,
        buttonLabel: config.buttonLabel,
      });
      if (result.canceled || !result.filePaths || !result.filePaths.length) {
        return { ok: false, canceled: true };
      }
      return { ok: true, path: result.filePaths[0], kind: k };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  // 无边框窗口的窗口控制。只认这三个动作，不做成通用通道
  ipcMain.handle('win', (event, action) => {    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false, error: '找不到窗口' };
    switch (action) {
      case 'minimize':
        win.minimize();
        return { ok: true };
      case 'toggle-maximize':
        if (win.isMaximized()) win.unmaximize();
        else win.maximize();
        return { ok: true, maximized: win.isMaximized() };
      case 'close':
        win.close();
        return { ok: true };
      default:
        return { ok: false, error: `未知的窗口动作：${action}` };
    }
  });

  // 页面切主题时同步给主进程：无边框窗口的标题栏和阴影也跟着换，
  // 否则深色界面配浅色窗口边会很难看
  ipcMain.handle('set-theme', (event, theme) => {
    const t = theme === 'dark' ? 'dark' : 'light';
    if (nativeTheme) nativeTheme.themeSource = t;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.setBackgroundColor(t === 'dark' ? '#0b0f14' : '#ffffff');
    return { ok: true, theme: t };
  });
}

/* ------------------------------------------------------------------ */
/* 自检（排查「窗口白屏 / 桌面能力没生效」这类问题）                    */
/* ------------------------------------------------------------------ */

/**
 * 依次验证：页面标题、DOM 是否渲染、preload 桥是否注入、界面能否连上本地服务。
 * 结论打到控制台后退出进程——这样一个命令就能回答「桌面程序是不是好的」。
 *
 * 注意：打包成 exe 之后，Windows 的 GUI 子系统进程没有可写的 stdout，
 * 所以结果同时写一份到文件，由调用方读取（见 test/desktop-e2e.js）。
 */
async function runSelfTest(win, baseUrl) {
  const lines = [];
  const log = (ok, text) => {
    const line = `${ok ? '✓' : '✗'} ${text}`;
    lines.push(line);
    console.log(line);
  };
  let failures = 0;
  const check = (ok, text) => {
    if (!ok) failures += 1;
    log(ok, text);
  };

  // 兜底：万一某项检查挂住（打包环境下可能发生），也要写出结论再退出，
  // 否则用户看到的就是「双击了没反应」，完全无从下手
  const watchdog = setTimeout(() => {
    failures += 1;
    lines.push('✗ 自检超时（25 秒）——某个检查挂住了');
    flush();
    if (app) app.exit(1);
  }, 25000);
  if (watchdog.unref) watchdog.unref();

  // 自检结果文件：打包版靠它把结论带出来。
  // 多准备几个候选路径——打包后有些目录不可写（asar 内的路径、受限的 userData），
  // 必须保证至少有一个能写成，否则打包版出问题时完全没有诊断信息。
  const reportCandidates = [];
  try {
    if (app && app.getPath) reportCandidates.push(path.join(app.getPath('userData'), 'selftest-report.txt'));
  } catch {
    /* 忽略 */
  }
  try {
    if (app && app.getPath) reportCandidates.push(path.join(app.getPath('temp'), 'mya-selftest-report.txt'));
  } catch {
    /* 忽略 */
  }
  reportCandidates.push(path.join(ROOT, '.mya', 'selftest-report.txt'));
  reportCandidates.push(path.join(require('os').tmpdir(), 'mya-selftest-report.txt'));

  let reportFile = '';
  let shotsDir = '';
  let lastError = null;

  /** 找一个能写文件的目录，同时确定截图存哪 */
  const pickWritable = () => {
    for (const candidate of reportCandidates) {
      try {
        const dir = path.dirname(candidate);
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.mya-write-test-${process.pid}`);
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        reportFile = candidate;
        shotsDir = dir;
        return true;
      } catch {
        /* 试下一个 */
      }
    }
    return false;
  };
  pickWritable();

  const flush = () => {
    const text = `\uFEFF${[`地址：${baseUrl}`, ...lines, '', failures === 0 ? '全部通过' : `${failures} 项失败`].join('\n')}\n`;
    // 优先写选中的那个；万一它也失败了，把所有候选都试一遍
    for (const target of [reportFile, ...reportCandidates].filter(Boolean)) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text, 'utf8');
        if (target !== reportFile) console.log(`    （报告已改写到备用路径：${target}）`);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    // 一个都写不了，至少让控制台留下痕迹。
    // 打包版没有控制台，所以再弹个框——总比「双击没反应」强。
    const msg = `自检报告无法写入：${lastError && lastError.message}`;
    console.error(`! ${msg}`);
    try {
      if (dialog) dialog.showErrorBox('自检报告写入失败', `${msg}\n\n尝试过的路径：\n${reportCandidates.join('\n')}`);
    } catch {
      /* 弹不出来就算了 */
    }
  };

  try {
    console.log('\n桌面程序自检');
    console.log(`  地址：${baseUrl}`);
    console.log(`  Electron ${process.versions.electron} / Chromium ${process.versions.chrome}\n`);

    // 把页面里的报错转出来。前端出错时界面上往往「看着还行」，
    // 只有控制台才知道哪一行炸了——自检必须能看见。
    win.webContents.on('console-message', (event, level, message) => {
      // level: 0=verbose 1=info 2=warning 3=error
      if (level >= 2 && !/DevTools|Autofill/i.test(message)) {
        console.log(`    [页面${level === 3 ? '错误' : '警告'}] ${message}`);
      }
    });

    // 等页面真正加载完
    if (win.webContents.isLoading()) {
      await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    }
    await new Promise((r) => setTimeout(r, 800));

    check(win.webContents.getTitle().includes('梦云'), `窗口标题：${win.webContents.getTitle()}`);

    // 用 executeJavaScript 检查渲染结果（这是唯一能证明前端真的跑起来的方式）。
    // 界面是异步加载数据的，所以会话列表要轮询等一会儿，不能只看一眼就判失败。
    const probeOnce = () =>
      win.webContents.executeJavaScript(`(() => ({
        hasDesktopBridge: !!(window.myaDesktop && window.myaDesktop.isDesktop),
        hasMessages: !!document.getElementById('messages'),
        hasInput: !!document.getElementById('input'),
        // 会话现在挂在工作区下面（侧栏改成了「工作区 = 文件夹」的树），
        // 所以数的是树里的会话行 + 工作区行
        sessionCount: document.querySelectorAll('#wsList .ws-session, #wsArchList .ws-session').length,
        // 模型名从「输入区左下角的模型按钮」读：顶栏的模型胶囊去掉之后，
        // 这里是模型名唯一的常驻显示位置（state.info.model 是权威值，DOM 只是显示）
        modelText: (state.info && state.info.model) ||
          (document.getElementById('composerModelName') || {}).textContent || '',
        sideSections: [...document.querySelectorAll('.side-section')].map((s) => s.id),
        workspaceRows: document.querySelectorAll('#wsList .ws-item').length,
        // 只数「装了的插件」那一行：还没装时的占位按钮不算（它永远存在，
        // 会把「插件列表加载好了吗」这件事说成谎）
        pluginRows: document.querySelectorAll('#sidebarPlugins .plugin-row[data-plugin]').length,
        pluginPlaceholder: !!document.querySelector('#sidebarPlugins .plugin-row:not([data-plugin])'),
        topbarHasModelChip: !!document.getElementById('modelChip'),
        bodyClass: document.body.className,
        bootStep: document.body.getAttribute('data-boot') || '(未标记)',
      }))()`);

    let probe = await probeOnce();
    for (let i = 0; i < 12 && (probe.sessionCount === 0 || probe.workspaceRows === 0); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 250));
      // eslint-disable-next-line no-await-in-loop
      probe = await probeOnce();
    }

    // 如果会话没出来，收集诊断信息——不然只知道「失败了」，不知道卡在哪
    let diag = null;
    if (probe.sessionCount === 0) {
      diag = await win.webContents.executeJavaScript(`(async () => {
        const out = {
          sessionListHtml: (document.getElementById('wsList') || {}).innerHTML || '',
          hasEmptyState: !!document.querySelector('.empty'),
          toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent),
          apiSessions: null,
          apiError: '',
          localStorageOk: true,
        };
        try { localStorage.setItem('__probe', '1'); localStorage.removeItem('__probe'); }
        catch (e) { out.localStorageOk = false; out.localStorageError = String(e); }
        try {
          const r = await fetch('/api/sessions');
          out.apiSessions = (await r.json()).sessions.length;
        } catch (e) { out.apiError = String(e); }
        return out;
      })()`);
    }

    check(probe.hasDesktopBridge, `preload 桥已注入（window.myaDesktop）${probe.hasDesktopBridge ? '' : ' —— 桌面增强功能将不可用'}`);
    check(probe.hasMessages, '对话容器已渲染');
    check(probe.hasInput, '输入框已渲染');
    check(probe.sessionCount > 0, `会话列表已加载（${probe.sessionCount} 个）`);
    if (diag) {
      console.log(`    诊断：接口里有 ${diag.apiSessions} 个会话，localStorage ${diag.localStorageOk ? '可用' : '不可用'}`);
      if (diag.toasts.length) console.log(`    页面提示：${diag.toasts.join(' | ')}`);
      console.log(`    会话容器内容：${JSON.stringify(diag.sessionListHtml.slice(0, 200))}`);
      if (diag.apiError) console.log(`    接口错误：${diag.apiError}`);
      if (diag.localStorageError) console.log(`    localStorage 错误：${diag.localStorageError}`);
    }
    check(/is-desktop/.test(probe.bodyClass), '页面已识别为桌面模式');

    /* ---- 无边框窗口 ---- */
    check(win.isResizable() && !!win.getBounds, '窗口可调整大小（无边框窗口仍应保留系统缩放能力）');

    /* ---- 主题（浅色 / 深色） ---- */
    // 不只查 DOM 属性，还直接截图采样像素——那才是用户实际看到的东西。
    // 检查 DOM 只能证明「代码执行了」，采样像素才能证明「界面真的是白的」。
    const themeProbe = async () => {
      const info = await win.webContents.executeJavaScript(`(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          theme: document.documentElement.getAttribute('data-theme'),
          bgVar: cs.getPropertyValue('--bg').trim(),
          bodyBg: getComputedStyle(document.body).backgroundColor,
        };
      })()`);
      const image = await win.webContents.capturePage();
      const size = image.getSize();
      const bmp = image.toBitmap(); // BGRA 顺序
      let bright = 0;
      let samples = 0;
      // 每隔 97 个像素采一个（97 是质数，避免总是落在同一列）
      for (let i = 0; i + 3 < bmp.length; i += 4 * 97) {
        const lum = 0.299 * bmp[i + 2] + 0.587 * bmp[i + 1] + 0.114 * bmp[i];
        if (lum > 200) bright += 1;
        samples += 1;
      }
      return { ...info, size, brightRatio: samples ? bright / samples : 0 };
    };

    const shotDir = shotsDir || (reportFile ? path.dirname(reportFile) : ROOT);
    const saveShot = async (name) => {
      try {
        const img = await win.webContents.capturePage();
        const p = path.join(shotDir, name);
        fs.writeFileSync(p, img.toPNG());
        return p;
      } catch (err) {
        console.error(`    截图保存失败：${err && err.message}`);
        return '';
      }
    };

    const themeLight = await themeProbe();
    check(themeLight.theme === 'light', `默认主题是浅色（data-theme=${themeLight.theme}）`);
    check(!!themeLight.bgVar, `--bg 变量有值（${themeLight.bgVar}）`);
    check(
      themeLight.brightRatio > 0.6,
      `界面确实是白底（亮色像素占 ${(themeLight.brightRatio * 100).toFixed(0)}%）`,
    );

    check(probe.bootStep === 'done', `启动流程走完了（当前步骤：${probe.bootStep}）`);

    /* ---- 思考过程与上下文用量 ---- */
    // 这两块没法靠「发一条消息」来验（自检不带真实模型），
    // 但可以验证：容器在、样式在、渲染函数真的会把数字变成宽度。
    const meterInfo = await win.webContents.executeJavaScript(`(() => {
      const meter = document.getElementById('ctxMeter');
      const fill = document.getElementById('ctxFill');
      const text = document.getElementById('ctxText');
      const sub = document.getElementById('ctxSub');
      const tip = document.getElementById('ctxTip');
      const compact = document.getElementById('btnCompact');
      if (!meter || !fill || !text || !tip) return { missing: true };
      // 圆环拿周长反推进度：dashoffset = 周长 ×(1-比例)，所以比例 = 1 - offset/周长
      const ratioOf = () => {
        const r = (fill.r && fill.r.baseVal && fill.r.baseVal.value) || 9;
        const c = 2 * Math.PI * r;
        const off = parseFloat(fill.style.strokeDashoffset || 'NaN');
        return Number.isFinite(off) ? 1 - off / c : null;
      };
      const before = { ratio: ratioOf(), text: text.textContent };
      if (typeof renderContext === 'function') {
        window.__ctxBackup = state.context;
        state.context = { used: 96000, window: 128000, windowSource: 'gateway' };
        renderContext();
      }
      const after = {
        ratio: ratioOf(),
        pct: meter.dataset.pct,
        text: text.textContent,
        sub: sub ? sub.textContent : '',
        cls: meter.className,
        shown: !meter.hidden,
        stroke: getComputedStyle(fill).stroke,
        // 平时不展开，鼠标放上去（或键盘聚焦）才展开——
        // 这是用户明确要的「鼠标放上去再出现具体」
        tipBefore: getComputedStyle(tip).display,
        compactInside: !!(compact && compact.closest('#ctxMeter')),
      };
      meter.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
      const tipHover = getComputedStyle(tip).display;
      meter.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
      const tipAfterLeave = getComputedStyle(tip).display;
      // 再试一个「快到上限」的用量，应该换成告警色（档位挂在容器上）
      if (typeof renderContext === 'function') {
        state.context = { used: 126000, window: 128000 };
        renderContext();
      }
      const danger = { cls: meter.className, pct: meter.dataset.pct, stroke: getComputedStyle(fill).stroke };
      if (typeof renderContext === 'function') {
        state.context = window.__ctxBackup;
        renderContext();
      }
      return { before, after, danger, tipHover, tipAfterLeave };
    })()`);

    if (meterInfo.missing) {
      check(false, '上下文用量圆环的 DOM 结构不完整');
    } else {
      check(meterInfo.after.shown, '上下文用量圆环能显示出来');
      check(
        meterInfo.after.ratio !== null && meterInfo.after.ratio > 0.5 && meterInfo.after.ratio < 1,
        `圆环按比例画出进度（75% 用量 → ${(meterInfo.after.ratio * 100).toFixed(0)}%）`,
      );
      check(meterInfo.after.pct === '75', `用量百分比写在 data-pct 上（${meterInfo.after.pct}）`);
      check(
        meterInfo.after.text.includes('/') && meterInfo.after.text.includes('75%'),
        `悬停气泡里带上「已用 / 总量（百分比）」（${meterInfo.after.text}）`,
      );
      check(
        /窗口 128k/.test(meterInfo.after.sub) && /网关/.test(meterInfo.after.sub),
        `气泡第二行说清窗口来源（${meterInfo.after.sub}）`,
      );
      check(
        meterInfo.after.tipBefore === 'none' && meterInfo.tipHover !== 'none',
        `平时只显示圆环，鼠标放上去才展开具体数字（${meterInfo.after.tipBefore} → ${meterInfo.tipHover}）`,
      );
      check(meterInfo.tipAfterLeave === 'none', '鼠标移开之后气泡收起来');
      check(meterInfo.after.compactInside, '「压缩上下文」按钮跟着用量走（在同一个容器里）');
      check(
        meterInfo.after.cls.includes('ctx-meter') &&
          !!meterInfo.after.stroke &&
          meterInfo.after.stroke !== 'none',
        `圆环画出来了（档位=${meterInfo.after.cls}，描边=${meterInfo.after.stroke}）`,
      );
      check(meterInfo.danger.cls.includes('danger'), `用量接近上限时圆环变色告警（${meterInfo.danger.cls}）`);
    }

    const reasoningCss = await win.webContents.executeJavaScript(`(() => {
      const probe = document.createElement('div');
      probe.className = 'block reasoning collapsed';
      probe.innerHTML = '<div class="reasoning-body"></div>';
      document.body.appendChild(probe);
      const body = probe.querySelector('.reasoning-body');
      const collapsedDisplay = getComputedStyle(body).display;
      probe.classList.remove('collapsed');
      const openDisplay = getComputedStyle(body).display;
      const hasHead = typeof reasoningTitle === 'function';
      probe.remove();
      return { collapsedDisplay, openDisplay, hasHead };
    })()`);
    check(reasoningCss.collapsedDisplay === 'none', '思考块默认是折起来的（不占地方）');
    check(reasoningCss.openDisplay !== 'none', '思考块展开后能看到内容');
    check(reasoningCss.hasHead, '思考块的标题会显示耗时与 token 数');

    /* ---- 设置浮层 ---- */
    // 设置现在是一个独立按钮打开的浮层，不再常驻页面。
    // 这里要验证的是：平时不占位、点按钮能打开、里面内容齐全、Esc 能关掉。
    const drawerState = () =>
      win.webContents.executeJavaScript(`(() => {
        const d = document.getElementById('settingsDrawer');
        const b = document.getElementById('settingsBackdrop');
        if (!d) return { missing: true };
        const cs = getComputedStyle(d);
        return {
          open: d.classList.contains('open'),
          hidden: d.hidden,
          cls: d.className,
          display: cs.display,
          visibility: cs.visibility,
          width: Math.round(d.getBoundingClientRect().width),
          backdrop: !b || !b.hidden,
          tabs: d.querySelectorAll('.drawer-tab').length,
          views: d.querySelectorAll('.drawer-view').length,
          // 接入收在「模型与 API」里：浮层内是「接入运营商」下拉；
          // 填 Key 的弹窗在浮层**外面**（文档级 modal），所以 Key 要在 document 上找
          hasApiKey: !!d.querySelector('#apSelect') && !!document.querySelector('#apKey'),
          hasSwatches: !!d.querySelector('#accentSwatches'),
          hasPlugins: !!d.querySelector('#pluginList'),
          // 联网搜索是「能不能出网」的开关，内网用户第一个要找的就是它，
          // 所以它在设置里必须真的渲染出来（而不只是写在 HTML 里）
          hasWeb: !!d.querySelector('#setWebEnabled') && !!d.querySelector('#setWebProvider'),
          webEndpointHidden: (() => {
            // 默认后端是 bing，不该看到「自定义接口地址」那个输入框
            const f = d.querySelector('#webEndpointField');
            return f ? !!f.hidden : false;
          })(),
        };
      })()`);

    // 浮层相关的判断都靠 computed style，出问题时只看到「失败」两个字很难查，
    // 所以把关键状态一起打出来
    const drawerDiag = (label, s) =>
      console.log(
        `    ${label}：hidden=${s.hidden} class="${s.cls}" display=${s.display} ` +
          `visibility=${s.visibility} width=${s.width} backdrop=${s.backdrop}`,
      );

    // 打开浮层并切到指定视图。
    // 页面里的浮层有 220ms 滑出动画，而且它是「先显示、下一帧再加 .open」，
    // 所以点完不能立刻操作里面的控件，要等它真的可见。
    const openDrawerUi = async (view) => {
      const clickTab = `(() => {
        const t = document.querySelector('.drawer-tab[data-view="${view}"]');
        if (t) t.click();
        return true;
      })()`;
      await win.webContents.executeJavaScript(`(() => {
        if (document.getElementById('settingsDrawer').hidden) {
          document.getElementById('btnSettings').click();
        }
        return true;
      })()`);
      await win.webContents.executeJavaScript(clickTab);
      // 等浮层**真的画出来**再往下量。
      // 这里不能用 computed visibility 判断：元素即使 display:none，
      // 计算出来的 visibility 仍然可能是 'visible'，那个条件一上来就成立，
      // 等于没等——机器一忙，后面的色板就会量到 0px 高而假红（踩过）。
      // 所以改成量真实宽度 + 确认目标视图是 active 的，没到位就再点一次 tab
      // （别的异步流程——比如「没配 Key 时引导去设置」——可能把视图切回去）。
      for (let i = 0; i < 25; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const state = await win.webContents.executeJavaScript(`(() => {
          const d = document.getElementById('settingsDrawer');
          const v = document.querySelector('.drawer-view[data-view="${view}"]');
          return {
            open: !!d && !d.hidden && d.getBoundingClientRect().width > 10,
            active: !!v && v.classList.contains('active'),
            height: v ? Math.round(v.getBoundingClientRect().height) : 0,
          };
        })()`);
        if (state.open && state.active && state.height > 0) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 120));
        if (!state.active) {
          // eslint-disable-next-line no-await-in-loop
          await win.webContents.executeJavaScript(clickTab);
        }
      }
    };
    const closeDrawerUi = async () => {
      await win.webContents.executeJavaScript(`(() => {
        if (!document.getElementById('settingsDrawer').hidden) {
          document.getElementById('btnSettingsClose').click();
        }
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 400));
    };

    const drawerBefore = await drawerState();
    drawerDiag('浮层初始状态', drawerBefore);
    if (drawerBefore.open || drawerBefore.display !== 'none') {
      // 意外打开时把交互轨迹打出来——这是唯一能定位「谁点的」的线索
      const drawerTrace = await win.webContents.executeJavaScript(`window.__drawerTrace || []`);
      console.log('    交互轨迹（最近 40 条）：');
      for (const line of drawerTrace.slice(-40)) console.log(`      ${line}`);
      await closeDrawerUi();
    }
    check(drawerBefore.display === 'none' || !!drawerBefore.hidden, '设置平时是收起的，不占页面');

    await win.webContents.executeJavaScript(`document.getElementById('btnSettings').click()`);
    /**
     * 等浮层出现，而不是点完立刻判。
     * 原来重试预算只有 2.25 秒，机器在跑别的重活时会不够——这条探针偶发失败过一次
     * （紧跟全量回归之后跑桌面自检时）。现在放宽到 6 秒，超时后再补点一次：
     * 点击本身也可能落在渲染卡顿的窗口里丢掉。
     */
    const waitDrawer = async (rounds = 30) => {
      let state = null;
      for (let i = 0; i < rounds; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 200));
        // eslint-disable-next-line no-await-in-loop
        state = await drawerState();
        if (state.open && state.display !== 'none' && state.width > 100) break;
      }
      return state;
    };
    let drawerOpen = await waitDrawer();
    if (!drawerOpen.open) {
      await win.webContents.executeJavaScript(`document.getElementById('btnSettings').click()`);
      drawerOpen = await waitDrawer();
    }
    drawerDiag('点开之后', drawerOpen);
    check(drawerOpen.open, '点「设置」按钮能把设置浮层打开');
    check(drawerOpen.tabs >= 5 && drawerOpen.views >= 5, `设置里分成了 ${drawerOpen.tabs} 个视图`);
    check(drawerOpen.hasApiKey, 'API 接入收进了设置里（接入运营商下拉 + 弹窗里的 Key）');
    check(drawerOpen.hasSwatches, '主题色选择收进了设置里');
    check(drawerOpen.hasPlugins, '插件管理收进了设置里');
    check(drawerOpen.hasWeb, '联网搜索的开关和后端选择收进了设置里');
    check(drawerOpen.webEndpointHidden, '默认后端（Bing）下不显示「自定义接口地址」（用不着填）');

    await win.webContents.executeJavaScript(`document.getElementById('btnSettingsClose').click()`);
    let drawerClosed = null;
    for (let i = 0; i < 15; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 150));
      // eslint-disable-next-line no-await-in-loop
      drawerClosed = await drawerState();
      if (drawerClosed.display === 'none' || drawerClosed.hidden) break;
    }
    drawerDiag('关掉之后', drawerClosed);
    check(
      drawerClosed.display === 'none' || !!drawerClosed.hidden,
      `关掉之后设置不再占页面（display=${drawerClosed.display}）`,
    );

    /* ---- 输入区的模型切换按钮 ---- */
    // 用户要求「在对话框位置添加一个更换模型的按钮」。
    // 这里只验证界面行为：按钮在输入区里、点了浮层出来、点外面或按 Esc 能收起。
    // 不真的切模型——那会写进用户自己的 config.json。
    const modelProbe = () =>
      win.webContents.executeJavaScript(`(() => {
        const btn = document.getElementById('btnModelSwitch');
        const pop = document.getElementById('modelPop');
        if (!btn || !pop) return { missing: true };
        const rect = btn.getBoundingClientRect();
        return {
          label: (document.getElementById('composerModelName') || {}).textContent || '',
          inComposer: !!btn.closest('.composer'),
          visible: rect.width > 0 && rect.height > 0,
          popHidden: pop.hidden,
          popDisplay: getComputedStyle(pop).display,
          popCurrent: (document.getElementById('modelPopCurrent') || {}).textContent || '',
          // 用户要求「选择模型下面不要有多余的话」：浮动层里不该再有那行说明
          extraWords: !!document.getElementById('modelPopHint') || !!document.getElementById('reasonHint'),
        };
      })()`);

    const modelBefore = await modelProbe();
    if (modelBefore.missing) {
      check(false, '输入区里找不到模型切换按钮');
    } else {
      check(modelBefore.inComposer && modelBefore.visible, `输入区有换模型的按钮（显示为「${modelBefore.label}」）`);
      // 模型名**后面**那个标记必须是个**正圆**的点（用户明确要求「把它改成圆点」）：
      // 宽高相等 + border-radius 50%，这两条缺一条就会变成椭圆或方块
      const dotBox = await win.webContents.executeJavaScript(`(() => {
        const dot = document.getElementById('composerDot');
        if (!dot) return { missing: true };
        const r = dot.getBoundingClientRect();
        const cs = getComputedStyle(dot);
        return {
          w: Math.round(r.width), h: Math.round(r.height),
          radius: cs.borderRadius, bg: cs.backgroundColor,
          round: cs.borderRadius === '50%',
        };
      })()`);
      if (dotBox.missing) {
        check(false, '模型名后面没有圆点');
      } else {
        check(dotBox.w === dotBox.h && dotBox.w > 3, `圆点是正圆（${dotBox.w}×${dotBox.h}）`);
        check(dotBox.round, `圆点用的是 50% 圆角（${dotBox.radius}）`);
        check(!!dotBox.bg && dotBox.bg !== 'rgba(0, 0, 0, 0)', `圆点有填充色（${dotBox.bg}）`);
      }
      check(modelBefore.popHidden && modelBefore.popDisplay === 'none', '模型浮层默认是收起的');

      await win.webContents.executeJavaScript(`document.getElementById('btnModelSwitch').click()`);
      let modelOpen = modelBefore;
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
        // eslint-disable-next-line no-await-in-loop
        modelOpen = await modelProbe();
        if (!modelOpen.popHidden && modelOpen.popDisplay !== 'none') break;
      }
      check(!modelOpen.popHidden && modelOpen.popDisplay !== 'none', '点按钮能弹出模型切换浮层');
      check(!!modelOpen.popCurrent, `浮层里标出了当前模型（${modelOpen.popCurrent}）`);
      // 用户明确要求「选择模型下面不要有多余的话」：那两行说明已经删掉，
      // 这条断言是防止有人再顺手加回去
      check(modelOpen.extraWords === false, '模型浮层里没有多余的说明文字（只留列表和当前模型）');

      // 点浮层外面应该收起来
      await win.webContents.executeJavaScript(`document.getElementById('messages').click()`);
      let modelAfterOutside = modelOpen;
      for (let i = 0; i < 15; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
        // eslint-disable-next-line no-await-in-loop
        modelAfterOutside = await modelProbe();
        if (modelAfterOutside.popHidden) break;
      }
      check(modelAfterOutside.popHidden, '点浮层外面能把它收起来');

      // Esc 也要能关（和设置浮层一致的交互习惯）
      await win.webContents.executeJavaScript(`document.getElementById('btnModelSwitch').click()`);
      await new Promise((r) => setTimeout(r, 220));
      await win.webContents.executeJavaScript(
        `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
      );
      let modelAfterEsc = modelOpen;
      for (let i = 0; i < 15; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
        // eslint-disable-next-line no-await-in-loop
        modelAfterEsc = await modelProbe();
        if (modelAfterEsc.popHidden) break;
      }
      check(modelAfterEsc.popHidden, '按 Esc 能收起模型浮层');
    }

    /* ---- Codex 观感的三个结构约束 ----
       这三条是「界面长什么样」的硬约束，靠肉眼看截图容易漏，所以用真实 DOM 量：
       ① 顶栏中间要显示当前会话标题（不然切了会话都不知道自己在哪一轮里）；
       ② 输入框是一个圆角框，模型按钮 / 累计用量 / 发送键都在**框里面**——
          这是 Codex 输入区的关键，散到框外就退回成三行各管各的；
       ③ 工具行是一行灰字 + 12px 对勾/叉（不是实心圆点），高度 ≤ 30px 且不描边。 */
    const codexProbe = await win.webContents.executeJavaScript(`(() => {
      const cs = (el, p) => (el ? getComputedStyle(el)[p] : '');
      const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : 0);
      const w = (el) => (el ? Math.round(el.getBoundingClientRect().width) : 0);

      const title = document.getElementById('topTitle');
      const activeItem = document.querySelector('.ws-session.active .t');
      const box = document.querySelector('.composer-box');
      const bar = document.querySelector('.composer-bar');
      const modelBtn = document.getElementById('btnModelSwitch');
      const usage = document.getElementById('usageHint');
      const send = document.getElementById('btnSend');
      const compact = document.getElementById('btnCompact');

      // 注入一个「成功的工具调用」，量它的行高与状态图标，量完就摘掉
      let tool = null;
      if (typeof renderBlock === 'function') {
        const node = renderBlock({
          seq: 987656, type: 'tool', name: 'read',
          args: { path: 'src/app.js' }, ok: true, summary: '读取 src/app.js（120 行）', ms: 18, output: '',
        });
        const head = node.querySelector('.tool-head');
        const dot = node.querySelector('.state-dot');
        tool = {
          headH: h(head),
          border: cs(head, 'borderTopWidth'),
          hasIcon: !!(dot && dot.querySelector('svg')),
          iconColor: dot ? cs(dot, 'color') : '',
          nameMono: /mono/i.test(cs(node.querySelector('.tool-name'), 'fontFamily')),
        };
        node.remove();
        state.blocks.delete(987656);
      }

      return {
        titleText: title ? title.textContent.trim() : '',
        activeTitle: activeItem ? activeItem.textContent.trim() : '',
        hasTitle: !!title,
        titleWidth: w(title),
        boxRadius: cs(box, 'borderRadius'),
        boxBorder: cs(box, 'borderTopWidth'),
        barInBox: !!(bar && box && box.contains(bar)),
        barH: h(bar),
        modelInBox: !!(modelBtn && box && box.contains(modelBtn)),
        usageInBox: !!(usage && box && box.contains(usage)),
        sendInBox: !!(send && box && box.contains(send)),
        sendRadius: cs(send, 'borderRadius'),
        compactInMeter: !!(compact && compact.closest('#ctxMeter')),
        tool,
      };
    })()`);

    check(codexProbe.hasTitle && codexProbe.titleWidth > 0, '顶栏中间显示着当前会话标题');
    check(
      !!codexProbe.titleText && codexProbe.titleText === codexProbe.activeTitle,
      `顶栏标题跟着当前会话走（「${codexProbe.titleText}」）`,
    );
    check(
      codexProbe.barInBox && codexProbe.modelInBox && codexProbe.usageInBox && codexProbe.sendInBox,
      '输入区是一个框：工具条、模型按钮、累计用量、发送键都在框里',
    );
    check(parseFloat(codexProbe.boxBorder) >= 1 && parseFloat(codexProbe.boxRadius) >= 12, `输入框有描边和圆角（${codexProbe.boxBorder} / ${codexProbe.boxRadius}）`);
    check(codexProbe.sendRadius === '50%', `发送键是圆形（${codexProbe.sendRadius}）`);
    check(codexProbe.compactInMeter, '「压缩上下文」按钮跟着上下文用量走（同一个容器里）');
    if (codexProbe.tool) {
      check(codexProbe.tool.headH > 0 && codexProbe.tool.headH <= 30, `工具行是一行灰字（高 ${codexProbe.tool.headH}px）`);
      check(codexProbe.tool.border === '0px', '工具行不描边（不做成卡片）');
      check(codexProbe.tool.hasIcon, '工具状态是画出来的对勾/叉，不是一个实心圆点');
      check(codexProbe.tool.nameMono, '工具名用等宽体（和中文参数一眼分开）');
    } else {
      check(false, '工具行渲染函数没注入成功，无法验证工具行观感');
    }

    /* ---- 用户消息只显示一条（乐观渲染 vs 服务端广播的去重）----
       用户报过：「输入框里的话点发送之后出现两行」。
       根因是客户端先乐观渲染一条，服务端随后又把同一条作为 block 广播回来，
       而渲染函数无条件新建节点，于是同一句话在对话里出现两次。
       这里用真实 DOM 走一遍两条路径，确认它们会合并成一条。 */
    const dedupProbe = await win.webContents.executeJavaScript(`(async () => {
      const text = '唯一性测试-' + Date.now();
      const el = renderBlock({ seq: state.lastSeq + 1, type: 'user', text });
      state.pendingUser.push({ text, el });
      await handleEvent({ type: 'block', sessionId: state.currentId, block: { seq: 987001, type: 'user', text, ts: Date.now() } });
      const nodes = [...document.querySelectorAll('.block.user')].filter((n) => n.textContent.includes(text));
      const first = nodes[0] || null;
      const out = {
        count: nodes.length,
        adoptedSeq: first ? first.dataset.seq : '',
        mapped: !!first && state.blocks.get(987001) === first,
        pendingCleared: state.pendingUser.length === 0,
      };
      // 连着发两条：两条都要各自被认领（服务端第二条会排队，回来得晚）
      const t1 = '连发甲-' + Date.now();
      const t2 = '连发乙-' + Date.now();
      const e1 = renderBlock({ seq: state.lastSeq + 1, type: 'user', text: t1 });
      state.pendingUser.push({ text: t1, el: e1 });
      const e2 = renderBlock({ seq: state.lastSeq + 2, type: 'user', text: t2 });
      state.pendingUser.push({ text: t2, el: e2 });
      await handleEvent({ type: 'block', sessionId: state.currentId, block: { seq: 987011, type: 'user', text: t1, ts: Date.now() } });
      await handleEvent({ type: 'block', sessionId: state.currentId, block: { seq: 987012, type: 'user', text: t2, ts: Date.now() } });
      const countOf = (t) => [...document.querySelectorAll('.block.user')].filter((n) => n.textContent.includes(t)).length;
      out.pairA = countOf(t1);
      out.pairB = countOf(t2);
      out.pairMapped = state.blocks.get(987011) === e1 && state.blocks.get(987012) === e2;
      out.pairQueueEmpty = state.pendingUser.length === 0;
      // 再验一次「同 seq 渲染两次也只留一个节点」
      renderBlock({ seq: 987002, type: 'user', text: '重复渲染测试' });
      renderBlock({ seq: 987002, type: 'user', text: '重复渲染测试' });
      out.sameSeqCount = countOf('重复渲染测试');
      nodes.forEach((n) => n.remove());
      [e1, e2].forEach((n) => n.remove());
      [...document.querySelectorAll('.block.user')].filter((n) => n.textContent.includes('重复渲染测试')).forEach((n) => n.remove());
      state.blocks.delete(987001);
      state.blocks.delete(987011);
      state.blocks.delete(987012);
      state.blocks.delete(987002);
      state.pendingUser = [];
      return out;
    })()`);
    check(dedupProbe.count === 1, `发一句话只显示一条（实际 ${dedupProbe.count} 条）`);
    check(dedupProbe.mapped && dedupProbe.adoptedSeq === '987001', '服务端回来的 block 会认领乐观渲染的节点（补上真实 seq，而不是新建）');
    check(dedupProbe.pendingCleared, '认领之后待认领状态要清掉');
    check(dedupProbe.pairA === 1 && dedupProbe.pairB === 1, `连着发两条也各只显示一条（实际 ${dedupProbe.pairA} / ${dedupProbe.pairB} 条）`);
    check(dedupProbe.pairMapped && dedupProbe.pairQueueEmpty, '两条按先后顺序各自认领（单槽会被后一条覆盖）');
    check(dedupProbe.sameSeqCount === 1, `同一个 seq 渲染两次也只留一条（实际 ${dedupProbe.sameSeqCount} 条）`);

    /* ---- 接入运营商：下拉选一个 → 弹窗填 API 信息（用户要的接入形态）---- */
    const accessProbe = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // 设置浮层是懒加载的：先打开它
      document.getElementById('btnSettings').click();
      for (let i = 0; i < 20 && !document.querySelector('#apSelect'); i += 1) await sleep(150);
      const sel = document.getElementById('apSelect');
      const out = {
        hasSelect: !!sel,
        optionCount: sel ? sel.options.length : 0,
        hasNew: sel ? [...sel.options].some((o) => o.value === '__new__') : false,
        hasCapture: sel ? [...sel.options].some((o) => o.value === '__capture__') : false,
        backdropHiddenAtStart: !!document.getElementById('accessBackdrop')?.hidden,
        modalFields: ['apName', 'apProvider', 'apBaseUrl', 'apModel', 'apFormat', 'apKey', 'apSave'].filter((id) => !!document.getElementById(id)).length,
      };
      // 选「＋ 新建接入…」→ 弹窗必须出现
      if (sel) {
        sel.value = '__new__';
        sel.dispatchEvent(new Event('change'));
        await sleep(200);
        out.backdropVisibleAfterNew = !document.getElementById('accessBackdrop').hidden;
        out.titleAfterNew = (document.getElementById('accessTitle') || {}).textContent || '';
        // 关掉，别把浮层留在屏幕上
        const cancel = document.getElementById('apCancel');
        if (cancel) cancel.click();
        await sleep(150);
        out.backdropHiddenAfterCancel = !!document.getElementById('accessBackdrop').hidden;
      }
      // 收起设置浮层，恢复界面
      const closeBtn = document.getElementById('btnSettingsClose');
      if (closeBtn) closeBtn.click();
      return out;
    })()`);

    check(accessProbe.hasSelect, '「模型与 API」里有接入运营商下拉');
    check(accessProbe.optionCount >= 2, `下拉里有选项（${accessProbe.optionCount} 个：存档 + 两个动作项）`);
    check(accessProbe.hasNew && accessProbe.hasCapture, '下拉带「新建接入」与「把当前配置存为一条」');
    check(accessProbe.backdropHiddenAtStart, '接入弹窗默认是关着的');
    check(accessProbe.modalFields === 7, `弹窗字段齐全（${accessProbe.modalFields}/7）`);
    check(accessProbe.backdropVisibleAfterNew === true, '选「新建接入」会弹出填 API 信息的表单');
    check(/新建接入/.test(accessProbe.titleAfterNew || ''), `弹窗标题要说清在干什么（${accessProbe.titleAfterNew}）`);
    check(accessProbe.backdropHiddenAfterCancel === true, '点取消能把弹窗关掉');

    /* ---- 工作区树：工作区 = 文件夹，会话挂在它下面，可上下展开 ----
       这是用户明确要的形态（「我想要的是这段会话所处的文件夹这种工作区」），
       所以逐条用真实 DOM 验：行结构、展开收起、会话子行、归档分组。 */
    const wsProbe = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 20 && !document.querySelector('#wsList .ws-item'); i += 1) await sleep(200);

      const items = [...document.querySelectorAll('#wsList .ws-item')];
      const first = items[0] || null;
      const out = {
        workspaces: items.length,
        hasCaret: !!(first && first.querySelector('.ws-head .ws-caret')),
        hasIcon: !!(first && first.querySelector('.ws-head .ws-icon')),
        name: first ? (first.querySelector('.ws-name') || {}).textContent || '' : '',
        countBadge: first ? (first.querySelector('.ws-count') || {}).textContent || '' : '',
        headTitle: first ? (first.querySelector('.ws-head') || {}).title || '' : '',
        hasNewBtn: !!(first && first.querySelector('[data-act="new"]')),
        hasMoreBtn: !!(first && first.querySelector('[data-act="more"]')),
        sessionsWhenOpen: first ? first.querySelectorAll('.ws-session').length : 0,
        openBefore: first ? first.classList.contains('open') : false,
        sideSections: [...document.querySelectorAll('.side-section')].map((s) => s.id),
        noSessionSection: !document.getElementById('sessionSection'),
        hasArchivedGroup: !!document.getElementById('wsArchived'),
      };

      // 折起来：会话子行应当从 DOM 里消失
      if (first) {
        first.querySelector('.ws-head').click();
        await sleep(120);
        const after = document.querySelector('#wsList .ws-item');
        out.openAfterCollapse = after.classList.contains('open');
        out.sessionsWhenCollapsed = after.querySelectorAll('.ws-session').length;
        // 再点开：回来
        after.querySelector('.ws-head').click();
        await sleep(120);
        const again = document.querySelector('#wsList .ws-item');
        out.openAfterExpand = again.classList.contains('open');
        out.sessionsAfterExpand = again.querySelectorAll('.ws-session').length;
      }

      // 归档一条会话：它应当离开工作区、出现在「已归档」组里
      const target = state.sessions.find((s) => !s.archived);
      if (target) {
        await setArchived(target, true);
        await sleep(200);
        out.archivedGroupVisible = !document.getElementById('wsArchived').hidden;
        out.archivedRows = document.querySelectorAll('#wsArchList .ws-session').length;
        // 收尾：恢复原状，别把沙箱里的会话留在归档里
        await setArchived(target, false);
        await sleep(150);
        out.restoredRows = document.querySelectorAll('#wsArchList .ws-session').length;
      }
      return out;
    })()`);

    check(wsProbe.workspaces >= 1, `工作区树里有工作区（${wsProbe.workspaces} 个）`);
    check(wsProbe.hasCaret && wsProbe.hasIcon, '工作区行有展开箭头和文件夹图标');
    check(wsProbe.name.length > 0, `工作区显示文件夹名（「${wsProbe.name}」）`);
    check(wsProbe.headTitle.includes(':\\') || wsProbe.headTitle.includes(':/'), '工作区行悬停能看到完整路径');
    check(wsProbe.hasNewBtn && wsProbe.hasMoreBtn, '工作区行有「+ 新建会话」与「⋯ 更多」两个动作');
    check(wsProbe.openBefore && wsProbe.sessionsWhenOpen >= 1, `含当前会话的工作区默认展开，并列出会话（${wsProbe.sessionsWhenOpen} 条）`);
    check(wsProbe.openAfterCollapse === false && wsProbe.sessionsWhenCollapsed === 0, '点一下能折起来（会话子行从 DOM 里消失）');
    check(wsProbe.openAfterExpand === true && wsProbe.sessionsAfterExpand >= 1, '再点一下能展开回来');
    check(wsProbe.noSessionSection, '侧栏不再有独立的「会话」段（会话已经挂在工作区下面）');
    check(wsProbe.hasArchivedGroup, '底部有「已归档」组');
    if (wsProbe.archivedRows !== undefined) {
      check(wsProbe.archivedGroupVisible && wsProbe.archivedRows >= 1, `归档后会收进「已归档」组（${wsProbe.archivedRows} 条）`);
      check(wsProbe.restoredRows === 0, '取消归档后能还原回去（组里不留残留）');
    }

    /* ---- 展开式模型列表 + 推理等级 + 侧栏按钮已去掉 ----
       这三条也是「界面长什么样」的硬约束：
       ① 模型列表要按前缀分组、能折叠、能过滤（用户要的「展开式」）；
       ② 推理等级的选项必须来自服务端按当前协议生成的官方取值，并且每档都写清
          「实际会发什么字段」；
       ③ 侧栏底部那两个按钮（刷新 / 重扫插件）必须真的不在了。 */
    // 量宽度必须让浮层**真的可见**：隐藏子树里 getBoundingClientRect 全是 0，
    // 会把「竖排占满整行」误判成没布局（踩过一次）
    await win.webContents.executeJavaScript(`(() => {
      const pop = document.getElementById('modelPop');
      if (pop && pop.hidden) document.getElementById('btnModelSwitch').click();
    })()`);
    await new Promise((r) => setTimeout(r, 200));

    const modelPanel = await win.webContents.executeJavaScript(`(() => {
      const box = document.getElementById('modelPopList');
      const reason = document.getElementById('modelPopReason');
      const seg = document.getElementById('reasonLevels');
      if (!box) return { missing: true };

      // 造一份「像真实网关那样」的模型列表，喂给渲染函数，看它怎么分组。
      // 必须把「当前模型」也放进去：分组默认只展开含当前模型的那一组
      // （组多的时候全展开等于没分组），不放进去就没有任何一组是展开的
      const current = typeof currentModel === 'function' ? currentModel() : '';
      const models = [
        current ? { id: current } : null,
        { id: 'deepseek-chat' }, { id: 'deepseek-reasoner' },
        { id: 'gpt-5' }, { id: 'gpt-5-mini' },
        { id: 'claude-sonnet-4' }, { id: 'qwen2.5-72b' }, { id: 'text-embedding-3' },
      ].filter(Boolean);
      if (typeof renderModelPopList === 'function') renderModelPopList(models);

      const groups = [...box.querySelectorAll('.model-group')].map((g) => ({
        key: g.dataset.group,
        open: g.classList.contains('open'),
        rows: g.querySelectorAll('.model-row').length,
      }));
      // 找「展开着的那一组」来验证折叠行为，而不是默认拿第一个
      const first = box.querySelector('.model-group.open') || box.querySelector('.model-group');
      const firstBody = first ? first.querySelector('.model-group-body') : null;
      const openDisplay = firstBody ? getComputedStyle(firstBody).display : '';
      // 点一下组标题：应该折叠起来（再点一下还原）
      const head = first ? first.querySelector('.model-group-head') : null;
      if (head) head.click();
      const afterClickOpen = first ? first.classList.contains('open') : null;
      const closedDisplay = firstBody ? getComputedStyle(firstBody).display : '';
      if (head) head.click();

      // 输入过滤：只留 claude 那一组
      if (typeof filterModelPopList === 'function') filterModelPopList('claude');
      const filtered = [...box.querySelectorAll('.model-group')].map((g) => ({
        key: g.dataset.group,
        hidden: g.classList.contains('hide'),
        rows: [...g.querySelectorAll('.model-row')].filter((r) => !r.classList.contains('hide')).length,
      }));
      if (typeof filterModelPopList === 'function') filterModelPopList('');

      const info = state.info && state.info.reasoning;

      /* ---- 推理等级：上下展开的抽屉 ----
         用户要求「推理等级改为上下展开的抽屉格式」。这里量三件事：
         默认收起、点标题展开、展开后每档是竖排（宽度接近整行而不是并排小标签）。 */
      const reasonWrap = document.getElementById('modelPopReason');
      const toggle = document.getElementById('reasonToggle');
      const drawerClosedDisplay = seg ? getComputedStyle(seg).display : '';
      if (toggle) toggle.click();
      const drawerOpenDisplay = seg ? getComputedStyle(seg).display : '';
      const drawerOpen = reasonWrap ? reasonWrap.classList.contains('open') : null;
      const optBoxes = seg
        ? [...seg.querySelectorAll('.seg-btn')].map((b) => {
            const r = b.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) };
          })
        : [];
      // 竖排的标志：每个按钮都占满容器宽度，且容器是 column
      const drawerDir = seg ? getComputedStyle(seg).flexDirection : '';
      if (toggle) toggle.click();

      return {
        groups,
        openDisplay,
        afterClickOpen,
        closedDisplay,
        filtered,
        // 抽屉
        drawerClosedDisplay,
        drawerOpenDisplay,
        drawerOpen,
        drawerDir,
        optWidths: optBoxes.map((b) => b.w),
        optCount: optBoxes.length,
        // 默认展开的应该是含当前模型的那一组（组多时只展开它）
        openGroupIsCurrent:
          groups.filter((g) => g.open).length === 1 &&
          /^deepseek|^gpt|^claude|^qwen|^text/.test(
            (groups.find((g) => g.open) || {}).key || '',
          ) &&
          String(current || '').toLowerCase().startsWith((groups.find((g) => g.open) || {}).key || '###'),
        nonChatTagged: !!box.querySelector('.model-row.warn'),
        reasonShown: reason ? !reason.hidden : null,
        seg: seg ? [...seg.querySelectorAll('.seg-btn')].map((b) => ({ value: b.dataset.level, label: b.textContent, title: b.title, active: b.classList.contains('active') })) : [],
        infoLevel: (info && info.level) || '',
        infoFormat: (info && info.format) || '',
        sidebarButtonsGone: !document.getElementById('btnRefresh') && !document.getElementById('btnRescan'),
      };
    })()`);

    if (modelPanel.missing) {
      check(false, '模型列表容器不见了');
    } else {
      check(
        modelPanel.groups.length >= 4 && modelPanel.groups.every((g) => g.rows > 0),
        `模型列表按前缀分组（${modelPanel.groups.map((g) => `${g.key}:${g.rows}`).join(' ')}）`,
      );
      check(modelPanel.openDisplay !== 'none', '默认展开的分组能看到里面的模型');
      check(
        modelPanel.afterClickOpen === false && modelPanel.closedDisplay === 'none',
        '点分组标题能折叠起来（展开式列表该有的行为）',
      );
      const visible = modelPanel.filtered.filter((g) => !g.hidden);
      check(
        visible.length === 1 && visible[0].key === 'claude' && visible[0].rows === 1,
        `输入框能过滤列表（只剩 ${visible.map((g) => `${g.key}:${g.rows}`).join(' ')}）`,
      );
      check(modelPanel.nonChatTagged, '非对话模型（embedding 那类）被标出来');
      check(modelPanel.openGroupIsCurrent, '默认展开的正是含当前模型的那一组');
      check(modelPanel.reasonShown === true, '模型面板里显示着推理等级');
      check(
        modelPanel.seg.length >= 4 && modelPanel.seg.some((b) => b.value === 'auto'),
        `推理等级给出了 ${modelPanel.seg.length} 档（${modelPanel.seg.map((b) => b.value).join('/')}）`,
      );
      check(
        modelPanel.seg.every((b) => !!b.title),
        '每一档都说清了「实际会发什么字段」（官方参数名/取值）',
      );
      check(
        modelPanel.seg.some((b) => b.active),
        `当前等级有选中态（${(modelPanel.seg.find((b) => b.active) || {}).value || '无'}）`,
      );
      // 推理等级是「上下展开的抽屉」：默认收起 → 点标题展开 → 每档竖排占满整行
      check(modelPanel.drawerClosedDisplay === 'none', `推理等级默认是收起的（display=${modelPanel.drawerClosedDisplay}）`);
      check(
        modelPanel.drawerOpenDisplay !== 'none' && modelPanel.drawerOpen === true,
        '点「推理等级」能把它展开（抽屉行为）',
      );
      check(modelPanel.drawerDir === 'column', `抽屉里的选项是上下排的（flex-direction=${modelPanel.drawerDir}）`);
      check(
        modelPanel.optWidths.length >= 4 && modelPanel.optWidths.every((w) => w >= 150),
        `每一档都占满整行宽度（${modelPanel.optWidths.join('/')}）`,
      );
      check(modelPanel.sidebarButtonsGone, '侧栏底部的「刷新 / 重扫插件」已经去掉');
    }

    /* ---- 输入区的「附件 + 权限」----
       用户要求：加号能选文件/文件夹/压缩包；权限栏三档（询问 / 工作区内执行 / 完全权限）。
       原生对话框没法自动点，所以这里验证「菜单出来了、三项都在、桥接函数在、
       当前档位显示正确」，真实的文件选择交给桌面桥（它只回路径，不读内容）。 */
    const toolbar = await win.webContents.executeJavaScript(`(async () => {
      const attach = document.getElementById('btnAttach');
      const perm = document.getElementById('btnApproval');
      if (!attach || !perm) return { missing: true };
      const bridge = window.myaDesktop || {};
      attach.click();
      await new Promise((r) => setTimeout(r, 60));
      const attachPop = document.getElementById('attachPop');
      const attachItems = attachPop ? [...attachPop.querySelectorAll('.menu-row')].map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim()) : [];
      const attachVisible = attachPop ? !attachPop.hidden : false;
      // 附件菜单和权限菜单应当互斥：打开权限菜单时附件菜单要收起来
      perm.click();
      await new Promise((r) => setTimeout(r, 60));
      const approvalPop = document.getElementById('approvalPop');
      const approvalItems = approvalPop ? [...approvalPop.querySelectorAll('.menu-row')].map((b) => b.dataset.mode) : [];
      const approvalVisible = approvalPop ? !approvalPop.hidden : false;
      const attachStillOpen = attachPop ? !attachPop.hidden : false;
      const current = (state.info && state.info.approval && state.info.approval.mode) || '';
      const shown = (document.getElementById('approvalLabel') || {}).textContent || '';
      const active = approvalPop ? [...approvalPop.querySelectorAll('.menu-row.active')].map((b) => b.dataset.mode) : [];
      document.getElementById('messages').click();
      await new Promise((r) => setTimeout(r, 60));
      const bothClosed = (attachPop ? attachPop.hidden : true) && (approvalPop ? approvalPop.hidden : true);
      return {
        hasBridge: typeof bridge.chooseAttachment === 'function',
        attachVisible, attachItems,
        approvalVisible, approvalItems, attachStillOpen,
        current, shown, active, bothClosed,
      };
    })()`);

    if (toolbar.missing) {
      check(false, '输入区里找不到附件 / 权限按钮');
    } else {
      check(toolbar.hasBridge, '桌面桥暴露了 chooseAttachment（文件/文件夹/压缩包）');
      check(toolbar.attachVisible && toolbar.attachItems.length === 3, `加号菜单有 3 项（${toolbar.attachItems.join(' / ')}）`);
      check(
        toolbar.attachItems.join(' ').includes('文件') &&
          toolbar.attachItems.join(' ').includes('文件夹') &&
          toolbar.attachItems.join(' ').includes('压缩包'),
        '加号菜单能选 文件 / 文件夹 / 压缩包',
      );
      check(
        toolbar.approvalVisible && toolbar.approvalItems.join(',') === 'ask,workspace,full',
        `权限栏有三个档位（${toolbar.approvalItems.join(' / ')}）`,
      );
      check(toolbar.attachStillOpen === false, '打开权限菜单时附件菜单会收起（互斥）');
      check(!!toolbar.current && toolbar.active.length === 1 && toolbar.active[0] === toolbar.current, `按钮上显示的就是当前档位（${toolbar.shown} / ${toolbar.current}）`);
      check(toolbar.bothClosed, '点别处能把这两个菜单收起来');

      /* ---- 「完全权限」要弹一次确认，而且取消之后不能真的生效 ----
         这条特别值得自动验：它用的是**用户真实的配置文件路径**（桌面自检的配置目录），
         所以只走「取消」这条路——既证明了会拦，又不会把用户的权限真的放开。 */
      const fullGuard = await win.webContents.executeJavaScript(`(async () => {
        const before = (state.info && state.info.approval && state.info.approval.mode) || '';
        document.getElementById('btnApproval').click();
        await new Promise((r) => setTimeout(r, 50));
        const row = [...document.querySelectorAll('#approvalPop .menu-row')].find((b) => b.dataset.mode === 'full');
        if (!row) return { missing: true };
        row.click();
        await new Promise((r) => setTimeout(r, 120));
        const backdrop = document.getElementById('permBackdrop');
        const shown = backdrop ? !backdrop.hidden : false;
        const focused = document.activeElement ? document.activeElement.id : '';
        const title = (document.getElementById('permTitle') || {}).textContent || '';
        // 取消：权限必须原封不动
        document.getElementById('btnPermCancel').click();
        await new Promise((r) => setTimeout(r, 200));
        const after = (state.info && state.info.approval && state.info.approval.mode) || '';
        const hiddenAfter = backdrop ? backdrop.hidden : true;
        return { before, shown, focused, title, after, hiddenAfter };
      })()`);
      if (fullGuard.missing) {
        check(false, '权限菜单里找不到「完全权限」这一档');
      } else {
        check(fullGuard.shown === true, '选「完全权限」会弹出确认提示');
        check(/不再询问|不再问/.test(fullGuard.title), `提示里说清了代价（${fullGuard.title}）`);
        check(fullGuard.focused === 'btnPermCancel', `默认焦点在「取消」上（实际 ${fullGuard.focused}）`);
        check(fullGuard.hiddenAfter === true, '取消之后提示会收起来');
        check(
          fullGuard.after === fullGuard.before,
          `取消之后权限必须保持原样（${fullGuard.before} → ${fullGuard.after}）`,
        );
      }
    }

    /* ---- 新建会话先选目录 ---- */
    // 用户要求「新建对话应该出现让我选择目录」。
    // 这里只验证弹窗会出来、能取消（真正确认会创建会话，自检不该留下垃圾会话）。
    const dirProbe = () =>
      win.webContents.executeJavaScript(`(() => {
        const backdrop = document.getElementById('dirBackdrop');
        const input = document.getElementById('dirInput');
        if (!backdrop || !input) return { missing: true };
        return {
          hidden: backdrop.hidden,
          display: getComputedStyle(backdrop).display,
          value: input.value,
          choices: document.querySelectorAll('#dirChoices .dir-chip').length,
          canCreate: !document.getElementById('btnDirCreate').hidden,
          hasBrowse: !document.getElementById('btnDirBrowse').hidden,
          nativePicker: !!(window.myaDesktop && typeof window.myaDesktop.chooseDirectory === 'function'),
        };
      })()`);

    const dirBefore = await dirProbe();
    if (dirBefore.missing) {
      check(false, '找不到「选工作目录」的弹窗');
    } else {
      check(dirBefore.hidden, '选目录弹窗默认不显示');
      check(dirBefore.nativePicker, '桌面程序里能用系统原生目录选择框');
      await win.webContents.executeJavaScript(`document.getElementById('btnNew').click()`);
      let dirOpen = dirBefore;
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
        // eslint-disable-next-line no-await-in-loop
        dirOpen = await dirProbe();
        if (!dirOpen.hidden && dirOpen.display !== 'none') break;
      }
      check(!dirOpen.hidden && dirOpen.display !== 'none', '点「新建会话」会先弹出选目录');
      check(!!dirOpen.value, `弹窗里预填了上次用过的目录（${dirOpen.value}）`);

      // 子目录列表必须真的列出来。为了不受「当时那个目录恰好是空的」影响，
      // 这里现造一个带子目录的临时目录，再让弹窗去读它。
      const dirProbeRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mya-dirprobe-'));
      fs.mkdirSync(path.join(dirProbeRoot, 'sub-alpha'), { recursive: true });
      fs.mkdirSync(path.join(dirProbeRoot, 'sub-beta'), { recursive: true });
      await win.webContents.executeJavaScript(`(() => {
        const input = document.getElementById('dirInput');
        input.value = ${JSON.stringify(dirProbeRoot)};
        input.dispatchEvent(new Event('change'));
        return true;
      })()`);
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 120));
        // eslint-disable-next-line no-await-in-loop
        dirOpen = await dirProbe();
        if (dirOpen.choices >= 2) break;
      }
      check(dirOpen.choices >= 2, `列出了可选的子目录（${dirOpen.choices} 个）`);
      try {
        fs.rmSync(dirProbeRoot, { recursive: true, force: true });
      } catch {
        /* 临时目录删不掉无所谓 */
      }

      await win.webContents.executeJavaScript(`document.getElementById('btnDirCancel').click()`);
      let dirClosed = dirOpen;
      for (let i = 0; i < 15; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 100));
        // eslint-disable-next-line no-await-in-loop
        dirClosed = await dirProbe();
        if (dirClosed.hidden) break;
      }
      check(dirClosed.hidden, '点「取消」不会新建会话，弹窗收起');
    }

    /* ---- 每一步的 token 行 ---- */
    const stepInfo = await win.webContents.executeJavaScript(`(() => {
      const btn = document.getElementById('btnCompact');
      const injected = typeof renderBlock === 'function';
      let text = '';
      if (injected) {
        window.__stepBackup = state.blocks.get(987654);
        renderBlock({
          seq: 987654, type: 'step', turn: 2,
          usage: { promptTokens: 12000, completionTokens: 340 },
          cumulative: { totalTokens: 12340 }, ms: 2400,
        });
        // 必须精确取「刚注入的这一块」，不能用 querySelector('.block.step')：
        // 后者命中的是页面上第一个 step 块，而用户的真实数据目录里往往
        // 已经存着历史对话的 step 块，断言就会读到别人的数字而误报失败
        // （实测踩过：读出 · ↑2.6k ↓83 · 1.7s，于是「每一步显示 token」假红）。
        const own = state.blocks.get(987654);
        text = own ? own.textContent : '';
      }
      const el = state.blocks.get(987654);
      if (el) { el.remove(); state.blocks.delete(987654); }
      return {
        hasButton: !!btn,
        inMeter: !!(btn && btn.closest('#ctxMeter')),
        text,
      };
    })()`);
    check(stepInfo.hasButton && stepInfo.inMeter, '输入区有「压缩上下文」按钮（手动触发压缩）');
    check(
      /第 2 步/.test(stepInfo.text) && /12\.0k/.test(stepInfo.text) && /12\.3k/.test(stepInfo.text),
      `每一步会显示 token（${stepInfo.text}）`,
    );

    /* ---- 内置插件市场（离线，不碰 GitHub） ---- */
    // 用户要求「内置的插件市场，插件由我们添加」：这台机器连不上
    // api.github.com，所以插件市场必须有一条不依赖网络的路。
    const marketProbe = () =>
      win.webContents.executeJavaScript(`(() => {
        const src = document.getElementById('marketSrc');
        const box = document.getElementById('builtinList');
        if (!src || !box) return { missing: true };
        const active = src.querySelector('.seg-btn.active');
        return {
          activeSource: active ? active.dataset.src : '',
          cards: box.querySelectorAll('.card').length,
          installButtons: box.querySelectorAll('.card-actions .btn').length,
          text: box.textContent.slice(0, 200),
          ghPaneHidden: (document.querySelector('.market-pane[data-pane="github"]') || {}).hidden,
        };
      })()`);

    await openDrawerUi('market');
    await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('#marketSrc .seg-btn[data-src="builtin"]');
      if (b) b.click();
      return true;
    })()`);
    let marketState = await marketProbe();
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 150));
      // eslint-disable-next-line no-await-in-loop
      marketState = await marketProbe();
      if (marketState.cards > 0) break;
    }
    if (marketState.missing) {
      check(false, '插件市场里找不到内置插件页');
    } else {
      check(marketState.activeSource === 'builtin', `插件市场默认停在「内置插件」（当前 ${marketState.activeSource || '无'}）`);
      check(marketState.cards >= 5, `内置插件清单渲染出来了（${marketState.cards} 个卡片）`);
      check(marketState.installButtons >= 5, '每个内置插件都有安装/启停按钮');
      check(marketState.ghPaneHidden !== false, 'GitHub 那一页是收起的（默认不打扰）');
    }
    await closeDrawerUi();

    /* ---- 浮层里的内容 ---- */
    // 色板必须真的渲染出来了。只看背景色不够——色板没渲染出来时
    // 界面依然是白的，看不出问题。它住在浮层的「外观」里，
    // 所以先把浮层打开并切到那一个视图。
    await openDrawerUi('appearance');
    for (let i = 0; i < 15; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 150));
      // eslint-disable-next-line no-await-in-loop
      const h = await win.webContents.executeJavaScript(
        `Math.round((document.getElementById('accentSwatches') || {getBoundingClientRect: () => ({height: 0})}).getBoundingClientRect().height)`,
      );
      if (h > 10) break;
      // 还没量到高度，就再看一眼视图是不是被切走了
      // （比如「没配 Key 时引导去设置」那条路会打开「模型」视图），
      // 切走了就再切回来——否则会拿一个 display:none 的容器量出 0px 高而假红
      // eslint-disable-next-line no-await-in-loop
      await openDrawerUi('appearance');
    }
    const swatchInfo = await win.webContents.executeJavaScript(`(() => {
      const box = document.getElementById('accentSwatches');
      const btns = box ? box.querySelectorAll('.swatch') : [];
      const active = box ? box.querySelector('.swatch.active') : null;
      return {
        count: btns.length,
        activeKey: active ? active.dataset.accent : '',
        firstDotBg: btns[0] ? getComputedStyle(btns[0].querySelector('.swatch-dot')).backgroundImage.slice(0, 40) : '',
        boxHeight: box ? box.getBoundingClientRect().height : 0,
      };
    })()`);
    check(swatchInfo.count >= 6, `主题色色板渲染出来了（${swatchInfo.count} 个颜色）`);
    check(!!swatchInfo.activeKey, `色板标出了当前选中的颜色（${swatchInfo.activeKey}）`);
    check(swatchInfo.boxHeight > 10, `色板有实际高度（${Math.round(swatchInfo.boxHeight)}px）`);

    /* ---- 主题色（强调色） ---- */
    const readAcc = () =>
      win.webContents.executeJavaScript(`(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          acc: cs.getPropertyValue('--acc').trim(),
          fg: cs.getPropertyValue('--acc-fg').trim(),
          attr: document.documentElement.getAttribute('data-accent'),
          theme: document.documentElement.getAttribute('data-theme'),
          saved: (function () { try { return localStorage.getItem('mya.accent') || ''; } catch (e) { return ''; } })(),
        };
      })()`);

    const accBefore = await readAcc();

    // 挑一个和当前不同的颜色来点，这样才真的能验证「点了会变」。
    // （如果固定点蓝色，而用户上一次选的就是蓝色，就什么都验证不出来）
    const pickTarget = accBefore.attr === 'violet' ? 'blue' : 'violet';
    await win.webContents.executeJavaScript(
      `document.querySelector('#accentSwatches .swatch[data-accent="${pickTarget}"]').click()`,
    );
    await new Promise((r) => setTimeout(r, 400));
    const accAfter = await readAcc();

    check(accAfter.attr === pickTarget, `点色板能换主题色（${accBefore.attr} → ${accAfter.attr}）`);
    check(
      accAfter.acc !== accBefore.acc && /^#/.test(accAfter.acc),
      `--acc 变量真的变了（${accBefore.acc} → ${accAfter.acc}）`,
    );
    check(!!accAfter.fg, `--acc-fg 也跟着更新（${accAfter.fg}）`);

    // 切主题后颜色要重算——同一个色号在浅色/深色下取值不同，
    // 不然深色界面里会留一个「白底专用」的颜色，糊成一片。
    // 主题选择现在在设置浮层的「外观」里（浮层此时正开着）。
    const accLight = accAfter.acc;
    await win.webContents.executeJavaScript(
      `document.querySelector('.seg-btn[data-theme-opt="dark"]').click()`,
    );
    await new Promise((r) => setTimeout(r, 500));
    const accDark = await readAcc();
    check(accDark.attr === pickTarget, '切主题后主题色选择被保留');
    check(
      accDark.acc !== accLight,
      `深色下用的是同色系的另一档取值（${accLight} → ${accDark.acc}）`,
    );

    // 把主题和主题色都恢复到自检前的状态。
    // 自检不该动用户的配置——否则跑一次自检，用户会发现界面颜色被改了。
    await win.webContents.executeJavaScript(`(() => {
      var before = ${JSON.stringify({ theme: accBefore.theme || 'light', accent: accBefore.attr || 'teal' })};
      var root = document.documentElement;
      root.setAttribute('data-theme', before.theme);
      try { localStorage.setItem('mya.theme', before.theme); } catch (e) {}
      if (typeof applyAccent === 'function') applyAccent(before.accent);
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 400));
    const accRestored = await readAcc();
    check(
      accRestored.attr === accBefore.attr,
      `自检结束后主题色已还原（${accAfter.attr} → ${accRestored.attr}）`,
    );

    // 浅色截图要在浮层关掉之后拍：这是用户平时看到的界面
    await closeDrawerUi();
    const lightShot = await saveShot('selftest-light.png');
    if (lightShot) console.log(`    浅色截图：${lightShot}`);

    // 切到深色验一次。主题选择现在在设置浮层的「外观」里，所以先把它打开。
    // 这里不能只等一个固定时间就截图——截图和 CSS 重绘之间存在时序竞争，
    // 偶尔会截到还没重绘完的旧画面（表现为「深色下亮色像素 97%」这种假失败）。
    // 所以改成轮询：最多等 3 秒，只要画面真的变暗了就继续。
    await openDrawerUi('appearance');
    await win.webContents.executeJavaScript(
      `document.querySelector('.seg-btn[data-theme-opt="dark"]').click()`,
    );
    let themeDark = null;
    for (let i = 0; i < 15; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 200));
      // eslint-disable-next-line no-await-in-loop
      themeDark = await themeProbe();
      if (themeDark.theme === 'dark' && themeDark.brightRatio < 0.35) break;
    }
    check(themeDark.theme === 'dark', `主题能切到深色（data-theme=${themeDark.theme}）`);
    check(
      themeDark.brightRatio < 0.35,
      `深色下界面确实变暗（亮色像素占 ${(themeDark.brightRatio * 100).toFixed(0)}%）`,
    );
    if (themeDark.theme !== 'dark' || themeDark.brightRatio >= 0.35) {
      const why = await win.webContents.executeJavaScript(`(() => {
        const cs = getComputedStyle(document.documentElement);
        return {
          theme: document.documentElement.getAttribute('data-theme'),
          attr: document.documentElement.getAttribute('data-accent'),
          acc: cs.getPropertyValue('--acc').trim(),
          bg: cs.getPropertyValue('--bg').trim(),
          bodyBg: getComputedStyle(document.body).backgroundColor,
          savedTheme: (function(){ try { return localStorage.getItem('mya.theme'); } catch(e){ return 'ERR'; } })(),
        };
      })()`);
      console.log(`    诊断：${JSON.stringify(why)}`);
    }
    const darkShot = await saveShot('selftest-dark.png');
    if (darkShot) console.log(`    深色截图：${darkShot}`);

    // 切回浅色。顺序很重要：先在浮层里点「浅色」，再关掉浮层——
    // 关了浮层就点不到它了。关掉之后再量亮度，否则遮罩会把画面压暗。
    await openDrawerUi('appearance');
    await win.webContents.executeJavaScript(
      `document.querySelector('.seg-btn[data-theme-opt="light"]').click()`,
    );
    await closeDrawerUi();
    let backLight = null;
    for (let i = 0; i < 15; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 200));
      // eslint-disable-next-line no-await-in-loop
      backLight = await themeProbe();
      if (backLight.theme === 'light' && backLight.brightRatio > 0.6) break;
    }
    check(backLight.theme === 'light', '能切回浅色（外观里选浅色）');

    // 再验证一次本地接口——界面能连上服务才算真的可用
    const apiOk = await win.webContents.executeJavaScript(
      `fetch('/api/info').then(r => r.ok).catch(() => false)`,
    );
    check(apiOk === true, '界面能访问本地接口（/api/info）');
    // 模型名现在住在「输入区左下角的模型按钮」+ state.info 里（顶栏的显示已去掉）
    check(!!probe.modelText && probe.modelText !== '—', `当前模型：${probe.modelText}`);

    /* ---- 侧栏的新结构（类 Codex：工作区 / 会话 / 插件） ----
       顶栏的模型显示去掉了，模型只剩输入区一处；
       侧栏从「只剩会话」变成三分区。这四条都用**此刻**的页面快照：
       前面那份 probe 是启动早期拍的，侧栏数据在它之后才到——
       用旧快照量新结构，就会出现「0 个插件」这种鬼影（踩过一次）。
       轮询等它到位（最多 6 秒），还不到位才报红。 */
    const sideProbeOnce = () =>
      win.webContents.executeJavaScript(`(async () => {
        const apiPick = await fetch('/api/plugins')
          .then((r) => r.json().then((j) => ({ status: r.status, plugins: j && j.plugins ? j.plugins.length : -1, error: j && j.error })))
          .catch(() => ({ status: -1, plugins: 'fetch失败', error: '' }));
        return {
          topbarHasModelChip: !!document.getElementById('modelChip'),
          sideSections: [...document.querySelectorAll('.side-section')].map((s) => s.id),
          workspaceRows: document.querySelectorAll('#wsList .ws-item').length,
          sessionRows: document.querySelectorAll('#wsList .ws-session').length,
          // 只数「装了的插件」那一行：还没装时的占位按钮不算（它永远存在，
          // 会把「插件列表加载好了吗」这件事说成谎）
          pluginRows: document.querySelectorAll('#sidebarPlugins .plugin-row[data-plugin]').length,
          sidebarHtml: (document.getElementById('sidebarPlugins') || {}).innerHTML || '',
          apiPick,
        };
      })()`);
    let side = await sideProbeOnce();
    for (let i = 0; i < 20 && (side.workspaceRows === 0 || side.pluginRows === 0); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 300));
      // eslint-disable-next-line no-await-in-loop
      side = await sideProbeOnce();
    }
    check(side.topbarHasModelChip === false, '顶栏不再显示模型（重复入口已去掉）');
    check(
      side.sideSections.includes('wsSection') && side.sideSections.includes('pluginSection'),
      `侧栏分成 工作区/插件 两段（实际：${side.sideSections.join(' / ')}）`,
    );
    check(
      side.sideSections.includes('sessionSection') === false,
      '会话不再单独占一段（已经并进工作区树，同一个东西不重复出现）',
    );
    check(side.workspaceRows > 0, `工作区树渲染出来了（${side.workspaceRows} 个工作区）`);
    // 侧栏的契约是「如实反映服务端实际装了什么」：
    // 沙箱工作区里 plugins/ 是空的时，0 行 + 占位才是对的。
    // 所以这里对账「侧栏行数 == /api/plugins 说的数量」（而不是写死一个数字），
    // 两种环境都能成立：装了插件的真环境要都列出来，空环境要有占位不能空白。
    check(
      side.pluginRows === side.apiPick.plugins || side.pluginPlaceholder,
      `侧栏插件清单与接口一致（侧栏 ${side.pluginRows} 行 / 接口 ${side.apiPick.plugins} 个）`,
    );

    const summary = `\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`;
    lines.push(summary.trim());
    console.log(summary);
  } catch (err) {
    failures += 1;
    const msg = `✗ 自检过程出错：${err.message}`;
    lines.push(msg);
    console.error(msg);
  } finally {
    clearTimeout(watchdog);
    flush();
    const code = failures === 0 ? 0 : 1;
    if (app) app.exit(code);
    // 兜底：app.exit() 偶尔退不干净（GPU/网络子进程还在，主进程跟着挂着）。
    // 实测过后果——自检跑完程序不退出，它占着 dist 里的 exe，
    // 下一次打包就会无限等「output file is locked」。
    // 所以这里给它 1.5 秒，还不走就硬退。
    setTimeout(() => process.exit(code), 1500).unref?.();
  }
}

/* ------------------------------------------------------------------ */
/* 应用菜单（中文）                                                    */
/* ------------------------------------------------------------------ */

function buildMenu() {
  if (!Menu) return;

  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  };

  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建会话',
          accelerator: 'CmdOrCtrl+N',
          click: () => send('menu', { action: 'new-session' }),
        },
        { type: 'separator' },
        {
          label: '打开工作目录',
          click: () => {
            if (serverHandle) shell.openPath(serverHandle.app.cfg.cwd);
          },
        },
        {
          label: '打开数据目录（会话记录）',
          click: () => {
            if (serverHandle) shell.openPath(serverHandle.app.cfg.dataDir);
          },
        },
        {
          label: '打开插件目录',
          click: () => {
            if (serverHandle) {
              const dir = serverHandle.app.cfg.pluginDirs[0];
              if (dir && fs.existsSync(dir)) shell.openPath(dir);
              else dialog.showMessageBox({ message: '插件目录还不存在', detail: dir || '(未配置)' });
            }
          },
        },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        {
          label: '刷新界面',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow && mainWindow.reload(),
        },
        { type: 'separator' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '恢复默认大小', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
        {
          label: '开发者工具',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => mainWindow && mainWindow.webContents.toggleDevTools(),
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '项目主页 / 文档',
          click: () => {
            const readme = path.join(ROOT, 'README.md');
            if (fs.existsSync(readme)) shell.showItemInFolder(readme);
            else dialog.showMessageBox({ message: 'README.md 不存在' });
          },
        },
        {
          label: '显示服务地址',
          click: () => {
            dialog.showMessageBox({
              type: 'info',
              title: '服务地址',
              message: serverHandle ? serverHandle.server.url : '(服务未启动)',
              detail:
                '这个地址也可以在浏览器里打开，效果一样。\n服务只监听本机，局域网内其他机器访问不到。',
            });
          },
        },
        {
          label: '关于',
          click: () => {
            const version = serverHandle ? serverHandle.app.version : '?';
            dialog.showMessageBox({
              type: 'info',
              title: '关于梦云 Agent',
              message: `梦云 Agent v${version}`,
              detail: [
                `Electron ${process.versions.electron}`,
                `Chromium ${process.versions.chrome}`,
                `Node ${process.versions.node}`,
                '',
                `工作目录：${serverHandle ? serverHandle.app.cfg.cwd : '?'}`,
                `模型：${serverHandle ? `${serverHandle.app.cfg.provider}/${serverHandle.app.cfg.model}` : '?'}`,
              ].join('\n'),
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

/**
 * 决定配置目录，并在需要时铺好模板。
 *
 * 打包之后程序目录是 `resources/app.asar`——一个**只读的虚拟路径**，
 * 往里写 config.json 会报：
 *   ENOENT: no such file or directory, open '...\app.asar\config.json'
 * 而且免安装版每次启动都解压到新的临时目录，写进去也留不住。
 *
 * 所以桌面版把配置放到用户数据目录（%APPDATA%\梦云Agent），
 * 首次启动时从程序自带的模板复制一份 config.json / .env 过去，
 * 用户就能在同目录里改，改完重启生效。
 *
 * 优先级：环境变量 MYA_CONFIG_DIR 最优先。
 * 这条不能省——以前这里无条件把 userData 写回环境变量，等于把用户（和测试）
 * 显式指定的目录悄悄吃掉：测试以为配置落在沙箱里，其实写进了真实数据目录，
 * 隔离形同虚设（踩过：打包版自检的报告与配置都跑到了用户目录里）。
 *
 * @returns {string} 配置目录
 */
function setupConfigDir() {
  const explicit = process.env.MYA_CONFIG_DIR;
  const dir = explicit
    ? path.resolve(explicit)
    : app && app.getPath
      ? app.getPath('userData')
      : path.join(ROOT, '.mya');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    logToFile(`配置目录创建失败：${err.message}`);
    return dir;
  }

  // 铺模板：只在缺失时复制，绝不覆盖用户已经改过的文件。
  // 优先用 config.json（作者本机的配置：通常已经配好了网关和模型，新用户开箱能用）；
  // 没有它（比如别人 clone 下来的仓库，config.json 被 .gitignore 忽略了）就用
  // config.example.json 顶上——里面的敏感字段是空的，第一次启动会引导去设置里填。
  const bundledConfig = path.join(ROOT, 'config.json');
  const bundledExample = path.join(ROOT, 'config.example.json');
  const templateConfig = fs.existsSync(bundledConfig)
    ? bundledConfig
    : fs.existsSync(bundledExample)
      ? bundledExample
      : null;
  const targetConfig = path.join(dir, 'config.json');
  try {
    if (!fs.existsSync(targetConfig) && templateConfig) {
      fs.copyFileSync(templateConfig, targetConfig);
      logToFile(`已生成默认配置：${targetConfig}（来自 ${path.basename(templateConfig)}）`);
    }
  } catch (err) {
    logToFile(`复制 config.json 失败：${err.message}`);
  }

  // .env 从 .env.example 铺（不能复制用户程序目录里的 .env，那可能带着别人的 key）
  const bundledEnv = path.join(ROOT, '.env.example');
  const targetEnv = path.join(dir, '.env');
  try {
    if (!fs.existsSync(targetEnv) && fs.existsSync(bundledEnv)) {
      fs.copyFileSync(bundledEnv, targetEnv);
      logToFile(`已生成环境变量模板：${targetEnv}`);
    }
  } catch (err) {
    logToFile(`复制 .env.example 失败：${err.message}`);
  }

  // 告诉 config.js 用哪个目录
  process.env.MYA_CONFIG_DIR = dir;
  logToFile(`配置目录：${dir}`);
  return dir;
}

// 单实例：已经开着一个就别再开第二个（否则两个进程抢同一个端口）
if (app) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });

    app.whenReady().then(async () => {
      // 必须赶在 bootServer（也就是 loadConfig）之前
      setupConfigDir();
      try {
        serverHandle = await bootServer();
      } catch (err) {
        showFatal('启动失败', err && err.message ? err.message : String(err));
        app.quit();
        return;
      }

      buildMenu();
      registerIpc();
      createWindow(serverHandle.server.url);

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow(serverHandle.server.url);
      });
    });

    // 关掉窗口就退出（这不是 macOS 那种常驻型应用）
    app.on('window-all-closed', () => {
      app.quit();
    });

    app.on('before-quit', () => {
      if (serverHandle && serverHandle.server) {
        try {
          serverHandle.server.close();
        } catch {
          /* 忽略 */
        }
      }
    });
  }
}

module.exports = { bootServer, ROOT };
