'use strict';

/**
 * 梦云 Agent —— 会话（Session）层
 *
 * 负责：
 *   - 维护一条对话的消息数组（OpenAI messages 协议）
 *   - 落盘保存 / 恢复，方便下次接着聊
 *   - 统计 token 用量
 *   - 组装系统提示词（读 prompts/*.md，不存在就用内置兜底）
 *
 * 注意：发给模型前会剥掉内部字段（_ts 之类），避免污染协议。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { shortId, timestamp, readTextFile, writeTextFile, ensureDir, truncate } = require('./utils');
const { getContextWindow } = require('./model-info');

/* ------------------------------------------------------------------ */
/* 上下文窗口与 token 估算                                              */
/* ------------------------------------------------------------------ */

/**
 * 常见模型的上下文窗口（token）。
 *
 * 为什么需要这个：界面上要显示「上下文用了多少 / 一共多少」，
 * 分母从哪来？服务商的响应里只有「用了多少」，没有「最多多少」。
 * 所以这里按模型名匹配一份预设表，用户也能在 config.json 里用
 * contextWindow 直接覆盖（拿不准就配一个，比猜准）。
 */
const CONTEXT_WINDOWS = [
  [/deepseek-(reasoner|chat|v3|coder)/i, 128000],
  [/deepseek/i, 128000],
  [/gpt-4o|gpt-4\.1|gpt-4-turbo|o1|o3|o4/i, 128000],
  [/gpt-3\.5/i, 16385],
  [/gpt-4/i, 8192],
  [/qwen|qwq/i, 131072],
  [/claude/i, 200000],
  [/glm-4/i, 128000],
  [/kimi|moonshot/i, 128000],
  [/llama|mistral|gemma|phi/i, 32768],
];

/** 按服务商兜底（模型名匹配不上时用） */
const PROVIDER_DEFAULT_WINDOW = {
  deepseek: 128000,
  openai: 128000,
  ollama: 8192,
  custom: 128000,
};

/**
 * 估算一段文本的 token 数。
 *
 * 这不是分词器，是估算——目的是让「上下文快满了」这种提示能提前出现，
 * 而不是等到接口报 400。中文大约 1 字 1 token，英文大约 4 字符 1 token，
 * 所以按字符类型分别折算，比单纯除以 4 准得多（中文内容能差 2 倍以上）。
 */
function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    // CJK 统一表意文字、日文假名、韩文
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x3400 && code <= 0x4dbf)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  // 每条消息还有 role / 结构开销，由调用方按条数补
  return Math.ceil(cjk + other / 4);
}

/** 估算一组 OpenAI messages 的 token 数（含每条消息的结构开销） */
function estimateMessagesTokens(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let total = 0;
  for (const msg of list) {
    total += 4; // 每条消息的角色、分隔符等固定开销
    total += estimateTokens(msg.content);
    if (msg.tool_calls) total += estimateTokens(JSON.stringify(msg.tool_calls));
    if (msg.name) total += estimateTokens(msg.name);
    if (msg.tool_call_id) total += 4;
  }
  return total + 2;
}

/**
 * 从历史里回溯「最近一次请求上游实际报了多少输入 token」。
 *
 * 为什么要它：估算公式对中文偏低（2.2 字符/token 是乐观值），只有估算的话
 * 「第一次压缩」会来得偏晚——等到上游 400 才知道窗口满了，那时这一轮已经废了。
 * 上游给的 prompt_tokens 是权威值，用它给估算兜个底。
 *
 * 两条边界：
 *   · **压缩之前**测到的值不能当锚点：历史已经被换掉了，拿旧请求的 token 数兜底
 *     会让用量永远降不下来，压缩等于白压。所以按时间比：只认晚于最后一次压缩的测量；
 *   · 加上 completion：那次请求产出的回答已经进了历史，下一次请求要把它一起带上。
 *
 * @param {Array} messages 内部历史（带 _usage / _compacted），不是 toMessages() 的产物
 * @returns {number} 0 表示没有可用的锚点
 */
function lastRealPromptTokens(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let lastCompactedAt = 0;
  for (const msg of list) {
    if (msg && msg._compacted && Number(msg._compacted.at) > lastCompactedAt) {
      lastCompactedAt = Number(msg._compacted.at);
    }
  }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const u = list[i] && list[i]._usage;
    if (!u || Number(u.promptTokens) <= 0) continue;
    if (Number(u.at || 0) <= lastCompactedAt) break; // 比最后一次压缩更早 → 作废
    return Number(u.promptTokens) + Number(u.completionTokens || 0);
  }
  return 0;
}

/**
 * 推导上下文窗口大小。
 *
 * 注意这里的**取值顺序**，它决定了界面上那个分母可不可信：
 *   1. 用户显式配的 contextWindow（他说的最算数）
 *   2. 网关自己报的（Gemini 的 inputTokenLimit、OpenRouter 的 context_length…）
 *   3. 按模型名推断（这张表是兜底，不是真相）
 *
 * 需要知道用的是哪一种时用 resolveContextWindowInfo()。
 *
 * @param {object} cfg 配置
 * @returns {number} token 数
 */
function resolveContextWindow(cfg = {}) {
  return resolveContextWindowInfo(cfg).window;
}

/** 同上，但额外告诉你这个数字是从哪来的 */
function resolveContextWindowInfo(cfg = {}) {
  const explicit = Number(cfg.contextWindow);
  if (Number.isFinite(explicit) && explicit > 0) {
    return { window: Math.floor(explicit), source: 'config' };
  }

  const model = String(cfg.model || '');
  // 网关报过的值：这是服务端自己的上限，比我们猜的可靠
  const known = getContextWindow(cfg, model);
  if (known) return { window: known.window, source: 'gateway', at: known.at };

  for (const [pattern, size] of CONTEXT_WINDOWS) {
    if (pattern.test(model)) return { window: size, source: 'estimate' };
  }
  const byProvider = PROVIDER_DEFAULT_WINDOW[String(cfg.provider || '').toLowerCase()];
  return { window: byProvider || 128000, source: 'estimate' };
}

/* ------------------------------------------------------------------ */
/* 系统提示词                                                          */
/* ------------------------------------------------------------------ */

/** 内置兜底提示词：prompts/*.md 缺失时使用，保证 agent 永远能跑 */
function builtinSystemPrompt(ctx) {
  const { cwd, platform, date, toolNames } = ctx;
  return `你是「梦云 Agent」——一个运行在用户本机的编程助手，风格类似 Codex：直接、务实、动手解决问题。

# 运行环境
- 操作系统：${platform}
- 工作目录：${cwd}
- 当前时间：${date}
- 可用工具：${toolNames}

# 工作方式
1. **先看再改**：修改任何文件前，先用 read 读它；用 grep/glob 定位而不是猜。
2. **动手而不是空谈**：需要了解代码库就调用工具去查，不要把问题丢回给用户。
3. **最小改动**：只改与任务相关的代码，不顺手重构、不擅自加注释和文档。
4. **改完要验证**：能跑测试就跑测试（shell 工具），能检查语法就检查。
5. **失败要如实说**：工具报错就把错误原文带上，不要假装成功、不要编造输出。
6. **危险操作要克制**：删除文件、强制推送、安装全局依赖这类操作，先说明理由再执行。
7. **一次一步**：不要用 && 串一长串命令；每一步的意图要清楚。

# 回答风格
- 用中文回答（用户用英文提问时用英文）。
- 简洁，不铺垫、不复述用户的话、不写"好的我来帮你"这类废话。
- 引用代码时用 \`文件路径:行号\` 的格式。
- 完成后用一两句话说明「做了什么、结果如何、还有什么没做」，不要长篇总结。
`;
}

/**
 * 组装系统提示词。
 * 优先读 prompts/<lang>.md；其中的 {{变量}} 会被替换。
 */
function buildSystemPrompt(cfg, { toolNames, pluginHints = [], extra = '', cwd = '' } = {}) {
  // toolNames 传进来可能是数组，也可能是逗号分隔的字符串，这里统一成数组再拼
  const names = Array.isArray(toolNames) ? toolNames : String(toolNames || '').split(',').map((s) => s.trim()).filter(Boolean);
  const vars = {
    // 每个会话可以有自己的工作目录，所以由调用方传进来优先，
    // 否则提示词里写的目录会和工具实际能碰的范围对不上
    cwd: cwd || cfg.cwd || process.cwd(),
    platform: `${os.type()} ${os.release()} (${process.platform}/${process.arch})`,
    date: timestamp(),
    model: cfg.model || '',
    provider: cfg.provider || '',
    toolNames: names.join(', '), // 展示用
    toolNameList: names, // 需要数组时用这个
    toolCount: names.length,
    pluginCount: pluginHints.length,
    pluginHints: pluginHints.join('\n'),
  };

  let template = null;
  if (cfg.systemPromptFile && fs.existsSync(cfg.systemPromptFile)) {
    template = readTextFile(cfg.systemPromptFile, null);
  }
  if (!template) template = builtinSystemPrompt(vars);

  // 变量替换：{{cwd}} 之类
  let prompt = template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, key) =>
    vars[key] === undefined ? m : String(vars[key]),
  );

  if (extra) prompt += `\n\n${extra}`;
  return prompt;
}

/* ------------------------------------------------------------------ */
/* 会话文件头部读取                                                    */
/* ------------------------------------------------------------------ */

/** 头部元信息的读取上限：会话文件里消息历史占大头，元数据在文件最前面 */
const HEAD_BYTES = 64 * 1024;

/**
 * 只读会话文件的头部元信息（id/title/usage/context…），不把整个 messages
 * 数组搬进内存。
 *
 * save() 写盘时 messages 固定排在最后一个键，所以：
 *   - 小文件（≤ HEAD_BYTES）直接整份解析，最稳；
 *   - 大文件只读前 HEAD_BYTES 字节，在 messages 数组开头把 JSON 截断、
 *     补个右括号再解析，拿到的就是除 messages 以外的完整头部；
 *   - 头部里没等到 messages 标记、或截出来的 JSON 不合法（格式意外），
 *     就退回整份读——宁可慢一点也不能把会话从列表里弄丢。
 *
 * 注意截断标记锚定了缩进和 `[`：context 里也有个 "messages" 键，但它是
 * 数字且缩进 4 格，不会撞上 `\n  "messages": [`。
 *
 * @returns {{data:object, partial:boolean}|null} partial=true 表示没读 messages
 */
function readSessionHead(file, size) {
  const readFull = () => {
    try {
      return { data: JSON.parse(fs.readFileSync(file, 'utf8')), partial: false };
    } catch {
      return null;
    }
  };

  if (size <= HEAD_BYTES) return readFull();

  let raw;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const read = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      raw = buf.toString('utf8', 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }

  const cut = raw.indexOf('\n  "messages": [');
  if (cut === -1) return readFull();
  try {
    // 截断处前面是上一个键后面的逗号，去掉再补右括号才是合法 JSON
    const headJson = `${raw.slice(0, cut).replace(/,\s*$/, '')}\n}`;
    return { data: JSON.parse(headJson), partial: true };
  } catch {
    return readFull();
  }
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

class Session {
  /**
   * @param {object} cfg 全局配置
   * @param {object} [opts]
   * @param {string} [opts.id] 会话 id
   * @param {string} [opts.title] 会话标题（一般取第一条用户消息）
   */
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this.id = opts.id || `${new Date().toISOString().slice(0, 10)}-${shortId(6)}`;
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;
    this.title = opts.title || '';
    this.cwd = opts.cwd || cfg.cwd || process.cwd();
    /** 归档：不删会话，但从主列表收起来（侧栏里归到「已归档」） */
    this.archived = opts.archived === true;
    /** @type {Array<object>} 原始历史（含 _ts 等内部字段） */
    this.messages = [];
    this.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
    /** 最近一次发给模型的上下文规模（估算值），界面上的用量条用它 */
    const windowInfo = resolveContextWindowInfo(cfg);
    this.context = {
      used: 0,
      window: windowInfo.window,
      windowSource: windowInfo.source,
      messages: 0,
      compacted: 0,
      /** 纯字符估算值（界面上可以对照看「估算 vs 实测」差多少） */
      estimated: 0,
      /** used 里是否用了上游实测值兜底 */
      anchorUsed: false,
    };
    this.turns = 0;
    this.dirty = false;
    this._systemPrompt = '';
  }

  /** 文件路径 */
  get filePath() {
    return path.join(this.cfg.session.dir, `${this.id}.json`);
  }

  /* ---------------- 系统提示词 ---------------- */

  setSystemPrompt(text) {
    this._systemPrompt = text;
    // 第一条永远是 system；直接替换而不是追加，避免越聊越长
    if (this.messages.length && this.messages[0].role === 'system') {
      this.messages[0] = { role: 'system', content: text, _ts: Date.now() };
    } else {
      this.messages.unshift({ role: 'system', content: text, _ts: Date.now() });
    }
    this.dirty = true;
  }

  getSystemPrompt() {
    return this._systemPrompt;
  }

  /* ---------------- 追加消息 ---------------- */

  addUser(content) {
    this.messages.push({ role: 'user', content, _ts: Date.now() });
    if (!this.title) this.title = truncate(String(content).replace(/\s+/g, ' '), 60);
    this.dirty = true;
  }

  addAssistant(content, toolCalls, reasoning, usage, ms) {
    const msg = { role: 'assistant', content: content || '' };
    if (toolCalls && toolCalls.length) {
      msg.tool_calls = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: typeof tc.rawArgs === 'string' ? tc.rawArgs : JSON.stringify(tc.args || {}) },
      }));
    }
    // 思考内容只留给我们自己看：下一轮绝对不能原样发回给模型。
    // 服务商对 history 里的思考字段处理不一致，有的直接 400。
    // 所以存成下划线开头的内部字段，toMessages 会剥掉。
    if (reasoning) msg._reasoning = String(reasoning);
    // 这一步（这一次请求模型）花了多少 token。
    // 也要落盘：刷新页面后每一步的用量还得能显示出来，不能只在内存里。
    if (usage) {
      msg._usage = {
        promptTokens: usage.prompt_tokens || usage.promptTokens || 0,
        completionTokens: usage.completion_tokens || usage.completionTokens || 0,
        totalTokens: usage.total_tokens || usage.totalTokens || 0,
        ms: ms || 0,
        /** 测量时刻：用来判断这个实测值是不是「压缩之前」的（旧的就不能再当锚点） */
        at: Date.now(),
      };
    }
    msg._ts = Date.now();
    this.messages.push(msg);
    this.dirty = true;
  }

  addToolResult(toolCallId, toolName, content) {
    this.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      name: toolName,
      content: String(content ?? ''),
      _ts: Date.now(),
    });
    this.dirty = true;
  }

  /** 手工插入任意消息（插件注入上下文时用） */
  addRaw(message) {
    this.messages.push({ ...message, _ts: Date.now() });
    this.dirty = true;
  }

  /* ---------------- 供模型使用 ---------------- */

  /**
   * 转成发给 API 的 messages 数组。
   * - 剥掉 _ts 等内部字段
   * - 可选按 maxHistoryMessages 裁剪，且保证不会把 tool 消息与其 tool_calls 拆散
   * - 可选压缩旧工具输出，省 token（默认开启）
   */
  toMessages({ maxMessages, compressOldToolOutput = true, toolOutputKeepChars = 3000 } = {}) {
    const limit = maxMessages || this.cfg.session.maxHistoryMessages || 200;
    let list = this.messages;
    if (limit > 0 && list.length > limit) {
      // 保留 system + 最近 (limit-1) 条
      const head = list[0] && list[0].role === 'system' ? [list[0]] : [];
      let tail = list.slice(-(limit - head.length));
      // 修正切割点：如果 tail 以 tool 消息开头，说明它的 assistant(tool_calls) 被切掉了，
      // 这种孤儿 tool 消息会被部分服务商直接报 400，所以往后跳。
      let guard = 0;
      while (tail.length && tail[0].role === 'tool' && guard < tail.length) {
        tail = tail.slice(1);
        guard += 1;
      }
      list = [...head, ...tail];
    }

    return list.map((msg) => {
      const out = { role: msg.role };
      if (msg.content !== undefined) {
        // 老工具输出太长时做压缩，保留尾部（错误信息通常在后面）
        if (compressOldToolOutput && msg.role === 'tool' && String(msg.content).length > toolOutputKeepChars * 2) {
          const text = String(msg.content);
          out.content = `${text.slice(0, toolOutputKeepChars)}\n…（中间省略 ${text.length - toolOutputKeepChars * 2} 字符）…\n${text.slice(-toolOutputKeepChars)}`;
        } else {
          out.content = msg.content;
        }
      }
      if (msg.tool_calls) out.tool_calls = msg.tool_calls;
      if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
      if (msg.name && msg.role === 'tool') out.name = msg.name;
      return out;
    });
  }

  /* ---------------- 上下文用量 ---------------- */

  /**
   * 更新「当前上下文规模」的估算值。
   * 每轮问模型之前调一次，界面就能实时显示用量条。
   *
   * 返回的是快照，不是 this.context 本身——压缩插件要拿压缩前后的两个
   * 快照算「省下多少 token」，如果返回同一个对象引用，调用方手里的
   * 「压缩前」会被后来的测量覆盖成压缩后的值。
   *
   * @param {Array} messages 即将发出去的消息数组
   * @returns {{used:number, window:number, messages:number, compacted:number}}
   */
  measureContext(messages) {
    const list = Array.isArray(messages) ? messages : this.messages;
    const info = resolveContextWindowInfo(this.cfg);
    const estimated = estimateMessagesTokens(list);
    /**
     * 估算对中文是**偏低**的（按 2.2 字符/token 折算，真实约 1.5~1.8），
     * 光靠它会让「第一次压缩」来得偏晚——等上游 400 才知道窗口满了，代价太大。
     * 所以：拿最近一次请求上游**实际报告**的输入 token 当锚点，取两者较大值。
     *
     * 锚点从历史里现推（不去持久化它），这样重启/恢复会话也算得出来；
     * 压缩之后旧锚点就没意义了（历史已经被换掉），所以遇到压缩标记就停止回溯。
     *
     * 注意锚点要看 **this.messages**（内部历史）而不是传进来的 list：
     * 传进来的通常是 toMessages() 的产物，内部字段（_usage）已经被剥掉了，
     * 从那儿永远找不到实测值。
     */
    const anchor = lastRealPromptTokens(this.messages);
    this.context.estimated = estimated;
    this.context.used = anchor ? Math.max(estimated, anchor) : estimated;
    this.context.anchorUsed = !!anchor;
    this.context.window = info.window;
    // 记下这个分母是怎么来的：界面要如实告诉用户
    // 「这是网关说的」还是「这是我按模型名猜的」
    this.context.windowSource = info.source;
    this.context.messages = list.length;
    return { ...this.context };
  }

  /** 上下文用掉的比例（0~1），界面上画进度条用 */
  contextRatio() {
    if (!this.context.window) return 0;
    return Math.min(1, this.context.used / this.context.window);
  }

  /**
   * 用一段摘要替换掉较早的历史（上下文压缩插件调用）。
   *
   * 做成独立方法而不是让插件直接改 messages 数组，是因为有三个必须一起做的动作：
   * 保留 system、保留最近若干条、在压缩点插一条说明。
   * 少做任何一个，下一轮请求都可能变成「孤儿 tool 消息」而被服务商拒绝。
   *
   * @param {number} keepRecent 保留最近多少条
   * @param {string} summary    旧内容的摘要
   * @param {object} [meta]     附加信息（压缩了多少条、省了多少 token）
   * @returns {{removed:number, kept:number}|null} 没压缩就返回 null
   */
  compactHistory(keepRecent, summary, meta = {}) {
    const head = this.messages[0] && this.messages[0].role === 'system' ? [this.messages[0]] : [];
    const rest = this.messages.slice(head.length);
    const keep = Math.max(2, Math.floor(keepRecent));
    if (rest.length <= keep + 2) return null; // 太短，压了反而亏

    let tail = rest.slice(-keep);
    // 切割点不能落在 tool 消息上：它的 assistant(tool_calls) 被切掉会变成孤儿（400）
    let guard = 0;
    while (tail.length && tail[0].role === 'tool' && guard < tail.length) {
      tail = tail.slice(1);
      guard += 1;
    }
    // 也不能让 tail 以 assistant(tool_calls) 结尾而没有对应的 tool 结果
    while (tail.length) {
      const last = tail[tail.length - 1];
      if (last.role === 'assistant' && last.tool_calls && last.tool_calls.length) {
        // 只有确实缺 tool 结果时才回退
        const nextIndex = rest.indexOf(last) + 1;
        const next = rest[nextIndex];
        if (!next || next.role !== 'tool') {
          tail = tail.slice(0, -1);
          continue;
        }
      }
      break;
    }
    if (!tail.length) return null;

    const dropped = rest.length - tail.length;
    if (dropped <= 0) return null;

    const note = {
      role: 'user',
      content:
        `[上下文压缩] 以下是对更早对话的摘要（已省略 ${dropped} 条原始消息${meta.savedTokens ? `，约省下 ${meta.savedTokens} token` : ''}）。` +
        `需要细节时用工具重新查看文件或代码，不要凭记忆猜测。\n\n${String(summary || '').trim()}`,
      _ts: Date.now(),
      _compacted: { removed: dropped, at: Date.now(), ...meta },
    };

    this.messages = [...head, note, ...tail];
    this.context.compacted = (this.context.compacted || 0) + dropped;
    this.dirty = true;
    return { removed: dropped, kept: tail.length };
  }

  /** 只要最后一条 assistant 的可见文本 */
  lastAssistantText() {
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      if (this.messages[i].role === 'assistant' && this.messages[i].content) return this.messages[i].content;
    }
    return '';
  }

  /** 统计一轮对话的可见消息数（不含 system/tool） */
  countTurns() {
    return this.messages.filter((m) => m.role === 'user').length;
  }

  /* ---------------- 用量 ---------------- */

  recordUsage(usage) {
    if (!usage) return;
    this.usage.promptTokens += usage.prompt_tokens || 0;
    this.usage.completionTokens += usage.completion_tokens || 0;
    // 有些网关只回 prompt/completion、不回 total：不兜底的话「累计 token」
    // 会一直是 0，而输入输出明明都有数——看起来就像统计坏了
    this.usage.totalTokens +=
      usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
    this.usage.calls += 1;
    this.dirty = true;
  }

  /* ---------------- 持久化 ---------------- */

  save() {
    if (!this.cfg.session.save) return false;
    try {
      ensureDir(this.cfg.session.dir);
      this.updatedAt = new Date().toISOString();
      writeTextFile(
        this.filePath,
        JSON.stringify(
          {
            id: this.id,
            title: this.title,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            cwd: this.cwd,
            /**
             * 归档：会话不删，但从主列表里收起来（侧栏归到「已归档」）。
             * 单独一个字段而不是假借别的字段：归档是用户意图，要能存、能还原、能分组。
             */
            archived: this.archived === true,
            model: this.cfg.model,
            provider: this.cfg.provider,
            usage: this.usage,
            context: this.context,
            messages: this.messages,
          },
          null,
          2,
        ),
      );
      this.dirty = false;
      return true;
    } catch (err) {
      // 存盘失败不能影响对话本身
      return false;
    }
  }

  /** 从文件恢复会话 */
  static load(cfg, id) {
    const file = path.join(cfg.session.dir, `${id}.json`);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const s = new Session(cfg, { id: data.id, title: data.title, cwd: data.cwd, archived: data.archived === true });
      s.createdAt = data.createdAt || s.createdAt;
      s.updatedAt = data.updatedAt || s.updatedAt;
      s.messages = Array.isArray(data.messages) ? data.messages : [];
      s.usage = data.usage || s.usage;
      s.context = { ...s.context, ...(data.context || {}) };
      // 模型可能已经换了，窗口大小按当前配置重算
      const info = resolveContextWindowInfo(cfg);
      s.context.window = info.window;
      s.context.windowSource = info.source;
      return s;
    } catch {
      return null;
    }
  }

  /** 列出历史会话（按更新时间倒序） */
  static list(cfg, limit = 20) {
    const dir = cfg.session.dir;
    if (!fs.existsSync(dir)) return [];
    const items = [];
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(dir, file);
      try {
        const stat = fs.statSync(full);
        // 只读头部元信息（见 readSessionHead），不把整个消息历史搬进内存：
        // 会话文件单个可能上 MB，列表一次最多 200 个，全量读会很卡
        const head = readSessionHead(full, stat.size);
        if (!head) continue;
        const data = head.data;
        items.push({
          id: data.id || file.replace(/\.json$/, ''),
          title: data.title || '(无标题)',
          updatedAt: data.updatedAt || stat.mtime.toISOString(),
          // 大文件只读了头部，消息数拿不到就记 0（仅展示用，不影响功能）
          messageCount: head.partial ? 0 : (data.messages || []).length,
          size: stat.size,
          // 下面几项是给界面用的：会话列表要显示「这个会话在哪个目录里干活」，
          // 用量条也要能在恢复之前就显示出大概规模
          cwd: data.cwd || '',
          createdAt: data.createdAt || '',
          /** 归档标记：侧栏据此把它归到「已归档」组（不删，只是收起来） */
          archived: data.archived === true,
          model: data.model || '',
          provider: data.provider || '',
          usage: data.usage || null,
          context: data.context || null,
        });
      } catch {
        /* 损坏的会话文件直接跳过 */
      }
    }
    items.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return items.slice(0, limit);
  }

  /** 删掉磁盘上的会话文件；返回是否真的删掉了 */
  static removeFile(cfg, id) {
    try {
      const file = path.join(cfg.session.dir, `${id}.json`);
      if (!fs.existsSync(file)) return false;
      fs.unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }

  /** 转成 Markdown 记录，方便导出阅读 */
  toMarkdown() {
    const lines = [`# 会话 ${this.id}`, '', `- 标题：${this.title || '(无)'}`, `- 创建：${this.createdAt}`, `- 模型：${this.cfg.provider}/${this.cfg.model}`, ''];
    for (const msg of this.messages) {
      if (msg.role === 'system') continue;
      if (msg.role === 'user') lines.push('## 用户', '', String(msg.content), '');
      else if (msg.role === 'assistant') {
        if (msg.content) lines.push('## 助手', '', String(msg.content), '');
        for (const tc of msg.tool_calls || []) {
          lines.push(`> 调用工具 \`${tc.function.name}\`：\`${truncate(tc.function.arguments, 300)}\``, '');
        }
      } else if (msg.role === 'tool') {
        lines.push(`<details><summary>工具结果 ${msg.name}</summary>`, '', '```', truncate(String(msg.content), 2000), '```', '', '</details>', '');
      }
    }
    return lines.join('\n');
  }
}

module.exports = {
  Session,
  buildSystemPrompt,
  builtinSystemPrompt,
  estimateTokens,
  estimateMessagesTokens,
  resolveContextWindow,
  resolveContextWindowInfo,
  CONTEXT_WINDOWS,
};
