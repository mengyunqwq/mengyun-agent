# 常见问题


<details>
<summary><b>插件市场搜不到东西 / 报「连不上 api.github.com」</b></summary>

先看报错里的**原因码**——程序会把 Node 藏在 `err.cause` 里的真实原因翻出来（默认只有一句 `fetch failed`，看不出任何东西）：

- `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN`：**本机有中间人证书**（公司代理、杀软、加速器）。典型症状是**浏览器能打开 GitHub、程序连不上**，因为浏览器走系统证书库、Node 走自己那份。两个办法：把根证书导出后设 `NODE_EXTRA_CA_CERTS=证书路径`；或者临时 `MYA_INSECURE_TLS=1` 跳过证书校验。
- `ETIMEDOUT`：设 `MYA_PROXY=http://127.0.0.1:端口` 走代理。
- 搜索走 `api.github.com`、下载走 `codeload.github.com`，两者**可能一个通一个不通**（实测遇到过）。

另外 `topic:mya-plugin` 目前是 0 个仓库——没有现成插件可搜，属于正常现象，不是你的网络问题。

**但这件事不该让你去折腾网络**：插件市场默认停在「内置插件」页，那 5 个插件点一下就装好，完全不需要联网；「本地安装」页还能装你手动下载的 zip 或文件夹。GitHub 那一页连不上，只影响「搜网上的插件」这一种用法。

</details>

<details>
<summary><b>关掉程序再打开，之前的对话不见了</b></summary>

先确认版本：早期版本**会话列表只显示内存里的**，重启后列表是空的，于是看起来像「对话丢了」——其实文件一直在磁盘上（数据目录的 `.mya/sessions/`）。

现在的行为：`GET /api/sessions` 会把**磁盘上的历史会话一起列出来**，重启后接着点就能继续聊；删除也会连文件一起删掉。

如果你确实还想找文件，看设置「关于」里的**数据目录**，会话就是里面的 `.mya/sessions/*.json`。

</details>

<details>
<summary><b>双击之后什么都没发生 / 窗口没出来</b></summary>

1. 先跑自检，它会直接指出是哪一环出问题：
   ```powershell
   mya desktop --selftest
   ```
2. 看看任务栏——窗口可能开在别的显示器上，或者被其它窗口挡住了
3. 检查有没有装桌面组件：`npm install`（不装的话会自动退回浏览器界面）
4. 加了 `MYA_DEBUG=1` 再启动可以看到详细日志；启动过程也会写到 `main.log`（在 userData 目录里）

</details>

<details>
<summary><b>窗口白屏 / 界面卡在加载中</b></summary>

1. 先跑 `mya desktop --selftest`，看哪一项是 ✗
2. 按 `Ctrl+R` 刷新界面
3. 看黑窗口里有没有报错，正常应该显示 `✓ 界面已启动：http://127.0.0.1:端口`
4. 端口被占用时会自动往后找，注意看**实际地址**
5. 还是不行就跑 `mya doctor`

</details>

<details>
<summary><b>报 401 / 鉴权失败</b></summary>

`config.json` 的 `apiKey` 或 `.env` 的 `MYA_API_KEY` 没填对。注意 `.env` 优先级高于 `config.json`，两边都写了以 `.env` 为准。界面「设置」里填的会写进 `config.json`。
</details>

<details>
<summary><b>报 404</b></summary>

`baseUrl` 写错了。正确形式是 `https://api.deepseek.com/v1`，**不要**带 `/chat/completions`（代码会自动补上）。
</details>

<details>
<summary><b>报 400，模型不支持 tools</b></summary>

你选的模型不支持函数调用。换个模型，比如 `deepseek-chat`、`gpt-4o-mini`、`qwen2.5-coder`。
</details>

<details>
<summary><b>回复是空的 / 卡住不动</b></summary>

在 `.env` 里加 `MYA_STREAM=0` 关掉流式，有些网关的 SSE 实现不规范。改完重启。
</details>

<details>
<summary><b>agent 一直在调工具停不下来</b></summary>

降低设置里的「最大工具调用轮数」（默认 25 已经算宽松）。另外看看是不是某个工具一直失败、模型在反复重试——`audit` 插件能给你答案：终端模式输入 `/audit_stats` 看哪个工具失败率最高。
</details>

<details>
<summary><b>市场搜不到东西 / 提示限流</b></summary>

GitHub 匿名配额有限（搜索 10 次/分钟）。两个办法：
1. 填个 GitHub Token（设置里）
2. 别用泛词搜，直接粘仓库地址，或者搜 `topic:mya-plugin`
</details>

<details>
<summary><b>搜到了仓库，但提示「没找到插件结构」</b></summary>

那个仓库确实不是插件。识别标准是：目录里有 `manifest.json`，或者根目录的 `index.js` 里用了插件 API（`ctx.registerTool` 之类）。如果作者把插件放在子目录里，通常也能自动识别。
</details>

<details>
<summary><b>插件装了但没生效</b></summary>

按顺序查：
1. 「设置 → 插件管理」里它是不是「已禁用」？装完默认是禁用的，点启用
2. 设置（插件管理）里的工具清单有没有它注册的工具？没有的话看插件卡片上有没有红色错误
3. 启用/重载之后，**已经在跑的会话需要新开一个**才会拿到新的工具列表
4. `MYA_DEBUG=1` 启动看完整堆栈；`MYA_DEBUG_DISCOVER=1` 看插件扫描过程

最常见的原因是插件里 `module.exports` 拼错了，或者工具名和内置工具重名被拒绝注册。
</details>

<details>
<summary><b>PowerShell 说「禁止运行脚本」</b></summary>

Windows 默认执行策略限制。直接用 `start.cmd`，或者：
```powershell
powershell -ExecutionPolicy Bypass -File .\start.ps1
```
</details>

<details>
<summary><b>想让它自动执行所有工具，不要每次都问</b></summary>

设置里把工具加到「免确认放行的工具」，或者临时用 `mya --yes`。
**去做这个之前，请先确认你在沙箱/虚拟机里，或者工作目录有 git 且已提交。**
</details>

<details>
<summary><b>关掉窗口后 agent 还在跑吗</b></summary>

不在。关掉窗口就是退出程序，本地服务也一起停。

会话记录已经存到 `.mya/sessions/`，下次打开窗口，之前的对话还在左栏列表里。

> 如果用的是命令行版本（`mya web`），那个终端窗口就是服务进程，关掉即停止。
</details>

<details>
<summary><b>想换个工作目录（让它操作别的项目）</b></summary>

程序的工作目录 = **你启动它时所在的目录**。所以有三种办法：

1. 把程序（或 `start.cmd`）放进目标项目文件夹里双击
2. 在命令行里指定：
   ```powershell
   mya desktop --cwd "D:\我的项目"
   ```
3. 看菜单「文件 → 打开工作目录」，确认它现在指的是哪里

> 有个兜底：如果启动时所在目录不可写（比如从开始菜单启动，工作目录变成了
> `C:\Windows\System32`），程序会自动退到「文档/梦云Agent」，不会因为写不了会话文件而起不来。
</details>

---

---

## 接下来可以怎么改


这份模板是**故意做得薄**的——每个文件都短、职责单一，就是为了方便你一步步改。按「改动量从小到大」排：

### 第 1 档：改文字和外观（不用碰代码）

- **`prompts/system.zh.md`** —— agent 的人格。想让它说话更简短、先写测试、遵守你团队的规范，都改这里
- **界面「设置 → 外观」** —— 主题、主题色
- **`web/app.css`** —— 想大改配色就动文件开头的两个 `:root` 块（浅色一份、深色一份）

### 第 2 档：加工具（写插件就行）

在「设置 → 插件管理」里生成骨架，或从市场装一个。想清楚「这个能力要不要暴露给模型」：

- 要暴露 → `ctx.registerTool()`
- 不希望模型自己决定（发版、删数据库）→ `ctx.registerCommand()` 注册成命令

### 第 3 档：改界面

| 想做的事 | 改哪里 |
|---|---|
| 加一个设置视图 | `web/index.html` 加一个 `drawer-tab` + 对应的 `drawer-view`，`web/app.js` 的 `DRAWER_VIEWS` 和 `switchDrawerView` 加分支 |
| 加一个设置分区 | `web/index.html` 加 `section-xxx`，`app.js` 的 `loadSettings` 加填充逻辑 |
| 改消息渲染样式 | `web/app.css`，或 `app.js` 里的 `renderBlock` |
| 换 Markdown 渲染 | `web/app.js` 的 `renderMarkdown`（现在是手写的轻量版） |
| 加可选主题色 | `web/app.js` 的 `ACCENTS` 加一行 + `index.html` 内联脚本同步加一行 |
| 加界面上的新功能 | `server.js` 加 REST 接口 + `app.js` 加调用 |

### 第 4 档：改后端

| 想做的事 | 改哪个文件 |
|---|---|
| 加一种模型协议（第四种、第五种……） | `src/providers/` 加一个类（继承 `BaseProvider`），`src/provider.js` 的 `API_FORMATS` + `createProvider` 各加一行 |
| 改主循环策略（先规划再执行、自我反思） | `src/agent.js` 的 `run()` |
| 改工具确认策略 | `src/tools.js` 的 `needsConfirmation()` |
| 加新工具（内置级别） | `src/tools/builtin.js`；联网类的看 `src/tools/web.js` |
| 换搜索后端 / 加一个搜索引擎 | `src/tools/web.js` 里加一个 `searchXxx`，再在 `webSearchTool.run()` 的分发处加一支 |
| 改流式推送的合帧节奏 | `src/web/server.js` 的 `COALESCE_MS` / `makeCoalescer` |
| 改前端渲染节流与长文本降级阈值 | `web/app.js` 的 `makePainter` / `STREAM_PLAIN_LIMIT` / `RENDER_MD_LIMIT` |
| 改命令的超时与输出上限 | `src/tools/builtin.js` 的 `MAX_OUTPUT_BYTES` / `runCommand()` |
| 改插件发现规则 / 加插件源 | `src/plugins.js` 的 `discover()` |
| 换插件市场（GitLab / Gitee / 私有源） | `src/web/plugin-market.js`，实现同样的 search/inspect/install 方法 |
| 改会话上下文管理（自动摘要、向量检索） | `src/session.js` 的 `toMessages()` |
| 多会话调度策略 | `src/web/session-manager.js` |

### 第 5 档：几个现成的扩展方向

**① 做成真正的桌面程序（更进一步）**
现在已经是原生窗口了。想完全脱离本地端口，可以把服务改成 IPC 通信；想加托盘图标、开机自启、自动更新，都在 `desktop/main.js` 里加。

**② 加长期记忆**
写个插件，在 `session:end` 时把会话摘要存进 JSON 或 SQLite，在 `messages:before` 时检索相关记忆注入。**完全不用改核心代码。**

**③ 加成本控制**
`session.usage` 已经在累计 token 了。写个插件在 `session:end` 里按单价算钱写日志；或在 `turn:start` 里检查累计量，超阈值就返回 `false` 中断。

**④ 多 agent 协作**
`registry` 和 `agent` 都是普通对象，可以创建多个 `ChatAgent` 实例互相调用——把「另一个 agent」包装成一个工具就行。

**⑤ 定时任务 / 后台值守**
现在的会话是「你说一句它干一件」。想做成「文件变化就自动跑」，用 `chokidar` 之类的库监听，然后调 `sessionManager.send()` 即可。

**⑥ 把 agent 当库用（写自己的入口）**

```js
const { createApp } = require('./src');
const app = await createApp({ cwd: process.cwd() });
const session = app.agent.createSession();
const result = await app.agent.run(session, '任务', { verbose: false });
console.log(result.text);
```

---

---

> 回到 [README](../README.md) 看快速上手。
