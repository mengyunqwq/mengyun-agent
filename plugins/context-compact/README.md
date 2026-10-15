# context-compact —— 上下文压缩

把**较早的历史**交给模型总结成一段摘要，用摘要替换那一段，最近几轮原样保留。

## 为什么需要它

Agent 干活时上下文长得很快：读几个文件、跑几轮工具，几万 token 就没了。撞上模型上下文上限的后果不是「变慢」，而是**接口直接报错、会话进行不下去**。

界面上有一条上下文用量条（输入框下方），用量接近窗口时它会变黄、变红。这个插件负责在变红之前把上下文压下来。

## 什么时候会压缩：默认等你说

压缩会**改写对话历史**，所以默认**不自动压**：

| 触发方式 | 说明 |
|---|---|
| 输入区用量条右边的 **「压缩上下文」** 按钮 | 点一下就压，界面上的按钮走的就是 `/compact` |
| 斜杠命令 `/compact` | 聊天框里输入 |
| 自动（`compact.auto: true`） | 打开开关后，每轮请求前量一次，≥ 阈值（默认 75%）且可压缩条数 ≥ `minMessages`（默认 10）时自动压 |

为什么默认改成手动：自动压的时机不由你定——你正看着上下文、心里有数，它却把你要回看的旧消息折掉了，而且没征求你同意。

压缩过程会在对话里留一条记录：

```
↺ 上下文已压缩   已折叠 37 条更早的对话 · 省下约 12.4k token · 当前 18.2k / 128k
```

点开能看到模型写的那份摘要。**这一步必须显式告诉用户**——否则用量会突然掉一半，看起来像 bug。

## 为什么不直接丢掉旧消息

直接截断最省事，但会丢掉关键信息：改过哪些文件、定过什么方案、还有哪些事没做完。模型会在下一轮重新去读一遍文件，甚至改错地方。总结一次的成本远低于这个代价。

摘要提示词要求保留五类信息：用户的目标与约束、改过的文件与改动内容、已确认的技术结论、未完成的事项与风险、报错与排查进展。

## 切点为什么讲究

OpenAI 协议里 `tool` 消息必须紧跟着它对应的 `assistant(tool_calls)`。从中间随便切一刀很容易把这一对拆散，服务商直接返回 400。

所以真正动手切的是 `Session.compactHistory()`，它会把切点往后挪到安全位置，并在压缩点插入一条 `user` 角色的摘要消息（不用 `system`——部分网关对历史里的额外 system 消息处理不一致）。

## 配置

三种来源，后面的覆盖前面的：

1. 插件里的默认值
2. `config.json` 的 `plugins.config["context-compact"]`
3. 环境变量 `MYA_PLUGIN_CONTEXT_COMPACT_<KEY>`

另外 `config.json` 的 `compact` 段优先级最高（Web 设置界面写的就是这一段）：

```json
{
  "contextWindow": 0,
  "compact": {
    "enabled": true,
    "auto": false,
    "threshold": 0.75,
    "keepRecent": 8,
    "maxSummaryTokens": 1200
  }
}
```

| 项 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就只能靠模型的窗口硬扛 |
| `auto` | **`false`** | `false` = 手动（按钮 / `/compact`）；`true` = 超过阈值自动压 |
| `threshold` | `0.75` | **只在 `auto: true` 时生效**。界面上限制在 30%~95% |
| `keepRecent` | `8` | 压缩后保留最近多少条消息 |
| `maxSummaryTokens` | `1200` | 摘要长度上限（写进提示词约束模型） |
| `minMessages` | `10` | 可压缩的消息少于这个数就不压（压了反而亏） |

`contextWindow` 是**整个 agent** 的配置，不是这个插件的：界面上的用量条拿它当分母。留 `0` 表示自动——**优先用网关返回的窗口大小**（Gemini 的 `inputTokenLimit`、OpenRouter 的 `context_length` 等，存在数据目录的 `model-info.json`），网关没给才按模型名推断。

## 命令

```
/compact          现在压一次（界面上的按钮也走这个命令）
/compact_stats    看压缩统计（当前模式、累计次数、最近一次时间）
```

## 失败会怎样

压缩失败**绝不会拖垮对话**：捕获异常、保留原上下文继续跑，同时抛一个 `error` 事件让界面提示出来。不静默是关键——否则用户只会看到「用量一直在涨，压缩好像没生效」，却查不到原因。

手动触发时还会额外抛一个 `context:compact-failed`（带原因），界面靠它判断该提示成功还是失败——**不去解析那段中文**。

## 事件

插件通过事件总线暴露状态（`src/events.js` 里有清单）：

| 事件 | 时机 |
|---|---|
| `context:compacting` | 开始生成摘要（界面显示「正在总结较早的对话…」） |
| `context:compacted` | 压缩完成（界面插入一条压缩记录） |
| `context:compact-failed` | 没压成（消息太少、摘要太短、请求失败…），带 `error` 原因 |

## 自己写一个类似的

这个插件是个不错的参考，它用了三样东西——`messages:before` 钩子、`registerCommand` 命令、`session` 对象：

```js
ctx.on('messages:before', async (e) => {
  // e.messages  —— 即将发出去的数组，可以原地改
  // e.session   —— 会话对象（compactHistory / measureContext）
  // e.provider  —— 模型客户端，可以自己发请求
  // e.emit      —— 抛事件给界面
});

// 界面上的按钮可以调这个命令（core 用 PluginHost.runCommand 调）
ctx.registerCommand('compact', { description: '压缩上下文' }, async (input, extra) => {
  // extra.session / extra.provider / extra.emit
  return '给人看的一句话';
});
```

要做「只留最近 N 轮」「按文件路径去重」这类策略，改这个文件里的判断条件即可，不用碰核心代码。
