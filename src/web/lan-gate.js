'use strict';

/**
 * 梦云 Agent —— 局域网模式的访问令牌闸门
 *
 * 背景：默认只监听 127.0.0.1，`/api/*` 校验 Host/Origin 都是本机（防别的网页
 * 通过你的浏览器来操控 agent）。一旦用 `mya web --host 0.0.0.0` 暴露到局域网，
 * 这套判断就不成立了——访问者的 Host 是 192.168.x.x，不是本机。
 * 所以局域网模式下改成「必须带访问令牌」。
 *
 * 这里踩过的坑（所以单独成模块、单独测）：
 *   原先只认请求头 `x-mya-token`，而**网页前端从来不发这个头**。
 *   结果是：页面能打开（静态资源不校验），但每个 /api 请求都 403，
 *   而且提示写的是「请求来源不是本机页面」——完全误导。功能等于半死。
 *
 * 现在的做法（三种带令牌的方式，按优先级）：
 *   1. URL 上带 `?token=xxx` → 种一个 HttpOnly cookie，然后 302 掉 URL 上的 token
 *      （别让它留在地址栏和浏览器历史里）；
 *   2. 请求头 `x-mya-token`（给脚本/curl 用）；
 *   3. Cookie（浏览器后续请求自动带上，前端代码一行都不用改）。
 *
 * 为什么用 cookie 而不是让前端读地址栏：地址栏里的 token 会被前端代码、日志、
 * 截图、浏览器历史反复暴露；cookie 是 HttpOnly 的，JS 读不到，只用于回传。
 */

/** Cookie 名。固定值，不随机化：随机化只会让人更难排查。 */
const TOKEN_COOKIE = 'mya_token';
const COOKIE_MAX_AGE_SEC = 7 * 24 * 3600;

/**
 * 判断是不是「本机」。
 * 只认这三种：回环地址、localhost、以及 IPv6 回环。
 * 注意**不能**把 0.0.0.0 当本机——它是「监听所有网卡」，不是「只有本机能连」。
 */
function isLoopbackHost(hostname) {
  const h = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (h === '127.0.0.1') return true;
  // 整个 127.0.0.0/8 都是回环
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/** 解析 Cookie 头（零依赖，只做我们需要的那一件事） */
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    /**
     * decodeURIComponent 遇到畸形输入（比如 `%zz`）会直接抛 URIError。
     * 以前这里没兜住：一个手改过的 cookie 就能让请求在半路炸掉、连接永远挂着不回
     * （静态路径不过闸门，所以是未认证可达的）。解不出来就原样用——
     * 它不可能是正确的令牌，交给后面的比较拒绝即可。
     */
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/** 极简 HTML 转义（只给下面那一页用，不引依赖） */
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 造一个令牌闸门。
 * @param {{token:string, displayHost?:string, port?:number}} opts
 */
function makeLanGate({ token = '', displayHost = '', port = 0 } = {}) {
  const enabled = !!token;
  const cookieHeader = () =>
    `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SEC}`;

  return {
    enabled,
    cookieHeader,
    cookieName: TOKEN_COOKIE,

    /**
     * 这次请求放不放行。
     * @returns {'ok'|'authorize'|'deny'} authorize = 地址栏里带了正确令牌，要种 cookie 并跳走
     */
    decide(req, url) {
      if (!enabled) return 'ok';
      const query = url && url.searchParams ? url.searchParams.get('token') : '';
      if (query && query === token) return 'authorize';
      const header = req.headers['x-mya-token'];
      if (header && header === token) return 'ok';
      const cookies = parseCookies(req.headers.cookie);
      if (cookies[TOKEN_COOKIE] === token) return 'ok';
      return 'deny';
    },

    /** 页面被拒时给人看的说明（要说清「怎么进来」，而不是只说「不让你进」） */
    denyPage(hostHeader = '') {
      /**
       * 拼「形如」的示例地址时优先给出**真正能用**的局域网 IP。
       *
       * 以前这里直接用 displayHost，而局域网模式的 displayHost 是 `0.0.0.0`——
       * 那对手机/另一台机器毫无意义（0.0.0.0 在它那儿指它自己）。
       * 而看到这一页的，恰恰就是用手机访问的人。
       *
       * hostHeader 是客户端可控的，所以一律转义后再插进 HTML（反射注入点）。
       */
      const wildcard = !displayHost || displayHost === '0.0.0.0' || displayHost === '::';
      const hosts = wildcard ? lanAddresses() : [displayHost];
      const where = (hosts.length ? hosts : [hostHeader || '这台机器的局域网 IP'])
        .map((h) => `${h}${port ? `:${port}` : ''}`)
        .join(' / ');
      return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>需要访问令牌</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:640px;margin:12vh auto;padding:0 20px;line-height:1.7;color:#18181b}
code{background:#f4f4f5;padding:2px 5px;border-radius:4px;font-family:ui-monospace,Consolas,monospace}
.note{color:#57575e;font-size:14px}</style></head><body>
<h2>这个地址需要访问令牌</h2>
<p>你打开的 agent 监听在局域网地址上，为了防止同一网络里的其他人操作你的文件，
所有请求都要带上启动时打印的令牌。</p>
<p>请用<strong>启动时终端里打印的那条完整链接</strong>打开（形如
<code>http://${escapeHtml(where)}/?token=…</code>）；打开一次之后浏览器会记住，不用每次粘。</p>
<p class="note">如果你就是想从别的机器访问，也可以在请求头里带 <code>x-mya-token: 你的令牌</code>。</p>
</body></html>`;
    },

    /** API 被拒时的结构化错误：别用「来源不是本机页面」那种误导文案 */
    denyJson() {
      return {
        ok: false,
        error: '缺少或错误的访问令牌：请用启动时带 ?token= 的链接打开页面，或在请求头里带 x-mya-token。',
        needToken: true,
      };
    },
  };
}

/**
 * 本机在局域网里的 IPv4 地址（给「另一台机器/手机怎么打开」用）。
 *
 * 为什么需要它：`--host 0.0.0.0` 时终端只打印 127.0.0.1 的链接，
 * 而那台手机根本连不上 127.0.0.1——那正是这个功能存在的意义。
 * 这里只取 IPv4 且跳过回环/内部地址（169.254.x.x 是自分配的，连不通）。
 */
function lanAddresses() {
  const os = require('os');
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (String(info.address).startsWith('169.254.')) continue;
      out.push(info.address);
    }
  }
  return out;
}

module.exports = { makeLanGate, isLoopbackHost, parseCookies, lanAddresses, TOKEN_COOKIE, COOKIE_MAX_AGE_SEC };
