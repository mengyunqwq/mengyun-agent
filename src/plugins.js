'use strict';

/**
 * 梦云 Agent —— 插件系统（Plugin Host）
 *
 * 这是「类 Codex 的可扩展性」的关键所在。目标：不改核心代码，就能加工具、加钩子、加人格。
 *
 * ── 目录约定 ────────────────────────────────────────────────
 * plugins/
 *   my-plugin/
 *     manifest.json     ← 元信息（name / version / entry / permissions…）
 *     index.js          ← 入口，默认导出插件对象
 *   quick-tool.js       ← 也支持单文件插件（无 manifest）
 *
 * ── 插件写法 ────────────────────────────────────────────────
 *   module.exports = {
 *     name: 'my-plugin',
 *     setup(ctx) {
 *       // 1) 注册工具
 *       ctx.registerTool({
 *         name: 'hello',
 *         description: '打招呼',
 *         parameters: { type:'object', properties:{ who:{type:'string'} }, required:['who'] },
 *         async run(args, tctx) { return `你好，${args.who}`; },
 *       });
 *
 *       // 2) 挂钩子
 *       ctx.on('tool:before', (e) => { ctx.log('即将执行 ' + e.toolName); });
 *       ctx.on('messages:before', (e) => { e.messages.push({ role:'system', content:'额外要求…' }); });
 *
 *       // 3) 注册斜杠命令
 *       ctx.registerCommand('ping', { description: '测试' }, async () => 'pong');
 *
 *       // 4) 贡献系统提示词片段
 *       ctx.addPrompt('回答时优先给出可运行的最小改动。');
 *     },
 *     teardown() { /* 会话结束时可清理，可选 *\/ },
 *   };
 *
 * ── 安全提示 ────────────────────────────────────────────────
 * 插件运行在同一个 Node 进程里，拥有完整权限。只安装你信任的插件。
 * manifest 的 permissions 字段只是「声明 + 告警」，不是沙箱。
 */

const fs = require('fs');
const path = require('path');
const module_ = require('module');
const { pathToFileURL } = require('url');
const { isDir, readJsonFile, ensureDir, writeTextFile } = require('./utils');

/** 插件可以声明的权限（用于加载时告警，非强制） */
const KNOWN_PERMISSIONS = [
  'fs:read',
  'fs:write',
  'shell:exec',
  'net:fetch',
  'env',
  'session',
];

class PluginHost {
  /**
   * @param {object} cfg 全局配置
   * @param {import('./events').EventBus} bus 事件总线
   * @param {import('./tools').ToolRegistry} registry 工具注册表
   * @param {object} [deps] 额外依赖注入，如 { ui, log }
   */
  constructor(cfg, bus, registry, deps = {}) {
    this.cfg = cfg;
    this.bus = bus;
    this.registry = registry;
    this.deps = deps;
    /** @type {Map<string, object>} 已加载插件：name -> record */
    this.plugins = new Map();
    this.errors = [];
    this.commands = new Map();
    this.promptContribs = [];
    // 排查插件加载问题时打开：设 MYA_DEBUG_DISCOVER=1 会把发现/加载过程打到 stderr
    this.trace = process.env.MYA_DEBUG_DISCOVER === '1';
  }

  /** 追踪日志（默认关闭，只在排查插件问题时开） */
  say(...args) {
    if (!this.trace) return;
    const line = `[插件发现] ${args.join(' ')}`;
    if (this.deps && this.deps.ui && this.deps.ui.log) this.deps.ui.log.dim(line);
    else console.error(line);
  }

  /**
   * 以程序方式调用插件注册的斜杠命令。
   *
   * 为什么需要：界面上的按钮不该被「只能从聊天框输入 /命令」限制住。
   * 比如输入区的「压缩上下文」按钮，走的就是插件注册的 /compact，
   * 这样「能力只有一份实现」——按钮和命令不会各写一套、然后慢慢跑偏。
   *
   * @param {string} name 命令名（可以带前导 /）
   * @param {string} [arg] 命令参数
   * @param {object} [extra] 透传给命令处理函数（session / provider / emit 等）
   * @returns {Promise<{ok:boolean, result?:any, error?:string, plugin?:string}>}
   */
  async runCommand(name, arg = '', extra = {}) {
    const key = String(name || '').replace(/^\//, '');
    const cmd = this.commands.get(key);
    if (!cmd) {
      return { ok: false, error: `没有插件注册命令 /${key}（插件没装或被禁用了？）` };
    }
    try {
      const result = await cmd.handler(arg, extra);
      return { ok: true, result, plugin: cmd.plugin };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err), plugin: cmd.plugin };
    }
  }

  /* ---------------------------------------------------------------- */
  /* 扫描                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 扫描所有插件目录，返回候选列表（此时还没执行插件代码）。
   * @returns {Array<{dir:string, id:string, manifest:object|null, entry:string|null, kind:string, error?:string}>}
   */
  discover() {
    const found = [];
    const say = (...a) => this.say(...a);
    if (!this.cfg.plugins.enabled) {
      say('插件系统已禁用');
      return found;
    }
    say('pluginDirs =', JSON.stringify(this.cfg.pluginDirs));

    for (const dir of this.cfg.pluginDirs) {
      if (!isDir(dir)) {
        say('跳过（不是目录）:', dir);
        continue;
      }
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        say('读取失败:', dir, err.message);
        continue;
      }
      say(`扫描 ${dir} → ${entries.length} 个条目: ${entries.map((e) => e.name).join(', ')}`);
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
        const full = path.join(dir, entry.name);

        // 形态 A：单文件插件 my-plugin.js
        if (entry.isFile() && /\.(c?js|mjs)$/.test(entry.name)) {
          found.push({
            dir: full,
            id: entry.name.replace(/\.(c?js|mjs)$/, ''),
            manifest: null,
            entry: full,
            kind: 'file',
          });
          continue;
        }

        // 形态 B：目录插件
        if (entry.isDirectory()) {
          const pkgFile = path.join(full, 'package.json');
          const manifestFile = path.join(full, 'manifest.json');
          let manifest = null;
          if (fs.existsSync(manifestFile)) {
            manifest = readJsonFile(manifestFile, null);
            if (!manifest) {
              found.push({
                dir: full,
                id: entry.name,
                manifest: null,
                entry: null,
                kind: 'dir',
                error: 'manifest.json 不是合法 JSON',
              });
              continue;
            }
          } else if (fs.existsSync(pkgFile)) {
            const pkg = readJsonFile(pkgFile, {});
            manifest = {
              name: pkg.name || entry.name,
              version: pkg.version || '0.0.0',
              description: pkg.description || '',
              entry: pkg.main || 'index.js',
            };
          } else {
            // 没有清单的目录：按约定找入口
            const guess = ['index.js', 'index.cjs', 'index.mjs', `${entry.name}.js`].find((f) =>
              fs.existsSync(path.join(full, f)),
            );
            if (!guess) continue;
            manifest = { name: entry.name, entry: guess };
          }

          const entryRel = manifest.entry || 'index.js';
          const entryAbs = path.resolve(full, entryRel);
          if (!fs.existsSync(entryAbs)) {
            found.push({
              dir: full,
              id: manifest.name || entry.name,
              manifest,
              entry: null,
              kind: 'dir',
              error: `入口文件不存在：${entryRel}`,
            });
            continue;
          }
          found.push({
            dir: full,
            id: manifest.name || entry.name,
            manifest,
            entry: entryAbs,
            kind: 'dir',
          });
        }
      }
    }
    return found;
  }

  /* ---------------------------------------------------------------- */
  /* 加载                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 发现并加载全部插件。
   * @returns {Promise<{loaded:number, failed:number}>}
   */
  async loadAll() {
    const candidates = this.discover();
    const disabled = new Set(this.cfg.plugins.disabled || []);
    let loaded = 0;
    let failed = 0;

    for (const cand of candidates) {
      const name = cand.manifest?.name || cand.id;
      this.say('候选:', name, 'error=', cand.error || '(无)', 'entry=', cand.entry || '(无)');
      if (disabled.has(name) || disabled.has(cand.id)) {
        this.say('  → 被 plugins.disabled 跳过');
        continue;
      }
      if (cand.error) {
        failed += 1;
        this.errors.push({ plugin: name, error: cand.error, file: cand.dir });
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.loadOne(cand);
        loaded += 1;
        this.say('  → 加载成功');
      } catch (err) {
        failed += 1;
        this.errors.push({ plugin: name, error: err.message, stack: err.stack, file: cand.entry });
        this.say('  → 加载失败:', err.message);
      }
    }
    this.say(`加载结束: 成功 ${loaded}，失败 ${failed}，禁用列表 ${JSON.stringify([...disabled])}`);
    return { loaded, failed };
  }

  /** 加载单个插件 */
  async loadOne(cand) {
    const manifest = cand.manifest || {};
    const name = manifest.name || cand.id;

    if (this.plugins.has(name)) {
      throw new Error(`插件名重复：${name}`);
    }

    // 插件自己就是 ESM 时只能走 import；CJS 优先用 require（这样插件能读到自己目录的 node_modules）
    const isEsm = /\.mjs$/.test(cand.entry) || manifest.type === 'module';
    let mod;
    if (isEsm) {
      mod = await import(pathToFileURL(cand.entry).href);
    } else {
      mod = this.requireLocal(cand.entry);
    }

    const plugin = normalizeModule(mod);
    if (!plugin) throw new Error('插件没有导出对象（请 module.exports = {...} 或 export default {...}）');
    if (plugin.enabled === false) throw new Error('插件自身声明 enabled:false');

    const record = {
      name,
      version: plugin.version || manifest.version || '0.0.0',
      description: plugin.description || manifest.description || '',
      author: manifest.author || plugin.author || '',
      permissions: manifest.permissions || plugin.permissions || [],
      dir: cand.kind === 'dir' ? cand.dir : path.dirname(cand.dir),
      entry: cand.entry,
      kind: cand.kind,
      manifest,
      instance: plugin,
      toolNames: [],
      commandNames: [],
      hookEvents: [],
      state: {},
      loadedAt: new Date().toISOString(),
    };

    // 未声明但可能用到的权限，给出提醒（不阻断）
    const known = new Set(KNOWN_PERMISSIONS);
    for (const p of record.permissions) {
      if (!known.has(p)) {
        this.warn(`插件 ${name} 声明了未知权限 "${p}"（已忽略，仍会加载）`);
      }
    }

    const ctx = this.makeContext(record);
    if (typeof plugin.setup === 'function') {
      await plugin.setup(ctx);
    }

    /**
     * 没有任何权限声明，却注册了工具 —— 值得当面提醒一句。
     *
     * 不猜「这个工具名看起来像写文件」那种判据（会误报，也会让人学会绕过）。
     * 说的是事实：权限是**声明**不是沙箱；没声明又不标 dangerous 的工具，
     * 在「询问」档下是免确认放行的，所以装这类插件前请看一眼它的代码。
     */
    if (!record.permissions.length && record.toolNames.length) {
      this.warn(
        `插件 ${name} 没有声明任何权限却注册了 ${record.toolNames.length} 个工具（${record.toolNames.join(', ')}）：` +
          '这些工具默认按「只读」处理、不会弹确认。装陌生插件前请先看一眼它的代码。',
      );
    }

    this.plugins.set(name, record);
    return record;
  }

  /**
   * 用插件自己目录作为解析基准去 require。
   * 这样插件可以 `require('lodash')` 并命中它自己目录里的 node_modules，
   * 而不需要把依赖装到 agent 根目录。
   */
  requireLocal(file) {
    try {
      return require(file);
    } catch (err) {
      // 只有「找不到模块」时才启用兜底路径；插件自身的语法错误要如实抛出
      if (err.code !== 'MODULE_NOT_FOUND') throw err;
      const localRequire = module_.createRequire(file);
      try {
        return localRequire(file);
      } catch {
        throw err; // 抛原始错误，提示更准确
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* 插件上下文                                                        */
  /* ---------------------------------------------------------------- */

  makeContext(record) {
    const host = this;
    const cfg = this.cfg;

    return {
      /* --- 元信息 --- */
      name: record.name,
      version: record.version,
      dir: record.dir,
      config: cfg,
      cwd: cfg.cwd || process.cwd(),
      state: record.state, // 插件自己的状态袋，跨钩子共享
      deps: this.deps,

      /* --- 日志 --- */
      log: (...args) => host.log(record.name, ...args),
      warn: (...args) => host.warn(`[${record.name}] ${args.join(' ')}`),
      error: (...args) => host.error(`[${record.name}] ${args.join(' ')}`),

      /* --- 注册工具 --- */
      registerTool(def) {
        if (!def || !def.name) throw new Error('registerTool 需要 name');
        /**
         * 把插件声明的权限随定义一起交给注册表（走 Tool 的正规字段）。
         *
         * 为什么不让确认闸门自己去查插件表：闸门拿到的只有工具对象，
         * 而工具会被重建（clone / 子任务掩码），临时挂的属性会丢。
         * 权限放在定义里，跟着工具走，才不会有「有时弹窗有时不弹」的怪事。
         */
        const tool = host.registry.register({ ...def, permissions: record.permissions || [] }, `plugin:${record.name}`);
        if (!tool) throw new Error(`工具 "${def.name}" 注册失败（可能被禁用或与内置工具重名）`);
        record.toolNames.push(tool.name);
        return tool;
      },
      /** 一次注册多个 */
      registerTools(defs) {
        return (defs || []).map((d) => this.registerTool(d));
      },
      unregisterTool(name) {
        host.registry.tools.delete(name);
      },

      /* --- 注册斜杠命令（在 chat 里用 /命令名 调用） --- */
      registerCommand(name, meta, handler) {
        const cmd = String(name).replace(/^\//, '');
        host.commands.set(cmd, {
          name: cmd,
          description: (meta && meta.description) || '',
          usage: (meta && meta.usage) || '',
          plugin: record.name,
          handler,
        });
        record.commandNames.push(cmd);
        return cmd;
      },

      /* --- 钩子 --- */
      on(event, fn, opts) {
        const off = host.bus.on(event, fn, { label: record.name, ...(opts || {}) });
        record.hookEvents.push(event);
        return off;
      },
      once(event, fn) {
        return this.on(event, fn, { once: true });
      },
      off(event, fn) {
        host.bus.off(event, fn);
      },
      emit(event, payload, opts) {
        return host.bus.emit(event, payload, opts);
      },

      /* --- 贡献系统提示词 --- */
      addPrompt(text) {
        host.promptContribs.push({ plugin: record.name, text: String(text) });
      },

      /* --- 读插件自己的配置（config.json 的 plugins.config.<插件名>） --- */
      getConfig(defaults = {}) {
        const fromFile = (cfg.plugins && cfg.plugins.config && cfg.plugins.config[record.name]) || {};
        const fromEnv = {};
        // 支持 MYA_PLUGIN_<大写插件名>_<KEY> 形式的环境变量
        const prefix = `MYA_PLUGIN_${record.name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`;
        for (const [k, v] of Object.entries(process.env)) {
          if (k.startsWith(prefix)) fromEnv[k.slice(prefix.length).toLowerCase()] = v;
        }
        return { ...defaults, ...fromFile, ...fromEnv };
      },

      /* --- 工具函数，省得每个插件都自己写 --- */
      utils: require('./utils'),

      /* --- 直接调用别的工具（插件之间协作） --- */
      callTool(toolName, args, runCtx) {
        return host.registry.execute(toolName, args, runCtx || host.deps.runCtx || {});
      },

      /* --- 让插件也能安全地解析路径 --- */
      resolvePath(p, insideOnly = true) {
        return require('./utils').resolvePath(p, cfg.cwd || process.cwd(), insideOnly);
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* 收尾                                                              */
  /* ---------------------------------------------------------------- */

  /** 会话结束时调用 teardown */
  async teardownAll() {
    for (const record of this.plugins.values()) {
      if (record.instance && typeof record.instance.teardown === 'function') {
        try {
          // eslint-disable-next-line no-await-in-loop
          await record.instance.teardown(this.makeContext(record));
        } catch (err) {
          this.warn(`插件 ${record.name} teardown 出错：${err.message}`);
        }
      }
    }
  }

  /**
   * 清掉某个目录下所有模块的 require 缓存。
   *
   * 为什么必须有这一步：插件是用 require 加载的，Node 会把模块对象缓存起来。
   * 用户改了插件代码点「重扫」，如果不清缓存，加载到的还是**旧代码**
   * （实测：把插件返回值从 v1 改成 v2，重扫后仍然是 v1），
   * 于是「改了没生效」变成了一个查不出原因的坑。
   *
   * 只清插件自己目录里的模块：目录外的依赖是共享的，动它们会波及别的插件。
   * 同时比对真实路径，因为插件目录常常是 junction / symlink（link: 安装方式）。
   */
  clearRequireCacheFor(dir) {
    let real = dir;
    try {
      real = fs.realpathSync(dir);
    } catch {
      /* 目录不存在就算了，按原路径比 */
    }
    const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
    const targets = [norm(dir), norm(real)];
    let cleared = 0;
    for (const key of Object.keys(require.cache)) {
      const file = norm(key);
      if (targets.some((t) => file.startsWith(`${t}/`))) {
        delete require.cache[key];
        cleared += 1;
      }
    }
    return cleared;
  }

  /**
   * 卸载一个插件：钩子 / 工具 / 命令 / 提示词贡献 / 模块缓存，并调用它的 teardown。
   *
   * 顺序是有讲究的：先摘钩子再调 teardown——否则 teardown 里如果触发了事件，
   * 插件自己的钩子还会被叫一次，出现「自己拆自己」的怪状态。
   */
  async unload(name) {
    const record = this.plugins.get(name);
    if (!record) return { ok: false, reason: 'not-loaded', name };

    const hooks = this.bus.offLabel(record.name);
    let tools = 0;
    for (const toolName of record.toolNames) {
      if (this.registry.tools.delete(toolName)) tools += 1;
    }
    let commands = 0;
    for (const cmd of record.commandNames) {
      if (this.commands.delete(cmd)) commands += 1;
    }
    const before = this.promptContribs.length;
    this.promptContribs = this.promptContribs.filter((p) => p.plugin !== record.name);
    const prompts = before - this.promptContribs.length;

    if (record.instance && typeof record.instance.teardown === 'function') {
      try {
        await record.instance.teardown(this.makeContext(record));
      } catch (err) {
        this.warn(`插件 ${record.name} teardown 出错：${err.message}`);
      }
    }

    const modules = this.clearRequireCacheFor(record.dir);
    this.plugins.delete(record.name);
    return { ok: true, name: record.name, hooks, tools, commands, prompts, modules };
  }

  /**
   * 卸载全部（重扫插件前调用）。返回汇总，方便如实告诉用户「摘掉了什么」——
   * 出问题时这几个数字就是最直接的线索。
   */
  async unloadAll() {
    const total = { plugins: 0, hooks: 0, tools: 0, commands: 0, prompts: 0, modules: 0 };
    for (const name of [...this.plugins.keys()]) {
      // eslint-disable-next-line no-await-in-loop
      const one = await this.unload(name);
      if (!one.ok) continue;
      total.plugins += 1;
      total.hooks += one.hooks;
      total.tools += one.tools;
      total.commands += one.commands;
      total.prompts += one.prompts;
      total.modules += one.modules;
    }
    return total;
  }

  /** 列出插件（给 /plugins 命令和 doctor 用） */
  list() {
    return [...this.plugins.values()];
  }

  /** 提示词贡献拼接 */
  promptExtra() {
    if (!this.promptContribs.length) return '';
    return ['# 来自插件的额外要求', ...this.promptContribs.map((p) => `- (${p.plugin}) ${p.text}`)].join('\n');
  }

  /* ---------------------------------------------------------------- */
  /* 插件脚手架                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * 生成一个新插件骨架到 plugins/<name>/。
   * 这是「一步步改」最省事的起点：mya plugin new xxx
   *
   * 目录名规则：保留字母、数字、下划线和中文；
   * 其他字符（空格、标点、连字符）统一转成 -。
   * 全中文的名字没问题——Node 的 require 和文件系统都支持中文路径。
   */
  static scaffold(dir, name, { description = '', withHook = true, force = false } = {}) {
    const safeName = String(name)
      .trim()
      .replace(/[^\p{L}\p{N}_]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();

    if (!safeName) {
      throw new Error(`插件名 "${name}" 不含任何可用字符（字母、数字、下划线或中文），请换一个`);
    }

    const target = path.join(dir, safeName);
    if (fs.existsSync(target) && !force) {
      throw new Error(`目录已存在：${target}（加 --force 覆盖）`);
    }
    ensureDir(target);

    // 工具名只能包含字母数字下划线（OpenAI 协议的硬性要求），
    // 所以中文插件名要额外生成一个 ASCII 版本作为工具名前缀。
    const asciiName = safeName.replace(/[^\x20-\x7e]/g, '').replace(/-+$/g, '') || 'myplugin';
    const toolPrefix = asciiName.replace(/-/g, '_');

    const manifest = {
      name: safeName,
      version: '0.1.0',
      description: description || `${safeName} 插件`,
      entry: 'index.js',
      author: '',
      permissions: ['fs:read'],
    };
    writeTextFile(path.join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const indexJs = `'use strict';

/**
 * 插件：${safeName}
 * ${description || '在这里描述插件用途'}
 *
 * 这个文件由 \`mya plugin new\` 生成，改完直接生效（下次启动 agent 时加载）。
 */

module.exports = {
  name: '${safeName}',
  version: '0.1.0',
  description: '${description || safeName + ' 插件'}',

  /**
   * setup 在 agent 启动时调用一次。
   * @param {object} ctx 插件上下文（详见 docs/plugins.md，类型契约见 types/plugin.d.ts）
   */
  setup(ctx) {
    ctx.log('插件已加载');

    // ── 1) 注册一个工具给模型用 ──────────────────────────────
    ctx.registerTool({
      name: '${toolPrefix}_demo',
      description: '示例工具：把输入原样返回，用于验证插件链路是否通',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要回显的文本' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      async run(args, tctx) {
        // 第二个参数 tctx 里有 cwd / cfg / confirm / log 等
        return \`插件 ${safeName} 收到：\${args.text}（工作目录：\${tctx.cwd}）\`;
      },
    });
${withHook ? `
    // ── 2) 挂一个钩子 ────────────────────────────────────────
    ctx.on('tool:after', (e) => {
      if (e.ok === false) ctx.warn(\`工具 \${e.toolName} 失败：\${e.summary}\`);
    });
` : ''}
    // ── 3) 注册一个斜杠命令：/hello ───────────────────────────
    ctx.registerCommand('hello', { description: '插件示例命令' }, async (input) => {
      return \`你好！这是来自插件 ${safeName} 的回复。你输入了：\${input || '(空)'}\`;
    });

    // ── 4) 给系统提示词加一句话（可选） ───────────────────────
    // ctx.addPrompt('回答时请优先使用 ${safeName} 工具。');
  },

  // 会话结束时的清理（可选）
  // teardown(ctx) {},
};
`;
    writeTextFile(path.join(target, 'index.js'), indexJs);

    writeTextFile(
      path.join(target, 'README.md'),
      `# ${safeName}\n\n${description || '梦云 Agent 插件'}\n\n- 工具：\`${toolPrefix}_demo\`\n- 命令：\`/hello\`\n\n在 config.json 的 \`plugins.dirs\` 包含本目录后，重启 agent 即生效。\n`,
    );

    return { dir: target, name: safeName, toolPrefix };
  }

  /* ---------------------------------------------------------------- */
  /* 日志                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 插件的日志。
   *
   * 控制台那行保持原来的 `[插件:名字] …` 格式（用户和测试都认这个），
   * 同时往结构化日志里记一条（带 plugin 字段），这样事后能按插件名筛。
   * 用 record() 而不是 info()：控制台已经打过了，不要在控制台上出现两份。
   */
  log(pluginName, ...args) {
    const message = args.join(' ');
    const line = `[插件:${pluginName}] ${message}`;
    if (this.deps.log) this.deps.log(line);
    else if (this.deps.ui && this.deps.ui.log && this.deps.ui.log.dim) this.deps.ui.log.dim(line);
    else console.log(line);
    if (this.deps.logger) this.deps.logger.record('info', message, { plugin: pluginName });
  }

  warn(msg) {
    if (this.deps.ui) this.deps.ui.log.warn(msg);
    else console.warn(msg);
    if (this.deps.logger) this.deps.logger.record('warn', String(msg));
  }

  error(msg) {
    if (this.deps.ui) this.deps.ui.log.error(msg);
    else console.error(msg);
    if (this.deps.logger) this.deps.logger.record('error', String(msg));
  }
}

/** 兼容 CJS / ESM 两种导出写法 */
function normalizeModule(mod) {
  if (!mod) return null;
  if (mod.default && typeof mod.default === 'object') return mod.default;
  if (mod.plugin && typeof mod.plugin === 'object') return mod.plugin;
  if (typeof mod === 'object' && (mod.setup || mod.name)) return mod;
  return null;
}

module.exports = { PluginHost, KNOWN_PERMISSIONS, normalizeModule };
