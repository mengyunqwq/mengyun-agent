'use strict';

/**
 * 插件：context-compact —— 上下文压缩
 *
 * ── 解决什么问题 ────────────────────────────────────────────────
 * Agent 干活时上下文长得很快：读几个文件、跑几轮工具，几万 token 就没了。
 * 撞上模型上限的后果不是「变慢」，而是接口直接报错，会话进行不下去。
 *
 * 压缩的做法：把**较早的历史**交给模型总结成一段摘要，用摘要替换那一段，
 * 最近几轮原样保留。
 *
 * ── 手动触发，不自动动你的历史 ──────────────────────────────────
 * 早期版本是「用量超过阈值就自动压」。问题是：压缩会改写对话历史，
 * 而用户往往正看着上下文涨、心里有数，突然被压掉一截反而莫名其妙
 * （尤其是正在排查问题时，旧消息里可能还有他要的东西）。
 *
 * 现在是**默认自动压**（阈值 0.62），同时也留着手动：
 *   · 界面上输入区那条用量条旁边有「压缩上下文」按钮
 *   · 也可以发 /compact
 *   · 想纯手动：config.json 里把 compact.auto 改成 false
 *
 * 为什么又改回自动：手动意味着用户得自己盯圆环，而长会话真撞上窗口的代价是
 * 上游直接 400、这一轮白跑。自动的代价是「历史被改写」，所以配了两个约束——
 * 阈值留出余量（0.62，不是贴边才动），以及压缩会在对话里留一条可展开的记录。
 *
 * ── 为什么用「模型总结」而不是直接丢 ─────────────────────────────
 * 直接截断最省事，但会丢掉关键信息：改过哪些文件、定过什么方案、
 * 还有哪些事没做完。模型会在下一轮里重新去读一遍文件，甚至改错地方。
 * 总结一次的成本远低于这个代价。
 *
 * ── 切点为什么这么讲究 ─────────────────────────────────────────
 * OpenAI 协议里 tool 消息必须紧跟着它对应的 assistant(tool_calls)。
 * 从中间随便切一刀，很容易把这一对拆散，服务商直接返回 400。
 * 所以真正动手切的是 session.compactHistory()，它会把切点往后挪到安全位置。
 */

const DEFAULTS = {
  enabled: true,
  /** 是否在超过阈值时自动压缩（默认开；纯手动就设为 false） */
  auto: true,
  /** 自动模式下，上下文用量超过这个比例就压 */
  threshold: 0.62,
  /** 压缩后保留最近多少条消息 */
  keepRecent: 8,
  /** 摘要最多多少 token（写进摘要提示词里约束模型） */
  maxSummaryTokens: 1200,
  /** 消息太少就别压了，压了反而亏 */
  minMessages: 10,
  /** 生成摘要的请求超时（秒） */
  timeoutSec: 60,
};

/** 摘要提示词。要求「密」而不是「短」——目标是接得上活，不是好看 */
const SUMMARY_PROMPT = (targetTokens) => `你在为一个编程 agent 压缩它的对话历史。下面是较早的一段对话，请把它总结成一份接手工作所需的交接说明。

必须保留的信息：
1. 用户的目标和明确提出的要求、约束（原话里的关键措辞要保留）
2. 已经改动的文件路径，以及每个文件改了什么（尽量带函数名/行号范围）
3. 已经确认的技术结论、选定的方案，以及否掉方案的原因
4. 还没做完的事、待验证的假设、已知的风险
5. 报错信息和排查进展

写法要求：
- 用中文，条目式，不要客套话、不要复述显而易见的步骤
- 路径、命令、标识符原样保留，不要意译
- 没提到的信息不要编造；不确定就写「未确认」
- 总长度控制在 ${targetTokens} token 以内

只输出摘要本身，不要加「以下是摘要」这类前言。`;

/** 把一条消息压成一行，方便塞进摘要请求 */
function briefMessage(msg, index) {
  const role = msg.role === 'tool' ? `工具结果(${msg.name || '?'})` : msg.role;
  let body = '';
  if (typeof msg.content === 'string') body = msg.content;
  else if (Array.isArray(msg.content)) {
    body = msg.content.map((part) => (typeof part === 'string' ? part : part && part.text) || '').join(' ');
  }
  if (msg.tool_calls && msg.tool_calls.length) {
    const calls = msg.tool_calls
      .map((tc) => `${(tc.function && tc.function.name) || '?'}(${String((tc.function && tc.function.arguments) || '').slice(0, 400)})`)
      .join(', ');
    body = `${body}\n[调用工具] ${calls}`;
  }
  const clean = String(body || '').replace(/\s+/g, ' ').trim();
  // 单条太长时保留头尾：错误信息往往在尾部
  const max = 1200;
  const text = clean.length > max ? `${clean.slice(0, max / 2)} …（中间省略）… ${clean.slice(-max / 2)}` : clean;
  return `#${index} [${role}] ${text}`;
}

module.exports = {
  name: 'context-compact',
  version: '0.2.0',
  description: '上下文压缩：把较早的历史总结成摘要（默认手动触发）',

  setup(ctx) {
    // getConfig 已经把默认值合并进去了；全局配置的 compact 段优先级更高，
    // 因为 Web 设置界面写的是那一段
    const cfg = { ...DEFAULTS, ...ctx.getConfig(DEFAULTS) };
    const fromGlobal = (ctx.config && ctx.config.compact) || {};
    for (const [key, value] of Object.entries(fromGlobal)) {
      if (value !== undefined && key in DEFAULTS) cfg[key] = value;
    }

    if (cfg.enabled === false) {
      ctx.log('已关闭（config.compact.enabled = false）');
      return;
    }

    const state = {
      compactions: 0,
      lastCompactedAt: 0,
      /** 防止并发触发两次压缩（自动 + 手动可能撞上） */
      busy: false,
    };
    ctx.state.stats = state;

    ctx.log(
      cfg.auto
        ? `已启用：自动模式，用量超过 ${Math.round(cfg.threshold * 100)}% 时压缩，保留最近 ${cfg.keepRecent} 条`
        : `已启用：手动模式（点界面上的「压缩上下文」或发 /compact），保留最近 ${cfg.keepRecent} 条`,
    );

    /**
     * 让模型写摘要。
     * 用单独的一次非流式请求，不占用主对话的轮数。
     */
    async function summarize(provider, messageList, targetTokens) {
      const text = messageList.map((m, i) => briefMessage(m, i)).join('\n\n');
      const reply = await provider.chat({
        messages: [
          { role: 'system', content: SUMMARY_PROMPT(targetTokens) },
          { role: 'user', content: text },
        ],
        tools: [],
        stream: false,
      });
      return String(reply.text || '').trim();
    }

    /**
     * 真正压一次。
     *
     * @param {object} session  要压缩的会话
     * @param {object} provider 用来写摘要的模型客户端
     * @param {object} [opts]
     * @param {string} [opts.reason] 'manual' | 'auto'
     * @param {Function} [opts.emit] 事件出口：(event, payload) => Promise
     * @param {Array}  [opts.messages] 即将发出去的消息（自动模式下用）
     * @returns {Promise<object>} { ok, skipped?, ... }
     */
    async function compact(session, provider, opts = {}) {
      const emit = typeof opts.emit === 'function' ? opts.emit : async () => {};
      if (!session || typeof session.compactHistory !== 'function') {
        return { ok: false, error: '拿不到会话对象，无法压缩' };
      }
      if (!provider) return { ok: false, error: '拿不到模型客户端（provider），无法生成摘要' };
      if (state.busy) return { ok: false, error: '上一次压缩还没结束，请稍候' };

      const list = Array.isArray(opts.messages) && opts.messages.length ? opts.messages : session.toMessages();
      const before = session.measureContext(list);
      const window = before.window || 0;

      const keep = Math.max(2, Math.floor(cfg.keepRecent));
      const compactable = list.length - keep;
      if (compactable < cfg.minMessages) {
        return {
          ok: false,
          error: `消息还太少（现在 ${list.length} 条），压缩了反而更亏。至少要 ${cfg.minMessages + keep} 条。`,
        };
      }

      state.busy = true;
      const startedAt = Date.now();
      try {
        await emit('context:compacting', {
          used: before.used,
          window,
          ratio: window ? before.used / window : 0,
          messages: list.length,
          reason: opts.reason || 'manual',
        });

        // 摘要的输入：准备被替换掉的那一段（不含 system 和最近 keep 条）
        const head = list[0] && list[0].role === 'system' ? 1 : 0;
        const oldPart = list.slice(head, list.length - keep);
        if (oldPart.length < 4) {
          return { ok: false, error: '可压缩的历史太短，跳过' };
        }

        const summary = await summarize(provider, oldPart, cfg.maxSummaryTokens);
        if (!summary || summary.length < 20) {
          ctx.warn('摘要太短，放弃本次压缩（保持原样更安全）');
          return { ok: false, error: '模型给的摘要太短，已放弃（历史保持原样）' };
        }

        const result = session.compactHistory(keep, summary, {
          plugin: 'context-compact',
          elapsedMs: Date.now() - startedAt,
          reason: opts.reason || 'manual',
        });
        if (!result) {
          return { ok: false, error: '找不到安全的切割点，这次没有压缩' };
        }

        const after = session.measureContext(session.toMessages());
        const savedTokens = Math.max(0, before.used - after.used);
        state.compactions += 1;
        state.lastCompactedAt = Date.now();

        const info = {
          removed: result.removed,
          kept: result.kept,
          summary,
          used: after.used,
          window: after.window || window,
          windowSource: after.windowSource || '',
          savedTokens,
          elapsedMs: Date.now() - startedAt,
          total: state.compactions,
          reason: opts.reason || 'manual',
        };
        await emit('context:compacted', info);
        ctx.log(
          `已压缩：${result.removed} 条历史 → 摘要，约省 ${savedTokens} token（${before.used} → ${after.used}）`,
        );
        return { ok: true, ...info, before: before.used };
      } catch (err) {
        // 压缩失败绝不能拖垮正常对话：留着原上下文继续跑就是了。
        // 但也不能静默——要让它以 error 事件露出去，否则用户只会觉得
        // 「压缩好像没生效」却查不到原因。
        ctx.warn(`压缩失败，本次跳过：${err.message}`);
        await emit('error', { error: err, where: 'plugin:context-compact' }).catch(() => {});
        return { ok: false, error: `压缩失败：${err.message}` };
      } finally {
        state.busy = false;
      }
    }

    /* ---------------- 自动模式（默认关闭，见文件头说明） ---------------- */

    if (cfg.auto) {
      ctx.on('messages:before', async (e) => {
        if (state.busy) return;
        if (!e.session || !e.provider) return;
        const before = e.session.measureContext(e.messages);
        if (!before.window) return;
        if (before.used / before.window < cfg.threshold) return;

        const result = await compact(e.session, e.provider, {
          reason: 'auto',
          messages: e.messages,
          emit: e.emit,
        });
        if (!result.ok) return;
        // 用压缩后的真实数组替换掉这次要发的内容
        e.messages.length = 0;
        e.messages.push(...e.session.toMessages());
      });
    }

    /* ---------------- 手动触发 ---------------- */

    ctx.registerCommand('compact', { description: '压缩上下文：把较早的历史总结成摘要' }, async (_input, extra = {}) => {
      const session = extra.session;
      const provider = extra.provider || extra.agent?.provider;
      const emit = typeof extra.emit === 'function' ? extra.emit : async () => {};
      const result = await compact(session, provider, { reason: 'manual', emit });
      if (!result.ok) {
        // 失败必须让调用方**能判断出来**，而不是只从一段中文里猜。
        // 界面上的按钮靠这个事件决定提示成功还是报错。
        await emit('context:compact-failed', { error: result.error, reason: 'manual' });
        return `没有压缩：${result.error}`;
      }
      return [
        `已压缩：${result.removed} 条历史 → 摘要，保留最近 ${result.kept} 条`,
        `上下文约 ${result.before} → ${result.used} token（省了约 ${result.savedTokens}）`,
      ].join('\n');
    });

    ctx.registerCommand('compact_stats', { description: '看上下文压缩的统计' }, async () => {
      const mode = cfg.auto
        ? `自动（用量超过 ${Math.round(cfg.threshold * 100)}% 时触发）`
        : '手动（点「压缩上下文」或发 /compact）';
      return [
        `压缩模式：${mode}`,
        `保留最近 ${cfg.keepRecent} 条消息`,
        `累计压缩：${state.compactions} 次`,
        state.lastCompactedAt
          ? `最近一次：${new Date(state.lastCompactedAt).toLocaleString('zh-CN')}`
          : '最近一次：还没压过',
      ].join('\n');
    });
  },
};
