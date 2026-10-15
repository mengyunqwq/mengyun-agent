# 排障：结构化日志

出问题时最想知道的是「**刚才那几十秒到底发生了什么**」。以前只有控制台，
关掉窗口就什么都不剩；工具调用、插件报错、接口 500 全靠翻屏幕。
现在有一条结构化日志兜底。

## 日志在哪

| 项 | 值 |
|---|---|
| 位置 | `<工作目录>/.mya/logs/mya.log` |
| 格式 | JSON Lines（一行一条，机器可直接读） |
| 轮转 | 单文件到 5MB 就轮转，最多留 3 个历史文件（`mya.log.1` …） |
| 默认级别 | `info` |

选 `.mya/logs` 而不是仓库根，有两个原因：日志天然是「这个项目」的，
放在项目工作目录里最直观；而且 `.mya/` 早就在 `.gitignore` 里，
跑一次命令不会给你冒出一个需要提交的新目录。

## 怎么看

```bash
# 跟着看（排障时最常用）
tail -f .mya/logs/mya.log

# 只看错误
grep '"level":"error"' .mya/logs/mya.log

# 一条条看得清楚点（有 jq 的话）
tail -n 50 .mya/logs/mya.log | jq -r '"\\(.ts[11:19]) [\\(.level)] \\(.logger): \\(.msg)"'
```

界面跑着的时候也可以直接问服务端（不用去翻文件）：

```bash
curl -s "http://127.0.0.1:3080/api/logs?n=50" | jq '.lines'
```

## 里面都记了什么

| 时机 | 级别 | 关键字段 |
|---|---|---|
| 应用组装开始 / 完成 | info | cwd、provider、model、推理等级、工具数、插件数 |
| 界面服务启动 | info | url、host、port、是否需要令牌、日志文件路径 |
| 插件加载成功 | debug | 插件名、版本、注册的工具/命令/钩子、目录 |
| 插件加载失败 | error | 插件名、错误、文件 |
| 接口处理出错（HTTP 500） | error | message、stack |

## 环境变量

| 变量 | 作用 |
|---|---|
| `MYA_LOG_LEVEL` | `error` / `warn` / `info` / `debug` / `trace`，默认 `info` |
| `MYA_LOG_DIR` | 换日志目录（默认 `<工作目录>/.mya/logs`） |
| `MYA_LOG_CONSOLE` | `0` 关掉控制台输出（默认：交互式终端才打） |
| `MYA_LOG_STDERR` | `1` 时日志走 stderr，方便管道里把日志和正常输出分开 |

排查插件问题把级别调到 debug：

```bash
MYA_LOG_LEVEL=debug npm start
```

## 两点设计取舍

- **默认脱敏**：字段名里出现 `apiKey` / `token` / `secret` / `password` / `authorization`
  的值一律打码（形如 `sk-l***op`），免得「为了排障把密钥写进日志再发给别人」这种经典事故。
  要对照是不是同一个 key，看前后几位就够了。
- **同步写盘**：写入用的是同步的 `fs.writeSync`，不是可写流。流是缓冲的，
  刚出错那条要等下一个 tick 才落盘——而「出错当下立刻去看」恰恰是日志最主要的用法（
  这一点是写测试时才发现的：`tail()` 会读不到刚写的最后几条）。

## 测试

`node test/logging.js`（11 项）盯着：JSON 行格式、级别过滤、脱敏、超长截断、
`tail()` 顺序、写不进去也不崩、轮转不丢最新、`record()` 不打两份控制台。
