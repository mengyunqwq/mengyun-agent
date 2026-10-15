'use strict';

/**
 * 梦云 Agent —— 命令行界面
 *
 * 命令一览：
 *   mya                      进入交互式对话（默认）
 *   mya chat                 同上，可 -c 继续上次会话
 *   mya run "任务描述"        一次性执行，不进交互（适合脚本/管道）
 *   mya tools                列出所有工具
 *   mya plugins              列出插件
 *   mya plugin new <名字>     生成插件骨架（改插件最省事的起点）
 *   mya doctor               体检：配置、模型连通性、插件状态
 *   mya config               打印当前生效配置（脱敏）
 *   mya checkpoint           查看 / 回滚 git 检查点（agent 改文件前自动打点）
 *   mya sessions             列出历史会话
 *   mya export <id>          导出会话为 Markdown
 */

const fs = require('fs');
const path = require('path');
const ui = require('./ui');
const { createApp } = require('./app');
const { Session } = require('./session');
const { PluginHost } = require('./plugins');
const { describeConfig } = require('./config');
const { humanSize, humanMs } = require('./utils');
const pkg = require('../package.json');

/* ------------------------------------------------------------------ */
/* 参数解析（不引第三方库，够用）                                       */
/* ------------------------------------------------------------------ */

function parseArgv(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      }
    } else if (token.startsWith('-') && token.length > 1 && !/^-\d/.test(token)) {
      const key = token.slice(1);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

const HELP = `
梦云 Agent —— 本地可插拔编码智能体

用法：
  mya desktop                 打开桌面程序（原生窗口，推荐）
  mya web                     在浏览器里打开界面
  mya chat                    在终端里对话
  mya run "任务"              一次性执行任务
  mya doctor                  环境体检（推荐先跑这个）
  mya doctor --probe          额外把请求摊开：地址 / 鉴权 / 工具协议 / 流式逐层验（接中转站必备）
  mya tools                   列出所有可用工具
  mya plugins                 列出已加载插件
  mya plugin new <名字>        生成插件骨架
  mya config                  查看当前生效配置（密钥已脱敏）
  mya checkpoint list         列出 git 检查点（agent 改文件前会自动打点）
  mya checkpoint restore <ref> --yes   回滚到某个检查点
  mya sessions                列出历史会话
  mya export <会话ID>          导出会话为 Markdown

常用选项：
  -c, --continue              继续最近一次会话
  --session <id>              恢复指定会话
  -m, --model <name>          临时指定模型
  -p, --provider <name>       deepseek | openai | ollama | custom
  --api-format <fmt>          接口协议：openai | anthropic | gemini | auto（默认 auto，按地址识别）
  --probe                     连不上时把请求摊开逐层验；配合 --api-format 可试出中转站认哪种协议
  --base-url <url>            临时指定接口地址
  --key <key>                 临时指定 API Key
  -y, --yes                   自动同意所有工具执行（危险，建议只在沙箱里用）
  --max-turns <n>             单轮最多工具调用轮数
  -v, --verbose               打印更多细节
  --debug                     打印异常堆栈
  -h, --help                  显示本帮助
  --version                   显示版本

桌面程序 / 浏览器界面选项：
  --port <n>                  端口，默认 3080（被占用会自动往后找）
  --host <addr>               监听地址，默认 127.0.0.1（只允许本机）
  --no-open                   启动后不自动打开浏览器（仅 mya web）
  --token <str>               监听非本机地址时的访问令牌（不填会自动生成）
  --dev                       桌面程序打开开发者工具（仅 mya desktop）
  --selftest                  桌面程序自检：检查窗口/桥接/接口是否正常（仅 mya desktop）

终端交互模式内的斜杠命令：
  /help  /exit  /new  /save  /history  /tools  /plugins  /config
  /model <名字>  /yes  /verbose  /clear  /sessions  /export

最省事的用法是双击 start.cmd（Windows）或 ./start.sh（Linux/macOS）。
`;

/** 把命令行参数映射成配置覆盖项 */
function cliOverrides(flags) {
  const cli = {};
  if (flags.model) cli.model = String(flags.model);
  if (flags.provider) cli.provider = String(flags.provider);
  if (flags['api-format']) cli.apiFormat = String(flags['api-format']).toLowerCase();
  if (flags['base-url']) cli.baseUrl = String(flags['base-url']);
  if (flags.key) cli.apiKey = String(flags.key);
  if (flags['max-turns']) cli.maxTurns = Number(flags['max-turns']);
  if (flags.temperature !== undefined) cli.temperature = Number(flags.temperature);
  if (flags.yes === true) cli._assumeYes = true;
  if (flags.stream === false) cli.stream = false;
  return cli;
}

/* ------------------------------------------------------------------ */
/* 输出辅助                                                            */
/* ------------------------------------------------------------------ */

function printToolTable(registry) {
  const tools = registry.list({ includeHidden: true });
  ui.log.title(`可用工具（${tools.length} 个）`);
  const width = Math.max(...tools.map((t) => t.name.length), 6);
  for (const t of tools) {
    const tag = t.source === 'builtin' ? ui.c.gray('内置') : ui.c.magenta(t.source.replace('plugin:', '插件:'));
    const danger = t.dangerous ? ui.c.yellow(' ⚠需确认') : '';
    ui.out(`  ${ui.c.bold(t.name.padEnd(width))}  ${tag}${danger}`);
    ui.out(`  ${' '.repeat(width)}  ${ui.c.gray(t.description.split('\n')[0])}`);
  }
  if (registry.skipped.length) {
    ui.log.title('未注册的工具');
    for (const s of registry.skipped) ui.out(`  ${ui.c.yellow(s.name)} ← ${s.reason}（来源 ${s.source}）`);
  }
}

function printPluginTable(plugins) {
  const list = plugins.list();
  ui.log.title(`已加载插件（${list.length} 个）`);
  if (!list.length) {
    ui.log.dim('  暂无插件。用 `mya plugin new 我的插件` 生成一个骨架试试。');
    return;
  }
  for (const p of list) {
    ui.out(`  ${ui.c.bold(p.name)} ${ui.c.gray(`v${p.version}`)}${p.description ? ui.c.gray(` — ${p.description}`) : ''}`);
    ui.out(`    ${ui.c.gray('目录')} ${p.dir}`);
    if (p.toolNames.length) ui.out(`    ${ui.c.gray('工具')} ${p.toolNames.join(', ')}`);
    if (p.commandNames.length) ui.out(`    ${ui.c.gray('命令')} ${p.commandNames.map((c) => `/${c}`).join(', ')}`);
    if (p.hookEvents.length) ui.out(`    ${ui.c.gray('钩子')} ${[...new Set(p.hookEvents)].join(', ')}`);
    if (p.permissions.length) {
      const risky = p.permissions.filter((x) => ['fs:write', 'shell:exec', 'net:fetch'].includes(x));
      ui.out(`    ${ui.c.gray('权限')} ${p.permissions.join(', ')}${risky.length ? ui.c.yellow('  ⚠ 含高危权限') : ''}`);
    }
  }
  if (plugins.errors.length) {
    ui.log.title('加载失败的插件');
    for (const e of plugins.errors) ui.out(`  ${ui.c.red(e.plugin)} — ${e.error}`);
  }
}

/* ------------------------------------------------------------------ */
/* 各子命令                                                            */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 中转站协议探针                                                       */
/* ------------------------------------------------------------------ */

/**
 * 当普通连通性测试失败时，把请求原样摊开给用户看。
 *
 * 为什么需要这个：接第三方中转站时，「连不上」有七八种可能——
 * 地址少写了 /v1、网关不支持 tools、不支持 stream_options、
 * 密钥要走别的头、模型名不对……统一报「fetch failed」等于没说。
 * 这里把「发到哪个 URL、发了什么、对方回了什么原文」全打出来，
 * 再分别探一次「不带头工具」和「带工具」，就能定位到具体哪一层。
 */
/**
 * 当普通连通性测试失败时，把请求原样摊开给用户看。
 *
 * 为什么需要这个：接第三方中转站时，「连不上」有七八种可能——
 * 地址少写了 /v1、网关不支持 tools、不支持 stream_options、密钥要走别的头、
 * 模型名不对、**协议格式选错了**……统一报「fetch failed」等于没说。
 * 这里把「发到哪个 URL、发了什么、对方回了什么原文」全打出来，
 * 再逐层探，就能定位到具体哪一层。
 *
 * @param {object} cfg
 * @param {string} apiKey
 * @param {string} [formatOverride] 强制用某种格式探（不给就按配置解析）
 */
async function probeTransit(cfg, apiKey, formatOverride) {
  const { API_FORMATS, resolveApiFormat } = require('./provider');
  const resolved = resolveApiFormat(cfg);
  const format =
    formatOverride && API_FORMATS.some((f) => f.key === formatOverride) ? formatOverride : resolved.format;
  const label = (API_FORMATS.find((f) => f.key === format) || {}).label || format;
  const endpoint = probeEndpoint(format, cfg.baseUrl, cfg.model);

  ui.log.title('请求探针');
  const sourceNote = formatOverride ? ui.c.yellow('（手动指定）') : `（配置：${cfg.apiFormat || 'auto'}）`;
  ui.out(`  ${ui.c.gray('接口格式  ')} ${label}${sourceNote}`);
  ui.out(`  ${ui.c.gray('最终地址  ')} ${endpoint}`);
  ui.out(`  ${ui.c.gray('鉴权方式  ')} ${authHint(format, apiKey)}`);
  ui.out(`  ${ui.c.gray('模型      ')} ${cfg.model || ui.c.red('(空)')}`);
  ui.out(`  ${ui.c.gray('流式      ')} ${cfg.stream === false ? '关闭' : '开启'}`);

  const headers = buildProbeHeaders(format, apiKey, cfg);

  /** 发一次请求，把状态码和响应原文都拿出来 */
  const attempt = async (name, stream, withTools) => {
    const body = buildProbeBody(format, cfg, stream, withTools);
    const useEndpoint = stream && format === 'gemini' ? geminiStreamEndpoint(endpoint) : endpoint;
    ui.plain('');
    ui.out(`  ${ui.c.bold(name)}`);
    ui.log.dim(`    请求体：${JSON.stringify(body).slice(0, 240)}`);
    const started = Date.now();
    try {
      const res = await fetch(useEndpoint, {
        method: 'POST',
        headers: stream ? { ...headers, Accept: 'text/event-stream' } : headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      const ms = Date.now() - started;
      if (!res.ok) {
        const { classifyError } = require('./providers/base');
        const info = classifyError(res.status, text);
        ui.log.error(`    HTTP ${res.status}（${humanMs(ms)}）`);
        ui.block(text.slice(0, 600) || '(空响应体)', { indent: '    ', color: ui.c.red });
        // 把类别一起带出去，结论段据此给建议
        return { ok: false, status: res.status, text, kind: info.kind, models: info.models };
      }
      if (stream) {
        // 流式不在这里读完，能拿到数据块就说明网关支持
        ui.log.ok(`    HTTP ${res.status}（${humanMs(ms)}），已经在返回数据`);
        ui.log.dim(`    首块样例：${text.slice(0, 200).replace(/\n/g, '\\n')}`);
        return { ok: text.length > 0, status: res.status };
      }
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* 不是 JSON，下面按结构不匹配处理 */
      }
      const read = readProbeReply(format, json);
      if (!read.matched) {
        ui.log.warn(`    返回了 200，但不是预期的 ${label} 结构。原文：${text.slice(0, 400)}`);
        return { ok: false, status: res.status, text, kind: 'endpoint' };
      }
      ui.log.ok(`    HTTP ${res.status}（${humanMs(ms)}）`);
      ui.out(`    回复：${JSON.stringify(String(read.text || '').slice(0, 80))}`);
      if (read.tools.length) ui.out(`    工具调用：${read.tools.join(', ')}`);
      return { ok: true, ms, json };
    } catch (err) {
      const ms = Date.now() - started;
      const cause = err.cause ? `（底层原因：${err.cause.code || err.cause.message}）` : '';
      ui.log.error(`    没拿到响应（${humanMs(ms)}）：${err.message}${cause}`);
      if (err.cause) ui.log.dim('    这通常是网络层：地址写错、端口不通、代理没生效、或 TLS 证书问题。');
      return { ok: false, error: err };
    }
  };

  // 探针 1：最小请求，验证「地址 + 鉴权 + 模型名」
  const basic = await attempt('① 最小请求（不带工具）', false, false);

  // 探针 2：带工具。很多中转站基础聊天能用，一给 tools 就 400/500，
  // 而 agent 是必须要工具调用的，所以必须单独探这一层
  const toolsProbe = basic.ok
    ? await attempt('② 带工具调用（agent 实际会这么发）', false, true)
    : { ok: false, skipped: true };

  // 探针 3：流式。SSE 不标准的网关会让 agent 一直转圈或报「流式响应为空」
  ui.plain('');
  const streamProbe = basic.ok ? await attempt('③ 流式（SSE）', true, false) : { ok: false, skipped: true };

  /* ---------------- 结论 ---------------- */
  ui.plain('');
  ui.log.title('结论');
  if (!apiKey && cfg.provider !== 'ollama') {
    ui.log.error('没读到 API Key。中转站基本都要密钥，去设置里填上。');
    ui.log.dim('    注意：.env 里空的 MYA_API_KEY= 会覆盖 config.json 里的值，两边都要看。');
  }
  if (!basic.ok && basic.error) {
    ui.log.error('第 ① 层就没通：地址、端口、网络或证书有问题。');
    ui.log.dim('    先确认这个地址在浏览器里能打开；公司网络需要代理的话给 Node 配上代理。');
  } else if (!basic.ok) {
    // 到这里说明请求发出去了、也拿到了业务报错——所以不能一律怪地址或格式。
    // 服务端原文里往往已经写明原因（模型不在分组 / 密钥无效 / 余额不足），
    // 按类别给建议，别让人去折腾无关的地方。
    const kind = basic.kind || 'ok';
    const firstLine = String(basic.text || '').split('\n')[0].slice(0, 200);
    if (kind === 'model') {
      ui.log.error(`模型名不对（HTTP ${basic.status}），不是地址或格式的问题。`);
      for (const m of basic.models) {
        const warn = /image|video|embedding|rerank/i.test(m) ? '（非对话模型，多半不支持工具调用）' : '';
        ui.out(`      ${ui.c.green('·')} ${m}${ui.c.gray(warn)}`);
      }
      ui.log.dim('    把「模型」改成上面任意一个，或到中转站后台确认分组里有哪些模型。');
    } else if (kind === 'auth') {
      ui.log.error(`鉴权被拒（HTTP ${basic.status}）：密钥不对，或协议选错导致鉴权头不对。`);
      ui.log.dim('    OpenAI 兼容用 Bearer、Anthropic 用 x-api-key、Gemini 用 x-goog-api-key。');
      ui.log.dim('    协议不对时换个格式试：mya doctor --probe --api-format <格式>');
    } else if (kind === 'quota') {
      ui.log.error(`额度或权限问题（HTTP ${basic.status}）：不是配置写错，去中转站后台看余额/分组权限。`);
    } else {
      ui.log.error(`第 ① 层失败（HTTP ${basic.status}）：地址通了，但请求被拒。`);
      ui.log.dim('    404：地址写错，或「接口格式」选错导致请求打到不存在的端点。');
      ui.log.dim('    400：模型名不存在，或该模型不接受 temperature / max_tokens 这类参数。');
      ui.log.dim('    401/403：密钥不对，或协议选错。');
    }
    if (firstLine) ui.log.dim(`    服务端原文：${firstLine}`);
    const others = API_FORMATS.map((f) => f.key).filter((k) => k !== format);
    // 只有在「方向可能真是协议」时才建议换格式；模型名错就别让人白折腾
    if (kind !== 'model' && kind !== 'quota' && others.length) {
      ui.log.dim(`    换格式再试：${others.map((k) => `mya doctor --probe --api-format ${k}`).join('   ')}`);
    }
  } else if (!toolsProbe.ok) {
    ui.log.error('第 ② 层失败：基础聊天通，但「带工具」不行 —— 这正是 agent 用不了的原因。');
    ui.log.dim('    说明这个中转站或模型不完整支持工具调用协议。换支持函数调用的模型，或换中转站。');
  } else if (streamProbe.ok === false) {
    ui.log.warn('第 ③ 层失败：工具调用没问题，但流式不标准。');
    ui.log.dim('    应急办法：把「流式输出」关掉（.env 里 MYA_STREAM=0，或设置界面的开关）。');
  } else {
    ui.log.ok(`三层都通（${label}）：地址、鉴权、模型名、工具调用、流式全都没问题。`);
  }
  return basic.ok && toolsProbe.ok ? 0 : 1;
}

/** 按协议拼出请求地址（用户可能把 /v1 也写进来了，这里统一处理） */
function probeEndpoint(format, baseUrl, model) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (format === 'anthropic') {
    return /\/messages$/.test(base) ? base : `${base}/messages`;
  }
  if (format === 'gemini') {
    if (/:generateContent/.test(base)) return base;
    const root = /\/v1beta$|\/v1$/.test(base) ? base : `${base}/v1beta`;
    return `${root}/models/${encodeURIComponent(model || '')}:generateContent`;
  }
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

/** Gemini 的流式是换端点，不是加 stream 字段 */
function geminiStreamEndpoint(endpoint) {
  return endpoint.replace(':generateContent', ':streamGenerateContent');
}

/** 探针用的请求头（替用户把各家的鉴权细节处理好） */
function buildProbeHeaders(format, apiKey, cfg) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'mengyun-agent/0.1',
    ...(cfg.extraHeaders || {}),
  };
  if (format === 'anthropic') {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = cfg.anthropicVersion || '2023-06-01';
  } else if (format === 'gemini') {
    if (apiKey) {
      headers['x-goog-api-key'] = apiKey;
      headers.Authorization = `Bearer ${apiKey}`;
    }
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/** 探针用的请求体（三种协议各写各的） */
function buildProbeBody(format, cfg, stream, withTools) {
  const tools = withTools ? probeToolDefs(format) : null;
  if (format === 'anthropic') {
    const body = {
      model: cfg.model,
      max_tokens: 512,
      messages: [{ role: 'user', content: stream ? '数到三' : 'ping' }],
      stream,
    };
    if (tools) body.tools = tools;
    if (cfg.temperature !== null && cfg.temperature !== undefined) {
      body.temperature = Math.min(1, Math.max(0, Number(cfg.temperature) || 0.3));
    }
    return body;
  }
  if (format === 'gemini') {
    const body = {
      contents: [{ role: 'user', parts: [{ text: stream ? '数到三' : 'ping' }] }],
      generationConfig: { maxOutputTokens: 512 },
    };
    if (tools) body.tools = [{ functionDeclarations: tools }];
    return body;
  }
  const body = {
    model: cfg.model,
    messages: [{ role: 'user', content: stream ? '数到三' : 'ping' }],
    stream,
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

/** 各协议的工具定义形状不同 */
function probeToolDefs(format) {
  const props = { text: { type: 'string' } };
  if (format === 'anthropic') {
    return [
      {
        name: 'echo',
        description: '原样返回输入',
        input_schema: { type: 'object', properties: props, required: ['text'] },
      },
    ];
  }
  if (format === 'gemini') {
    // Gemini 不接受 required 之外的额外 JSON Schema 关键字
    return [{ name: 'echo', description: '原样返回输入', parameters: { type: 'object', properties: props } }];
  }
  return [
    {
      type: 'function',
      function: {
        name: 'echo',
        description: '原样返回输入',
        parameters: { type: 'object', properties: props, required: ['text'] },
      },
    },
  ];
}

/** 从各协议的响应里读出文本和工具调用，确认结构对不对 */
function readProbeReply(format, json) {
  if (!json || typeof json !== 'object') return { matched: false, text: '', tools: [] };
  if (format === 'anthropic') {
    if (!Array.isArray(json.content)) return { matched: false, text: '', tools: [] };
    return {
      matched: true,
      text: json.content.filter((b) => b && b.type === 'text').map((b) => b.text).join(''),
      tools: json.content.filter((b) => b && b.type === 'tool_use').map((b) => b.name),
    };
  }
  if (format === 'gemini') {
    const cand = (json.candidates || [])[0];
    if (!cand) return { matched: false, text: '', tools: [] };
    const parts = (cand.content && cand.content.parts) || [];
    return {
      matched: true,
      text: parts.filter((p) => p && p.text).map((p) => p.text).join(''),
      tools: parts.filter((p) => p && p.functionCall).map((p) => p.functionCall.name),
    };
  }
  const choice = (json.choices || [])[0];
  if (!choice) return { matched: false, text: '', tools: [] };
  const msg = choice.message || {};
  return {
    matched: true,
    text: msg.content || '',
    tools: (msg.tool_calls || []).map((t) => (t.function && t.function.name) || '?'),
  };
}

/** 按格式说明鉴权方式，用户对照文档一看就懂 */
function authHint(format, apiKey) {
  const masked = apiKey ? `${apiKey.slice(0, 6)}***` : '(空)';
  if (format === 'anthropic') return `x-api-key: ${masked} + anthropic-version`;
  if (format === 'gemini') return `x-goog-api-key: ${masked}（同时带 Bearer 兜底）`;
  return `Authorization: Bearer ${masked}`;
}

async function cmdDoctor(opts) {
  const { flags, cwd } = opts;
  ui.log.title(`梦云 Agent v${pkg.version} 体检报告`);
  ui.out(`  Node       ${process.version} (${process.platform}/${process.arch})`);
  ui.out(`  工作目录   ${cwd}`);
  ui.plain('');

  // 1) 配置
  let app;
  try {
    app = await createApp({ cli: cliOverrides(flags), cwd, loadPlugins: true, needProvider: false, quiet: true });
  } catch (err) {
    ui.log.error(`配置加载失败：${err.message}`);
    return 1;
  }
  const { cfg, registry, plugins } = app;

  // --api-format 允许不改配置就试另一种协议：
  // 接中转站时最有用的一步就是「这个地址到底认哪种格式」，一个个试过去即可
  const formatOverride = typeof flags['api-format'] === 'string' ? String(flags['api-format']).toLowerCase() : '';
  if (formatOverride) {
    const { FORMAT_KEYS } = require('./provider');
    if (!FORMAT_KEYS.includes(formatOverride)) {
      ui.log.error(`--api-format 只能是：${FORMAT_KEYS.join(' / ')}（收到 "${formatOverride}"）`);
      return 1;
    }
    cfg.apiFormat = formatOverride;
    ui.log.dim(`（本次强制使用 ${formatOverride} 协议，不改动你的配置）`);
  }

  ui.log.title('配置');
  for (const [k, v] of Object.entries(describeConfig(cfg))) {
    ui.out(`  ${ui.c.gray(String(k).padEnd(12))} ${v}`);
  }

  // 2) 工具与插件
  ui.log.title('能力');
  ui.out(`  内置工具   ${app.builtinCount} 个`);
  const stats = registry.statsBySource();
  for (const [source, count] of Object.entries(stats)) {
    if (source === 'builtin') continue;
    ui.out(`  ${source.padEnd(10)} ${count} 个`);
  }
  ui.out(`  插件       ${plugins.list().length} 个已加载，${plugins.errors.length} 个失败`);
  ui.out(`  钩子       ${app.bus.count()} 个监听器`);
  if (plugins.promptContribs.length) ui.out(`  提示词贡献 ${plugins.promptContribs.length} 条`);

  // 3) 模型连通性
  ui.log.title('模型连通性');
  if (!cfg.baseUrl) {
    ui.log.error('未配置 baseUrl，跳过连通性测试');
    ui.log.dim('    在桌面程序里点「设置 → 模型与 API」，或改 .env 的 MYA_BASE_URL。');
    return 1;
  }
  if (!cfg.hasApiKey && cfg.provider !== 'ollama') {
    ui.log.warn('未检测到 API Key');
  }
  const provider = require('./provider').createProvider(cfg);
  const t0 = Date.now();
  try {
    const reply = await provider.chat({
      messages: [
        { role: 'system', content: '你是一个连通性测试助手，请只回复“ok”两个字符。' },
        { role: 'user', content: 'ping' },
      ],
      tools: [],
      stream: false,
      model: cfg.model,
    });
    const ms = Date.now() - t0;
    ui.log.ok(`连接成功（${humanMs(ms)}）模型回复：${JSON.stringify((reply.text || '').slice(0, 60))}`);
    if (reply.usage) {
      ui.log.dim(`    token 用量：prompt ${reply.usage.prompt_tokens || 0} / completion ${reply.usage.completion_tokens || 0}`);
    }
  } catch (err) {
    ui.log.error('连接失败：');
    ui.block(err.message, { indent: '    ', color: ui.c.red });
    // 错误类别决定该给什么建议，所以不要在这里写死「检查 baseUrl」
    if (err.kind === 'model') {
      ui.log.dim('    原因：模型名不被接受（服务端报错里通常列了可用模型）。');
    } else if (err.kind === 'auth') {
      ui.log.dim('    原因：鉴权失败。检查 API Key；也可能「接口格式」选错导致鉴权头不对。');
    } else if (err.kind === 'quota') {
      ui.log.dim('    原因：额度或权限问题，不是配置错。');
    } else {
      ui.log.dim('    排查建议：1) 检查 API Key（注意 .env 里空的 MYA_API_KEY= 会覆盖配置文件）；');
      ui.log.dim('              2) 确认 baseUrl 写到 /v1；3) 换个「接口格式」试试。');
    }
    // 连不上时直接把请求摊开看——中转站的问题光靠一句 fetch failed 查不动
    await probeTransit(cfg, cfg.apiKey || '', formatOverride || undefined);
    return 1;
  }

  // --probe：即使连通性测试通过了，也把协议细节摊出来看一眼。
  // 接第三方中转站时很有用（能确认工具调用和流式是不是真的支持）
  if (flags.probe === true) {
    await probeTransit(cfg, cfg.apiKey || '', formatOverride || undefined);
  }

  ui.plain('');
  ui.log.ok('体检完成。可以用 `mya` 开始对话了。');
  return 0;
}

async function cmdTools(opts) {
  const app = await createApp({
    cli: cliOverrides(opts.flags),
    cwd: opts.cwd,
    loadPlugins: true,
    needProvider: false,
    quiet: true,
  });
  printToolTable(app.registry);
  if (opts.flags.json) {
    ui.plain('');
    ui.plain(JSON.stringify(app.registry.list().map((t) => t.toOpenAI()), null, 2));
  }
  return 0;
}

async function cmdPlugins(opts) {
  const app = await createApp({
    cli: cliOverrides(opts.flags),
    cwd: opts.cwd,
    loadPlugins: true,
    needProvider: false,
    quiet: true,
  });
  printPluginTable(app.plugins);
  ui.plain('');
  ui.log.dim(`插件目录：${app.cfg.pluginDirs.join('  |  ')}`);
  ui.log.dim(`新增插件：mya plugin new <名字>   然后在 config.json 的 plugins.dirs 里包含该目录`);
  return 0;
}

async function cmdPluginNew(opts) {
  const { positionals, flags } = opts;
  const name = positionals[0];
  if (!name) {
    ui.log.error('用法：mya plugin new <插件名> [--dir plugins] [--desc "描述"]');
    return 1;
  }
  const targetDir = path.resolve(opts.cwd, flags.dir ? String(flags.dir) : 'plugins');
  try {
    const created = PluginHost.scaffold(targetDir, name, {
      description: flags.desc ? String(flags.desc) : '',
      withHook: flags.hook !== false,
      force: !!flags.force,
    });
    ui.log.ok(`插件骨架已生成：${created.dir}`);
    ui.plain('');
    ui.plain(`  插件名   ${created.name}`);
    ui.plain(`  工具名   ${created.toolPrefix}_demo`);
    ui.plain('  命令名   /hello');
    ui.plain('');
    ui.plain('接下来：');
    ui.plain(`  1. 编辑 ${path.join(created.dir, 'index.js')}，把示例换成你自己的逻辑`);
    ui.plain('  2. 运行 mya plugins 确认它能被加载');
    ui.plain('  3. 运行 mya tools 确认新工具已注册');
    ui.plain('  4. 进入 mya 对话，让模型调用你的工具');
    return 0;
  } catch (err) {
    ui.log.error(err.message);
    return 1;
  }
}

async function cmdConfig(opts) {
  const app = await createApp({
    cli: cliOverrides(opts.flags),
    cwd: opts.cwd,
    loadPlugins: false,
    needProvider: false,
    quiet: true,
  });
  if (opts.flags.json) {
    const copy = JSON.parse(JSON.stringify(app.cfg));
    if (copy.apiKey) copy.apiKey = '***已隐藏***';
    ui.plain(JSON.stringify(copy, null, 2));
  } else {
    ui.log.title('当前生效配置');
    for (const [k, v] of Object.entries(describeConfig(app.cfg))) {
      ui.out(`  ${ui.c.gray(String(k).padEnd(12))} ${v}`);
    }
    ui.plain('');
    ui.log.dim('配置优先级：内置默认 < .env < config.json < 环境变量 MYA_* < 命令行参数');
  }
  return 0;
}

/**
 * mya checkpoint —— 查看 / 手动打点 / 回滚（agent 改文件前会自动打点）。
 *
 * 为什么要有命令行入口：检查点是「出事了才用」的东西，而那时候界面可能已经打不开
 * （或者用户就想在终端里干活）。一条命令能回滚，比点按钮可靠。
 *
 * 回滚是破坏性操作（会覆盖工作区当前内容），所以必须显式加 --yes。
 */
async function cmdCheckpoint(opts) {
  const ck = require('./checkpoint');
  const sub = String(opts.positionals[0] || 'list').toLowerCase();
  const arg = String(opts.positionals[1] || '');
  const cwd = opts.cwd;

  const resolveRef = (value) => {
    const list = ck.listCheckpoints(cwd, 200);
    const hit = list.find((x) => x.ref === value || String(x.commit).startsWith(value) || x.ref.endsWith(value));
    return hit ? hit.ref : '';
  };

  if (sub === 'list' || sub === 'ls') {
    if (!ck.isRepo(cwd)) {
      ui.log.warn('当前目录不是 git 仓库。检查点只在 git 仓库里生效（我们不会替你 git init）。');
      return 1;
    }
    const list = ck.listCheckpoints(cwd, Number(opts.flags.limit) || 20);
    if (!list.length) {
      ui.plain('还没有检查点。agent 下次改文件前会自动打一个；也可以 mya checkpoint create [标签] 手动打。');
      return 0;
    }
    ui.log.title(`检查点（${list.length} 个，新的在前）`);
    for (const item of list) {
      ui.out(`  ${ui.c.gray(String(item.commit).slice(0, 7))}  ${ui.c.gray(item.at)}  ${item.label || '(无标签)'}`);
      ui.log.dim(`         ${item.ref}`);
    }
    ui.plain('');
    ui.log.dim('看某个点改了什么：mya checkpoint show <前 7 位>；回滚：mya checkpoint restore <前 7 位> --yes');
    return 0;
  }

  if (sub === 'create' || sub === 'add') {
    const label = opts.positionals.slice(1).join(' ') || 'manual';
    const res = ck.createCheckpoint(cwd, { label });
    if (!res.ok) {
      ui.log.warn(`没能打检查点：${res.reason}${res.error ? `（${res.error}）` : ''}`);
      return 1;
    }
    ui.log.ok(`已记录检查点 ${String(res.commit).slice(0, 7)}（${res.summary}）`);
    ui.log.dim(`  ${res.ref}`);
    const keep = Number(opts.flags.keep) || 50;
    const pruned = ck.pruneCheckpoints(cwd, keep);
    if (pruned) ui.log.dim(`  已清理 ${pruned} 个旧检查点（保留最近 ${keep} 个）`);
    return 0;
  }

  if (sub === 'show') {
    if (!arg) {
      ui.plain('用法：mya checkpoint show <ref 或前 7 位>');
      return 1;
    }
    const ref = resolveRef(arg);
    if (!ref) {
      ui.log.error(`找不到这个检查点：${arg}`);
      return 1;
    }
    const diff = ck.checkpointDiff(cwd, ref);
    ui.log.title(`检查点 ${ref}`);
    if (!diff.files.length) ui.plain('  （和上一个提交相比没有文件差异）');
    for (const f of diff.files) ui.out(`  ${ui.c.gray(f.status.padEnd(2))} ${f.path}`);
    if (diff.stat) {
      ui.plain('');
      ui.plain(diff.stat);
    }
    return 0;
  }

  if (sub === 'restore' || sub === 'undo') {
    if (!arg) {
      ui.plain('用法：mya checkpoint restore <ref 或前 7 位> --yes');
      return 1;
    }
    const ref = resolveRef(arg);
    if (!ref) {
      ui.log.error(`找不到这个检查点：${arg}`);
      return 1;
    }
    if (!opts.flags.yes) {
      ui.log.warn('回滚会用检查点里的内容覆盖工作区当前的文件。确认请加 --yes：');
      ui.log.dim(`  mya checkpoint restore ${arg} --yes`);
      return 1;
    }
    const res = ck.restoreCheckpoint(cwd, ref);
    if (!res.ok) {
      ui.log.error(`回滚失败：${res.reason}${res.error ? `（${res.error}）` : ''}`);
      return 1;
    }
    ui.log.ok(`已回滚到 ${ref}`);
    ui.log.dim('  注意：检查点之后**新建**的文件不会被删掉（回滚只恢复检查点里存在的路径）。');
    return 0;
  }

  ui.plain('用法：');
  ui.plain('  mya checkpoint list                  列出检查点');
  ui.plain('  mya checkpoint create [标签]         立刻打一个');
  ui.plain('  mya checkpoint show <ref>            这个点改了哪些文件');
  ui.plain('  mya checkpoint restore <ref> --yes   回滚到那个点');
  return 1;
}

async function cmdSessions(opts) {  const app = await createApp({
    cli: cliOverrides(opts.flags),
    cwd: opts.cwd,
    loadPlugins: false,
    needProvider: false,
    quiet: true,
  });
  const list = Session.list(app.cfg, Number(opts.flags.limit) || 20);
  ui.log.title(`历史会话（${list.length} 个）`);
  if (!list.length) {
    ui.log.dim('  还没有保存过会话。');
    return 0;
  }
  for (const s of list) {
    ui.out(`  ${ui.c.bold(s.id)}  ${ui.c.gray(s.updatedAt.replace('T', ' ').slice(0, 19))}  ${ui.c.gray(`${s.messageCount} 条 / ${humanSize(s.size)}`)}`);
    ui.out(`    ${s.title}`);
  }
  ui.plain('');
  ui.log.dim('继续某次会话：mya chat --session <id>');
  return 0;
}

async function cmdExport(opts) {
  const id = opts.positionals[0] || (opts.flags.session ? String(opts.flags.session) : '');
  if (!id) {
    ui.log.error('用法：mya export <会话ID> [--out 文件路径]');
    return 1;
  }
  const app = await createApp({
    cli: cliOverrides(opts.flags),
    cwd: opts.cwd,
    loadPlugins: false,
    needProvider: false,
    quiet: true,
  });
  const session = Session.load(app.cfg, id);
  if (!session) {
    ui.log.error(`找不到会话：${id}（用 mya sessions 看看有哪些）`);
    return 1;
  }
  const outPath = opts.flags.out
    ? path.resolve(opts.cwd, String(opts.flags.out))
    : path.join(app.cfg.dataDir, 'exports', `${id}.md`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, session.toMarkdown(), 'utf8');
  ui.log.ok(`已导出：${outPath}`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* 交互式对话                                                          */
/* ------------------------------------------------------------------ */

/** 解析一行斜杠命令，返回 {name, arg} 或 null */
function parseSlash(line) {
  const m = /^\/([a-zA-Z\u4e00-\u9fa5_-]+)\s*(.*)$/.exec(line.trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), arg: m[2].trim() };
}

async function cmdChat(opts) {
  const { flags, cwd } = opts;
  const app = await createApp({ cli: cliOverrides(flags), cwd, loadPlugins: true, needProvider: true });
  const { cfg, agent, registry, plugins } = app;

  // 恢复会话
  let session;
  const wantContinue = flags.continue === true || flags.c === true;
  const wantSession = flags.session ? String(flags.session) : '';
  if (wantSession) {
    session = Session.load(cfg, wantSession);
    if (!session) {
      ui.log.warn(`找不到会话 ${wantSession}，已新建会话`);
    }
  } else if (wantContinue) {
    const recent = Session.list(cfg, 1);
    if (recent.length) {
      session = Session.load(cfg, recent[0].id);
      if (session) ui.log.ok(`已恢复最近会话 ${session.id}（${session.countTurns()} 轮）`);
    }
  }
  if (!session) session = agent.createSession({ cwd });

  ui.banner({
    version: pkg.version,
    model: cfg.model,
    provider: cfg.provider,
    rootDir: cwd,
    plugins: plugins.list().map((p) => p.name),
  });
  ui.log.dim(`  会话 ${session.id}  ·  工具 ${registry.list().length} 个  ·  Ctrl+C 中断当前任务`);
  ui.plain('');

  let verbose = !flags.quiet;
  let running = true;

  // Ctrl+C：正在跑任务就中断任务，空闲时就提示再按一次退出
  let sigintCount = 0;
  const onSigint = () => {
    if (agent.isRunning) {
      agent.abort();
      sigintCount = 0;
    } else {
      sigintCount += 1;
      if (sigintCount >= 2) {
        ui.plain('');
        ui.log.dim('再见。');
        ui.closeInput();
        process.exit(0);
      }
      ui.plain('');
      ui.log.dim('再按一次 Ctrl+C 退出，或输入 /exit');
      ui.raw(`${ui.c.bold(ui.c.green('你'))} ${ui.c.gray('›')} `);
    }
  };
  process.on('SIGINT', onSigint);

  /* ---- 斜杠命令处理 ---- */
  const handleSlash = async ({ name, arg }) => {
    // 插件注册的命令优先（同名时插件胜出，方便用户覆盖）
    const pluginCmd = plugins.commands.get(name);
    if (pluginCmd) {
      try {
        const result = await pluginCmd.handler(arg, { session, cfg, agent, registry });
        if (result !== undefined && result !== null) ui.out(String(result));
      } catch (err) {
        ui.log.error(`插件命令 /${name} 出错：${err.message}`);
      }
      return true;
    }

    switch (name) {
      case 'help': {
        ui.log.title('命令');
        ui.out('  /help            显示帮助');
        ui.out('  /exit /quit      退出');
        ui.out('  /new             开始新会话');
        ui.out('  /save            手动保存会话');
        ui.out('  /history         查看当前会话消息数');
        ui.out('  /tools           列出工具');
        ui.out('  /plugins         列出插件');
        ui.out('  /config          查看配置');
        ui.out('  /model <名字>     切换模型');
        ui.out('  /yes             开/关自动放行所有工具');
        ui.out('  /verbose         开/关详细输出');
        ui.out('  /clear           清屏');
        ui.out('  /sessions        列出历史会话');
        ui.out('  /export          导出当前会话为 Markdown');
        const cmds = [...plugins.commands.values()];
        if (cmds.length) {
          ui.log.title('插件命令');
          for (const c of cmds) ui.out(`  /${c.name.padEnd(14)} ${c.description}${ui.c.gray(`  (来自 ${c.plugin})`)}`);
        }
        ui.plain('');
        ui.log.dim('提示：直接说需求即可，我会自己决定调用哪些工具。');
        break;
      }
      case 'exit':
      case 'quit':
      case 'q':
        return false;

      case 'new': {
        session.save();
        session = agent.createSession({ cwd });
        ui.log.ok(`已开始新会话 ${session.id}`);
        break;
      }
      case 'save': {
        const ok = session.save();
        ui.log.ok(ok ? `已保存到 ${session.filePath}` : '保存失败（检查 session.save 配置）');
        break;
      }
      case 'history':
        ui.out(`  当前会话 ${session.id}：${session.messages.length} 条消息，${session.countTurns()} 轮，token ${session.usage.totalTokens}`);
        break;
      case 'tools':
        printToolTable(registry);
        break;
      case 'plugins':
        printPluginTable(plugins);
        break;
      case 'config':
        for (const [k, v] of Object.entries(describeConfig(cfg))) ui.out(`  ${ui.c.gray(String(k).padEnd(12))} ${v}`);
        break;
      case 'model': {
        if (!arg) {
          ui.out(`  当前模型：${cfg.model}`);
          break;
        }
        cfg.model = arg;
        agent.provider.model = arg;
        ui.log.ok(`已切换模型为 ${arg}（仅本次运行有效）`);
        break;
      }
      case 'yes': {
        cfg.assumeYes = !cfg.assumeYes;
        ui.log.warn(`自动放行所有工具：${cfg.assumeYes ? '已开启（危险）' : '已关闭'}`);
        break;
      }
      case 'verbose':
        verbose = !verbose;
        ui.log.ok(`详细输出：${verbose ? '开' : '关'}`);
        break;
      case 'clear':
        ui.raw('\u001b[2J\u001b[H');
        break;
      case 'sessions': {
        const list = Session.list(cfg, 10);
        for (const s of list) ui.out(`  ${ui.c.bold(s.id)}  ${s.updatedAt.slice(0, 19).replace('T', ' ')}  ${s.title}`);
        break;
      }
      case 'export': {
        const outPath = path.join(cfg.dataDir, 'exports', `${session.id}.md`);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, session.toMarkdown(), 'utf8');
        ui.log.ok(`已导出：${outPath}`);
        break;
      }
      default:
        ui.log.warn(`未知命令 /${name}，输入 /help 查看可用命令`);
        break;
    }
    return true;
  };

  /* ---- 主循环 ---- */
  try {
    while (running) {
      // eslint-disable-next-line no-await-in-loop
      const line = (await ui.prompt()).trim();
      if (!line) continue;

      const slash = parseSlash(line);
      if (slash) {
        // eslint-disable-next-line no-await-in-loop
        running = await handleSlash(slash);
        continue;
      }

      try {
        // eslint-disable-next-line no-await-in-loop
        await agent.run(session, line, { verbose });
      } catch (err) {
        ui.log.error(err.message);
        if (flags.debug && err.stack) ui.block(err.stack, { indent: '    ', color: ui.c.gray });
        ui.log.dim('    提示：运行 `mya doctor` 可以快速定位配置或网络问题。');
      }
      ui.plain('');
    }
  } finally {
    process.off('SIGINT', onSigint);
    session.save();
    await plugins.teardownAll();
    ui.closeInput();
  }

  ui.log.dim(`会话已保存：${session.filePath}`);
  return 0;
}

/* ------------------------------------------------------------------ */
/* 一次性执行                                                          */
/* ------------------------------------------------------------------ */

/** 读取管道输入（有内容则返回，无则返回空字符串，不阻塞） */
async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function cmdRun(opts) {
  const { positionals, flags, cwd } = opts;
  let task = positionals.join(' ').trim();
  // 支持 mya run -p "任务"；若 -p 后面跟的是服务商名，则当成 --provider 处理
  if (!task && typeof flags.prompt === 'string') {
    const known = ['deepseek', 'openai', 'ollama', 'custom'];
    if (known.includes(flags.prompt.toLowerCase()) && !flags.provider) {
      flags.provider = flags.prompt;
    } else {
      task = flags.prompt;
    }
  }
  if (!task) task = (await readStdin()).trim();
  if (!task) {
    ui.log.error('用法：mya run "任务描述"  或  echo "任务" | mya run');
    return 1;
  }

  const app = await createApp({ cli: cliOverrides(flags), cwd, loadPlugins: true, needProvider: true });
  const { cfg, agent, plugins } = app;

  let session;
  if (flags.session) session = Session.load(cfg, String(flags.session));
  else if (flags.continue === true) {
    const recent = Session.list(cfg, 1);
    if (recent.length) session = Session.load(cfg, recent[0].id);
  }
  if (!session) session = agent.createSession({ cwd });

  if (!flags.quiet) {
    ui.log.dim(`  模型 ${cfg.provider}/${cfg.model}  ·  会话 ${session.id}  ·  工作目录 ${cwd}`);
  }

  try {
    const result = await agent.run(session, task, { verbose: !flags.quiet });
    await plugins.teardownAll();
    // 非交互模式下把最终答案再原样打一遍，方便管道下游取用
    if (flags.quiet && result.text) ui.plain(result.text);
    return result.aborted ? 130 : 0;
  } catch (err) {
    ui.log.error(err.message);
    if (flags.debug && err.stack) ui.block(err.stack, { indent: '    ', color: ui.c.gray });
    await plugins.teardownAll();
    return 1;
  }
}

/* ------------------------------------------------------------------ */
/* 桌面程序                                                            */
/* ------------------------------------------------------------------ */

/**
 * 打开桌面程序（原生窗口）。
 * 没装 Electron 时自动退回「起服务 + 开浏览器」，保证命令永远有结果。
 */
async function cmdDesktop(opts) {
  const { flags, cwd } = opts;
  const { desktopAvailable, launchDesktop } = require('./desktop');

  if (!desktopAvailable()) {
    ui.log.warn('没找到桌面组件（Electron），改用浏览器打开界面。');
    ui.log.dim('  想用原生窗口：npm install（会下载 Electron，约 100MB）');
    ui.plain('');
    return cmdWeb({ ...opts, flags: { ...flags, open: flags['no-open'] !== true } });
  }

  const result = launchDesktop({
    cwd,
    port: flags.port ? Number(flags.port) : undefined,
    dev: !!flags.dev,
    selftest: !!flags.selftest,
  });

  if (!result.ok) {
    ui.log.error(`桌面程序启动失败：${result.reason || `退出码 ${result.exitCode}`}`);
    ui.log.dim('  可以改用浏览器界面：mya web');
    return 1;
  }

  if (result.selftest) {
    ui.log.dim('提示：mya desktop --dev 可以打开开发者工具排查问题');
    return 0;
  }

  ui.log.ok('桌面程序已启动');
  ui.log.dim('  如果窗口没有出现，看看任务栏，或者改用 mya web 在浏览器里打开');
  return 0;
}

/* ------------------------------------------------------------------ */
/* 网页界面                                                            */
/* ------------------------------------------------------------------ */

async function cmdWeb(opts) {
  const { flags, cwd } = opts;
  const port = Number(flags.port || flags.p || 3080);
  const host = String(flags.host || '127.0.0.1');
  const open = flags.open !== false && flags['no-open'] !== true;

  // 监听非本地地址时强制要访问令牌，避免把 agent 暴露给整个网络
  let token = '';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    token = String(flags.token || '') || require('crypto').randomBytes(12).toString('hex');
    ui.log.warn(`已监听 ${host}。访问令牌：${token}`);
    ui.log.warn('任何拿到这个令牌的人都能通过它操作你的文件，请勿在不可信网络使用。');
    /**
     * 打印**真正能用**的链接。
     * 以前这里只给了令牌，用户得自己拼 IP；而手机要访问的是局域网地址，
     * 不是一个 127.0.0.1。链接带上 ?token= 打开一次就会种 cookie，
     * 之后在同一浏览器里就不用再粘令牌了。
     */
    const { lanAddresses } = require('./web/lan-gate');
    for (const addr of lanAddresses()) {
      ui.log.dim(`  局域网访问：http://${addr}:${port}/?token=${token}`);
    }
    ui.log.dim(`  本机访问：  http://127.0.0.1:${port}/?token=${token}`);
  }

  ui.plain('');
  // needProvider: false —— 界面先打开，模型没配好也不该拦住用户（界面里会引导他配）
  const webApp = await createApp({ cli: cliOverrides(flags), cwd, loadPlugins: true, needProvider: false, quiet: true });
  const { startWebServer } = require('./web/server');
  const instance = await startWebServer(webApp, { port, host, open, token });

  // 常驻不退出：Ctrl+C 才停
  await new Promise((resolve) => {
    const stop = () => {
      ui.plain('');
      ui.log.dim('正在关闭…');
      instance.close();
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

async function main(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseArgv(argv);
  const cwd = flags.cwd ? path.resolve(String(flags.cwd)) : process.cwd();
  const opts = { positionals, flags, cwd };

  if (flags.version === true) {
    ui.plain(`${pkg.name} v${pkg.version}`);
    return 0;
  }
  if (flags.help === true && !positionals.length) {
    ui.plain(HELP.trim());
    return 0;
  }

  const command = positionals[0] && typeof positionals[0] === 'string' ? positionals[0].toLowerCase() : '';
  const rest = positionals.slice(1);

  // 子命令白名单：只有第一个词是已知命令时才吃它，否则整句当任务
  const COMMANDS = new Set([
    'help', 'doctor', 'tools', 'plugins', 'plugin', 'config',
    'sessions', 'export', 'run', 'chat', 'version', 'web', 'ui', 'desktop', 'app',
    'checkpoint', 'ckpt',
  ]);
  const isCommand = COMMANDS.has(command);
  const positionalTask = isCommand ? rest : positionals;

  switch (isCommand ? command : '') {
    case 'help':
      ui.plain(HELP.trim());
      return 0;
    case 'doctor':
      return cmdDoctor(opts);
    case 'tools':
      return cmdTools(opts);
    case 'plugins':
      return cmdPlugins(opts);
    case 'plugin':
      if (rest[0] === 'new') return cmdPluginNew({ ...opts, positionals: rest.slice(1) });
      if (rest[0] === 'list') return cmdPlugins(opts);
      ui.plain('用法：mya plugin new <名字> | mya plugin list');
      return 1;
    case 'config':
      return cmdConfig(opts);
    case 'checkpoint':
    case 'ckpt':
      return cmdCheckpoint({ ...opts, positionals: rest });
    case 'sessions':
      return cmdSessions(opts);
    case 'export':
      return cmdExport({ ...opts, positionals: rest });
    case 'run':
      return cmdRun({ ...opts, positionals: rest });
    case 'chat':
      return cmdChat({ ...opts, positionals: rest });
    case 'web':
    case 'ui':
      return cmdWeb(opts);
    case 'desktop':
    case 'app':
      return cmdDesktop(opts);
    case 'version':
      ui.plain(`${pkg.name} v${pkg.version}`);
      return 0;
    default:
      break;
  }

  // 不是子命令：有内容就当任务直接执行；什么都没给时，
  // 如果装了桌面组件就开原生窗口，否则退回浏览器界面
  if (positionalTask.length) return cmdRun({ ...opts, positionals: positionalTask });
  if (require('./desktop').desktopAvailable()) return cmdDesktop(opts);
  return cmdWeb(opts);
}

module.exports = { main, parseArgv, HELP, printToolTable, printPluginTable };
