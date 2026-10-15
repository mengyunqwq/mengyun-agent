'use strict';

/**
 * Anthropic Messages 协议（/v1/messages）
 *
 * 适用：Claude 官方 API、Claude Code 类中转站、以及只提供 Anthropic 原生
 * 格式的中转站。很多中转站只有这一种格式，OpenAI 兼容只是「顺便也支持」。
 *
 * ── 和 OpenAI 协议的差异（这些坑都在下面处理了）──────────────────
 *   鉴权      x-api-key + anthropic-version（不是 Authorization: Bearer）
 *   系统提示  顶层 system 字段，不在 messages 里
 *   工具结果  user 消息里的 tool_result 块，而不是 role:"tool"
 *   工具调用  assistant 消息里的 tool_use 块，而不是 tool_calls
 *   最大输出  max_tokens 是必填项（不传直接 400）
 *   参数上限  temperature 只能 0~1
 *   流式      SSE 事件有类型（content_block_delta 等），不是统一的 choices[].delta
 */

const { BaseProvider } = require('./base');

/** Anthropic 的 temperature 上限是 1，OpenAI 习惯用 0~2，超了会被拒 */
const clampTemperature = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
};

class AnthropicProvider extends BaseProvider {
  constructor(cfg) {
    super(cfg);
    this.formatName = 'anthropic';
    this.formatLabel = 'Anthropic Messages';
    // max_tokens 必填。默认给 4096：够用又不会因为太大被网关拒
    this.maxTokens = Number(cfg.maxTokens) > 0 ? Number(cfg.maxTokens) : 4096;
    this.anthropicVersion = cfg.anthropicVersion || '2023-06-01';
  }

  defaultEndpoint() {
    if (/\/messages$/.test(this.baseUrl)) return this.baseUrl;
    return `${this.baseUrl}/messages`;
  }

  /** 模型列表：Anthropic 用 GET /v1/models，鉴权头与 /messages 相同 */
  modelsEndpoint() {
    if (/\/messages$/.test(this.baseUrl)) return this.baseUrl.replace(/\/messages$/, '/models');
    return `${this.baseUrl}/models`;
  }

  buildHeaders() {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'User-Agent': 'mengyun-agent/0.1',
      // Anthropic 用 x-api-key，不是 Bearer
      'anthropic-version': this.anthropicVersion,
    };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    if (this.cfg.extraHeaders && typeof this.cfg.extraHeaders === 'object') {
      Object.assign(headers, this.cfg.extraHeaders);
    }
    return headers;
  }

  buildBody(req, stream) {
    const { system, messages } = toAnthropicMessages(req.messages);
    const body = {
      model: req.model || this.model,
      max_tokens: this.maxTokens,
      messages,
      stream,
    };
    if (system) body.system = system;
    const temp = clampTemperature(this.cfg.temperature);
    if (temp !== undefined && this.cfg.temperature !== null) body.temperature = temp;
    // 推理等级：官方没有「等级」，只有 extended thinking 的 budget_tokens。
    // 这里会顺带把 temperature 摘掉——官方要求开 thinking 时不能自定义它
    require('../reasoning').applyAnthropicThinking(body, this.cfg, this.maxTokens);
    if (req.tools && req.tools.length) {
      body.tools = toAnthropicTools(req.tools);
      if (req.toolChoice && req.toolChoice !== 'auto') body.tool_choice = { type: 'any' };
    }
    return { ...body, ...(req.extraBody || {}) };
  }

  parseResponse(json) {
    const blocks = Array.isArray(json.content) ? json.content : [];
    let text = '';
    let reasoning = '';
    const toolCalls = [];

    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text') text += block.text || '';
      else if (block.type === 'thinking') reasoning += block.thinking || '';
      else if (block.type === 'redacted_thinking') reasoning += '[思考内容已被服务商加密]';
      else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id || `call_${Date.now()}_${toolCalls.length}`,
          name: block.name,
          args: block.input && typeof block.input === 'object' ? block.input : {},
          rawArgs: JSON.stringify(block.input || {}),
          index: toolCalls.length,
        });
      }
    }

    return {
      text,
      reasoning,
      toolCalls,
      usage: toOpenAIUsage(json.usage),
      finishReason: mapStopReason(json.stop_reason),
      raw: json,
    };
  }

  /**
   * 流式状态机。
   * Anthropic 的 SSE 是按「内容块」组织的：先 content_block_start 声明这是
   * 文本块还是工具块，然后 content_block_delta 增量，最后 content_block_stop。
   * 所以必须按 index 记住每个块是什么，否则增量会拼错地方。
   */
  createStreamState(req) {
    /** @type {Map<number, {type:string, id:string, name:string, json:string, text:string}>} */
    const blocks = new Map();
    const toolCalls = [];
    let text = '';
    let thought = '';
    let finishReason = 'stop';
    let usage = null;
    let sawAnyEvent = false;
    /** JSON 增量需要跨事件累积，否则解析不了 */
    const jsonBuffers = new Map();

    const state = {
      push(data) {
        if (data === '[DONE]') return;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          return;
        }
        // 有些网关会把事件类型放在 data.type 里（标准做法是放在 data.type）
        const type = json.type;
        if (!type) return;
        sawAnyEvent = true;

        switch (type) {
          case 'message_start': {
            const u = json.message && json.message.usage;
            if (u) usage = toOpenAIUsage(u);
            break;
          }
          case 'content_block_start': {
            const index = json.index || 0;
            const block = json.content_block || {};
            blocks.set(index, {
              type: block.type || 'text',
              id: block.id || '',
              name: block.name || '',
              text: '',
            });
            if (block.type === 'tool_use') {
              jsonBuffers.set(index, typeof block.input === 'string' ? block.input : '');
              if (block.input && typeof block.input === 'object' && Object.keys(block.input).length) {
                jsonBuffers.set(index, JSON.stringify(block.input));
              }
            }
            break;
          }
          case 'content_block_delta': {
            const index = json.index || 0;
            const delta = json.delta || {};
            if (delta.type === 'text_delta' && delta.text) {
              text += delta.text;
              if (typeof req.onDelta === 'function') req.onDelta(delta.text, text);
            } else if (delta.type === 'thinking_delta' && delta.thinking) {
              thought += delta.thinking;
              if (typeof req.onReasoning === 'function') req.onReasoning(delta.thinking, thought);
            } else if (delta.type === 'input_json_delta' || delta.type === 'tool_use_delta') {
              // 工具参数是 JSON 字符串增量，先攒着，块结束时再解析
              jsonBuffers.set(index, (jsonBuffers.get(index) || '') + (delta.partial_json || delta.text || ''));
            }
            break;
          }
          case 'content_block_stop': {
            const index = json.index || 0;
            const block = blocks.get(index);
            if (block && block.type === 'tool_use') {
              const raw = jsonBuffers.get(index) || '{}';
              let args = {};
              try {
                args = JSON.parse(raw || '{}');
              } catch {
                args = { __parseError: true, __raw: raw };
              }
              const call = {
                id: block.id || `call_${Date.now()}_${toolCalls.length}`,
                name: block.name,
                args,
                rawArgs: raw,
                index: toolCalls.length,
              };
              toolCalls.push(call);
              if (typeof req.onToolCall === 'function') req.onToolCall(call);
            }
            break;
          }
          case 'message_delta': {
            if (json.delta && json.delta.stop_reason) finishReason = mapStopReason(json.delta.stop_reason);
            if (json.usage) {
              // message_delta 里的 usage 只有 output_tokens，要和开头那份合并
              usage = { ...(usage || {}), ...toOpenAIUsage(json.usage) };
            }
            break;
          }
          case 'error': {
            const err = json.error || {};
            throw new Error(err.message || 'Anthropic 流式返回了错误事件');
          }
          default:
            break;
        }
      },

      finish() {
        if (!sawAnyEvent && !text && !thought && toolCalls.length === 0) {
          throw new Error('流式响应为空（Anthropic 格式）：检查接口地址是否指向 /v1，以及模型名是否存在');
        }
        return {
          text,
          reasoning: thought,
          toolCalls: toolCalls.filter((t) => t.name),
          usage,
          finishReason,
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

/**
 * OpenAI messages → Anthropic { system, messages }
 *
 * 三处必须翻译对：
 *   1. system 消息被抽出来放顶层（Anthropic 不接受 messages 里有 system）
 *   2. role:"tool" 变成 user 消息里的 tool_result 块
 *   3. assistant.tool_calls 变成 tool_use 块
 * 另外相邻的同角色消息要合并——Anthropic 要求 user/assistant 严格交替。
 */
function toAnthropicMessages(messages) {
  const systemParts = [];
  const out = [];

  /**
   * 追加一条消息。
   * 内容一律存成「块数组」而不是裸字符串：Anthropic 两种都接受，
   * 但混用会让相邻消息合并时类型对不上（字符串 + 数组拼不起来），
   * 而 Anthropic 要求 user/assistant 严格交替，合并是必须的。
   */
  const push = (role, blocks) => {
    const list = Array.isArray(blocks) ? blocks : [{ type: 'text', text: String(blocks) }];
    if (!list.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push(...list);
      return;
    }
    out.push({ role, content: list });
  };

  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg) continue;

    if (msg.role === 'system') {
      if (msg.content) systemParts.push(typeof msg.content === 'string' ? msg.content : textOf(msg.content));
      continue;
    }

    if (msg.role === 'tool') {
      // 工具结果在 Anthropic 里是 user 消息里的 tool_result 块
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === 'string' ? msg.content : textOf(msg.content),
        },
      ]);
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks = [];
      if (msg.content) {
        const t = typeof msg.content === 'string' ? msg.content : textOf(msg.content);
        if (t) blocks.push({ type: 'text', text: t });
      }
      for (const tc of msg.tool_calls || []) {
        const fn = tc.function || {};
        let input = {};
        try {
          input = JSON.parse(fn.arguments || '{}');
        } catch {
          input = { __parseError: true, __raw: fn.arguments };
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: fn.name, input });
      }
      if (!blocks.length) continue; // 空 assistant 消息会被拒
      push('assistant', blocks);
      continue;
    }

    // user
    const t = typeof msg.content === 'string' ? msg.content : textOf(msg.content);
    if (t) push('user', [{ type: 'text', text: t }]);
  }

  // 第一条必须是 user：Anthropic 不接受以 assistant 开头
  while (out.length && out[0].role !== 'user') out.shift();

  return { system: systemParts.join('\n\n'), messages: out };
}

/** 把可能是数组的 content 拍平成文本 */
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

/** OpenAI 工具定义 → Anthropic 工具定义 */
function toAnthropicTools(tools) {
  return (tools || [])
    .map((t) => {
      const fn = t.function || t;
      if (!fn || !fn.name) return null;
      return {
        name: fn.name,
        description: fn.description || '',
        input_schema: fn.parameters || { type: 'object', properties: {} },
      };
    })
    .filter(Boolean);
}

/** Anthropic usage → OpenAI usage（好让上层的用量统计不用改） */
function toOpenAIUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = usage.input_tokens || usage.prompt_tokens || 0;
  const output = usage.output_tokens || usage.completion_tokens || 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
  };
}

/** stop_reason → finish_reason */
function mapStopReason(reason) {
  switch (reason) {
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
      return 'length';
    case 'stop_sequence':
    case 'end_turn':
    case undefined:
    case null:
      return 'stop';
    default:
      return reason === 'refusal' ? 'content_filter' : 'stop';
  }
}

module.exports = {
  AnthropicProvider,
  toAnthropicMessages,
  toAnthropicTools,
  toOpenAIUsage,
  mapStopReason,
  clampTemperature,
};
