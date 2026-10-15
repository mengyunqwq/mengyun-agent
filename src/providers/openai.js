'use strict';

/**
 * OpenAI 兼容协议（/chat/completions）
 *
 * 适用：OpenAI 官方、DeepSeek、Ollama、以及绝大多数第三方「中转站」。
 * 它们都实现同一套 messages / tools / SSE 格式，所以这一个适配器能覆盖一大片。
 */

const { BaseProvider, ProviderError, SseParser } = require('./base');

class OpenAICompatProvider extends BaseProvider {
  constructor(cfg) {
    super(cfg);
    this.formatName = 'openai';
    this.formatLabel = 'OpenAI 兼容';
  }

  defaultEndpoint() {
    // 允许用户直接把完整地址写进 baseUrl（有些人就是这么配的）
    if (/\/chat\/completions$/.test(this.baseUrl)) return this.baseUrl;
    return `${this.baseUrl}/chat/completions`;
  }

  buildBody(req, stream) {
    const body = {
      model: req.model || this.model,
      messages: req.messages,
      stream,
    };
    // temperature 有些推理模型不接受，配置里给 null 就不发
    if (this.cfg.temperature !== null && this.cfg.temperature !== undefined) {
      body.temperature = this.cfg.temperature;
    }
    // 推理等级：官方字段 reasoning_effort（minimal/low/medium/high）。
    // 默认（auto）一个字段都不发，行为和以前完全一样
    require('../reasoning').applyOpenAI(body, this.cfg);
    if (req.tools && req.tools.length) {
      body.tools = req.tools;
      body.tool_choice = req.toolChoice || 'auto';
    }
    if (stream) {
      // 让服务商在最后一帧带上 usage，方便统计 token
      body.stream_options = { include_usage: true };
    }
    return { ...body, ...(req.extraBody || {}) };
  }

  parseResponse(json) {
    const choice = (json.choices || [])[0] || {};
    const message = choice.message || {};
    return {
      text: message.content || '',
      reasoning: extractReasoning(message),
      toolCalls: normalizeToolCalls(message.tool_calls),
      usage: json.usage || null,
      finishReason: choice.finish_reason || 'stop',
      raw: json,
    };
  }

  /**
   * 流式状态机。
   * 这里的两个坑：工具参数是分片到达的（要按 index 拼），
   * 以及 usage 常常在最后一帧才出现。
   */
  createStreamState(req) {
    let text = '';
    let thought = '';
    let finishReason = 'stop';
    let usage = null;
    let sawAnyEvent = false;
    /** @type {Map<number, {id:string,name:string,args:string}>} */
    const partial = new Map();

    const state = {
      push(data) {
        if (data === '[DONE]') return;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          return; // 心跳或非 JSON 载荷，忽略
        }
        if (json.usage) usage = json.usage;
        const choice = (json.choices || [])[0];
        if (!choice) return;
        sawAnyEvent = true;
        if (choice.finish_reason) finishReason = choice.finish_reason;

        const delta = choice.delta || choice.message || {};

        // 思考增量。字段名各家不统一，都认（见 extractReasoning）
        const piece = extractReasoning(delta);
        if (piece) {
          thought += piece;
          if (typeof req.onReasoning === 'function') req.onReasoning(piece, thought);
        }

        const content = typeof delta.content === 'string' ? delta.content : '';
        if (content) {
          text += content;
          if (typeof req.onDelta === 'function') req.onDelta(content, text);
        }

        // 工具调用增量：按 index 拼接 arguments（这是流式工具调用的关键）
        for (const tc of delta.tool_calls || []) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          if (!partial.has(idx)) partial.set(idx, { id: '', name: '', args: '' });
          const slot = partial.get(idx);
          if (tc.id) slot.id = tc.id;
          const fn = tc.function || {};
          if (fn.name) slot.name = fn.name;
          if (fn.arguments) slot.args += fn.arguments;
        }
      },

      finish() {
        if (!sawAnyEvent && !text && !thought && partial.size === 0) {
          throw new ProviderError('流式响应为空，可能是接口地址不对或该模型不支持流式输出（可试 MYA_STREAM=0）');
        }

        const toolCalls = [...partial.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([index, slot], i) => ({
            id: slot.id || `call_${Date.now()}_${i}`,
            name: slot.name,
            args: parseArgs(slot.args),
            rawArgs: slot.args,
            index,
          }))
          .filter((t) => t.name);

        if (typeof req.onToolCall === 'function') {
          for (const tc of toolCalls) req.onToolCall(tc);
        }

        return { text, reasoning: thought, toolCalls, usage, finishReason, raw: null };
      },
    };

    return state;
  }
}

/* ------------------------------------------------------------------ */
/* 辅助函数                                                            */
/* ------------------------------------------------------------------ */

/** 各家放思考内容的字段名不一样，这里统一取出来 */
const REASONING_FIELDS = ['reasoning_content', 'reasoning', 'thinking', 'thought'];

/**
 * 从 message / delta 里取出思考内容。
 * 返回 '' 表示这一帧没有思考内容（不是「思考为空」）。
 */
function extractReasoning(source) {
  if (!source || typeof source !== 'object') return '';
  for (const field of REASONING_FIELDS) {
    const value = source[field];
    if (typeof value === 'string' && value) return value;
    // 个别网关把思考包成 { content: '...' }，能取就取
    if (value && typeof value === 'object') {
      if (typeof value.content === 'string' && value.content) return value.content;
      if (typeof value.text === 'string' && value.text) return value.text;
    }
  }
  return '';
}

/** 解析工具参数 JSON；模型偶尔会给出坏 JSON，尽量救回来 */
function parseArgs(rawArgs) {
  if (rawArgs === undefined || rawArgs === null || rawArgs === '') return {};
  if (typeof rawArgs === 'object') return rawArgs;
  const text = String(rawArgs).trim();
  try {
    return JSON.parse(text);
  } catch {
    /* 继续尝试修复 */
  }
  // 常见情况：被 markdown 代码块包起来了
  const fenced = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(fenced);
  } catch {
    /* 继续 */
  }
  return { __parseError: true, __raw: text };
}

function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((tc, i) => ({
    id: tc.id || `call_${Date.now()}_${i}`,
    name: tc.function ? tc.function.name : tc.name,
    args: parseArgs(tc.function ? tc.function.arguments : tc.arguments),
    rawArgs: tc.function ? tc.function.arguments : tc.arguments,
    index: i,
  }));
}

module.exports = {
  OpenAICompatProvider,
  extractReasoning,
  parseArgs,
  normalizeToolCalls,
  REASONING_FIELDS,
  SseParser,
};
