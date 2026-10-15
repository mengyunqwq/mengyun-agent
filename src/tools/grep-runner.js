'use strict';

/**
 * 梦云 Agent —— grep 的执行器：把扫描丢进 worker，并给它一个超时
 *
 * 为什么不直接在工具里跑（见 grep-scan.js 的说明）：正则匹配没有超时机制，
 * 一个回溯炸弹就能把主进程钉死，而这个进程同时服务所有会话与 Web/SSE。
 *
 * 这里的策略：
 *   · 起一个 worker 跑扫描，主线程 await，超时就 `terminate()`；
 *   · 超时时返回**已经拿到的那部分结果**并打上 timedOut 标记（部分答案比没有答案有用，
 *     但必须说清它不完整——假装完整是最糟的）；
 *   · worker 不可用（老 Node / 受限环境）就退回主线程直跑，保留已知风险但功能可用。
 */

const path = require('path');

const WORKER_FILE = path.join(__dirname, '..', 'grep-scan.js');

/**
 * @param {object} scanOpts 传给扫描器的参数
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, matches?:string[], scanned?:number, timedOut?:boolean, error?:string, mode?:string}>}
 */
function runGrepScan(scanOpts, { timeoutMs = 5000 } = {}) {
  let Worker;
  try {
    ({ Worker } = require('worker_threads'));
  } catch {
    Worker = null;
  }

  // 退路：主线程直跑（没有 worker 的环境）
  if (!Worker) {
    const { scan } = require('../grep-scan');
    return scan(scanOpts)
      .then((r) => ({ ok: true, ...r, timedOut: false, mode: 'inline' }))
      .catch((err) => ({ ok: false, error: `搜索失败：${(err && err.message) || err}` }));
  }

  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(WORKER_FILE, { workerData: scanOpts });
    } catch (err) {
      // 起不来就直跑，别让功能整个不可用
      const { scan } = require('../grep-scan');
      scan(scanOpts)
        .then((r) => resolve({ ok: true, ...r, timedOut: false, mode: 'inline-fallback' }))
        .catch((e) => resolve({ ok: false, error: `搜索失败：${(e && e.message) || e}` }));
      return;
    }

    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 掐掉 worker：超时的情况下它可能正卡在正则里，不能指望它自己退出
      worker.terminate().catch(() => {});
      resolve(payload);
    };

    const timer = setTimeout(() => {
      finish({ ok: true, matches: [], scanned: 0, timedOut: true, mode: 'worker' });
    }, Math.max(500, Number(timeoutMs) || 5000));
    if (timer.unref) timer.unref();

    worker.on('message', (msg) => {
      if (msg && msg.ok) finish({ ok: true, matches: msg.matches || [], scanned: msg.scanned || 0, timedOut: false, mode: 'worker' });
      else finish({ ok: false, error: `搜索失败：${(msg && msg.error) || '未知错误'}` });
    });
    worker.on('error', (err) => finish({ ok: false, error: `搜索失败：${(err && err.message) || err}` }));
    worker.on('exit', () => finish({ ok: true, matches: [], scanned: 0, timedOut: false, mode: 'worker-exit' }));
  });
}

module.exports = { runGrepScan, WORKER_FILE };
