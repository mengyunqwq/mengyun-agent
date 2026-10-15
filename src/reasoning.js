'use strict';

/**
 * 推理等级（reasoning effort）。
 *
 * 为什么不能自造一套「低 / 中 / 高」直接发出去：三家官方 API 的参数名和取值
 * **完全不一样**，发错一个字段，轻则被静默忽略（你以为调高了，其实模型还在用
 * 默认档），重则直接 400 把整轮请求打回来——
 *
 *   · OpenAI 兼容（POST /chat/completions）
 *     官方字段 `reasoning_effort`，官方取值 `minimal | low | medium | high`
 *     （minimal 是 GPT-5 那一代才有的档，老一点的推理模型只认 low/medium/high）
 *   · Anthropic（POST /v1/messages）
 *     官方**没有**「等级」这个概念，只有 extended thinking 的
 *     `thinking.budget_tokens`（token 预算）。官方硬性要求：预算 ≥ 1024，
 *     且必须小于 max_tokens；另外开着 thinking 时**不能再带 temperature**
 *   · Google Gemini（POST :generateContent）
 *     官方字段 `generationConfig.thinkingConfig.thinkingBudget`（token 预算；
 *     0 表示关掉思考，-1 表示交给模型自己决定）
 *
 * 所以内部只用一组语义值：auto / low / medium / high（外加 OpenAI 特有的 minimal），
 * **auto = 一个字段都不发**，和加这个功能之前的行为一模一样；落到具体协议时，
 * 再由这里翻译成官方形状。界面上的选项也由这里生成（见 optionsFor），
 * 保证「界面显示什么」和「实际发出去什么」永远对得上，不会两处各写一份。
 */

/** 内部语义值。auto = 不发送任何推理字段 */
const LEVELS = ['auto', 'low', 'medium', 'high'];

/** OpenAI 官方多一档 minimal，所以对外可选的取值多一个 */
const OPENAI_LEVELS = ['auto', 'minimal', 'low', 'medium', 'high'];

/**
 * Anthropic 只有 token 预算。这三档是按「预算越大、思考越多」的语义折算的，
 * 取值本身没有官方依据（官方没有等级概念），所以界面上会把真实预算写出来，
 * 让用户知道自己到底发了多少 token 的预算。
 */
const ANTHROPIC_BUDGETS = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };

/**
 * Gemini 的 thinkingBudget（token）。上限按官方 2.5 Flash 的 24576 取，
 * 2.5 Pro 上限更高，所以这个值在 Pro 上也是安全的。
 */
const GEMINI_BUDGETS = { minimal: 0, low: 2048, medium: 8192, high: 24576 };

/** 界面上的中文标签 */
const LABELS = { auto: '默认', minimal: '最低', low: '低', medium: '中', high: '高' };

/** 把配置/请求里传来的值收敛到合法取值（不认识的当 auto，也就是「不发送」） */
function normalize(level) {
  const value = String(level === undefined || level === null ? '' : level)
    .trim()
    .toLowerCase();
  return OPENAI_LEVELS.includes(value) ? value : 'auto';
}

/** 这个等级是不是「要真的发点东西出去」 */
function isEnabled(level) {
  return normalize(level) !== 'auto';
}

/**
 * 当前协议下界面上该给哪几个选项，以及每个选项发出去的到底是什么。
 *
 * @param {string} format openai | anthropic | gemini
 * @returns {Array<{value:string,label:string,hint:string}>}
 */
function optionsFor(format) {
  if (format === 'anthropic') {
    return LEVELS.map((value) => ({
      value,
      label: LABELS[value],
      hint:
        value === 'auto'
          ? '不发送 thinking 字段（官方默认行为）'
          : `thinking.budget_tokens = ${ANTHROPIC_BUDGETS[value]}`,
    }));
  }
  if (format === 'gemini') {
    return LEVELS.map((value) => ({
      value,
      label: LABELS[value],
      hint:
        value === 'auto'
          ? '不发送 thinkingConfig 字段（官方默认行为）'
          : `thinkingConfig.thinkingBudget = ${GEMINI_BUDGETS[value]}`,
    }));
  }
  // OpenAI 兼容（含 DeepSeek、Ollama、各家中转站）
  return OPENAI_LEVELS.map((value) => ({
    value,
    label: LABELS[value],
    hint: value === 'auto' ? '不发送 reasoning_effort 字段' : `reasoning_effort = "${value}"`,
  }));
}

/** 这个协议下「等级」具体是怎么落的——界面显示一行说明，免得用户以为三家的「高」是一回事 */
function protocolNote(format) {
  if (format === 'anthropic') {
    return 'Anthropic 官方没有推理等级，只有 extended thinking 的 token 预算；开 thinking 时会自动去掉 temperature（官方要求）。';
  }
  if (format === 'gemini') {
    return 'Gemini 官方用 generationConfig.thinkingConfig.thinkingBudget（token 预算），0 表示关掉思考。';
  }
  return 'OpenAI 兼容协议用 reasoning_effort，官方取值 minimal / low / medium / high。';
}

/** 给界面用的一份完整描述 */
function describe(cfg, format) {
  const level = normalize(cfg && cfg.reasoning && cfg.reasoning.level);
  return {
    level,
    format,
    options: optionsFor(format),
    note: protocolNote(format),
  };
}

/* ------------------------------------------------------------------ */
/* 落到各家请求体上                                                     */
/* ------------------------------------------------------------------ */

/** OpenAI 兼容：reasoning_effort（官方取值原样发出去） */
function applyOpenAI(body, cfg) {
  const level = normalize(cfg && cfg.reasoning && cfg.reasoning.level);
  if (level !== 'auto') body.reasoning_effort = level;
  return body;
}

/**
 * Anthropic：extended thinking。
 *
 * 两处官方硬性约束都在这里兜住：
 *   1. budget_tokens ≥ 1024，且必须小于 max_tokens（否则请求会被拒）；
 *   2. 开着 thinking 时不能自定义 temperature —— 所以直接把 temperature 摘掉，
 *      而不是留给服务端报 400（用户看到的会是「参数不被接受」，很难联想到 thinking）。
 */
function applyAnthropicThinking(body, cfg, maxTokens) {
  const level = normalize(cfg && cfg.reasoning && cfg.reasoning.level);
  if (level === 'auto') return body;
  const ceiling = Math.max(1024, Math.floor(Number(maxTokens) || 4096) - 1024);
  const budget = Math.max(1024, Math.min(ANTHROPIC_BUDGETS[level] || 4096, ceiling));
  body.thinking = { type: 'enabled', budget_tokens: budget };
  delete body.temperature;
  return body;
}

/** Gemini：generationConfig.thinkingConfig.thinkingBudget */
function applyGeminiThinking(generationConfig, cfg) {
  const level = normalize(cfg && cfg.reasoning && cfg.reasoning.level);
  if (level === 'auto') return generationConfig;
  generationConfig.thinkingConfig = {
    thinkingBudget: GEMINI_BUDGETS[level] === undefined ? 8192 : GEMINI_BUDGETS[level],
  };
  return generationConfig;
}

/** 出错时给用户的一句提示：把「参数不被接受」和推理等级关联起来 */
function errorHint() {
  return '如果服务端报 400 / 参数不被接受，先把「推理等级」改回默认——部分网关并不认 reasoning_effort / thinking 这些字段。';
}

module.exports = {
  LEVELS,
  OPENAI_LEVELS,
  ANTHROPIC_BUDGETS,
  GEMINI_BUDGETS,
  LABELS,
  normalize,
  isEnabled,
  optionsFor,
  protocolNote,
  describe,
  applyOpenAI,
  applyAnthropicThinking,
  applyGeminiThinking,
  errorHint,
};
