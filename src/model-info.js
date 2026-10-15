'use strict';

/**
 * 梦云 Agent —— 模型元信息缓存
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────
 * 界面上的上下文用量条需要一个分母（这个模型的窗口有多大）。
 * 服务商的**响应**里只有「用了多少」，从来不告诉你「最多多少」，
 * 所以早期版本只能按模型名猜（写死一张 gpt-4=8k、deepseek=128k 的表）。
 * 猜错的后果很实际：换到一个 32k 的模型，条子还按 128k 画，看着才 20%，
 * 其实早就塞满了，下一轮就直接 400。
 *
 * 但有些网关是**会告诉你**的：
 *   · Google Gemini 的 /v1beta/models 每个模型带 inputTokenLimit
 *   · OpenRouter 及一批中转站带 context_length / max_context_length
 * 这些数字是权威的（就是服务端自己的上限），应该优先用它们，
 * 而不是我猜的那张表。
 *
 * 缓存存在数据目录的 model-info.json 里，按「服务商+地址+模型名」做键。
 * 这样：拉过一次就不用每次再问；换了网关或换了模型各算各的。
 *
 * 优先级（见 session.resolveContextWindowInfo）：
 *   用户显式配置 > 网关给的 > 按模型名推断（界面上会标明是推断的）
 */

const fs = require('fs');
const path = require('path');
const { ensureDir } = require('./utils');

/** 网关可能用的字段名，按可信度从高到低排 */
const WINDOW_FIELDS = [
  'context_length',
  'context_window',
  'contextWindow',
  'max_context_length',
  'maxContextLength',
  'max_input_tokens',
  'maxInputTokens',
  'input_token_limit',
  'inputTokenLimit',
];

/**
 * 从模型元信息里抠出上下文窗口。
 *
 * 故意**不认** max_tokens / outputTokenLimit 这类字段：它们说的是「最多输出多少」，
 * 拿它当窗口会小得离谱（比如 8k 的输出上限）。宁可不用，也不能用错。
 *
 * @param {object} item 网关返回的单个模型对象
 * @returns {number} 0 表示没给出
 */
function extractContextWindow(item) {
  if (!item || typeof item !== 'object') return 0;
  for (const field of WINDOW_FIELDS) {
    const raw = item[field];
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 0;
}

/** 缓存文件路径 */
function filePath(cfg) {
  return path.join(cfg.dataDir || path.join(cfg.rootDir || '.', '.mya'), 'model-info.json');
}

/** 读整份缓存（坏文件当空的处理，缓存坏了不该影响启动） */
function load(cfg) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath(cfg), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

/** 缓存键：同一个模型名在不同网关上窗口可能不一样，所以要带上地址 */
function cacheKey(cfg, model) {
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  return `${cfg.provider || ''}|${base}|${model || ''}`;
}

/**
 * 取某个模型已知的上下文窗口。
 * @returns {{window:number, at:number, source:string}|null}
 */
function getContextWindow(cfg, model) {
  if (!model) return null;
  const hit = load(cfg)[cacheKey(cfg, model)];
  if (hit && Number(hit.window) > 0) {
    return { window: Math.floor(Number(hit.window)), at: hit.at || 0, source: hit.source || 'gateway' };
  }
  return null;
}

/**
 * 记下某个模型的上下文窗口。
 * @param {number} window token 数；<=0 会当成「没这条信息」直接忽略
 */
function setContextWindow(cfg, model, window, source = 'gateway') {
  const n = Math.floor(Number(window) || 0);
  if (!model || n <= 0) return false;
  try {
    const all = load(cfg);
    const key = cacheKey(cfg, model);
    if (all[key] && all[key].window === n) return false; // 没变就不写盘
    all[key] = { model, window: n, source, at: Date.now() };
    ensureDir(path.dirname(filePath(cfg)));
    fs.writeFileSync(filePath(cfg), `${JSON.stringify(all, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    // 写不进去只是下次还得再问一遍，不影响功能
    return false;
  }
}

module.exports = {
  WINDOW_FIELDS,
  extractContextWindow,
  filePath,
  load,
  cacheKey,
  getContextWindow,
  setContextWindow,
};
