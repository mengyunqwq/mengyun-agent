# 插件市场：三种来源


设置浮层里点「插件市场」，顶部有三个页签，**按"需不需要网络"从低到高排**：

| 页签 | 需要网络？ | 用途 |
|---|---|---|
| **内置插件** | ❌ 不需要 | 随程序发布的插件，点一下从自带目录复制到你的工作目录 |
| **本地安装** | ❌ 不需要 | 装一个文件夹 / `.zip` / `.tar.gz`——浏览器手动下好的包、同事拷给你的目录 |
| **GitHub** | ✅ 需要 | 搜索或粘仓库地址安装 |

默认停在**内置插件**：国内网络经常连不上 `api.github.com`，一进来就撞一堵报错墙不合适。

### 内置插件（离线货架）

自带 5 个插件，装上就能用：

| 插件 | 干什么 |
|---|---|
| **上下文压缩** | 把较早的对话总结成摘要，腾出上下文（默认用量超 62% 自动压，也可手动 /compact） |
| **联网搜索** | 注册 `tavily_search` 工具（需要 Tavily Key）。想联网**不用装它**——内置的 `web_search` 免密钥就能用；这个插件的价值是当「怎么读 API Key 接第三方服务」的抄写模板 |
| **文件增强** | 列目录树、统计、批量替换、算哈希 |
| **操作审计** | 记录每次工具调用，拦截明显危险的命令 |
| **示例插件** | 最小可运行示例，自己写插件就从它开始抄 |

**加一个新插件 = 两步**（这就是"插件由我们添加"）：

1. 把插件目录放进 `plugins/`（最小形态是一个 `index.js`，里面 `module.exports = { name, setup(ctx) {...} }`）
2. 在 `catalog/plugins.json` 里加一条（名字、说明、标签）

界面读的是这两处的并集：**清单里写了但目录不存在**会被跳过，**目录里有但清单没写**也会列出来并标注「未在清单里登记」——所以忘写清单不会导致插件"消失"。

装的动作是把插件**复制**到当前工作目录的 `plugins/` 下（只复制，不覆盖：重名会变成 `hello-2`）。为什么是复制而不是直接用自带的：插件跟着工作目录走，在 A 项目装的插件不该跑到 B 项目生效。

### 本地安装（离线）

「本地安装」页填一个路径，或者点 **「选文件夹…」/「选压缩包…」**（桌面程序里是系统对话框）：

- 认三种：**文件夹**、**`.zip`**、**`.tar.gz` / `.tgz`**
- 有「先检查」按钮：装之前先看一眼这目录像不像插件、入口文件是哪个
- zip 是**零依赖自己解的**（只用 `zlib`），所以你从 GitHub 网页上「Download ZIP」下的包能直接装
- 装完默认**禁用**，勾了「装完立即启用」才启用

这条路完全不经过网络——**GitHub 连不上时，它是装第三方插件的唯一入口**。

### 先说清楚：能装什么，装完能不能用

**机制上完全能装**：搜索 / 粘地址 → 预览文件清单和危险代码 → 从 GitHub 下载整包 → 解压落盘到当前工作目录的 `plugins/` → **默认禁用** → 你点「启用」后热加载，不用重启。

**但"能不能用"取决于那个插件是不是按本项目的接口写的**：

| 你想装的 | 结果 |
|---|---|
| 按本项目的插件接口写的仓库 | ✅ 装完启用就能用（新工具出现在工具清单里，模型能调） |
| Claude Code / Cursor / VS Code 插件 | ❌ 接口不同，装进来也加载不了 |
| MCP 服务器 | ❌ 协议不同（那是「工具服务」，不是本项目插件） |
| Chrome/Edge 浏览器扩展 | ❌ 它的 `manifest.json` 和本项目的同名但含义不同，安装时会被直接拦下 |
| 随便一个 Node 项目（如 express） | ❌ 安装前就会被拒绝，并告诉你插件的接口长什么样 |

> **现状（实测）**：GitHub 上 `topic:mya-plugin` 目前是 **0 个仓库**——也就是说，还没有别人发布的、现成能用的插件。所以今天"从 GitHub 装插件"这条路的真实用法是：**你自己写一个插件、推到 GitHub（打上 `mya-plugin` 话题），然后在别的机器上装**。

插件的最小形态（也是安装被拒时提示里给的样子）：

```js
module.exports = {
  name: '我的插件',
  setup(ctx) {
    ctx.registerTool({ name: 'hello', description: '打招呼', parameters: { type: 'object', properties: {} }, run: async () => '你好' });
  },
};
```

安装接口会自己校验这一点：没有 `manifest.json`、入口文件里也没有 `setup(ctx)` / `registerTool` 这类特征，就直接拒绝并把上面这段贴给你——**不让你装一个"启用了却毫无反应"的东西进来**。

### 怎么找插件（GitHub 页签）

界面上预置了几个快捷搜索：

- `mya-plugin` —— 给这个 agent 写的插件会打这个话题
- `mengyun` —— 名字/描述里带相关词的
- `agent plugin` —— 更宽泛的搜索

也可以直接粘 `https://github.com/某人/某仓库`，它会跳过搜索直接读那个仓库。

### 连不上 GitHub？先看是哪一种

搜索和预览走 `api.github.com`，下载走 `codeload.github.com`。这两个域名的连通性可能不一样——**实测过一台机器就是「codeload 通、api 不通」**。

如果报「连不上 api.github.com」，先看提示里的原因（它会把真实错误码翻出来）：

| 原因码 | 真实含义 | 怎么办 |
|---|---|---|
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE`、`SELF_SIGNED_CERT_IN_CHAIN` | **本机有中间人证书**（公司代理、杀软、某些加速器）。浏览器能打开 GitHub 不代表程序能连——浏览器走系统证书库，Node 走自己那份 | ① 导出那个根证书，设 `NODE_EXTRA_CA_CERTS=证书路径`（推荐）；② 或临时 `MYA_INSECURE_TLS=1` |
| `ENOTFOUND` / `EAI_AGAIN` | 域名解析失败 | 查 DNS；这台机器可能压根连不上外网 |
| `ETIMEDOUT` / `UND_ERR_CONNECT_TIMEOUT` | 连不上、被墙 | 设 `MYA_PROXY=http://127.0.0.1:端口`（程序会替你把 Node 的代理开关打开） |
| `ECONNREFUSED` | 代理没开或端口不对 | 确认代理软件的端口 |

`MYA_INSECURE_TLS=1` 的含义是**不校验证书**：它只解决「证书不被信任」，流量该被中间人看还是被看。程序启动时会为此在日志里喊一句，用完记得关掉。

### 安装前它会告诉你三件事

点「查看内容」，它会去读仓库，然后给你看：

**① 要装哪些文件**

```
将安装插件：(仓库根目录)
来源：someone/cool-plugin @ main
文件：6 个，共 24.3KB
入口：index.js

  manifest.json          412B
  index.js              3.2KB     ← 高亮的是入口文件
  lib/helpers.js        1.8KB
  README.md             2.1KB
```

**② 代码里有没有敏感操作**

安装**之前**做的静态扫描，逐行检查并标出：

| 级别 | 会报什么 |
|---|---|
| 高 | `child_process` / `exec`（执行系统命令）、`eval`（动态执行代码）、删除文件、碰 `.ssh`/`.aws`/凭据文件 |
| 中 | `process.env`（可能读到你的 API Key）、网络请求、访问用户主目录、base64 解码（可能藏代码） |

比如它会明确告诉你：

```
⚠ 执行系统命令 — index.js:12
   cp.execSync('git rev-parse HEAD')
```

**③ 装完要不要立即启用**

默认**不启用**。装完之后插件躺在「设置 → 插件管理」里，状态是「已禁用」。你可以：

1. 先去 `plugins/某插件/` 目录**亲自看一眼代码**
2. 觉得没问题，点「启用」
3. 有问题，点「卸载」（会移到 `.mya/uninstalled/` 备份，不是直接删）

> 为什么默认不启用？因为**装插件等于装代码**——插件和 agent 跑在同一个 Node 进程里，拥有你的全部权限。静态扫描能挡掉大部分明显的坏东西，但它挡不住精心伪装的代码。最后那道防线只能是你自己看一眼。

### 关于 GitHub 配额

搜索用的是 GitHub 公开接口，**不填 Token 也能用**，但有配额限制（每分钟 10 次搜索、每小时 60 次接口调用）。

想更顺畅，去 [github.com/settings/tokens](https://github.com/settings/tokens) 生成一个 Token（**只需要默认权限，不要勾任何额外权限**），填到「设置 → 模型与 API 接入 → GitHub Token」里。填了之后：

- 配额大幅提升（搜索 30 次/分钟）
- **解锁「按 manifest.json 内容精确搜索」**——这是最准的找插件方式

> 为什么：GitHub 从 2023 年起要求登录才能用代码搜索接口，未认证调用直接返回 401。所以不填 Token 时只能用仓库名/描述/话题搜索。

### 插件装在哪

**装在你当前的工作目录下**（`<工作目录>/plugins/`），不是装在 agent 自己的目录里。

这个设计很重要：插件跟着项目走。你在 A 项目装了数据库插件，跑到 B 项目它不会跟着生效——既符合直觉，也避免一堆用不上的插件互相干扰。

每条安装记录会写一个 `.mya-source.json`，标记来源仓库、分支和安装时间。界面上的「来自 GitHub」标签就是读它。

---

---

## 自己写插件


市场里没有你想要的？自己写一个，比你想的简单。

### 30 秒写一个

在「设置 → 插件管理」里展开「自己写一个插件」，填个名字点生成；或者命令行：

```powershell
mya plugin new 我的插件
```

生成的 `plugins/我的插件/index.js` 长这样，改它就行：

```js
'use strict';

module.exports = {
  name: '我的插件',
  version: '0.1.0',
  description: '插件用途',

  setup(ctx) {
    // 1) 给模型加一个能力
    ctx.registerTool({
      name: 'my_tool',
      description: '这个工具做什么（这句话会进模型的上下文，写得越清楚模型用得越准）',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '参数说明' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      async run(args, tctx) {
        return `收到：${args.text}`;
      },
    });

    // 2) 挂个钩子，观察或干预 agent 行为
    ctx.on('tool:after', (e) => {
      if (!e.ok) ctx.warn(`工具 ${e.toolName} 失败了`);
    });
  },
};
```

点「重载」按钮（设置 → 插件管理），或者重启一次，「当前可用工具」清单里就能看到 `my_tool` 了。**不需要编译、不需要改核心代码。**

### 插件的两种形态

```
plugins/quick-tool.js           ← 单文件插件，适合小巧的工具
plugins/my-plugin/              ← 目录插件，适合复杂逻辑
    ├── manifest.json           ← 元信息
    ├── index.js                ← 入口
    └── node_modules/           ← 你自己的依赖（会优先从这里解析）
```

`manifest.json`：

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "插件描述",
  "entry": "index.js",
  "permissions": ["fs:read", "net:fetch"]
}
```

`permissions` 只是**声明和告警**，不是沙箱。插件能干什么，取决于代码写了什么。

> `index.js` 用 CommonJS 写（`module.exports`），这样即使插件有语法错误，报错也能精确指到行号。也支持 ESM：入口改成 `.mjs`，或在 manifest 里加 `"type": "module"`。

### 插件能干的事（5 个扩展点）

#### ⓪ 先说「卸载 / 重扫」的语义（热重载）

设置里点「重扫插件」、或装/卸插件之后，宿主会**先真正卸载**再重新加载。卸载这件事包含：

| 撤掉什么 | 为什么 |
|---|---|
| 这个插件注册的**事件钩子** | 否则「禁用掉的插件还在拦危险命令」；反复重扫会让同一个钩子跑多遍（实测监听器数 6 → 12 → 18） |
| 它的**工具 / 斜杠命令 / 提示词贡献** | 否则删掉的插件留下的工具还能被模型调用 |
| 它的**模块缓存**（`require.cache`，只清它自己目录里的） | 否则改了插件代码点重扫，加载到的还是**旧代码**（实测 v1 改 v2 后仍是 v1） |
| 调用它的 `teardown(ctx)`（如果定义了） | 插件自己收尾（关连接、清定时器） |

`/api/plugins/reload` 的返回里带 `disposed`（摘掉了几个钩子/工具/命令/模块）和当前钩子总数，
排查这类问题时先看这两个数字。

#### ① 注册工具 —— 给模型加能力

```js
ctx.registerTool({
  name: 'query_db',
  description: '查询本地数据库',
  parameters: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
  dangerous: true,      // 标记为危险 → 执行前弹确认框
  autoApprove: true,    // 或标记为免确认（按需选一个）
  tags: ['db'],         // 标签，工具多时用于筛选
  async run(args, tctx) {
    // tctx 里有：cwd / cfg / session / confirm / log / ask / emit / registry / signal / ui
    return { ok: true, content: '查询结果...' };
  },
});
```

**你的工具要不要弹确认，由 manifest 里声明的权限决定**（这是"内置工具要问、插件工具不问"那个反直觉设计的修正）：

| 插件的 permissions | 工具的确认行为 |
|---|---|
| 含 `fs:write` / `fs:delete` / `shell:exec` / `net:write` | **必须问**（在「询问」和「工作区内」档下都会问） |
| 只有 `fs:read` / `net:fetch` / 没声明 | 当只读工具，不打断用户 |

单个工具可以覆盖：`dangerous: true` 强制问、`autoApprove: true` 强制不问。
没有声明任何权限却注册了工具时，加载会打一条提醒——**权限是声明，不是沙箱**：
插件代码跑在 agent 进程里，它想干什么拦不住，所以装陌生插件前请先看一眼代码。

想让确认框里显示"这次会改什么"，给工具加 `preview(args, ctx)` 返回一段文本
（内置的 write/edit 就是用它给出 diff 的）。

`run` 的返回值有三种写法：

```js
return '直接返回字符串';
return { ok: false, content: '失败了，原因...' };  // 推荐，能明确表达失败
throw new Error('...');                          // 会被捕获，转成给模型的错误文本
```

> 工具抛异常**不会**让 agent 崩溃，会被转成文本回填给模型，模型自己会看到「工具失败了：xxx」然后调整策略。

#### ② 挂钩子 —— 观察和干预

```js
ctx.on('tool:before', (e) => {
  console.log('要执行', e.toolName, e.args);
  if (e.args.command?.includes('rm -rf')) return false;  // 返回 false = 拦截，不执行
});

ctx.on('messages:before', (e) => {
  // 直接改 e.messages，注入你自己的上下文
  e.messages.push({ role: 'system', content: '回答必须用中文。' });
});
```

完整事件表：

| 事件 | 何时触发 | 载荷 |
|---|---|---|
| `session:start` | 会话开始 | `sessionId, cwd, input` |
| `turn:start` | 每一轮开始 | `turn, session` |
| `messages:before` | 调模型前 | `messages`（**可原地改**）, `session`, `provider`, `emit` |
| `turn:context` | 每轮量完上下文 | `turn, context: { used, window, messages, compacted }` |
| `context:compacting` | 开始生成摘要 | `used, window, ratio, messages` |
| `context:compacted` | 上下文压缩完成 | `removed, kept, summary, savedTokens, used, window` |
| `assistant:reasoning` | 思考内容流式输出 | `text, delta, turn, session` |
| `assistant:delta` | 流式输出中 | `text, delta, turn, session` |
| `assistant:done` | 模型回复完成 | `text, reasoning, toolCalls, usage, context` |
| `tool:before` | 工具执行前 | `toolName, args, tool`（**返回 false 可拦截**） |
| `tool:after` | 工具执行后 | `toolName, args, ok, summary, output, ms` |
| `turn:end` | 每一轮结束 | `turn, reason` |
| `session:end` | 会话结束 | `usage, context, turns, toolCalls, elapsedMs` |
| `error` | 出错 | `error, where` |

钩子里抛异常**不会**拖垮主流程，只会转成一个 `error` 事件。

#### ③ 注册斜杠命令 —— 不花 token 的确定性操作

```js
ctx.registerCommand('deploy', { description: '部署到测试环境' }, async (input) => {
  // 不经过模型，直接执行
  return `已部署：${input}`;
});
```

在**终端模式的对话里**（`mya chat`）输入 `/deploy staging` 就会调用它。适合做「我不想让模型来决定」的固定操作。

> 网页界面目前只暴露插件的**工具**，斜杠命令还是终端模式专属。想在界面里也加上，在 `web/app.js` 的输入处理那一带做解析即可，核心的 `ctx.registerCommand` 已经就位。

#### ④ 贡献系统提示词

```js
ctx.addPrompt('查询数据库时优先用 query_db，不要直接读 .db 文件。');
```

#### ⑤ 读自己的配置

```js
const conf = ctx.getConfig({ maxResults: 5, apiKey: '' });
```

取值顺序：`config.json` 的 `plugins.config.<插件名>` → 环境变量 `MYA_PLUGIN_<插件名>_<键名>` → 默认值。

```json
{
  "plugins": {
    "config": {
      "my-plugin": { "maxResults": 10 }
    }
  }
}
```

### ctx 上还有什么

```js
ctx.name / ctx.version / ctx.dir / ctx.config / ctx.cwd   // 元信息
ctx.state                                                  // 插件自己的状态袋，跨钩子共享
ctx.utils                                                  // src/utils.js 全部工具函数
ctx.resolvePath(p, insideOnly)                             // 安全解析路径
ctx.callTool('read', { path: 'x' })                        // 在插件里调用别的工具
ctx.log() / ctx.warn() / ctx.error()                       // 带插件名前缀的日志
ctx.emit(event, payload)                                   // 主动抛事件
ctx.registerTools([...]) / ctx.unregisterTool(name)        // 批量 / 移除
```

### 内置的 5 个示例插件，建议按顺序读

1. **`plugins/hello`** —— 40 行，看懂它你就学会写插件了。演示了全部扩展点。
2. **`plugins/context-compact`** —— **上下文压缩**。学**怎么在 `messages:before` 里改上下文**：量用量、判断阈值、调模型写摘要、用 `session.compactHistory()` 安全地替换历史。还想学「怎么把插件状态推到界面」，看它抛的 `context:compacted` 事件。详见 [`plugins/context-compact/README.md`](../plugins/context-compact/README.md)。
3. **`plugins/fs-extra`** —— 学**怎么安全地访问文件系统**：用 `ctx.resolvePath` 限制路径、用 `ctx.utils.isIgnored` 跳过噪音目录、出错返回 `{ok:false}` 而不是抛异常。
4. **`plugins/audit`** —— 学**钩子的三种典型用法**：记录（写日志）、统计（内存累加）、**拦截**（黑名单直接阻止）。最值得抄的一个。
5. **`plugins/websearch`** —— 学**怎么读密钥 + 发网络请求**，以及没配置时怎么给出人话提示而不是报错。

---

---

> 回到 [README](../README.md) 看快速上手。
