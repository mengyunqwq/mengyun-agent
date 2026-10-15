'use strict';

/**
 * 梦云 Agent —— 模型服务商基类
 *
 * 内部一律使用 OpenAI 的 messages / tools 协议。各家原生协议（Anthropic
 * Messages、Gemini generateContent）由子类在「组装请求」和「解析响应」
 * 两处做翻译，网络层、重试、超时、SSE 读取这些共性留在这里。
 *
 * ── 子类要实现什么 ─────────────────────────────────────────────
 *   formatName            格式名（openai / anthropic / gemini）
 *   defaultEndpoint()     请求地址
 *   buildHeaders()        请求头（鉴权方式各家不同）
 *   buildBody(req,stream) 请求体
 *   parseResponse(json)   非流式响应 → 统一结构
 *   createStreamState(req)流式解析状态机（见下）
 *
 * ── 流式状态机约定 ─────────────────────────────────────────────
 * 各家 SSE 的载荷结构完全不同，与其在基类里写一堆 if，不如让子类提供一个
 * 状态机：基类负责读流和切分 SSE 事件，把每个 data 载荷丢给 state.push()。
 * 状态机自己拼增量、并调用 req 上的回调（onDelta / onReasoning / onToolCall）。
 *
 * ── 统一返回结构 ───────────────────────────────────────────────
 *   { text, reasoning, toolCalls[], usage, finishReason, raw }
 *
 * 不管上游是哪种协议，agent 只认这个结构——这就是「换协议不用改内核」的原因。
 */

const { sleep } = require('../utils');
const { extractContextWindow } = require('../model-info');

/** 所有协议都要抛的错误类型，带 status 方便上层判断 */
class ProviderError extends Error {
  constructor(message, { status = 0, retryable = false, body = '', kind = 'ok' } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
    /**
     * 错误的真实类别：model（模型名）/ auth（鉴权）/ quota（额度）/ endpoint（地址）。
     * 界面据此给不同的修复建议——404 既可能是地址错也可能是模型名错，
     * 笼统地让用户「换个协议试试」会把人带偏。
     */
    this.kind = kind;
  }
}

/**
 * 极简 SSE 解析器：喂字符串进去，吐出一个个 data 载荷。
 * 独立成类是为了能增量解析——流式输出必须边收边解析。
 */
class SseParser {
  constructor() {
    this.buffer = '';
    /** 当前事件里已经收到的 data 行（SSE 规范：同一事件可以有多条 data 行，用 \n 拼接） */
    this.pending = [];
  }

  /**
   * @returns {string[]} 本次新增的完整事件 data 载荷
   *
   * 严格按 SSE 规范的事件边界（空行）交付，而不是按 data 行：
   * 一个事件里的多条 data 行要拼成一个载荷（用 \n 连接）。
   * 按行各发各的，遇到双 data 行网关时两个半截 JSON 都解析失败，整段内容被静默丢掉。
   * 注释行（含 keep-alive 的 `:` 行）不终止事件，直接忽略。
   */
  push(chunk) {
    this.buffer += chunk;
    const payloads = [];
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.startsWith(':')) continue; // 注释行，不影响事件
      if (!line) {
        // 空行 = 事件结束
        if (this.pending.length) {
          payloads.push(this.pending.join('\n'));
          this.pending = [];
        }
        continue;
      }
      if (line.startsWith('data:')) {
        // 规范：冒号后最多去掉一个前导空格
        let data = line.slice(5);
        if (data.startsWith(' ')) data = data.slice(1);
        this.pending.push(data);
        continue;
      }
      // event: / id: / retry: 等字段不影响 data，忽略
    }
    return payloads;
  }

  /** 流结束：没等到终止空行的事件（哪怕半行还卡在 buffer 里）也交出去 */
  finish() {
    const payloads = [];
    if (this.buffer) {
      // 把没以换行结尾的残留当成一行处理完
      let line = this.buffer;
      this.buffer = '';
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.startsWith('data:')) {
        let data = line.slice(5);
        if (data.startsWith(' ')) data = data.slice(1);
        this.pending.push(data);
      }
    }
    if (this.pending.length) {
      payloads.push(this.pending.join('\n'));
      this.pending = [];
    }
    return payloads;
  }
}

class BaseProvider {
  /**
   * @param {object} cfg 由 config.js 产出的配置
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.name = cfg.provider || 'openai-compat';
    this.formatName = 'base';
    /** 显式配置的格式来源：config.apiFormat，没配就是 auto */
    this.apiFormat = cfg.apiFormat || 'auto';
    this.baseUrl = String(cfg.baseUrl || '').replace(/\/+$/, '');
    this.model = cfg.model;
    this.apiKey = cfg.apiKey || '';
    this.timeoutMs = (cfg.timeoutSec || 120) * 1000;
    this.streamEnabled = cfg.stream !== false;
    if (!this.baseUrl) {
      throw new ProviderError('未配置 baseUrl，请在设置里填「接口地址」，或在 .env 里设置 MYA_BASE_URL');
    }
  }

  /* ---------------- 对外接口 ---------------- */

  /**
   * 发起一次对话。参数是 OpenAI 协议的形状，返回值统一结构。
   * @param {object} req
   * @param {Array}    req.messages
   * @param {Array}    [req.tools]
   * @param {Function} [req.onDelta]     (deltaText, fullText) => void
   * @param {Function} [req.onReasoning] (deltaThought, fullThought) => void
   * @param {Function} [req.onToolCall]  工具调用完成（流式下在结束时调用）
   * @param {AbortSignal} [req.signal]
   */
  async chat(req) {
    const useStream = req.stream !== undefined ? req.stream : this.streamEnabled;
    return useStream ? this.chatStream(req) : this.chatOnce(req);
  }

  /** 非流式 */
  async chatOnce(req) {
    const body = this.buildBody(req, false);
    const json = await this.request(body, req.signal, false);
    return this.parseResponse(json);
  }

  /** 流式：读 SSE，把每个载荷交给子类的状态机 */
  async chatStream(req) {
    const body = this.buildBody(req, true);
    const res = await this.fetchWithRetry(body, req.signal, true);

    if (!res.body) {
      // 极少数环境（老 Node / 特殊 polyfill）拿不到流，退回一次性请求
      return this.chatOnce(req);
    }

    const state = this.createStreamState(req);
    const parser = new SseParser();
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');

    const feed = (text) => {
      for (const payload of parser.push(text)) {
        try {
          state.push(payload);
        } catch (err) {
          // 流中途服务端报错（比如 Anthropic 的 error 事件）：
          // 不能吞掉，否则会变成「流式响应为空」这种看不出原因的错误
          reader.cancel().catch(() => {});
          throw err;
        }
      }
    };

    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) feed(tail);
    // 流结束时把没有等到终止空行的最后一批 data 也冲出去
    for (const payload of parser.finish()) {
      try {
        state.push(payload);
      } catch (err) {
        reader.cancel().catch(() => {});
        throw err;
      }
    }

    return state.finish();
  }

  /* ---------------- 网络请求 ---------------- */

  async request(body, signal, stream = false) {
    const res = await this.fetchWithRetry(body, signal, stream);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError(`接口返回的不是 JSON：${text.slice(0, 300)}`, {
        status: res.status,
        body: text,
      });
    }
  }

  /**
   * 带指数退避的 fetch；429 / 5xx / 网络抖动会自动重试。
   *
   * stream 要一路传下去：Gemini 的流式和非流式是两个不同的端点
   * （:streamGenerateContent 和 :generateContent），地址必须在这里就定下来。
   */
  async fetchWithRetry(body, signal, stream = false, attempt = 0) {
    const maxAttempts = 3;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), this.timeoutMs);

    // 外部取消信号同时生效
    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const res = await fetch(this.endpoint(stream), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < maxAttempts - 1) {
          clearTimeout(timer);
          await sleep(600 * 2 ** attempt);
          return this.fetchWithRetry(body, signal, stream, attempt + 1);
        }
        const explained = explainHttpError(res.status, errText, this);
        throw new ProviderError(explained.message, {
          status: res.status,
          retryable,
          body: errText,
          kind: explained.kind,
        });
      }
      return res;
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      const aborted = controller.signal.aborted;
      const retryable = !aborted && attempt < maxAttempts - 1;
      if (retryable) {
        await sleep(600 * 2 ** attempt);
        return this.fetchWithRetry(body, signal, stream, attempt + 1);
      }
      if (aborted) {
        throw new ProviderError(
          signal && signal.aborted ? '请求已被用户取消' : `请求超时（超过 ${this.timeoutMs / 1000}s）`,
        );
      }
      throw new ProviderError(`网络请求失败：${humanNetworkError(err)}（检查 baseUrl 与网络/代理）`, {
        retryable: false,
      });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  
/* ---------------- 子类接口（默认实现留给单轮协议） ---------------- */

  /**
   * 请求地址。
   * @param {boolean} stream 是否流式——Gemini 靠它决定挂哪个端点
   */
  endpoint(stream = false) {
    const explicit = this.cfg.apiEndpoint || '';
    if (explicit) return explicit;
    return this.defaultEndpoint(stream);
  }

  defaultEndpoint() {
    throw new ProviderError(`${this.formatName} 协议没有实现 defaultEndpoint()`);
  }

  /* ---------------- 模型列表 ---------------- */

  /**
   * 列出这个网关/服务商可用的模型。
   *
   * 为什么值得做：让用户手打模型名是反人类的——名字错一个字符就是 404，
   * 而服务端明明知道自己有哪些模型。拉一份列表让他点选，既不用记也不用猜。
   *
   * 注意：`/models` 不是所有网关都有（尤其自建中转站）。失败时返回
   * ok:false + 原因，让界面退回手填，而不是把设置页卡住。
   *
   * @returns {Promise<{ok:boolean, models:Array<{id:string,label?:string}>, error?:string, source?:string}>}
   */
  async listModels() {
    const endpoint = this.modelsEndpoint();
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'GET',
        headers: { ...this.buildHeaders(), Accept: 'application/json' },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 20000)),
      });
    } catch (err) {
      const cause = err.cause ? `（${err.cause.code || err.cause.message}）` : '';
      return { ok: false, models: [], error: `连不上 ${endpoint}：${err.message}${cause}` };
    }

    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const detail = String(text || '').slice(0, 200);
      return {
        ok: false,
        models: [],
        error: `这个网关不提供模型列表（HTTP ${res.status}）${detail ? `：${detail}` : ''}。手动填模型名即可。`,
      };
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, models: [], error: '模型列表返回的不是 JSON，可能不是标准接口' };
    }

    const models = this.parseModels(json);
    if (!models.length) {
      return { ok: false, models: [], error: '接口返回了，但里面没有解析出模型列表' };
    }
    return { ok: true, models, source: endpoint };
  }

  /** 默认取 baseUrl 的根再拼 /models（各家子类可覆盖） */
  modelsEndpoint() {
    if (/\/models$/.test(this.baseUrl)) return this.baseUrl;
    return `${this.baseUrl}/models`;
  }

  /**
   * 解析模型列表。各家响应形状不同，这里做宽容匹配：
   *   { data: [{ id }] }                        OpenAI / Anthropic
   *   { models: [{ name: 'models/gemini-x' }] }  Gemini
   *   { model: 'x' } 或直接的字符串数组           一些自建网关
   *
   * 认不出来时返回空数组，让上层给出「这个网关不提供模型列表」的提示——
   * 不能抛错，否则一个格式怪异的网关会让整个设置页用不了。
   */
  parseModels(json) {
    if (!json) return [];
    const list = Array.isArray(json)
      ? json
      : json.data || json.models || json.result || json.list || (json.model ? [json.model] : []);
    const out = [];
    for (const item of Array.isArray(list) ? list : []) {
      if (typeof item === 'string') {
        out.push({ id: item });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      // Gemini 的 name 形如 "models/gemini-2.0-flash"，前缀要去掉
      const raw = item.id || item.name || item.model || item.slug;
      if (!raw) continue;
      // 有些网关会附带上下文窗口（Gemini 的 inputTokenLimit、
      // OpenRouter 的 context_length…）。有就是权威值，界面的用量条直接用它，
      // 省得去猜；没有也没关系，上层会退回「按模型名推断」并标明是推断的。
      const contextWindow = extractContextWindow(item);
      out.push({
        id: String(raw).replace(/^models\//, ''),
        label: item.display_name || item.displayName || item.description || undefined,
        ...(contextWindow ? { contextWindow } : {}),
      });
    }
    // 去重 + 排序，界面看起来才整齐
    const seen = new Set();
    return out
      .filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  buildHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'User-Agent': 'mengyun-agent/0.1',
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    // 自建网关常见的自定义头（Azure 的 api-key、某些中转站要求 X-Api-Key）
    if (this.cfg.extraHeaders && typeof this.cfg.extraHeaders === 'object') {
      Object.assign(headers, this.cfg.extraHeaders);
    }
    return headers;
  }

  buildBody() {
    throw new ProviderError(`${this.formatName} 协议没有实现 buildBody()`);
  }
  parseResponse() {
    throw new ProviderError(`${this.formatName} 协议没有实现 parseResponse()`);
  }

  createStreamState() {
    throw new ProviderError(`${this.formatName} 协议没有实现 createStreamState()`);
  }
}

/**
 * 把 HTTP 错误翻译成人能看懂、能直接照做的中文提示。
 * 各家协议的状态码含义基本一致，所以放在基类共用。
 *
 * 重点是**别猜错方向**。中转站的报错文案往往已经指明了原因：
 *   「模型 "LLM" 不在分组「LLM」中。可用：a, b, c」
 * 如果一律按「404 = 地址不对」提示，用户就会去折腾地址和协议格式，
 * 而真正要改的是模型名——白折腾半天。
 * 所以这里先做一次语义识别，认出模型名/鉴权/端点/额度这四类，
 * 再决定给什么建议。
 */
function explainHttpError(status, bodyText, provider) {
  const detail = extractErrorMessage(bodyText).slice(0, 500);
  const info = classifyError(status, detail);
  return { message: buildErrorMessage(status, detail, info, provider), kind: info.kind };
}

function buildErrorMessage(status, detail, info, provider) {
  if (info.kind === 'model') {
    const list = info.models.length
      ? `\n\n这个网关可用的模型：\n${info.models.map((m) => `  · ${m}${/image|video|embedding|rerank/i.test(m) ? '（非对话模型，多半不支持工具调用）' : ''}`).join('\n')}`
      : '';
    return (
      `模型名不被接受（HTTP ${status}）：${detail}` +
      `${list}\n\n` +
      '去「设置 → 模型与 API」把「模型」改成上面列表里的一个。\n' +
      '注意：图像 / 视频 / 向量类模型通常不支持工具调用，选了它们 agent 干活会失败，优先选对话模型。' +
      `\n（当前格式=${provider.formatLabel || provider.formatName}, baseUrl=${provider.baseUrl}, model=${provider.model}）`
    );
  }

  if (info.kind === 'quota') {
    return `额度或权限问题（HTTP ${status}）：${detail}\n（当前格式=${provider.formatLabel || provider.formatName}, baseUrl=${provider.baseUrl}）`;
  }

  /**
   * 协议不匹配：网关按协议给模型分组。
   * 直接给「该做什么」，别让用户去查模型名（那是 404 类的事）。
   */
  if (info.kind === 'protocol') {
    return (
      `这个模型不支持当前用的协议（HTTP ${status}）：${detail}\n\n` +
      `原因是网关把不同模型挂在不同协议下：同一个地址上，有的模型只在\n` +
      `OpenAI chat/completions，有的只在 Responses 或 Anthropic messages。\n` +
      `去「设置 → 模型与 API」点「测试连接」换个「接口格式」再试；\n` +
      `换完还不行，就是这个网关没把这个模型挂在你能用的协议上——换模型（这类网关上同家族总有一款能用）。\n` +
      `（当前格式=${provider.formatLabel || provider.formatName}, baseUrl=${provider.baseUrl}, model=${provider.model}）`
    );
  }

  /** 源站挂了：CF 档在前面但后面的源站不可达。这是网关的服务器问题。 */
  if (info.kind === 'origin') {
    return (
      `网关源站不可达（HTTP ${status}）：${detail || 'Cloudflare 返回了错误页'}\n\n` +
      `这不是你的配置问题：Cloudflare 档正常工作，但它背后的源站挂了/解不了析。\n` +
      `先用浏览器直接打开 ${provider.baseUrl} 确认；等网关恢复，或换它的备用地址。`
    );
  }

  if (info.kind === 'auth') {
    return (
      `鉴权被拒（HTTP ${status}）：${detail}\n` +
      '检查 API Key 是否正确、是否过期。\n' +
      `提示：OpenAI 兼容用 Authorization: Bearer，Anthropic 用 x-api-key，Gemini 用 x-goog-api-key——` +
      `选错「接口格式」也会导致鉴权头不对。当前格式=${provider.formatLabel || provider.formatName}。`
    );
  }

  const hints = {
    400:
      '请求格式被拒。常见原因：模型名不存在，或该模型/网关不支持 tools（工具调用）。' +
      require('../reasoning').errorHint(),
    401: '鉴权失败。检查 API Key、以及「接口格式」是否选对了（三家的鉴权头不一样）。',
    402: '余额不足或未开通付费。',
    403: '无权限访问该模型或接口。',
    // 404 特意分成两种情况说：能走到这里说明已经拿到了服务端的业务报错，
    // 那 404 往往不是「地址不存在」，而是「地址对了但里面没有这个资源（模型）」
    404: '接口地址可能不对。baseUrl 一般应形如 https://api.deepseek.com/v1（不要带 /chat/completions）；也可能是「接口格式」选错，请求打到了不存在的端点。',
    422:
      '参数不被接受。可能是该模型不支持 temperature 或 tools，试试把 temperature 设为 null。' +
      require('../reasoning').errorHint(),
    429: '触发限流（已自动重试 3 次仍失败）。稍后再试，或换模型。',
    500: '服务端错误，稍后重试。',
    502: '网关错误，检查代理/baseUrl 是否可达。',
    503: '服务暂时不可用（模型过载）。',
    504: '网关超时。',
  };
  const hint = hints[status] || (status >= 500 ? '服务端错误（5xx）。' : '未知错误。');
  return (
    `模型接口返回 ${status}：${hint}` +
    `${detail ? `\n服务端原文：${detail}` : ''}` +
    `（当前格式=${provider.formatLabel || provider.formatName}, baseUrl=${provider.baseUrl}）`
  );
}

/**
 * 把 fetch 层的错误翻译成人话。
 *
 * 为什么要它：这一层的原始报错对用户完全不可读——
 *   · `Cannot convert argument to a ByteString … greater than 255`
 *     = **请求头里有非 ASCII 字符**。九成是「API Key 是模板占位符没替换」
 *     / 复制 Key 时带进了中文或空格（实测：.env 里躺着 sk-在这里填你的key 时就是它）。
 *     这类请求根本没出门，修法是改 Key，不是查网络。
 *   · `getaddrinfo ENOTFOUND` = 域名解析不了（地址打错/断网/DNS 污染）。
 *   · `ECONNREFUSED` = 通了但没人听（端口/服务不在）。
 * 原样丢给用户，就会像这次一样：真因是占位符 Key，用户却一直在查代理和防火墙。
 */

function humanNetworkError(err) {
const raw = String((err && err.message) || err);
if (/ByteString|greater than 255/i.test(raw)) {
  const hasChinese = /[\u4e00-\u9fff]/.test(raw);
  return (
    `请求头里带了大纲外字符（${hasChinese ? '里面有中文' : '非 ASCII 字符'}），请求没有发出去。` +
    `最常见的原因：API Key 还是从模板复制来的占位符（比如「sk-在这里填你的key」），或者复制 Key 时带进了中文/多余字符——` +
    `先去「设置 → 模型与 API」确认 Key 是真实的、只含英文数字。`
  );
}
if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return `域名解析不了${raw.includes('ENOTFOUND') ? '（多半地址打错了，或断网/DNS 有问题）' : ''}：${raw}`;
if (/ECONNREFUSED/i.test(raw)) return `地址通但端口没人听（服务不在/端口写错）：${raw}`;
if (/CERT|TLS|SSL/i.test(raw)) return `证书校验失败（本机有中间人证书时见 .env 里的 NODE_EXTRA_CA_CERTS 说明）：${raw}`;
return raw;
}

/** 从各种错误响应体里把「人话」抠出来 */
function extractErrorMessage(bodyText) {
  const raw = String(bodyText || '');
  try {
    const json = JSON.parse(raw);
    const err = json.error;
    if (err) {
      if (typeof err === 'string') return err;
      if (err.message) return String(err.message);
      if (err.type) return String(err.type);
    }
    if (json.message) return String(json.message);
    if (json.msg) return String(json.msg);
    if (json.detail) return String(json.detail);
  } catch {
    /* 不是 JSON 就用原文 */
  }
  return raw;
}

/**
 * 认出错误的真实类别。
 *
 * 为什么值得单独做：中转站的报错格式五花八门，但语义就那么几类。
 * 不识别的话只能按状态码猜，而 404 既可能是「地址错」也可能是
 * 「地址对但模型不存在」——这两种要用户做的事完全不同。
 *
 * @returns {{kind:'ok'|'model'|'auth'|'quota'|'endpoint'|'protocol'|'origin', models:string[]}}
 */
function classifyError(status, detail) {
  const text = String(detail || '');
  const lower = text.toLowerCase();
  const out = { kind: 'ok', models: [] };

  // 模型列表：先按「可用：a, b, c」这种中文写法抓
  const available = text.match(/可用(?:的)?(?:模型)?[：:]\s*([^\n]+)/);
  if (available) {
    out.models = available[1]
      .split(/[,，、|]/)
      .map((s) => s.trim())
      .filter((s) => /^[\w.\-/:]+$/.test(s));
  }
  // 再按英文常见写法补齐（available models: / supported models are ...）
  if (!out.models.length) {
    const en = text.match(/(?:available models|supported models|model list)[^:：]*[:：]?\s*([^\n]+)/i);
    if (en) {
      out.models = en[1]
        .split(/[,，、|]/)
        .map((s) => s.trim())
        .filter((s) => /^[\w.\-/:]+$/.test(s));
    }
  }

  /**
   * 协议类：网关按协议给模型分组，同一个模型不一定在每条协议下都有。
   * （实测：OpenCode Go 的 grok/gpt-luna 系列只在 Responses 下存在，
   *  用 chat/completions 调就回 ModelProtocolUnsupported。）
   *
   * 为什么必须单独认：它会被上面 400 的默认提示带去查「模型名/是否支持 tools」，
   * 而真正该做的是换「接口格式」。用户在这上面烧过真钱。
   */
  if (
    /ModelProtocolUnsupported/i.test(text) ||
    /protocol[^.\n]{0,40}not\s+support/i.test(text) ||
    /does\s+not\s+support\s+this\s+protocol/i.test(text) ||
    /(该模型|这个模型|模型)[^.\n]{0,20}不支持(这个|该)?协议/.test(text)
  ) {
    out.kind = 'protocol';
    return out;
  }

  /**
   * 源站类：Cloudflare 档在前面、但后面的源站挂了。
   * HTTP 530 是网关走 Cloudflare 时「源站不可达」的表现；正文里则是
   * Error 1016（源站 DNS 解析失败）/ Error 1033（Argo tunnel 断了）。
   * 用户会以为是自己的配置错——要说清「这是网关服务器的问题」。
   */
  if (
    status === 530 ||
    /Error\s*1?0?16|Error\s*1033|cdn-cgi|cloudflare/i.test(text) ||
    /tunnel|origin( unreachable| dns)? error/i.test(lower)
  ) {
    out.kind = 'origin';
    return out;
  }

  // 模型类：分组、不存在、无效、未找到……
  const modelPatterns = [
    /不在分组/,
    /模型[^，。;\n]{0,12}(不存在|未找到|无效|不支持|已被?禁用)/,
    /(invalid|unknown|unsupported|nonexistent|not\s+found|does\s+not\s+exist)[^.\n]{0,30}model/,
    /model[^.\n]{0,30}(not\s+found|does\s+not\s+exist|is\s+invalid|not\s+supported|unknown|unavailable)/,
    /no\s+such\s+model/,
    /模型.*(配额|限流)/,
  ];
  if (modelPatterns.some((re) => re.test(text) || re.test(lower))) {
    out.kind = 'model';
    return out;
  }

  const quotaPatterns = [/insufficient/i, /quota/i, /balance/i, /余额/, /欠费/, /exceeded your current quota/i, /计费/];
  if (quotaPatterns.some((re) => re.test(text) || re.test(lower))) {
    out.kind = 'quota';
    return out;
  }

  const authPatterns = [/invalid[_ ]api[_ ]key/i, /incorrect api key/i, /unauthorized/i, /authentication/i, /鉴权/, /密钥/, /token.*(invalid|expired)/i];
  if (authPatterns.some((re) => re.test(text) || re.test(lower))) {
    out.kind = 'auth';
    return out;
  }

  // 地址类：明确提到路径/端点/方法
  if (/no\s+route|not\s+found.*(path|endpoint|route)|cannot\s+post|method\s+not\s+allowed/i.test(lower)) {
    out.kind = 'endpoint';
    return out;
  }

  return out;
}

/** 错误是不是「模型名的问题」——界面据此给不同的修复建议 */
function isModelNameError(err) {
  if (!err) return false;
  return err.kind === 'model' || classifyError(err.status || 0, String(err.message || '')).kind === 'model';
}

module.exports = { BaseProvider, ProviderError, SseParser, explainHttpError, classifyError, isModelNameError, humanNetworkError };
