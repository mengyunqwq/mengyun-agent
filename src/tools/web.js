'use strict';

/**
 * 梦云 Agent —— 联网工具（web_search / web_fetch）
 *
 * 为什么单独一个文件，而不是塞进 builtin.js：
 *   联网面对的是「本机之外、不受我们控制」的世界，它踩的坑和本地文件操作完全不是一类：
 *   证书被公司代理/杀软换成中间人证书、DNS 解析不了、被搜索站风控限流、抓回来的正文全是标签。
 *   这些情况如果只回一句 "fetch failed"，人和模型都会往错的方向修（比如去折腾代理，
 *   而真因其实是证书）。所以网络相关的判断、翻译、清洗集中放在这里。
 *
 * 三条硬约束（和项目其它部分一致）：
 *   1. 零依赖：只用 Node 18+ 自带的全局 fetch / AbortController / URL。
 *      连 HTML 解析都不引库——搜索页的解析用正则自己写，够用、可控、可测。
 *   2. 不抛异常：任何失败都翻译成中文文本，用 { ok:false, content } 回给模型，
 *      内容里写清「为什么失败」和「可以怎么做」。
 *   3. 可离线测试：真正发请求的那一层做成可注入的（ctx.fetch 或 __setFetchForTest），
 *      测试喂固定 HTML 就能覆盖解析与错误分支，不依赖外网。
 */

const { truncate, humanSize } = require('../utils');

/* ================================================================== */
/* 0. 可注入的请求层                                                    */
/* ================================================================== */

/**
 * 真正的 fetch 存在模块级变量里，而不是在代码里直接写全局 fetch。
 *
 * 为什么：用户的机器上外网可能根本不通、或者被 TLS 中间人拦掉，
 * 那种环境下「测试失败」说明不了代码有问题。把请求层抽出来，
 * 测试就能喂固定 HTML，只验证真正属于我们的逻辑（解析、校验、错误翻译）。
 *
 * Node 18 里 fetch 是全局的，这里只是把它取一份存着，默认行为完全一样。
 */
let httpFetch = typeof fetch === 'function' ? fetch : null;

/** 测试钩子：换掉请求层。传假函数则用假的，传空则恢复全局 fetch。 */
function __setFetchForTest(fn) {
  httpFetch = typeof fn === 'function' ? fn : typeof fetch === 'function' ? fetch : null;
}

/** 恢复真实 fetch（测试收尾用，避免污染后续用例） */
function __resetFetchForTest() {
  httpFetch = typeof fetch === 'function' ? fetch : null;
}

/**
 * 选这次调用用哪个 fetch。
 * 优先级：ctx.fetch（宿主或测试注入）> 模块级（可能被测试替换过）> 全局 fetch。
 *
 * 让 ctx.fetch 排最前，是为了让「同一个进程里不同会话用不同网络栈」成为可能，
 * 也让测试可以逐用例注入、互不污染（不用管模块级被谁改过）。
 */
function resolveFetch(ctx) {
  if (ctx && typeof ctx.fetch === 'function') return ctx.fetch;
  if (typeof httpFetch === 'function') return httpFetch;
  if (typeof fetch === 'function') return fetch;
  return null;
}

/* ================================================================== */
/* 1. 通用小工具：实体解码、清洗、截断                                  */
/* ================================================================== */

/**
 * 常见的命名实体表。
 * 只列真正会出现在正文里、且不查表就读不懂的那些；查不到的实体保持原样，
 * 这样宁可留个 &foo; 也不要把用户的正文改坏。
 */
const NAMED_ENTITIES = {
  nbsp: ' ',
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  middot: '·',
  bull: '•',
  copy: '©',
  reg: '®',
  trade: '™',
  times: '×',
  divide: '÷',
  plusmn: '±',
  deg: '°',
  laquo: '«',
  raquo: '»',
  sect: '§',
  para: '¶',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  frac12: '½',
  ne: '≠',
  le: '≤',
  ge: '≥',
  micro: 'µ',
  shy: '', // 软连字符：不可见，直接删掉
};

/**
 * 解码 HTML 实体，支持命名实体、十进制（&#39;）和十六进制（&#x27; / &#x1F600;）。
 *
 * 为什么用「一次 replace」而不是先替换 &amp; 再替换别的：
 * 一次扫描才能保证 &amp;lt; 解成 &lt;（字面量）而不是被二次解码成 <。
 * 二次解码正是 XSS 和「正文被改乱」的经典来源。
 */
function decodeHtmlEntities(input) {
  return String(input ?? '').replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const num = parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      // 只接受合法码点；代理区（D800-DFFF）单独 fromCodePoint 也不会炸，但没必要冒险
      if (!Number.isFinite(num) || num < 0 || num > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(num);
      } catch {
        return whole;
      }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : whole;
  });
}

/** 去掉所有标签（用于标题、摘要这种「只想要一行字」的场景） */
function stripTags(html) {
  return String(html ?? '').replace(/<[^>]*>/g, ' ');
}

/** 压成一行：去标签 → 解实体 → 连续空白折成一个空格 → 去首尾空白 */
function cleanInline(html) {
  return decodeHtmlEntities(stripTags(html))
    .replace(/[\s\u00a0\u3000]+/g, ' ')
    .trim();
}

/**
 * 去掉「不是正文」的整块内容：注释、脚本、样式、模板、内联 SVG、iframe。
 *
 * 为什么要单独抽出来给搜索解析也用：DuckDuckGo 的结果页里带着内联脚本，
 * 脚本字符串里常常就有 result__a 这样的片段。不先挖掉脚本，
 * 解析器会把脚本里的字符串当成一条「搜索结果」——这是最容易被忽略的假结果来源。
 */
function stripNonContentBlocks(html) {
  return String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|object|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/?(script|style|noscript|template|svg|iframe)\b[^>]*>/gi, ' ');
}

/** 按长度截断，并把「截了多少」一并返回（给模型看的提示要用） */
function clipText(text, maxChars) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return { text: s, truncated: false, omitted: 0, total: s.length };
  return { text: s.slice(0, maxChars), truncated: true, omitted: s.length - maxChars, total: s.length };
}

/* ================================================================== */
/* 2. HTML → 纯文本                                                     */
/* ================================================================== */

/**
 * 把网页 HTML 转成能给模型读的纯文本。
 *
 * 为什么必须转：一个普通新闻页的 HTML 有 200KB~2MB，其中 90% 是标签、样式和脚本。
 * 原样丢给模型，上下文立刻被撑爆，而且模型要从标签缝里找句子，又慢又贵。
 *
 * 转换顺序是刻意安排的，不能随便换：
 *   先挖整块（script/style/head…）→ 再把「有语义的结束标签」换成换行 →
 *   再给 li 加项目符号 → 最后才删掉剩下的所有标签。
 *   如果把「删标签」提到前面，<br>、</p> 这些就没了，所有文字会粘成一坨。
 */
function htmlToText(html) {
  let s = stripNonContentBlocks(html);

  // head 里是 meta/title/link，对正文没用（title 会单独从 <title> 里取，这里先整块丢掉）
  s = s.replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, ' ');

  // 换行类：<br> 就是换行，<hr> 是分隔（用空行表达）
  s = s.replace(/<br\b[^>]*\/?>/gi, '\n');
  s = s.replace(/<hr\b[^>]*\/?>/gi, '\n');

  // 块级结束标签 → 换行。这是「段落感」的来源，缺了就会读成一整段。
  s = s.replace(
    /<\/(p|div|h[1-6]|li|tr|ul|ol|table|thead|tbody|section|article|header|footer|blockquote|pre|form|nav|aside|main|figure|figcaption|dl|dt|dd|address|details|summary)\s*>/gi,
    '\n',
  );

  // 表格单元格之间也要有分隔，否则一行里的几列会粘成一个怪词
  s = s.replace(/<\/(td|th)\s*>/gi, ' ');

  // 列表项前面加 "- "（换行在上一步或这一步统一给出）
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');

  // 到这一步才把剩下的标签全部删掉，用空格替，避免 <b>foo</b><i>bar</i> 粘成 foobar
  s = s.replace(/<[^>]*>/g, ' ');

  s = decodeHtmlEntities(s);

  // 行首行尾空白清掉，行内连续空白折成一个空格
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v\u00a0\u3000]+/g, ' ').trim())
    .join('\n');

  // 三段以上连续换行折成两段（一个空行），
  // 因为很多页面用 <br><br><br> 凑间距，留着只会白烧 token
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

/* ================================================================== */
/* 3. 敏感信息打码                                                      */
/* ================================================================== */

/** 查询串里这些名字的参数，值一律打码（自建搜索接口常把 key 写在 URL 上） */
const SENSITIVE_PARAM = /^(api[_-]?key|apikey|key|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|passwd|pwd|auth|authorization|signature|sig)$/i;

/**
 * 文本里这些「键: 值」形状的键，值一律打码。
 *
 * 顺序很重要（这里真的踩过一次）：必须**先**处理 "Bearer xxx"，再处理
 * "键: 值"。如果反过来，`Authorization: Bearer sk-xxx` 会被那条「键: 值」规则
 * 匹配成「键=Authorization、值=Bearer」，于是只把 Bearer 这个词打码，
 * 真正的 token 原样留在后面——看起来打了码，最关键的那段其实漏出去了。
 * 所以「键: 值」规则里还加了 (?!Bearer) 兜底，避免把 Bearer 当成值。
 */
const SECRET_TEXT_RULES = [
  [/(Bearer\s+)([A-Za-z0-9._\-+/=]{8,})/gi, '$1***已隐藏***'],
  [
    /((?:api[_-]?key|apikey|token|secret|password|passwd|authorization)\s*[:=]\s*)(?!Bearer\b)([^\s,;"'&]{6,})/gi,
    '$1***已隐藏***',
  ],
];

/**
 * 把 text 里疑似密钥的部分打码。
 *
 * 为什么必须做：工具的返回值会被原样写进对话历史（还可能被存进会话文件）。
 * 自建搜索接口经常是 https://host/search?q=xx&key=SECRET 这种形式，
 * 出错信息里一旦回显了完整 URL，密钥就永久留在了对话记录里。
 */
function redactSecrets(text) {
  let s = String(text ?? '');
  for (const [re, replacement] of SECRET_TEXT_RULES) s = s.replace(re, replacement);
  return s;
}

/** URL 里的敏感查询参数打码（只改被点名的参数，其余保持原样，方便排查） */
function redactUrl(url) {
  const raw = String(url ?? '');
  try {
    const u = new URL(raw);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_PARAM.test(key)) {
        u.searchParams.set(key, '***');
        changed = true;
      }
    }
    return changed ? u.href : raw;
  } catch {
    // 不是合法 URL（比如只有域名）就退回文本打码，至少别把 key=xxx 露出去
    return redactSecrets(raw);
  }
}

/* ================================================================== */
/* 4. 网络错误翻译（两个工具共用）                                      */
/* ================================================================== */

/**
 * 证书类故障的翻译表。
 *
 * 为什么专门列出来：这是本机真实踩到的坑——浏览器能打开网页，程序却报
 * fetch failed，真因是中间人证书（公司代理 / 杀毒软件 / 加速器）。
 * 这时候含糊地提示「可能需要配置代理」会把人带到完全错误的方向：
 * 代理根本不是问题，问题是 Node 不认那个根证书。
 */
const TLS_CAUSE_HINTS = {
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '本机有中间人证书（公司代理 / 杀毒软件 / 网络加速器），Node 不认这个根证书',
  SELF_SIGNED_CERT_IN_CHAIN: '证书链里夹着自签名证书（典型的中间人替换）',
  DEPTH_ZERO_SELF_SIGNED_CERT: '对方用的是自签名证书',
  CERT_HAS_EXPIRED: '对方证书已过期（也可能是中间人证书过期了）',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书上的域名和你要访问的域名对不上',
};

/**
 * 把 fetch 的报错翻译成「看完能照着做」的中文。
 *
 * 为什么要有这个统一函数：Node 的 fetch 失败时往往只给一句 `fetch failed`，
 * 真正的原因藏在 err.cause.code 里（TLS 用它、DNS 用它、超时也用它）。
 * 两个工具（搜索和抓取）都走这里，保证同样的错误在哪儿看到都是同一套说法。
 */
function describeFetchError(err, target) {
  const where = redactUrl(target || '目标地址');
  const cause = (err && err.cause) || {};
  const code = String(cause.code || (err && err.code) || '');
  const name = String((err && err.name) || cause.name || '');
  const head = `访问 ${where} 失败：`;

  if (TLS_CAUSE_HINTS[code]) {
    return [
      `${head}${TLS_CAUSE_HINTS[code]}（${code}）。`,
      '  为什么浏览器能打开、程序却不行：浏览器走系统的证书库，Node 走自己那份——',
      '  公司网关或杀软插进来的根证书，Node 不认识。两个办法：',
      '  ① 推荐：把那个根证书导出成 .crt/.pem，设环境变量 NODE_EXTRA_CA_CERTS=证书文件路径，然后重启程序；',
      '  ② 应急：设 MYA_INSECURE_TLS=1 跳过证书校验。注意这不安全——它只是「不检查证书」，',
      '     流量该被中间人看到还是能看到，用完请立刻取消这个环境变量。',
    ].join('\n');
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) {
    return `${head}域名解析不了（${code}）。检查 DNS 设置，或者这台机器根本连不上外网。`;
  }
  if (/ECONNREFUSED/.test(code)) {
    return `${head}连接被拒绝（${code}）。目标端口没人监听；如果开了代理或加速器，确认它的端口与 MYA_PROXY 里写的一致。`;
  }
  if (
    /ETIMEDOUT|CONNECT_TIMEOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ESOCKETTIMEDOUT/.test(code) ||
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    name === 'ConnectTimeoutError'
  ) {
    return `${head}连接超时（${code || name}）。网络不通或被墙：设 MYA_PROXY=http://127.0.0.1:端口 走代理再试。`;
  }
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(code)) {
    return `${head}连接被对方中断（${code}）。代理/加速器不稳定，或对方主动掐断都有这个表现，重试一次往往就好。`;
  }
  if (/CERT|TLS|SSL/i.test(code)) {
    return `${head}证书/加密握手失败（${code}）。处理办法参考上文：NODE_EXTRA_CA_CERTS 指定公司根证书，或临时 MYA_INSECURE_TLS=1。`;
  }

  // 认不出来的错误也要把原始信息带出来（打码后），不能吞掉——否则无从排查
  const detail = [err && err.message, cause.message, code].filter(Boolean).join(' | ');
  return `${head}${redactSecrets(detail || '未知网络错误')}`;
}

/**
 * 两个应急开关，都走环境变量（不改配置文件，也不会被误开）：
 *   MYA_PROXY=http://…   走代理。Node 24 的 fetch 支持 NODE_USE_ENV_PROXY，这里替用户打开。
 *   MYA_INSECURE_TLS=1   不校验证书。专治上面那种中间人证书导致的连不上。
 *
 * 为什么放在「真要发请求之前」而不是模块加载时：
 *   只是 require 一下这个文件不该改变整个进程的网络行为（测试、doctor 都会 require 它）。
 *   真正要用网络时再打开，语义更清楚。
 * 为什么必须喊一嗓子：安全开关不能悄悄开。哪天忘了自己开过，
 * 就等于把所有中间人攻击一起吃了下去。
 */
let insecureTlsWarned = false;
function applyNetworkEnvOverrides() {
  if (process.env.MYA_PROXY && !process.env.HTTPS_PROXY) {
    process.env.HTTPS_PROXY = process.env.MYA_PROXY;
    process.env.HTTP_PROXY = process.env.MYA_PROXY;
  }
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    // Node 24+ 认这个开关；老版本上它没有副作用
    process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || '1';
  }
  if (process.env.MYA_INSECURE_TLS === '1' && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    if (!insecureTlsWarned) {
      insecureTlsWarned = true;
      // eslint-disable-next-line no-console
      console.error(
        '[警告] MYA_INSECURE_TLS=1：已关闭 HTTPS 证书校验。\n' +
          '        这是为了绕过本机的中间人证书。用完请关掉——开着的话，任何伪造的证书都会被接受。',
      );
    }
  }
}

/* ================================================================== */
/* 5. HTTP 请求封装（GET + 超时 + 统一错误翻译）                        */
/* ================================================================== */

/** 不带 UA 会被 DuckDuckGo 直接拒（403），所以伪装成一个普通浏览器 */
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/** 搜索 JSON 接口用的头：明确要 JSON，但 UA 仍用浏览器形态（有些网关按 UA 拦） */
const JSON_HEADERS = { ...BROWSER_HEADERS, Accept: 'application/json, text/plain;q=0.9, */*;q=0.8' };

/** 兼容真 Headers（有 get）和测试里的普通对象 */
function headerOf(res, name) {
  const h = res && res.headers;
  if (!h) return '';
  const lower = String(name).toLowerCase();
  try {
    if (typeof h.get === 'function') return String(h.get(name) ?? '');
    for (const key of Object.keys(h)) if (key.toLowerCase() === lower) return String(h[key] ?? '');
  } catch {
    /* 忽略：拿不到头就当没有，不影响主流程 */
  }
  return '';
}

/**
 * 发起一次 GET，带超时。
 *
 * 为什么用 AbortController 而不是给 fetch 传 timeout 选项：
 * fetch 没有 timeout 选项，超时必须靠 signal 打断——而且打断之后
 * 必须自己把 timer 清掉，否则这个定时器会一直吊着事件循环，
 * 表现为「工具跑完了，进程却迟迟不退出」。
 *
 * @returns {Promise<{ok:true,res:object,body:string}|{ok:false,content:string}>}
 *   失败时 content 已经是「能被模型直接读的中文」，调用方直接 return 即可。
 */
async function httpGet(url, { timeoutSec, headers, ctx }) {
  const doFetch = resolveFetch(ctx);
  if (!doFetch) {
    return {
      ok: false,
      content:
        '当前运行环境没有可用的 fetch。联网工具需要 Node 18 及以上（fetch 是 Node 18 才有的全局函数），请升级 Node 后重试。',
    };
  }

  applyNetworkEnvOverrides();

  const ms = Math.max(200, Math.round(timeoutSec * 1000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    const res = await doFetch(url, { method: 'GET', headers, signal: controller.signal, redirect: 'follow' });
    let body = '';
    try {
      body = await res.text();
    } catch (err) {
      // 头已经回来了，读正文时才断——单独说清，免得看起来像「网站打不开」
      return { ok: false, content: `响应头已收到，但读取正文时连接中断：${describeFetchError(err, url)}` };
    }
    return { ok: true, res, body };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return {
        ok: false,
        content: [
          `请求超时（${timeoutSec} 秒）：${redactUrl(url)}`,
          '  慢、被墙、或对方一直不响应都会这样。可以：',
          '  ① 设环境变量 MYA_PROXY=http://127.0.0.1:端口 走代理；',
          '  ② 或者把配置项 ctx.cfg.web.timeoutSec 调大一点。',
        ].join('\n'),
      };
    }
    return { ok: false, content: describeFetchError(err, url) };
  } finally {
    clearTimeout(timer);
  }
}

/** 非 2xx 状态码的说明（带上对方返回的片段，方便判断是不是风控页） */
function describeHttpStatus(status, url, who, body) {
  const code = Number(status) || 0;
  const excerpt = body ? redactSecrets(cleanInline(body).slice(0, 240)) : '';
  const tail = excerpt ? `\n  对方返回的内容片段：${excerpt}` : '';
  const where = redactUrl(url);

  if (code === 403) {
    return `${who} 拒绝了这次请求（HTTP 403）：${where}\n  多半是风控或人机验证。可以换关键词重试，或在配置里把 ctx.cfg.web.provider 设成 'custom' 接自建搜索服务。${tail}`;
  }
  if (code === 429) {
    return `${who} 说你请求太频繁（HTTP 429，被限流）：${where}\n  等一会儿再试，或改用自定义搜索接口。${tail}`;
  }
  if (code >= 500) {
    return `${who} 服务端出错（HTTP ${code}）：${where}\n  这是对方的问题，过一会儿再试。${tail}`;
  }
  if (code === 404) {
    return `页面不存在（HTTP 404）：${where}\n  检查链接有没有写错；有些站点会删旧文章。${tail}`;
  }
  return `请求失败（HTTP ${code}）：${where}${tail}`;
}

/* ================================================================== */
/* 6. DuckDuckGo HTML 版解析                                            */
/* ================================================================== */

/** 全局匹配所有 <a …>…</a>，属性串和内部 HTML 分别拿到手再判断 */
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;

/**
 * 取一个标签属性，容忍：
 *   - 属性顺序任意（href 在 class 前面也行）
 *   - 双引号 / 单引号 / 完全不加引号
 *   - 等号两边有多余空白
 *   - 属性名大小写不同
 * 这些变化在真实页面里都会出现（不同模板、CDN 改写、压缩器），
 * 写死成 class="result__a" href=" 的顺序，一改版就全废。
 */
function getAttr(attrs, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(String(attrs || ''));
  if (!m) return '';
  return decodeHtmlEntities(m[1] ?? m[2] ?? m[3] ?? '');
}

/**
 * 把 DuckDuckGo 的跳转链接还原成真实地址。
 *
 * 这是最容易漏、后果又最直接的一步：DDG 的结果 href 长这样——
 *   //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=…
 * 不回填 uddg 的话，模型（或用户）拿到的是 DDG 的中转页，
 * 抓取时只会抓到 DDG 自己的空壳页面，看起来「抓到了但没内容」。
 */
function unwrapDuckDuckGoUrl(href) {
  const raw = String(href || '').trim();
  if (!raw) return '';
  // 协议相对（//host/path）在 URL 里要补上协议才能解析
  const withProto = raw.startsWith('//') ? `https:${raw}` : raw;
  try {
    const u = new URL(withProto, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return uddg.trim(); // searchParams 已经做过一次百分号解码
    return u.href;
  } catch {
    return raw;
  }
}

/**
 * 判断这条链接是不是「给了也没用」的链接。
 *
 * 只过滤 DDG 自己的广告跳转（/y.js）和没还原成功的重定向（/l/）：
 * 它们对用户没有任何价值，点开还是 DDG 的页面。
 * 刻意不用「域名是 duckduckgo.com 就丢掉」——那样搜 "duckduckgo" 时
 * 官网结果会被自己误杀。
 */
function isUselessLink(url) {
  if (!/^https?:\/\//i.test(url)) return true;
  try {
    const u = new URL(url);
    if (!/(^|\.)duckduckgo\.com$/i.test(u.hostname)) return false;
    return /\/y\.js$/i.test(u.pathname) || /^\/l\/?$/i.test(u.pathname) || /ad_provider/i.test(u.search);
  } catch {
    return true;
  }
}

/**
 * 解析 DuckDuckGo HTML 版的结果页。
 *
 * 目标结构（属性顺序和空白在不同版本里会变）：
 *   <a class="result__a" href="//duckduckgo.com/l/?uddg=…">标题</a>
 *   <a class="result__snippet" href="…">摘要</a>
 *
 * 做法：先按文档顺序把两类锚点抓成一条流，再让每个摘要归属到
 * 「最近一个还没有摘要的标题」上。这样即使中间夹了别的锚点（翻页、广告）
 * 也不会串行。
 *
 * @returns {Array<{title:string,url:string,snippet:string}>}
 */
function parseDuckDuckGoHtml(html) {
  const text = stripNonContentBlocks(html); // 先挖脚本：脚本字符串里可能有假的 result__a
  const stream = [];

  ANCHOR_RE.lastIndex = 0;
  let m;
  while ((m = ANCHOR_RE.exec(text))) {
    const attrs = m[1] || '';
    const cls = getAttr(attrs, 'class');
    if (/(?:^|\s)result__a(?:\s|$)/i.test(cls)) {
      stream.push({ kind: 'title', href: getAttr(attrs, 'href'), inner: m[2] });
    } else if (/(?:^|\s)result__snippet(?:\s|$)/i.test(cls)) {
      stream.push({ kind: 'snippet', inner: m[2] });
    }
  }

  const out = [];
  for (const item of stream) {
    if (item.kind === 'title') {
      const url = unwrapDuckDuckGoUrl(item.href);
      if (!url || isUselessLink(url)) continue;
      const title = cleanInline(item.inner);
      out.push({ title, url, snippet: '' });
    } else if (out.length) {
      // 摘要挂到最近一个还没摘要的结果上（从后往前找）
      for (let i = out.length - 1; i >= 0; i -= 1) {
        if (!out[i].snippet) {
          out[i].snippet = cleanInline(item.inner);
          break;
        }
      }
    }
  }

  // 同一个真实地址可能被列两次（DDG 偶尔这样），去重，保留先出现的
  const seen = new Set();
  return out.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

/**
 * Bing 会把一部分结果包成 https://www.bing.com/ck/a?...&u=a1<base64url>&...
 * 这里的 u 参数就是「a1 + base64url(真实地址)」。
 *
 * 不还原的话：用户点开看到的是 Bing 的中转页，web_fetch 也会抓到一堆脚本。
 * 解不出来时宁可丢掉这条，也不要把中转页当成结果给模型。
 */
function decodeBingRedirect(value) {
  const s = String(value || '');
  if (!s.startsWith('a1')) return '';
  try {
    const decoded = Buffer.from(s.slice(2), 'base64url').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : '';
  } catch {
    return '';
  }
}

/** 把 Bing 给的 href 变成能直接打开的地址 */
function normalizeBingUrl(href) {
  const raw = String(href || '').trim();
  if (!raw) return '';
  if (/^https?:\/\/(?:www\d?\.)?bing\.com\/ck\/a\b/i.test(raw)) {
    const m = /[?&]u=([^&]+)/i.exec(raw);
    return m ? decodeBingRedirect(m[1]) : '';
  }
  // 协议相对地址（//example.com/x）在页面里很常见
  if (raw.startsWith('//')) return `https:${raw}`;
  return raw;
}

/**
 * 解析 Bing 的结果页。
 *
 * 为什么把 Bing 做成默认后端：实测这台机器上 html.duckduckgo.com 是
 * 12 秒超时 + ECONNRESET（被墙），而 www.bing.com / cn.bing.com
 * 都在 100~300ms 内返回。一个「默认后端连不上」的搜索工具等于没有。
 *
 * Bing 的结构比 DDG 规整，每个结果就是一个 <li class="b_algo">：
 *
 *   <li class="b_algo" ...>
 *     <h2><a href="真实地址">标题</a></h2>
 *     <div class="b_caption"><p>摘要</p></div>
 *   </li>
 *
 * 所以按 li 切块、块内各取各的，比 DDG 那种「按出现顺序把摘要配给
 * 上一个标题」要稳得多——中间夹了广告或翻页也不会串行。
 */
function parseBingHtml(html) {
  const text = stripNonContentBlocks(html);
  // class 里常常还有别的类名（b_algo b_algoBorder 之类），所以用词边界匹配
  const blocks = text.split(/<li\b[^>]*\bclass="[^"]*\bb_algo\b[^"]*"[^>]*>/i).slice(1);

  const out = [];
  for (const block of blocks) {
    const head = /<h2\b[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a\s*>/i.exec(block);
    if (!head) continue;

    const url = normalizeBingUrl(getAttr(head[1], 'href'));
    if (!url || isUselessLink(url)) continue;

    const title = cleanInline(head[2]);
    if (!title) continue;

    // 摘要在 b_caption 里；结构变了就退而求其次，取块里第一个 <p>
    const caption = /<div\b[^>]*\bclass="[^"]*\bb_caption\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block);
    const fallback = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = cleanInline(caption ? caption[1] : (fallback || [])[1] || '');

    out.push({ title, url, snippet });
  }

  const seen = new Set();
  return out.filter((r) => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

/* ================================================================== */
/* 7. 参数归一化                                                        */
/* ================================================================== */

/** 结果条数：默认 5，上限 10（再多会把上下文塞满，而且 DDG 一页也没那么多） */
function normalizeMaxResults(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return Math.min(10, Math.max(1, Math.trunc(n)));
}

/** 超时秒数：默认 15 秒，可由 ctx.cfg.web.timeoutSec 覆盖 */
function normalizeTimeoutSec(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

/** 正文上限：默认 20000 字符；下限 100 防止把内容截成没用的碎片 */
function normalizeMaxChars(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 20000;
  return Math.min(500000, Math.max(100, Math.trunc(n)));
}

/** 把候选拼成给模型看的结果列表（两个后端共用同一套排版） */
function formatResults(results, { query, source, cap }) {
  const blocks = results.map((r, i) => {
    const lines = [`${i + 1}. ${r.title || '(无标题)'}`, `   ${r.url}`];
    if (r.snippet) lines.push(`   ${r.snippet}`);
    return lines.join('\n');
  });
  const capText = results.length >= cap ? `，已达到上限 ${cap} 条` : '';
  return [
    `搜索「${query}」的结果（来源：${source}，共 ${results.length} 条${capText}）：`,
    '',
    blocks.join('\n\n'),
  ].join('\n');
}

/* ================================================================== */
/* 8. web_search                                                        */
/* ================================================================== */

const webSearchTool = {
  name: 'web_search',
  // autoApprove：只读的网络查询，不落盘、不执行代码，没必要每次都让用户按 y。
  // 如果你的环境对「能发出网络请求」这件事另有要求，把它去掉即可（注册表会转成需确认）。
  autoApprove: true,
  description: [
    '联网搜索，返回「标题 / 链接 / 摘要」的列表。',
    '当你要查最新的、或者自己没有把握的事实（版本号、API 变更、报错含义、新闻、文档位置）时用它；',
    '它只给摘要，要读全文请拿这里返回的链接再用 web_fetch 抓。结果可能过期或不准确，重要结论要交叉验证。',
    '默认用 Bing（免密钥、国内可达）；也可以在配置里把 web.provider 换成 duckduckgo 或 custom（接自建 SearXNG 之类的接口）。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词，中文英文都行，越具体结果越准' },
      max_results: { type: 'integer', description: '最多返回几条结果，默认 5，上限 10', default: 5 },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    // 同时接受 query 和 q：模型偶尔会漏掉参数名，能救就救，不要直接失败
    const query = String(args.query ?? args.q ?? '').trim();
    if (!query) return { ok: false, content: '搜索关键词不能为空：请把要查的内容填进 query。' };

    const web = (ctx && ctx.cfg && ctx.cfg.web) || {};
    const maxResults = normalizeMaxResults(args.max_results);
    const timeoutSec = normalizeTimeoutSec(web.timeoutSec);
    const provider = String(web.provider || 'duckduckgo').trim().toLowerCase();

    if (provider === 'custom') {
      return searchCustom({ query, maxResults, timeoutSec, web, ctx });
    }
    if (provider === 'duckduckgo') {
      return searchDuckDuckGo({ query, maxResults, timeoutSec, ctx });
    }
    // 默认走 Bing：它是免密钥后端里实测能通的那个
    return searchBing({ query, maxResults, timeoutSec, ctx });
  },
};

/** 「没搜到」时给模型的话：先建议换关键词，换后端才是下一步 */
function noResultHint(query) {
  return `没搜到「${query}」的任何结果。换个关键词、换更常见的说法，或者换成英文再试一次。`;
}

/**
 * DuckDuckGo 的 HTML 版（免密钥）。
 * 国内不少网络连不上它（实测 12s 超时 + ECONNRESET），所以只作为备选后端。
 */
async function searchDuckDuckGo({ query, maxResults, timeoutSec, ctx }) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const got = await httpGet(url, { timeoutSec, headers: BROWSER_HEADERS, ctx });
  if (!got.ok) return got;

  if (!got.res.ok) {
    return { ok: false, content: describeHttpStatus(got.res.status, url, 'DuckDuckGo', got.body) };
  }

  const results = parseDuckDuckGoHtml(got.body).slice(0, maxResults);
  if (!results.length) {
    // 区分「真没结果」和「被风控拦了」——后者换关键词是没用的，得换后端
    if (/anomaly|unusual traffic|bots use duckduckgo/i.test(got.body)) {
      return {
        ok: false,
        content:
          'DuckDuckGo 返回的是风控/异常页面，没有可用结果（不是网络问题）。\n' +
          '  可以稍后重试，或者把配置里的 web.provider 换成 bing（默认）或 custom。',
      };
    }
    return { ok: false, content: noResultHint(query) };
  }

  return { ok: true, content: formatResults(results, { query, source: 'DuckDuckGo', cap: maxResults }) };
}

/**
 * Bing（免密钥，默认后端）。
 *
 * 为什么默认是它：实测这台机器上 html.duckduckgo.com 是 12 秒超时 + ECONNRESET
 * （网络层被挡），而 www.bing.com / cn.bing.com 都是 100~300ms 就返回。
 * 一个「默认后端连不上」的搜索工具等于没有，所以默认值必须选能通的那个。
 */
async function searchBing({ query, maxResults, timeoutSec, ctx }) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const got = await httpGet(url, { timeoutSec, headers: BROWSER_HEADERS, ctx });
  if (!got.ok) return got;

  if (!got.res.ok) {
    return { ok: false, content: describeHttpStatus(got.res.status, url, 'Bing', got.body) };
  }

  const results = parseBingHtml(got.body).slice(0, maxResults);
  if (!results.length) return { ok: false, content: noResultHint(query) };

  return { ok: true, content: formatResults(results, { query, source: 'Bing', cap: maxResults }) };
}

/**
 * 自定义搜索后端：把 {query} 填进用户给的模板地址，期望拿回 JSON。
 * 兼容 { results: [...] } 和裸数组 [...] 两种形状——
 * SearXNG 默认是前者，很多人自己包一层后是后者，两种都接住省得用户改代码。
 */
async function searchCustom({ query, maxResults, timeoutSec, web, ctx }) {
  const endpoint = String(web.endpoint || '').trim();
  if (!endpoint) {
    return {
      ok: false,
      content:
        '配置了 web.provider = "custom"，但没有配 web.endpoint。\n' +
        '  请在配置里写一个含 {query} 占位符的地址，例如 https://searx.example.com/search?q={query}&format=json',
    };
  }
  if (!/^https?:\/\//i.test(endpoint)) {
    return { ok: false, content: `web.endpoint 必须是 http/https 地址，当前是：${redactUrl(endpoint)}` };
  }

  const url = buildCustomUrl(endpoint, query);
  const got = await httpGet(url, { timeoutSec, headers: JSON_HEADERS, ctx });
  if (!got.ok) return got;

  if (!got.res.ok) {
    return { ok: false, content: describeHttpStatus(got.res.status, url, '自定义搜索接口', got.body) };
  }

  let data;
  try {
    data = JSON.parse(got.body);
  } catch {
    return {
      ok: false,
      content:
        '自定义搜索接口返回的不是合法 JSON，无法解析。\n' +
        '  请确认接口返回的是 { "results": [...] } 或 [ ... ]（SearXNG 需要加 format=json）。\n' +
        `  返回内容开头：${redactSecrets(truncate(cleanInline(got.body), 300))}`,
    };
  }

  const rawList = Array.isArray(data) ? data : Array.isArray(data && data.results) ? data.results : null;
  if (!rawList) {
    return {
      ok: false,
      content:
        '自定义搜索接口的 JSON 里没有 results 数组。\n' +
        '  期望的形状：{ "results": [{ "title": "...", "url": "...", "snippet": "..." }] }，或者直接是数组。',
    };
  }

  const results = rawList
    .map(normalizeCustomResult)
    .filter((r) => r.url)
    .slice(0, maxResults);

  if (!results.length) {
    return { ok: false, content: `没搜到「${query}」的任何结果。换个关键词、换更常见的说法，或者换成英文再试一次。` };
  }
  return { ok: true, content: formatResults(results, { query, source: '自定义接口', cap: maxResults }) };
}

/** 拼接自定义后端的地址：有 {query} 就替换，没有就自动补 ?q= */
function buildCustomUrl(endpoint, query) {
  if (endpoint.includes('{query}')) return endpoint.replace(/\{query\}/g, encodeURIComponent(query));
  const sep = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${sep}q=${encodeURIComponent(query)}`;
}

/** 不同搜索后端的字段名不一致，这里做一层宽松兼容 */
function normalizeCustomResult(item) {
  const o = item && typeof item === 'object' ? item : {};
  return {
    title: cleanInline(String(o.title || o.name || o.heading || '')),
    url: String(o.url || o.link || o.href || '').trim(),
    snippet: cleanInline(String(o.snippet || o.content || o.description || o.summary || '')),
  };
}

/* ================================================================== */
/* 9. web_fetch                                                         */
/* ================================================================== */

/**
 * 判断响应该按 HTML 处理，还是原样返回。
 *
 * 为什么要这么判：JSON 接口和纯文本（比如 robots.txt、.md、日志）里
 * 本来就没有标签，硬按 HTML 处理会把 `a < b` 这种内容当成标签吃掉，
 * 把 `{ "a": 1 }` 里的尖括号弄丢。只有确实是标记语言时才做转换。
 */
function looksLikeHtml(contentType, body) {
  const ct = String(contentType || '').toLowerCase();
  if (/json/.test(ct)) return false;
  if (/^text\/(plain|markdown|csv|tab-separated-values)/.test(ct)) return false;
  if (/html|xml/.test(ct)) return true;
  // 没有 content-type 或不认识：退回看正文开头像不像标记语言
  return /^\s*(?:<!doctype\s+html|<html[\s>]|<\?xml|<head[\s>]|<body[\s>]|<div[\s>]|<p[\s>])/i.test(String(body || ''));
}

const webFetchTool = {
  name: 'web_fetch',
  // 同 web_search：只读的网络读取，不写盘、不执行代码
  autoApprove: true,
  description: [
    '抓取一个网址，把网页正文转成纯文本返回，适合读文档、博客、Issue、API 参考的具体内容。',
    '在你要看某个页面的细节时用它（链接一般来自 web_search 或用户给的消息）；只支持 http/https。',
    '返回的是去标签后的文字，不执行页面里的脚本，所以纯前端渲染的页面可能抓不到正文；正文过长会被截断。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的完整网址，必须带 http:// 或 https://' },
      max_chars: { type: 'integer', description: '正文最多返回多少字符，默认 20000', default: 20000 },
    },
    required: ['url'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const rawUrl = String(args.url ?? args.link ?? '').trim();
    if (!rawUrl) return { ok: false, content: 'url 不能为空：请给出要抓取的完整网址（含 https://）。' };

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return {
        ok: false,
        content: `url 格式不对：${redactUrl(rawUrl)}\n  要写完整的地址，包含协议头，例如 https://example.com/page`,
      };
    }

    // 只放行 http/https：file: 能读本机任意文件，data:/javascript: 能绕过网络边界，
    // ftp: 之类既没实现也容易把错误信息搞乱——直接在门口拒掉，并说明为什么。
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        ok: false,
        content:
          `只允许抓取 http/https 的网页，收到的是 ${parsed.protocol} 协议，已拒绝。\n` +
          '  原因：file: 能读到你本机的文件，data:/javascript: 可以绕过网络边界，都不该由「抓网页」这个动作触发。',
      };
    }

    const maxChars = normalizeMaxChars(args.max_chars);
    const web = (ctx && ctx.cfg && ctx.cfg.web) || {};
    const timeoutSec = normalizeTimeoutSec(web.timeoutSec);

    const got = await httpGet(parsed.href, { timeoutSec, headers: BROWSER_HEADERS, ctx });
    if (!got.ok) return got;

    if (!got.res.ok) {
      return { ok: false, content: describeHttpStatus(got.res.status, parsed.href, '目标网站', got.body) };
    }

    const contentType = headerOf(got.res, 'content-type');
    // 跟随重定向后可能有新地址（测试里的假响应没有 url 字段，退回原地址）
    const finalUrl = String(got.res.url || parsed.href);
    const size = humanSize(Buffer.byteLength(got.body, 'utf8'));

    // JSON / 纯文本原样返回；只有标记语言才做「去标签」转换
    const text = looksLikeHtml(contentType, got.body) ? htmlToText(got.body) : got.body;

    if (!text.trim()) {
      return {
        ok: false,
        content:
          `抓到了页面（${contentType || '未知类型'}，${size}），但没抽出可读文字。\n` +
          '  常见原因：整页内容由脚本渲染、或者只是登录/验证页。可以换个页面，或者用 web_search 找同一主题的其它来源。',
      };
    }

    const clipped = clipText(text, maxChars);
    const notice = clipped.truncated
      ? `\n\n（已截断：正文共 ${clipped.total} 字符，只显示了前 ${maxChars} 字符，还有 ${clipped.omitted} 字符没显示。需要更多请提高 max_chars，或改抓更具体的页面。）`
      : '';

    const title = (got.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    const head = `已抓取 ${finalUrl}（${contentType || '未知类型'}，${size}${title ? `，标题：${cleanInline(title).slice(0, 120)}` : ''}）`;

    return { ok: true, content: `${head}\n\n${clipped.text}${notice}` };
  },
};

/* ================================================================== */

/** 导出：注册表会遍历这个数组逐个注册（和 builtin.js 的 builtinTools 写法一致） */
const webTools = [webSearchTool, webFetchTool];

module.exports = {
  webTools,
  webSearchTool,
  webFetchTool,
  // 下面这些是给测试和排错用的内部件，主程序不需要关心
  describeFetchError,
  htmlToText,
  decodeHtmlEntities,
  parseDuckDuckGoHtml,
  parseBingHtml,
  normalizeBingUrl,
  unwrapDuckDuckGoUrl,
  looksLikeHtml,
  redactSecrets,
  redactUrl,
  buildCustomUrl,
  __setFetchForTest,
  __resetFetchForTest,
};
