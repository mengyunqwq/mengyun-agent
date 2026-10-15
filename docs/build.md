# 打包分发给别人


想让别人拿到就能用（对方不用装 Node），打成免安装 exe：

```powershell
npm install --save-dev electron-builder
npm run dist
```

产物在 `dist/梦云Agent-0.1.0-免安装.exe`，**约 95MB**，发过去双击就跑。

> 第一次打包会下载一些打包工具，国内建议先设镜像（`desktop/build.js` 里已经帮你设好了，失败时会打印提示）：
> ```powershell
> $env:ELECTRON_BUILDER_BINARIES_MIRROR="https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
> ```

几个提醒：

- **不要把自己的 `.env` 打进去**（已在 `.gitignore` 和 `files` 里排除）。收到程序的人需要自己填 API Key。
- 打包后的程序，工作目录默认是**启动它时所在的目录**。所以把它放进某个项目文件夹里双击，agent 就会操作那个项目。
- 想做成安装程序（有开始菜单快捷方式）就把 `build.win.target` 从 `portable` 改成 `nsis`。

---

---

> 回到 [README](../README.md) 看快速上手。
