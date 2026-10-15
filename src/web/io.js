'use strict';

/**
 * 梦云 Agent —— Web 界面适配层
 *
 * 两个东西：
 *   1. createWebIO      —— 把 agent 的输出接到网页上（替代终端打印）
 *   2. createApprovals  —— 工具执行的「网页确认闸门」
 *
 * 确认闸门为什么这么设计：
 *   终端里确认是同步的（敲个 y 就完事），网页里做不到——用户可能正在看别的标签页。
 *   所以这里做成异步：工具执行会挂起，前端弹出一张「确认卡片」，
 *   用户点「允许」或「拒绝」之后，这个挂起的 Promise 才 resolve。
 *   超时（默认 5 分钟）没点，就当作拒绝，避免会话永久卡住。
 */

const { shortId } = require('../utils');

/* ------------------------------------------------------------------ */
/* 输出适配器                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {object} hooks
 * @param {Function} hooks.onEvent  (event) => void  推给前端的事件
 * @param {Function} [hooks.confirm] (question, opts) => Promise<boolean>
 *        危险操作确认。Web 模式下由 SessionManager 接到「网页确认卡片」上；
 *        不传则一律拒绝（宁可拒绝也不擅自执行）。
 */
function createWebIO(hooks = {}) {
  const emit = (event) => {
    if (typeof hooks.onEvent === 'function') hooks.onEvent(event);
  };
  return {
    kind: 'web',
    spinner: () => ({ start() {}, stop() {}, update() {} }),
    assistantStart: () => emit({ type: 'assistant_start' }),
    assistantDelta: (delta) => emit({ type: 'delta', text: delta }),
    assistantEnd: () => emit({ type: 'assistant_end' }),
    toolCall: (name, args) => emit({ type: 'tool_call', name, args }),
    toolResult: (name, info) => emit({ type: 'tool_result', name, info }),
    toolOutput: (text) => emit({ type: 'tool_output', text }),
    warn: (text) => emit({ type: 'warn', text }),
    dim: () => {},
    summary: (text) => emit({ type: 'summary', text }),
    // 网页里没有 stdin 可以提问，需要用户输入的操作一律拒绝
    ask: async () => '',
    confirm:
      typeof hooks.confirm === 'function'
        ? (question, opts) => hooks.confirm(question, opts)
        : async () => false,
  };
}

/* ------------------------------------------------------------------ */
/* 确认闸门                                                            */
/* ------------------------------------------------------------------ */

function createApprovals({ timeoutMs = 5 * 60 * 1000 } = {}) {
  /** @type {Map<string, {resolve:Function, timer:NodeJS.Timeout, info:object}>} */
  const pending = new Map();
  let notify = () => {};

  return {
    /** 设置通知回调（Web 服务器启动时注入，用来把请求推给前端） */
    setNotifier(fn) {
      notify = typeof fn === 'function' ? fn : () => {};
    },

    /** 当前等待确认的请求（前端刷新页面时用来恢复卡片） */
    list() {
      return [...pending.values()].map((p) => p.info);
    },

    /**
     * agent 要执行某个操作，挂起等用户点确认。
     * @returns {Promise<boolean>}
     */
    request(info) {
      const id = `ap_${shortId(8)}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          notify({ type: 'approval_timeout', id });
          resolve(false); // 超时当拒绝，避免永久卡住
        }, timeoutMs);
        if (timer.unref) timer.unref();

        const record = { resolve, timer, info: { id, ...info, ts: Date.now() } };
        pending.set(id, record);
        notify({ type: 'approval_request', approval: record.info });
      });
    },

    /** 用户点了允许 / 拒绝 */
    resolve(id, approved) {
      const record = pending.get(id);
      if (!record) return false;
      clearTimeout(record.timer);
      pending.delete(id);
      record.resolve(!!approved);
      notify({ type: 'approval_done', id, approved: !!approved });
      return true;
    },

    /** 会话中断时，把所有挂起的确认都拒掉 */
    rejectAll(reason = '会话已中断') {
      for (const [id, record] of pending) {
        clearTimeout(record.timer);
        record.resolve(false);
        record.info.reason = reason;
        notify({ type: 'approval_done', id, approved: false });
      }
      pending.clear();
    },

    /**
     * 只拒掉属于某个会话的挂起确认。
     * 多会话并行时，「中断 A」不该把 B 正在等的确认也拒掉——
     * 否则 B 那边的确认卡片会莫名消失，任务被误判成「用户拒绝」。
     */
    rejectFor(sessionId, reason = '会话已中断') {
      if (!sessionId) return this.rejectAll(reason);
      for (const [id, record] of pending) {
        if (record.info.sessionId !== sessionId) continue;
        clearTimeout(record.timer);
        record.resolve(false);
        record.info.reason = reason;
        notify({ type: 'approval_done', id, approved: false });
        pending.delete(id);
      }
    },

    get size() {
      return pending.size;
    },
  };
}

module.exports = { createWebIO, createApprovals };
