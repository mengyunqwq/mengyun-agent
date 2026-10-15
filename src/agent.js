'use strict';

/**
 * 梦云 Agent —— Agent 主循环
 *
 * 一句话概括整个 agent 的工作原理：
 *
 *     组装 messages ──▶ 问模型 ──▶ 模型要调工具？
 *                        ▲              │是
 *                        │              ▼
 *                        └──── 执行工具，把结果塞回 messages
 *                                       │否
 *                                       ▼
 *                                    输出最终回答
 *
 * 这个文件就是上面那个圈。别的地方都是给这个圈打辅助。
 */

const ui = require('./ui');
const { Session, buildSystemPrompt } = require('./session');
const { humanMs } = require('./utils');
const { createCheckpoint } = require('./checkpoint');

/**
 * 终端 IO 适配器：把 agent 的输出动作映射到终端界面。
 * 换成 Web 界面时，只要实现同样这几个方法就能整体替换——
 * 这就是为什么 agent.js 里不再直接调 ui.xxx 的原因。
 */
function createTerminalIO(uiModule = ui) {
  return {
    kind: 'terminal',
    spinner: (text) => uiModule.createSpinner(text),
    assistantStart: () => uiModule.raw(`${uiModule.c.bold(uiModule.c.cyan('助手'))} ${uiModule.c.gray('›')} `),
    assistantDelta: (delta) => uiModule.raw(delta),
    assistantEnd: () => uiModule.raw('\n'),
    toolCall: (name, args) => uiModule.toolCall(name, args),
    toolResult: (name, info) => uiModule.toolResult(name, info),
    toolOutput: (text) => uiModule.block(text, { indent: '    ', color: uiModule.c.gray, maxLines: 8 }),
    /**
     * 思考过程。终端里用暗色、缩进、限行打印：
     * 思维链经常很长，全打出来会把正文顶到屏幕外。
     */
    reasoning: (text) => {
      const body = String(text || '').trim();
      if (!body) return;
      uiModule.out(uiModule.c.dim('  ┌ 思考过程'));
      uiModule.block(body, { indent: '  │ ', color: uiModule.c.gray, maxLines: 12 });
      uiModule.out(uiModule.c.dim('  └'));
    },
    warn: (text) => uiModule.log.warn(text),
    dim: (text) => uiModule.log.dim(text),
    summary: (text) => uiModule.out(uiModule.c.gray(`  ── ${text}`)),
    confirm: (question, opts) => uiModule.confirm(question, opts),
    ask: (question) => uiModule.ask(question),
  };
}

class ChatAgent {
  /**
   * @param {object} opts
   * @param {object} opts.cfg       全局配置
   * @param {object} opts.provider  模型服务商实例
   * @param {import('./tools').ToolRegistry} opts.registry 工具注册表
   * @param {import('./plugins').PluginHost} opts.plugins 插件宿主（可选）
   * @param {import('./events').EventBus} opts.bus 事件总线
   * @param {object} [opts.io]      输出适配器，默认走终端
   */
  constructor({ cfg, provider, registry, plugins, bus, io, tasks }) {
    this.cfg = cfg;
    this.provider = provider;
    this.registry = registry;
    this.plugins = plugins;
    this.bus = bus;
    this.io = io || createTerminalIO();
    /**
     * 并行子任务的调度器（可选）。
     * 传进来之后，execution context 里会带上 `tasks`，
     * task_* 那几个工具就是靠它工作的。
     */
    this.tasks = tasks || null;
    /**
     * 正在跑的任务的中断控制器，按会话 id 登记。
     * Web 模式下一个 agent 服务多个会话、可能并行，控制器必须一份一份存；
     * 挂在实例上的单个字段会被并行的另一轮覆盖——「中断 A」实际停掉的是 B。
     */
    this.abortControllers = new Map();
    /**
     * 第几次 run。用来给每一轮生成唯一的 runId（子任务按 runId 归账：
     * 预算、生命周期）。不能用 session.id 当 runId——同一个会话会跑很多轮，
     * 上一轮收尾时把「这一轮结束了」标记到会话 id 上，下一轮就拆不出子任务了。
     */
    this.runSeq = 0;
    /** runId → 这一轮已经打过的 git 检查点（避免一轮里打几十个点） */
    this.checkpoints = new Map();
  }

  /* ---------------------------------------------------------------- */
  /* 会话                                                              */
  /* ---------------------------------------------------------------- */

  /** 新建会话并写入系统提示词 */
  createSession(opts = {}) {
    // 会话可以有自己的工作目录（新建会话时用户选的）。
    // 早期版本这里写死了 cfg.cwd，把传进来的目录直接覆盖掉——
    // 结果就是「选了目录却没生效」，而且在提示词和工具路径上表现出来。
    const session = new Session(this.cfg, { ...opts, cwd: opts.cwd || this.cfg.cwd });
    this.refreshSystemPrompt(session);
    return session;
  }

  /** （重新）生成系统提示词，插件贡献的内容会拼在后面 */
  refreshSystemPrompt(session) {
    const tools = this.registry.list();
    const prompt = buildSystemPrompt(this.cfg, {
      // 提示词里的工作目录必须和这个会话实际用的目录一致，
      // 否则模型会按提示词里的路径去猜（然后工具报「越界」）
      cwd: session.cwd || this.cfg.cwd,
      toolNames: tools.map((t) => t.name),
      pluginHints: this.plugins ? this.plugins.list().map((p) => `- ${p.name}: ${p.description}`) : [],
      extra: this.plugins ? this.plugins.promptExtra() : '',
    });
    session.setSystemPrompt(prompt);
    return prompt;
  }

  /* ---------------------------------------------------------------- */
  /* 中断                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 中断正在跑的任务。
   * @param {string} [sessionId] 传会话 id 就只中断那一个（多会话并行时必须
   *                             按 id 精确中断）；不传则中断全部（终端单会话
   *                             模式的旧用法，保持兼容）。
   */
  abort(sessionId) {
    if (!this.abortControllers.size) return false;
    if (sessionId) {
      const controller = this.abortControllers.get(sessionId);
      if (!controller) return false;
      controller.abort(new Error('用户中断'));
      return true;
    }
    for (const controller of this.abortControllers.values()) {
      controller.abort(new Error('用户中断'));
    }
    return true;
  }

  /** 是否有任务在跑（任意会话） */
  get isRunning() {
    return this.abortControllers.size > 0;
  }

  /* ---------------------------------------------------------------- */
  /* 工具筛选                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 工具太多会浪费 token 还容易让模型选错。
   * 这里做个简单的粗筛：显式 @ 提及的工具优先；超过阈值时按关键词打分取前 N。
   */
  selectTools(userInput, { maxTools = 0 } = {}) {
    const all = this.registry.list();
    if (!maxTools || all.length <= maxTools) return all;

    const text = String(userInput || '').toLowerCase();
    const scored = all.map((t) => {
      let score = 0;
      if (text.includes(t.name.toLowerCase())) score += 10;
      for (const tag of t.tags || []) {
        if (text.includes(String(tag).toLowerCase())) score += 3;
      }
      // 描述里的词命中
      for (const word of t.description.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/)) {
        if (word.length > 3 && text.includes(word)) score += 1;
      }
      if (t.source === 'builtin') score += 0.5; // 内置工具是基本盘，略微加分
      return { tool: t, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxTools).map((s) => s.tool);
  }

  /* ---------------------------------------------------------------- */
  /* 主循环                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * 跑一轮完整对话（可能包含多次工具调用）。
   * @param {Session} session
   * @param {string}  userInput 用户输入
   * @param {object}  [options]
   * @param {boolean} [options.verbose] 是否打印工具调用细节
   * @param {number}  [options.maxTools] 暴露给模型的工具数量上限（0=全部）
   * @param {boolean} [options.parallelTools] 是否并行执行同一轮的多个工具
   * @returns {Promise<{text:string, turns:number, toolCalls:number, usage:object, aborted:boolean}>}
   */
  async run(session, userInput, options = {}) {
    const { verbose = true, maxTools = 0, parallelTools = true, depth = 0 } = options;
    // io 可以按次注入：Web 模式下一个 agent 服务多个会话，
    // 每个会话需要自己的输出通道和确认闸门，所以不能挂在实例上共用。
    const io = options.io || this.io;
    const startedAt = Date.now();
    // 这一轮的标识：子任务的预算、生命周期都挂在它上面
    this.runSeq = (this.runSeq || 0) + 1;
    const runId = `${session.id}#${Date.now().toString(36)}-${this.runSeq}`;

    const controller = new AbortController();
    // 同一会话同时最多一轮在跑（SessionManager 会排队），按会话 id 登记即可
    this.abortControllers.set(session.id, controller);
    const signal = controller.signal;

    session.addUser(userInput);
    if (this.bus) {
      await this.bus.emit('session:start', { sessionId: session.id, cwd: this.cfg.cwd, input: userInput });
    }

    const stats = { toolCalls: 0, turns: 0, text: '', reasoning: '', aborted: false };

    try {
      for (let turn = 1; turn <= this.cfg.maxTurns; turn += 1) {
        stats.turns = turn;
        if (this.bus) await this.bus.emit('turn:start', { turn, session });

        // ---- 1) 组装请求 ----
        let messages = session.toMessages();
        if (this.bus) {
          // 插件可以在这里插入上下文（比如自动附加相关文件内容、压缩旧历史）
          const payload = { messages, session, turn, userInput, provider: this.provider, emit: (e, p, o) => this.bus.emit(e, p, o) };
          await this.bus.emit('messages:before', payload);
          messages = payload.messages;
        }

        // 量一下这次要发出去多少上下文。界面的用量条要用，
        // 而且必须量在插件压缩之后——否则用户看到的还是压缩前的数字。
        const contextInfo = session.measureContext(messages);
        if (this.bus) {
          await this.bus.emit('turn:context', { turn, session, context: contextInfo });
        }

        const tools = this.selectTools(userInput, { maxTools }).map((t) => t.toOpenAI());

        // ---- 2) 问模型（流式） ----
        const spinner = io.spinner(turn === 1 ? '思考中' : `继续推理（第 ${turn} 轮）`);
        let streamed = '';
        let streaming = false;
        let thought = '';
        let thinking = false;
        const streamOn = verbose && io.kind !== 'web';
        if (streamOn) spinner.start();

        // 统一的增量处理：终端直接打印，Web 端通过回调推给前端
        const handleDelta = (delta, full) => {
          streamed = full;
          if (streamOn) {
            if (!streaming) {
              spinner.stop();
              streaming = true;
              io.assistantStart();
            }
            io.assistantDelta(delta);
          }
          if (typeof options.onDelta === 'function') options.onDelta(delta, full);
          if (this.bus) this.bus.emit('assistant:delta', { text: full, delta, turn, session });
        };

        // 思考内容（推理模型的思维链）。终端模式下不逐字刷屏，
        // 攒起来在正文开始前一次性淡色打印——否则一屏都是思考，看不清答案。
        const handleReasoning = (delta, full) => {
          thought = full;
          thinking = true;
          if (typeof options.onReasoning === 'function') options.onReasoning(delta, full);
          // 事件里带上 session：Web 端一个进程服务多个会话，
          // 靠它才能判断这条事件属于哪个会话
          if (this.bus) this.bus.emit('assistant:reasoning', { text: full, delta, turn, session });
        };

        let reply;
        const requestStartAt = Date.now();
        try {
          reply = await this.provider.chat({
            messages,
            tools,
            signal,
            onDelta: handleDelta,
            onReasoning: handleReasoning,
          });
        } catch (err) {
          spinner.stop();
          if (streaming) io.assistantEnd();
          throw err;
        }
        const requestMs = Date.now() - requestStartAt;
        spinner.stop();
        if (streaming) io.assistantEnd();
        // 终端里把思考过程打出来（截断，避免超长思维链淹没正文）
        if (thinking && streamOn && thought.trim() && typeof io.reasoning === 'function') {
          io.reasoning(thought);
        }

        session.recordUsage(reply.usage);
        if (this.bus) {
          await this.bus.emit('assistant:done', {
            text: reply.text,
            reasoning: reply.reasoning || thought || '',
            toolCalls: reply.toolCalls,
            usage: reply.usage,
            context: { ...session.context },
            turn,
          });
        }

        // ---- 每一步的 token ----
        // 只给总数不够用：用户想知道的是「这一步（这次请求）花了多少」，
        // 好判断是模型在绕圈子，还是某个工具输出把上下文撑爆了。
        // 所以每一步都单独报一次，并附上累计值。
        const stepUsage = {
          turn,
          ms: requestMs,
          usage: reply.usage
            ? {
                promptTokens: reply.usage.prompt_tokens || 0,
                completionTokens: reply.usage.completion_tokens || 0,
                totalTokens:
                  reply.usage.total_tokens ||
                  (reply.usage.prompt_tokens || 0) + (reply.usage.completion_tokens || 0),
              }
            : null,
          cumulative: {
            promptTokens: session.usage.promptTokens,
            completionTokens: session.usage.completionTokens,
            totalTokens: session.usage.totalTokens,
            calls: session.usage.calls,
          },
          context: { ...session.context },
          session,
        };
        if (this.bus) await this.bus.emit('step:usage', stepUsage);
        if (verbose && streamOn && stepUsage.usage) {
          io.dim(
            `第 ${turn} 步 · 输入 ${stepUsage.usage.promptTokens} · 输出 ${stepUsage.usage.completionTokens} · ` +
              `累计 ${stepUsage.cumulative.totalTokens} token（${humanMs(requestMs)}）`,
          );
        }

        // ---- 3) 没有工具调用 → 说明模型给最终答案了，收工 ----
        if (!reply.toolCalls || !reply.toolCalls.length) {
          session.addAssistant(reply.text, null, reply.reasoning || thought, reply.usage, requestMs);
          stats.text = reply.text || streamed;
          stats.reasoning = reply.reasoning || thought || '';
          if (this.bus) await this.bus.emit('turn:end', { turn, reason: 'final' });
          break;
        }

        // ---- 4) 有工具调用 → 记录 assistant 消息，然后执行 ----
        session.addAssistant(reply.text, reply.toolCalls, reply.reasoning || thought, reply.usage, requestMs);
        stats.toolCalls += reply.toolCalls.length;

        const results = await this.executeToolCalls(reply.toolCalls, session, {
          verbose,
          parallel: parallelTools,
          signal,
          io,
          depth,
          runId,
        });

        // ---- 5) 把工具结果回填进对话 ----
        for (const r of results) {
          session.addToolResult(r.id, r.name, r.content);
          if (this.bus) {
            await this.bus.emit('tool:after', {
              toolName: r.name,
              // 带上**工具调用 id**：界面靠它精确对上「哪个工具块」。
              // 之前只靠「按顺序取一个待办」，一旦有两个发出点（registry 给插件
              // 发一条、这里给界面发一条）或并发的子任务，队列就会错位——
              // 表现成「被拒绝的工具永远停在执行中」这种查不动的问题。
              toolCallId: r.id,
              ok: r.ok,
              output: r.content,
              summary: r.summary,
              ms: r.ms,
              turn,
              session,
            });
          }
        }

        if (this.bus) await this.bus.emit('turn:end', { turn, reason: 'tool_calls' });

        // ---- 6) 到达轮数上限 ----
        if (turn === this.cfg.maxTurns) {
          const note = `已达到最大工具调用轮数（${this.cfg.maxTurns}），为避免失控我先停下来。已完成的部分见上面的工具输出；可以让我「继续」，或把 config.json 的 maxTurns 调大。`;
          session.addAssistant(note);
          stats.text = note;
          if (verbose) io.warn(note);
        }
      }
    } catch (err) {
      if (signal.aborted) {
        stats.aborted = true;
        const note = '（已中断）';
        if (verbose) io.warn('已中断当前任务');
        stats.text = session.lastAssistantText() || note;
      } else {
        if (this.bus) await this.bus.emit('error', { error: err, where: 'agent.run' });
        throw err;
      }
    } finally {
      // 只摘自己那个：万一同一会话真的叠了两轮（不该发生），别误删后一轮的
      if (this.abortControllers.get(session.id) === controller) {
        this.abortControllers.delete(session.id);
      }

      /**
       * 这一轮结束了 → 把它名下的子任务全部收掉。
       *
       * 这是「僵尸子任务」唯一的防线：父任务已经给出最终答复（用户看到答案了），
       * 子任务却还在后台调模型、烧 token、往已经安静的会话里推事件。
       * 用户点「停止」时也走这里（abort → 抛出来 → finally）。
       */
      if (this.tasks) {
        const n = this.tasks.closeParent(runId, signal.aborted ? 'parent_aborted' : 'parent_gone');
        if (n && this.bus) {
          this.bus.emit('task:cancelled_all', { session, runId, count: n, reason: signal.aborted ? 'parent_aborted' : 'parent_gone' });
        }
      }
      // 这一轮的检查点记录只在这一轮有意义（下一轮要重新打点）
      this.checkpoints.delete(runId);
      const saved = session.save();
      if (this.bus) {
        await this.bus.emit('session:end', {
          sessionId: session.id,
          usage: session.usage,
          context: { ...session.context },
          turns: stats.turns,
          toolCalls: stats.toolCalls,
          elapsedMs: Date.now() - startedAt,
          saved,
        });
      }
    }

    if (verbose) this.printSummary(stats, startedAt, io);
    return { ...stats, usage: session.usage, sessionId: session.id };
  }

  /* ---------------------------------------------------------------- */
  /* 工具执行                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 执行一批工具调用。
   * 同一轮里的多个工具默认并行——模型经常一口气要读 4 个文件，串行会很慢。
   */
  async executeToolCalls(toolCalls, session, { verbose = true, parallel = true, signal, io, depth = 0, runId = '' } = {}) {
    const ctx = this.makeRunContext(session, { signal, verbose, io, depth, runId });

    const runOne = async (tc) => {
      if (signal && signal.aborted) {
        return { id: tc.id, name: tc.name, ok: false, content: '（用户中断，未执行）', summary: '已中断', ms: 0 };
      }
      if (verbose) io.toolCall(tc.name, tc.args);

      const result = await this.registry.execute(tc.name, tc.args, ctx);

      if (verbose) {
        io.toolResult(tc.name, {
          ok: result.ok,
          summary: result.meta.summary || '',
          ms: result.meta.ms,
        });
        // 出错时把细节打出来，用户才知道为什么失败
        if (!result.ok && result.content) {
          io.toolOutput(result.content);
        }
      }
      return {
        id: tc.id,
        name: tc.name,
        ok: result.ok,
        content: result.content,
        summary: result.meta.summary || '',
        ms: result.meta.ms || 0,
      };
    };

    /**
     * 这一轮里只要有一个工具声明了 sequential，就整轮按顺序执行。
     *
     * 典型场景：模型在同一轮里发「spawn A、spawn B、wait」。并行的话
     * wait 会跟两个 spawn 抢跑，读到「任务还不存在」；而并行度本来就放在
     * 子任务里，spawn 是立即返回的，串行几乎不花时间——顺序执行反而是对的。
     */
    const wantsSequential = toolCalls.some((tc) => {
      const tool = this.registry.get(tc.name);
      return !!(tool && tool.sequential);
    });

    if (parallel && toolCalls.length > 1 && !wantsSequential) {
      // allSettled：一个工具炸了不影响其它工具的结果收集
      const settled = await Promise.allSettled(toolCalls.map(runOne));
      return settled.map((s, i) =>
        s.status === 'fulfilled'
          ? s.value
          : {
              id: toolCalls[i].id,
              name: toolCalls[i].name,
              ok: false,
              content: `工具内部异常：${s.reason && s.reason.message}`,
              summary: '内部异常',
              ms: 0,
            },
      );
    }

    const out = [];
    for (const tc of toolCalls) {
      // eslint-disable-next-line no-await-in-loop
      out.push(await runOne(tc));
    }
    return out;
  }

  /** 构造传给工具的运行时上下文 */
  makeRunContext(session, { signal, verbose, io, depth = 0, runId = '' } = {}) {
    const cfg = this.cfg;
    const out = io || this.io;
    return {
      // 用会话自己的工作目录：路径越界检查、相对路径解析都以此为准
      cwd: (session && session.cwd) || cfg.cwd || process.cwd(),
      cfg,
      session,
      signal,
      verbose,
      /**
       * 并行子任务的入口。runId 是「这一轮」的标识（不是会话 id）：
       * 预算和生命周期都按轮算，不然同一会话的第二轮会被上一轮标记成已结束。
       */
      tasks: this.tasks
        ? { manager: this.tasks, depth, runId, session }
        : null,
      /**
       * 动文件之前打一个 git 检查点。
       *
       * 一轮只打一次：同一轮里的连续改动共享同一个回滚点（= 这一轮开始前的状态），
       * 否则一次任务能刷出几十个检查点，回滚时反而不知道该挑哪个。
       * 不是 git 仓库 / 没装 git 时安静返回 { ok:false }，绝不让写入因此失败。
       */
      checkpoint: async (label) => {
        const ckCfg = (cfg && cfg.checkpoint) || {};
        if (ckCfg.enabled === false) return { ok: false, reason: 'disabled' };
        if (this.checkpoints.has(runId)) return this.checkpoints.get(runId);
        const ck = createCheckpoint((session && session.cwd) || cfg.cwd, {
          label: label || '',
          sessionId: (session && session.id) || '',
        });
        this.checkpoints.set(runId, ck);
        if (ck.ok && this.bus) {
          this.bus.emit('checkpoint', { session, runId, ref: ck.ref, commit: ck.commit, summary: ck.summary });
        }
        return ck;
      },
      log: (...a) => out.dim(`    ${a.join(' ')}`),
      confirm: (question, opts) =>
        out.confirm(question, { assumeYes: cfg.assumeYes, defaultValue: false, ...(opts || {}) }),
      ask: out.ask,
      emit: (event, payload, opts) => (this.bus ? this.bus.emit(event, payload, opts) : Promise.resolve(true)),
      registry: this.registry,
      ui,
    };
  }

  /* ---------------------------------------------------------------- */
  /* 输出                                                              */
  /* ---------------------------------------------------------------- */

  printSummary(stats, startedAt, io) {
    const usage = stats.usage || {};
    const parts = [];
    parts.push(`用时 ${humanMs(Date.now() - startedAt)}`);
    parts.push(`${stats.turns} 轮`);
    if (stats.toolCalls) parts.push(`${stats.toolCalls} 次工具调用`);
    if (usage.totalTokens) parts.push(`token ${usage.totalTokens}`);
    (io || this.io).summary(parts.join(' · '));
  }
}

module.exports = { ChatAgent, createTerminalIO };
