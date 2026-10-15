'use strict';

/**
 * 联网工具（web_search / web_fetch）的离线验证。
 * 用法：node test/web-search.js
 *
 * 为什么全程不联网：用户机器上的外网可能根本不通，或者被 TLS 中间人拦掉——
 * 那种环境下「测试失败」说明不了代码有问题，只会让真正的问题被掩盖。
 * 所以这里把请求层换成假的（ctx.fetch），只验证真正属于我们的那部分逻辑：
 * 参数校验、HTML 解析、跳转链接还原、正文转换、截断、错误翻译、敏感信息打码。
 * 真实联网另做冒烟验证，不放进回归测试。
 */

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const web = require(path.join(ROOT, 'src', 'tools', 'web.js'));
const { webTools, webSearchTool, webFetchTool } = web;

const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${err.message}\x1b[0m`);
    if (process.env.MYA_DEBUG) console.log(err.stack);
  }
}

function section(name) {
  console.log(`\n\x1b[36m▌ ${name}\x1b[0m`);
}

/* ------------------------------------------------------------------ */
/* 假的 HTTP 层：所有用例都靠它，测试期间一次真实请求都不会发出            */
/* ------------------------------------------------------------------ */

/** 先上保险：万一哪个用例忘了注入假 fetch，直接炸出来，而不是悄悄连外网 */
web.__setFetchForTest(() => {
  throw new Error('测试不应该真的联网：请用 ctx.fetch 注入假响应');
});

/** 造一个够用的假 Response（真 fetch 的 Response 太大，这里只实现被用到的部分） */
function fakeResponse(body, { status = 200, contentType = 'text/html; charset=utf-8', headers = {} } = {}) {
  const map = {};
  for (const [k, v] of Object.entries({ 'content-type': contentType, ...headers })) {
    map[String(k).toLowerCase()] = String(v);
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '',
    headers: {
      get: (n) => (Object.prototype.hasOwnProperty.call(map, String(n).toLowerCase()) ? map[String(n).toLowerCase()] : null),
    },
    async text() {
      return body;
    },
  };
}

/** 假 fetch：记录每次调用（url/参数），方便断言「请求发对地方了吗」 */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), opts: opts || {} });
    return handler(String(url), opts || {}, calls.length);
  };
  fn.calls = calls;
  return fn;
}

/** 永远是「请求发出去了，但对方不理你」的 fetch：用来验证超时分支 */
function hangingFetch() {
  return (url, opts) =>
    new Promise((_resolve, reject) => {
      const signal = opts && opts.signal;
      if (!signal) return; // 没有 signal 就永远挂着（也说明实现没用超时，测试会超时失败）
      signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      });
    });
}

function searchCtx(cfg, fetchImpl) {
  return { cfg: { web: cfg || {} }, fetch: fetchImpl };
}
function fetchCtx(cfg, fetchImpl) {
  return { cfg: { web: cfg || {} }, fetch: fetchImpl };
}

/* ------------------------------------------------------------------ */
/* 样本：故意写得「脏」——属性顺序乱、大小写混、单引号、脚本里放假结果      */
/* ------------------------------------------------------------------ */

const DDG_SAMPLE = `<!DOCTYPE html>
<html>
<head>
  <title>中文 搜索 at DuckDuckGo</title>
  <style>.result__a { color: #000; }</style>
  <script>
    var fakeResult = '<a class="result__a" href="https://evil.example/should-not-appear">脚本里的假结果</a>';
  </script>
</head>
<body>
  <div class="serp__results">
    <div class="result results_links">
      <h2 class="result__title">
        <a REL="nofollow"  HREF="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffetch&amp;rut=abc" class="result__a">Node.js <b>fetch</b> 官方文档</a>
      </h2>
      <a class="result__snippet" href="#">全局 <b>fetch</b> 说明 &amp; 用法 &#39;示例&#39;</a>
    </div>
    <div class="result results_links">
      <a class='result__a' href='//duckduckgo.com/l/?uddg=https%3A%2F%2Fdeveloper.mozilla.org%2Fzh-CN%2Fdocs%2FWeb%2FAPI%2Ffetch&amp;rut=x'>MDN 上的 fetch</a>
      <a class="result__snippet">中文文档，讲得比较细</a>
    </div>
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/y.js?ad_provider=bingv7aa&amp;clickurl=https%3A%2F%2Fad.example">广告：买点啥</a>
    </div>
    <div class="result">
      <a class="result__a" href="https://example.com/plain">直接就是真实地址</a>
      <a class="result__snippet">  多余   空白    也要折叠  </a>
    </div>
  </div>
</body>
</html>`;

/** 造一个含 n 条结果的 DDG 页面（测条数上限用） */
function ddgSampleOf(n) {
  let html = '<html><body>';
  for (let i = 1; i <= n; i += 1) {
    const real = `https://example.com/${i}`;
    html +=
      `<div class="result"><h2 class="result__title">` +
      `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(real)}&rut=${i}">结果 ${i}</a>` +
      `</h2><a class="result__snippet">摘要 ${i}</a></div>`;
  }
  return `${html}</body></html>`;
}

const NO_RESULT_SAMPLE = '<html><body><div class="no-results">No results.</div></body></html>';

const ANOMALY_SAMPLE =
  '<html><body><h1>Unfortunately, bots use DuckDuckGo too.</h1>' +
  '<p>Your request was detected as unusual traffic. Please try again later.</p></body></html>';

const PAGE_SAMPLE = `<!DOCTYPE html>
<html>
<head>
  <title>测试页</title>
  <style>body{color:red}</style>
  <script>var fake = '<p>脚本里的假正文</p>';</script>
</head>
<body>
  <h1>标题一</h1>
  <p>第一段文字</p>
  <noscript>请开启 JS</noscript>
  <svg><text>矢量图文字</text></svg>
  <div>第二段<br>换行后</div>
  <ul>
    <li>条目一</li>
    <li>条目二</li>
  </ul>
  <table><tr><td>单元格A</td><td>单元格B</td></tr></table>
</body>
</html>`;

/** 统计结果列表里的条数（形如 "1. 标题" 的行） */
function countItems(content) {
  return (content.match(/^\d+\. /gm) || []).length;
}

/* ================================================================== */

(async () => {
  console.log('\n\x1b[1m\x1b[35m联网工具（web_search / web_fetch）离线测试\x1b[0m');

  /* ---------------- 1. 工具外观与参数契约 ---------------- */

  section('1. 工具外观与参数契约');

  await test('导出 webTools 数组与两个具名工具，名字和 schema 符合约定', () => {
    assert.ok(Array.isArray(webTools), 'webTools 应该是数组（注册表要遍历它）');
    assert.strictEqual(webTools.length, 2);
    assert.ok(webTools.includes(webSearchTool) && webTools.includes(webFetchTool));

    assert.strictEqual(webSearchTool.name, 'web_search');
    assert.strictEqual(webFetchTool.name, 'web_fetch');

    assert.deepStrictEqual(webSearchTool.parameters.required, ['query']);
    assert.strictEqual(webSearchTool.parameters.additionalProperties, false);
    assert.strictEqual(webSearchTool.parameters.properties.max_results.default, 5);
    assert.deepStrictEqual(webFetchTool.parameters.required, ['url']);
    assert.strictEqual(webFetchTool.parameters.additionalProperties, false);
    assert.strictEqual(webFetchTool.parameters.properties.max_chars.default, 20000);

    // description 至少两行：第一行说用途，第二行说什么时候用
    for (const t of webTools) {
      assert.ok(t.description.split('\n').length >= 2, `${t.name} 的描述应该有多行`);
      assert.strictEqual(typeof t.run, 'function');
    }
  });

  await test('web_search 缺少 query 时不发请求，直接给中文提示', async () => {
    const f = fakeFetch(() => fakeResponse(DDG_SAMPLE));
    const out = await webSearchTool.run({ query: '   ' }, searchCtx({}, f));
    assert.strictEqual(out.ok, false);
    assert.ok(out.content.includes('不能为空'), `要说明缺什么：${out.content}`);
    assert.strictEqual(f.calls.length, 0, '参数不合法时不该发请求');
  });

  await test('web_fetch 缺少 url 时不发请求', async () => {
    const f = fakeFetch(() => fakeResponse('x'));
    const out = await webFetchTool.run({}, fetchCtx({}, f));
    assert.strictEqual(out.ok, false);
    assert.ok(out.content.includes('不能为空'), out.content);
    assert.strictEqual(f.calls.length, 0);
  });

  await test('web_fetch 只放行 http/https，其它协议拒绝且不发请求', async () => {
    const f = fakeFetch(() => fakeResponse('不该被调用'));
    for (const bad of ['file:///C:/Windows/win.ini', 'ftp://example.com/a.txt', 'data:text/html,<b>x</b>', 'javascript:alert(1)']) {
      const out = await webFetchTool.run({ url: bad }, fetchCtx({}, f));
      assert.strictEqual(out.ok, false, `${bad} 应该被拒绝`);
      assert.ok(out.content.includes('http'), `要说明只允许 http/https：${out.content}`);
      // 把协议名回显出来，用户才知道自己写错了什么
      const proto = bad.slice(0, bad.indexOf(':') + 1);
      assert.ok(out.content.includes(proto), `要指出收到的协议（${proto}）：${out.content}`);
    }
    assert.strictEqual(f.calls.length, 0, '被拒绝的协议不该真的去请求');

    const noProto = await webFetchTool.run({ url: 'example.com/page' }, fetchCtx({}, f));
    assert.strictEqual(noProto.ok, false);
    assert.ok(noProto.content.includes('格式不对'), `没写协议的地址要单独提示：${noProto.content}`);
  });

  /* ---------------- 2. web_search：DuckDuckGo ---------------- */

  section('2. web_search（DuckDuckGo 后端）');

  await test('请求发到 DDG HTML 版，中文关键词被正确编码，且带浏览器 UA', async () => {
    const f = fakeFetch(() => fakeResponse(DDG_SAMPLE));
    await webSearchTool.run({ query: '中文 搜索' }, searchCtx({}, f));
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0].url, `https://html.duckduckgo.com/html/?q=${encodeURIComponent('中文 搜索')}`);
    const ua = f.calls[0].opts.headers['User-Agent'];
    assert.ok(/Mozilla\/5\.0/.test(ua), `不带浏览器 UA 会被 DDG 拒（403），实际：${ua}`);
    assert.strictEqual(f.calls[0].opts.method, 'GET', 'DDG HTML 版用普通 GET');
  });

  await test('解析出标题/真实地址/摘要：跳转链接还原、广告与脚本假结果被排除', async () => {
    const f = fakeFetch(() => fakeResponse(DDG_SAMPLE));
    const out = await webSearchTool.run({ query: 'fetch' }, searchCtx({}, f));
    assert.strictEqual(out.ok, true, out.content);

    assert.ok(out.content.includes('1. Node.js fetch 官方文档'), '标题里的 <b> 标签要被清掉');
    assert.ok(out.content.includes('https://nodejs.org/api/fetch'), '必须还原 uddg 里的真实地址');
    assert.ok(!out.content.includes('duckduckgo.com/l/'), '不能把 DDG 的跳转页交给用户');
    assert.ok(out.content.includes("全局 fetch 说明 & 用法 '示例'"), '摘要要解实体、去标签');

    assert.ok(out.content.includes('https://developer.mozilla.org/zh-CN/docs/Web/API/fetch'), '单引号属性的结果也要解析出来');
    assert.ok(out.content.includes('3. 直接就是真实地址'), '直接给真实地址的结果不能被跳过');
    assert.ok(out.content.includes('多余 空白 也要折叠'), '连续空白要折叠');

    assert.ok(!out.content.includes('evil.example'), '脚本里的假 result__a 不能被当成搜索结果');
    assert.ok(!out.content.includes('广告：买点啥'), 'DDG 的广告跳转链接没有价值，要丢掉');
    assert.ok(!out.content.includes('脚本里的假结果'));

    assert.strictEqual(countItems(out.content), 3, `样本里有效结果应有 3 条：\n${out.content}`);
  });

  await test('输出排版：序号 / 缩进的 URL / 缩进的摘要', async () => {
    const f = fakeFetch(() => fakeResponse(DDG_SAMPLE));
    const out = await webSearchTool.run({ query: 'fetch' }, searchCtx({}, f));
    const lines = out.content.split('\n');
    const at = lines.findIndex((l) => l.startsWith('1. '));
    assert.ok(at >= 0, `应有 "1. 标题" 的行：\n${out.content}`);
    assert.ok(lines[at + 1].startsWith('   https://'), `URL 要缩进对齐：${JSON.stringify(lines[at + 1])}`);
    assert.ok(lines[at + 2].startsWith('   '), `摘要要缩进对齐：${JSON.stringify(lines[at + 2])}`);
    assert.ok(out.content.includes('DuckDuckGo'), '要说明结果来自哪个后端，方便判断可信度');
  });

  await test('条数：默认 5 条、上限 10 条、显式指定生效', async () => {
    const many = ddgSampleOf(12);

    const d = await webSearchTool.run({ query: 'x' }, searchCtx({}, fakeFetch(() => fakeResponse(many))));
    assert.strictEqual(countItems(d.content), 5, '不传 max_results 时默认 5 条');

    const cap = await webSearchTool.run({ query: 'x', max_results: 99 }, searchCtx({}, fakeFetch(() => fakeResponse(many))));
    assert.strictEqual(countItems(cap.content), 10, '上限是 10 条（再多会撑爆上下文）');

    const few = await webSearchTool.run({ query: 'x', max_results: 2 }, searchCtx({}, fakeFetch(() => fakeResponse(many))));
    assert.strictEqual(countItems(few.content), 2);

    const bad = await webSearchTool.run({ query: 'x', max_results: -3 }, searchCtx({}, fakeFetch(() => fakeResponse(many))));
    assert.strictEqual(countItems(bad.content), 5, '非法条数要退回默认值而不是报错');
  });

  await test('一条都没搜到时 ok:false，并提示换关键词（而不是返回空字符串）', async () => {
    const out = await webSearchTool.run({ query: 'aksjdhkajshd' }, searchCtx({}, fakeFetch(() => fakeResponse(NO_RESULT_SAMPLE))));
    assert.strictEqual(out.ok, false);
    assert.ok(out.content.includes('没搜到'), out.content);
    assert.ok(out.content.includes('换个关键词'), `要给出下一步动作：${out.content}`);
    assert.ok(out.content.trim().length > 0);
  });

  await test('DDG 风控页：说清是风控（不是网络问题）并建议换后端', async () => {
    const out = await webSearchTool.run({ query: 'x' }, searchCtx({}, fakeFetch(() => fakeResponse(ANOMALY_SAMPLE))));
    assert.strictEqual(out.ok, false);
    assert.ok(out.content.includes('风控'), out.content);
    assert.ok(out.content.includes('custom'), `要指出出路是自建接口：${out.content}`);
  });

  await test('HTTP 403 给出可读说明，并带上对方返回的片段', async () => {
    const out = await webSearchTool.run(
      { query: 'x' },
      searchCtx({}, fakeFetch(() => fakeResponse(ANOMALY_SAMPLE, { status: 403 }))),
    );
    assert.strictEqual(out.ok, false);
    assert.ok(out.content.includes('403'), out.content);
    assert.ok(/风控|拒绝/.test(out.content), out.content);
    assert.ok(out.content.includes('unusual traffic'), `要带上片段便于判断：${out.content}`);
  });

  /* ---------------- 3. web_search：自定义后端 ---------------- */

  section('3. web_search（custom 后端）');

  await test('{ results: [...] } 形状能解析', async () => {
    const payload = JSON.stringify({
      results: [
        { title: '自建结果一', url: 'https://self.example/1', snippet: '摘要一' },
        { title: '自建结果二', url: 'https://self.example/2', snippet: '摘要二' },
      ],
    });
    const f = fakeFetch(() => fakeResponse(payload, { contentType: 'application/json' }));
    const out = await webSearchTool.run(
      { query: '关键词' },
      searchCtx({ provider: 'custom', endpoint: 'https://searx.example.com/search?q={query}&format=json' }, f),
    );
    assert.strictEqual(out.ok, true, out.content);
    assert.ok(out.content.includes('1. 自建结果一') && out.content.includes('https://self.example/1'));
    assert.ok(out.content.includes('2. 自建结果二'));
    assert.strictEqual(countItems(out.content), 2);
    assert.strictEqual(f.calls[0].url, `https://searx.example.com/search?q=${encodeURIComponent('关键词')}&format=json`);
  });

  await test('裸数组形状也能解析（字段名换个写法同样兼容）', async () => {
    const payload = JSON.stringify([{ name: '别名标题', link: 'https://self.example/a', content: '别名摘要' }]);
    const out = await webSearchTool.run(
      { query: 'q' },
      searchCtx({ provider: 'custom', endpoint: 'https://self.example/api' }, fakeFetch(() => fakeResponse(payload, { contentType: 'application/json' }))),
    );
    assert.strictEqual(out.ok, true, out.content);
    assert.ok(out.content.includes('别名标题') && out.content.includes('https://self.example/a') && out.content.includes('别名摘要'));
  });

  await test('endpoint 没有 {query} 占位符时自动拼 ?q=', async () => {
    const f = fakeFetch(() => fakeResponse('{"results":[]}', { contentType: 'application/json' }));
    await webSearchTool.run({ query: 'a b' }, searchCtx({ provider: 'custom', endpoint: 'https://self.example/search' }, f));
    assert.strictEqual(f.calls[0].url, `https://self.example/search?q=${encodeURIComponent('a b')}`);

    const f2 = fakeFetch(() => fakeResponse('{"results":[]}', { contentType: 'application/json' }));
    await webSearchTool.run({ query: 'a b' }, searchCtx({ provider: 'custom', endpoint: 'https://self.example/s?fmt=json' }, f2));
    assert.strictEqual(f2.calls[0].url, `https://self.example/s?fmt=json&q=${encodeURIComponent('a b')}`);
  });

  await test('自定义后端配错时给得出具体原因（缺 endpoint / 非 JSON / 没有 results）', async () => {
    const missing = await webSearchTool.run(
      { query: 'q' },
      searchCtx({ provider: 'custom' }, fakeFetch(() => fakeResponse(''))),
    );
    assert.strictEqual(missing.ok, false);
    assert.ok(missing.content.includes('endpoint'), `要说清缺哪个配置：${missing.content}`);

    const notJson = await webSearchTool.run(
      { query: 'q' },
      searchCtx({ provider: 'custom', endpoint: 'https://self.example/s' }, fakeFetch(() => fakeResponse('<html>登录页</html>'))),
    );
    assert.strictEqual(notJson.ok, false);
    assert.ok(notJson.content.includes('JSON'), notJson.content);

    const noResults = await webSearchTool.run(
      { query: 'q' },
      searchCtx(
        { provider: 'custom', endpoint: 'https://self.example/s' },
        fakeFetch(() => fakeResponse('{"data":[]}', { contentType: 'application/json' })),
      ),
    );
    assert.strictEqual(noResults.ok, false);
    assert.ok(noResults.content.includes('results'), noResults.content);

    const badProto = await webSearchTool.run(
      { query: 'q' },
      searchCtx({ provider: 'custom', endpoint: 'file:///etc/passwd' }, fakeFetch(() => fakeResponse(''))),
    );
    assert.strictEqual(badProto.ok, false);
    assert.ok(badProto.content.includes('http'), badProto.content);
  });

  /* ---------------- 4. 超时与错误翻译 ---------------- */

  section('4. 超时与错误翻译');

  await test('超时被 AbortController 打断，并给出中文提示与代理出口', async () => {
    const out = await webSearchTool.run({ query: 'x' }, searchCtx({ timeoutSec: 0.05 }, hangingFetch()));
    assert.strictEqual(out.ok, false);
    assert.ok(out.content.includes('超时'), out.content);
    assert.ok(out.content.includes('MYA_PROXY'), `要告诉用户怎么走代理：${out.content}`);
    assert.ok(out.content.includes('timeoutSec'), `也要提配置项：${out.content}`);
  });

  await test('web_fetch 同样有超时保护', async () => {
    const out = await webFetchTool.run({ url: 'https://slow.example/' }, fetchCtx({ timeoutSec: 0.05 }, hangingFetch()));
    assert.strictEqual(out.ok, false);
    assert.ok(out.content.includes('超时'), out.content);
  });

  await test('证书类错误说清是中间人证书（而不是含糊地让人去折腾代理）', () => {
    for (const code of ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED']) {
      const msg = web.describeFetchError({ message: 'fetch failed', cause: { code } }, 'https://example.com/');
      assert.ok(msg.includes('证书'), `${code} 要说清是证书问题：${msg}`);
      assert.ok(msg.includes('NODE_EXTRA_CA_CERTS'), `${code} 要给出导出根证书的办法：${msg}`);
      assert.ok(msg.includes('MYA_INSECURE_TLS'), `${code} 要给出应急开关：${msg}`);
      assert.ok(msg.includes('不安全'), `${code} 必须说明应急开关不安全：${msg}`);
      assert.ok(msg.includes(code), `${code} 原始错误码要保留，便于搜索：${msg}`);
    }
  });

  await test('DNS / 连接被拒 / 超时 / 未知错误各有对策', () => {
    const dns = web.describeFetchError({ message: 'fetch failed', cause: { code: 'ENOTFOUND' } }, 'https://x.example/');
    assert.ok(dns.includes('域名解析不了'), dns);
    assert.ok(/DNS|外网/.test(dns), dns);

    const again = web.describeFetchError({ message: 'fetch failed', cause: { code: 'EAI_AGAIN' } }, 'https://x.example/');
    assert.ok(again.includes('域名解析不了'), again);

    const refused = web.describeFetchError({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } }, 'https://x.example/');
    assert.ok(refused.includes('连接被拒绝'), refused);

    for (const code of ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']) {
      const t = web.describeFetchError({ message: 'fetch failed', cause: { code } }, 'https://x.example/');
      assert.ok(t.includes('超时') && t.includes('MYA_PROXY'), `${code}: ${t}`);
    }

    const aborted = web.describeFetchError(Object.assign(new Error('aborted'), { name: 'AbortError' }), 'https://x.example/');
    assert.ok(aborted.includes('超时'), aborted);

    const unknown = web.describeFetchError({ message: 'fetch failed', cause: { code: 'EUNKNOWNTHING' } }, 'https://x.example/');
    assert.ok(unknown.includes('EUNKNOWNTHING'), `认不出来的错误也要带原始信息：${unknown}`);
  });

  await test('敏感信息不回显：URL 里的 key / 文本里的 token 都要打码', () => {
    const msg = web.describeFetchError(
      { message: 'fetch failed', cause: { code: 'ENOTFOUND' } },
      'https://searx.example/search?q=hi&key=SUPERSECRET123',
    );
    assert.ok(!msg.includes('SUPERSECRET123'), `密钥不能出现在给模型的文本里：${msg}`);
    assert.ok(msg.includes('***'), msg);

    const redacted = web.redactSecrets('错误：api_key=abcdef123456 请求被拒');
    assert.ok(!redacted.includes('abcdef123456'), redacted);
    assert.ok(redacted.includes('已隐藏'), redacted);

    const headers = web.redactSecrets('Authorization: Bearer sk-abcdefghijklmnop');
    assert.ok(!headers.includes('sk-abcdefghijklmnop'), headers);
  });

  /* ---------------- 5. web_fetch：正文转换 ---------------- */

  section('5. web_fetch（HTML → 纯文本）');

  await test('脚本/样式/noscript/svg 整块丢掉，不给模型看垃圾', async () => {
    const out = await webFetchTool.run(
      { url: 'https://example.com/page' },
      fetchCtx({}, fakeFetch(() => fakeResponse(PAGE_SAMPLE))),
    );
    assert.strictEqual(out.ok, true, out.content);
    assert.ok(!out.content.includes('脚本里的假正文'), 'script 内容不能出现');
    assert.ok(!out.content.includes('color:red'), 'style 内容不能出现');
    assert.ok(!out.content.includes('请开启 JS'), 'noscript 内容不能出现');
    assert.ok(!out.content.includes('矢量图文字'), 'svg 内容不能出现');
    assert.ok(!out.content.includes('<h1>') && !out.content.includes('</p>'), '标签本身不能留下');
    assert.ok(out.content.includes('标题一') && out.content.includes('第一段文字'), '正文要在');
  });

  await test('块级标签转换行、<li> 加项目符号、<br> 换行、表格单元格有分隔', async () => {
    const out = await webFetchTool.run(
      { url: 'https://example.com/page' },
      fetchCtx({}, fakeFetch(() => fakeResponse(PAGE_SAMPLE))),
    );
    assert.ok(/\n标题一\n/.test(out.content), `h1 前后要有换行：${JSON.stringify(out.content.slice(0, 80))}`);
    assert.ok(/第二段\n换行后/.test(out.content), `<br> 要变成换行：${out.content}`);
    assert.ok(out.content.includes('- 条目一') && out.content.includes('- 条目二'), `li 要有项目符号：${out.content}`);
    assert.ok(out.content.includes('单元格A 单元格B'), `单元格之间要有分隔：${out.content}`);
  });

  await test('HTML 实体解码：命名 / 十进制 / 十六进制都要还原', async () => {
    const html =
      '<html><body><p>&nbsp;A&amp;B &lt;tag&gt; &quot;q&quot; &#39;单引号&#39; &#x27;x&#x27; &#123; &#x1F600; &hellip;</p></body></html>';
    const out = await webFetchTool.run(
      { url: 'https://example.com/e' },
      fetchCtx({}, fakeFetch(() => fakeResponse(html))),
    );
    assert.strictEqual(out.ok, true, out.content);
    assert.ok(out.content.includes('A&B'), out.content);
    assert.ok(out.content.includes('<tag>'), '&lt;tag&gt; 应还原成字面量尖括号');
    assert.ok(out.content.includes('"q"'), out.content);
    assert.ok(out.content.includes("'单引号'"), out.content);
    assert.ok(out.content.includes("'x'"), '十六进制实体 &#x27; 要还原');
    assert.ok(out.content.includes('{'), '数字实体 &#123; 要还原');
    assert.ok(out.content.includes('😀'), '十六进制 emoji 实体 &#x1F600; 要还原');
    assert.ok(out.content.includes('…'), '命名实体 &hellip; 要还原');
    assert.ok(!out.content.includes('&amp;') && !out.content.includes('&#'), '不能留下未解码的实体');
  });

  await test('折叠多余空行、去掉行首尾空白', async () => {
    const html = '<html><body><p>甲</p><br><br><br><br><p>   乙   </p><div>   </div><p>丙</p></body></html>';
    const out = await webFetchTool.run(
      { url: 'https://example.com/w' },
      fetchCtx({}, fakeFetch(() => fakeResponse(html))),
    );
    const body = out.content.split('\n\n').slice(1).join('\n\n');
    assert.ok(!/\n{3,}/.test(body), `不该有 3 个以上连续换行：${JSON.stringify(body)}`);
    assert.ok(/甲\n+乙\n+丙/.test(body), `顺序要保留：${JSON.stringify(body)}`);
    assert.ok(!/^ +| +$/m.test(body.split('\n').filter(Boolean).join('\n')), '每行首尾不该有空白');
  });

  await test('JSON 与纯文本原样返回，不当 HTML 处理', async () => {
    const json = '{"a":"<b>这不是标签</b>","n":1}';
    const outJson = await webFetchTool.run(
      { url: 'https://api.example/data' },
      fetchCtx({}, fakeFetch(() => fakeResponse(json, { contentType: 'application/json; charset=utf-8' }))),
    );
    assert.strictEqual(outJson.ok, true, outJson.content);
    assert.ok(outJson.content.includes(json), `JSON 要原样保留：${outJson.content}`);

    const plain = 'a < b && c > d\n第二行';
    const outPlain = await webFetchTool.run(
      { url: 'https://example.com/robots.txt' },
      fetchCtx({}, fakeFetch(() => fakeResponse(plain, { contentType: 'text/plain' }))),
    );
    assert.strictEqual(outPlain.ok, true, outPlain.content);
    assert.ok(outPlain.content.includes('a < b && c > d'), `纯文本要原样保留：${outPlain.content}`);
    assert.ok(outPlain.content.includes('第二行'));
  });

  await test('截断到 max_chars，并明确说明还有多少字符没显示', async () => {
    const long = 'x'.repeat(1000);
    const out = await webFetchTool.run(
      { url: 'https://example.com/long', max_chars: 120 },
      fetchCtx({}, fakeFetch(() => fakeResponse(long, { contentType: 'text/plain' }))),
    );
    assert.strictEqual(out.ok, true, out.content);
    assert.ok(out.content.includes('已截断'), out.content);
    assert.ok(out.content.includes('还有 880 字符没显示'), `要给出准确的漏掉字数：${out.content}`);
    assert.ok(out.content.includes('max_chars'), `要告诉模型怎么拿更多：${out.content}`);
  });

  await test('HTTP 404 / 500 给出可读说明而不是抛错', async () => {
    const nf = await webFetchTool.run(
      { url: 'https://example.com/gone' },
      fetchCtx({}, fakeFetch(() => fakeResponse('<html>Not Found</html>', { status: 404 }))),
    );
    assert.strictEqual(nf.ok, false);
    assert.ok(nf.content.includes('404'), nf.content);

    const err = await webFetchTool.run(
      { url: 'https://example.com/boom' },
      fetchCtx({}, fakeFetch(() => fakeResponse('<html>Server Error</html>', { status: 503 }))),
    );
    assert.strictEqual(err.ok, false);
    assert.ok(err.content.includes('503'), err.content);
    assert.ok(/服务端出错|对方/.test(err.content), err.content);
  });

  await test('抓到了但没正文时，说清原因并给出下一步', async () => {
    const out = await webFetchTool.run(
      { url: 'https://example.com/spa' },
      fetchCtx({}, fakeFetch(() => fakeResponse('<html><head></head><body>   </body></html>'))),
    );
    assert.strictEqual(out.ok, false);
    assert.ok(out.content.includes('可读文字'), out.content);
    assert.ok(out.content.includes('web_search'), `要给出替代做法：${out.content}`);
  });

  await test('网络层直接报错时翻译成中文，不把原始栈丢给模型', async () => {
    const out = await webFetchTool.run(
      { url: 'https://nowhere.invalid/' },
      fetchCtx(
        {},
        fakeFetch(() => {
          throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
        }),
      ),
    );
    assert.strictEqual(out.ok, false);
    assert.ok(out.content.includes('域名解析不了'), out.content);
  });

  /* ---------------- 汇总 ---------------- */

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(52)}`);
  console.log(`通过 ${results.length - failed.length} 项 / 失败 ${failed.length} 项 / 共 ${results.length} 项`);
  if (failed.length) {
    console.log('\x1b[31m\x1b[1m失败清单：\x1b[0m');
    for (const f of failed) console.log(`  - ${f.name}: ${f.error && f.error.message}`);
    // 先让 stdout 刷完再退，避免管道模式下最后几行日志被 process.exit 吃掉
    setTimeout(() => process.exit(1), 30);
  } else {
    console.log('\x1b[32m\x1b[1m全部通过\x1b[0m');
  }
})().catch((err) => {
  console.error('\n测试脚本本身出错：', err);
  process.exit(1);
});
