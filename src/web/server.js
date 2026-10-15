'use strict';

/**
 * 梦云 Agent —— 本地 Web 服务器（零依赖，只用 Node 内置 http）
 *
 * 它做三件事：
 *   1. 提供网页（web/ 目录下的静态文件，单页应用）
 *   2. 提供 JSON 接口（/api/*）：会话、消息、插件、设置，以及 GitHub 插件市场
 *   3. 用 SSE（/api/events）把 agent 的实时进度推给网页
 *
 * 安全上的取舍：
 *   这是「本地工具」而不是「对外的服务」，所以：
 *   - 默认只监听 127.0.0.1，局域网内其他机器访问不到
 *   - 所有 /api/* 都做 Host / Origin 校验，防止别的网页通过浏览器来操控你的 agent
 *     （这种攻击叫 DNS rebinding / CSRF，本地服务不设防是很常见的坑）
 *   - 真要暴露到局域网时（--host 0.0.0.0），会强制要求一个访问令牌
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { SessionManager } = require('./session-manager');
const { createApprovals } = require('./io');
const { PluginMarket } = require('./plugin-market');
const { makeLanGate, isLoopbackHost } = require('./lan-gate');
const { describeConfig } = require('../config');
const ui = require('../ui');

/** 静态文件的 MIME 类型 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/* ------------------------------------------------------------------ */
/* 响应辅助                                                            */
/* ------------------------------------------------------------------ */

/**
 * 安全响应头（纵深防御）。
 *
 * 前端是手写渲染 + 大量 escapeHtml，没有已知注入；但"每个站点都记得转义"
 * 靠的是纪律，而纪律会松。这些头是零成本的第二道防线：
 *   · CSP：只允许同源脚本；inline 必须放开（index.html 有一段主题初始化脚本、
 *     模板里也有行内 style），所以它不是"防 XSS 的银弹"——但 object/base-uri/
 *     frame-ancestors 一起锁死之后，常见的"塞 iframe、改 base、挂外部脚本"都不成立；
 *   · nosniff：防把 JSON 当脚本执行；
 *   · no-referrer：本机地址不该出现在任何外发请求的 Referer 里；
 *   · DENY：这个界面本来就不该被嵌。
 */
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; " +
    "base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

/** 统一发 JSON。放在模块级，这样 startWebServer 内外的函数都能用 */
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

/** 统一发错误。ok:false 是前端判定失败的依据 */
function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { ok: false, error: String(message), ...extra });
}

/**
 * 启动 Web 界面。
 * @param {object} app createApp() 返回的应用实例
 * @param {object} [opts]
 * @param {number} [opts.port]  0 = 自动选一个空闲端口
 * @param {string} [opts.host]
 * @param {boolean} [opts.open] 是否自动打开浏览器
 */
async function startWebServer(app, opts = {}) {
  const { port = 3080, host = '127.0.0.1', open = false, quiet = false } = opts;
  const webRoot = path.join(__dirname, '..', '..', 'web');
  // 结构化日志：app.log 由 createApp 建好（写了 .mya/logs/mya.log）。
  // 独立调用 startWebServer 的场景（测试里直接拼 app）可能没有，所以判空。
  const log = app && app.log ? app.log.child('web') : null;

  // ---- 组装各层 ----
  const sessions = new SessionManager(app);
  const approvals = createApprovals({ timeoutMs: 5 * 60 * 1000 });
  const market = new PluginMarket(app.cfg, app.plugins, app);

  // 把组装结果挂回 app，插件热重载时要用（刷新所有会话的系统提示词）
  app.sessions = sessions;
  app.approvals = approvals;
  app.market = market;

  /** SSE 客户端 */
  const sseClients = new Set();

  /**
   * 流式事件合帧器。
   *
   * 为什么必须有这层：模型（或工具）一边跑一边吐字，provider 每收到一个
   * 分片就 emit 一次，而每条事件里带的都是「到目前为止的累积全文」。
   * 不合并的话：
   *   - 网络上是 O(n²) 的字节量（第 k 个分片要重发前 k-1 个分片的全部内容）；
   *   - 前端每收到一条就要把整段正文重新解析一遍 Markdown 再重建 DOM，
   *     同样 O(n²)，主线程直接被占满，界面就「卡死」了。
   * 一段脚本日志、一次 npm install、一段长回答都会触发这个雪崩。
   *
   * 做法：只对同一个块（seq）的连续 text / reasoning 事件做压缩，
   * 30ms 之内只保留最后一条（它就是最全的那条），到点或遇到任何
   * 其他类型的事件时立刻冲刷——这样 text_end / block 一定排在文本后面，
   * 前端看到的顺序和不合帧时完全一致。
   */
  const COALESCE_TYPES = new Set(['text', 'reasoning']);
  const COALESCE_MS = 30;

  function makeCoalescer(send) {
    /** key = 会话|类型|块号，值 = 该块最新的一条事件 */
    const pending = new Map();
    let timer = null;

    function flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (!pending.size) return;
      // Map 保持插入顺序，同一块的旧事件已经被新事件覆盖掉了
      const batch = [...pending.values()];
      pending.clear();
      for (const ev of batch) send(ev);
    }

    return {
      push(event) {
        const key =
          COALESCE_TYPES.has(event.type) && event.seq !== undefined
            ? `${event.sessionId}|${event.type}|${event.seq}`
            : null;

        if (!key) {
          // 非流式事件（工具结果、结束、报错…）必须立刻到，
          // 但先把挂起的文本冲出去，免得正文比 text_end 还晚到。
          flush();
          send(event);
          return;
        }

        pending.set(key, event);
        if (!timer) {
          timer = setTimeout(flush, COALESCE_MS);
          // 别让这个定时器把进程钉住不退出
          if (timer.unref) timer.unref();
        }
      },
      flush,
    };
  }

  const coalescer = makeCoalescer((event) => sseSend(sseClients, event));

  sessions.subscribe((sessionId, event) => {
    coalescer.push({ ...event, sessionId });
  });

  approvals.setNotifier((event) => {
    sseSend(sseClients, event);
  });

  /* ---------------------------------------------------------------- */
  /* SSE                                                              */
  /* ---------------------------------------------------------------- */

  function handleSse(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);

    const client = { res, alive: true };
    sseClients.add(client);

    // 心跳：防止代理或浏览器把空闲连接掐掉
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* 连接已经没了，下面的 close 会清理 */
      }
    }, 25000);
    if (ping.unref) ping.unref();

    const cleanup = () => {
      clearInterval(ping);
      sseClients.delete(client);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  function sseSend(clients, event) {
    // 流式正文丢掉一帧不心疼（下一帧就是更全的全文），
    // 但工具结果、报错这些「一次性」事件一帧都不能丢
    const isStreamFrame = COALESCE_TYPES.has(event.type);
    const payload = safeJson(event);
    const frame = `data: ${payload}\n\n`;
    for (const client of clients) {
      try {
        // 背压保护：浏览器来不及消费时 socket 会一直攒数据，
        // 攒到几百 MB 就是内存爆掉 / 整个页面假死。
        // 这里对可丢的流式帧做丢弃，其余照发。
        if (isStreamFrame && client.res.writableLength > 1_000_000) continue;
        client.res.write(frame);
      } catch {
        clients.delete(client);
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* 请求处理                                                          */
  /* ---------------------------------------------------------------- */

  async function readBody(req, maxBytes = 2 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw new Error('请求体过大');
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('请求体不是合法 JSON');
    }
  }

  /**
   * 本机来源校验：只接受本机页面发来的请求。
   *
   * 注意这里**只管本机监听**的情况。局域网监听（--host 0.0.0.0）走令牌闸门
   * （见 lan-gate.js）——那边的判定标准是「有没有令牌」，不是「来源是不是本机」，
   * 因为局域网访问者的 Host 本来就不是本机。以前两条逻辑混在一个函数里，
   * 结果局域网模式下报了「请求来源不是本机页面」这种误导性错误。
   */
  function checkOrigin(req) {
    const hostHeader = req.headers.host || '';
    const hostName = hostHeader.split(':')[0].toLowerCase();

    // 主机头必须是本机：不校验的话，别的网站可以通过你的浏览器
    // 向 127.0.0.1 发请求来操控这个 agent（CSRF / DNS rebinding）
    if (!isLoopbackHost(hostName)) return false;

    const origin = req.headers.origin;
    if (origin) {
      try {
        const parsed = new URL(origin);
        if (!isLoopbackHost(parsed.hostname)) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* 模型可用性                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * 确保 agent 已经创建好。
   *
   * 为什么要有这个函数：界面必须能在「还没配模型」的时候也打开
   * ——否则第一次用的用户会看到一个打不开的窗口，根本没法去配置。
   * 所以 createApp 用 needProvider:false 启动，等用户真的要用的时候
   * 再在这里按当前配置把 agent 建出来。
   *
   * @returns {string} 空字符串表示可用，否则是给用户看的原因
   */
  function ensureAgent() {
    if (app.agent) return '';
    if (!app.cfg.baseUrl) {
      return '还没配置模型接口地址。请在「设置」里填上服务商和 API Key。';
    }
    try {
      const { ChatAgent } = require('../agent');
      const { createProvider } = require('../provider');
      app.provider = createProvider(app.cfg);
      app.agent = new ChatAgent({
        cfg: app.cfg,
        provider: app.provider,
        registry: app.registry,
        plugins: app.plugins,
        bus: app.bus,
        /**
         * 并行子任务调度器必须一起接上。
         *
         * 这里是「延迟创建 agent」的那条路（启动时还没配模型、后来在设置里配好）。
         * 漏掉这一行的话，拆分功能会表现成「永远说调度器没装配」——
         * 而它在 CLI/桌面直连路径上又是好的，排查时极易指错方向。
         */
        tasks: app.tasks || null,
      });
      return '';
    } catch (err) {
      return `模型初始化失败：${err.message}`;
    }
  }

  /** 需要模型才能用的接口，统一先过这一关 */
  function requireAgent(res) {
    const reason = ensureAgent();
    if (reason) {
      sendError(res, 400, reason, { needsSetup: true });
      return false;
    }
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* API 路由                                                          */
  /* ---------------------------------------------------------------- */

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};

    switch (route) {
      /* ---------------- 诊断：结构化日志 ---------------- */
      /**
       * 读最近的结构化日志（JSON 行）。
       *
       * 为什么给一个接口而不是只留文件：程序是「开着窗口一直跑」的，
       * 出问题时用户在界面上，不该再让他去文件系统里翻。
       * 也给 `curl /api/logs?n=50` 这种命令行排查留了出口。
       */
      case 'GET /api/logs': {
        const n = Number(url.searchParams.get('n')) || 100;
        const logger = app.log || null;
        return sendJson(res, 200, {
          ok: true,
          file: logger ? logger.file : '',
          level: logger ? logger.levelName : '',
          lines: logger ? logger.tail(n) : [],
          note: logger ? '' : '结构化日志没启用（app.log 不存在）',
        });
      }

      /* ---------------- 基础信息 ---------------- */
      case 'GET /api/info': {
        // 窗口大小和它的来源要一起给前端：界面上得如实说明
        // 「这个分母是网关给的」还是「按模型名推断的」
        const windowInfo = require('../session').resolveContextWindowInfo(app.cfg);
        return sendJson(res, 200, {
          ok: true,
          version: app.version,
          node: process.version,
          platform: `${process.platform}/${process.arch}`,
          cwd: app.cfg.cwd,
          rootDir: app.cfg.rootDir,
          dataDir: app.cfg.dataDir,
          provider: app.cfg.provider,
          apiFormat: require('../provider').resolveApiFormat(app.cfg).format,
          model: app.cfg.model,
          /**
           * 推理等级：当前值 + 当前协议下的可选档位。
           * 选项由服务端生成（src/reasoning.js），前端照渲染即可——
           * 三家官方的参数名/取值完全不同，两处各写一份迟早对不上。
           */
          reasoning: require('../reasoning').describe(
            app.cfg,
            require('../provider').resolveApiFormat(app.cfg).format,
          ),
          baseUrl: app.cfg.baseUrl,
          assumeYes: app.cfg.assumeYes,
          /**
           * 权限档位（输入区「权限」栏要用）：ask / workspace / full。
           * 放在 info 里而不是只放 settings：这个栏是常驻的，
           * 页面一加载就得知道当前是哪一档，不该等用户点开设置。
           */
          approval: { mode: require('../tools').approvalMode(app.cfg) },
          maxTurns: app.cfg.maxTurns,
          stream: app.cfg.stream,
          /** 上下文窗口大小（token）。界面上的用量条拿它当分母 */
          contextWindow: windowInfo.window,
          /** config=用户配的 / gateway=网关报的 / estimate=按模型名推断 */
          contextWindowSource: windowInfo.source,
          /** 上下文压缩插件的配置，设置界面要显示 */
          compact: app.cfg.compact,
          hasApiKey: app.cfg.hasApiKey,
          autoApprove: app.cfg.tools.autoApprove,
          allowDangerous: app.cfg.shell.allowDangerous,
          toolCount: app.registry.list().length,
          pluginCount: app.plugins.list().length,
          pluginDirs: app.cfg.pluginDirs,
          githubToken: market.authenticated ? '已配置' : '',
          rate: market.rate,
          sessions: sessions.list(),
          approvals: approvals.list(),
        });
      }

      /* ---------------- 设置 ---------------- */
      case 'GET /api/settings':
        return sendJson(res, 200, {
          ok: true,
          config: describeConfig(app.cfg),
          raw: {
            provider: app.cfg.provider,
            apiFormat: app.cfg.apiFormat || 'auto',
            /** 实际会用的协议（选 auto 时是按地址推断出来的那个） */
            resolvedFormat: require('../provider').resolveApiFormat(app.cfg).format,
            model: app.cfg.model,
            reasoning: require('../reasoning').describe(
              app.cfg,
              require('../provider').resolveApiFormat(app.cfg).format,
            ),
            baseUrl: app.cfg.baseUrl,
            temperature: app.cfg.temperature,
            maxTurns: app.cfg.maxTurns,
            stream: app.cfg.stream,
            contextWindow: app.cfg.contextWindow,
            contextWindowSource: require('../session').resolveContextWindowInfo(app.cfg).source,
            compact: app.cfg.compact,
            autoApprove: app.cfg.tools.autoApprove,
            allowDangerous: app.cfg.shell.allowDangerous,
            /** 权限档位：ask / workspace / full（界面输入区的「权限」栏） */
            approval: { mode: require('../tools').approvalMode(app.cfg) },
            web: app.cfg.web,
            assumeYes: app.cfg.assumeYes,
            apiKeyMasked: maskKey(app.cfg.apiKey),
            githubTokenMasked: maskKey(market.token),
          },
          presets: require('../config').PROVIDER_PRESETS,
          /** 可选的接口格式，前端直接拿来渲染下拉框，避免两处写不一样 */
          apiFormats: require('../provider').API_FORMATS,
          pluginDirs: app.cfg.pluginDirs,
          configPath: path.join(app.cfg.rootDir, 'config.json'),
        });

      case 'POST /api/settings':
        return handleSaveSettings(res, body, app, market);

      case 'POST /api/settings/test':
        return handleTestModel(res, body, app);

      /* ---------------- 模型列表 ---------------- */
      case 'POST /api/models':
        return handleListModels(res, body, app);

      /* ---------------- 会话 ---------------- */
      case 'GET /api/sessions':
        return sendJson(res, 200, { ok: true, sessions: sessions.list() });

      case 'POST /api/sessions': {
        if (!requireAgent(res)) return undefined;
        // 新建会话时可以指定工作目录（界面上让用户选）。
        // 目录不存在就明确报错，不要「先建了再说」——否则 agent 后面
        // 每个工具调用都会以越界失败告终，用户根本看不出是目录的问题。
        let cwd = '';
        if (typeof body.cwd === 'string' && body.cwd.trim()) {
          const check = checkDirectory(body.cwd.trim(), { create: !!body.createDir });
          if (!check.ok) return sendError(res, 400, check.error);
          cwd = check.path;
        }
        const record = sessions.create({ title: body.title || '', cwd });
        return sendJson(res, 200, { ok: true, session: sessions.serialize(record) });
      }

      /* ---------------- 工作目录 ---------------- */
      case 'POST /api/fs/check-dir': {
        const check = checkDirectory(String(body.path || '').trim(), { create: !!body.create });
        return sendJson(res, 200, { ok: check.ok, ...check });
      }

      case 'POST /api/fs/mkdir': {
        const target = resolveUserPath(String(body.path || '').trim());
        if (!target) return sendError(res, 400, '路径不能为空');
        try {
          fs.mkdirSync(target, { recursive: true });
          return sendJson(res, 200, { ok: true, path: target });
        } catch (err) {
          return sendError(res, 400, `建不了这个目录：${err.message}`);
        }
      }

      /* ---------------- 工作区文件树（侧栏的「工作区」分区用） ---------------- */
      /**
       * 列出某个目录下的子目录与文件。
       *
       * 和 /fs/check-dir 的区别：那个接口是给「选工作目录」弹窗用的，
       * 调用者有权利看任意盘符；这个接口是给侧栏的文件树用的——
       * **锚定在当前会话的工作目录上**，此时此刻用户在哪个项目里，就只能看哪里。
       * 越界（../、盘符、别的会话的目录）一律 400，不然「侧栏」就成了一个
       * 可以翻遍整块硬盘的入口。
       *
       * 默认过滤 node_modules / .git 这类噪音（和内置工具的 isIgnored 同一份名单），
       * 并给一个上限：谁家也没有 node_modules 里那种几万个文件一次全吐的道理。
       */
      case 'POST /api/fs/list': {
        const id = String(body.sessionId || '');
        const record = id ? sessions.get(id) : null;
        const rootRaw = (record && record.session && record.session.cwd) || app.cfg.cwd || '';
        if (!rootRaw || !fs.existsSync(rootRaw)) {
          return sendJson(res, 200, {
            ok: false,
            missing: true,
            error: `工作目录已经不存在了：${rootRaw || '(空)'}。点左上角「新建会话」重新选一个。`,
          });
        }
        const raw = String(body.path || '').trim() || rootRaw;
        const target = path.resolve(resolveUserPath(raw) || rootRaw);
        const root = path.resolve(rootRaw);
        const rel = path.relative(root, target);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          return sendError(res, 400, `只能查看工作目录（${root}）里面的内容：${target}`);
        }
        if (!fs.existsSync(target)) {
          return sendJson(res, 200, { ok: false, path: target, missing: true, error: '目录不存在（可能被删了或改了名，点刷新看看）' });
        }
        let entries;
        try {
          entries = fs.readdirSync(target, { withFileTypes: true });
        } catch (err) {
          return sendError(res, 400, `读不了这个目录：${err.message}`);
        }
        const isIgnored = require('../utils').isIgnored;
        const cap = Math.min(Math.max(Number(body.limit) || 200, 10), 500);
        const dirs = [];
        const files = [];
        const sorted = entries
          .slice()
          .sort((a, b) => (b.isDirectory() ? 1 : 0) - (a.isDirectory() ? 1 : 0) || a.name.localeCompare(b.name));
        for (const entry of sorted) {
          if (isIgnored(entry.name)) continue;
          const full = path.join(target, entry.name);
          if (entry.isDirectory()) {
            if (dirs.length >= cap) continue;
            dirs.push({ name: entry.name, path: full });
          } else if (entry.isFile()) {
            if (dirs.length + files.length >= cap) continue;
            let size = 0;
            try {
              size = fs.statSync(full).size;
            } catch {
              /* 读不到大小的文件照常显示 */
            }
            files.push({ name: entry.name, path: full, size });
          }
        }
        return sendJson(res, 200, {
          ok: true,
          path: target,
          root,
          dirs,
          files,
          truncated: sorted.length > cap,
        });
      }

      /* ---------------- 手动压缩上下文 ---------------- */
      case 'POST /api/compact': {
        const id = body.sessionId || '';
        const record = sessions.get(id) || sessions.resume(id);
        if (!record) return sendError(res, 404, `找不到会话 ${id}`);
        const run = await sessions.compact(record);
        if (!run.ok) return sendError(res, 400, run.error || '压缩失败');
        // 命令返回的是给人看的文字，结构化结果在事件里（已由 handleContextEvent 落成块）
        return sendJson(res, 200, { ok: true, message: String(run.result || '已压缩'), context: record.context });
      }

      /* ---------------- git 检查点（回滚用） ---------------- */

      case 'GET /api/checkpoints': {
        const ck = require('../checkpoint');
        const cwd = app.cfg.cwd || process.cwd();
        if (!ck.isRepo(cwd)) return sendJson(res, 200, { ok: true, isRepo: false, list: [] });
        return sendJson(res, 200, {
          ok: true,
          isRepo: true,
          root: ck.repoRoot(cwd),
          list: ck.listCheckpoints(cwd, 50),
        });
      }

      case 'POST /api/checkpoint/create': {
        const ck = require('../checkpoint');
        const cwd = app.cfg.cwd || process.cwd();
        const made = ck.createCheckpoint(cwd, { label: body.label || 'manual' });
        if (!made.ok) return sendError(res, 400, `没能打检查点：${made.reason}`);
        ck.pruneCheckpoints(cwd, Number(app.cfg.checkpoint && app.cfg.checkpoint.keep) || 50);
        return sendJson(res, 200, { ok: true, ref: made.ref, commit: made.commit, summary: made.summary });
      }

      case 'POST /api/checkpoint/diff': {
        const ck = require('../checkpoint');
        const cwd = app.cfg.cwd || process.cwd();
        const ref = String(body.ref || '');
        // 只认我们自己的检查点命名空间：这个接口会读 git 对象，不该接受任意 ref
        if (!ref.startsWith(ck.REF_PREFIX)) return sendError(res, 400, 'ref 不合法：只接受本工具创建的检查点');
        if (!ck.listCheckpoints(cwd, 500).some((x) => x.ref === ref)) return sendError(res, 404, '找不到这个检查点');
        const diff = ck.checkpointDiff(cwd, ref);
        return sendJson(res, 200, { ok: true, files: diff.files, stat: diff.stat || '' });
      }

      case 'POST /api/checkpoint/restore': {
        const ck = require('../checkpoint');
        const cwd = app.cfg.cwd || process.cwd();
        const ref = String(body.ref || '');
        /**
         * 两道校验，缺一不可：
         *   1) ref 必须落在本工具的命名空间里 —— 否则等于给了一个「把工作区 checkout 到任意提交」
         *      的接口，那是拿用户仓库开玩笑；
         *   2) ref 必须真的存在于当前工作区的检查点列表里 —— 防止拿别的仓库的 ref 来这边执行。
         */
        if (!ref.startsWith(ck.REF_PREFIX)) return sendError(res, 400, 'ref 不合法：只接受本工具创建的检查点');
        const known = ck.listCheckpoints(cwd, 500);
        if (!known.some((x) => x.ref === ref)) return sendError(res, 404, '找不到这个检查点（可能已经被清理）');
        const done = ck.restoreCheckpoint(cwd, ref);
        if (!done.ok) return sendError(res, 400, `回滚失败：${done.reason}`);
        return sendJson(res, 200, { ok: true, ref, changed: !!done.changed });
      }

      /* ---------------- 工作区（一个文件夹 = 一个工作区） ---------------- */

      case 'GET /api/workspaces': {
        const workspaces = require('../workspaces');
        return sendJson(res, 200, {
          ok: true,
          list: workspaces.list(app.cfg, sessions.list()),
          file: workspaces.storeFile(app.cfg),
        });
      }

      case 'POST /api/workspaces': {
        if (!requireAgent(res)) return undefined;
        const workspaces = require('../workspaces');
        const raw = String(body.path || '').trim();
        if (!raw) return sendError(res, 400, '请选一个文件夹');
        const check = checkDirectory(raw, { create: !!body.create });
        if (!check.ok) return sendError(res, 400, check.error);
        const added = workspaces.add(app.cfg, check.path, { create: !!body.create });
        if (!added.ok) return sendError(res, 400, added.error);
        return sendJson(res, 200, {
          ok: true,
          existed: !!added.existed,
          path: added.path,
          list: workspaces.list(app.cfg, sessions.list()),
        });
      }

      case 'POST /api/workspaces/remove': {
        const workspaces = require('../workspaces');
        const raw = String(body.path || '').trim();
        if (!raw) return sendError(res, 400, '请给出要移除的工作区路径');
        const all = workspaces.list(app.cfg, sessions.list());
        const mine = all.find((w) => workspaces.normalize(w.path) === workspaces.normalize(raw));
        // 有会话就不让移除：移掉了它会立刻被会话的 cwd 带回来（下面 list 的并集规则），
        // 与其做假动作，不如直接说清楚
        const removed = workspaces.remove(app.cfg, raw, mine ? mine.sessionCount : 0);
        if (!removed.ok) return sendError(res, 400, removed.error);
        return sendJson(res, 200, { ok: true, list: workspaces.list(app.cfg, sessions.list()) });
      }

      /* ---------------- API 配置库（多套「服务商+地址+Key+模型」存档与一键切换） ---------------- */
      // 只回掩码、不回明文 Key：防界面被旁看；切换是服务端从库里取真值去用（见 activate）
      case 'GET /api/api-profiles': {
        const profiles = require('../api-profiles');
        const data = profiles.list(app.cfg);
        return sendJson(res, 200, {
          ok: true,
          activeId: data.activeId,
          list: data.profiles.map((p) => profiles.publicView(p, data.activeId)),
        });
      }

      case 'POST /api/api-profiles': {
        const profiles = require('../api-profiles');
        const r = profiles.upsert(app.cfg, body || {});
        if (!r.ok) return sendError(res, 400, r.error);
        const data = profiles.list(app.cfg);
        return sendJson(res, 200, {
          ok: true,
          created: r.created,
          profile: profiles.publicView(r.profile, data.activeId),
          list: data.profiles.map((p) => profiles.publicView(p, data.activeId)),
        });
      }

      case 'POST /api/api-profiles/remove': {
        const profiles = require('../api-profiles');
        const r = profiles.remove(app.cfg, body.id);
        if (!r.ok) return sendError(res, 400, r.error);
        const data = profiles.list(app.cfg);
        return sendJson(res, 200, {
          ok: true,
          activeId: data.activeId,
          list: data.profiles.map((p) => profiles.publicView(p, data.activeId)),
        });
      }

      case 'POST /api/api-profiles/activate': {
        const profiles = require('../api-profiles');
        const act = profiles.activationPayload(app.cfg, body.id);
        if (!act.ok) return sendError(res, 400, act.error);
        profiles.setActive(app.cfg, act.profile.id);
        /**
         * 走「保存设置」那条路，而不是自己改 cfg 字段。
         *
         * 理由：provider 在构造时就把 endpoint / timeout / stream 这些派生状态
         * 算好了，只改 cfg 会出现「界面显示新地址、请求还发到老地方」这种
         * 查半天都找不到的问题（handleSaveSettings 里已有同样注释与处理）。
         */
        return handleSaveSettings(res, act.payload, app, market);
      }

      /**
       * 把**当前生效的配置**存成一条存档。
       * 用户的第一条往往就是这么来的：他刚配好、能用了，先存下来免得以后改坏。
       */
      case 'POST /api/api-profiles/capture': {
        const profiles = require('../api-profiles');
        const r = profiles.upsert(app.cfg, {
          id: body.id || '',                       // 给了 id 就是"用当前值覆盖这一条"
          name: body.name || '',
          provider: app.cfg.provider,
          baseUrl: app.cfg.baseUrl,
          model: app.cfg.model,
          apiFormat: app.cfg.apiFormat || 'auto',
          apiKey: app.cfg.apiKey || '',
        });
        if (!r.ok) return sendError(res, 400, r.error);
        const data = profiles.list(app.cfg);
        return sendJson(res, 200, {
          ok: true,
          created: r.created,
          profile: profiles.publicView(r.profile, data.activeId),
          list: data.profiles.map((p) => profiles.publicView(p, data.activeId)),
        });
      }

      case 'POST /api/sessions/archive': {
        const id = String(body.sessionId || '');
        if (!id) return sendError(res, 400, '缺少 sessionId');
        const archived = body.archived === true;
        const done = sessions.setArchived(id, archived);
        if (!done) return sendError(res, 404, `找不到会话 ${id}`);
        return sendJson(res, 200, { ok: true, archived, sessions: sessions.list() });
      }

      case 'GET /api/history': {
        const id = url.searchParams.get('id') || '';
        const record = sessions.get(id) || sessions.resume(id);
        if (!record) return sendError(res, 404, `找不到会话 ${id}`);
        const data = sessions.history(record);
        return sendJson(res, 200, { ok: true, session: sessions.serialize(record), ...data });
      }

      /* ---------------- 发消息 / 中断 ---------------- */
      case 'POST /api/message': {
        if (!requireAgent(res)) return undefined;
        const id = body.sessionId || '';
        if (!sessions.get(id) && !sessions.resume(id)) return sendError(res, 404, `找不到会话 ${id}`);
        const result = sessions.send(id, body.text);
        return sendJson(res, 200, { ok: true, ...result });
      }

      case 'POST /api/abort': {
        const id = body.sessionId || '';
        // 只拒这个会话挂起的确认：并行的别的会话不受牵连
        approvals.rejectFor(id, '会话已中断');
        const aborted = sessions.abort(id);
        return sendJson(res, 200, { ok: true, aborted });
      }

      case 'POST /api/sessions/delete': {
        const id = body.sessionId || '';
        try {
          const removed = sessions.remove(id);
          return sendJson(res, 200, { ok: true, removed });
        } catch (err) {
          return sendError(res, 400, err.message);
        }
      }

      /* ---------------- 确认闸门 ---------------- */
      case 'POST /api/approve': {
        const { id, approved } = body;
        const ok = approvals.resolve(id, !!approved);
        return sendJson(res, 200, { ok, pending: approvals.list() });
      }

      /* ---------------- 工具 ---------------- */
      case 'GET /api/tools': {
        const tools = app.registry.list().map((t) => ({
          name: t.name,
          description: t.description,
          source: t.source,
          dangerous: t.dangerous,
          autoApproved: (app.cfg.tools.autoApprove || []).includes(t.name),
          tags: t.tags,
          parameters: t.parameters,
        }));
        return sendJson(res, 200, {
          ok: true,
          tools,
          skipped: app.registry.skipped,
          hooks: app.bus.count(),
        });
      }

      /* ---------------- 插件 ---------------- */
      case 'GET /api/plugins':
        return sendJson(res, 200, {
          ok: true,
          plugins: market.list(),
          dirs: app.cfg.pluginDirs,
          loaded: app.plugins.list().length,
          failed: app.plugins.errors.length,
        });

      case 'POST /api/plugins/enable': {
        try {
          const result = await market.enable(body.name);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          return sendError(res, 400, err.message);
        }
      }

      case 'POST /api/plugins/disable': {
        try {
          const result = await market.disable(body.name);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          return sendError(res, 400, err.message);
        }
      }

      case 'POST /api/plugins/uninstall': {
        try {
          const result = await market.uninstall(body.name);
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          return sendError(res, 400, err.message);
        }
      }

      case 'POST /api/plugins/reload': {
        const result = await market.reload();
        return sendJson(res, 200, { ok: true, ...result });
      }

      case 'POST /api/plugins/scaffold': {
        try {
          const { PluginHost } = require('../plugins');
          const created = PluginHost.scaffold(
            market.pluginDir,
            body.name,
            { description: body.description || '', force: !!body.force },
          );
          // 新建的插件默认启用，这是用户自己写的，可信
          const reload = await market.reload();
          return sendJson(res, 200, { ok: true, ...created, reload });
        } catch (err) {
          return sendError(res, 400, err.message);
        }
      }

      /* ---------------- 内置插件市场（完全离线） ---------------- */
      case 'GET /api/market/catalog': {
        try {
          return sendJson(res, 200, {
            ok: true,
            plugins: market.listBundled(),
            bundledDir: app.cfg.bundledPluginDir,
            pluginDir: market.pluginDir,
          });
        } catch (err) {
          return sendError(res, 500, `读取内置插件清单失败：${err.message}`);
        }
      }

      case 'POST /api/market/install-bundled': {
        try {
          const result = await market.installBundled(String(body.name || ''), { enable: !!body.enable });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          return sendError(res, 400, err.message);
        }
      }

      case 'POST /api/market/install-local': {
        // 装本地文件夹 / zip / tar.gz。完全不联网——GitHub 连不上时靠它。
        try {
          const result = await market.installFromPath(String(body.path || ''), {
            enable: !!body.enable,
            name: String(body.pluginName || ''),
          });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          return sendError(res, 400, err.message);
        }
      }

      case 'POST /api/market/check-local': {
        // 安装前先看一眼：这个路径是什么、像不像插件
        const p = resolveUserPath(String(body.path || ''));
        let kind = 'missing';
        let preview = null;
        try {
          const stat = fs.statSync(p);
          if (stat.isDirectory()) {
            kind = 'dir';
            const shape = require('./plugin-market').detectInstalledPluginShape(p);
            preview = {
              ok: shape.ok,
              error: shape.ok ? '' : shape.error,
              entry: shape.entry || '',
              subdirs: listSubdirs(p).length,
            };
          } else {
            kind = /\.zip$/i.test(p) ? 'zip' : /\.(tar\.gz|tgz)$/i.test(p) ? 'tar' : 'other';
          }
        } catch {
          kind = 'missing';
        }
        return sendJson(res, 200, { ok: true, path: p, kind, preview });
      }

      /* ---------------- 插件市场（GitHub） ---------------- */
      case 'POST /api/market/search': {
        try {
          const result = await market.search(body.query, {
            limit: Number(body.limit) || 20,
            onlyPlugins: body.onlyPlugins !== false,
          });
          return sendJson(res, 200, { ok: true, ...result, authenticated: market.authenticated, rate: market.rate });
        } catch (err) {
          return sendError(res, 400, err.message, { rate: market.rate });
        }
      }

      case 'POST /api/market/inspect': {
        try {
          const result = await market.inspect(body.owner, body.name, { ref: body.ref || '' });
          const readme = await market.readme(body.owner, body.name);
          return sendJson(res, 200, { ok: true, ...result, readme: readme.slice(0, 4000) });
        } catch (err) {
          return sendError(res, 400, err.message);
        }
      }

      case 'POST /api/market/install': {
        try {
          const result = await market.install({
            owner: body.owner,
            name: body.name,
            ref: body.ref || '',
            subdir: body.subdir || '',
            pluginName: body.pluginName || '',
            enable: !!body.enable,
          });
          // 插件变了，通知所有页面刷新插件清单
          sseSend(sseClients, { type: 'plugins_changed', reload: result.reload });
          return sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          return sendError(res, 400, err.message);
        }
      }

      default:
        return sendError(res, 404, `没有这个接口：${route}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* 静态文件                                                          */
  /* ---------------------------------------------------------------- */

  function serveStatic(req, res, url) {
    /**
     * 畸形 URL（比如 `/%zz`）会让 decodeURIComponent 抛 URIError。
     * 以前这里没兜住：异常从请求回调里冒出去，被全局兜底接住（进程活着），
     * 但这个请求**永远不回**——连接一直挂着（实测客户端只能超时），
     * 而且静态路径不过闸门，未认证就能触发。
     */
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('请求路径里有无法解析的转义字符（URL 编码不合法）');
      return;
    }
    if (rel === '/' || rel === '') rel = '/index.html';

    // 去掉开头的 /，并把 .. 挡在外面（防目录穿越）
    const safeRel = path
      .normalize(rel)
      .replace(/^([/\\])+/, '')
      .replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.join(webRoot, safeRel);

    if (!filePath.startsWith(webRoot)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stat) => {
      if (err || !stat.isFile()) {
        // 单页应用：找不到的路径一律回 index.html，让前端路由处理
        const fallback = path.join(webRoot, 'index.html');
        if (fs.existsSync(fallback)) {
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
          fs.createReadStream(fallback).pipe(res);
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('找不到 web/index.html，请确认文件完整');
        }
        return;
      }

      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        // 开发时改前端文件能立即看到效果，所以不缓存
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  /* ---------------------------------------------------------------- */
  /* 服务器                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * 局域网模式的令牌闸门。
   *
   * 只在监听非本地地址时启用（loopback 模式靠 Host/Origin 校验就够，
   * 那种情况下「来源不是本机」本身就是拒绝理由）。
   */
  const bindHost = opts.host || '127.0.0.1';
  const lanGate = makeLanGate({
    token: isLoopbackHost(bindHost) ? '' : String(opts.token || ''),
    displayHost: bindHost,
    port,
  });

  const server = http.createServer((req, res) => {
    /**
     * 所有响应（含静态资源与 SSE）统一带上安全头。
     * 写在请求入口而不是每个 writeHead：漏一处等于没防；
     * setHeader 会被后面的 writeHead 合并进去，不会互相覆盖。
     */
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);

    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      res.writeHead(400).end('Bad Request');
      return;
    }

    /**
     * 局域网模式（--host 0.0.0.0）：先过令牌闸门。
     *
     * 这里必须发生在**静态资源之前**——以前静态资源不校验，于是局域网用户能打开
     * 页面、却每个请求都 403，界面看起来"打开了但全都不工作"。
     */
    if (lanGate.enabled) {
      const verdict = lanGate.decide(req, url);
      if (verdict === 'authorize') {
        // 地址栏带了正确令牌：种 cookie，然后跳掉 URL 上的 token
        res.writeHead(302, {
          'Set-Cookie': lanGate.cookieHeader(),
          Location: url.pathname + (url.searchParams.has('__keep') ? '' : ''),
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }
      if (verdict === 'deny') {
        if (url.pathname.startsWith('/api/')) {
          const payload = lanGate.denyJson();
          const text = JSON.stringify(payload);
          res.writeHead(403, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': Buffer.byteLength(text),
          });
          res.end(text);
        } else {
          const html = lanGate.denyPage(req.headers.host || '');
          res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(html);
        }
        return;
      }
    }

    if (url.pathname.startsWith('/api/')) {
      if (!lanGate.enabled && !checkOrigin(req)) {
        sendError(res, 403, '拒绝访问：请求来源不是本机页面');
        return;
      }
      if (url.pathname === '/api/events') {
        handleSse(req, res);
        return;
      }
      // 同步抛错也要兜住：任何一个接口写崩了都不该让整个服务挂掉
      try {
        Promise.resolve(handleApi(req, res, url)).catch((err) => onRequestError(res, err));
      } catch (err) {
        onRequestError(res, err);
      }
      return;
    }

    serveStatic(req, res, url);
  });

  function onRequestError(res, err) {
    const message = err && err.message ? err.message : String(err);
    try {
      if (!res.headersSent) sendError(res, 500, `服务端处理出错：${message}`);
      else res.end();
    } catch {
      /* 响应已经废了，忽略 */
    }
    // 打日志但不退出：本地服务挂掉会让人很困惑
    if (!quiet) ui.log.error(`接口处理出错：${message}`);
    // 结构化留痕：接口 500 是最需要事后回看的一类事件
    if (log) log.error('接口处理出错', { message, stack: (err && err.stack) || '' });
    if (process.env.MYA_DEBUG && err && err.stack) ui.block(err.stack, { indent: '    ' });
  }

  server.bindHost = host;
  server.token = opts.token || '';

  // 最后一道保险：任何漏网的异步异常都不该让服务进程悄悄死掉。
  // 对一个「开着窗口一直跑」的本地服务来说，静默退出是最让人困惑的失败方式。
  const onFatal = (err) => {
    const message = err && err.message ? err.message : String(err);
    ui.log.error(`运行中出现未捕获的异常：${message}`);
    if (process.env.MYA_DEBUG && err && err.stack) ui.block(err.stack, { indent: '    ' });
    ui.log.dim('  服务仍在运行。如果界面出现异常，刷新页面即可；反复出现请把上面信息反馈。');
  };
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);

  // ---- 端口占用时自动换一个 ----
  const actualPort = await listenWithFallback(server, port, host);

  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const url = `http://${displayHost}:${actualPort}${server.token ? `/?token=${server.token}` : ''}`;

  ui.log.ok(`界面已启动：${url}`);
  if (log) {
    log.info('界面服务已启动', {
      url,
      host,
      port: actualPort,
      tokenRequired: !!server.token,
      logFile: log.file,
    });
  }
  if (host === '0.0.0.0') {
    ui.log.warn('已监听 0.0.0.0（局域网可访问）。请确保你信任所在网络。');
  }
  ui.log.dim('  按 Ctrl+C 停止服务');

  if (open) openBrowser(url);

  return { server, port: actualPort, url, sessions, market, approvals, close: () => server.close() };
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

/** 端口被占用就往后试几个，最多试 20 个 */
function listenWithFallback(server, startPort, host) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryListen = (port) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && attempt < 20) {
          attempt += 1;
          tryListen(port + 1);
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };
    tryListen(startPort);
  });
}

/* ------------------------------------------------------------------ */
/* 工作目录相关的小工具                                                */
/* ------------------------------------------------------------------ */

/**
 * 把用户填的目录变成绝对路径。
 *
 * 为什么允许相对路径和 ~：用户手打路径时经常只写一半（`D:\code`、`~/work`），
 * 直接丢给 fs 会得到一个「相对于服务进程当前目录」的路径——那是程序自己的
 * 目录，不是用户以为的那个，最后表现成「选了目录但 agent 在别处干活」。
 */
function resolveUserPath(input) {
  const raw = String(input || '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw) return '';
  let p = raw;
  if (p === '~') p = require('os').homedir();
  else if (p.startsWith('~/') || p.startsWith('~\\')) p = path.join(require('os').homedir(), p.slice(2));
  return path.resolve(p);
}

/** 列出某个目录下的子目录（给界面上的目录选择器用） */
function listSubdirs(dirPath) {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((d) => {
        try {
          return d.isDirectory();
        } catch {
          return false;
        }
      })
      .map((d) => d.name)
      .filter((n) => !n.startsWith('.'))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, 300);
  } catch {
    return [];
  }
}

/**
 * 检查一个目录能不能当工作目录用。
 * @param {string} input 用户填的路径
 * @param {{create?:boolean}} [opts] create=true 时目录不存在就建出来
 */
function checkDirectory(input, { create = false } = {}) {
  const target = resolveUserPath(input);
  if (!target) return { ok: false, error: '请填一个目录路径' };

  let stat = null;
  try {
    stat = fs.statSync(target);
  } catch {
    stat = null;
  }

  if (!stat) {
    if (create) {
      try {
        fs.mkdirSync(target, { recursive: true });
        return { ok: true, path: target, created: true, parent: path.dirname(target), dirs: listSubdirs(target) };
      } catch (err) {
        return { ok: false, error: `目录不存在，而且建不出来：${err.message}`, path: target, missing: true };
      }
    }
    // 不存在时把父目录列出来，用户就能看清自己到底打错在哪一级
    const parent = path.dirname(target);
    const parentExists = fs.existsSync(parent);
    return {
      ok: false,
      path: target,
      missing: true,
      parent,
      dirs: parentExists ? listSubdirs(parent) : [],
      error: parentExists
        ? `这个目录不存在：${target}（父目录 ${parent} 是存在的，看看是不是名字打错了）`
        : `这个目录不存在：${target}`,
    };
  }

  if (!stat.isDirectory()) {
    return { ok: false, path: target, error: `这不是目录，是个文件：${target}` };
  }
  return { ok: true, path: target, parent: path.dirname(target), dirs: listSubdirs(target) };
}

/** 保存设置到 config.json（只改白名单里的字段，不碰用户的其他配置） */function handleSaveSettings(res, body, app, market) {
  const fsMod = fs;
  const configPath = path.join(app.cfg.rootDir, 'config.json');
  let json = {};
  try {
    json = JSON.parse(fsMod.readFileSync(configPath, 'utf8'));
  } catch {
    json = {};
  }

  const s = body || {};

  if (typeof s.provider === 'string' && s.provider) json.provider = s.provider;
  // 接口格式：auto 或已知的几种，其余忽略（不写坏配置）
  if (typeof s.apiFormat === 'string' && s.apiFormat) {
    const { FORMAT_KEYS } = require('../provider');
    const want = s.apiFormat.toLowerCase();
    if (want === 'auto' || FORMAT_KEYS.includes(want)) json.apiFormat = want;
  }
  if (typeof s.model === 'string') json.model = s.model;
  if (typeof s.baseUrl === 'string') json.baseUrl = s.baseUrl.replace(/\/+$/, '');
  if (s.temperature !== undefined && s.temperature !== '') json.temperature = Number(s.temperature);
  if (s.maxTurns !== undefined && s.maxTurns !== '') json.maxTurns = Math.max(1, Number(s.maxTurns));
  if (typeof s.stream === 'boolean') json.stream = s.stream;
  if (typeof s.apiKey === 'string' && s.apiKey && !s.apiKey.includes('***')) json.apiKey = s.apiKey;

  if (Array.isArray(s.autoApprove)) json.tools = { ...(json.tools || {}), autoApprove: s.autoApprove };
  if (typeof s.allowDangerous === 'boolean') json.shell = { ...(json.shell || {}), allowDangerous: s.allowDangerous };

  /**
   * 权限档位：只接受三个已知取值。
   *
   * 写错就忽略（而不是落一个未知值到配置里）：未知档位在工具层会退回 'ask'，
   * 但如果它被写进 config.json，用户下次看到的是一个「我明明设了完全权限，
   * 怎么还在问」的悬案——不如直接不落盘。
   */
  if (s.approval && typeof s.approval === 'object' && s.approval.mode !== undefined) {
    const { APPROVAL_MODES } = require('../tools');
    const mode = String(s.approval.mode);
    if (APPROVAL_MODES.includes(mode)) json.approval = { ...(json.approval || {}), mode };
  }

  // 联网搜索：能不能出网、走哪个后端。
  // provider 只接受已知的三种，写错就忽略——免得一个手滑把搜索彻底弄坏，
  // 而用户只看得到「就是搜不出来」。
  if (s.web && typeof s.web === 'object') {
    const next = { ...(json.web || {}) };
    if (typeof s.web.enabled === 'boolean') next.enabled = s.web.enabled;
    if (typeof s.web.provider === 'string' && ['bing', 'duckduckgo', 'custom'].includes(s.web.provider)) {
      next.provider = s.web.provider;
    }
    if (typeof s.web.endpoint === 'string') next.endpoint = s.web.endpoint.trim();
    if (s.web.timeoutSec !== undefined && s.web.timeoutSec !== '') {
      next.timeoutSec = Math.max(3, Math.min(120, Math.floor(Number(s.web.timeoutSec) || 15)));
    }
    json.web = next;
  }

  // 上下文：窗口大小（0=按模型自动推断）与压缩策略
  if (s.contextWindow !== undefined && s.contextWindow !== '') {
    const n = Math.max(0, Math.floor(Number(s.contextWindow) || 0));
    json.contextWindow = n;
  }
  // 推理等级：只接受已知取值（auto/low/medium/high/minimal），
  // 写错就忽略——手滑写个 "max" 进去，最后会变成一个发给服务端的野字段
  if (s.reasoning && typeof s.reasoning === 'object' && s.reasoning.level !== undefined) {
    const level = require('../reasoning').normalize(s.reasoning.level);
    json.reasoning = { ...(json.reasoning || {}), level };
  }
  if (s.compact && typeof s.compact === 'object') {    const next = { ...(json.compact || {}) };
    if (typeof s.compact.enabled === 'boolean') next.enabled = s.compact.enabled;
    // auto=true 才自动压；默认是「按键才压」
    if (typeof s.compact.auto === 'boolean') next.auto = s.compact.auto;
    if (s.compact.threshold !== undefined && s.compact.threshold !== '') {
      // 阈值限定在 0.3~0.95：太低会一直压缩（拖慢每一轮），太高就来不及了
      next.threshold = Math.min(0.95, Math.max(0.3, Number(s.compact.threshold)));
    }
    if (s.compact.keepRecent !== undefined && s.compact.keepRecent !== '') {
      next.keepRecent = Math.max(2, Math.min(100, Math.floor(Number(s.compact.keepRecent))));
    }
    json.compact = next;
  }

  // GitHub Token 单独存，不参与模型配置
  let tokenChanged = false;
  if (typeof s.githubToken === 'string') {
    const value = s.githubToken.trim();
    if (value === '') {
      json.githubToken = '';
      tokenChanged = true;
    } else if (!value.includes('***')) {
      json.githubToken = value;
      tokenChanged = true;
    }
  }

  // 写配置。打包版曾经因为把配置目录解析到了只读的 app.asar 里而报
  // ENOENT，用户只看到一句「no such file or directory」，完全不知道该干什么。
  // 所以这里把失败拦下来，翻译成能照着做的提示。
  try {
    fsMod.writeFileSync(configPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  } catch (err) {
    const insideAsar = /[\\/]app\.asar[\\/]?/i.test(configPath);
    return sendError(
      res,
      500,
      `配置写入失败：${err.message}\n\n目标文件：${configPath}\n` +
        (insideAsar
          ? '这个路径在程序包内部（app.asar），是只读的。重启一次程序即可——新版会把配置放到用户数据目录；也可以用环境变量 MYA_CONFIG_DIR 指定别的可写目录。'
          : '请确认这个目录存在且可写（或用环境变量 MYA_CONFIG_DIR 指定别的目录）。'),
    );
  }

  // 立即把改动同步到内存配置（不用重启）。
  // 注意这里不能用 `json.x || app.cfg.x` 的写法：用户清空某一项时（比如
  // 想清掉 model），空字符串是假值，会被静默回退成旧值，表现成「保存了没反应」。
  //
  // modelChanged 要在赋值**之前**算出来，后面用它决定要不要重算上下文窗口
  const modelChanged = json.model !== undefined && json.model !== app.cfg.model;
  if (json.provider !== undefined) app.cfg.provider = json.provider;
  if (json.apiFormat !== undefined) app.cfg.apiFormat = json.apiFormat;
  if (json.model !== undefined) app.cfg.model = json.model;
  if (json.baseUrl !== undefined) app.cfg.baseUrl = String(json.baseUrl).replace(/\/+$/, '');
  app.cfg.temperature = json.temperature !== undefined ? json.temperature : app.cfg.temperature;
  if (json.maxTurns !== undefined) app.cfg.maxTurns = json.maxTurns;
  app.cfg.stream = json.stream !== undefined ? json.stream : app.cfg.stream;
  if (json.apiKey) app.cfg.apiKey = json.apiKey;
  if (json.tools) app.cfg.tools = { ...app.cfg.tools, ...json.tools };
  if (json.shell) app.cfg.shell = { ...app.cfg.shell, ...json.shell };
  if (json.web) {
    app.cfg.web = { ...app.cfg.web, ...json.web };
    // 开关必须立刻生效：关掉时把 web_search / web_fetch 从模型的能力列表里
    // 摘掉（不是注销，注销了想再打开就得重启），
    // 否则模型还会照着旧列表去调一个已经被关掉的工具。
    try {
      require('../app').applyWebToolVisibility(app.cfg, app.registry);
    } catch {
      /* 注册表不在（极少见）时不影响配置保存本身 */
    }
  }
  app.cfg.githubToken = json.githubToken || '';
  app.cfg.hasApiKey = !!app.cfg.apiKey;
  if (json.contextWindow !== undefined) {
    app.cfg.contextWindow = json.contextWindow;
    // 已经开着的会话马上按新窗口重算，不用等下次启动。
    // 取 app.sessions 而不是外层变量：handleSaveSettings 只拿到 app
    app.sessions.refreshContextWindow();
  } else if (modelChanged) {
    // 只改了模型也必须重算：上下文窗口默认是按模型名推断的
    // （gpt-4 是 8k，deepseek 是 128k），不重算的话界面上那条用量条会
    // 一直用旧分母，换到小窗口模型后「20%」其实已经快满了。
    app.sessions.refreshContextWindow();
  }
  if (json.compact) app.cfg.compact = { ...app.cfg.compact, ...json.compact };
  // 推理等级：只存语义值（auto/low/medium/high/minimal），
  // 具体发什么字段由 provider 在组装请求时按各自官方形状翻译（见 src/reasoning.js）
  if (json.reasoning) app.cfg.reasoning = { ...app.cfg.reasoning, ...json.reasoning };

  // 权限档位立刻生效：工具层的判定每次都现读 app.cfg.approval，
  // 所以不用重建 provider / agent——切一下下一轮就按新档位走
  if (json.approval && json.approval.mode) {
    app.cfg.approval = { ...(app.cfg.approval || {}), mode: json.approval.mode };
  }

  // 模型参数变了要重建 provider。
  // 只改字段是不够的——provider 在构造时就把 streamEnabled、endpoint、
  // timeoutMs 这些派生状态算好了，换个接口地址却沿用旧的那些，
  // 会出现「地址显示变了，请求还发到老地方」这种查半天的问题。
  if (app.provider) {
    try {
      app.provider = require('../provider').createProvider(app.cfg);
      // agent 可能还没建起来（没配模型时是 null），所以要先判空
      if (app.agent) app.agent.provider = app.provider;
    } catch (err) {
      // 新配置建不出 provider（比如 baseUrl 被清空）时保留旧的，
      // 但要让用户知道，不能默默用旧配置继续跑
      return sendJson(res, 200, {
        ok: true,
        warning: `配置已保存，但新的模型客户端没建起来：${err.message}`,
        message: '其余设置已生效。请补全接口地址后重试「测试连接」。',
        raw: { provider: app.cfg.provider, model: app.cfg.model, baseUrl: app.cfg.baseUrl },
        configPath,
      });
    }
  }
  if (tokenChanged) market.token = (json.githubToken || '').trim();

  return sendJson(res, 200, {
    ok: true,
    message: '已保存。模型相关改动立即生效；个别设置（如插件目录）重启后生效。',
    raw: {
      provider: app.cfg.provider,
      model: app.cfg.model,
      baseUrl: app.cfg.baseUrl,
      githubTokenMasked: maskKey(market.token),
    },
    configPath,
  });
}

/**
 * 列出网关可用的模型。
 *
 * 和「测试连接」一样，用请求体里带的地址/协议/密钥去试，
 * 这样用户改完地址就能立刻看有哪些模型，不用先保存一次。
 * 拉不到（很多自建网关没有 /models）时返回明确原因，让界面退回手填。
 */
async function handleListModels(res, body, app) {
  const cfg = { ...app.cfg };
  if (body && body.baseUrl) cfg.baseUrl = String(body.baseUrl).replace(/\/+$/, '');
  if (body && body.provider) cfg.provider = body.provider;
  if (body && body.apiFormat) {
    const { FORMAT_KEYS } = require('../provider');
    const want = String(body.apiFormat).toLowerCase();
    cfg.apiFormat = want === 'auto' || FORMAT_KEYS.includes(want) ? want : 'auto';
  }
  if (body && body.apiKey && !String(body.apiKey).includes('***')) cfg.apiKey = body.apiKey;
  // 有些网关要按模型名分组才能列出来，带上没坏处
  if (body && body.model) cfg.model = body.model;

  if (!cfg.baseUrl) return sendError(res, 400, '没有配置接口地址（baseUrl）');

  const { createProvider, resolveApiFormat } = require('../provider');
  let provider;
  try {
    provider = createProvider(cfg);
  } catch (err) {
    return sendError(res, 400, err.message);
  }

  const result = await provider.listModels();
  const format = resolveApiFormat(cfg).format;

  if (!result.ok) {
    // 不当作 500：拉不到列表是「可以用手填绕过」的情况，
    // 界面上要显示原因而不是弹一个刺眼的错误
    return sendJson(res, 200, { ok: false, models: [], format, error: result.error });
  }

  // 顺手把上下文窗口记下来。
  // 这是唯一能拿到**权威**窗口大小的地方（Gemini 的 inputTokenLimit、
  // OpenRouter 的 context_length 都在这个响应里），比我们按模型名猜准得多。
  const currentModel = String(cfg.model || '');
  const hit = currentModel ? result.models.find((m) => m.id === currentModel) : null;
  if (hit && hit.contextWindow) {
    const changed = require('../model-info').setContextWindow(cfg, currentModel, hit.contextWindow, 'gateway');
    // 窗口变了，已经开着的会话要立刻按新分母重算
    if (changed && app.sessions) app.sessions.refreshContextWindow();
  }
  const windowInfo = require('../session').resolveContextWindowInfo(app.cfg);

  return sendJson(res, 200, {
    ok: true,
    models: result.models,
    format,
    source: result.source,
    contextWindow: windowInfo.window,
    contextWindowSource: windowInfo.source,
  });
}

/** 用当前配置真发一次请求，测试模型是否可用 */
async function handleTestModel(res, body, app) {
  const cfg = { ...app.cfg };
  if (body && body.model) cfg.model = body.model;
  if (body && body.baseUrl) cfg.baseUrl = String(body.baseUrl).replace(/\/+$/, '');
  if (body && body.provider) cfg.provider = body.provider;
  // 测试连接要能用「还没保存的格式选择」试，否则用户得先存再试
  if (body && body.apiFormat) {
    const { FORMAT_KEYS } = require('../provider');
    const want = String(body.apiFormat).toLowerCase();
    cfg.apiFormat = want === 'auto' || FORMAT_KEYS.includes(want) ? want : 'auto';
  }
  if (body && body.apiKey && !String(body.apiKey).includes('***')) cfg.apiKey = body.apiKey;

  if (!cfg.baseUrl) return sendError(res, 400, '没有配置接口地址（baseUrl）');

  const { createProvider, resolveApiFormat } = require('../provider');
  let provider;
  try {
    provider = createProvider(cfg);
  } catch (err) {
    return sendError(res, 400, err.message);
  }
  const usedFormat = resolveApiFormat(cfg).format;

  const started = Date.now();
  try {
    const reply = await provider.chat({
      messages: [
        { role: 'system', content: '你是连通性测试助手，只回复两个字：可用' },
        { role: 'user', content: 'ping' },
      ],
      tools: [],
      stream: false,
      model: cfg.model,
    });
    return sendJson(res, 200, {
      ok: true,
      ms: Date.now() - started,
      reply: (reply.text || '').slice(0, 100),
      usage: reply.usage || null,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      /** 回显实际用的协议：选 auto 时用户需要知道最后走了哪种 */
      format: usedFormat,
    });
  } catch (err) {
    return sendError(res, 400, err.message, {
      ms: Date.now() - started,
      format: usedFormat,
      /** 错误类别：model / auth / quota / endpoint —— 前端据此给对应的修复建议 */
      kind: err.kind || 'ok',
    });
  }
}

function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

function safeJson(obj) {
  // 事件里可能有循环引用或 Error 对象，统一序列化成纯文本
  try {
    return JSON.stringify(obj, (k, v) => {
      if (v instanceof Error) return { message: v.message, name: v.name };
      if (typeof v === 'function') return undefined;
      return v;
    });
  } catch {
    return JSON.stringify({ type: 'error', text: '事件序列化失败' });
  }
}

/** 打开系统默认浏览器 */
function openBrowser(url) {
  const { spawn } = require('child_process');
  try {
    if (process.platform === 'win32') {
      // start 是 cmd 内置命令，必须通过 cmd 调用
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    /* 打不开就算了，用户自己点链接 */
  }
}

module.exports = { startWebServer, listenWithFallback, maskKey };
