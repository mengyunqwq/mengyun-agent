'use strict';

/**
 * Google Gemini 协议（generateContent，v1beta）
 *
 * 适用：Gemini 官方、以及只提供 Gemini 原生格式的中转站。
 *
 * ── 和 OpenAI 协议的差异 ────────────────────────────────────────
 *   地址      /v1beta/models/{model}:generateContent（模型名在 URL 里）
 *   鉴权      x-goog-api-key（也有网关用 ?key= 查询参数）
 *   角色      assistant → model，system 走 systemInstruction
 *   工具      裸 functionDeclarations 数组，不是 {type:'function',function:{...}}
 *   工具结果  user 消息里的 functionResponse 部分
 *   流式      同样是 SSE，但载荷是 candidates[].content.parts[].text
 *   思考      parts 里的 thought:true 标记（Gemini 2.5 的思维链）
 */

const { BaseProvider } = require('./base');

class GeminiProvider extends BaseProvider {
  constructor(cfg) {
    super(cfg);
    this.formatName = 'gemini';
    this.formatLabel = 'Google Gemini';
    this.maxTokens = Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : 8192;
  }

  /**
   * 模型名要拼进 URL，所以这里不能只交给 endpoint() 的默认实现。
   *
   * 关键差异：Gemini 的流式**不是**加一个 stream 字段，而是换端点——
   *   :generateContent        一次返回
   *   :streamGenerateContent  流式返回
   * 只发 stream:true 而打错端点的话，会拿到一份普通 JSON，
   * 解析器读不到任何 SSE 事件，最终报成「流式响应为空」，很难查。
   */
  defaultEndpoint(stream = false) {
    const action = stream ? 'streamGenerateContent' : 'generateContent';
    if (new RegExp(`:${action}`).test(this.baseUrl)) return this.baseUrl;
    // 地址里带了另一种 action 时，替换掉而不是往后面接
    const stripped = this.baseUrl.replace(/:(stream)?generateContent.*$/, '');
    const base = /\/v1beta$|\/v1$/.test(stripped) ? stripped : `${stripped}/v1beta`;
    // alt=sse 是 Gemini 要求流式返回 SSE 的开关，不带的话会拿到一整段 JSON 数组
    return `${base}/models/${encodeURIComponent(this.model || '')}:${action}${stream ? '?alt=sse' : ''}`;
  }

  /**
   * 模型列表：Gemini 用 GET /v1beta/models（不带模型名，也不带 action）。
   * 注意它返回的是 `{ models: [{ name: 'models/gemini-2.0-flash' }] }`，
   * name 前缀由基类的 parseModels 去掉。
   */
  modelsEndpoint() {
    const stripped = this.baseUrl
      .replace(/\/models\/[^/]*:.*$/, '')
      .replace(/:(stream)?generateContent.*$/, '')
      .replace(/\/models\/[^/]+$/, '');
    const base = /\/v1beta$|\/v1$/.test(stripped) ? stripped : `${stripped}/v1beta`;
    return `${base}/models`;
  }

  buildHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'User-Agent': 'mengyun-agent/0.1',
    };
    // Gemini 用 x-goog-api-key；部分网关仍认 Bearer，两个都带上更省事
    if (this.apiKey) {
      headers['x-goog-api-key'] = this.apiKey;
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (this.cfg.extraHeaders && typeof this.cfg.extraHeaders === 'object') {
      Object.assign(headers, this.cfg.extraHeaders);
    }
    return headers;
  }

  buildBody(req, stream = false) {
    const { systemInstruction, contents } = toGeminiContents(req.messages);
    const body = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    // 流式的开关其实在 URL 上（:streamGenerateContent），这里带上 stream
    // 只是为了让日志和诊断工具能一眼看出这是流式请求
    if (stream) body.stream = true;
    const gen = {};
    const temp = Number(this.cfg.temperature);
    if (Number.isFinite(temp) && this.cfg.temperature !== null) gen.temperature = temp;
    gen.maxOutputTokens = this.maxTokens;
    // 推理等级：官方字段 generationConfig.thinkingConfig.thinkingBudget
    require('../reasoning').applyGeminiThinking(gen, this.cfg);
    if (Object.keys(gen).length) body.generationConfig = gen;
    if (req.tools && req.tools.length) {
      body.tools = [{ functionDeclarations: toGeminiTools(req.tools) }];
    }
    return { ...body, ...(req.extraBody || {}) };
  }

  parseResponse(json) {
    const candidate = (json.candidates || [])[0] || {};
    const parts = (candidate.content && candidate.content.parts) || [];
    const parsed = readParts(parts);
    return {
      text: parsed.text,
      reasoning: parsed.reasoning,
      toolCalls: parsed.toolCalls,
      usage: toOpenAIUsage(json.usageMetadata),
      // 有工具调用时，即使 finishReason 是 STOP 也按 tool_calls 上报：
      // agent 主循环靠这个决定「继续跑工具」还是「收工」，
      // 报错了会导致模型明明要调工具却被当成最终答复
      finishReason: parsed.toolCalls.length ? 'tool_calls' : mapFinishReason(candidate.finishReason),
      raw: json,
    };
  }

  createStreamState(req) {
    let text = '';
    let thought = '';
    const toolCalls = [];
    let finishReason = 'stop';
    let usage = null;
    let sawAnyEvent = false;

    const state = {
      push(data) {
        if (data === '[DONE]') return;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          return;
        }
        sawAnyEvent = true;
        if (json.usageMetadata) usage = toOpenAIUsage(json.usageMetadata);
        const candidate = (json.candidates || [])[0];
        if (!candidate) return;
        if (candidate.finishReason) finishReason = mapFinishReason(candidate.finishReason);

        const parts = (candidate.content && candidate.content.parts) || [];
        for (const part of parts) {
          if (!part || typeof part !== 'object') continue;
          // 思维链：Gemini 2.5 用 thought:true 标记
          if (part.thought && part.text) {
            thought += part.text;
            if (typeof req.onReasoning === 'function') req.onReasoning(part.text, thought);
            continue;
          }
          if (typeof part.text === 'string' && part.text) {
            text += part.text;
            if (typeof req.onDelta === 'function') req.onDelta(part.text, text);
          }
          if (part.functionCall) {
            const call = functionCallToToolCall(part.functionCall, toolCalls.length);
            toolCalls.push(call);
            if (typeof req.onToolCall === 'function') req.onToolCall(call);
          }
        }
      },

      finish() {
        if (!sawAnyEvent && !text && !thought && toolCalls.length === 0) {
          throw new Error('流式响应为空（Gemini 格式）：确认接口地址指向 /v1beta，且模型名正确');
        }
        return {
          text,
          reasoning: thought,
          toolCalls,
          usage,
          // 同 parseResponse：有工具调用就必须报 tool_calls
          finishReason: toolCalls.length ? 'tool_calls' : finishReason,
          raw: null,
        };
      },
    };

    return state;
  }
}

/* ------------------------------------------------------------------ */
/* 协议翻译                                                            */
/* ------------------------------------------------------------------ */

/** OpenAI messages → Gemini { systemInstruction, contents } */
function toGeminiContents(messages) {
  const systemParts = [];
  const contents = [];

  const lastOf = (role) => {
    const last = contents[contents.length - 1];
    return last && last.role === role ? last : null;
  };

  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg) continue;

    if (msg.role === 'system') {
      const t = textOf(msg.content);
      if (t) systemParts.push({ text: t });
      continue;
    }

    if (msg.role === 'tool') {
      // 工具结果：user 角色里的 functionResponse
      const part = {
        functionResponse: {
          name: msg.name || 'tool',
          response: { content: textOf(msg.content) },
        },
      };
      const last = lastOf('user');
      if (last) last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
      continue;
    }

    if (msg.role === 'assistant') {
      const parts = [];
      const t = textOf(msg.content);
      if (t) parts.push({ text: t });
      for (const tc of msg.tool_calls || []) {
        const fn = tc.function || {};
        let args = {};
        try {
          args = JSON.parse(fn.arguments || '{}');
        } catch {
          args = { __parseError: true, __raw: fn.arguments };
        }
        parts.push({ functionCall: { name: fn.name, args } });
      }
      if (!parts.length) continue;
      const last = lastOf('model');
      if (last) last.parts.push(...parts);
      else contents.push({ role: 'model', parts });
      continue;
    }

    // user
    const t = textOf(msg.content);
    if (!t) continue;
    const last = lastOf('user');
    if (last) last.parts.push({ text: t });
    else contents.push({ role: 'user', parts: [{ text: t }] });
  }

  return {
    systemInstruction: systemParts.length ? { parts: systemParts } : null,
    contents,
  };
}

/** 读一批 parts，拼成统一结构 */
function readParts(parts) {
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    if (part.thought && part.text) {
      reasoning += part.text;
      continue;
    }
    if (typeof part.text === 'string' && part.text) text += part.text;
    if (part.functionCall) toolCalls.push(functionCallToToolCall(part.functionCall, toolCalls.length));
  }
  return { text, reasoning, toolCalls };
}

/** Gemini 的 functionCall 没有 id，我们自己造一个稳定的 */
function functionCallToToolCall(fc, index) {
  const args = fc.args && typeof fc.args === 'object' ? fc.args : {};
  return {
    id: fc.id || `call_${Date.now()}_${index}`,
    name: fc.name,
    args,
    rawArgs: JSON.stringify(args),
    index,
  };
}

/** OpenAI 工具定义 → Gemini functionDeclarations */
function toGeminiTools(tools) {
  return (tools || [])
    .map((t) => {
      const fn = t.function || t;
      if (!fn || !fn.name) return null;
      const decl = { name: fn.name, description: fn.description || '' };
      const params = fn.parameters || { type: 'object', properties: {} };
      // Gemini 不接受 JSON Schema 里的 additionalProperties
      decl.parameters = stripUnsupported(params);
      return decl;
    })
    .filter(Boolean);
}

/** 递归删掉 Gemini 不认的 schema 关键字（不删会被 400 拒掉） */
function stripUnsupported(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(stripUnsupported);
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' || key === '$schema' || key === 'default' || key === 'examples') continue;
    out[key] = stripUnsupported(value);
  }
  return out;
}

function textOf(content) {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        return part.text || part.content || '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
}

/** usageMetadata → OpenAI usage */
function toOpenAIUsage(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const input = meta.promptTokenCount || meta.input_tokens || 0;
  const output = meta.candidatesTokenCount || meta.output_tokens || 0;
  const total = meta.totalTokenCount || input + output;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: total };
}

function mapFinishReason(reason) {
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'content_filter';
    default:
      return 'stop';
  }
}

module.exports = {
  GeminiProvider,
  toGeminiContents,
  toGeminiTools,
  stripUnsupported,
  toOpenAIUsage,
  mapFinishReason,
};
