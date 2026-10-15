'use strict';

/**
 * 示例插件：audit（审计）
 *
 * 用途：演示「钩子的三种典型用法」——这也是插件最有价值的能力：
 *   1. 记录（tool:after）   → 把每次工具调用写进日志，事后可追溯
 *   2. 统计（内存累加）     → 统计各工具使用次数、耗时、失败率
 *   3. 拦截（tool:before 返回 false）→ 命中黑名单直接阻止，模型收到拒绝原因
 *
 * 想加自己的安全规则？改下面的 BLOCKED_PATTERNS 和 ctx.getConfig() 即可。
 */

const fs = require('fs');
const path = require('path');

/** 默认黑名单：即使有人误点了「允许」，这些也拦下来 */
const BLOCKED_PATTERNS = [
  { re: /rm\s+-rf\s+\/(?!\w)/i, reason: '禁止删除根目录' },
  { re: /Remove-Item\s+.*-Recurse.*-Force\s+[A-Z]:\\?$/i, reason: '禁止递归删除整个盘符' },
  { re: /git\s+push\s+.*--force/i, reason: '禁止强制推送（可能覆盖他人提交）' },
  { re: /npm\s+publish|pnpm\s+publish/i, reason: '禁止自动发布到 npm' },
  { re: /curl[^|]*\|\s*(ba)?sh/i, reason: '禁止 curl | sh 这种不可审计的安装方式' },
  { re: /:\(\)\s*\{.*\}\s*;\s*:/, reason: '禁止 fork 炸弹' },
];

module.exports = {
  name: 'audit',
  version: '0.1.0',
  description: '工具调用审计与统计',

  setup(ctx) {
    // 插件自己的配置：config.json → plugins.config.audit
    const conf = ctx.getConfig({
      enabled: true,
      logFile: '.mya/audit.log',
      blocked_patterns: [], // 用户可在配置里追加自定义黑名单（正则字符串）
      maxMemoryRecords: 500,
    });

    // 编译用户追加的正则（用户写错正则不能让插件崩掉）
    const userPatterns = [];
    for (const item of conf.blocked_patterns || []) {
      try {
        const src = typeof item === 'string' ? item : item.pattern;
        const reason = (typeof item === 'object' && item.reason) || '命中自定义黑名单';
        userPatterns.push({ re: new RegExp(src, 'i'), reason });
      } catch (err) {
        ctx.warn(`自定义黑名单正则无效，已忽略：${item}（${err.message}）`);
      }
    }
    const allPatterns = [...BLOCKED_PATTERNS, ...userPatterns];

    // 内存中的统计与最近记录
    const stats = new Map(); // toolName -> { calls, ok, failed, totalMs, maxMs }
    const recent = []; // 最近 N 条记录
    const logPath = path.isAbsolute(conf.logFile) ? conf.logFile : path.join(ctx.cwd, conf.logFile);

    if (conf.enabled === false) {
      ctx.log('审计已按配置关闭（plugins.config.audit.enabled=false）');
      return;
    }

    /* ------------------------------------------------------------
     * 写盘：攒批 + 异步追加
     *
     * 为什么不再用 appendFileSync：tool:after 是热路径（每次工具调用都过一遍），
     * 同步写会在这里阻塞事件循环——一块慢盘、一个被杀毒的目录，就能把整个
     * agent 拖成"卡住"。改成先入内存队列，setImmediate/setTimeout 合并成一次
     * appendFile。
     *
     * 代价要讲清楚：进程被强杀（kill -9 / 断电）时，最后一批可能没落盘。
     * 这个取舍是有意的——审计的价值在"事后可查"，而不是"崩溃时零丢失"，
     * 而且真正要紧的动作在 tool:before 就拦住了，不靠日志兜底。
     * 另外：进程正常退出（含 CLI 一次性任务）时做一次同步 flush，
     * 否则 200ms 的批窗口还没到就退出了，记录会整批丢。
     * ---------------------------------------------------------- */
    const pending = [];
    let flushTimer = null;

    const flushSync = () => {
      if (!pending.length) return;
      const batch = pending.splice(0, pending.length).join('');
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, batch, 'utf8');
      } catch (err) {
        ctx.warn(`写审计日志失败：${err.message}`);
      }
    };

    const flushAsync = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (!pending.length) return;
      const batch = pending.splice(0, pending.length).join('');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFile(logPath, batch, 'utf8', (err) => {
        if (err) ctx.warn(`写审计日志失败：${err.message}`);
      });
    };

    const enqueue = (line) => {
      pending.push(line);
      // 积压多了立即写，别让内存无限涨
      if (pending.length >= 50) {
        flushAsync();
        return;
      }
      if (!flushTimer) {
        flushTimer = setTimeout(flushAsync, 200);
        if (flushTimer.unref) flushTimer.unref();
      }
    };

    const onExit = () => flushSync();
    process.once('exit', onExit);

    /* ------------------------------------------------------------
     * 1) 拦截：tool:before 返回 false 即可阻止执行
     * ---------------------------------------------------------- */
    ctx.on('tool:before', (e, meta) => {
      if (e.toolName !== 'shell') return true;
      const command = String(e.args?.command || '');
      for (const { re, reason } of allPatterns) {
        if (re.test(command)) {
          ctx.warn(`拦截危险命令（${reason}）：${command}`);
          return false; // ← 这一行就是拦截
        }
      }
      return true;
    });

    /* ------------------------------------------------------------
     * 2) 记录 + 3) 统计
     * ---------------------------------------------------------- */
    ctx.on('tool:after', (e) => {
      const name = e.toolName;
      const rec = stats.get(name) || { calls: 0, ok: 0, failed: 0, totalMs: 0, maxMs: 0 };
      rec.calls += 1;
      if (e.ok) rec.ok += 1;
      else rec.failed += 1;
      rec.totalMs += e.ms || 0;
      rec.maxMs = Math.max(rec.maxMs, e.ms || 0);
      stats.set(name, rec);

      const entry = {
        ts: new Date().toISOString(),
        session: e.ctx?.session?.id || '',
        tool: name,
        ok: e.ok !== false,
        ms: e.ms || 0,
        summary: (e.summary || '').slice(0, 200),
        args: safeArgs(e.toolName, e.args),
      };

      recent.push(entry);
      if (recent.length > (conf.maxMemoryRecords || 500)) recent.shift();

      // 入队（真正的写盘交给批处理器，热路径不再同步阻塞）
      enqueue(`${JSON.stringify(entry)}\n`);
    });

    /* ------------------------------------------------------------
     * 会话结束时打印一行汇总
     * ---------------------------------------------------------- */
    ctx.on('session:end', (e) => {
      // 一轮结束就把积压写掉：用户可能马上打开日志看刚才干了什么
      flushAsync();
      const total = [...stats.values()].reduce((sum, r) => sum + r.calls, 0);
      if (total) {
        const failed = [...stats.values()].reduce((sum, r) => sum + r.failed, 0);
        ctx.log(`本次会话共 ${total} 次工具调用，失败 ${failed} 次；审计日志：${logPath}`);
      }
    });

    /* ------------------------------------------------------------
     * 给模型两个查询工具
     * ---------------------------------------------------------- */
    ctx.registerTool({
      name: 'audit_recent',
      description: '查看最近的工具调用记录（谁在什么时候调用了什么工具、成功与否、耗时多久）',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '显示最近多少条，默认 20' },
          only_failed: { type: 'boolean', description: '只看失败的调用' },
        },
        required: [],
        additionalProperties: false,
      },
      tags: ['audit'],
      autoApprove: true,
      async run(args) {
        let list = recent;
        if (args.only_failed) list = list.filter((r) => !r.ok);
        const n = Math.max(1, Math.min(Number(args.limit) || 20, 200));
        const shown = list.slice(-n);
        if (!shown.length) return { ok: true, content: '还没有工具调用记录。' };
        return {
          ok: true,
          content: shown
            .map((r) => `${r.ts.slice(11, 19)} ${r.ok ? '✓' : '✗'} ${r.tool.padEnd(14)} ${String(r.ms).padStart(6)}ms  ${r.summary}`)
            .join('\n'),
        };
      },
    });

    ctx.registerTool({
      name: 'audit_stats',
      description: '统计各工具的使用次数、成功率、平均耗时，用于分析 agent 的工作模式',
      parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
      tags: ['audit'],
      autoApprove: true,
      async run() {
        if (!stats.size) return { ok: true, content: '还没有统计数据。' };
        const rows = [...stats.entries()]
          .sort((a, b) => b[1].calls - a[1].calls)
          .map(([name, r]) => {
            const rate = r.calls ? Math.round((r.ok / r.calls) * 100) : 0;
            const avg = r.calls ? Math.round(r.totalMs / r.calls) : 0;
            return `${name.padEnd(16)} 调用 ${String(r.calls).padStart(4)}  成功 ${String(rate).padStart(3)}%  平均 ${String(avg).padStart(5)}ms  最慢 ${r.maxMs}ms`;
          });
        return { ok: true, content: `工具使用统计：\n${rows.join('\n')}` };
      },
    });

    ctx.registerCommand(
      'audit',
      { description: '查看审计统计（不经过模型）', usage: '/audit [数量]' },
      async (input) => {
        const n = Number(input) || 10;
        const lines = recent.slice(-n).map((r) => `${r.ts.slice(11, 19)} ${r.ok ? '✓' : '✗'} ${r.tool} — ${r.summary}`);
        return lines.length ? lines.join('\n') : '暂无记录。';
      },
    );

    ctx.log(`审计已启用，日志写入 ${logPath}，黑名单规则 ${allPatterns.length} 条`);
  },
};

/** 审计日志里不要把超长内容存进去，只留关键参数 */
function safeArgs(toolName, args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') out[k] = v.length > 300 ? `${v.slice(0, 300)}…(${v.length}字符)` : v;
    else out[k] = v;
  }
  return out;
}
