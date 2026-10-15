'use strict';

/**
 * 梦云 Agent —— 事件总线
 *
 * 插件通过它挂钩子（hook），实现「不改核心代码就扩展行为」：
 *
 *   export default {
 *     name: 'my-plugin',
 *     setup(ctx) {
 *       ctx.on('tool:before', async (e) => {
 *         if (e.toolName === 'shell') ctx.log('要执行命令了：' + e.args.command);
 *       });
 *     }
 *   }
 *
 * 事件名清单（都在下面 EVENTS 里）：
 *   session:start        会话开始        { sessionId, config }
 *   turn:start           新一轮开始      { turn }
 *   prompt:build         系统提示词组装前 { system, config }
 *   messages:before      调模型前        { messages, provider, session } ← 可原地修改 messages，用于注入或压缩上下文
 *   turn:context         上下文用量       { turn, context: { used, window, messages, compacted } }
 *   context:compacting   开始压缩上下文   { used, window, ratio, messages, reason }
 *   context:compacted    上下文被压缩     { removed, kept, summary, savedTokens, reason }
 *   context:compact-failed 压缩没做成     { error, reason }  ← 界面据此判断成败，别去解析中文
 *   assistant:reasoning  思考过程片段     { text, delta, turn }
 *   assistant:delta      流式片段        { text, delta }
 *   assistant:done       模型回复完成     { text, reasoning, toolCalls, usage, context }
 *   step:usage           每一步的 token   { turn, usage, cumulative, context, ms } ← 一次请求模型算一步
 *   tool:before          工具执行前      { toolName, args }        ← 返回 false 可拦截
 *   tool:after           工具执行后      { toolName, args, ok, summary, output }
 *   turn:end             本轮结束        { turn, reason }
 *   session:end          会话结束        { sessionId, usage, context }
 *   error                出错            { error, where }
 */

const EVENTS = [
  'session:start',
  'turn:start',
  'prompt:build',
  'messages:before',
  'turn:context',
  'context:compacting',
  'context:compacted',
  'context:compact-failed',
  'assistant:reasoning',
  'assistant:delta',
  'assistant:done',
  'step:usage',
  'tool:before',
  'tool:after',
  'turn:end',
  'session:end',
  'error',
];

class EventBus {
  constructor() {
    /** @type {Map<string, Array<{fn: Function, once: boolean, label: string}>>} */
    this.handlers = new Map();
  }

  /**
   * 注册监听器。
   * @param {string} event 事件名，支持 '*' 通配
   * @param {Function} fn  处理函数，可 async
   * @param {{once?: boolean, label?: string}} [opts]
   * @returns {Function} 取消注册的函数
   */
  on(event, fn, opts = {}) {
    if (typeof fn !== 'function') throw new TypeError(`事件 ${event} 的处理器必须是函数`);
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    const entry = { fn, once: !!opts.once, label: opts.label || 'anonymous' };
    this.handlers.get(event).push(entry);
    return () => this.off(event, fn);
  }

  once(event, fn, opts = {}) {
    return this.on(event, fn, { ...opts, once: true });
  }

  off(event, fn) {
    const list = this.handlers.get(event);
    if (!list) return;
    const next = list.filter((h) => h.fn !== fn);
    if (next.length) this.handlers.set(event, next);
    else this.handlers.delete(event);
  }

  /**
   * 按 label 摘掉监听器，返回摘掉的数量。
   *
   * 为什么需要它：插件卸载/重扫时，光把插件的工具和命令删掉是不够的——
   * 它注册的钩子还挂在总线上，于是「禁用掉的插件依然在拦截危险命令」
   * 「重扫三次，同一个钩子跑三遍」（实测监听器数 6 → 12 → 18）。
   * 插件注册钩子时统一带 label（见 PluginHost.makeContext），所以按 label 能一次摘净。
   */
  offLabel(label) {
    let removed = 0;
    for (const [event, list] of this.handlers) {
      const next = list.filter((h) => h.label !== label);
      removed += list.length - next.length;
      if (next.length) this.handlers.set(event, next);
      else this.handlers.delete(event);
    }
    return removed;
  }

  /** 清空所有监听器（会话之间调用，避免插件重复注册） */
  clear() {
    this.handlers.clear();
  }

  /** 监听器数量，用于 doctor 展示 */
  count() {
    let n = 0;
    for (const list of this.handlers.values()) n += list.length;
    return n;
  }

  /**
   * 触发事件。
   * - 默认：所有处理器都跑完，忽略返回值。
   * - { bail: true }：任何一个处理器返回 false 就中止后续处理器，并让 emit 返回 false。
   * - 处理器抛错：不会炸掉主流程，只会转成 error 事件（除非 { throwOnError: true }）。
   */
  async emit(event, payload = {}, opts = {}) {
    const listeners = [...(this.handlers.get(event) || []), ...(this.handlers.get('*') || [])];
    for (const entry of listeners) {
      if (entry.once) this.off(event, entry.fn);
      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await entry.fn(payload, { event, label: entry.label });
        if (opts.bail && result === false) return false;
      } catch (err) {
        if (opts.throwOnError) throw err;
        // 插件报错不应该拖垮整个会话
        if (event !== 'error') {
          await this.emit(
            'error',
            { error: err, where: `hook:${event}`, label: entry.label },
            { throwOnError: false },
          ).catch(() => {});
        }
      }
    }
    return true;
  }
}

module.exports = { EventBus, EVENTS };
