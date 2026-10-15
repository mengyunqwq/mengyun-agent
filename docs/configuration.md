# 配置系统


### 配置文件放在哪

| 场景 | 配置目录（`config.json`、`.env`、`.mya` 数据都在这里） |
|---|---|
| 从源码跑（`node bin/mya.js` / `npm start`） | 项目目录——改起来方便 |
| **打包后的 exe** | **`%APPDATA%\mengyun-agent\`**——Electron 的用户数据目录，名字取 `package.json` 的 `name`；首次启动自动铺好 `config.json` 和 `.env` 模板 |
| 想自己指定 | 设环境变量 `MYA_CONFIG_DIR`（桌面版也认，显式指定优先） |

为什么打包版不放程序目录：程序目录是 `resources/app.asar`——**只读的虚拟路径**，往里写会报

```
ENOENT: no such file or directory,
open '...\resources\app.asar\config.json'
```

而且免安装版每次启动会解压到新的临时目录，写进去也留不住。

程序自带的 [`config.json`](../config.json) 仍然有用：**配置目录里没有对应文件时会复制一份过去**（只在缺失时复制，绝不覆盖你改过的）。放在 `Program Files` 这类只读位置也能正常保存设置。

### 分层覆盖

配置有 5 层，**下面覆盖上面**：

```
1. 代码内置默认值（src/config.js 的 DEFAULTS）
2. .env 文件
3. config.json
4. 环境变量（MYA_* 开头的）
5. 命令行参数
```

所以临时试一个模型不用改文件：

```powershell
mya --model gpt-4o-mini --provider openai --key sk-xxx
```

### 关键配置项

`config.json` 里每一项都有中文注释，这里说几个最常调的：

| 配置项 | 说明 |
|---|---|
| `provider` | `deepseek` / `openai` / `ollama` / `custom`，会自动补全 baseUrl 和 model |
| `apiFormat` | 接口协议：`auto`（按地址识别）/ `openai` / `anthropic` / `gemini` |
| `model` | 模型名，随时换 |
| `maxTurns` | 单轮最多几次工具调用，**防止死循环烧钱**，默认 25 |
| `tools.autoApprove` | 免确认白名单，默认 `["read","glob","grep"]`（注意：敏感文件闸门在它之前生效，见 `tools.guardSensitive`） |
| `tools.guardSensitive` | 读 `.env` / `config.json` / 私钥这类文件前要不要问一句，默认 `true` |
| API 配置库 | 存在配置目录的 `.mya/api-profiles.json`（多套「服务商+地址+Key+模型」存档与当前使用的那条；界面只回 Key 掩码） |
| 工作区列表 | 存在配置目录的 `.mya/workspaces.json`（程序自己维护，不写进 config.json）；列表 = 注册表 ∪ 各会话的 cwd |
| `tools.insideOnly` | 路径是否限制在工作目录内，默认 `true`；设成 `false` 等于放开全盘（按真实路径判，junction 也拦） |
| `approval.mode` | 权限档位：`ask`（默认，每次都问）/ `workspace`（工作区内免问，越界仍问）/ `full`（不再问）。界面输入区的「权限」栏就是改它 |
| `checkpoint` | git 检查点（`enabled` / `keep`）：动文件前自动打点、可回滚，见 [checkpoints.md](./checkpoints.md) |
| `tasks` | 并行子任务（`enabled` / `maxParallel` / `maxDepth` / `budgetTurns` / `budgetTokens` / `readonlyTools`），见 [parallel-tasks.md](./parallel-tasks.md) |
| `tools.deny` | 禁用某些工具（插件工具也能在这里屏蔽） |
| `tools.maxOutputChars` | 单个工具返回上限，防止一次读几万字撑爆上下文 |
| `plugins.dirs` | 插件搜索目录，**相对工作目录**，可以写多个做私有插件库 |
| `plugins.disabled` | 禁用的插件名列表（界面上点启用/禁用就是在改这里） |
| `contextWindow` | 模型上下文窗口，界面用量圆环的分母。`0` = 按模型名推断 |
| `compact` | 上下文压缩策略（`enabled` / `threshold` / `keepRecent` / `maxSummaryTokens`） |
| `shell.allowDangerous` | `false` 时 shell 只放行只读命令 |
| `web.enabled` | 是否允许模型联网（关掉后 `web_search` / `web_fetch` 不出现在能力列表里） |
| `web.provider` | 搜索后端：`bing`（默认）/ `duckduckgo` / `custom` |
| `web.endpoint` | `provider=custom` 时的接口地址，可以写 `{query}` 占位符 |
| `web.timeoutSec` | 搜索与抓网页的超时秒数，默认 15 |
| `session.save` | 是否保存会话 |

> **注意**：`config.json` 里可以用 `$注释` 这种键写中文说明（加载时会被自动忽略），
> 但**不要往 `package.json` 的 `build` 段里加**——那个字段有严格 schema 校验，
> 多一个键 electron-builder 就会拒绝启动（这个坑踩过一次）。

### 环境变量

`.env.example` 有完整列表。最常用的：

```bash
MYA_API_KEY=sk-xxx        # 必填（本地 Ollama 除外）
MYA_PROVIDER=deepseek     # 可选
MYA_MODEL=deepseek-chat   # 可选
MYA_API_FORMAT=auto       # 接口协议：auto | openai | anthropic | gemini
MYA_MAX_TURNS=25          # 可选
MYA_CONTEXT_WINDOW=128000 # 可选：模型上下文窗口（用量圆环的分母）
MYA_ALLOW_DANGEROUS=1     # 危险：放开 shell 限制
MYA_YES=1                 # 危险：所有工具免确认
MYA_TAVILY_KEY=tvly-xxx   # websearch 插件用（接 Tavily）。日常联网不需要它，内置 web_search 免密钥
MYA_PROXY=http://127.0.0.1:7890   # 走代理出网（联网搜索、插件市场都吃这个）
NODE_EXTRA_CA_CERTS=D:\certs\公司根证书.crt   # 公司代理替换了 HTTPS 证书时，指到根证书
MYA_INSECURE_TLS=1        # 危险：跳过 HTTPS 证书校验，只在确认风险后临时用
GITHUB_TOKEN=ghp_xxx      # 插件市场配额（也可在界面设置里填）
MYA_DEBUG=1               # 打印异常堆栈
MYA_DEBUG_DISCOVER=1      # 打印插件发现/加载过程（排查插件问题用）
```

---

---

> 回到 [README](../README.md) 看快速上手。
