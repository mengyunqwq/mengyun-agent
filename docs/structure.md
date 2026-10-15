# 目录结构


```
梦云Agent/
├── start.cmd / start.ps1 / start.sh   ← 一键启动（默认开桌面程序）
├── config.json                        ← 主配置（每项都有中文注释）。**个人配置，不进版本库**
├── config.example.json                ← 配置模板（敏感字段留空，给别人/新机器用）
├── .env.example                       ← 环境变量模板，复制成 .env 用
├── eslint.config.js / .prettierrc / .editorconfig  ← 代码风格与 lint（只开能抓真 bug 的规则）
├── jsconfig.json                      ← 让编辑器认 types/ 下的插件接口类型
├── LICENSE                            ← MIT
│
├── types/
│   └── plugin.d.ts                    ← 插件接口的 TS 类型契约（ctx / 工具定义 / 事件名）
├── docs/                              ← 分层文档（README 只留首屏，细节都在这）
│
├── .github/workflows/ci.yml           ← CI：Linux 跑 10 个套件 + lint，Windows 跑全量（含桌面）
│
├── desktop/                           ← 桌面程序（Electron）
│   ├── main.js                         主进程：起服务、开窗口、菜单、单实例、自检
│   ├── preload.js                      安全桥：只暴露明确列出的几个能力
│   ├── make-icon.js                    图标生成器（手写 PNG/ICO 编码，零依赖）
│   └── build.js                        打包脚本（免安装 exe + 打包后校验 asar 内容）
│
├── build/
│   ├── icon.ico                        应用图标（多尺寸，由 make-icon.js 生成）
│   └── icon.png                        图标源图 1024×1024
│
├── web/                               ← 界面（原生 HTML/CSS/JS，无构建）
│   ├── index.html                      单页结构：标题栏 + 会话列表 + 对话 + 设置浮层
│   ├── app.css                         浅色 / 深色两套主题样式
│   └── app.js                          全部前端逻辑（含轻量 Markdown 渲染）
│
├── bin/
│   └── mya.js                         ← 命令行入口（只管参数转发）
│
├── src/                               ← 后端
│   ├── cli.js          命令行：所有子命令、终端交互模式
│   ├── desktop.js      桌面启动器：找 Electron、拉起窗口、找不到就退回浏览器
│   ├── app.js          组装层：把下面这些拼成一个可用的 agent
│   ├── agent.js        ★ 主循环：问模型 → 调工具 → 回填 → 再问
│   ├── provider.js     模型层入口：按 apiFormat 选协议 + 格式自动识别
│   ├── tools.js        工具注册表：注册、参数校验、确认闸门、事件
│   ├── plugins.js      ★ 插件宿主：发现、加载、钩子、脚手架
│   ├── session.js      会话：消息历史、落盘、系统提示词组装、上下文压缩切点
│   ├── reasoning.js    推理等级：内部语义值 → 各家官方字段的翻译（唯一一份）
│   ├── tasks.js        并行子任务调度器：并发池、深度限制、超时、预算、中断级联
│   ├── checkpoint.js   git 检查点：独立索引 + 隐藏 ref，不碰用户的 HEAD/暂存区
│   ├── diff.js         行级 diff（零依赖 LCS）：确认闸门里给人看「到底改了什么」
│   ├── logger.js       结构化日志：分级、JSON Lines、轮转、脱敏
│   ├── model-info.js   模型元信息缓存：网关报的上下文窗口（权威值），按「地址+模型」记
│   ├── events.js       事件总线：插件挂钩子的地方
│   ├── config.js       配置：5 层优先级覆盖 + 容错
│   ├── ui.js           终端界面层
│   ├── utils.js        工具函数：路径、glob、截断、模糊匹配
│   ├── index.js        库入口：把 agent 当库用
│   ├── providers/      ← 各家的 API 协议适配
│   │   ├── base.js         基类：网络、重试、超时、SSE 读取、错误翻译
│   │   ├── openai.js       /chat/completions（DeepSeek、OpenAI、Ollama、多数中转站）
│   │   ├── anthropic.js    /v1/messages（x-api-key、tool_use/tool_result 翻译）
│   │   └── gemini.js       generateContent（模型名进 URL、functionDeclarations 翻译）
│   ├── tools/
│   │   ├── builtin.js  6 个内置工具：read/write/edit/glob/grep/shell
│   │   ├── task.js     4 个任务工具：task_spawn/wait/status/cancel（拆分并行子任务）
│   │   └── web.js      联网工具：web_search（Bing / DuckDuckGo / 自定义）+ web_fetch
│   └── web/            ← 界面后端
│       ├── server.js            HTTP 服务：REST + SSE（含合帧与背压）+ 静态资源 + 本地来源校验
│       ├── session-manager.js   多会话引擎：事件流、排队、历史还原
│       ├── io.js                输出适配 + 网页确认闸门
│       ├── lan-gate.js          局域网模式的访问令牌闸门（?token= → HttpOnly cookie）
│       └── plugin-market.js     ★ GitHub 搜索 / tarball 解压 / 安装审查
│
├── catalog/
│   └── plugins.json                 内置插件市场的「离线货架」（加一条即上架）
│
├── plugins/                           ← 插件目录（跟着工作目录走）
│   ├── hello/              最小示例
│   ├── context-compact/    上下文压缩（超阈值自动总结旧历史）
│   ├── fs-extra/           目录树 / 文件信息 / 项目统计
│   ├── audit/              审计 + 危险命令拦截
│   └── websearch/          接第三方搜索服务的示例（Tavily，需要 Key）
│
├── prompts/
│   ├── system.zh.md    ★ 系统提示词（agent 的人格，随便改）
│   └── system.en.md
│
├── test/
│   ├── run-all.js          ★ 测试总入口（跨平台、失败继续、汇总表、可并行、自带 --self-test）
│   ├── selftest.js         后端单元/集成：72 项
│   ├── mock-server.js      端到端：起假模型服务，真实走完整个链路
│   ├── web-check.js        前端一致性静态检查：36 项（不需要浏览器）
│   ├── freeze-guard.js     卡死防护：11 项（真跑刷屏脚本验证熔断）
│   ├── web-search.js       联网工具：29 项（注入假 fetch，不发真实请求）
│   ├── context-compact.js  上下文压缩：16 项
│   ├── provider-formats.js 三种 API 协议：53 项（含推理等级按官方定义）
│   ├── web-e2e.js          界面端到端：49 项
│   ├── plugin-contract.js  插件接口契约：6 项（types/plugin.d.ts ↔ 宿主 ctx）
│   ├── tasks.js            并行子任务调度：27 项（并发/深度/超时/取消/预算/掩码）
│   ├── logging.js          结构化日志：11 项
│   └── desktop-e2e.js      桌面程序验证：17 项（真开窗口 + 图标 + 打包产物）
│
├── dist/                               打包产物（免安装 exe）
└── .mya/                               运行时数据（自动创建，已 gitignore）
    ├── sessions/       会话记录
    ├── logs/mya.log    结构化日志（JSON Lines，5MB 轮转）
    ├── test-report.json 最近一次 npm test 的机器可读结果
    ├── uninstalled/    卸载插件的备份
    └── audit.log       审计日志（audit 插件写）
```

---

---

> 回到 [README](../README.md) 看快速上手。
