# 梦云 Agent

一个跑在你自己电脑上的编码智能体。**双击就是一个程序窗口**，像 Codex 一样能读写文件、执行命令，**插件可以从 GitHub 一键搜索安装**，而且所有代码都在你手里。

```
┌──────────────────────────────────────────────────────────────────────────┐
│  ▣ 梦云 Agent                              custom/deepseek  [⚙ 设置] ─ □ ✕│
├────────────┬─────────────────────────────────────────────────────────────┤
│            │                                                             │
│  新建会话   │   你                                                        │
│ ─────────  │   帮我把 utils.js 的 humanSize 改成支持 TB                   │
│ ▸ 改 human  │                                          ┌─────────┐      │
│   Size     │                                          │ 发送 ▶  │      │
│ ▸ 了解项目  │   梦 我先读一下这个文件。                     └─────────┘      │
│ ▸ 检查 bug  │   ▶ read  ✓ 210 行                                          │
│            │   梦 找到了，现在改。                          ◯ 12% ↑发送     │
│ E:\项目      │   ▶ edit  ✓ 已修改                                          │
└────────────┴─────────────────────────────────────────────────────────────┘

       点右上角「设置」之后（从右侧滑出的浮层，关掉就不占地方）：

                            ┌───────────────────────────────────┐
                            │  设置                          ✕  │
                            ├───────────┬───────────────────────┤
                            │ 模型与 API │  外观                  │
                            │ 插件管理   │   主题  (浅色)(深色)   │
                            │ 插件市场   │   主题色 ●●●●●●●●      │
                            │ 外观       │                       │
                            │ 行为与安全 │                       │
                            │ 关于       │                       │
                            └───────────┴───────────────────────┘
```

## 它是什么

- **本地、一键部署**：免安装 exe，双击就能用；不需要装 Node、不需要 Docker、运行时**零依赖**
- **真的能干活**：读写文件、搜索代码、跑命令、跑测试；每一步都会先问你（危险操作必确认）
- **可插拔**：工具、钩子、斜杠命令、系统提示词都能由插件扩展；插件市场支持 GitHub / 本地 / 自带三种来源
- **协议可插**：同一套内核支持 OpenAI 兼容 / Anthropic / Gemini 三种协议，中转站也能接
- **上下文可控**：输入区有个圆环显示用量（拿到上游实测后就按实测校准），悬停看细节；长会话默认在 62% 自动压缩，每次压缩都会在对话里留一条可展开的记录，也可以按键手动压
- **复杂任务能拆**：一句话说不清的活，模型可以拆成几个子任务**并行**跑，各自只读、各花各的预算，最后汇总回来（见 [docs/parallel-tasks.md](docs/parallel-tasks.md)）
- **改崩了能回去**：动文件之前自动打一个 git 检查点（**不碰**你的 HEAD / 暂存区 / 工作区），`mya checkpoint restore <ref> --yes` 一条命令回滚（见 [docs/checkpoints.md](docs/checkpoints.md)）
- **出事了查得到**：每一步的 token、结构化日志（`mya.log`）、可归因的错误提示

## 30 秒上手


**前提**：装好 [Node.js 18+](https://nodejs.org)。

```powershell
# Windows：双击 start.cmd 就行
# 首次运行会自动生成 .env 并打开记事本，填一行：
#   MYA_API_KEY=sk-你的key
# 保存关闭，程序窗口就打开了
```

```bash
# Linux / macOS
chmod +x start.sh && ./start.sh
```

**装桌面组件（推荐，一次就够）**：

```powershell
npm install
```

这会下载 Electron（约 100MB）。装完之后双击 `start.cmd` 打开的是**原生程序窗口**，不是浏览器标签页。

> 不装也能用——会自动退回浏览器界面，功能一模一样。

### 常用命令

```powershell
mya                      # 打开程序窗口（没装桌面组件则开浏览器）
mya desktop              # 同上，并输出诊断信息
mya web                  # 强制用浏览器打开
mya chat                 # 在终端里对话
mya "把这个项目翻译成中文"  # 单次执行，适合脚本
mya doctor               # 环境体检（推荐第一次跑一下）
mya doctor --probe       # 把请求摊开分层验（接中转站必备，可配 --api-format 试协议）
mya tools                # 我有哪些工具
mya plugins              # 我装了哪些插件
mya desktop --selftest   # 桌面程序自检（窗口/主题/接口是否正常）
npm run icon             # 重新生成应用图标
```

### 先跑个体检

```powershell
.\start.cmd doctor
```

它会检查 Node 版本、配置有没有写错、插件加载情况，并**真的发一次请求**测试模型连通性，出错会直接告诉你中文原因和修法。

---

## 界面速览

- **左栏**：类 Codex 的三分区，各自可折叠——**工作区**（当前会话目录的文件树，懒加载、`node_modules` 默认隐藏）、**会话**（点一行切换，标着每个会话的工作目录）、**插件**（装了什么、开着没有）。新会话会先让你选目录，底部的路径就是 agent 的活动范围
- **对话区**：用户消息是右侧浅灰气泡；助手回答整宽平铺、没有头像；工具调用压成一行灰字（`✓ read src/app.js  18ms`），点一下展开输出
- **思考过程**：折成一行「已思考 3.2s · 1.2k token」，默认收起
- **输入区是一个圆角框**：左下角依次是 **+ 号**（选文件/文件夹/压缩包）、**权限**（询问 / 工作区内执行 / 完全权限）、**模型**（展开式列表 + 推理等级抽屉）；右边是累计用量、上下文圆环和圆形发送键
- 设置是点开才出现的右侧浮层：模型与 API / 插件管理 / 插件市场 / 外观 / 行为与安全 / 关于

细节、动效取舍与「为什么这么设计」都在 [docs/ui.md](docs/ui.md)。

## 目录结构（精简）

```
bin/        命令行入口（mya chat / web / desktop / doctor / plugin …）
desktop/    桌面壳：主进程、preload 桥、打包脚本、图标生成
src/        内核：agent 主循环、会话、工具注册表与内置工具、插件宿主、三种协议适配、配置
  web/      网页服务：HTTP/SSE、会话管理、插件市场
web/        界面：单页 index.html + app.css + app.js
plugins/    自带示例插件（审计 / 上下文压缩 / 文件增强 / 联网搜索 / 最小示例）
prompts/    系统提示词（中英各一份）
catalog/    内置插件市场的离线清单
types/      插件接口的 TS 类型契约（plugin.d.ts）
docs/       这份文档的分层正文
test/       11 个测试套件 + 跨平台测试总入口 run-all.js
```

逐项说明见 [docs/structure.md](docs/structure.md)。

## 测试与质量

```bash
npm test                # 全部 11 个套件（跨平台，失败也继续跑完并给汇总）
npm run test:fast       # 跳过需要 Electron 的桌面套件（约 10 秒）
npm run lint            # ESLint（只开能抓真 bug 的规则）
```

当前：**12 个套件 / 345 项用例**。每个套件盯什么都写在 [docs/testing.md](docs/testing.md)。

## 安全与隐私（先说清楚）

- 网页服务**只监听 127.0.0.1**，并且校验 Host / Origin（防 DNS rebinding 与本地 CSRF）
- **密钥放 `.env`（`MYA_API_KEY`）或 `config.json`**；两者都不会进版本库（`.gitignore` 已忽略），
  仓库里提交的模板是 `config.example.json`（敏感字段一律留空）
- **插件就是代码**：装插件等于让它在你的权限下运行。权限声明只是告警不是沙箱，
  所以默认「装完是禁用状态」，你看过代码再启用

## 文档索引

| 想看什么 | 去哪 |
|---|---|
| 先把窗口开起来（3 条命令） | [30 秒上手](#30-秒上手) |
| 桌面程序：无边框窗口、菜单、自检、托盘与图标 | [docs/desktop.md](docs/desktop.md) |
| 界面说明：侧栏/对话区/输入区；含上下文圆环、展开式模型面板、推理等级 | [docs/ui.md](docs/ui.md) |
| 设置浮层里六个视图分别能改什么 | [docs/settings.md](docs/settings.md) |
| 界面为什么不再卡死（合帧、背压、输出熔断的来龙去脉） | [docs/why-no-freeze.md](docs/why-no-freeze.md) |
| 插件市场三种来源 + 怎么写一个插件（API 契约见 types/plugin.d.ts） | [docs/plugins.md](docs/plugins.md) |
| 上下文压缩：切点怎么选、阈值与自动/手动 | [docs/context-compact.md](docs/context-compact.md) |
| 并行子任务：复杂任务拆开一起跑（工具、预算、安全边界） | [docs/parallel-tasks.md](docs/parallel-tasks.md) |
| git 检查点：动文件前自动打点，一条命令回滚 | [docs/checkpoints.md](docs/checkpoints.md) |
| 配置系统：配置文件在哪、分层覆盖、关键配置项、环境变量 | [docs/configuration.md](docs/configuration.md) |
| 接入模型：四种预设、协议选择、拉取模型列表、连不上怎么判断 | [docs/models.md](docs/models.md) |
| 内置工具清单与安全机制（确认闸门、路径约束、危险命令） | [docs/tools.md](docs/tools.md) |
| 工作原理：主循环、事件、会话、上下文计量 | [docs/architecture.md](docs/architecture.md) |
| 打包分发给别人（免安装 exe 是怎么来的） | [docs/build.md](docs/build.md) |
| 自测：测试总入口、11 个套件各盯什么 | [docs/testing.md](docs/testing.md) |
| 排障：结构化日志（.mya/logs/mya.log）与 /api/logs | [docs/observability.md](docs/observability.md) |
| 常见问题与「接下来可以怎么改」 | [docs/faq.md](docs/faq.md) |
| 目录结构的逐项说明 | [docs/structure.md](docs/structure.md) |

## 授权

这份代码给你了，随便改、随便用。
