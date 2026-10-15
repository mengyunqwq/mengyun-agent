'use strict';

/**
 * 梦云 Agent —— 工具注册表（Tool Registry）
 *
 * 这是整个 agent 的「能力层」：
 *   - 内置工具（read/write/edit/glob/grep/shell）和插件工具都注册到这里
 *   - 统一做参数校验 → 安全确认 → 执行 → 截断输出 → 抛事件
 *   - 对外只暴露 OpenAI tools 协议的描述，模型不需要知道工具是谁提供的
 *
 * 新增一个工具最小写法：
 *   registry.register({
 *     name: 'hello',
 *     description: '打招呼',
 *     parameters: { type:'object', properties:{ who:{type:'string'} }, required:['who'] },
 *     async run(args, ctx) { return '你好，' + args.who; },
 *   });
 */

// 注意：这一层刻意不依赖 ui.js。
// 需要和用户交互时（比如确认执行），统一走 ctx.confirm 注入进来的函数，
// 这样换 Web 界面、换自动化脚本时都不用动核心逻辑。
const path = require('path');
const { truncate, closest, isSensitivePath } = require('./utils');

/**
 * 内部标记键名：注册表确认通过后写进 args，
 * 工具内部（如 shell）据此避免「同一件事问两遍」。
 */
const CONFIRMED = '__mya_confirmed';

/** 工具名规范化：OpenAI 要求 ^[a-zA-Z0-9_-]{1,64}$ */
function normalizeName(name) {
  const cleaned = String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 64) || 'unnamed_tool';
}

/* ------------------------------------------------------------------ */
/* 参数校验（JSON Schema 的一个实用子集）                              */
/* ------------------------------------------------------------------ */

/**
 * 按 schema 校验并「净化」参数。
 * 不追求完整 JSON Schema 支持，但覆盖了 type/properties/required/items/enum/default。
 * @returns {{ok: boolean, value?: object, error?: string}}
 */
function validateArgs(schema, args) {
  const value = args && typeof args === 'object' && !Array.isArray(args) ? { ...args } : {};

  // 模型偶尔把参数塞进 __raw / __parseError，这里直接判失败，让模型重来
  if (value.__parseError) {
    return { ok: false, error: `工具参数不是合法 JSON，请重新输出。原始内容：${truncate(value.__raw, 300)}` };
  }

  if (!schema || schema.type !== 'object') return { ok: true, value };

  const props = schema.properties || {};
  const required = schema.required || [];

  // 1) 必填检查
  const missing = required.filter((key) => value[key] === undefined || value[key] === null || value[key] === '');
  if (missing.length) {
    return {
      ok: false,
      error: `缺少必填参数：${missing.join(', ')}。请按这个 schema 重新调用：${JSON.stringify(schema)}`,
    };
  }

  // 2) 逐字段校验 + 类型宽松修正
  for (const [key, def] of Object.entries(props)) {
    let v = value[key];
    if (v === undefined || v === null) {
      if (def.default !== undefined) value[key] = def.default;
      continue;
    }

    switch (def.type) {
      case 'string':
        if (typeof v !== 'string') value[key] = typeof v === 'object' ? JSON.stringify(v) : String(v);
        break;
      case 'number':
      case 'integer': {
        const n = typeof v === 'number' ? v : Number(String(v).trim());
        if (!Number.isFinite(n)) return { ok: false, error: `参数 ${key} 必须是数字，收到：${JSON.stringify(v)}` };
        value[key] = def.type === 'integer' ? Math.trunc(n) : n;
        break;
      }
      case 'boolean':
        if (typeof v !== 'boolean') {
          const s = String(v).trim().toLowerCase();
          value[key] = ['true', '1', 'yes', 'y', '是'].includes(s);
        }
        break;
      case 'array':
        if (!Array.isArray(v)) {
          // 模型有时候把数组写成 JSON 字符串
          if (typeof v === 'string') {
            try {
              const parsed = JSON.parse(v);
              v = Array.isArray(parsed) ? parsed : [v];
            } catch {
              v = [v];
            }
          } else {
            v = [v];
          }
          value[key] = v;
        }
        if (def.items) {
          for (let i = 0; i < v.length; i += 1) {
            if (def.items.type === 'string' && typeof v[i] !== 'string') v[i] = String(v[i]);
          }
        }
        break;
      case 'object':
        if (typeof v === 'string') {
          try {
            value[key] = JSON.parse(v);
          } catch {
            /* 保持原样，交给工具自己报错 */
          }
        }
        break;
      default:
        break;
    }

    // 枚举校验：只警告不阻断（模型写错了让它自己从错误信息里学）
    if (Array.isArray(def.enum) && !def.enum.includes(value[key])) {
      return {
        ok: false,
        error: `参数 ${key} 只能取 ${def.enum.map((x) => JSON.stringify(x)).join(' / ')}，收到 ${JSON.stringify(value[key])}`,
      };
    }
  }

  return { ok: true, value };
}

/**
 * 这个 schema 能不能安全地开 strict（OpenAI Structured Outputs 的硬性要求）。
 *
 * strict 不是「校验更严」的开关，它要求 schema 满足一个具体子集：
 *   1. additionalProperties 必须是 false；
 *   2. properties 里的每一个键都必须列进 required——「可选参数」在
 *      strict 模式下是非法的。
 * 内置工具大多是「必填 + 可选」混合（read 的 offset/limit、shell 的
 * cwd/timeout），不满足却硬带 strict:true 的话，官方 OpenAI 会在请求阶段
 * 直接 400（Invalid schema for function 'read'...），整个 agent 瘫痪。
 * 很多中转站忽略这个字段所以平时暴露不出来，但按「满足才开」处理，两边都安全。
 */
function isStrictCompatibleSchema(schema) {
  if (!schema || typeof schema !== 'object' || schema.type !== 'object') return false;
  if (schema.additionalProperties !== false) return false;
  const props = Object.keys(schema.properties || {});
  const required = new Set(schema.required || []);
  return props.every((key) => required.has(key));
}

/* ------------------------------------------------------------------ */
/* 工具对象                                                            */
/* ------------------------------------------------------------------ */

class Tool {
  constructor(def, source = 'builtin') {
    if (!def || typeof def !== 'object') throw new TypeError('工具定义必须是对象');
    if (typeof def.run !== 'function') throw new TypeError(`工具 ${def.name} 缺少 run() 函数`);

    this.name = normalizeName(def.name);
    this.rawName = def.name;
    this.description = String(def.description || def.name || '').trim();
    this.parameters = def.parameters || { type: 'object', properties: {} };
    this.run = def.run;
    this.source = def.source || source;
    this.dangerous = def.dangerous === true;
    this.autoApprove = def.autoApprove === true;
    this.needsConfirm = def.needsConfirm === true;
    this.hidden = def.hidden === true; // 不暴露给模型，仅供命令/插件内部调用
    /**
     * 必须单独跑：同一轮里有它时，这一轮的工具按顺序执行。
     *
     * 用途：任务拆分工具（task_spawn / task_wait）。模型很自然的写法是
     * 「连发两个 spawn 再跟一个 wait」，而默认同轮工具是并行的——
     * wait 会和 spawn 抢跑，看到「任务还不存在」，功能变成时灵时不灵。
     */
    this.sequential = def.sequential === true;
    /**
     * 插件声明的权限（manifest.permissions 的副本）。
     *
     * 为什么放进正规字段而不是注册完再挂一个属性：工具对象会被重建
     * （clone / 重新注册 / 子任务掩码），临时挂上去的属性在那几处会悄悄丢掉，
     * 于是「插件写文件要不要问」会时灵时不灵——这种 bug 最难查。
     */
    this.permissions = Array.isArray(def.permissions) ? def.permissions.map(String) : [];
    /**
     * 可选：执行前给用户看的「改动预览」（write/edit 用它给出 diff）。
     *
     * 为什么放在工具而不是闸门里统一算：只有工具自己知道「这次到底会改什么」
     * （写文件要看旧内容、编辑要先把替换算出来）。闸门只负责把它递给用户。
     * 只在**真要问用户**的时候才调用它——不能为了显示而白读一遍文件。
     */
    this.preview = typeof def.preview === 'function' ? def.preview : null;
    /** 可选：自定义「这次要不要问用户」的判断 */
    this.needsConfirmation = typeof def.needsConfirmation === 'function' ? def.needsConfirmation : null;
    this.aliases = (def.aliases || []).map(normalizeName);
    this.tags = def.tags || [];
    this.version = def.version || '';
    this.examples = def.examples || [];
  }

  /** 转换成 OpenAI tools 协议格式 */
  toOpenAI() {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
        // strict 让支持的服务端强制模型按 schema 输出，显著降低参数出错率。
        // 但它有硬性前提（见 isStrictCompatibleSchema），不满足时绝不能带。
        strict: isStrictCompatibleSchema(this.parameters) ? true : undefined,
      },
    };
  }

  /** 最短的使用说明，注入系统提示词用 */
  toPromptLine() {
    const firstLine = this.description.split(/\r?\n/)[0];
    return `- ${this.name}: ${firstLine}`;
  }
}

/* ------------------------------------------------------------------ */
/* 注册表                                                              */
/* ------------------------------------------------------------------ */

class ToolRegistry {
  /**
   * @param {object} cfg 全局配置
   * @param {import('./events').EventBus} bus 事件总线
   */
  constructor(cfg, bus) {
    this.cfg = cfg;
    this.bus = bus;
    /** @type {Map<string, Tool>} */
    this.tools = new Map();
    this.aliasIndex = new Map();
    this.skipped = []; // 被禁用/重名跳过的记录，供 doctor 展示
  }

  /**
   * 注册一个工具。
   * @param {object} def
   * @param {string} [source] 来源标识，如 'builtin' 或 'plugin:search'
   * @returns {Tool|null} 被禁用时返回 null
   */
  register(def, source = 'builtin') {
    let tool;
    try {
      tool = new Tool(def, source);
    } catch (err) {
      this.skipped.push({ name: def && def.name, source, reason: err.message });
      return null;
    }

    const denied = (this.cfg.tools.deny || []).map(normalizeName);
    if (denied.includes(tool.name)) {
      this.skipped.push({ name: tool.name, source, reason: '已在 tools.deny 中禁用' });
      return null;
    }

    if (this.tools.has(tool.name)) {
      const prev = this.tools.get(tool.name);
      // 内置工具不允许被插件静默顶替，避免「插件一装就劫持文件读写」
      if (prev.source === 'builtin' && source !== 'builtin') {
        this.skipped.push({
          name: tool.name,
          source,
          reason: `与内置工具重名，已跳过（想覆盖请改个名字，或把它写进 tools.deny 后再注册）`,
        });
        return null;
      }
      this.skipped.push({ name: tool.name, source, reason: '重名，后注册者覆盖前者' });
    }

    this.tools.set(tool.name, tool);
    for (const alias of tool.aliases) this.aliasIndex.set(alias, tool.name);
    return tool;
  }

  /** 批量注册，返回成功条数 */
  registerAll(defs, source = 'builtin') {
    let n = 0;
    for (const def of defs || []) {
      if (this.register(def, source)) n += 1;
    }
    return n;
  }

  /** 按名字（含别名）找工具 */
  get(name) {
    const key = normalizeName(name);
    if (this.tools.has(key)) return this.tools.get(key);
    const real = this.aliasIndex.get(key);
    return real ? this.tools.get(real) : null;
  }

  has(name) {
    return !!this.get(name);
  }

  /**
   * 复制一份「只含指定工具」的注册表——子任务用它。
   *
   * 为什么是复制**同一批 Tool 实例的引用**、而不是重新 new 一遍：
   * 重新包装等于换了个对象，`hidden`、`needsConfirmation` 这些行为
   * 得一个个照抄，抄漏了就是另一个 bug。我们要的只是「把没被许可的工具
   * 从视野里拿掉」，实例本身没必要换。
   *
   * 为什么子任务需要它：并行子任务同时写文件必然竞态，所以子任务的工具集
   * 默认只读。只靠系统提示词说「你别用 write」是不够的——提示词是建议，
   * 注册表才是约束。
   */
  clone(names) {
    const child = new ToolRegistry(this.cfg, this.bus);
    const wanted = Array.isArray(names) && names.length ? names : [...this.tools.keys()];
    for (const name of wanted) {
      const tool = this.get(name);
      if (tool) child.tools.set(tool.name, tool);
    }
    for (const [alias, real] of this.aliasIndex) {
      if (child.tools.has(real)) child.aliasIndex.set(alias, real);
    }
    return child;
  }

  /** 全部工具（默认不含 hidden） */
  list({ includeHidden = false } = {}) {
    const all = [...this.tools.values()];
    return includeHidden ? all : all.filter((t) => !t.hidden);
  }

  /** 暴露给模型的工具描述数组 */
  toOpenAITools() {
    return this.list().map((t) => t.toOpenAI());
  }

  /**
   * 临时隐藏 / 放出某个工具。
   *
   * 用途：联网搜索这种「设置里可以关掉」的能力。隐藏之后
   * toOpenAITools() 就不会把它带给模型——比「注册着但一调用就报错」好得多，
   * 后者会让模型反复重试一个注定失败的动作，白白烧 token。
   *
   * 之所以不干脆注销掉，是因为注销之后想再打开就得重启进程；
   * 隐藏位是可逆的，设置里一拨就立刻生效。
   */
  setHidden(name, hidden) {
    const tool = this.get(name);
    if (!tool) return false;
    tool.hidden = !!hidden;
    return true;
  }

  /** 这个工具现在对模型可见吗 */
  isVisible(name) {
    const tool = this.get(name);
    return !!tool && !tool.hidden;
  }

  /** 按来源统计，doctor / plugin list 用 */
  statsBySource() {
    const stats = {};
    for (const t of this.tools.values()) {
      const key = t.source.startsWith('plugin:') ? t.source : 'builtin';
      stats[key] = (stats[key] || 0) + 1;
    }
    return stats;
  }

  /**
   * 判断某个工具这次调用是否需要用户确认。
   *
   * 三档权限（界面输入区的「权限」栏，存在 cfg.approval.mode）：
   *   · ask（询问）      —— 危险工具 / 内置工具都问；只读白名单免问（原来的行为）
   *   · workspace（工作区内）—— 写文件只要**落在工作目录里**就免问；越界、探测不到路径、
   *                             以及「永远危险」的命令仍然问
   *   · full（完全权限） —— 不再问；只有工具自己坚持「必须问」的（比如 rm -rf /、
   *                             git push --force 这类硬黑名单）才会拦一下
   *
   * 优先级（从高到低）：
   *   1. 工具自带 needsConfirmation(args, cfg, mode) —— 最懂自己（shell 按命令内容判断）
   *   2. 敏感文件闸门（.env / config.json / 私钥…）—— 在免确认白名单**之前**，免得被它绕过
   *   3. 工具声明 autoApprove / 配置里的白名单
   *   4. 权限档位（full 直接放行）
   *   5. 危险工具 / 内置工具默认要问
   *   6. 插件工具：**按插件声明的权限**判断（声明了写文件/执行命令就要问）
   */
  needsConfirmation(tool, args, ctx = {}) {
    const mode = approvalMode(this.cfg);
    const own = typeof tool.needsConfirmation === 'function' ? tool.needsConfirmation(args, this.cfg, mode) === true : null;
    // 工具自己说「必须问」的，任何档位都不绕过（硬黑名单就靠这条兜底）
    if (own === true) return true;

    // 用户明确选了「完全权限」就别再拦（那道弹窗已经把代价说清楚了）
    if (mode === 'full') return false;

    /**
     * 敏感文件闸门：读 .env / config.json / 私钥这类文件之前先问一句。
     *
     * 为什么单独加一道：read/glob/grep 默认就在 tools.autoApprove 里（免确认），
     * 而它们正好是最容易被「顺手搜一下」利用的工具——模型读到一段恶意文本后，
     * 一句 grep 就能把 apiKey 搜进上下文、随后随下一轮请求发给上游。
     * 这类文件正常干活时用不着读，所以宁可问一句；tools.guardSensitive=false 可关。
     */
    if (this.cfg.tools.guardSensitive !== false && touchesSensitivePath(tool, args)) return true;

    if (tool.autoApprove) return false;
    const auto = (this.cfg.tools.autoApprove || []).map(normalizeName);
    if (auto.includes(tool.name)) return false;

    /**
     * 工具自己说「这次不用问」也要认——这是「只读白名单」真正生效的地方。
     *
     * 以前这条只在工作区档生效，于是两种档位下它都不起作用：
     *   · ask 档：安全命令（ls / git status）也会一路落到 needsConfirm 被问（和文档不符）；
     *   · workspace 档：shell 自己对所有命令都返回 false，等于命令全免问。
     * 现在统一成：ask 档 = 白名单免问、其余都问；workspace 档 = 命令不再逐条问。
     */
    if (own === false) return false;

    if (mode === 'workspace') {
      // 工作区档：写文件看是否落在工作目录内；命令不逐条问（这一档的取舍，文档里写清了）
      return !insideWorkspace(tool, args, ctx);
    }

    if (tool.needsConfirm) return true;
    if (tool.dangerous) return true;
    if (tool.source === 'builtin') return true;

    /**
     * 插件工具：以前一律放行，这是不对的——「内置工具要问、插件工具不问」
     * 意味着**从 GitHub 一键装进来的代码比自带代码更自由**。
     *
     * 判定依据是插件自己声明的权限（manifest.permissions）：
     *   · 声明了 fs:write / fs:delete / shell:exec / net:write 这类会改东西的权限 → 必须问
     *   · 没声明 → 当只读工具放行（否则 hello / list_tree 这类纯读插件天天弹窗，
     *     用户最后会干脆切到「完全权限」，反而更危险）
     *
     * 要说清楚：permissions 是**声明**，不是沙箱（插件代码本身跑在进程里，
     * 它想干什么是拦不住的）。所以这条规则解决的是「知情同意」，
     * 不是「隔离」——真正的隔离要靠进程级手段，那是另一个量级的工程。
     */
    if (isPluginTool(tool)) {
      return pluginToolIsRisky(tool);
    }
    return false;
  }

  /**
   * 执行一次工具调用（带校验、确认、事件、截断）。
   * @param {string} name 工具名
   * @param {object} rawArgs 模型给的参数
   * @param {object} ctx 运行上下文（session/日志/配置/cwd 等）
   * @returns {Promise<{ok:boolean, content:string, meta:object}>}
   *   content 是会回填给模型的文本，永远不抛异常（错误也变成文本）。
   */
  async execute(name, rawArgs, ctx = {}) {
    const started = Date.now();
    const tool = this.get(name);

    if (!tool) {
      const candidates = closest(name, [...this.tools.keys()]);
      const hint = candidates.length ? `你是不是想用：${candidates.join(' / ')}？` : '';
      return {
        ok: false,
        content: `错误：不存在名为 "${name}" 的工具。${hint}\n可用工具：${[...this.tools.keys()].join(', ')}`,
        meta: { toolName: name, ms: 0, notFound: true },
      };
    }

    // ---- 1) 参数校验 ----
    const validated = validateArgs(tool.parameters, rawArgs);
    if (!validated.ok) {
      return {
        ok: false,
        content: `工具 ${tool.name} 参数有误：${validated.error}`,
        meta: { toolName: tool.name, ms: Date.now() - started, invalidArgs: true },
      };
    }
    const args = validated.value;

    // ---- 2) 前置钩子（插件可拦截） ----
    if (this.bus) {
      const proceed = await this.bus.emit(
        'tool:before',
        { toolName: tool.name, args, tool, ctx },
        { bail: true },
      );
      if (proceed === false) {
        return {
          ok: false,
          content: `工具 ${tool.name} 的执行被插件钩子拦截。`,
          meta: { toolName: tool.name, ms: Date.now() - started, blocked: true },
        };
      }
    }

    // ---- 3) 安全确认闸门 ----
    if (this.needsConfirmation(tool, args, ctx)) {
      const preview = ctx.preview || describeCall(tool, args);
      /**
       * 改动预览（diff）单独走 detail 通道：
       * 问句那一行是「允许执行 write 吗？」，diff 是另一块内容。
       * 混在一行里，界面上就没法把 +/- 着色，终端里也会挤成一团。
       */
      let detail = '';
      if (tool.preview) {
        try {
          const shown = await tool.preview(args, ctx);
          detail = typeof shown === 'string' ? shown : (shown && shown.text) || '';
        } catch (err) {
          // 预览失败不能挡住执行本身：拿不到 diff 就照旧问
          detail = `（生成改动预览失败：${err.message}）`;
        }
      }
      const allowed = await ctx.confirm(`允许执行 ${tool.name} 吗？\n     ${preview}`, { detail });
      if (!allowed) {
        // 返回给模型的文案很关键：要让它知道「不是出错，是人不同意」
        return {
          ok: false,
          content: `用户拒绝执行 ${tool.name}。请不要重试同一操作；如果这是完成任务的必要步骤，请说明原因并询问用户。`,
          meta: { toolName: tool.name, ms: Date.now() - started, denied: true },
        };
      }
      // 标记「已经过用户同意」，工具内部就不会重复问一遍
      args[CONFIRMED] = true;
    }

    // ---- 4) 真正执行 ----
    let ok = true;
    let content = '';
    try {
      const result = await tool.run(args, ctx);
      if (result && typeof result === 'object' && 'content' in result) {
        ok = result.ok !== false;
        content = String(result.content ?? '');
      } else {
        content = result === undefined || result === null ? '(工具没有返回内容)' : String(result);
      }
    } catch (err) {
      ok = false;
      content = `工具 ${tool.name} 执行失败：${err && err.message ? err.message : String(err)}`;
      if (ctx.debug && err && err.stack) content += `\n${err.stack}`;
    }

    const maxChars = this.cfg.tools.maxOutputChars || 30000;
    const wasTruncated = content.length > maxChars;
    content = truncate(content, maxChars);
    const ms = Date.now() - started;
    const summary = summarizeResult(tool, args, content, ok);

    // ---- 5) 后置钩子 ----
    if (this.bus) {
      await this.bus.emit('tool:after', {
        toolName: tool.name,
        args,
        ok,
        output: content,
        summary,
        ms,
        ctx,
      });
    }

    return {
      ok,
      content,
      meta: { toolName: tool.name, ms, summary, truncated: wasTruncated, source: tool.source },
    };
  }
}

/* ------------------------------------------------------------------ */
/* 权限档位                                                            */
/* ------------------------------------------------------------------ */

/** 三档权限的取值（别处也用它做校验，所以放这儿导出） */
const APPROVAL_MODES = ['ask', 'workspace', 'full'];

/** 读当前权限档；配置写错/没写都退回最保守的「询问」 */
function approvalMode(cfg) {
  const raw = cfg && cfg.approval && cfg.approval.mode;
  return APPROVAL_MODES.includes(raw) ? raw : 'ask';
}

/**
 * 这次调用是不是**完全落在工作目录里**（只有工作区档用它）。
 *
 * 判断不出来就返回 false —— 也就是「照问」。宁可多问一句，也不要
 * 因为没看懂参数就把越界操作放过去。
 */
function insideWorkspace(tool, args, ctx) {
  const cwd = (ctx && ctx.cwd) || (ctx && ctx.session && ctx.session.cwd) || '';
  if (!cwd) return false;
  // 文件类工具的目标路径就这几个字段名（内置的 write/edit 用 path，
  // 插件里常见的写法是 file_path / target）
  const target = args && (args.path || args.file_path || args.target);
  if (!target || typeof target !== 'string') {
    // 没有路径参数的工具：只读类放行，其它（可能是任意副作用）继续问
    return READONLY_TOOLS.has(tool.name);
  }
  const raw = target.trim().replace(/^"(.*)"$/, '$1');
  const root = path.resolve(cwd);
  const abs = path.resolve(root, raw);
  return abs === root || abs.startsWith(root + path.sep);
}

/** 纯读工具：工作区档下不给它们弹确认（读文件没有副作用） */
const READONLY_TOOLS = new Set(['read', 'glob', 'grep', 'list_tree', 'file_info']);

/** 插件注册的工具，source 形如 "plugin:插件名" */
function isPluginTool(tool) {
  return typeof tool.source === 'string' && tool.source.startsWith('plugin:');
}

/**
 * 这次调用有没有碰到敏感文件（.env / config.json / 私钥 / .ssh 等）。
 *
 * 只看参数里的路径字段，不做内容嗅探（那既慢又不准）。
 * shell 命令里的路径不做解析——它本来就要确认（除非命中只读白名单，
 * 而白名单里现在已经没有能读文件内容的命令了）。
 */
function touchesSensitivePath(tool, args) {
  if (!args || typeof args !== 'object') return false;
  const candidates = [args.path, args.file_path, args.filePath, args.file, args.target, args.cwd];
  for (const value of candidates) {
    if (typeof value === 'string' && value && isSensitivePath(value)) return true;
  }
  // glob/grep 的 pattern 也可能是 `.env*` 这类直接点名
  if (typeof args.pattern === 'string' && isSensitivePath(args.pattern)) return true;
  if (typeof args.include === 'string' && isSensitivePath(args.include)) return true;
  /**
   * shell 命令串里点名了敏感文件也要问。
   *
   * 不能只靠「命令不在白名单里就问」——工作区档下命令本来就不逐条问，
   * 而 `cat .env` 一条就够把密钥读出来。
   *
   * 按 token 拆开判（`cat .env` 里 `.env` 是独立 token，整串判不出来）。
   * 字符串级匹配当然不完美（`cat $(echo .env)` 就抓不到），
   * 但它挡住的是最常见、最省事的那一类。
   */
  if (typeof args.command === 'string' && commandMentionsSensitive(args.command)) return true;
  void tool;
  return false;
}

/** 命令串里有没有提到敏感文件（按 token 拆开看，含路径最后一段） */
function commandMentionsSensitive(command) {
  const tokens = String(command)
    .split(/[\s"'`=;,|&<>()[\]{}]+/)
    .filter(Boolean);
  return tokens.some((tok) => {
    if (isSensitivePath(tok)) return true;
    const last = tok.split(/[\\/]/).filter(Boolean).pop() || '';
    return last && last !== tok && isSensitivePath(last);
  });
}

/**
 * 会「改东西」的插件权限。声明了任意一条，它的工具就必须先问一句。
 * 这份清单和 plugins.js 里的 KNOWN_PERMISSIONS 是同一套词表。
 */
const RISKY_PLUGIN_PERMISSIONS = [/^fs:write$/, /^fs:delete$/, /^shell:exec$/, /^net:write$/, /^fs:write:/];

/**
 * 插件工具该不该问。
 *
 * 三种情况要问：
 *   1. 工具自己标了 dangerous（插件作者最清楚自己在干什么）；
 *   2. 插件声明了会改东西的权限；
 *   3. —— 反过来，插件没声明任何权限且工具也没标 dangerous，就按只读放行。
 */
function pluginToolIsRisky(tool) {
  if (tool.dangerous) return true;
  const perms = Array.isArray(tool.permissions) ? tool.permissions : [];
  return perms.some((p) => RISKY_PLUGIN_PERMISSIONS.some((re) => re.test(String(p))));
}

/* ------------------------------------------------------------------ */
/* 展示辅助                                                            */
/* ------------------------------------------------------------------ */

/** 确认提示里显示「这次到底要干什么」 */
function describeCall(tool, args) {
  if (tool.name === 'shell') return `$ ${args.command}`;
  if (['write', 'edit'].includes(tool.name)) {
    const len = typeof args.content === 'string' ? `（${args.content.length} 字符）` : '';
    return `写入 ${args.path || args.file_path} ${len}`;
  }
  const keys = Object.keys(args || {});
  if (!keys.length) return '(无参数)';
  return keys.map((k) => `${k}=${String(args[k]).slice(0, 60)}`).join(', ');
}

/** 一行结果摘要，给终端看 */
function summarizeResult(tool, args, content, ok) {
  if (!ok) return content.split('\n')[0].slice(0, 120);
  const lines = content ? content.split('\n').length : 0;
  switch (tool.name) {
    case 'read':
      return `读取 ${args.path || args.file_path}（${lines} 行）`;
    case 'write':
      return `已写入 ${args.path || args.file_path}`;
    case 'edit':
      return `已修改 ${args.path || args.file_path}`;
    case 'glob':
      return `匹配到 ${lines} 个文件`;
    case 'grep':
      return `匹配到 ${lines} 行`;
    case 'shell':
      return `命令结束（输出 ${lines} 行）`;
    default:
      return content ? content.split('\n')[0].slice(0, 120) : `${tool.name} 完成`;
  }
}

module.exports = {
  ToolRegistry,
  Tool,
  validateArgs,
  normalizeName,
  describeCall,
  CONFIRMED,
  APPROVAL_MODES,
  approvalMode,
};
