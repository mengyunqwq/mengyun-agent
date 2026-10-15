# 接入模型


支持三种接口协议，**在设置里选**（或写 `apiFormat`）：

| 接口格式 | 端点 | 适用 |
|---|---|---|
| **OpenAI 兼容** | `/chat/completions` | DeepSeek、OpenAI、Ollama、**绝大多数中转站** |
| **Anthropic Messages** | `/v1/messages` | Claude 官方、只给 Anthropic 原生格式的中转站 |
| **Google Gemini** | `generateContent` | Gemini 官方、只给 Gemini 原生格式的中转站 |

默认是 **`auto`：按接口地址自动识别**——地址里带 `/messages` 或 `anthropic` 就用 Anthropic，带 `generativelanguage` 或 `:generateContent` 就用 Gemini，其余按 OpenAI 兼容处理。所以你多数时候不用管这一项。

### 为什么做成可选

中转站的协议**不一定和它宣传的一致**：有的号称 OpenAI 兼容其实只实现了 `/v1/messages`；有的两种都开但工具调用只有一种能用。写死一种格式，就成了「你拿到哪家，就得看运气」。

选错格式的典型症状：

| 现象 | 多半是 |
|---|---|
| 404 | 请求打到了对方不存在的端点（格式选错，或地址少了 `/v1`） |
| 401 / 403 | 鉴权头不对：OpenAI 用 `Authorization: Bearer`，Anthropic 用 `x-api-key`，Gemini 用 `x-goog-api-key` |
| 400 且提示 `tools` 相关 | 该格式的工具定义形状不对（Anthropic 要 `input_schema`，Gemini 要裸 `functionDeclarations`） |
| 400 且提示 `max_tokens` | 选了 Anthropic 但没发 `max_tokens`（这是必填项，程序会自动带上） |

### 怎么快速试出对方认哪种

```powershell
mya doctor --probe --api-format anthropic
mya doctor --probe --api-format gemini
mya doctor --probe --api-format openai
```

`--probe` 会**分层验证**并把请求摊开，一眼看出卡在哪一层：

```
请求探针
  接口格式   Anthropic Messages（手动指定）
  最终地址   https://你的中转站/v1/messages
  鉴权方式   x-api-key: sk-abc*** + anthropic-version

  ① 最小请求（不带工具）          → 验「地址 + 鉴权 + 模型名」
  ② 带工具调用（agent 实际会这么发） → 很多站基础聊天能用，一给 tools 就 400
  ③ 流式（SSE）                  → 不标准的网关会让 agent 一直转圈

结论
✓ 三层都通（Anthropic Messages）：地址、鉴权、模型名、工具调用、流式全都没问题。
```

不动你的配置，`--api-format` 只影响这一次探测。

### 四种预设

<details>
<summary><b>DeepSeek（默认，便宜好用）</b></summary>

```bash
MYA_PROVIDER=deepseek
MYA_API_KEY=sk-xxx
# 默认 model=deepseek-chat；想用推理模型改成 deepseek-reasoner（思考过程会折起来显示）
```
</details>

<details>
<summary><b>OpenAI</b></summary>

```bash
MYA_PROVIDER=openai
MYA_API_KEY=sk-xxx
MYA_MODEL=gpt-4o-mini
```
</details>

<details>
<summary><b>本地 Ollama（完全免费、完全离线）</b></summary>

```bash
ollama pull qwen2.5-coder:7b

MYA_PROVIDER=ollama
MYA_MODEL=qwen2.5-coder:7b
# baseUrl 自动填 http://127.0.0.1:11434/v1，不需要 key
```

⚠️ 本地小模型的工具调用能力通常明显弱于云端大模型，可能经常忘记调工具或参数写错。建议至少 14B 以上。
</details>

<details>
<summary><b>自建网关 / 中转站</b></summary>

```bash
MYA_PROVIDER=custom
MYA_BASE_URL=https://你的网关/v1        # 写到 /v1 就行
MYA_API_KEY=xxx
MYA_MODEL=你想要的模型
MYA_API_FORMAT=auto                    # 拿不准就留 auto；报 404/401 再手动指定
```

Claude 类中转站通常长这样：

```bash
MYA_PROVIDER=custom
MYA_BASE_URL=https://你的中转站/v1
MYA_API_KEY=sk-xxx
MYA_MODEL=claude-sonnet-4-5
MYA_API_FORMAT=anthropic
```
</details>

界面上「设置 → 模型与 API」里也能改这些。切「接口格式」时，**接口地址的输入提示会跟着变**（告诉你该写到 `/v1` 还是 `/v1beta`），「测试连接」按钮可以立刻验证。

### 模型名不用手打：一键拉取

模型名错一个字符就是 404，而服务端明明知道自己有哪些模型。所以设置里「模型」那一项旁边有个 **「获取列表」** 按钮：

```
模型  [ deepseek-flash          ] [获取列表]
      ↓ 点一下
      ┌──────────────────────────────────────────┐
      │ deepseek-flash  deepseek-v4-pro          │
      │ agnes-3.0-flash  agnes-image-2.5-flash ·非对话 │
      └──────────────────────────────────────────┘
```

- 用界面上**当前填的**地址 / 协议 / 密钥去拉，所以改了地址可以立刻看有什么模型，不用先保存
- 点模型名直接填入；同时也灌进输入框的联想列表，手打时会自动补全
- **图像 / 视频 / 向量 / 语音类模型会标上「·非对话」**——它们通常不支持工具调用，选了 agent 干活会失败
- 拉不到也没关系：不少自建网关没实现 `/models`，界面会说明原因并让你手填

三种协议各自的接口不同，程序会自动按格式选（`/v1/models`、`/v1beta/models`，鉴权头也各不相同）。

**平时想换个模型，不用进设置**：输入框左下角那个模型按钮点开就能换，选完立刻生效（见 [换模型](./ui.md#换模型-推理等级输入区左下角就有按钮)）。设置里这一份是给「第一次配置」和「换网关」用的。

### 连不上时怎么判断原因

报错会**做语义识别**再给建议——因为 404 既可能是地址写错，也可能是「地址对但模型名不存在」，这两种要你做的事完全不同。笼统地提示「换个协议试试」会把人带偏。

程序认这四类：

| 类别 | 服务端常见的说法 | 该做什么 |
|---|---|---|
| **模型名** | `模型 "X" 不在分组中。可用：a, b, c` / `model not found` / `invalid model` | 改「模型」这一项。**报错里给的可用列表会被打出来**，还标注了哪些是图像/视频类（多半不支持工具调用） |
| **鉴权** | `invalid api key` / `incorrect api key` / `unauthorized` | 检查 Key；Key 没问题就试换「接口格式」（三家鉴权头不同） |
| **额度** | `insufficient quota` / `余额不足` | 去中转站后台看余额和分组权限，不是配置问题 |
| **端点** | `no route` / `Cannot POST /...` | 地址或协议格式对不上 |

比如模型名填错时的报错长这样：

```
模型名不被接受（HTTP 404）：模型 "LLM" 不在分组「LLM」中。可用：...

这个网关可用的模型：
  · agnes-2.5-flash
  · agnes-image-2.5-flash（非对话模型，多半不支持工具调用）
  · deepseek-flash
  · deepseek-v4-pro

去「设置 → 模型与 API」把「模型」改成上面列表里的一个。
（当前格式=OpenAI 兼容, baseUrl=https://api.example.com/v1, model=LLM）
```

### 加一种新协议

协议适配是**可插拔**的：照 `src/providers/anthropic.js` 的样子写一个类，继承 `BaseProvider`，实现三个方法，然后在 `src/provider.js` 的 `API_FORMATS` 和 `createProvider()` 里各加一行。

```js
class MyProvider extends BaseProvider {
  defaultEndpoint(stream) { /* 返回请求地址；stream 决定挂哪个端点 */ }
  buildHeaders()          { /* 鉴权头 */ }
  buildBody(req, stream)  { /* 把 OpenAI 格式的 messages/tools 翻译成对方格式 */ }
  parseResponse(json)     { /* 对方响应 → 统一结构（见下） */ }
  createStreamState(req)  { /* 流式：返回一个 { push(data), finish() } 状态机 */ }
}
```

统一结构的契约（上层只认这个，所以换协议不用改内核）：

```js
{
  text: '模型的文本回复',
  reasoning: '思考内容（没有就空字符串）',
  toolCalls: [{ id, name, args, rawArgs }],
  usage: { prompt_tokens, completion_tokens, total_tokens },
  finishReason: 'stop' | 'tool_calls' | 'length',
}
```

有两个坑值得先知道：

- **有工具调用时 `finishReason` 必须报 `tool_calls`**。agent 主循环靠它决定「继续跑工具」还是「收工」，报错会导致模型明明要调工具却被当成最终答复。
- **流式的端点可能不一样**。Gemini 的流式是 `:streamGenerateContent` 而不是给 `:generateContent` 加 `stream: true`——所以 `defaultEndpoint(stream)` 收了 `stream` 参数。这个坑踩过一次：请求打到了非流式端点，拿到一份普通 JSON，解析器读不到 SSE 事件，最后报成「流式响应为空」，很难往这个方向想。

---

---

> 回到 [README](../README.md) 看快速上手。
