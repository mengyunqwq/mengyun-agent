'use strict';

/**
 * 梦云 Agent —— 桌面程序的 preload 脚本
 *
 * 它在「网页」和「Electron 主进程」之间架一座很窄的桥。
 * 安全原则：只暴露明确列出的几个能力，绝不放开通用的 ipcRenderer
 * （那等于把整个 Node 环境交给页面，一个 XSS 就能执行任意命令）。
 *
 * 页面通过 window.myaDesktop 判断自己是不是跑在桌面程序里：
 *   如果是，可以隐藏「用浏览器打开」之类的提示；
 *   如果不是（浏览器访问），它会是 undefined，前端要有兜底。
 */

const { contextBridge, ipcRenderer } = require('electron');

try {
  contextBridge.exposeInMainWorld('myaDesktop', {
    /** 标记：跑在桌面程序里 */
    isDesktop: true,
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },

    /** 主进程菜单发来的动作（如「新建会话」） */
    onMenu(callback) {
      if (typeof callback !== 'function') return () => {};
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('menu', handler);
      return () => ipcRenderer.removeListener('menu', handler);
    },

    /** 用系统默认程序打开一个本地目录（比如插件目录） */
    openPath(target) {
      return ipcRenderer.invoke('open-path', String(target || ''));
    },

    /**
     * 弹原生目录选择框，返回用户选的目录。
     *
     * 为什么不自己写目录浏览器：桌面程序里用户要的可能在任何盘符、
     * 任何网络位置上，原生对话框能直接翻；浏览器模式下没有这个能力，
     * 界面会退回「手打路径 + 逐层点子目录」。
     *
     * @param {string} [defaultPath] 打开时的起始目录
     * @returns {Promise<{ok:boolean, path?:string, canceled?:boolean, error?:string}>}
     */
    chooseDirectory(defaultPath) {
      return ipcRenderer.invoke('choose-directory', String(defaultPath || ''));
    },

    /**
     * 弹原生文件选择框，用来挑插件压缩包（.zip / .tar.gz）。
     * 和 chooseDirectory 一样，只把「用户选了什么」带回来，
     * 主进程不替页面读写任何东西。
     */
    chooseArchive(defaultPath) {
      return ipcRenderer.invoke('choose-archive', String(defaultPath || ''));
    },

    /**
     * 选一个附件（聊天输入区那个 + 号）：文件 / 文件夹 / 压缩包。
     *
     * 和上面两个一样，只把「用户选了什么」带回来——主进程不读内容、不解压，
     * 也不把文件搬到别处（路径交给 agent 的工具去读，权限仍在工具闸门那儿）。
     *
     * @param {'file'|'directory'|'archive'} kind
     * @param {string} [defaultPath] 起始目录
     * @returns {Promise<{ok:boolean, path?:string, canceled?:boolean, error?:string}>}
     */
    chooseAttachment(kind, defaultPath) {
      return ipcRenderer.invoke('choose-attachment', String(kind || 'file'), String(defaultPath || ''));
    },

    /**
     * 同步主题给主进程。
     * 用途：无边框窗口的标题栏和阴影也受系统主题影响，
     * 页面切成深色时告诉主进程一声，窗口边框才不会还是浅色的。
     */
    setTheme(theme) {
      return ipcRenderer.invoke('set-theme', theme === 'dark' ? 'dark' : 'light');
    },

    /**
     * 窗口控制。无边框窗口下系统不画标题栏，最小化/最大化/关闭得自己接。
     * 只开放这三个动作，不做成通用的「发任意 ipc」。
     */
    window: {
      minimize: () => ipcRenderer.invoke('win', 'minimize'),
      toggleMaximize: () => ipcRenderer.invoke('win', 'toggle-maximize'),
      close: () => ipcRenderer.invoke('win', 'close'),
      /** 订阅最大化状态变化，用来切换按钮图标 */
      onMaximizeChange(callback) {
        if (typeof callback !== 'function') return () => {};
        const handler = (_event, isMax) => callback(!!isMax);
        ipcRenderer.on('window-maximized', handler);
        return () => ipcRenderer.removeListener('window-maximized', handler);
      },
    },
  });
} catch {
  // 极少数情况下 contextBridge 不可用（比如被杀软拦了）。
  // 这里不能抛错，否则整个页面加载失败——桌面功能降级，网页照常用。
  // eslint-disable-next-line no-console
  console.warn('[preload] contextBridge 不可用，桌面增强功能已禁用');
}
