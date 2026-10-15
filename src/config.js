'use strict';

/**
 * 梦云 Agent —— 配置系统
 *
 * 分层覆盖（后者覆盖前者）：
 *   1. 代码内置默认值 DEFAULTS
 *   2. .env 文件
 *   3. config.json（项目根目录）
 *   4. 进程环境变量 MYA_*
 *   5. 命令行参数
 *
 * 这一层刻意做得「无依赖 + 容错」：即使 config.json 不存在，
 * 也能靠 .env 或环境变量把 agent 跑起来。
 */

const fs = require('fs');
const path = require('path');

/** 服务商预设：只要填了 apiKey 就能开跑 */
const PROVIDER_PRESETS = {
  deepseek: {
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
  },
  openai: {
    label: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  ollama: {
    label: '本地 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5-coder:7b',
  },
  custom: {
    label: '自定义 OpenAI 兼容网关',
    baseUrl: '',
    model: '',
  },
};

/** 内置默认配置 */
const DEFAULTS = {
  provider: 'deepseek',
  /**
   * 接口格式（协议）。'auto' = 按 baseUrl 自动识别。
   * 中转站的协议各不相同，选错会报 404/401，所以做成可选项而不是写死一种。
   * 取值见 src/provider.js 的 API_FORMATS。
   */
  apiFormat: 'auto',
  apiKey: '',
  baseUrl: '',
  model: '',
  temperature: 0.3,
  /**
   * 推理等级（reasoning effort）。'auto' = 一个字段都不发（和没有这个功能时一样）。
   *
   * 这里存的是**语义值**（auto/low/medium/high，另加 OpenAI 特有的 minimal），
   * 不是某家的参数名：三家官方 API 的形状完全不同（OpenAI 用 reasoning_effort，
   * Anthropic 用 thinking.budget_tokens，Gemini 用 thinkingConfig.thinkingBudget），
   * 翻译由 src/reasoning.js 统一负责，界面上的选项也从那里来。
   */
  reasoning: {
    level: 'auto',
  },
  maxTurns: 25,
  timeoutSec: 120,
  stream: true,
  lang: 'zh',
  /**
   * 上下文窗口（token）。0 表示按模型名自动推断（见 session.js 的 CONTEXT_WINDOWS）。
   * 界面上的「上下文用量条」用它做分母；服务商响应里只告诉我们用了多少，
   * 不会告诉我们最多多少，所以要么推断、要么手填。
   */
  contextWindow: 0,
  /** 上下文压缩（由 context-compact 插件实现，这里只是它的配置） */
  compact: {
    enabled: true,
    /**
     * 是否自动压缩。默认 true（阈值 0.62）。
     *
     * 为什么从「默认手动」改成「默认自动」：手动意味着用户得自己盯着圆环，
     * 而长会话真正撞上窗口时，代价是上游直接 400、这一轮白跑。
     * 自动压缩的代价是「历史被改写」，所以两件事必须同时成立才算安全：
     *   1) 压缩在对话里留一条可展开的记录（compaction 块），用户能看出发生了什么；
     *   2) 阈值留出余量（0.62），不是等到贴边才动手。
     * 想恢复纯手动：把 auto 改成 false（设置里也有开关）。
     */
    auto: true,
    /** 自动模式下，用量超过这个比例就压缩 */
    threshold: 0.62,
    /** 压缩后保留最近多少条消息 */
    keepRecent: 8,
    /** 摘要最多多少 token */
    maxSummaryTokens: 1200,
  },
  systemPromptFile: 'prompts/system.zh.md',
  /**
   * git 检查点：动文件之前自动打一个点，改崩了能回去。
   *
   * 只在**用户自己的 git 仓库**里生效：不是仓库就什么都不做（绝不偷偷 git init，
   * 那是用户对自己项目的决定）。打点用的是独立索引 + 隐藏 ref，不碰 HEAD/暂存区/工作区。
   */
  checkpoint: {
    enabled: true,
    /** 最多保留多少个检查点（旧的自动清掉，ref 攒多了会拖慢 for-each-ref） */
    keep: 50,
  },
  /**
   * 权限档位（界面输入区的「权限」栏，三选一）。
   *
   *   ask       —— 询问：危险操作/写文件/跑命令都先问一句（默认，最保守）
   *   workspace —— 工作区内：写文件只要落在工作目录里就免问；越界仍然问；
   *                命令也不再逐条问（高破坏性命令永远问）
   *   full      —— 完全权限：不再问（硬黑名单那几条除外）
   *
   * 默认必须是 ask：这是个「一键放开」的开关，默认值决定了用户会不会
   * 在不知情的情况下让 agent 直接改文件。
   */
  approval: {
    mode: 'ask',
  },
  /**
   * 并行子任务（复杂任务拆分）。
   *
   * 取值都很保守，理由：拆出去的子任务和父任务**用的是同一个网关、同一个 key**，
   * 一次放太多并行请求，最可能的结果是互相限流、一起变慢；
   * 而子任务能写文件必然竞态（两个 write 打同一个文件），所以默认只给只读工具。
   */
  tasks: {
    enabled: true,
    /** 同时最多跑几个子任务 */
    maxParallel: 3,
    /** 最多嵌套几层：1 = 子任务不能再拆子任务 */
    maxDepth: 1,
    /** 一次用户消息里最多拆几个 */
    maxTasks: 6,
    /** 每个子任务最多几轮 */
    subTurns: 12,
    /** 单个子任务超时（秒） */
    subTimeoutSec: 600,
    /** 一次用户消息里，所有子任务合计最多多少轮 */
    budgetTurns: 30,
    /** 一次用户消息里，所有子任务合计最多多少 token */
    budgetTokens: 200000,
    /** 子任务默认可用的工具（默认只读；要放开写权限就在 task_spawn 里显式给 allow_tools） */
    readonlyTools: ['read', 'glob', 'grep'],
  },
  tools: {
    autoApprove: ['read', 'glob', 'grep'],
    /**
     * 读敏感文件（.env / config.json / 私钥 / .ssh 等）之前要不要问一句。
     *
     * 默认 true。为什么需要它：read/glob/grep 在 autoApprove 里是免确认的，
     * 而它们正是「读到一段恶意文本 → 顺手把 apiKey 搜进上下文 → 随下一轮请求发给上游」
     * 这条链路上最好用的工具。这类文件正常干活时用不着读，问一句成本很低。
     * 嫌烦可以设成 false（等于明确接受这个风险）。
     */
    guardSensitive: true,
    deny: [],
    maxOutputChars: 30000,
  },
  plugins: {
    enabled: true,
    dirs: ['plugins'],
    disabled: [],
  },
  session: {
    save: true,
    dir: '.mya/sessions',
    maxHistoryMessages: 200,
  },
  shell: {
    allowDangerous: false,
    timeoutSec: 60,
  },
  /**
   * 联网搜索（内置工具 web_search / web_fetch）。
   *
   * 默认开：模型遇到「这个库最新版本是什么」这类问题时，
   * 有搜索能力和没有搜索能力完全是两种体验。
   * 但内网环境可能完全出不去，那种情况下把它关掉更省事——
   * 关掉后这两个工具根本不会注册，模型也就不会去做必然失败的调用。
   */
  web: {
    enabled: true,
    /**
     * 搜索后端：
     *   bing       —— 免密钥，国内可直连（默认，实测 100~300ms）
     *   duckduckgo —— 免密钥，但国内不少网络连不通（实测 12s 超时），仅作备选
     *   custom     —— 自建 SearXNG 或其它搜索 API，地址填在 endpoint
     */
    provider: 'bing',
    /** provider=custom 时的接口地址，可以写 {query} 占位符 */
    endpoint: '',
    /** 一次搜索取回几条结果 */
    maxResults: 5,
    timeoutSec: 15,
    /** 抓网页时最多返回多少字符（防止把上下文撑爆） */
    maxChars: 20000,
  },
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 深合并：对象递归合并，数组整体替换（数组用「替换」更符合直觉） */
function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith('$')) continue; // 配置里的 $ 注释键直接忽略
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** 把 "1/true/yes/on" 认成 true，把 "0/false/no/off" 认成 false，其余返回 undefined */
function parseBool(value) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return undefined;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return undefined;
}

function parseNumber(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 把逗号分隔的字符串转成数组；数组原样返回 */
function parseList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* .env 解析                                                           */
/* ------------------------------------------------------------------ */

/** 解析 .env 文本 → 对象（支持 # 注释、export 前缀、单双引号、\n 转义） */
function parseEnvText(text) {
  const env = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    let value = line.slice(eq + 1).trim();

    // 值的解析分两种情况：
    //   a) 引号包裹："https://x" # 注释   → 取配对引号之间的内容，后面当注释
    //   b) 无引号：   value # 注释        → 遇到 " #" 截断
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.indexOf(quote, 1);
      if (end === -1) {
        value = value.slice(1); // 引号没闭合，退化成取剩余内容
      } else {
        const inner = value.slice(1, end);
        value = quote === '"' ? inner.replace(/\\n/g, '\n').replace(/\\t/g, '\t') : inner;
      }
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (key) env[key] = value;
  }
  return env;
}

/** 读取 .env 文件；不存在则返回空对象 */
function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    return parseEnvText(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* 主加载函数                                                          */
/* ------------------------------------------------------------------ */

/**
 * 加载配置。
 * @param {object}  [options]
 * @param {string}  [options.rootDir]  项目根目录（默认取 package.json 所在目录）
 * @param {object}  [options.cli]      命令行覆盖项，优先级最高
 * @returns {object} 冻结后的最终配置对象
 */
function loadConfig(options = {}) {
  const rootDir = options.rootDir || resolveConfigDir();
  const envFile = loadEnvFile(path.join(rootDir, '.env'));
  const readEnv = (key) => {
    const raw = process.env[key] !== undefined ? process.env[key] : envFile[key];
    if (raw === undefined || raw === null) return undefined;
    // 空字符串 / 纯空白一律按「没设置」处理。
    // 否则 .env 模板里留的 MYA_API_KEY=（空占位行）会把 config.json 里
    // 真正配好的 key 静默清掉——用户只会看到 401，查半天不知道 key 被谁抹掉了。
    const s = String(raw).trim();
    return s === '' ? undefined : s;
  };

  // ---- 1) config.json ----
  let fileConfig = {};
  const configPath = path.join(rootDir, 'config.json');
  try {
    if (fs.existsSync(configPath)) {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (err) {
    // 配置写坏了不能直接崩，给出可读提示后回退到默认值
    console.error(`[配置] config.json 解析失败，已回退默认值：${err.message}`);
    fileConfig = {};
  }

  let cfg = deepMerge(DEFAULTS, fileConfig);

  /**
   * ---- 1.5) config.local.json（本机私有覆盖）----
   *
   * .gitignore 里忽略它已经很久了，但**一直没人读它**——那等于给用户一个
   * 骗人的配置项：写了不生效，还找不到原因。分层顺序定死为
   *   config.json（可提交的团队默认值）
   *     → config.local.json（本机私有：真实网关地址、个人偏好）
   *       → 环境变量（CI / 临时覆盖，优先级最高）
   */
  const localPath = path.join(rootDir, 'config.local.json');
  let localConfig = {};
  try {
    if (fs.existsSync(localPath)) {
      localConfig = JSON.parse(fs.readFileSync(localPath, 'utf8'));
      cfg = deepMerge(cfg, localConfig);
    }
  } catch (err) {
    console.error(`[配置] config.local.json 解析失败，已忽略这一层：${err.message}`);
  }

  // ---- 2) 环境变量覆盖 ----
  const envPatch = {};
  let envSource = '';
  const setIf = (cond, fn) => cond && fn();

  setIf(readEnv('MYA_PROVIDER') !== undefined, () => {
    envPatch.provider = String(readEnv('MYA_PROVIDER')).trim();
  });
  setIf(readEnv('MYA_API_FORMAT') !== undefined, () => {
    envPatch.apiFormat = String(readEnv('MYA_API_FORMAT')).trim().toLowerCase();
  });
  setIf(readEnv('MYA_API_KEY') !== undefined, () => {
    envPatch.apiKey = String(readEnv('MYA_API_KEY')).trim();
    /**
     * 记下这把 Key 是从哪一层来的（.env / 系统环境变量 / config.json / 自带默认）。
     *
     * 为什么值得记：Key 被「模板占位符」静默覆盖时，用户看到的所有报错都
     * 不会提到 .env——排查者（人和 agent）最容易缺的就是「这个值到底是谁给的」。
     * 有这个字段，启动警告和「测试连接」就能直接点名该改哪个文件。
     */
    envSource =
      process.env.MYA_API_KEY !== undefined && process.env.MYA_API_KEY.trim() !== ''
        ? '系统环境变量'
        : `配置目录的 .env`;
  });
  setIf(readEnv('MYA_BASE_URL') !== undefined, () => {
    envPatch.baseUrl = String(readEnv('MYA_BASE_URL')).trim().replace(/\/+$/, '');
  });
  setIf(readEnv('MYA_MODEL') !== undefined, () => {
    envPatch.model = String(readEnv('MYA_MODEL')).trim();
  });
  setIf(readEnv('MYA_TEMPERATURE') !== undefined, () => {
    envPatch.temperature = parseNumber(readEnv('MYA_TEMPERATURE'), cfg.temperature);
  });
  setIf(readEnv('MYA_MAX_TURNS') !== undefined, () => {
    envPatch.maxTurns = parseNumber(readEnv('MYA_MAX_TURNS'), cfg.maxTurns);
  });
  setIf(readEnv('MYA_TIMEOUT') !== undefined, () => {
    envPatch.timeoutSec = parseNumber(readEnv('MYA_TIMEOUT'), cfg.timeoutSec);
  });
  setIf(readEnv('MYA_CONTEXT_WINDOW') !== undefined, () => {
    envPatch.contextWindow = parseNumber(readEnv('MYA_CONTEXT_WINDOW'), cfg.contextWindow);
  });
  setIf(parseBool(readEnv('MYA_STREAM')) !== undefined, () => {
    envPatch.stream = parseBool(readEnv('MYA_STREAM'));
  });
  setIf(readEnv('MYA_LANG') !== undefined, () => {
    envPatch.lang = String(readEnv('MYA_LANG')).trim();
  });
  setIf(readEnv('MYA_SYSTEM_PROMPT_FILE') !== undefined, () => {
    envPatch.systemPromptFile = String(readEnv('MYA_SYSTEM_PROMPT_FILE')).trim();
  });
  setIf(parseBool(readEnv('MYA_YES')) !== undefined, () => {
    envPatch._assumeYes = parseBool(readEnv('MYA_YES'));
  });
  setIf(parseBool(readEnv('MYA_ALLOW_DANGEROUS')) !== undefined, () => {
    envPatch.shell = { allowDangerous: parseBool(readEnv('MYA_ALLOW_DANGEROUS')) };
  });
  setIf(readEnv('MYA_TAVILY_KEY') !== undefined, () => {
    envPatch._tavilyKey = String(readEnv('MYA_TAVILY_KEY')).trim();
  });
  if (readEnv('MYA_PLUGIN_DIRS') !== undefined) {
    envPatch.plugins = { dirs: parseList(readEnv('MYA_PLUGIN_DIRS')) };
  }
  if (readEnv('MYA_PLUGINS_DISABLED') !== undefined) {
    envPatch.plugins = { ...(envPatch.plugins || {}), disabled: parseList(readEnv('MYA_PLUGINS_DISABLED')) };
  }
  if (readEnv('MYA_TOOLS_AUTO_APPROVE') !== undefined) {
    envPatch.tools = { autoApprove: parseList(readEnv('MYA_TOOLS_AUTO_APPROVE')) };
  }
  if (readEnv('MYA_TOOLS_DENY') !== undefined) {
    envPatch.tools = { ...(envPatch.tools || {}), deny: parseList(readEnv('MYA_TOOLS_DENY')) };
  }
  if (readEnv('MYA_DATA_DIR') !== undefined) {
    envPatch.session = { dir: path.join(String(readEnv('MYA_DATA_DIR')).trim(), 'sessions') };
  }

  cfg = deepMerge(cfg, envPatch);

  /**
   * Key 的来源记账：envPatch 里有就是 .env/环境变量那层给的；
   * 没有就是 config.json 或本地覆盖层带的。占位符警告要靠它点名文件。
   * （放归一化之前打，因为下面 provider/baseUrl 的兜底逻辑不碰 apiKey。）
   */
  cfg.keySource = envPatch.apiKey !== undefined
    ? envSource
    : fs.existsSync(path.join(rootDir, 'config.local.json'))
      ? '配置目录的 config.json / config.local.json'
      : '配置目录的 config.json';

  // ---- 3) 命令行覆盖 ----
  if (options.cli) cfg = deepMerge(cfg, stripPrivate(options.cli));

  // ---- 4) 收尾归一化 ----
  cfg.provider = String(cfg.provider || 'deepseek').toLowerCase();
  const preset = PROVIDER_PRESETS[cfg.provider];
  if (!preset) cfg.provider = 'custom';
  const finalPreset = PROVIDER_PRESETS[cfg.provider];

  cfg.baseUrl = (cfg.baseUrl || finalPreset.baseUrl || '').replace(/\/+$/, '');
  cfg.model = cfg.model || finalPreset.model || '';
  // 接口格式：只认已知的几种，其余一律回到 auto（免得手写错值导致请求发不出去）
  {
    const { FORMAT_KEYS } = require('./provider');
    const want = String(cfg.apiFormat || 'auto').toLowerCase();
    cfg.apiFormat = want === 'auto' || FORMAT_KEYS.includes(want) ? want : 'auto';
  }
  cfg.temperature = parseNumber(cfg.temperature, 0.3);
  cfg.maxTurns = Math.max(1, Math.floor(parseNumber(cfg.maxTurns, 25)));
  cfg.timeoutSec = Math.max(5, parseNumber(cfg.timeoutSec, 120));
  cfg.contextWindow = Math.max(0, Math.floor(parseNumber(cfg.contextWindow, 0)));
  cfg.stream = cfg.stream !== false;
  cfg.lang = String(cfg.lang || 'zh').startsWith('en') ? 'en' : 'zh';

  // 路径全部转成绝对路径，后续模块不用再关心 cwd
  cfg.rootDir = rootDir;
  // 工作目录必须在解析其他路径之前就确定下来：插件目录、数据目录都依赖它
  cfg.cwd = cfg.cwd || process.cwd();
  cfg.dataDir = path.resolve(rootDir, readEnv('MYA_DATA_DIR') || '.mya');
  cfg.session.dir = path.resolve(rootDir, cfg.session.dir || path.join('.mya', 'sessions'));
  cfg.systemPromptFile = cfg.systemPromptFile
    ? path.resolve(rootDir, cfg.systemPromptFile)
    : '';

  // 插件目录按「工作目录优先，程序目录兜底」解析。
  // 为什么不是直接用 rootDir：插件是跟着「你在哪个项目里干活」走的。
  // 如果写死成程序目录，那你在 A 项目里装了个插件，跑到 B 项目它也会跟着生效，
  // 这既反直觉又不安全。所以：
  //   - 配置里写相对路径（默认 "plugins"）→ 相对工作目录
  //   - 工作目录下没有 plugins → 用程序自带的 plugins（保证开箱即用）
  //   - 配置里写绝对路径 → 原样使用
  cfg.pluginDirs = resolvePluginDirs(cfg.plugins.dirs, cfg.cwd, rootDir);

  // 程序自带的插件目录与插件目录清单（内置插件市场用）。
  // 独立于 rootDir：打包版里 rootDir 是用户数据目录，那儿没有 plugins/，
  // 而自带资源在 app.asar 里——只能读，不能写。
  const bundledDir = bundledDirOf(rootDir);
  cfg.bundledPluginDir = path.join(bundledDir, 'plugins');
  cfg.catalogDir = path.join(bundledDir, 'catalog');

  // 便捷派生字段
  cfg.assumeYes = cfg._assumeYes === true;
  cfg.tavilyKey = cfg._tavilyKey || '';
  // GitHub Token：用于插件市场的搜索配额（不填也能用，只是配额低）
  cfg.githubToken = readEnv('GITHUB_TOKEN') || readEnv('GH_TOKEN') || cfg.githubToken || '';
  // Ollama 之类本地服务不需要真 key，这里给个占位符，省得用户被卡住
  if (!cfg.apiKey && cfg.provider === 'ollama') cfg.apiKey = 'ollama';
  cfg.hasApiKey = !!cfg.apiKey;

  return cfg;
}

/**
 * 解析插件目录列表。
 * @param {string[]} dirs   配置里写的目录（相对或绝对）
 * @param {string} cwd      当前工作目录
 * @param {string} rootDir  程序所在目录
 * @returns {string[]} 绝对路径列表
 */
function resolvePluginDirs(dirs, cwd, rootDir) {
  const list = Array.isArray(dirs) && dirs.length ? dirs : ['plugins'];
  const resolved = [];
  for (const entry of list) {
    const raw = String(entry || '').trim();
    if (!raw) continue;
    const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(cwd, raw);

    if (fs.existsSync(abs)) {
      resolved.push(abs);
      continue;
    }

    // 工作目录下不存在：如果这是个相对路径（比如默认的 "plugins"），
    // 就用程序自带的同名目录兜底，保证第一次运行就有示例插件可看。
    // 注意：自带目录要用 bundledPluginDir（程序所在目录），不能用 rootDir——
    // 打包之后 rootDir 是用户数据目录，那底下没有 plugins/，
    // 结果就是「打包版里一个示例插件都看不到」。
    if (!path.isAbsolute(raw)) {
      const bundled = path.resolve(bundledDirOf(rootDir), raw);
      if (bundled !== abs && fs.existsSync(bundled)) {
        resolved.push(bundled);
        continue;
      }
    }
    // 都不存在就保留原路径（后续找不到会安静跳过，不报错）
    resolved.push(abs);
  }

  return [...new Set(resolved)];
}

/** 去掉内部私有键（下划线开头），避免污染配置树 */function stripPrivate(obj) {
  if (!isPlainObject(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_')) continue;
    if (v === undefined) continue;
    out[k] = isPlainObject(v) ? stripPrivate(v) : v;
  }
  return out;
}

/** 向上查找 package.json 来定位项目根目录 */
function findRootDir(startDir = __dirname) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..');
}

/**
 * 「程序自带资源」所在的目录（plugins/ 和 catalog/ 都在这儿）。
 *
 * 和配置目录（rootDir）不是一回事：配置目录可以被 MYA_CONFIG_DIR 指走，
 * 打包之后还会变成用户数据目录，而自带资源永远跟着程序走。
 * 打包时它在 app.asar 里面——Electron 给 fs 打过补丁，**读**得到，
 * 但写不进去，所以只能「从里面复制出来」。
 */
function bundledDirOf(rootDir) {
  const programDir = findRootDir();
  return programDir && programDir !== rootDir ? programDir : rootDir;
}

/**
 * 判断一个目录能不能真的写文件。
 * 只看 existsSync 不够——asar 里的路径「存在」但写不进去，
 * 只读的安装目录（Program Files）也是存在但写不了。
 */
function isWritableDir(dir) {
  try {
    const probe = path.join(dir, '.mya-write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** 路径是不是在 asar 包里（只读的虚拟路径） */
function isInsideAsar(p) {
  return /[\\/]app\.asar[\\/]?/i.test(String(p));
}

/**
 * 决定「配置目录」——config.json、.env、.mya 数据目录都放在这里。
 *
 * 为什么不能直接用程序目录：
 * 打包之后程序目录是 `.../resources/app.asar`，那是个**只读的虚拟路径**。
 * 往里写 config.json 会得到：
 *   ENOENT: no such file or directory,
 *   open '...\resources\app.asar\config.json'
 * —— 而且这个目录每次启动都可能变（免安装版会解压到新的临时目录），
 * 就算能写，配置也留不住。
 *
 * 优先级：
 *   1. MYA_CONFIG_DIR（显式指定，测试和高级用户用）
 *   2. 程序目录（开发模式下就在项目里，改起来方便）
 *   3. 用户数据目录（打包后的正常位置；CLI 模式下退回 ~/.mengyun-agent）
 */
function resolveConfigDir() {
  const explicit = process.env.MYA_CONFIG_DIR;
  if (explicit) {
    const dir = path.resolve(explicit);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* 建不出来就让后面的写入报错，至少错误里带着用户给的路径 */
    }
    return dir;
  }

  const programDir = findRootDir();
  if (!isInsideAsar(programDir) && isWritableDir(programDir)) return programDir;

  const home = require('os').homedir();
  const fallback = path.join(home, '.mengyun-agent');
  try {
    fs.mkdirSync(fallback, { recursive: true });
  } catch {
    /* 落到临时目录也比崩了强 */
    return require('os').tmpdir();
  }
  return fallback;
}

/** 生成一个「脱敏」的配置摘要，供 doctor / --debug 打印 */
function describeConfig(cfg) {
  const mask = (s) => {
    if (!s) return '(未设置)';
    const str = String(s);
    if (str.length <= 8) return '***';
    return `${str.slice(0, 4)}***${str.slice(-4)}`;
  };
  // 把「配置里写的」和「实际会用的」都显示出来：
  // 选 auto 时用户需要知道最后到底走了哪种协议，否则出问题没法判断
  let resolvedFormat = cfg.apiFormat || 'auto';
  let extra = '';
  try {
    const { resolveApiFormat, API_FORMATS } = require('./provider');
    const r = resolveApiFormat(cfg);
    resolvedFormat = r.format;
    const label = (API_FORMATS.find((f) => f.key === r.format) || {}).label || r.format;
    if (cfg.apiFormat === 'auto') {
      extra = `（自动识别 → ${label}${r.source === 'default' ? '，地址没有明显特征，按 OpenAI 兼容处理' : ''}）`;
    } else {
      extra = `（${label}）`;
    }
  } catch {
    /* provider 层还没就绪时忽略 */
  }
  return {
    服务商: cfg.provider,
    接口格式: `${resolvedFormat}${extra}`,
    接口地址: cfg.baseUrl || '(空)',
    模型: cfg.model || '(空)',
    APIKey: mask(cfg.apiKey),
    流式输出: cfg.stream,
    最大工具轮数: cfg.maxTurns,
    温度: cfg.temperature,
    数据目录: cfg.dataDir,
    会话目录: cfg.session.dir,
    插件目录: cfg.pluginDirs.join(' | '),
    系统提示词: cfg.systemPromptFile || '(内置默认)',
    危险命令放行: cfg.shell.allowDangerous,
    自动放行工具: cfg.tools.autoApprove.join(', ') || '(无)',
    禁用工具: cfg.tools.deny.join(', ') || '(无)',
  };
}

module.exports = {
  DEFAULTS,
  PROVIDER_PRESETS,
  loadConfig,
  describeConfig,
  resolveConfigDir,
  resolvePluginDirs,
  findRootDir,
  isWritableDir,
  isInsideAsar,
  parseEnvText,
  parseList,
  parseBool,
  /**
   * 检测 Key 是不是「模板占位符」或带非 ASCII 字符。
   *
   * 为什么要它：占位符 Key（sk-在这里填你的key）会静默覆盖真 Key，
   * 所有请求在发出前就死在请求头编码上（ByteString 报错），用户看不懂。
   * 在启动时就指出来，比在报错里让用户猜强一万倍。
   * @returns {{issue:'placeholder'|'non-ascii'|null, hint:string}}
   */
  apiKeyIssue(key) {
    const k = String(key || '').trim();
    if (!k) return { issue: null, hint: '' };
    const nonAscii = [...k].filter((ch) => ch.charCodeAt(0) > 255);
    const placeholder = /在这里|填你的|你的key|你的密钥|placeholder|示例|example|xxx{2,}|粘贴|replace[_-]?me/i;
    if (placeholder.test(k)) {
      return {
        issue: 'placeholder',
        hint: `看起来是模板占位符（${k.slice(0, 3)}…），不是真 Key——真请求会全部失败。`,
      };
    }
    if (nonAscii.length) {
      return {
        issue: 'non-ascii',
        hint: `里面有 ${nonAscii.length} 个非英数字符（${nonAscii.slice(0, 3).join('')}…），请求头装不下它们，请求一个都发不出去。`,
      };
    }
    return { issue: null, hint: '' };
  },
  parseNumber,
  deepMerge,
  isPlainObject,
};
