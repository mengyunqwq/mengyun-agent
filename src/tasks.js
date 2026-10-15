'use strict';

/**
 * 梦云 Agent —— 并行子任务调度器
 *
 * 复杂任务让模型拆成几个小目标并行跑，各自用**受限的**上下文和工具集，
 * 只把结论摘要回填给父任务。为什么不做多进程：这套内核的路子是
 * 「零依赖、单进程、工具/插件/确认闸门都在同一个进程里」，
 * 拆成多进程就得把事件总线、确认闸门、路径约束全部跨进程复制一遍。
 *
 * 这个文件只管**调度**，不碰模型也不碰 UI：
 *   · 并发池（maxParallel）—— 同一个网关同一个 key，一次放十个请求只会互相拖慢
 *   · 深度限制（maxDepth）—— 子任务不能再无限拆孙任务
 *   · 超时（subTimeoutSec）—— 到点自己收掉，不把父任务一起拖死
 *   · 预算（budgetTurns / budgetTokens）—— 按「一次用户消息」算总账
 *   · 中断级联（cancelAll）—— 父任务停了，子任务必须一起停，否则就是僵尸
 * 真正「怎么跑一个子任务」由外部注入（runSubtask），所以这个文件可以用假执行器单测。
 */

const { shortId } = require('./utils');

/** 摘要上限：回填给父任务的是结论，不是子任务的完整过程（防上下文爆炸） */
const MAX_SUMMARY = 800;
/** 每个子任务保留多少行「活动记录」给界面看 */
const MAX_ACTIVITY = 40;

const TASK_DEFAULTS = {
  enabled: true,
  /** 同时最多跑几个子任务 */
  maxParallel: 3,
  /** 最多嵌套几层（1 = 子任务不能再拆） */
  maxDepth: 1,
  /** 一次用户消息里最多拆几个 */
  maxTasks: 6,
  /** 每个子任务最多几轮（父任务的 maxTurns 另算） */
  subTurns: 12,
  /** 单个子任务超时（秒） */
  subTimeoutSec: 600,
  /** 一次用户消息里，所有子任务合计最多多少轮 */
  budgetTurns: 30,
  /** 一次用户消息里，所有子任务合计最多多少 token */
  budgetTokens: 200000,
  /**
   * 子任务默认能用的工具。
   * 默认只读：并行子任务同时写文件必然是竞态（两个 write 打同一个文件、
   * 两个 edit 抢同一段），所以写操作留给父任务统一做。
   */
  readonlyTools: ['read', 'glob', 'grep'],
};

/** 把配置里的 tasks 块补全成一份完整、安全的取值 */
function normalizeTasksCfg(cfg) {
  const raw = (cfg && cfg.tasks) || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const list =
    Array.isArray(raw.readonlyTools) && raw.readonlyTools.length
      ? raw.readonlyTools.map((s) => String(s).trim()).filter(Boolean)
      : TASK_DEFAULTS.readonlyTools.slice();
  return {
    enabled: raw.enabled !== false,
    maxParallel: Math.max(1, num(raw.maxParallel, TASK_DEFAULTS.maxParallel)),
    maxDepth: Math.max(0, num(raw.maxDepth, TASK_DEFAULTS.maxDepth)),
    maxTasks: Math.max(1, num(raw.maxTasks, TASK_DEFAULTS.maxTasks)),
    subTurns: Math.max(1, num(raw.subTurns, TASK_DEFAULTS.subTurns)),
    // 超时下限 1 秒：再小就不是「超时」而是「必然失败」了
    subTimeoutSec: Math.max(1, num(raw.subTimeoutSec, TASK_DEFAULTS.subTimeoutSec)),
    budgetTurns: Math.max(1, num(raw.budgetTurns, TASK_DEFAULTS.budgetTurns)),
    /**
     * 预算不设隐藏下限：写了 500 就按 500 执行。
     * （曾经在这里 clamp 到 1000，结果用户填的小值被悄悄改大——
     *   配置项的行为必须和写进去的数字一致，否则「我明明设了」会变成悬案。）
     */
    budgetTokens: Math.max(1, num(raw.budgetTokens, TASK_DEFAULTS.budgetTokens)),
    readonlyTools: list,
  };
}

/**
 * 子任务用的静默输出通道。
 *
 * 为什么需要：agent 的输出适配器（io）在终端模式下会逐字打印。
 * 三个子任务同时往终端刷字，主任务的输出就被淹了——用户会以为程序疯了。
 * 子任务的过程走「任务块」（界面）和日志，终端只在必要时给一行提示。
 */
function createSilentIO() {
  const noop = () => {};
  const spinner = () => ({ start: noop, stop: noop, update: noop });
  return {
    kind: 'subtask',
    spinner,
    assistantStart: noop,
    assistantDelta: noop,
    assistantEnd: noop,
    toolCall: noop,
    toolResult: noop,
    toolOutput: noop,
    warn: noop,
    dim: noop,
    summary: noop,
    block: noop,
    log: { ok: noop, warn: noop, error: noop, info: noop, step: noop, dim: noop },
    // 网页里没有 stdin：需要用户输入的操作一律拒绝（和 web io 保持一致）
    ask: async () => '',
    // 子任务里的确认走它自己的 ctx.confirm（由执行器注入），这里兜底拒绝
    confirm: async () => false,
  };
}

class TaskManager {
  /**
   * @param {object} opts
   * @param {object} opts.cfg 全局配置（读 cfg.tasks）
   * @param {import('./events').EventBus} [opts.bus] 事件总线
   * @param {(task:object, signal:AbortSignal, hooks:object) => Promise<object>} opts.runSubtask
   *        真正跑一个子任务；返回 { text, usage, turns, toolCalls }
   * @param {object} [opts.logger] 结构化日志
   */
  constructor({ cfg, bus, runSubtask, logger } = {}) {
    this.cfg = cfg || {};
    this.opts = normalizeTasksCfg(this.cfg);
    this.bus = bus || null;
    this.runSubtask = runSubtask;
    this.log = logger || null;
    /** @type {Map<string, object>} id → 任务记录 */
    this.tasks = new Map();
    /** spawn 顺序（wait 不带 id 时按这个顺序收） */
    this.order = [];
    /** parentRunId → 任务 id 列表 */
    this.byParent = new Map();
    /** parentRunId → { turns, tokens } 已花掉的预算 */
    this.spent = new Map();
    this.queue = [];
    this.running = 0;
    /** 单测/自检要看「并发真的封顶了」 */
    this.peakRunning = 0;
    this.seq = 0;
    this.closedParents = new Set();
  }

  /** 当前配置（已补全默认值） */
  get config() {
    return { ...this.opts, readonlyTools: this.opts.readonlyTools.slice() };
  }

  /** 还没结束的任务数（running + queued）——中断后应当归零 */
  pendingCount(parentRunId) {
    const ids = parentRunId ? this.byParent.get(parentRunId) || [] : this.order;
    return ids.filter((id) => {
      const t = this.tasks.get(id);
      return t && (t.status === 'running' || t.status === 'queued');
    }).length;
  }

  /** 某个父任务名下的账（给 task_status / 测试看） */
  stats(parentRunId) {
    const ids = parentRunId ? this.byParent.get(parentRunId) || [] : this.order;
    const spent = this.spent.get(parentRunId) || { turns: 0, tokens: 0 };
    const count = (s) => ids.filter((id) => (this.tasks.get(id) || {}).status === s).length;
    return {
      total: ids.length,
      running: count('running'),
      queued: count('queued'),
      done: count('done'),
      failed: count('failed'),
      aborted: count('aborted'),
      timeout: count('timeout'),
      turns: spent.turns,
      tokens: spent.tokens,
      limits: {
        maxParallel: this.opts.maxParallel,
        maxDepth: this.opts.maxDepth,
        maxTasks: this.opts.maxTasks,
        budgetTurns: this.opts.budgetTurns,
        budgetTokens: this.opts.budgetTokens,
        subTurns: this.opts.subTurns,
        subTimeoutSec: this.opts.subTimeoutSec,
        readonlyTools: this.opts.readonlyTools,
      },
      peakRunning: this.peakRunning,
    };
  }

  /** 对外的任务快照（不含 controller/promise/session 这些内部东西） */
  view(record) {
    if (!record) return null;
    return {
      id: record.id,
      title: record.title,
      goal: record.goal,
      status: record.status,
      depth: record.depth,
      allowTools: record.allowTools.slice(),
      turns: record.turns,
      tokens: record.tokens,
      toolCalls: record.toolCalls,
      ms: record.ms,
      activity: record.activity.slice(),
      summary: record.summary,
      error: record.error,
      createdAt: record.createdAt,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
    };
  }

  /**
   * 拆一个子任务。**立刻返回**，不等它跑完。
   *
   * 为什么立刻返回：父任务在同一轮里可能连发好几个 spawn，
   * 如果这里阻塞，它们就变成串行了——而「并行」正是这个功能的意义。
   */
  spawn({ parentRunId, parentSession, cwd, title, goal, depth = 0, allowTools } = {}) {
    const refuse = (error) => ({ ok: false, error });

    if (!this.opts.enabled) return refuse('并行子任务功能在配置里关着（tasks.enabled=false），请自己按顺序完成。');
    if (typeof this.runSubtask !== 'function') return refuse('子任务执行器没有装配（内部错误：runSubtask 缺失）。');
    if (this.closedParents.has(parentRunId)) {
      return refuse('这一轮任务已经结束了，不能再拆子任务。');
    }
    const cleanGoal = String(goal || '').trim();
    if (!cleanGoal) return refuse('task_spawn 需要 goal（这个子任务到底要做什么），不能空着。');
    const cleanTitle =
      String(title || '')
        .trim()
        .slice(0, 60) || cleanGoal.slice(0, 30);

    const childDepth = (Number(depth) || 0) + 1;
    if (childDepth > this.opts.maxDepth) {
      return refuse(
        `已经到最大拆分深度（tasks.maxDepth=${this.opts.maxDepth}）：子任务不能再拆子任务，` +
          `这件事请你自己做完，或者把结论报给父任务。`,
      );
    }

    const mine = this.byParent.get(parentRunId) || [];
    if (mine.length >= this.opts.maxTasks) {
      return refuse(
        `一次任务最多拆 ${this.opts.maxTasks} 个子任务（已经拆了 ${mine.length} 个）：` +
          `请先用 task_wait 收结果，或 task_cancel 取消不需要的。`,
      );
    }

    const spent = this.spent.get(parentRunId) || { turns: 0, tokens: 0 };
    if (spent.turns >= this.opts.budgetTurns) {
      return refuse(`子任务的轮数预算用完了（本次 ${this.opts.budgetTurns} 轮）：剩下的活请你自己做。`);
    }
    if (spent.tokens >= this.opts.budgetTokens) {
      return refuse(
        `子任务的 token 预算用完了（约 ${spent.tokens} / ${this.opts.budgetTokens}）：剩下的活请你自己做。`,
      );
    }

    const list =
      Array.isArray(allowTools) && allowTools.length
        ? allowTools.map((s) => String(s).trim()).filter(Boolean)
        : this.opts.readonlyTools.slice();

    const id = `t${++this.seq}-${shortId(4)}`;
    /**
     * 每个任务在创建时就有一个「结束」promise。
     * 为什么不用「开始时那个 promise」：排队中的任务还没有 promise，
     * wait 拿到 null 就立刻返回了——于是「等三个」实际只等到两个（踩过）。
     * 这个 promise 从创建起就有效，排队/运行/取消都走同一条路。
     */
    let resolveDone;
    const done = new Promise((resolve) => {
      resolveDone = resolve;
    });
    const record = {
      id,
      title: cleanTitle,
      goal: cleanGoal,
      status: 'queued',
      depth: childDepth,
      allowTools: list,
      cwd: cwd || (parentSession && parentSession.cwd) || this.cfg.cwd,
      parentRunId,
      parentSession: parentSession || null,
      createdAt: Date.now(),
      startedAt: 0,
      endedAt: 0,
      ms: 0,
      turns: 0,
      tokens: 0,
      toolCalls: 0,
      activity: [],
      summary: '',
      error: '',
      stopReason: '',
      controller: null,
      timer: null,
      promise: null,
      done,
      resolveDone,
      /** 已经记到父任务账上的轮数/token（增量记账，避免重复累加） */
      chargedTurns: 0,
      chargedTokens: 0,
    };

    this.tasks.set(id, record);
    this.order.push(id);
    this.queue.push(id); // 进排队，pump() 有空位就开
    if (!this.byParent.has(parentRunId)) this.byParent.set(parentRunId, []);
    this.byParent.get(parentRunId).push(id);

    if (this.log)
      this.log.debug('子任务已创建', { taskId: id, title: record.title, depth: childDepth, allowTools: list });
    this.emit('task:spawned', record);
    this.pump();

    return { ok: true, task: this.view(record) };
  }

  /** 有空位就开下一个（FIFO，保证测试里顺序稳定） */
  pump() {
    while (this.running < this.opts.maxParallel && this.queue.length) {
      const id = this.queue.shift();
      const record = this.tasks.get(id);
      if (!record || record.status !== 'queued') continue;
      this.start(record);
    }
  }

  /** 真正开跑一个任务：开 AbortController、挂超时、调执行器 */
  start(record) {
    record.status = 'running';
    record.startedAt = Date.now();
    this.running += 1;
    this.peakRunning = Math.max(this.peakRunning, this.running);

    const controller = new AbortController();
    record.controller = controller;

    record.timer = setTimeout(() => {
      record.stopReason = 'timeout';
      controller.abort(new Error(`子任务超时（${this.opts.subTimeoutSec}s）`));
    }, this.opts.subTimeoutSec * 1000);
    // 刻意不 unref：有子任务在跑的时候，进程不该「因为没有别的活了」就退出。
    // （之前 unref 过一次，结果单测跑到「等超时」那一节整个进程静默消失——
    //   真实场景里也是同一个道理：用户还在等结果，程序不能先走。）

    this.emit('task:progress', record);

    record.promise = (async () => {
      // 被 abort 时的状态要按「为什么被 abort」如实归档：
      // 超时、超预算、父任务停止、用户取消，界面上是四种不同的故事
      const abortedStatus = () => (record.stopReason === 'timeout' ? 'timeout' : 'aborted');
      try {
        const res = await this.runSubtask(this.view(record), controller.signal, {
          progress: (patch) => this.progress(record, patch),
          activity: (line) => this.activity(record, line),
        });
        this.finish(record, controller.signal.aborted ? abortedStatus() : 'done', res);
      } catch (err) {
        this.finish(record, controller.signal.aborted ? abortedStatus() : 'failed', null, err);
      } finally {
        if (record.timer) clearTimeout(record.timer);
        record.timer = null;
        record.controller = null;
        this.running = Math.max(0, this.running - 1);
        this.pump();
      }
    })();
    // spawn 不 await 它，但异常必须有人接住（否则 unhandledRejection）
    record.promise.catch(() => {});
  }

  /** 执行器报进度：轮数 / token / 工具次数 / 一行活动 */
  progress(record, patch = {}) {
    if (!record || record.endedAt) return;
    if (Number.isFinite(patch.turns)) record.turns = Math.max(record.turns, patch.turns);
    if (Number.isFinite(patch.toolCalls)) record.toolCalls = Math.max(record.toolCalls, patch.toolCalls);
    if (Number.isFinite(patch.tokens)) record.tokens = Math.max(record.tokens, patch.tokens);
    if (patch.activity) this.activity(record, patch.activity);

    // 记到父任务账上：预算按「一次用户消息」算总账
    const spent = this.charge(record);

    // 超预算就地收掉：不然一个子任务就能把这次对话的钱烧光
    if (record.controller && spent.tokens >= this.opts.budgetTokens) {
      record.stopReason = 'budget';
      this.activity(record, `已达 token 预算（${this.opts.budgetTokens}），收掉这个子任务`);
      record.controller.abort(new Error('子任务超出 token 预算'));
    } else if (record.controller && record.turns >= this.opts.subTurns) {
      record.stopReason = 'subTurns';
      this.activity(record, `已达单任务轮数上限（${this.opts.subTurns}），收掉这个子任务`);
      record.controller.abort(new Error('子任务超出单任务轮数上限'));
    }

    this.emit('task:progress', record);
  }

  /**
   * 把当前任务的花费记到它父任务的账上（增量）。
   * progress 和 finish 都要调：只在一处记的话，边跑边报进度的任务和
   * 只在结束时才知道花了多少的任务，账会不一致。
   */
  charge(record) {
    const spent = this.spent.get(record.parentRunId) || { turns: 0, tokens: 0 };
    spent.turns += Math.max(0, record.turns - (record.chargedTurns || 0));
    spent.tokens += Math.max(0, record.tokens - (record.chargedTokens || 0));
    record.chargedTurns = record.turns;
    record.chargedTokens = record.tokens;
    this.spent.set(record.parentRunId, spent);
    return spent;
  }

  activity(record, line) {
    if (!record || !line) return;
    record.activity.push(String(line).slice(0, 160));
    if (record.activity.length > MAX_ACTIVITY) record.activity.splice(0, record.activity.length - MAX_ACTIVITY);
  }

  finish(record, status, res, err) {
    record.status = status;
    record.endedAt = Date.now();
    record.ms = record.startedAt ? record.endedAt - record.startedAt : 0;
    if (res) {
      if (Number.isFinite(res.turns)) record.turns = Math.max(record.turns, res.turns);
      if (Number.isFinite(res.toolCalls)) record.toolCalls = Math.max(record.toolCalls, res.toolCalls);
      if (res.usage && Number.isFinite(res.usage.totalTokens)) {
        record.tokens = Math.max(record.tokens, res.usage.totalTokens);
      }
    }
    // 账在 finish 也要记一次：只在 progress 里记的话，
    // 「跑完才报花费」（或者压根没报过进度）的任务就不进预算了（踩过）
    this.charge(record);

    const text = res ? String(res.text || '').trim() : '';
    if (err) {
      record.error = (err && err.message) || String(err);
      record.summary = text || `（没跑完：${record.error}）`;
    } else if (status !== 'done') {
      /**
       * 超时/中止时，子任务自己给的文本往往是半截话（比如「（被中断）」）。
       * 调度器比它更清楚到底发生了什么，所以**原因写在前面**，
       * 不让一句占位文本把真相盖掉。
       */
      const why = this.stopReasonText(status, record);
      record.summary = text ? `${why} ${text}` : why;
    } else {
      record.summary = text || '（子任务没有产出文本结论）';
    }
    if (record.summary.length > MAX_SUMMARY + 120) record.summary = record.summary.slice(0, MAX_SUMMARY + 120);

    if (this.log) {
      this.log.debug('子任务结束', {
        taskId: record.id,
        status,
        turns: record.turns,
        tokens: record.tokens,
        ms: record.ms,
        error: record.error || undefined,
      });
    }
    this.emit('task:finished', record);
    if (record.resolveDone) record.resolveDone();
  }

  /** 非正常结束时的说明文案 */
  stopReasonText(status, record) {
    if (status === 'timeout') return `（超时：${this.opts.subTimeoutSec}s 内没做完）`;
    if (status === 'failed') return `（失败：${record.error || '未知原因'}）`;
    if (record.stopReason === 'budget') return `（因超出 token 预算被收掉，本期预算 ${this.opts.budgetTokens}）`;
    if (record.stopReason === 'subTurns') return `（因达到单任务轮数上限被收掉，上限 ${this.opts.subTurns} 轮）`;
    if (record.stopReason === 'parent_gone') return '（父任务已结束，被一起收掉）';
    if (record.stopReason === 'parent_aborted') return '（用户停止了主任务，被一起收掉）';
    if (record.stopReason === 'model') return '（被主任务取消）';
    return '（被中止）';
  }

  /**
   * 等一批子任务。
   *
   * 不带 id 时等「这个父任务名下的全部」——因为同一轮里的工具是按顺序执行的
   * （见 agent.js 里对 task_ 工具的串行处理），所以「现在全都」= 「刚才拆的那些」，
   * 不会把后面才拆的也算进来。
   */
  async wait(ids, { parentRunId, timeoutMs = 0, signal } = {}) {
    const wanted =
      Array.isArray(ids) && ids.length
        ? ids.map((id) => this.tasks.get(String(id).trim())).filter(Boolean)
        : (this.byParent.get(parentRunId) || []).map((id) => this.tasks.get(id)).filter(Boolean);

    if (!wanted.length) {
      return { ok: true, tasks: [], note: '没有找到要等的子任务：先用 task_spawn 拆，或者检查 task_id 写错没有。' };
    }

    // 等「结束 promise」而不是「开跑后的 promise」：排队中的任务还没有后者，
    // 用它会让 wait 提前返回（漏掉还在排队/刚开跑的那个）
    const racers = [Promise.all(wanted.map((t) => t.done)).then(() => 'done')];
    let capTimer = null;
    let onAbort = null;
    if (timeoutMs > 0) {
      racers.push(
        new Promise((resolve) => {
          // 刻意不 unref：正在等子任务时进程必须活着。
          // 但**必须**在结束前清掉：不清的话每次 task_wait 都会留下一个
          // 计时器，CLI 用户会看到「答完了还挂在那儿不走」（实测挂满 5 分钟）。
          capTimer = setTimeout(() => resolve('timeout'), timeoutMs);
        }),
      );
    }
    if (signal) {
      racers.push(
        new Promise((resolve) => {
          if (signal.aborted) resolve('abort');
          else {
            onAbort = () => resolve('abort');
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }),
      );
    }
    try {
      await Promise.race(racers);
    } finally {
      if (capTimer) clearTimeout(capTimer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }

    const stillRunning = wanted.filter((t) => t.status === 'running' || t.status === 'queued');
    return {
      ok: true,
      tasks: wanted.map((t) => this.view(t)),
      note: stillRunning.length
        ? `还有 ${stillRunning.length} 个子任务没结束（可能还在跑或超过了本次等待时间）：${stillRunning.map((t) => t.id).join(', ')}`
        : '',
    };
  }

  /** 取消一个子任务 */
  cancel(id, reason = 'user') {
    const record = this.tasks.get(String(id || '').trim());
    if (!record) return { ok: false, error: `没有这个子任务：${id}` };
    if (record.status !== 'running' && record.status !== 'queued') {
      return { ok: false, error: `这个子任务已经结束了（${record.status}），不用取消。` };
    }
    record.stopReason = reason;
    if (record.controller) record.controller.abort(new Error(`子任务被取消（${reason}）`));
    if (record.status === 'queued') {
      // 还没开跑：直接从排队里摘掉
      this.queue = this.queue.filter((x) => x !== record.id);
      record.status = 'aborted';
      record.endedAt = Date.now();
      record.summary = this.stopReasonText('aborted', record);
      this.emit('task:finished', record);
      if (record.resolveDone) record.resolveDone();
    }
    return { ok: true, task: this.view(record) };
  }

  /**
   * 父任务中断/结束时，把它名下的子任务全部收掉。
   *
   * 这是「僵尸子任务」的防线：父任务已经拿到最终答复、或者用户点了停止，
   * 子任务如果还在跑，就会继续烧 token、继续往那个已经安静的会话里推消息。
   */
  cancelAll(parentRunId, reason = 'parent_gone') {
    const ids = this.byParent.get(parentRunId) || [];
    let n = 0;
    for (const id of ids) {
      const record = this.tasks.get(id);
      if (!record) continue;
      if (record.status === 'running' || record.status === 'queued') {
        const r = this.cancel(id, reason);
        if (r.ok) n += 1;
      }
    }
    return n;
  }

  /** 父任务这一轮彻底结束（之后不许再拆） */
  closeParent(parentRunId, reason = 'parent_gone') {
    const n = this.cancelAll(parentRunId, reason);
    this.closedParents.add(parentRunId);
    return n;
  }

  /** 事件统一带父会话对象：Web 层靠 payload.session.id 判断「这条属于哪个会话」 */
  emit(name, record) {
    if (!this.bus) return;
    try {
      const p = this.bus.emit(name, {
        session: record.parentSession,
        parentRunId: record.parentRunId,
        taskId: record.id,
        task: this.view(record),
      });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* 事件推不过去不该影响任务本身 */
    }
  }
}

module.exports = { TaskManager, TASK_DEFAULTS, MAX_SUMMARY, normalizeTasksCfg, createSilentIO };
