'use strict';

/**
 * 梦云 Agent —— 组装层
 *
 * 把配置、模型、工具、插件、事件总线拼成一个可用的 agent。
 * CLI / Web / 脚本都调用这里，保证「入口换皮，内核不变」。
 */

const { loadConfig } = require('./config');
const { EventBus } = require('./events');
const { createProvider } = require('./provider');
const { ToolRegistry } = require('./tools');
const { builtinTools } = require('./tools/builtin');
const { webTools } = require('./tools/web');
const { makeTaskTools } = require('./tools/task');
const { PluginHost } = require('./plugins');
const { ChatAgent } = require('./agent');
const { TaskManager, createSilentIO, normalizeTasksCfg } = require('./tasks');
const { Session } = require('./session');
const { createLogger } = require('./logger');
const ui = require('./ui');
const pkg = require('../package.json');

/**
 * 创建应用实例。
 * @param {object} [opts]
 * @param {object} [opts.cli]           命令行覆盖项
 * @param {string} [opts.cwd]           工作目录（agent 操作文件以此为基准）
 * @param {boolean} [opts.loadPlugins]  是否加载插件，默认 true
 * @param {boolean} [opts.needProvider] 是否必须能创建模型客户端，默认 true
 * @param {boolean} [opts.quiet]        静默模式（不打印插件加载信息）
 */
async function createApp(opts = {}) {
  const { cli = {}, cwd = process.cwd(), loadPlugins = true, needProvider = true, quiet = false } = opts;

  const cfg = loadConfig({ cli: { ...cli, cwd } });
  cfg.cwd = cwd;

  // 结构化日志：控制台照旧，同时往 <工作目录>/.mya/logs/mya.log 写 JSON 行。
  // 出了事「刚才那几十秒发生了什么」能回看——以前只有控制台，关窗即失忆。
  const log = createLogger(cfg);
  log.info('应用组装开始', {
    cwd,
    provider: cfg.provider,
    apiFormat: cfg.apiFormat,
    model: cfg.model,
    reasoning: (cfg.reasoning && cfg.reasoning.level) || 'auto',
    pluginsEnabled: cfg.plugins.enabled,
  });

  const bus = new EventBus();
  const registry = new ToolRegistry(cfg, bus);

  // ---- 内置工具 ----
  const builtinCount = registry.registerAll(builtinTools, 'builtin');

  // ---- 联网搜索（可选的内置工具）----
  // 注册但不一定给模型看：设置里关掉时把它们隐藏起来。
  // 这里刻意不「关掉就不注册」——那样开关一改就得重启进程，
  // 而隐藏位是可逆的，拨一下立刻生效。
  const webCount = registry.registerAll(webTools, 'builtin');
  applyWebToolVisibility(cfg, registry);

  // ---- 插件 ----
  const plugins = new PluginHost(cfg, bus, registry, { ui, runCtx: null, logger: log.child('plugin') });
  let pluginStats = { loaded: 0, failed: 0 };

  if (loadPlugins && cfg.plugins.enabled) {
    pluginStats = await plugins.loadAll();
    for (const record of plugins.list()) {
      log.debug('插件已加载', {
        plugin: record.name,
        version: record.version,
        tools: record.toolNames,
        commands: record.commandNames,
        hooks: [...new Set(record.hookEvents)],
        dir: record.dir,
      });
    }
    for (const err of plugins.errors) {
      log.error('插件加载失败', { plugin: err.plugin, error: err.error, file: err.file });
    }
    if (!quiet) {
      for (const record of plugins.list()) {
        const bits = [`${record.version}`];
        if (record.toolNames.length) bits.push(`工具 ${record.toolNames.length} 个`);
        if (record.commandNames.length) bits.push(`命令 ${record.commandNames.map((c) => `/${c}`).join(' ')}`);
        ui.log.ok(`插件 ${record.name} v${bits[0]} 已加载${bits.length > 1 ? `（${bits.slice(1).join('，')}）` : ''}`);
      }
      for (const err of plugins.errors) {
        ui.log.error(`插件 ${err.plugin} 加载失败：${err.error}`);
        if (process.env.MYA_DEBUG) ui.block(err.stack || '', { indent: '    ' });
      }
    }
  }

  // ---- 模型 ----
  let provider = null;
  if (needProvider) {
    if (!cfg.baseUrl) {
      throw new Error('未配置模型接口地址。请在 config.json 里设置 baseUrl，或设置环境变量 MYA_BASE_URL。');
    }
    if (!cfg.hasApiKey && cfg.provider !== 'ollama') {
      ui.log.warn('未检测到 API Key（MYA_API_KEY）。若接口无需鉴权可忽略；否则会在请求时报 401。');
    }
    /**
     * Key 占位符前置校验。
     *
     * 为什么放在启动时而不是等报错：占位符 Key（模板没替换就复制了 .env）
     * 会把 config.json 里的真 Key 静默覆盖，所有请求在发出前就死在
     * 「请求头编码」上，报错是一句用户读不懂的 ByteString——
     * 这次真实发生过：机器的 .env 里躺着 sk-在这里填你的key，用户查了半天网络。
     * 启动时点名「哪个文件给的值、该怎么改」，一分钟就能修完。
     */
    {
      const { apiKeyIssue } = require('./config');
      const bad = apiKeyIssue(cfg.apiKey);
      if (bad.issue) {
        ui.log.warn(`API Key 有问题（来自 ${cfg.keySource}）：${bad.hint}`);
        ui.log.warn('  去那一层改成真实 Key（形如 sk-xxxx，只含英文数字），或删掉/注释那一行让下层接管。');
      }
    }
    provider = createProvider(cfg);
  }

  const agent = provider ? new ChatAgent({ cfg, provider, registry, plugins, bus }) : null;

  /* ---------------- 并行子任务（复杂任务拆分） ---------------- */
  /**
   * 子任务 = 一个**独立的** ChatAgent，用受限的工具集跑一轮。
   *
   * 为什么要独立实例（而不是复用主 agent 只传白名单）：
   *   · 系统提示词是 `registry.list()` 生成的，共用实例等于告诉子任务
   *     「你有 write/shell」，它就会去调、然后被拒，行为莫名其妙；
   *   · 中断控制器挂在实例上（abortControllers），独立实例的中断
   *     必须由调度器显式级联，共用实例反而更乱。
   * 所以：独立实例 + clone 出来的掩码注册表 + 会话级联取消。
   */
  const tasksCfg = normalizeTasksCfg(cfg);
  const silentIO = createSilentIO();

  /**
   * @param {object} appRef 应用对象本身。
   *   provider 用 appRef.provider 而不是闭包里的变量：web 模式下启动时可能
   *   还没配模型，provider 是用户后来在「设置」里填好 Key 才创建的
   *   （server.js 的 ensureAgent）。闭包捕获会把「后来才有的 provider」永久错过，
   *   表现成「拆分功能永远说执行器没装配」——而它在别的入口又是好的。
   */
  async function runSubtask(appRef, task, signal, hooks) {
    const prov = (appRef && appRef.provider) || provider;
    if (!prov) throw new Error('没有可用的模型客户端，子任务跑不起来');
    const cfgNow = (appRef && appRef.cfg) || cfg;
    const childCfg = {
      ...cfgNow,
      // 子任务比父任务更能跑就荒唐了：轮数取两者的更小值
      maxTurns: Math.max(1, Math.min(cfgNow.maxTurns, tasksCfg.subTurns)),
      // 子任务的历史不落盘：它是过程，不是用户要留档的对话
      // （留档的是父会话里那条工具结果）
      session: { ...(cfgNow.session || {}), save: false },
    };
    const childRegistry = registry.clone(task.allowTools);
    const childSession = new Session(childCfg, { cwd: task.cwd, title: `子任务：${task.title}` });
    const child = new ChatAgent({
      cfg: childCfg,
      provider: prov,
      registry: childRegistry,
      plugins,
      bus,
      io: silentIO,
    });
    child.refreshSystemPrompt(childSession);

    // 子任务的过程不进父对话，但要让界面看得到：把它的进度/工具活动
    // 摘出来喂给调度器，由调度器汇总成「任务块」。
    // 注意载荷形状：registry.execute 发的事件带的是 ctx（会话在 ctx.session 里），
    // agent 自己发的带的是 session。两种都要认，否则活动记录永远是空的。
    const ownerId = (p) => {
      const owner = (p && p.session) || (p && p.ctx && p.ctx.session);
      return owner && owner.id;
    };
    const onTool = (p) => {
      if (ownerId(p) !== childSession.id) return;
      hooks.activity(`${p.ok === false ? '✗' : '▶'} ${p.toolName}`);
    };
    const onStep = (p) => {
      if (ownerId(p) !== childSession.id) return;
      hooks.progress({
        turns: p.turn,
        tokens: (p.cumulative && p.cumulative.totalTokens) || 0,
        activity: p.usage ? `第 ${p.turn} 步 · ${p.usage.totalTokens} token` : '',
      });
    };
    bus.on('tool:after', onTool);
    bus.on('step:usage', onStep);
    try {
      const res = await child.run(childSession, task.goal, {
        verbose: false,
        io: silentIO,
        depth: task.depth,
      });
      return { text: res.text, usage: res.usage, turns: res.turns, toolCalls: res.toolCalls, aborted: res.aborted };
    } finally {
      bus.off('tool:after', onTool);
      bus.off('step:usage', onStep);
    }
  }

  const tasks = new TaskManager({
    cfg,
    bus,
    runSubtask: (task, signal, hooks) => runSubtask(app, task, signal, hooks),
    logger: log.child('task'),
  });
  if (agent) agent.tasks = tasks;

  // 子任务的工具注册进主表（模型通过它们拆分/收结果）。
  // 注意：注册进主表 ≠ 子任务也能用它们——子任务的注册表是 clone 出来的白名单。
  const taskCount = tasksCfg.enabled ? registry.registerAll(makeTaskTools(), 'builtin') : 0;

  log.info('应用组装完成', {
    tools: registry.list().length,
    hiddenTools: registry.list({ includeHidden: true }).length - registry.list().length,
    plugins: plugins.list().length,
    pluginErrors: plugins.errors.length,
    hasProvider: !!provider,
    tasksEnabled: !!(tasksCfg.enabled && provider),
    taskTools: taskCount,
    logFile: log.file,
  });

  /**
   * 应用对象。先建对象再填字段（而不是直接 return 一个字面量），
   * 是为了让 runSubtask 能拿到「同一个 app」——provider 可能在 createApp
   * 之后才被创建（web 模式在设置里填完 Key 才建），闭包变量接不到那次更新。
   */
  const app = {
    cfg,
    log,
    bus,
    registry,
    plugins,
    provider,
    agent,
    tasks,
    taskConfig: tasksCfg,
    version: pkg.version,
    builtinCount: builtinCount + webCount + taskCount,
    webCount,
    taskCount,
    pluginStats,
  };
  return app;
}

/**
 * 按配置决定联网搜索工具对模型可不可见。
 *
 * 单独抽成函数是因为「保存设置」那条路径也要调用它：
 * 用户在设置里拨了开关，必须立刻生效，不能等到下次启动。
 *
 * @param {object} cfg      完整配置
 * @param {import('./tools').ToolRegistry} registry
 * @returns {boolean} 现在是开着还是关着
 */
function applyWebToolVisibility(cfg, registry) {
  const on = !(cfg && cfg.web && cfg.web.enabled === false);
  for (const def of webTools) registry.setHidden(def.name, !on);
  return on;
}

module.exports = { createApp, applyWebToolVisibility };
