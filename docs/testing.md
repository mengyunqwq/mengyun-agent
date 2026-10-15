# 自测


改完代码跑一下。**几乎全部离线，不消耗一分钱 token。**

## 一个入口：`test/run-all.js`

```bash
npm test                  # 全部 11 个套件（顺序跑，失败也继续，最后给汇总表 + 退出码）
npm run test:fast         # 跳过需要 Electron 的 desktop-e2e（约 10 秒）
npm run test:parallel     # 并行 3 路（抢 CPU，时序敏感的用例会变慢）
node test/run-all.js --only=selftest,web-check     # 只跑指定的
node test/run-all.js --json                        # 机器可读结果 + 写 .mya/test-report.json
node test/run-all.js --self-test                   # 验证这个运行器自己的汇总/退出码逻辑
node test/run-all.js --stop-on-fail                # 想要「第一处失败就停」的旧行为
npm run lint                                       # ESLint（只开能抓真 bug 的规则）
```

为什么不再用 `a && b && c`：`&&` 是 shell 语法（Windows cmd / sh / PowerShell 5.1 行为不一致，
直接粘进 PowerShell 会报 `The token '&&' is not a valid statement separator`），
而且它是**一失败就全停**——第 3 个套件挂了后面 6 个根本不跑，你拿不到全貌。
`run-all.js` 用 `child_process` 直接起 node（不经过 shell），失败了也继续跑完，
最后给一张表 + 一个退出码。它自己也有测试（`--self-test`）。

## 11 个套件分别盯什么

```bash
node test/selftest.js          # 后端 124 项（配置分层 / 插件生命周期 / 会话 / 工作区与归档 / API 配置库 / diff / 检查点 / 局域网 / 安全加固 / npm 打包清单）
node test/web-check.js         # 前端与代码一致性 47 项（不启动浏览器）
node test/freeze-guard.js      # 卡死防护 11 项（会真跑一个刷屏脚本验证熔断）
node test/web-search.js        # 联网工具 29 项（全程注入假 fetch，一次真实请求都不发）
node test/context-compact.js   # 上下文压缩 16 项（切点、手动/自动、失败降级）
node test/provider-formats.js  # 三种 API 协议 53 项（格式翻译、流式、鉴权、端点、错误归因、模型列表、推理等级）
node test/mock-server.js       # 端到端 7 项（起假模型服务走完整链路）
node test/web-e2e.js           # 界面端到端 58 项（含安全头、权限档位往返、检查点接口、畸形 URL）
node test/web-e2e.js --online  # 额外测真实 GitHub 搜索/下载（+5 项）
node test/plugin-contract.js   # 插件接口契约 6 项（types/plugin.d.ts 与宿主 ctx 是否一一对应）
node test/tasks.js             # 并行子任务调度 27 项（并发上限/深度/超时/取消/预算/生命周期/只读掩码）
node test/logging.js           # 结构化日志 11 项（格式/级别/脱敏/轮转/tail/写不坏）
node test/desktop-e2e.js       # 桌面程序 17 项（真的开窗口 + 图标 + 打包产物能不能存配置）
```

合计 **12 个套件 / 406 项**。

覆盖的东西：

- **`selftest.js`** —— 配置分层覆盖、**配置目录解析（打包版不会写进只读的 asar）**、路径安全、glob 转换、参数校验、确认闸门、插件发现/加载/失败隔离、钩子拦截、会话裁剪、主循环（多轮工具调用/并行/拒绝/上限/异常）、**思考内容的存储与事件**、**每步 token 与累计值、会话级工作目录**、**上下文用量估算**、**上下文窗口的取值优先级（用户 > 网关 > 推断）与缓存分键**、CLI 端到端
- **`web-check.js`** —— 静态检查前端：JS 引用的 DOM id 是否都存在、JS 用到的 class 是否都有样式、设置浮层的视图和面板是否一一对应、**设置默认是收起的（不占页面）**、**`innerHTML` 插入的动态内容是否都转义过**、外链是否带 `noopener`、**浅色和深色两套主题的变量是否完整**（漏一个就会出现"深色界面里突然一块白的"）、主题初始化脚本是否排在样式表之前（否则会闪色）、组件样式里有没有漏改的写死颜色、**设置浮层该有的分区是否都在**、**主题色色板数据是否完整且两处定义一致**、**上下文用量是不是圆环、具体数字是不是悬停才展开（含 `.open` 规则与分档变色）**、**思考块的样式是否齐备**、**输入区换模型的按钮与面板（含 `[hidden]` 覆盖、只提交 model 字段、展开式分组列表要能折叠能过滤）**、**推理等级的选项是否按各家官方定义生成（`reasoning_effort` / `thinking.budget_tokens` / `thinkingConfig.thinkingBudget`）、是否只提交 reasoning 字段**、**侧栏那两个按钮（刷新 / 重扫插件）是不是真的删掉了**、**对话区观感是否还是 Codex 那一套（无头像、中性灰气泡、无边框工具行、正文居中列宽、圆点在模型名后面、输入区是一个框）**、**主体高度有没有依赖「隐藏的标题栏占位」（浏览器模式会塌成 52px）**、**联网搜索的开关与后端选择是否齐备、关掉时工具会不会从模型的能力列表里消失**
- **`context-compact.js`** —— 专门盯上下文压缩的边界：**切点会不会拆散 tool/assistant 对**（拆散会被服务商 400）、历史太短时不动手、摘要失败时原样保留且抛 error 事件、摘要太短时放弃压缩、**压缩后请求里不能出现 `_reasoning` / `_compacted` 这类内部字段**、用量估算口径、窗口大小推断
- **`provider-formats.js`** —— 三种 API 协议 × 流式/非流式/工具调用/思考内容，配一个按路径分派的假网关（同时会说三种协议）。重点验：**协议翻译**（system 的位置、工具结果怎么表达、工具定义的形状）、**端点与鉴权**（Anthropic 必须发 `max_tokens`、Gemini 流式必须换 `:streamGenerateContent` 端点）、**流式事件的组织方式**（Anthropic 按内容块、Gemini 按 parts）、**错误归因**（模型名 / 鉴权 / 额度 / 端点四类要分对，别把「模型名错」提示成「地址错」）、**模型列表拉取**（三家地址与鉴权各不同，`models/` 前缀要剥掉，网关不支持时要能退回手填）、**推理等级按各家官方定义发字段**（OpenAI 兼容发 `reasoning_effort`，Anthropic 发 `thinking.budget_tokens` 且必须去掉 temperature，Gemini 发 `thinkingConfig.thinkingBudget`；默认一档一个字段都不发）
- **`plugin-contract.js`** —— 插件接口契约：把宿主 `makeContext()` **真正给出去的 ctx 成员**逐个和 `types/plugin.d.ts` 对上（少一个就红）、所有钩子事件名都在类型里（`EVENTS` 是唯一真相）、`ToolDefinition` 里那些「会影响行为」的字段（`autoApprove`/`needsConfirm`/`needsConfirm` 等）都声明了。没有这个套件，插件作者会照着一份慢慢过期的文档写代码，而且**不会有任何测试报错**
- **`tasks.js`** —— 并行子任务调度器。不接模型（`runSubtask` 是注入的），所以能精确造出真实模型上很难复现的场景：并发上限（第 3 个必须排队、峰值只能是 2）、深度限制（子任务不能再拆）、单个子任务超时会自己收掉、父任务中断/结束时子任务被级联取消（**僵尸任务防线**）、token/轮数预算用完就拒绝新的拆分、排队中的任务也能取消、事件必须带父会话对象（不然多会话会串台）、`view()` 不能泄露 `controller`/`promise`/`session`。还有一条专门盯着**只读掩码**：`registry.clone(['read'])` 之后 write/shell 必须彻底看不见
- **`logging.js`** —— 结构化日志：JSON Lines 格式、级别过滤、**敏感字段自动脱敏**（apiKey/token/secret 不能落日志）、超长字段截断、`tail()` 顺序、**写不进去也不能把程序搞崩**、轮转之后最新日志还在、`record()` 只落盘不打两份控制台
- **`freeze-guard.js`** —— 专门盯「软件会不会卡死」：后端有没有把同一个块的连续流式事件合帧（不合帧就是平方级的网络量）、前端有没有按帧合并重绘、超长正文会不会降级成纯文本、工具输出有没有截断上限、消息区有没有误开平滑滚动。**它不是只看代码里有没有那几行**——它会真的跑一个死循环刷屏的脚本，确认几秒内被熔断；再跑一个等 stdin 的脚本，确认不会挂到超时
- **`web-search.js`** —— 联网工具的后端与正文转换：DuckDuckGo 的**跳转链接还原**（不还原的话用户点开看到的是中转页）、广告与重复结果剔除、custom 接口的两种 JSON 形状、HTML 转正文（去脚本样式、块级标签转换行、实体解码）、截断时要说清还剩多少、网络错误的中文翻译与密钥打码。全程注入假 fetch，**一次真实请求都不发**，所以没网也能跑
- **`mock-server.js`** —— 在本地起一个假的 OpenAI 兼容服务，真的启动一次 agent 让它去调。**流式 SSE 解析、`tool_calls` 参数分片拼接、工具执行、结果回填、`reasoning_content` 解析与展示**这条最容易写错的链路会被真实走一遍
- **`web-e2e.js`** —— 起真实的 HTTP 服务：静态资源、所有 REST 接口、SSE 事件流、完整对话链路、**确认闸门（挂起 → 拒绝 → 文件没被写；允许 → 文件被写）**、插件装卸、本地来源校验（伪造 Origin/Host 被拒）、tar.gz 解压、路径穿越防护、**首次使用（什么都没配）时的引导路径**、**上下文用量与思考内容的事件推送和落库**、**模型列表接口**、**只改 model 的切换（地址和 Key 不能被顺手清掉）**、**磁盘历史会话能被列出来/能删掉**、**每一步的 token**、**新建会话指定目录 + 目录不存在时的报错与创建**、**手动压缩（默认不自动压，按键才压）**、**内置插件离线安装 + 本地文件夹/zip 安装（解出来的插件要真的能用）+ 不是插件就拒绝**
- **`web-e2e.js --online`** —— 真实 GitHub：搜索仓库、**排除普通项目误判**（拿 express 当反例）、**真实下载并解压 tarball**、安装到不存在的目录时正确失败且不留残留
- **`desktop-e2e.js`** —— **真的启动一次桌面程序**，让它自己检查：窗口标题、页面渲染、**preload 桥是否注入**、界面能否连上本地服务、**输入区换模型的按钮能不能真的弹开/点外面关掉/按 Esc 关掉**、**点「新建会话」会不会先弹选目录（含取消不建会话）**、**每步 token 那一行渲染得对不对**、**插件市场默认停在「内置插件」且 5 个插件卡片都渲染出来了（离线）**、首次使用（没配模型）时窗口能否打开、端口冲突时能否自动换端口、**打包出来的 exe 能否独立运行**，以及图标（PNG/ICO 结构是否合法、图标是不是空图、**把图标从 exe 里抠出来和源图比像素**）

> 有几项是针对真实踩过的坑加的，值得说明：
> - `main` 字段如果没指向 `desktop/main.js`，electron-builder 会把别的文件当主进程启动，**打包后的程序双击完全没反应**（日志里看不出来）
> - electron-builder 找不到图标时**只会静默换成默认图标**，所以必须把图标从 exe 里抠出来比像素
> - 主题色有没有真的生效，只查 DOM 属性不够——要截图采样像素
> - 压缩的切点必须避开 `tool` / `assistant(tool_calls)` 的配对，**这种错误在界面上完全看不出来**，只会在下一轮变成 400
> - 协议的端点差异也有测试盯着：Gemini 的流式端点是 `:streamGenerateContent`，而 `:streamGenerateContent` 里**并不包含**子串 `:generateContent`——按 `includes` 判断会静默走到非流式那一支
> - 测试里起的服务必须用 `MYA_CONFIG_DIR` 把配置目录钉在沙箱里。不钉的话 `rootDir` 会解析成**程序所在的目录**，于是「保存设置」会去读写你真实的 `config.json`——症状是测试跑到一半 baseUrl 突然变成你自己的中转站，然后后面所有用例都开始报连不上的错，方向完全指错
> - 光钉 `MYA_CONFIG_DIR` 还不够：**Electron 的 profile 也要用 `--user-data-dir=` 钉进沙箱**。profile 里有单实例锁，你自己正开着程序时，测试起的那个实例拿不到锁会**静默退出**、报告一个字都不写，测试只会报「打包版没有写出自检报告」——和真实原因毫不相干（踩过，白查半天）。顺手这样也不会去写你真实的 `%APPDATA%`
> - 桌面版的配置目录**必须认 `MYA_CONFIG_DIR`**。以前 `setupConfigDir()` 无条件把 userData 写回这个环境变量，等于把显式指定的目录悄悄吃掉：测试以为配置落在沙箱，实际写进了真实数据目录，「隔离」形同虚设
> - 布局那条也值得说：`body` 原来用「标题栏 / 顶栏 / 主体」三行的 grid 模板，而自绘标题栏在**浏览器模式**下是 `display:none`——`display:none` 的元素**不是 grid item**，于是本该给主体的那一行被顶栏占掉，整个界面塌成 52px 高。桌面模式因为标题栏是显示的，这个问题藏了很久；是给界面截图时才撞出来的。现在改成 flex column，隐藏元素自然不占位

> `mock-server.js` 也是「怎么把自己的网关接进来」最好的参考——照它的请求/响应格式做就行。

加 `MYA_DEBUG=1` 可以看到失败项的完整堆栈。

---

---

> 回到 [README](../README.md) 看快速上手。
