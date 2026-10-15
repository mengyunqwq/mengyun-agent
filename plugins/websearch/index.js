'use strict';

/**
 * 示例插件：websearch（接一个需要 API Key 的搜索服务）
 *
 * 用途：演示「插件如何读取密钥 + 发起网络请求」。
 *
 * ⚠ 关于工具名：这里叫 tavily_search，**故意不叫** web_search。
 * 主程序已经内置了一个免密钥的 web_search（默认走 Bing，见 src/tools/web.js），
 * 插件工具和内置工具重名时注册会被拒（注册表会打印「与内置工具重名」）。
 * 两者的分工是：
 *   内置 web_search   —— 免密钥、开箱可用，日常就用它
 *   本插件 tavily_search —— 演示怎么读 API Key 去接一个第三方服务
 * 想换成别的搜索服务？改下面的 doTavilySearch 即可（Bing / Google CSE / SerpAPI 都是 HTTP 调用）。
 *
 * 启用步骤：
 *   1. 去 https://tavily.com 注册，拿到 API Key（有免费额度）
 *   2. 在 .env 里加一行：MYA_TAVILY_KEY=tvly-xxxxxxxx
 *   3. 重启 agent，然后让它用 tavily_search 查点东西
 *
 * 没有 key 时，search 会返回一段清晰的配置指引，而不是报一个看不懂的错。
 */

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';

module.exports = {
  name: 'websearch',
  version: '0.1.0',
  description: '联网搜索与网页抓取（Tavily，需要 API Key）',

  setup(ctx) {
    // 三层取值：config.json → 环境变量 → 默认值
    const conf = ctx.getConfig({
      provider: 'tavily',
      maxResults: 5,
      timeoutSec: 30,
      allowFetchUrl: true,
    });

    // 密钥来源：MYA_TAVILY_KEY 环境变量 / .env / config.json 的 plugins.config.websearch.apiKey
    const apiKey =
      process.env.MYA_TAVILY_KEY ||
      ctx.config.tavilyKey ||
      conf.apiKey ||
      '';

    /* ---------------- 工具 1：搜索 ---------------- */
    ctx.registerTool({
      name: 'tavily_search',
      description: [
        '联网搜索最新信息（Tavily 服务，需要 API Key），返回标题、摘要和链接。',
        '适用于查询库的最新用法、报错信息、版本变更、外部文档等。',
        '注意：主程序内置的 web_search 免密钥且开箱可用，日常优先用它；',
        '这个工具存在的意义是演示「插件怎么读密钥去接第三方服务」。',
        '查到的内容记得标明来源链接。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，用自然语言提问效果更好' },
          count: { type: 'integer', description: `返回条数，默认 ${conf.maxResults}` },
          topic: { type: 'string', description: 'general（通用）或 news（新闻），默认 general', enum: ['general', 'news'] },
        },
        required: ['query'],
        additionalProperties: false,
      },
      tags: ['web', 'search'],
      autoApprove: true,
      async run(args, tctx) {
        if (!apiKey) {
          return {
            ok: false,
            content: [
              '联网搜索未配置 API Key，暂时不可用。',
              '启用方法：',
              '  1. 到 https://tavily.com 注册并复制 API Key',
              '  2. 在项目根目录的 .env 里加一行：MYA_TAVILY_KEY=tvly-你的key',
              '  3. 重启 agent（重新运行 mya）',
              '如果暂时不需要联网，请基于已有知识回答，并说明这一点。',
            ].join('\n'),
          };
        }

        const query = String(args.query || '').trim();
        if (!query) return { ok: false, content: 'query 不能为空。' };
        const count = Math.max(1, Math.min(Number(args.count) || conf.maxResults, 10));

        try {
          const json = await postJson(
            TAVILY_ENDPOINT,
            {
              api_key: apiKey,
              query,
              max_results: count,
              topic: args.topic === 'news' ? 'news' : 'general',
              include_answer: true,
              search_depth: 'basic',
            },
            (conf.timeoutSec || 30) * 1000,
          );

          const parts = [];
          if (json.answer) parts.push(`综合回答：${json.answer}\n`);
          for (const [i, r] of (json.results || []).entries()) {
            parts.push(`[${i + 1}] ${r.title}\n    ${r.url}\n    ${String(r.content || '').replace(/\s+/g, ' ').slice(0, 500)}`);
          }
          if (!parts.length) return { ok: true, content: `没有搜到与「${query}」相关的结果。` };
          return { ok: true, content: parts.join('\n\n') };
        } catch (err) {
          return { ok: false, content: `搜索失败：${err.message}` };
        }
      },
    });

    /* ---------------- 工具 2：抓取网页正文 ---------------- */
    ctx.registerTool({
      name: 'fetch_url',
      description: [
        '抓取一个网页或接口的文本内容（会自动去掉 HTML 标签）。',
        '适合打开搜索结果里的具体文档页面查看详细内容。',
        '如果是 JSON 接口，会原样返回 JSON 文本。',
        '注意：内置的 web_fetch 也能做这件事，而且不需要 Key；',
        '这个工具留在示例里是为了演示「插件自己实现一次抓取」要处理哪些细节。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '完整网址，必须以 http:// 或 https:// 开头' },
          max_chars: { type: 'integer', description: '最多返回多少字符，默认 8000' },
        },
        required: ['url'],
        additionalProperties: false,
      },
      tags: ['web'],
      // 抓取外部地址属于网络访问，默认需要用户确认
      autoApprove: false,
      async run(args) {
        if (conf.allowFetchUrl === false) {
          return { ok: false, content: 'fetch_url 已在配置中关闭（plugins.config.websearch.allowFetchUrl=false）。' };
        }
        const url = String(args.url || '').trim();
        if (!/^https?:\/\//i.test(url)) return { ok: false, content: 'url 必须以 http:// 或 https:// 开头。' };
        const maxChars = Math.max(500, Math.min(Number(args.max_chars) || 8000, 50000));

        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), (conf.timeoutSec || 30) * 1000);
          const res = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MengyunAgent/0.1)' },
            signal: controller.signal,
            redirect: 'follow',
          });
          clearTimeout(timer);

          if (!res.ok) return { ok: false, content: `抓取失败：HTTP ${res.status} ${res.statusText}` };
          const contentType = res.headers.get('content-type') || '';
          const raw = await res.text();

          if (contentType.includes('json')) {
            return { ok: true, content: `HTTP ${res.status} (JSON)\n\n${raw.slice(0, maxChars)}` };
          }
          const text = htmlToText(raw);
          return {
            ok: true,
            content: `来源：${res.url}\nHTTP ${res.status}  内容长度：${raw.length} 字符\n\n${text.slice(0, maxChars)}${text.length > maxChars ? `\n\n…（已截断，原文共 ${text.length} 字符）` : ''}`,
          };
        } catch (err) {
          const reason = err.name === 'AbortError' ? '请求超时' : err.message;
          return { ok: false, content: `抓取失败：${reason}` };
        }
      },
    });

    ctx.registerCommand(
      'search',
      { description: '直接联网搜索（不经过模型）', usage: '/search 关键词' },
      async (input) => {
        if (!input) return '用法：/search 关键词';
        if (!apiKey) return '未配置 MYA_TAVILY_KEY，无法搜索。';
        const json = await postJson(
          TAVILY_ENDPOINT,
          { api_key: apiKey, query: input, max_results: 5, include_answer: true },
          30000,
        );
        return (json.results || []).map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}`).join('\n') || '没有结果。';
      },
    );

    ctx.log(apiKey ? '已启用（Tavily）' : '未配置 MYA_TAVILY_KEY，搜索工具会在调用时提示配置方法');
  },
};

/* ------------------------------------------------------------------ */
/* 辅助函数                                                            */
/* ------------------------------------------------------------------ */

async function postJson(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}：${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`返回内容不是 JSON：${text.slice(0, 200)}`);
    }
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`请求超时（${timeoutMs / 1000}s）`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 极简 HTML → 文本：去掉 script/style、标签、多余空白。不追求完美，够模型读懂即可 */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}
