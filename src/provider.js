'use strict';

/**
 * 梦云 Agent —— 模型服务商（Provider）层
 *
 * 内部一律使用 OpenAI 的 messages / tools 协议；各家原生协议在这里被翻译。
 * 想接新协议，就在 src/providers/ 下照现有的样子加一个类，然后在下面的
 * createProvider 里注册——**不需要改 agent 内核**。
 *
 * ── 为什么做成可选的而不是写死一种 ──────────────────────────────
 * 中转站（第三方 API 代理）提供的格式各不相同：有的只给 OpenAI 兼容，
 * 有的只给 Anthropic 原生，有的只给 Gemini 原生。写死一种就意味着
 * 「用户拿到的是哪种，就得看运气」。所以让用户选，选错还能自动识别。
 *
 * 当前支持：
 *   openai     /chat/completions      OpenAI、DeepSeek、Ollama、多数中转站
 *   anthropic  /v1/messages           Claude 官方、Claude 类中转站
 *   gemini     generateContent        Gemini 官方、Gemini 类中转站
 */

const { BaseProvider, ProviderError, SseParser, explainHttpError } = require('./providers/base');
const { OpenAICompatProvider, extractReasoning, parseArgs, normalizeToolCalls } = require('./providers/openai');
const { AnthropicProvider, toAnthropicMessages, toAnthropicTools } = require('./providers/anthropic');
const { GeminiProvider, toGeminiContents, toGeminiTools } = require('./providers/gemini');

/** 界面和文档都用这一份清单，避免两处写不一样 */
const API_FORMATS = [
  {
    key: 'openai',
    label: 'OpenAI 兼容',
    hint: '/chat/completions —— DeepSeek、OpenAI、Ollama，以及绝大多数中转站',
  },
  {
    key: 'anthropic',
    label: 'Anthropic Messages',
    hint: '/v1/messages —— Claude 官方，以及只提供 Anthropic 原生格式的中转站',
  },
  {
    key: 'gemini',
    label: 'Google Gemini',
    hint: 'generateContent —— Gemini 官方，以及只提供 Gemini 原生格式的中转站',
  },
];

const FORMAT_KEYS = API_FORMATS.map((f) => f.key);

/**
 * 按 baseUrl 猜格式。
 *
 * 为什么值得做：用户拿到一个中转站地址，往往并不知道它是哪种协议，
 * 填错就报 404/401，而报错文案很难让人联想到「格式选错了」。
 * 地址里那点特征（/messages、generativelanguage）足够做出可靠判断。
 */
function detectApiFormat(baseUrl) {
  const url = String(baseUrl || '').toLowerCase();
  if (!url) return 'openai';
  if (/:generatecontent|:streamgeneratecontent/.test(url)) return 'gemini';
  if (url.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (url.includes('anthropic.com') || /\/messages\/?$/.test(url)) return 'anthropic';
  return 'openai';
}

/**
 * 解析出最终要用的格式。
 * @param {object} cfg
 * @returns {{format:string, source:'explicit'|'detected'|'default'}}
 */
function resolveApiFormat(cfg) {
  const explicit = String(cfg.apiFormat || 'auto').toLowerCase();
  if (FORMAT_KEYS.includes(explicit)) return { format: explicit, source: 'explicit' };
  const detected = detectApiFormat(cfg.baseUrl);
  const isDefault = detected === 'openai' && !String(cfg.baseUrl || '').match(/openai|deepseek|ollama/i);
  return { format: detected, source: isDefault ? 'default' : 'detected' };
}

/** 创建 Provider 的工厂 */
function createProvider(cfg) {
  const { format } = resolveApiFormat(cfg);
  switch (format) {
    case 'anthropic':
      return new AnthropicProvider(cfg);
    case 'gemini':
      return new GeminiProvider(cfg);
    case 'openai':
      return new OpenAICompatProvider(cfg);
    default:
      throw new ProviderError(`未知的接口格式：${format}（可选：${FORMAT_KEYS.join(' / ')}）`);
  }
}

module.exports = {
  createProvider,
  API_FORMATS,
  FORMAT_KEYS,
  detectApiFormat,
  resolveApiFormat,
  // 向后兼容：以前只导出 Provider 名，名字保持不变
  OpenAICompatProvider,
  AnthropicProvider,
  GeminiProvider,
  BaseProvider,
  ProviderError,
  SseParser,
  parseArgs,
  extractReasoning,
  explainHttpError,
  // 协议翻译函数也导出去，测试要直接验它们
  toAnthropicMessages,
  toAnthropicTools,
  toGeminiContents,
  toGeminiTools,
  normalizeToolCalls,
};
