'use strict';

/**
 * 梦云 Agent —— 会话管理器（给 Web 界面用的多会话引擎）
 *
 * 职责：
 *   1. 同时管理多个会话，每个会话有自己的消息历史和界面状态
 *   2. 把 agent 运行过程中的事件（流式文本、工具调用、工具结果、token 用量）
 *      整理成前端能直接渲染的「块（block）」序列
 *   3. 通过订阅者回调把事件推给 Web 服务器（SSE）
 *
 * 为什么要有这一层：
 *   agent.js 只关心「把活干完」，它不知道界面长什么样。
 *   这一层负责把 agent 的动作翻译成界面语言，并记住每个会话已经显示了什么。
 *   以后要换成桌面窗口、微信机器人，替换这一层的出口即可。
 */

const fs = require('fs');
const { Session } = require('../session');
const { shortId } = require('../utils');

class SessionManager {
  /**
   * @param {object} app createApp() 返回的应用实例
   */
  constructor(app) {
    this.app = app;
    /** @type {Map<string, object>} sessionId -> 会话记录 */
    this.sessions = new Map();
    /** @type {Set<Function>} 事件订阅者：(sessionId, event) => void */
    this.listeners = new Set();
  }

  /* ---------------------------------------------------------------- */
  /* 订阅（SSE 用）                                                    */
  /* ---------------------------------------------------------------- */

  /** 订阅所有会话事件，返回取消订阅函数 */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * 推送一个事件给所有订阅者；单个订阅者出错不影响其他人。
   *
   * sessionId 统一挂到事件体上：前端只认 ev.sessionId，
   * 之前靠每个调用点自己记得带上，很容易漏（比如插件发来的事件）。
   */
  broadcast(sessionId, event) {
    const payload = event && event.sessionId ? event : { ...event, sessionId };
    for (const fn of this.listeners) {
      try {
        fn(sessionId, payload);
      } catch {
        /* 忽略：前端断了不该影响 agent */
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* 会话生命周期                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * 新建会话。
   * @param {object} [opts]
   * @param {string} [opts.title]
   * @param {string} [opts.cwd] 该会话的工作目录
   */
  create({ title = '', cwd = '' } = {}) {
    const agent = this.app.agent;
    if (!agent) throw new Error('agent 未初始化（缺少模型配置）');

    const sessionCwd = cwd || this.app.cfg.cwd;
    const session = agent.createSession({ title, cwd: sessionCwd });

    const record = {
      id: session.id,
      session,
      cwd: sessionCwd,
      title: title || '新会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      /** 前端渲染用的块序列 */
      blocks: [],
      /** 累计 token */
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      /** 当前上下文规模（估算）与窗口大小，界面上的用量条用它 */
      context: { ...session.context },
      /** 是否正在跑 */
      running: false,
      /** 队列里还排着几条用户消息 */
      queued: 0,
      /** 当前这轮的工具调用队列（用于把 tool:after 结果对回工具卡片） */
      pendingTools: [],
      /** 当前正在写入的助手文本块索引 */
      openTextBlock: -1,
      /** 当前正在写入的思考块索引 */
      openReasoningBlock: -1,
      error: null,
    };

    this.sessions.set(session.id, record);
    this.broadcast(session.id, { type: 'session', session: this.serialize(record) });
    return record;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  /**
   * 恢复一个历史会话（从磁盘读）。
   * 找不到时返回 null，让调用方决定是报错还是新建。
   */
  resume(id) {
    if (this.sessions.has(id)) return this.sessions.get(id);

    const loaded = Session.load(this.app.cfg, id);
    if (!loaded) return null;
    // 老会话可能带着旧的系统提示词（比如插件变了），重新生成一次。
    //
    // 但 agent 是**懒创建**的（界面要能在「还没配模型」时正常打开，
    // 见 server.js 的 ensureAgent）。而恢复历史会话不需要模型，
    // 所以这里 this.app.agent 很可能还是 null——直接调用会抛
    // "Cannot read properties of null (reading 'refreshSystemPrompt')"，
    // 用户看到的就是「点开一个历史会话就报错」。
    //
    // 没模型时不刷新也没关系：真正开跑之前 runOnce() 会再刷一次，
    // 那一次的提示词一定是最新的。
    if (this.app.agent) this.app.agent.refreshSystemPrompt(loaded);

    const record = {
      id: loaded.id,
      session: loaded,
      cwd: loaded.cwd || this.app.cfg.cwd,
      title: loaded.title || '(无标题)',
      createdAt: new Date(loaded.createdAt).getTime() || Date.now(),
      updatedAt: Date.now(),
      blocks: [],
      usage: { ...loaded.usage },
      context: { ...loaded.context },
      running: false,
      queued: 0,
      pendingTools: [],
      openTextBlock: -1,
      openReasoningBlock: -1,
      error: null,
    };
    this.sessions.set(id, record);
    this.broadcast(id, { type: 'assistant_done', text: note('已恢复历史会话。上面的对话是之前保存的。'), done: true });

    // 工作目录有可能在两次运行之间没了。最典型的就是免安装版：
    // 它每次启动都把自己解压到 %TEMP% 下的随机目录，退出后那个目录被清理，
    // 而会话记下的正是它。不提醒的话，用户会看到 agent 的每条命令都失败，
    // 而且失败原因还是误导性的 spawn ENOENT——他只会觉得「软件坏了」。
    if (!fs.existsSync(record.cwd)) {
      this.broadcast(id, {
        type: 'block',
        block: {
          seq: -1,
          type: 'error',
          text:
            `这个会话的工作目录已经不存在了：\n${record.cwd}\n\n` +
            '在它恢复之前，模型读不了文件、也执行不了命令。' +
            '请点左上角「新建会话」，重新选一个真实存在的工作目录。',
        },
      });
    }
    return record;
  }

  /**
   * 归档 / 取消归档。
   *
   * 归档不是删除：会话文件原地保留，只是从主列表收进「已归档」组。
   * 为什么要区分：会话列表会越滚越长，但真正想删掉的没几个——
   * 只给「删」一种手段，用户就只能二选一：要么忍受长列表，要么丢掉历史。
   *
   * 磁盘上的会话（重启后还没加载进内存的那种）也要能归档，
   * 所以内存里没有就走 Session.load → 改标志 → 存回去。
   */
  setArchived(id, archived) {
    const record = this.sessions.get(id);
    if (record) {
      record.archived = archived === true;
      if (record.session) {
        record.session.archived = record.archived;
        record.session.save();
      }
      this.broadcast(id, { type: 'session', session: this.serialize(record) });
      return true;
    }
    // 只在磁盘上的会话
    const loaded = Session.load(this.app.cfg, id);
    if (!loaded) return false;
    loaded.archived = archived === true;
    loaded.save();
    return true;
  }

  /** 删除会话（内存 + 磁盘） */
  remove(id) {
    const record = this.sessions.get(id);
    if (record && record.running) throw new Error('会话正在执行任务，请先中断再删除');

    if (record) this.sessions.delete(id);
    // 磁盘上的记录也一并清掉，避免每次启动都看到。
    // 注意这里的顺序：会话可能只存在于磁盘上（重启之后就是这样），
    // 早期版本遇到这种情况直接返回 false，用户点删除毫无反应。
    const removedFile = Session.removeFile(this.app.cfg, id);
    if (!record && !removedFile) return false;

    this.broadcast(id, { type: 'removed' });
    return true;
  }

  /**
   * 列出所有会话：内存里的 + 磁盘上的历史会话，按更新时间倒序。
   *
   * 为什么必须合并磁盘：内存里的会话是「这次启动碰过的」那几个，
   * 程序一关就没了。而对话其实是落盘的（session.save()），重启后
   * 只返回内存列表的话，用户看到的就是「关闭软件再打开，我的对话全没了」——
   * 数据没丢，只是从来没被列出来过。
   */
  list() {
    const live = [...this.sessions.values()];
    const liveIds = new Set(live.map((r) => r.id));
    const out = live.map((record) => this.serialize(record));

    try {
      for (const item of Session.list(this.app.cfg, 200)) {
        if (liveIds.has(item.id)) continue; // 内存里的更新，以内存为准
        out.push({
          id: item.id,
          title: item.title,
          cwd: item.cwd || this.app.cfg.cwd,
          createdAt: Date.parse(item.createdAt) || Date.parse(item.updatedAt) || Date.now(),
          updatedAt: Date.parse(item.updatedAt) || Date.now(),
          running: false,
          queued: 0,
          archived: item.archived === true,
          usage: item.usage || null,
          context: item.context || null,
          blockCount: item.messageCount || 0,
          error: null,
          /** 只存在于磁盘（还没被这次启动加载）——界面上可以据此区别对待 */
          saved: true,
        });
      }
    } catch {
      /* 读不出磁盘列表不影响内存里的会话 */
    }

    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  /**
   * 用户在设置里改了上下文窗口大小：让内存里的会话立刻按新值重算。
   * 不重算的话，界面上会出现「12k / 128k」这种和设置对不上的数字，
   * 用户会以为设置没生效。
   */
  refreshContextWindow() {
    const { resolveContextWindow } = require('../session');
    const windowSize = resolveContextWindow(this.app.cfg);
    for (const record of this.sessions.values()) {
      record.context = { ...record.context, window: windowSize };
      record.session.context.window = windowSize;
      this.broadcast(record.id, { type: 'context', context: record.context });
    }
  }

  /* ---------------------------------------------------------------- */
  /* 并发控制：同一会话串行，不同会话并行                              */
  /* ---------------------------------------------------------------- */

  /**
   * 给会话发一条消息。
   * 如果这个会话正在跑，消息会排队，等当前这轮结束后自动执行。
   * 这样就不会出现「两条消息同时改同一个文件」的混乱。
   *
   * @returns {{queued:boolean, position:number}}
   */
  send(id, text) {
    const record = this.get(id);
    if (!record) throw new Error(`会话不存在：${id}`);
    const content = String(text || '').trim();
    if (!content) throw new Error('消息内容不能为空');

    if (!record.queue) record.queue = [];
    record.queue.push(content);
    record.queued = record.queue.length;

    const position = record.queue.length;

    if (!record.running) {
      // 不 await：接口立即返回，进度通过事件推送
      this.drain(record).catch((err) => {
        this.pushError(record, err);
      });
    }

    if (position > (record.running ? 0 : 1)) {
      this.broadcast(id, { type: 'queued', text: content, position });
    }
    return { queued: position > 1, position };
  }

  /** 依次处理队列里的消息 */
  async drain(record) {
    if (record.running) return;
    if (!record.queue || !record.queue.length) return;

    record.running = true;
    this.broadcast(record.id, { type: 'status', running: true });

    try {
      while (record.queue.length) {
        const text = record.queue.shift();
        record.queued = record.queue.length;
        // eslint-disable-next-line no-await-in-loop
        await this.runOnce(record, text);
      }
    } finally {
      record.running = false;
      record.pendingTools = [];
      this.broadcast(record.id, { type: 'status', running: false, usage: record.usage });
      this.persist(record);
    }
  }

  /** 真正跑一轮，并把过程中产生的事件翻译成界面块 */
  async runOnce(record, text) {
    const agent = this.app.agent;
    const session = record.session;
    const { createWebIO } = require('./io');

    // 开跑之前一定用**最新**的系统提示词。
    // 会话可能是从磁盘恢复的（带着当时的工作目录、工具列表和插件说明），
    // 而中途可能已经发生：换了模型、改了工作目录、装了或卸了插件。
    // 不刷新的话，模型会照着过期提示词里的路径去猜，工具直接报「越界」。
    agent.refreshSystemPrompt(session);

    record.error = null;
    record.updatedAt = Date.now();

    // ---- 1) 用户消息 ----
    const userBlock = this.pushBlock(record, { type: 'user', text, ts: Date.now() });
    if (record.title === '新会话' || !record.title) {
      record.title = text.replace(/\s+/g, ' ').slice(0, 40);
      this.broadcast(record.id, { type: 'title', title: record.title });
    }

    // 这个会话专属的输出通道和确认闸门
    const runIO = createWebIO({
      onEvent: (event) => this.broadcast(record.id, event),
      confirm: (question, opts) => this.requestApproval(record, question, opts),
    });

    const runState = this.createRunState(record);
    let result;
    try {
      result = await agent.run(session, text, {
        verbose: true,
        io: runIO,
      });
    } finally {
      runState.dispose();
    }

    // ---- 2) 收尾：把还在流式状态的文本块定稿 ----
    this.closeTextBlock(record);

    if (result && result.usage) {
      /**
       * 收尾时更新「权威的三个数字」，但**别把整个对象重建**：
       * result.usage 是会话自己的计量，不含并行子任务那部分（子任务是在
       * task:finished 时单独累加进来的）。重建会把它抹掉——症状是
       * 「明明拆了三个子任务，界面上却看不到它们花了多少」。
       */
      const sessionUsage = (record.session && record.session.usage) || {};
      record.usage = {
        ...(record.usage || {}),
        promptTokens: result.usage.promptTokens || 0,
        completionTokens: result.usage.completionTokens || 0,
        totalTokens: result.usage.totalTokens || 0,
        subtaskTokens: sessionUsage.subtaskTokens || (record.usage && record.usage.subtaskTokens) || 0,
      };
    }

    // ---- 3) 如果这一轮没产生任何可显示的助手文本（比如只调了工具就中断），补一个说明 ----
    const hasAssistantText = record.blocks.some(
      (b) => b.type === 'assistant' && b.ts >= userBlock.ts && b.text.trim(),
    );
    if (!hasAssistantText) {
      const fallback = result && result.aborted ? '（已中断）' : '（模型没有返回文本内容）';
      this.pushBlock(record, { type: 'assistant', text: fallback, ts: Date.now(), muted: true });
    }

    // ---- 4) 汇总 ----
    this.pushBlock(record, {
      type: 'summary',
      ts: Date.now(),
      turns: result ? result.turns : 0,
      toolCalls: result ? result.toolCalls : 0,
      usage: record.usage,
      aborted: !!(result && result.aborted),
    });

    record.updatedAt = Date.now();
    this.broadcast(record.id, { type: 'done', usage: record.usage, session: this.serialize(record) });
  }

  /** 用户要求中断当前任务 */
  abort(id) {
    const record = this.get(id);
    if (!record) return false;
    if (!record.running) return false;
    // 清空排队中的消息，避免中断后又接着跑下一轮
    const dropped = (record.queue || []).length;
    record.queue = [];
    record.queued = 0;
    if (dropped) this.broadcast(id, { type: 'queue_cleared', dropped });
    // 按 id 精确中断：多个会话并行时，无差别 abort 会把别人的任务也停掉
    return this.app.agent ? this.app.agent.abort(id) : false;
  }

  /* ---------------------------------------------------------------- */
  /* 事件 → 界面块                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * 为一次运行挂上事件监听。
   * 用独立的监听函数而不是常驻监听，是为了让每个会话只处理自己的事件——
   * 多个会话同时跑的时候不会互相串台。
   */
  createRunState(record) {
    const bus = this.app.bus;
    const mine = (payload) => !payload || !payload.session || payload.session.id === record.id;

    const onTurnStart = (p) => {
      if (!mine(p)) return;
      this.broadcast(record.id, { type: 'turn_start', turn: p.turn });
    };

    // 流式文本：agent 每收到一段增量就抛这个事件，这里累积成完整文本推给前端
    const onAssistantDelta = (p) => {
      if (!mine(p)) return;
      this.pushTextDelta(record, p.text);
    };

    // 思考过程（推理模型的思维链）。单独成块，不混进正文，
    // 前端会渲染成可折叠的「思考」区域——正文才是用户要看的。
    const onAssistantReasoning = (p) => {
      if (!mine(p)) return;
      this.pushReasoningDelta(record, p.text, p.turn);
    };

    // 每轮请求前的上下文用量（估算）。压缩之后这个数字会掉下来，
    // 用户就能直观看到插件干了活。
    const onTurnContext = (p) => {
      if (!mine(p)) return;
      record.context = { ...record.context, ...(p.context || {}) };
      this.broadcast(record.id, { type: 'context', context: record.context });
    };

    const onContextCompacting = (p) => {
      if (!mine(p)) return;
      // 自动压缩和手动压缩共用一套渲染（见 handleContextEvent）
      this.handleContextEvent(record, 'context:compacting', p);
    };

    // 上下文被压缩：落成一条对话内的记录。
    // 不这么做的话，用户只会看到「上下文用量突然掉了一半」，完全不知道发生过什么。
    const onContextCompacted = (p) => {
      if (!mine(p)) return;
      this.handleContextEvent(record, 'context:compacted', p);
    };

    const onAssistantDone = (p) => {      if (!mine(p)) return;
      this.closeTextBlock(record);
      this.closeReasoningBlock(record);
      if (p.context) {
        record.context = { ...record.context, ...p.context };
        this.broadcast(record.id, { type: 'context', context: record.context });
      }
      const calls = p.toolCalls || [];
      record.pendingTools = [];
      if (calls.length) {
        // 把这一轮要调的工具登记进队列，等执行完再按顺序填结果
        for (const c of calls) {
          record.pendingTools.push({ id: c.id, name: c.name });
          this.pushBlock(record, {
            type: 'tool',
            id: c.id,
            name: c.name,
            args: c.args,
            ok: null, // null = 还没跑完
            ts: Date.now(),
          });
        }
        this.broadcast(record.id, { type: 'tools_planned', count: calls.length });
      }
      // 注意：这里**不**累加 token。累计值由 step:usage 事件给（那是权威值），
      // 两处都加会翻倍——这种错误在界面上看起来只是「数字偏大」，很难发现。
    };

    /**
     * 每一步的 token。
     * 「每一步」= 一次请求模型，包括工具调用之间的那些中间轮。
     * 只报总数不够用：用户想知道的是哪一步开始烧钱了。
     */
    const onStepUsage = (p) => {
      if (!mine(p)) return;
      if (p.cumulative) {
        record.usage = {
          // 保留已有字段（比如 subtaskTokens）：这里只该覆盖「权威的四个数字」，
          // 整个对象重建会把子任务那部分抹掉——实测就是并行跑完之后，
          // 累计值里再也看不到「其中子任务花了多少」
          ...(record.usage || {}),
          promptTokens: p.cumulative.promptTokens || 0,
          completionTokens: p.cumulative.completionTokens || 0,
          totalTokens: p.cumulative.totalTokens || 0,
          calls: p.cumulative.calls || 0,
        };
      }
      if (p.context) record.context = { ...record.context, ...p.context };
      const block = this.pushBlock(record, {
        type: 'step',
        turn: p.turn || 0,
        usage: p.usage || null,
        cumulative: record.usage,
        ms: p.ms || 0,
        ts: Date.now(),
      });
      this.broadcast(record.id, { type: 'usage', usage: record.usage, block });
    };

    const onToolAfter = (p) => {
      /**
       * 只处理 agent 发的那一条（带 session）。
       *
       * tool:after 有**两个**发出点：registry.execute（给插件用，载荷里是 ctx）
       * 和 agent.run（给界面用，载荷里是 session）。两条都处理的话，
       * 「待办工具」队列会被多消费一次：多出来的那次拿不到槽位，于是
       * 凭空造一个工具块，并把**后续**工具的结果安到错误的块上——
       * 实测症状就是「被拒绝的 write 永远停在『进行中』」，
       * 而另一个块显示着它的结果（排查时非常容易被带偏）。
       */
      if (!p || !p.session) return;
      if (p.session.id !== record.id) return;
      record.updatedAt = Date.now();
      /**
       * 优先按**工具调用 id** 精确对上块；只有拿不到 id 时才退回「按顺序取一个」。
       *
       * 为什么必须精确匹配：同一批工具是并行执行的，完成顺序不保证；
       * 再加上 registry 和 agent 两个发出点，靠队列顺序迟早错位——
       * 错位的症状极隐蔽（某个工具块永远停在「进行中」，另一个块显示着
       * 别人的结果）。id 是模型给的，唯一且稳定，用它就没有这类问题了。
       */
      let callId = p.toolCallId || '';
      if (callId) {
        record.pendingTools = record.pendingTools.filter((t) => t.id !== callId);
      } else {
        const slot = record.pendingTools.shift();
        callId = slot ? slot.id : `t${Date.now()}`;
      }
      this.completeToolBlock(record, callId, {
        ok: p.ok !== false,
        summary: p.summary || '',
        ms: p.ms || 0,
        output: p.output || '',
        name: p.toolName || '',
      });
    };

    const onError = (p) => {
      this.pushError(record, p.error || new Error('未知错误'), p.where);
    };

    /**
     * 并行子任务：一个子任务在对话流里是一块（可折叠）。
     *
     * 为什么不复用 tool 块：子任务不是一次工具调用，它有自己的目标、轮数、
     * token 和一段过程（活动记录）。混进工具卡片里，用户根本看不出
     * 「现在有几个活同时在干、谁在等谁」——而这是拆分任务最需要看见的信息。
     */
    const onTaskSpawned = (p) => {
      if (!mine(p)) return;
      this.pushTaskBlock(record, p.task);
    };

    const onTaskProgress = (p) => {
      if (!mine(p)) return;
      this.updateTaskBlock(record, p.task);
    };

    const onTaskFinished = (p) => {
      if (!mine(p)) return;
      this.updateTaskBlock(record, p.task);
      // 子任务花的 token 也是这次对话花的钱，必须计入（否则界面上的累计值会骗人）
      this.addTaskUsage(record, p.task);
    };

    /**
     * 打了 git 检查点 → 在对话里留一块，带「回滚」。
     *
     * 为什么要留在对话流里而不是只在日志里：检查点的意义是「出事了能回去」，
     * 而用户发现出事的那一刻，人正在看这段对话。让他去翻日志、复制 ref、
     * 再回终端敲命令，等于把功能藏起来了。
     */
    const onCheckpoint = (p) => {
      if (!mine(p)) return;
      this.pushBlock(record, {
        type: 'checkpoint',
        ref: p.ref,
        commit: String(p.commit || '').slice(0, 7),
        summary: p.summary || '',
        ts: Date.now(),
      });
    };

    bus.on('turn:start', onTurnStart);
    bus.on('assistant:reasoning', onAssistantReasoning);
    bus.on('assistant:delta', onAssistantDelta);
    bus.on('assistant:done', onAssistantDone);
    bus.on('step:usage', onStepUsage);
    bus.on('turn:context', onTurnContext);
    bus.on('context:compacting', onContextCompacting);
    bus.on('context:compacted', onContextCompacted);
    bus.on('tool:after', onToolAfter);
    bus.on('error', onError);
    bus.on('task:spawned', onTaskSpawned);
    bus.on('task:progress', onTaskProgress);
    bus.on('task:finished', onTaskFinished);
    bus.on('checkpoint', onCheckpoint);

    return {
      dispose: () => {
        bus.off('turn:start', onTurnStart);
        bus.off('assistant:reasoning', onAssistantReasoning);
        bus.off('assistant:delta', onAssistantDelta);
        bus.off('assistant:done', onAssistantDone);
        bus.off('step:usage', onStepUsage);
        bus.off('turn:context', onTurnContext);
        bus.off('context:compacting', onContextCompacting);
        bus.off('context:compacted', onContextCompacted);
        bus.off('tool:after', onToolAfter);
        bus.off('error', onError);
        bus.off('task:spawned', onTaskSpawned);
        bus.off('task:progress', onTaskProgress);
        bus.off('task:finished', onTaskFinished);
        bus.off('checkpoint', onCheckpoint);
      },
    };
  }

  /** 新拆出一个子任务：落一个任务块 */
  pushTaskBlock(record, task) {
    if (!task || !task.id) return null;
    const exists = record.blocks.find((b) => b.type === 'task' && b.taskId === task.id);
    if (exists) return this.updateTaskBlock(record, task);
    return this.pushBlock(record, {
      type: 'task',
      taskId: task.id,
      title: task.title,
      goal: task.goal,
      status: task.status,
      turns: task.turns || 0,
      tokens: task.tokens || 0,
      toolCalls: task.toolCalls || 0,
      allowTools: task.allowTools || [],
      activity: (task.activity || []).slice(-12),
      ms: task.ms || 0,
      summary: task.summary || '',
      error: task.error || '',
      ts: Date.now(),
    });
  }

  /** 子任务有进展/结束了：就地改那块，不新开一块（否则一次任务能刷出上百块） */
  updateTaskBlock(record, task) {
    if (!task || !task.id) return null;
    const block = record.blocks.find((b) => b.type === 'task' && b.taskId === task.id);
    if (!block) return null;
    block.status = task.status;
    block.turns = task.turns || 0;
    block.tokens = task.tokens || 0;
    block.toolCalls = task.toolCalls || 0;
    block.ms = task.ms || 0;
    block.summary = task.summary || '';
    block.error = task.error || '';
    block.activity = (task.activity || []).slice(-12);
    this.broadcast(record.id, { type: 'task_update', seq: block.seq, block });
    return block;
  }

  /**
   * 把子任务的 token 计进这次会话的累计值。
   *
   * 只加总数、另记一个 subtaskTokens：子任务只报总 token（没有入/出拆分），
   * 硬塞进 prompt/completion 会让「入 + 出 = 总」这个等式对不上。
   */
  addTaskUsage(record, task) {
    const tokens = Number(task && task.tokens) || 0;
    if (!tokens) return;
    const session = record.session;
    if (!session.usage) session.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };
    session.usage.totalTokens = (session.usage.totalTokens || 0) + tokens;
    session.usage.subtaskTokens = (session.usage.subtaskTokens || 0) + tokens;
    // record.usage 是给前端序列化的那一份（runOnce 会用 result.usage 覆盖它），
    // 所以这里也要带上 subtaskTokens——只写 session.usage 的话，
    // 界面上看不到「这里面有多少是子任务花的」
    record.usage = {
      ...(record.usage || {}),
      totalTokens: session.usage.totalTokens,
      subtaskTokens: session.usage.subtaskTokens,
    };
    this.broadcast(record.id, {
      type: 'task_usage',
      taskId: task.id,
      usage: record.usage,
      subtaskTokens: session.usage.subtaskTokens,
    });
  }

  /**
   * 手动压缩当前会话的上下文。
   *
   * 走的是插件注册的 /compact 命令——「能力只有一份实现」：
   * 界面按钮和聊天框里的 /compact 是同一段代码，
   * 不会出现「按钮能压、命令不能压」这种两边不一致的情况。
   */
  async compact(record) {
    if (!record) return { ok: false, error: '找不到会话' };
    const plugins = this.app.plugins;
    if (!plugins || typeof plugins.runCommand !== 'function') {
      return { ok: false, error: '插件系统没启用，压缩功能不可用' };
    }
    // 命令的返回值是「给人看的文字」，成功与否要看事件——
    // 插件在失败时会发 context:compact-failed，别去猜那串中文
    let compacted = null;
    let failed = null;
    const run = await plugins.runCommand('compact', '', {
      session: record.session,
      provider: this.app.provider,
      emit: (event, payload) => {
        if (event === 'context:compacted') compacted = payload;
        if (event === 'context:compact-failed') failed = payload;
        return this.handleContextEvent(record, event, payload);
      },
    });

    if (failed) return { ok: false, error: failed.error || '压缩失败' };
    if (!run.ok) return { ok: false, error: run.error || '压缩失败' };
    if (!compacted) {
      return { ok: false, error: typeof run.result === 'string' ? run.result : '这次没有压缩' };
    }
    return {
      ok: true,
      message: typeof run.result === 'string' ? run.result : '已压缩',
      info: compacted,
    };
  }

  /**
   * 压缩/错误类事件的统一处理。
   * 自动压缩（插件挂在 messages:before 里）和手动压缩（按钮）都会走到这里，
   * 所以只写一份，保证两种路径在界面上长得一模一样。
   */
  async handleContextEvent(record, event, payload) {
    const p = payload || {};
    if (event === 'context:compacting') {
      this.broadcast(record.id, {
        type: 'context_compacting',
        used: p.used,
        window: p.window,
        ratio: p.ratio,
        messages: p.messages,
      });
      return;
    }
    if (event === 'context:compacted') {
      record.context = { ...record.context, used: p.used, window: p.window, windowSource: p.windowSource || record.context.windowSource };
      this.pushBlock(record, {
        type: 'compaction',
        removed: p.removed,
        kept: p.kept,
        savedTokens: p.savedTokens,
        elapsedMs: p.elapsedMs,
        summary: p.summary,
        total: p.total,
        used: p.used,
        window: p.window,
        reason: p.reason || 'manual',
        ts: Date.now(),
      });
      this.broadcast(record.id, { type: 'context', context: record.context });
      this.persist(record);
      return;
    }
    if (event === 'error') {
      this.pushError(record, p.error || new Error('未知错误'), p.where || 'plugin');
    }
  }

  /**
   * 请求用户确认一个危险操作。
   * 在对话流里插一张「确认卡片」，同时把请求推给前端弹窗；
   * 用户点允许/拒绝（或超时）之后 Promise 才 resolve。
   */
  async requestApproval(record, question, opts = {}) {
    const approvals = this.app.approvals;
    // 没有闸门（比如纯终端模式）就按默认拒绝处理
    if (!approvals) return false;

    const approved = await approvals.request({
      sessionId: record.id,
      question,
      detail: opts.detail || '',
      defaultValue: opts.defaultValue === true,
    });

    // 把结果也写进对话流，方便事后回溯「用户当时同意了什么」
    this.pushBlock(record, {
      type: 'approval',
      approved,
      question,
      // 带上改动预览：事后能点开看当时到底改了什么（不然只有一句「你允许了」）
      detail: opts.detail || '',
      ts: Date.now(),
    });
    return approved;
  }

  /** 追加一个块并推给前端，返回该块 */
  pushBlock(record, block) {
    const item = { seq: record.blocks.length, ...block };
    record.blocks.push(item);
    this.broadcast(record.id, { type: 'block', block: item });
    return item;
  }

  /** 流式文本：追加或扩展当前的文本块 */
  pushTextDelta(record, fullText) {
    let block = record.openTextBlock >= 0 ? record.blocks[record.openTextBlock] : null;
    if (!block || block.type !== 'assistant' || block.done) {
      block = this.pushBlock(record, { type: 'assistant', text: '', ts: Date.now(), streaming: true });
      record.openTextBlock = record.blocks.length - 1;
    } else {
      block.text = fullText;
      this.broadcast(record.id, { type: 'text', seq: block.seq, text: fullText });
      return;
    }
    block.text = fullText;
    this.broadcast(record.id, { type: 'text', seq: block.seq, text: fullText });
  }

  /** 文本块定稿 */
  closeTextBlock(record) {
    if (record.openTextBlock < 0) return;
    const block = record.blocks[record.openTextBlock];
    if (block) {
      block.streaming = false;
      block.done = true;
      this.broadcast(record.id, { type: 'text_end', seq: block.seq });
    }
    record.openTextBlock = -1;
  }

  /**
   * 思考过程：累积到独立的「思考块」里。
   *
   * 为什么不和正文共用一个块：思考经常很长，而且模型想清楚之后
   * 会另起一段给正式答复。混在一起的话，用户得先读一大段思维链
   * 才能看到答案。分开之后前端可以把它折起来。
   */
  pushReasoningDelta(record, fullThought, turn) {
    let block = record.openReasoningBlock >= 0 ? record.blocks[record.openReasoningBlock] : null;
    if (!block || block.type !== 'reasoning' || block.done) {
      block = this.pushBlock(record, {
        type: 'reasoning',
        text: '',
        turn: turn || 1,
        ts: Date.now(),
        streaming: true,
      });
      record.openReasoningBlock = record.blocks.length - 1;
    }
    block.text = fullThought || '';
    // 思考用字估算：服务商的 usage 里不区分「思考」和「正文」
    block.tokens = Math.ceil(block.text.length / 2);
    block.ms = Date.now() - block.ts;
    this.broadcast(record.id, {
      type: 'reasoning',
      seq: block.seq,
      text: block.text,
      tokens: block.tokens,
      ms: block.ms,
    });
  }

  /** 思考块定稿（模型开始给正文或本轮结束时调用） */
  closeReasoningBlock(record) {
    if (record.openReasoningBlock < 0) return;
    const block = record.blocks[record.openReasoningBlock];
    if (block) {
      block.streaming = false;
      block.done = true;
      block.ms = Date.now() - block.ts;
      this.broadcast(record.id, { type: 'reasoning_end', seq: block.seq, ms: block.ms });
    }
    record.openReasoningBlock = -1;
  }

  /** 工具跑完，回填结果 */
  completeToolBlock(record, callId, result) {
    const matches = record.blocks.filter((b) => b.type === 'tool' && b.id === callId);
    /**
     * 取「还没落定」的那一个（ok === null），而不是第一个。
     *
     * 同一个工具调用 id 可能在不同轮里重复出现——有些网关会复用 id
     * （我们的 mock 就是每轮都叫 call_w）。用 find 拿第一个的话，
     * 后一轮的结果会覆盖前一轮的块：实测症状是「用户明明拒绝了写入，
     * 那个工具块最后却显示成功」，而真正执行的那次停在『进行中』。
     */
    let block = matches.filter((b) => b.ok === null || b.ok === undefined).pop() || matches[matches.length - 1];
    if (!block) {
      block = this.pushBlock(record, {
        type: 'tool',
        id: callId,
        name: result.name || '工具',
        args: {},
        ts: Date.now(),
      });
    }
    block.ok = result.ok;
    block.summary = result.summary;
    block.ms = result.ms;
    block.output = result.output;
    block.pending = false;
    this.broadcast(record.id, { type: 'tool_result', seq: block.seq, block });
  }

  /** 错误也作为一种块显示在对话里，而不是只弹个 alert */
  pushError(record, err, where = '') {
    const message = err && err.message ? err.message : String(err);
    record.error = message;
    this.pushBlock(record, { type: 'error', text: message, where, ts: Date.now() });
    this.broadcast(record.id, { type: 'error', text: message, where });
  }

  /* ---------------------------------------------------------------- */
  /* 存储 / 序列化                                                     */
  /* ---------------------------------------------------------------- */

  persist(record) {
    try {
      record.session.save();
    } catch {
      /* 存盘失败不影响使用 */
    }
  }

  /** 给前端的会话元信息（不含完整消息，减小体积） */
  serialize(record) {
    return {
      id: record.id,
      title: record.title,
      cwd: record.cwd,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      running: record.running,
      queued: record.queued || 0,
      /** 归档：侧栏据此把它收进「已归档」组（见 web/app.js 的工作区树） */
      archived: record.archived === true,
      usage: record.usage,
      context: record.context,
      blockCount: record.blocks.length,
      error: record.error,
    };
  }

  /**
   * 把磁盘上的消息历史还原成界面块。
   * 这样刷新页面后，之前的对话还在。
   */
  history(record) {
    if (record.blocks.length) {
      return { blocks: record.blocks, usage: record.usage, context: record.context, restored: false };
    }

    const blocks = [];
    const messages = record.session.messages || [];

    for (let i = 0; i < messages.length; i += 1) {
      const msg = messages[i];
      if (msg.role === 'user') {
        // 压缩插件注入的摘要不是用户说的话，单独成一类块
        if (msg._compacted) {
          blocks.push({
            seq: blocks.length,
            type: 'compaction',
            removed: msg._compacted.removed || 0,
            kept: 0,
            savedTokens: msg._compacted.savedTokens || 0,
            summary: String(msg.content || '').replace(/^\[上下文压缩\][^\n]*\n+/, ''),
            restored: true,
            ts: msg._ts || Date.now(),
          });
        } else {
          blocks.push({ seq: blocks.length, type: 'user', text: msg.content, ts: msg._ts || Date.now() });
        }
        continue;
      }
      if (msg.role === 'assistant') {
        // 思考内容优先排在这一轮正文之前，和实时渲染的顺序一致
        if (msg._reasoning && String(msg._reasoning).trim()) {
          blocks.push({
            seq: blocks.length,
            type: 'reasoning',
            text: msg._reasoning,
            tokens: Math.ceil(String(msg._reasoning).length / 2),
            ms: 0,
            done: true,
            restored: true,
            ts: msg._ts || Date.now(),
          });
        }
        if (msg.content && String(msg.content).trim()) {
          blocks.push({
            seq: blocks.length,
            type: 'assistant',
            text: msg.content,
            ts: msg._ts || Date.now(),
            done: true,
          });
        }
        // 记录这次要调哪些工具，下一批 tool 消息按顺序对应
        for (const tc of msg.tool_calls || []) {
          const toolMsg = findNextToolMessage(messages, i, tc.id);
          blocks.push({
            seq: blocks.length,
            type: 'tool',
            id: tc.id,
            name: tc.function ? tc.function.name : '工具',
            args: safeParse(tc.function ? tc.function.arguments : '{}'),
            ok: toolMsg ? !/^(错误|工具 .* 执行失败)/.test(String(toolMsg.content || '')) : null,
            summary: toolMsg ? firstLine(toolMsg.content) : '（未执行）',
            output: toolMsg ? String(toolMsg.content || '') : '',
            ms: 0,
            restored: true,
            ts: msg._ts || Date.now(),
          });
        }
        // 这一步花了多少 token 也一并还原：刷新页面后用户还要能看见
        // 「哪一步开始烧钱的」，只在内存里显示的话一刷新就没了
        if (msg._usage) {
          blocks.push({
            seq: blocks.length,
            type: 'step',
            turn: 0,
            usage: {
              promptTokens: msg._usage.promptTokens || 0,
              completionTokens: msg._usage.completionTokens || 0,
              totalTokens: msg._usage.totalTokens || 0,
            },
            ms: msg._usage.ms || 0,
            restored: true,
            ts: msg._ts || Date.now(),
          });
        }
      }
    }

    record.blocks = blocks;
    record.usage = {
      promptTokens: record.session.usage.promptTokens || 0,
      completionTokens: record.session.usage.completionTokens || 0,
      totalTokens: record.session.usage.totalTokens || 0,
    };
    record.context = { ...record.context, ...(record.session.context || {}) };
    return { blocks, usage: record.usage, context: record.context, restored: true };
  }
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function note(text) {
  return text;
}

function firstLine(text) {
  const line = String(text || '').split('\n')[0];
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 从 index 往后找第一个匹配该 tool_call_id 的 tool 消息 */
function findNextToolMessage(messages, index, toolCallId) {
  for (let i = index + 1; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role === 'assistant') return null; // 越过了这一轮，说明没有
    if (m.role === 'tool' && m.tool_call_id === toolCallId) return m;
  }
  return null;
}

module.exports = { SessionManager, shortId };
