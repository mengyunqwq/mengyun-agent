/* ==========================================================================
   梦云 Agent —— 单页前端
   原生 JS，无构建、无依赖。所有状态都在内存 + localStorage 里。
   ========================================================================== */

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 把字节数变可读 */
function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1048576).toFixed(1)}MB`;
}

function humanMs(ms) {
  if (!ms) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

function timeAgo(ts) {
  const diff = Date.now() - Number(ts || 0);
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function shortPath(p, max = 46) {
  const s = String(p || '').replace(/\\/g, '/');
  return s.length > max ? `…${s.slice(-(max - 1))}` : s;
}

/* ------------------------------------------------------------------ */
/* 轻量 Markdown 渲染                                                  */
/* 目标：把模型输出的常见格式渲染好看，不追求完整 CommonMark。        */
/* 安全：所有文本先转义，再插入标签，模型输出里的 HTML 不会被当代码执行。 */
/* ------------------------------------------------------------------ */

function renderMarkdown(src) {
  const text = String(src ?? '');
  const codeBlocks = [];

  // 1) 先把代码块抠出来，避免里面的符号被后续规则破坏
  let work = text.replace(/```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: lang || '', code });
    return `\u0000CB${idx}\u0000`;
  });

  work = escapeHtml(work);

  // 2) 行内代码
  const inlineCodes = [];
  work = work.replace(/`([^`\n]+)`/g, (m, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `\u0000IC${idx}\u0000`;
  });

  // 3) 标题
  work = work.replace(/^######\s+(.*)$/gm, '<h3>$1</h3>');
  work = work.replace(/^#####\s+(.*)$/gm, '<h3>$1</h3>');
  work = work.replace(/^####\s+(.*)$/gm, '<h3>$1</h3>');
  work = work.replace(/^###\s+(.*)$/gm, '<h3>$1</h3>');
  work = work.replace(/^##\s+(.*)$/gm, '<h3>$1</h3>');
  work = work.replace(/^#\s+(.*)$/gm, '<h3>$1</h3>');

  // 4) 分隔线
  work = work.replace(/^\s*([-*_])\1{2,}\s*$/gm, '<hr>');

  // 5) 引用
  work = work.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
  work = work.replace(/<\/blockquote>\n<blockquote>/g, '<br>');

  // 6) 粗体 / 斜体 / 删除线
  work = work.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  work = work.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  work = work.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  work = work.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // 7) 链接（只允许 http/https，挡掉 javascript:）
  work = work.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  // 裸链接
  work = work.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');

  // 8) 列表：先标记，再包 <ul>
  const lines = work.split('\n');
  const out = [];
  let ulOpen = false;
  let olOpen = false;
  const closeLists = () => {
    if (ulOpen) { out.push('</ul>'); ulOpen = false; }
    if (olOpen) { out.push('</ol>'); olOpen = false; }
  };

  for (const line of lines) {
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul) {
      if (olOpen) { out.push('</ol>'); olOpen = false; }
      if (!ulOpen) { out.push('<ul>'); ulOpen = true; }
      out.push(`<li>${ul[1]}</li>`);
    } else if (ol) {
      if (ulOpen) { out.push('</ul>'); ulOpen = false; }
      if (!olOpen) { out.push('<ol>'); olOpen = true; }
      out.push(`<li>${ol[1]}</li>`);
    } else {
      closeLists();
      out.push(line);
    }
  }
  closeLists();
  work = out.join('\n');

  // 9) 表格（简单的 | a | b | 形式）
  work = work.replace(/(?:^\|.*\|\s*$\n?){2,}/gm, (table) => {
    const rows = table.trim().split('\n').map((r) =>
      r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()),
    );
    if (rows.length < 2) return table;
    const isSep = rows[1].every((c) => /^:?-{2,}:?$/.test(c));
    if (!isSep) return table;
    const head = rows[0].map((c) => `<th>${c}</th>`).join('');
    const body = rows.slice(2).map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  });

  // 10) 段落：连续非空行合并成 <p>
  const blocks = work.split(/\n{2,}/);
  work = blocks
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (/^<(h3|ul|ol|table|blockquote|hr|pre|div)/.test(trimmed)) return trimmed;
      return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');

  // 11) 把占位符换回来
  // eslint-disable-next-line no-control-regex -- \u0000 是内部占位符哨兵（正文里不可能出现），不是误写
  work = work.replace(/\u0000IC(\d+)\u0000/g, (m, i) => `<code>${escapeHtml(inlineCodes[Number(i)])}</code>`);
  // eslint-disable-next-line no-control-regex -- 同上
  work = work.replace(/\u0000CB(\d+)\u0000/g, (m, i) => {
    const cb = codeBlocks[Number(i)];
    const lang = escapeHtml(cb.lang || 'text');
    return `<div class="code-block"><div class="code-block-head"><span>${lang}</span><button class="copy-btn" data-copy>复制</button></div><pre><code>${escapeHtml(cb.code.replace(/\n$/, ''))}</code></pre></div>`;
  });

  return work;
}

/**
 * 交互追踪（默认关闭，自检时会打开）。
 *
 * 起因：设置浮层偶尔会在启动时就是打开状态，界面上完全看不出是谁打开的。
 * 光靠 console 里那句报错查不出所以然，所以把最近的点击记下来，
 * 出问题时能直接看到「第几毫秒、点了哪个元素」。
 *
 * 只有带 ?myaTrace=1 才启用，平时零开销。
 */
const TRACE_ON = /[?&]myaTrace=1/.test(location.search);
const trace = [];

function traceStart() {
  if (!TRACE_ON) return;
  const t0 = performance.now();
  const push = (line) => {
    if (trace.length < 80) trace.push(`${Math.round(performance.now() - t0)}ms ${line}`);
  };
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      const el = t && t.closest ? t.closest('button,[data-copy],.swatch,.session-item,.chip,.tag') : null;
      push(
        `click target=#${(t && t.id) || ''}.${(t && t.className) || ''} ` +
          `btn=#${(el && el.id) || ''} text="${((el && el.textContent) || '').trim().slice(0, 12)}" ` +
          `xy=${e.clientX},${e.clientY}`,
      );
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => push(`key ${e.key}${e.ctrlKey ? '+ctrl' : ''}${e.metaKey ? '+meta' : ''} active=#${(document.activeElement && document.activeElement.id) || ''}`),
    true,
  );
  // eslint-disable-next-line no-underscore-dangle
  window.__drawerTrace = trace;
}

/* ------------------------------------------------------------------ */
/* API 封装                                                            */
/* ------------------------------------------------------------------ */

async function api(pathname, options = {}) {
  const res = await fetch(`/api${pathname}`, {
    method: options.body ? 'POST' : 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`服务返回了非 JSON 内容（HTTP ${res.status}）`);
  }
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `请求失败（HTTP ${res.status}）`);
    err.needsSetup = !!data.needsSetup;
    throw err;
  }
  return data;
}

/**
 * 还没配模型时的引导。
 * 这种情况很常见（第一次打开程序），所以不能只弹个错误了事——
 * 要把「设置」面板打开、光标放进输入框，让用户一步就能配上。
 */
let setupPrompted = false;
function guideToSetup(message) {
  if (!setupPrompted) {
    setupPrompted = true;
    toast(message || '请先配置模型和 API Key', 'warn');
  }
  // 窄屏时先把会话栏收起来，免得盖在设置浮层上
  if (window.innerWidth <= 1180) $('.layout').classList.remove('sidebar-open');
  openSettings('model', { focus: '#apSelect' });
}

/* ------------------------------------------------------------------ */
/* 全局状态                                                            */
/* ------------------------------------------------------------------ */

const state = {
  info: null,
  sessions: [],
  currentId: '',
  blocks: new Map(), // seq -> DOM 节点
  running: false,
  pendingApproval: null,
  /**
   * 乐观渲染的用户消息节点（队列），等服务端 block 回来时「认领」。
   *
   * 为什么是队列不是单个槽：用户可能连着发两条（第二条会被服务端排队），
   * 单槽会被后一条覆盖，前一条的广播回来时就找不到对应节点 → 又变成显示两遍。
   */
  pendingUser: [],
  /** 工作区列表（服务端算好的：注册表 ∪ 会话 cwd） */
  workspaces: [],
  /** API 库：存档列表（Key 只有掩码）与当前使用的那条 id */
  apiProfiles: [],
  apiActiveId: '',
  /** 展开的工作区路径（localStorage 持久化） */
  wsOpen: loadWsOpen(),
  /** 用户手动折起来的工作区（避免「含当前会话就默认展开」把用户的选择顶掉） */
  wsCollapsed: loadWsCollapsed(),
  installTarget: null,
  autoApprove: [],
  usage: null,
  /** 当前上下文用量（估算）：{ used, window, messages, compacted } */
  context: null,
  lastSeq: -1,
  /** 流式文本缓存：seq -> 累积的原始文本（必须存原文，不能从 DOM 读，否则会丢 Markdown） */
  texts: new Map(),
  /** 思考内容缓存：seq -> 累积的思考原文 */
  reasonings: new Map(),
  /** 工具卡片的最新数据：seq -> block（渲染被节流，所以要留住最新一份） */
  toolBlocks: new Map(),
  /** 子任务累计 token（单独记一份，界面上要能看出「这里面有多少是子任务花的」） */
  subtaskTokens: 0,
  /**
   * 侧栏的「工作区」文件树。
   * root = 当前会话的工作目录；open = 展开着的目录；children = path → {dirs,files,truncated}
   * children 里还可能存 'loading' / 'error:xxx'，渲染函数会分别画出占位和错误。
   */
  workspace: null,
};

/* ------------------------------------------------------------------ */
/* 主题（浅色 / 深色 + 主题色）                                        */
/* ------------------------------------------------------------------ */

const THEME_KEY = 'mya.theme';
const ACCENT_KEY = 'mya.accent';

/**
 * 可选的界面主色。
 *
 * 每个颜色要分浅色/深色两套取值，原因很实际：
 * 同一个色号在白底和黑底上的观感差别很大——#2563eb 在白底上很清楚，
 * 在深色底上就发闷；反过来 #60a5fa 在白底上又太浅看不清。
 * 所以浅色主题取该色系偏深的一档，深色主题取偏亮的一档。
 *
 * 数组里三个值依次是：[主色, 压在主色上的文字色, 加强版主色]
 * 文字色必须和主色有足够对比度（白字或深色字）。
 * 加强版只用在 logo / 头像这种小面积渐变上。
 */
const ACCENTS = [
  { key: 'teal', name: '青', light: ['#0d9488', '#ffffff', '#0f766e'], dark: ['#38e0c8', '#06110f', '#0d9488'] },
  { key: 'blue', name: '蓝', light: ['#2563eb', '#ffffff', '#1d4ed8'], dark: ['#60a5fa', '#0b1220', '#2563eb'] },
  { key: 'indigo', name: '靛', light: ['#4f46e5', '#ffffff', '#4338ca'], dark: ['#818cf8', '#0b1220', '#4f46e5'] },
  { key: 'violet', name: '紫', light: ['#7c3aed', '#ffffff', '#6d28d9'], dark: ['#a78bfa', '#14091f', '#7c3aed'] },
  { key: 'pink', name: '粉', light: ['#db2777', '#ffffff', '#be185d'], dark: ['#f472b6', '#21060f', '#db2777'] },
  { key: 'red', name: '红', light: ['#dc2626', '#ffffff', '#b91c1c'], dark: ['#f87171', '#210606', '#dc2626'] },
  { key: 'orange', name: '橙', light: ['#ea580c', '#ffffff', '#c2410c'], dark: ['#fb923c', '#210f04', '#ea580c'] },
  { key: 'green', name: '绿', light: ['#16a34a', '#ffffff', '#15803d'], dark: ['#4ade80', '#04140a', '#16a34a'] },
];

function findAccent(key) {
  return ACCENTS.find((a) => a.key === key) || ACCENTS[0];
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function readSaved(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSaved(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 隐私模式下写不了，不影响本次使用 */
  }
}

/**
 * 应用主题色：直接覆盖 CSS 变量。
 * 比写一堆 CSS 类清爽——加一个颜色只要往 ACCENTS 里加一行。
 */
function applyAccent(key) {
  const accent = findAccent(key);
  const [main, fg, strong] = currentTheme() === 'dark' ? accent.dark : accent.light;
  const root = document.documentElement;
  root.style.setProperty('--acc', main);
  root.style.setProperty('--acc-fg', fg);
  root.style.setProperty('--acc-strong', strong);
  root.setAttribute('data-accent', accent.key);
  writeSaved(ACCENT_KEY, accent.key);
  return accent;
}

function currentAccent() {
  return findAccent(readSaved(ACCENT_KEY)).key;
}

/**
 * 应用主题。
 * @param {string} theme 'light' | 'dark'
 * @param {string} [accentKey] 主题色；不传就沿用已保存的那个
 */
function applyTheme(theme, accentKey) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  writeSaved(THEME_KEY, t);

  updateThemeButtons();
  renderAccentSwatches(); // 色板在浮层里，但一并重画，免得切主题后色点还是旧主题的取值

  // 同一组色号在浅色/深色下取值不同，所以每次切主题都要重新算一遍主色
  applyAccent(accentKey || currentAccent());

  // 桌面程序里还要告诉主进程：窗口边框和阴影也跟着换，
  // 否则深色界面配一圈浅色窗口边，就是用户说的「白边」
  const d = window.myaDesktop;
  if (d && typeof d.setTheme === 'function') {
    d.setTheme(t).catch(() => {});
  }
  return t;
}

function setTheme(theme) {
  applyTheme(theme);
  renderAccentSwatches(); // 深色/浅色切换时色板的显示色也要跟着变
}


/** 设置面板里「浅色 / 深色」两个按钮的选中态 */
function updateThemeButtons() {
  const now = currentTheme();
  $$('#themeSeg .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.themeOpt === now);
  });
}

/** 渲染主题色色板 */
function renderAccentSwatches() {
  const box = $('#accentSwatches');
  if (!box) return;
  const active = currentAccent();
  const dark = currentTheme() === 'dark';

  box.innerHTML = '';
  for (const accent of ACCENTS) {
    const [main, , strong] = dark ? accent.dark : accent.light;
    const btn = document.createElement('button');
    btn.className = `swatch${accent.key === active ? ' active' : ''}`;
    btn.title = `主题色：${accent.name}`;
    btn.dataset.accent = accent.key;
    // 色点用渐变，能同时看出主色和强色
    btn.innerHTML = `
      <span class="swatch-dot" style="background:linear-gradient(135deg, ${main}, ${strong})"></span>
      <span class="swatch-name">${escapeHtml(accent.name)}</span>
    `;
    btn.addEventListener('click', () => {
      applyAccent(accent.key);
      renderAccentSwatches(); // 重画一遍更新选中态
      toast(`主题色已换成${accent.name}色`, 'ok');
    });
    box.appendChild(btn);
  }
}

/**
 * 决定初始主题和主题色。
 * 优先用户上次选的；没选过就跟系统走（系统深色就用深色）。
 */
function initTheme() {
  let savedTheme = readSaved(THEME_KEY);
  if (savedTheme !== 'dark' && savedTheme !== 'light') {
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    savedTheme = prefersDark ? 'dark' : 'light';
  }
  return applyTheme(savedTheme, readSaved(ACCENT_KEY));
}

/* ------------------------------------------------------------------ */
/* Toast                                                               */
/* ------------------------------------------------------------------ */

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(14px)';
    setTimeout(() => el.remove(), 260);
  }, kind === 'err' ? 6000 : 3600);
}

/* ------------------------------------------------------------------ */
/* 消息区渲染                                                          */
/* ------------------------------------------------------------------ */

const messagesEl = () => $('#messages');

function isNearBottom() {
  const el = messagesEl();
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

function scrollToBottom(force = false) {
  const el = messagesEl();
  if (force || isNearBottom()) {
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }
}

/* ------------------------------------------------------------------ */
/* 渲染节流（防「卡死」的核心）                                        */
/* ------------------------------------------------------------------ */

/**
 * 流式正文的「纯文本降级」阈值。
 *
 * 为什么需要：Markdown 解析 + innerHTML 重建是 O(长度) 的开销，而流式
 * 期间每来一个分片就要做一次，累计 O(n²)。几千字的普通回答没问题，
 * 但一段脚本日志、一次大文件 diff、模型大段贴代码时，主线程会被彻底
 * 占满——用户看到的就是「软件卡死」。
 * 所以超过这个长度先按纯文本铺（textContent 几乎不耗时），
 * 等这一块定稿了再一次性解析成 Markdown。
 */
const STREAM_PLAIN_LIMIT = 12000;

/** 定稿时的 Markdown 渲染上限；再长就保持纯文本，省得一次解析好几秒 */
const RENDER_MD_LIMIT = 120000;

/** 工具输出在卡片里最多铺多少字符，超出的折在中间（保证 DOM 体积有上限） */
const TOOL_OUTPUT_LIMIT = 20000;

/**
 * 按帧合并高频重绘。
 *
 * 同一个 key 在 minIntervalMs 之内只会真正画一次，而且永远画「最后一次」
 * 提交的内容，中间那些直接被跳过。这样无论服务端推得多密，主线程每帧的
 * 工作量都是有上限的。
 */
function makePainter(minIntervalMs = 50) {
  const pending = new Map(); // key -> 绘制函数
  const lastAt = new Map(); // key -> 上次真正绘制的时间
  let raf = 0;

  function tick() {
    raf = 0;
    const now = performance.now();
    for (const [key, paint] of [...pending]) {
      if (now - (lastAt.get(key) || 0) < minIntervalMs) continue; // 还没到间隔，下一帧再看
      pending.delete(key);
      lastAt.set(key, now);
      try {
        paint();
      } catch (err) {
        console.error('渲染出错', err);
      }
    }
    if (pending.size) schedule();
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(tick);
  }

  return {
    /** 提交一次重绘；同一 key 的旧提交会被覆盖 */
    push(key, paint) {
      pending.set(key, paint);
      schedule();
    },
    /** 立刻执行挂起的重绘（定稿时必须马上出结果） */
    flush(key) {
      const paint = pending.get(key);
      if (!paint) return;
      pending.delete(key);
      lastAt.set(key, performance.now());
      paint();
    },
  };
}

/** 正文 / 思考 / 工具卡片各用一个节流器，互不干扰 */
const paintText = makePainter(50);
const paintReasoning = makePainter(50);
const paintTool = makePainter(50);

/**
 * 把正文写进容器。
 * 超长文本直接按纯文本铺——这个长度基本都是脚本日志或大段代码，
 * 走 Markdown 解析纯属浪费，而且会卡。
 */
function renderBodyInto(body, text, { forcePlain = false } = {}) {
  const value = text || '';
  if (forcePlain || value.length > RENDER_MD_LIMIT) {
    body.classList.add('plain');
    body.textContent = value;
    return;
  }
  body.classList.remove('plain');
  body.innerHTML = renderMarkdown(value);
}

function clearMessages() {
  messagesEl().innerHTML = '';
  state.blocks.clear();
  state.texts.clear();
  state.reasonings.clear();
  state.toolBlocks.clear();
  state.lastSeq = -1;
  // 换了会话：那些待认领的气泡已经不在 DOM 里了，别拿去认领新会话的消息
  state.pendingUser = [];
}

/** 渲染一个块，返回它的 DOM 节点 */
function renderBlock(block) {
  const wrap = document.createElement('div');
  wrap.dataset.seq = String(block.seq);

  switch (block.type) {
    case 'user': {
      wrap.className = 'block user';
      wrap.innerHTML = `<div class="bubble">${escapeHtml(block.text)}</div>`;
      break;
    }

    case 'assistant': {
      wrap.className = 'block assistant';
      const body = document.createElement('div');
      body.className = `assistant-body${block.muted ? ' muted' : ''}`;
      // 走统一的正文渲染入口：超长文本自动降级成纯文本，
      // 免得一次 Markdown 解析就把界面顶住（历史会话恢复时也会走到这里）
      renderBodyInto(body, block.text || '');
      wrap.appendChild(body);
      if (block.streaming) {
        const caret = document.createElement('span');
        caret.className = 'caret';
        body.appendChild(caret);
      }
      break;
    }

    case 'tool': {
      wrap.className = `block tool ${block.ok === null || block.pending ? 'pending' : block.ok ? 'ok' : 'fail'}`;
      wrap.innerHTML = toolCardHtml(block);
      wrap.querySelector('.tool-head')?.addEventListener('click', () => wrap.classList.toggle('open'));
      break;
    }

    case 'checkpoint': {
      /**
       * git 检查点。
       *
       * 为什么值得在对话里占一块：agent 刚改完你就发现不对，这一块就是「退回去」的入口。
       * 如果只把 ref 写在工具结果里，用户得自己复制到终端——那等于没有这个功能。
       */
      wrap.className = 'block checkpoint-card';
      wrap.innerHTML =
        `<span class="cp-text">已记录检查点 <code>${escapeHtml(block.commit || '')}</code>` +
        `${block.summary ? ` <span class="muted">${escapeHtml(String(block.summary).split('\n').pop())}</span>` : ''}</span>` +
        `<span class="cp-actions">` +
        `<button class="btn small" data-act="diff">看改动</button>` +
        `<button class="btn small" data-act="restore">回滚到这一步</button>` +
        `</span>`;
      wrap.querySelector('[data-act="diff"]')?.addEventListener('click', () => showCheckpointDiff(block.ref));
      wrap.querySelector('[data-act="restore"]')?.addEventListener('click', (e) => restoreCheckpoint(block.ref, e.currentTarget));
      break;
    }

    case 'approval': {
      wrap.className = `block approval-card ${block.approved ? 'yes' : 'no'}`;
      /**
       * 用 DOM 构造而不是拼 innerHTML：这里要塞的东西是**文件内容**（不可信），
       * 拼字符串就等于给 XSS 留门。结论文字走 textContent，
       * diff 走 diffHtml()（它逐行 escapeHtml）。
       */
      const verdict = document.createElement('span');
      verdict.textContent = block.approved ? '✓ 你允许了这次操作' : '✕ 你拒绝了这次操作';
      wrap.appendChild(verdict);
      // 事后也要能看见「当时同意的是什么」：diff 折起来放，别把对话刷屏
      if (block.detail) {
        const details = document.createElement('details');
        details.className = 'approval-diff';
        const summary = document.createElement('summary');
        summary.textContent = '看当时同意了什么';
        const box = document.createElement('pre');
        box.className = 'modal-code diff';
        box.innerHTML = diffHtml(block.detail);
        details.appendChild(summary);
        details.appendChild(box);
        wrap.appendChild(details);
      }
      break;
    }

    /* 模型的思考过程（推理模型的思维链）。
       学 Codex 的做法：独立成块、可折叠、默认折起来——
       思维链常常比正文长好几倍，全摊开会把答案顶到屏幕外。
       流式期间展开（不然用户看不到它在想什么），一结束就自动收起。 */
    case 'reasoning': {
      wrap.className = 'block reasoning';
      if (!block.streaming) wrap.classList.add('collapsed');
      wrap.dataset.reasoning = '1';
      wrap.innerHTML = `
        <div class="reasoning-head">
          <span class="reasoning-icon">
            <svg viewBox="0 0 24 24"><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/><circle cx="12" cy="12" r="3.6"/></svg>
          </span>
          <span class="reasoning-title">${escapeHtml(reasoningTitle(block))}</span>
          <span class="reasoning-chevron">
            <svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>
          </span>
        </div>
        <div class="reasoning-body"><div class="reasoning-text"></div></div>
      `;
      wrap.querySelector('.reasoning-head').addEventListener('click', () => {
        wrap.classList.toggle('collapsed');
      });
      wrap.querySelector('.reasoning-text').textContent = block.text || '';
      break;
    }

    /* 上下文被压缩了。这条必须显式告诉用户：
       否则界面上的用量会突然掉一半，看起来像 bug。 */
    case 'compaction': {
      wrap.className = 'block compaction';
      const bits = [`已折叠 ${block.removed} 条更早的对话`];
      if (block.savedTokens) bits.push(`省下约 ${formatTokens(block.savedTokens)} token`);
      if (block.used && block.window) bits.push(`当前 ${formatTokens(block.used)} / ${formatTokens(block.window)}`);
      wrap.innerHTML = `
        <div class="compaction-head">
          <span class="compaction-icon">↺</span>
          <span class="compaction-title">上下文已压缩</span>
          <span class="compaction-meta">${escapeHtml(bits.join(' · '))}</span>
          <span class="reasoning-chevron"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></span>
        </div>
        <div class="compaction-body"><div class="compaction-text"></div></div>
      `;
      wrap.querySelector('.compaction-head').addEventListener('click', () => wrap.classList.toggle('open'));
      wrap.querySelector('.compaction-text').textContent = block.summary || '';
      break;
    }

    case 'approval_pending': {
      wrap.className = 'block approval-card';
      wrap.innerHTML = '<span>⏳ 等待你确认一个操作…</span>';
      break;
    }

    case 'error': {
      wrap.className = 'block error-card';
      wrap.innerHTML = `${escapeHtml(block.text)}${
        block.where === 'agent.run' ? '<div class="hint">提示：检查模型配置（服务商/地址/Key/模型名），或点右上角设置里的「测试连接」。</div>' : ''
      }`;
      break;
    }

    /* 每一步（一次请求模型）花了多少 token。
       只给总数是不够用的：用户想一眼看出是哪一步开始烧钱的，
       所以工具卡片/正文之后跟一条很轻的用量行。 */
    case 'step': {
      wrap.className = 'block step';
      wrap.textContent = stepText(block);
      break;
    }

    /* 并行子任务：一块代表一个子任务（可折叠）。
       为什么单独立一种块：拆出去的任务不是「一次工具调用」，
       它有自己的目标、轮数、token 和一段过程。塞进工具卡片里，
       用户就看不出「现在有几个活在同时干、谁还没回来」——
       而这是拆分任务最需要一眼看到的信息。 */
    case 'task': {
      wrap.className = 'block task';
      wrap.dataset.taskId = block.taskId || '';
      renderTaskBlock(wrap, block);
      break;
    }

    case 'summary': {
      wrap.className = 'block summary';
      const parts = [];
      if (block.toolCalls) parts.push(`${block.toolCalls} 次工具调用`);
      if (block.turns) parts.push(`${block.turns} 轮`);
      if (block.usage && block.usage.totalTokens) parts.push(`token ${block.usage.totalTokens}`);
      if (block.aborted) parts.push('已中断');
      wrap.textContent = parts.join(' · ') || '完成';
      break;
    }

    case 'queued-note': {
      wrap.className = 'block queued-note';
      wrap.textContent = `已排队（第 ${block.position} 位）：${block.text}`;
      break;
    }

    default: {
      wrap.className = 'block';
      wrap.textContent = block.text || '';
    }
  }

  /**
   * 同一个 seq 只保留一个节点。
   *
   * 为什么必须有这一步：用户消息是**乐观渲染**的（点发送就立刻显示，不等后端），
   * 而服务端随后也会把这条消息作为 block 广播回来。以前这里无条件 append，
   * 于是同一句话会在对话里出现两次（用户看到的就是"我发的消息变成了两条/两行"）。
   * 按 seq 去重之后，无论是补齐、重连还是重放，都不会再长出第二个节点。
   */
  const prev = state.blocks.get(block.seq);
  if (prev && prev.isConnected) prev.replaceWith(wrap);
  else messagesEl().appendChild(wrap);
  state.blocks.set(block.seq, wrap);
  state.lastSeq = Math.max(state.lastSeq, Number(block.seq) || 0);
  scrollToBottom();
  return wrap;
}

/**
 * 工具输出太长时折在中间。
 *
 * 为什么必须折：一次 npm install 或脚本日志能吐几百 KB，全量塞进 DOM
 * 会让布局和滚动都变卡；但直接砍掉尾巴又会让用户看不到最后那行报错 ——
 * 所以头尾都留，只丢中间。
 */
function clampOutput(text) {
  const value = String(text ?? '');
  if (value.length <= TOOL_OUTPUT_LIMIT) return { text: value, dropped: 0 };
  const headLen = Math.floor(TOOL_OUTPUT_LIMIT * 0.55);
  const tailLen = TOOL_OUTPUT_LIMIT - headLen;
  const head = value.slice(0, headLen);
  const tail = value.slice(-tailLen);
  return {
    text: `${head}\n\n……（中间省略 ${value.length - headLen - tailLen} 字符）……\n\n${tail}`,
    dropped: value.length - headLen - tailLen,
  };
}

/** 工具卡片 HTML */
function toolCardHtml(block) {
  const pending = block.ok === null || block.pending;
  // 状态用一个 12px 的对勾 / 叉，而不是大图标：
  // 工具调用在一轮里会连着出现十几条，大图标会把正文的视觉重量抢走；
  // 但对勾比「一个实心圆点」多给了一条信息——不用回忆颜色代表什么，
  // 一眼就知道这一步是成了还是败了（Codex 的工具行也是这么做的）。
  const icon = pending
    ? '<div class="spinner-mini"></div>'
    : `<span class="state-dot ${block.ok ? 'done' : 'error'}">
         <svg viewBox="0 0 24 24">${
           block.ok ? '<path d="m5 13 4.5 4.5L19 7"/>' : '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'
         }</svg>
       </span>`;

  const args = summarizeArgs(block.args);
  const meta = pending ? '' : `${escapeHtml(block.summary || '')}${block.ms ? ` · ${humanMs(block.ms)}` : ''}`;

  let body = '';
  if (block.output) {
    const isDiff = block.name === 'edit' && /(^|\n)[+-]/.test(block.output);
    const { text, dropped } = clampOutput(block.output);
    body = isDiff
      ? renderDiff(text)
      : `<pre class="tool-output">${escapeHtml(text)}</pre>${
          dropped ? `<div class="tool-clip-note">输出过长，中间省略了 ${dropped} 字符</div>` : ''
        }`;
  } else if (!pending) {
    body = '<pre class="tool-output" style="color:var(--fg-3)">（无输出）</pre>';
  }

  return `
    <div class="tool-head">
      <span class="tool-status">${icon}</span>
      <span class="tool-name">${escapeHtml(block.name || '工具')}</span>
      <span class="tool-args">${escapeHtml(args)}</span>
      <span class="tool-meta">${meta}</span>
      <span class="tool-chevron"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></span>
    </div>
    ${body ? `<div class="tool-body">${body}</div>` : ''}
  `;
}

/** 编辑工具的输出做成 diff 样式 */
function renderDiff(text) {
  const lines = String(text).split('\n').slice(0, 200);
  const html = lines
    .map((line) => {
      const cls = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : '';
      return `<span class="${cls}">${escapeHtml(line) || '&nbsp;'}</span>`;
    })
    .join('\n');
  return `<div class="diff">${html}</div>`;
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const priority = ['path', 'file_path', 'command', 'pattern', 'query', 'url', 'name', 'text'];
  for (const key of priority) {
    if (args[key] !== undefined && args[key] !== '') {
      const v = String(args[key]).replace(/\s+/g, ' ');
      return `${key}=${v.length > 58 ? `${v.slice(0, 58)}…` : v}`;
    }
  }
  const json = JSON.stringify(args);
  return json.length > 70 ? `${json.slice(0, 70)}…` : json;
}

/** 更新流式文本（提交给节流器，真正的绘制在 paintStreamingText 里） */
function updateStreamingText(seq, text) {
  const key = Number(seq);
  state.texts.set(key, text);
  paintText.push(`text:${key}`, () => paintStreamingText(key));
}

/** 真正画一块正在流式的正文 */
function paintStreamingText(key) {
  const node = state.blocks.get(key);
  if (!node) return;
  const body = node.querySelector('.assistant-body');
  if (!body) return;

  const text = state.texts.get(key) || '';
  const streaming = node.classList.contains('streaming');

  if (streaming && text.length > STREAM_PLAIN_LIMIT) {
    // 流式期间的长文本先按纯文本铺：等定稿再一次性解析 Markdown
    renderBodyInto(body, text, { forcePlain: true });
  } else {
    renderBodyInto(body, text);
  }

  if (streaming) {
    const caret = document.createElement('span');
    caret.className = 'caret';
    body.appendChild(caret);
  }
  scrollToBottom();
}

/** 追加流式增量（原文存进缓存，避免从 DOM 反读导致 Markdown 丢失） */
function appendStreamingText(seq, delta) {
  const key = Number(seq);
  const next = (state.texts.get(key) || '') + (delta || '');
  updateStreamingText(key, next);
}

/** 工具卡片结果：也走节流，脚本一次吐几百 KB 也不会把界面顶住 */
function updateToolCard(seq, block) {
  const key = Number(seq);
  state.toolBlocks.set(key, block);
  paintTool.push(`tool:${key}`, () => paintToolCard(key));
}

/** 真正重画一张工具卡片 */
function paintToolCard(key) {
  const node = state.blocks.get(key);
  const block = state.toolBlocks.get(key);
  if (!node || !block) return;
  const wasOpen = node.classList.contains('open');
  node.className = `block tool ${block.ok ? 'ok' : 'fail'}`;
  node.innerHTML = toolCardHtml(block);
  node.querySelector('.tool-head')?.addEventListener('click', () => node.classList.toggle('open'));
  // 失败的工具默认展开（用户要立刻看到原因），成功的折叠起来保持清爽
  if (wasOpen || !block.ok) node.classList.add('open');
  scrollToBottom();
}

/* ------------------------------------------------------------------ */
/* 思考过程（推理内容）                                                */
/* ------------------------------------------------------------------ */

/** 思考块的标题：进行中说「正在思考」，结束后给时长和体量。
 *  文案对齐 Codex 的「Thought for 12s」这种「一行说清花了多久」的写法。 */
function reasoningTitle(block) {
  if (block.streaming) return '正在思考…';
  const bits = [];
  if (block.ms) bits.push(`${(block.ms / 1000).toFixed(1)}s`);
  if (block.tokens) bits.push(`${formatTokens(block.tokens)} token`);
  return bits.length ? `已思考 ${bits.join(' · ')}` : '已思考';
}

/** 千位 / k / M 记法，用量条上用 */
function formatTokens(n) {
  const value = Number(n) || 0;
  if (value < 1000) return String(value);
  if (value < 1000000) {
    const k = value / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
  }
  return `${(value / 1000000).toFixed(1)}M`;
}

/** 流式追加思考内容（同样走节流：思维链动辄几千字） */
function updateReasoning(seq, text, meta = {}) {
  const key = Number(seq);
  state.reasonings.set(key, text || '');
  paintReasoning.push(`reason:${key}`, () => paintReasoningBlock(key, meta));
}

/** 真正画一块正在流式的思考内容 */
function paintReasoningBlock(key, meta = {}) {
  const node = state.blocks.get(key);
  if (!node) return;
  const body = node.querySelector('.reasoning-text');
  if (body) body.textContent = state.reasonings.get(key) || '';
  const title = node.querySelector('.reasoning-title');
  if (title) title.textContent = reasoningTitle({ streaming: true, ...meta });
  // 思考内容在变长，跟着滚（用户此时通常正盯着看）
  scrollToBottom();
}

/** 思考结束：标题换成时长，并折起来 */
function endReasoning(seq, ms) {
  const node = state.blocks.get(Number(seq));
  if (!node) return;
  const text = state.reasonings.get(Number(seq)) || node.querySelector('.reasoning-text')?.textContent || '';
  const title = node.querySelector('.reasoning-title');
  if (title) title.textContent = reasoningTitle({ ms, tokens: Math.ceil(text.length / 2) });
  node.classList.remove('streaming');
  node.classList.add('collapsed');
}

/** 思考结束后紧接着就是正文，中间不需要再占位 */
function removeThinkingIfIdle() {
  if ($('.reasoning.streaming')) return;
  removeThinking();
}

/* ------------------------------------------------------------------ */
/* 上下文用量                                                          */
/* ------------------------------------------------------------------ */

/**
 * 画上下文用量条。
 *
 * 分子是「这一轮要发出去的规模」（服务端估算），分母是模型窗口大小。
 * 用真实 usage 的 promptTokens 更准，但那只在上一次响应里才有，
 * 而且压缩之后就对不上了，所以统一用估算值，标注上也写明是估算。
 */
function renderContext() {
  const meter = $('#ctxMeter');
  const text = $('#ctxText');
  const fill = $('#ctxFill');
  if (!meter || !text || !fill) return;

  const ctx = state.context || {};
  const used = Number(ctx.used) || 0;
  const window = Number(ctx.window) || 0;
  if (!used && !window) {
    meter.hidden = true;
    return;
  }

  meter.hidden = false;
  const ratio = window ? Math.min(1, used / window) : 0;
  const pct = ratio * 100;

  // 圆环进度用 stroke-dashoffset 表达：周长 C，走到 p 时虚线偏移 C×(1-p)。
  // 比「宽度百分比」准（宽度终究是个矩形），而且天然就是一圈。
  const radius = (fill.r && fill.r.baseVal && fill.r.baseVal.value) || 9;
  const circumference = 2 * Math.PI * radius;
  fill.style.strokeDasharray = circumference.toFixed(2);
  fill.style.strokeDashoffset = (circumference * (1 - ratio)).toFixed(2);
  // 档位挂在容器上：div 的 className 是字符串，好读也好测；
  // SVG 元素的 className 是 SVGAnimatedString，直接赋字符串是不生效的（踩过这种坑）
  meter.classList.toggle('danger', ratio >= 0.85);
  meter.classList.toggle('warn', ratio >= 0.6 && ratio < 0.85);
  // 悬停气泡和自检都读它，省得再去反解 dashoffset
  meter.dataset.pct = pct.toFixed(0);

  // 只有真的开了自动压缩才标出来。默认是手动压缩，
  // 标成「自动压缩已开」会让用户以为放着不管就会自己压。
  // （这个状态现在写在悬停气泡的第二行里，不再单独占一个角标）
  const autoCompact = !!(state.info && state.info.compact && state.info.compact.auto);

  const compactNote = ctx.compacted ? ` · 已折叠 ${ctx.compacted} 条` : '';
  text.textContent = `上下文 ${formatTokens(used)} / ${formatTokens(window)}（${pct.toFixed(0)}%）${compactNote}`;
  // 第二行讲清「这个分母可不可信」和压缩策略。
  // 原来这些放在原生 title 里，现在自己有气泡了，就别再叠一层系统提示
  const sub = $('#ctxSub');
  if (sub) {
    sub.textContent =
      `窗口 ${formatTokens(window)}：${WINDOW_SOURCE_LABELS[ctx.windowSource] || '来源未知'}` +
      (state.usage && state.usage.totalTokens
        ? ` · 本会话累计 ${formatTokens(state.usage.totalTokens)} token`
        : '') +
      (autoCompact ? ' · 自动压缩已开' : ' · 压缩：手动') +
      // 用量的可信度也要说清楚：估算对中文偏低，拿到上游实测之后就按实测兜底了
      (ctx.anchorUsed ? ' · 已按上游实测校准' : ' · 按字符估算（还没拿到上游实测）');
  }
}

/**
 * 上下文窗口这个数字是从哪来的。
 * 必须如实说明：网关报的是权威值，按模型名推断的只是我猜的——
 * 猜错会让用量条的百分比失去意义（看着 20%，其实早满了）。
 */
const WINDOW_SOURCE_LABELS = {
  config: '你在设置里指定的',
  gateway: '网关返回的（权威值）',
  estimate: '按模型名推断的（网关没给这个信息，不准）',
};

/** 每一步的 token 文案 */
function stepText(block) {
  const u = block.usage || {};
  const c = block.cumulative || {};
  const bits = [];
  if (block.turn) bits.push(`第 ${block.turn} 步`);
  if (u.promptTokens || u.completionTokens) {
    bits.push(`↑${formatTokens(u.promptTokens || 0)} ↓${formatTokens(u.completionTokens || 0)}`);
  }
  if (block.ms) bits.push(humanMs(block.ms));
  if (c.totalTokens) bits.push(`累计 ${formatTokens(c.totalTokens)}`);
  return `· ${bits.join(' · ')}`;
}

/** 上下文压缩进行中的提示 */
function showCompacting(info) {
  const node = document.createElement('div');
  node.className = 'block compacting-note';
  node.dataset.compacting = '1';
  const dot = document.createElement('span');
  dot.className = 'dot-pulse';
  // 数字走 textContent，不拼 HTML：这里虽然只有百分数，但保持
  // 「动态内容一律不进 innerHTML」的习惯，免得以后改成插文本时忘了转义
  node.append(dot, document.createTextNode(`上下文快满了（${Math.round((Number(info && info.ratio) || 0) * 100)}%），正在总结较早的对话…`));
  messagesEl().appendChild(node);
  scrollToBottom(true);
}

function removeCompacting() {
  $$('[data-compacting]', messagesEl()).forEach((el) => el.remove());
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

let sseRetry = 0;

function connectEvents() {
  const es = new EventSource('/api/events');

  es.addEventListener('open', () => {
    sseRetry = 0;
    setModelDot('ok');
  });

  es.addEventListener('error', () => {
    setModelDot('bad');
    // EventSource 自己会重连，这里只提示一下
    if (sseRetry++ === 0) toast('与服务端的连接断开了，正在重连…', 'warn');
  });

  es.addEventListener('message', (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleEvent(data).catch((err) => console.error('处理事件出错', err));
  });
}

async function handleEvent(ev) {
  // 只处理当前会话的事件，别的会话的在后台跑
  const forMe = !ev.sessionId || ev.sessionId === state.currentId;

  switch (ev.type) {
    case 'hello':
      break;

    case 'session':
      if (forMe) setRunning(false);
      break;

    case 'status':
      if (forMe) {
        setRunning(!!ev.running);
        if (!ev.running && ev.usage) state.usage = ev.usage;
        renderUsage();
      }
      break;

    case 'title':
      if (forMe) {
        updateSessionTitle(ev.title);
        const h = $('.session-item.active .t');
        if (h) h.textContent = ev.title;
      }
      break;

    case 'turn_start':
      if (forMe && ev.turn > 1) removeThinking();
      break;

    /* 思考过程：单独成块，不混进正文 */
    case 'reasoning':
      if (forMe) {
        removeThinking();
        let node = state.blocks.get(Number(ev.seq));
        if (!node || !node.classList.contains('reasoning')) {
          node = renderBlock({
            seq: ev.seq,
            type: 'reasoning',
            text: ev.text || '',
            streaming: true,
          });
          // 流式期间展开显示，结束后再折（见 endReasoning）
          node.classList.remove('collapsed');
          node.classList.add('streaming');
        }
        updateReasoning(ev.seq, ev.text, { ms: ev.ms });
      }
      break;

    case 'reasoning_end':
      if (forMe) endReasoning(ev.seq, ev.ms);
      break;

    /* 上下文用量：每轮都会推一次 */
    case 'context':
      if (forMe) {
        state.context = { ...(state.context || {}), ...(ev.context || {}) };
        renderContext();
      }
      break;

    case 'context_compacting':
      if (forMe) showCompacting(ev);
      break;

    case 'assistant_start':
      if (forMe) {
        removeThinking();
        state.texts.set(state.lastSeq + 1, '');
      }
      break;

    case 'delta':
      if (forMe) {
        removeThinkingIfIdle();
        // 正文一出现，思考块就该折起来了（此时用户要看的是答案）
        $$('.reasoning.streaming', messagesEl()).forEach((el) => el.classList.remove('streaming'));
        const last = state.blocks.get(state.lastSeq);
        if (last && last.classList.contains('assistant')) {
          appendStreamingText(state.lastSeq, ev.text);
        } else {
          const seq = state.lastSeq + 1;
          state.texts.set(seq, '');
          renderBlock({ seq, type: 'assistant', text: ev.text || '', streaming: true });
          state.texts.set(seq, ev.text || '');
        }
      }
      break;

    case 'text':
      if (forMe) updateStreamingText(ev.seq, ev.text);
      break;

    case 'text_end':
      if (forMe) {
        const key = Number(ev.seq);
        // 定稿：文本不会再变了，把挂起的绘制先执行掉
        paintText.flush(`text:${key}`);
        const node = state.blocks.get(key);
        node?.querySelector('.caret')?.remove();
        node?.classList.remove('streaming');
        // 流式期间长文本是按纯文本铺的，现在一次性渲染成 Markdown
        // （全程只做这一次，所以再长也不会卡）
        const body = node?.querySelector('.assistant-body');
        if (body) renderBodyInto(body, state.texts.get(key) || '');
      }
      break;

    case 'assistant_end':
      if (forMe) removeThinking();
      break;

    case 'block':
      if (forMe) {
        // 已经渲染过的流式 assistant 块，用正式内容覆盖
        const key = Number(ev.block.seq);
        const existing = state.blocks.get(key);
        if (existing && ev.block.type === 'assistant') {
          existing.querySelector('.caret')?.remove();
          existing.classList.remove('streaming');
          const body = existing.querySelector('.assistant-body');
          if (body) {
            renderBodyInto(body, ev.block.text || '');
            body.classList.toggle('muted', !!ev.block.muted);
          }
          state.texts.set(key, ev.block.text || '');
          return;
        }
        /**
         * 用户消息：如果这就是我们刚才乐观渲染的那一条，认领它——
         * 补上服务端分配的真实 seq，并把它登记进 state.blocks，
         * 而不是再渲染一个新节点（那会让同一句话显示两遍）。
         * 按「文本 + 先后顺序」配对（客户端猜的 seq 与服务端分配的不一定相同），
         * 连续发多条时各认领各的。
         */
        if (ev.block.type === 'user' && state.pendingUser.length) {
          const idx = state.pendingUser.findIndex((p) => p.text === ev.block.text);
          if (idx !== -1) {
            const [pending] = state.pendingUser.splice(idx, 1);
            const el = pending.el;
            if (el && el.isConnected) {
              el.dataset.seq = String(ev.block.seq);
              state.blocks.set(Number(ev.block.seq), el);
              state.lastSeq = Math.max(state.lastSeq, Number(ev.block.seq) || 0);
              scrollToBottom();
              return;
            }
          }
        }
        renderBlock(ev.block);
      }
      break;

    /* 子任务有进展：就地改那一块（不新开块，否则一个任务能刷出上百条） */
    case 'task_update': {
      if (!forMe) break;
      const node = state.blocks.get(Number(ev.seq));
      if (!node || !ev.block) break;
      // 用户在看着这块的时候别把它重置了：折叠状态和滚动位置都留着
      const wasOpen = node.classList.contains('open');
      const scroller = node.querySelector('.task-activity');
      const scrollTop = scroller ? scroller.scrollTop : 0;
      const stuckBottom = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8 : true;
      renderTaskBlock(node, ev.block, { keepFold: wasOpen });
      const next = node.querySelector('.task-activity');
      if (next) next.scrollTop = stuckBottom ? next.scrollHeight : scrollTop;
      break;
    }

    /* 子任务花掉的 token 计入本次会话累计——不然界面上的数字会偏小 */
    case 'task_usage': {
      if (!forMe) break;
      if (ev.usage) {
        state.usage = ev.usage;
        state.subtaskTokens = ev.subtaskTokens || 0;
        renderUsage();
      }
      break;
    }

    case 'tool_result':
      if (forMe) updateToolCard(ev.seq, ev.block);
      break;

    case 'tools_planned':
      if (forMe) removeThinking();
      break;

    case 'queued':
      if (forMe) {
        renderBlock({ seq: state.lastSeq + 1, type: 'queued-note', text: ev.text, position: ev.position });
      }
      break;

    case 'queue_cleared':
      if (forMe && ev.dropped) toast(`已丢弃 ${ev.dropped} 条排队中的消息`, 'warn');
      break;

    case 'done':
      if (forMe) {
        state.usage = ev.usage;
        if (ev.session && ev.session.context) state.context = ev.session.context;
        renderUsage();
        removeCompacting();
        refreshSessions();
      }
      break;

    case 'removed':
      if (forMe) {
        toast('会话已删除');
        // 当前会话被别人删掉了（比如另一个窗口），补一个不带弹窗的新会话，
        // 正处于操作中间时不该被「选目录」的对话框挡住
        newSession({ silent: true });
      }
      refreshSessions();
      break;

    case 'approval_request':
      showApproval(ev.approval);      break;

    case 'approval_timeout':
      if (state.pendingApproval && state.pendingApproval.id === ev.id) {
        hideApproval();
        toast('确认超时（5 分钟），已按拒绝处理', 'warn');
      }
      break;

    case 'approval_done':
      if (state.pendingApproval && state.pendingApproval.id === ev.id) hideApproval();
      break;

    case 'plugins_changed':
      loadPlugins();
      loadTools();
      loadSidebarPlugins(); // 侧栏那份「装了什么/开着没有」也要跟着变
      toast(`插件已更新：当前 ${ev.reload.tools} 个工具`, 'ok');
      break;

    case 'error':
      if (forMe) {
        removeThinking();
        toast(ev.text || '出错了', 'err');
      }
      break;

    case 'summary':
      break;

    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* 运行状态 / 顶部栏                                                   */
/* ------------------------------------------------------------------ */

function setRunning(running) {
  state.running = running;
  // 空闲时只留「发送」，运行时只留「停止」——两个都显示会让人不知道点哪个。
  // 顶栏那个停止是给窄屏用的（输入框被键盘挡住时也能中断）
  const sendBtn = $('#btnSend');
  const stopBtn = $('#btnStop');
  sendBtn.hidden = running;
  sendBtn.disabled = running;
  stopBtn.hidden = !running;
  $('#btnAbort').hidden = !running;

  if (running) {
    setModelDot('busy');
    showThinking();
  } else {
    setModelDot(state.info && state.info.hasApiKey ? 'ok' : '');
    removeThinking();
  }
}

/**
 * 设置模型状态点的颜色。
 *
 * 只剩输入区左下角这一处：顶栏原来还有一个模型胶囊的点，
 * 顶栏的模型显示整个去掉之后，状态点也跟着收拢到模型按钮上。
 * 状态只显示在一个地方，反而不会出现「两处颜色不一样」的困惑。
 */
function setModelDot(kind) {
  const dot = $('#composerDot');
  if (dot) dot.className = `dot ${kind || ''}`.trim();
}

function showThinking() {
  if ($('.thinking')) return;
  const el = document.createElement('div');
  el.className = 'block thinking';
  el.innerHTML = '<span class="d"></span><span class="d"></span><span class="d"></span><span>思考中…</span>';
  messagesEl().appendChild(el);
  scrollToBottom(true);
}

function removeThinking() {
  $$('.thinking', messagesEl()).forEach((el) => el.remove());
}

function renderUsage() {
  const u = state.usage;
  const hint = $('#usageHint');
  if (!hint) return;
  if (!u || !u.totalTokens) {
    hint.textContent = '';
  } else {
    // 括号里带上输入/输出拆分：光看总数不知道「贵」在哪
    const inTok = u.promptTokens || 0;
    const outTok = u.completionTokens || 0;
    const sub = state.subtaskTokens || 0;
    hint.textContent =
      `本会话累计 ${formatTokens(u.totalTokens)} token（入 ${formatTokens(inTok)} / 出 ${formatTokens(outTok)}${sub ? ` / 子任务 ${formatTokens(sub)}` : ''}）`;
    hint.title =
      `输入 ${inTok} · 输出 ${outTok} · 合计 ${u.totalTokens}（服务商计量，跨所有轮次累计）` +
      (sub ? `\n其中子任务 ${sub} token（并行拆分出去的活）` : '');
  }
  renderContext();
}

/**
 * 画（或重画）一块子任务。
 *
 * 三件事要一眼能看到：**这个子任务在干什么**（目标）、**现在什么状态**（跑着/完成/失败）、
 * **花了多少**（轮数 / token / 耗时）。过程（activity）折在下面：运行时默认展开，
 * 完成后自动收起——不然几个子任务跑完，整屏都是它们的流水账。
 */
function renderTaskBlock(node, block, opts = {}) {
  const status = block.status || 'running';
  const labels = {
    queued: '排队中',
    running: '进行中',
    done: '完成',
    failed: '失败',
    aborted: '已中止',
    timeout: '超时',
  };
  // 默认展开的只有「还在跑」的：完成的收起来，省得刷屏
  const open = opts.keepFold !== undefined ? opts.keepFold : status === 'running' || status === 'queued';
  node.classList.toggle('open', open);
  node.classList.toggle('busy', status === 'running');
  node.dataset.status = status;

  const meta = [];
  if (block.turns) meta.push(`${block.turns} 轮`);
  if (block.tokens) meta.push(`↑${formatTokens(block.tokens)}`);
  if (block.ms) meta.push(humanMs(block.ms));
  if (block.allowTools && block.allowTools.length) meta.push(block.allowTools.join('/'));

  const activity = (block.activity || [])
    .map((line) => `<div class="task-line">${escapeHtml(line)}</div>`)
    .join('');

  node.innerHTML =
    `<div class="task-head">` +
    `<span class="task-caret">▸</span>` +
    `<span class="task-title">${escapeHtml(block.title || '子任务')}</span>` +
    `<span class="task-status ${status}">${labels[status] || status}</span>` +
    `<span class="task-meta">${escapeHtml(meta.join(' · '))}</span>` +
    `</div>` +
    `<div class="task-body">` +
    (block.goal ? `<div class="task-goal">${escapeHtml(block.goal)}</div>` : '') +
    (activity ? `<div class="task-activity">${activity}</div>` : '') +
    (block.summary ? `<div class="task-summary">${escapeHtml(block.summary)}</div>` : '') +
    `</div>`;

  const head = node.querySelector('.task-head');
  head.addEventListener('click', () => {
    node.classList.toggle('open');
    node.dataset.touched = '1'; // 用户自己折过：之后不再自动展开/收起
    if (node.classList.contains('open')) {
      const box = node.querySelector('.task-activity');
      if (box) box.scrollTop = box.scrollHeight;
    }
  });
}

function updateSessionTitle(title) {
  const item = state.sessions.find((s) => s.id === state.currentId);
  if (item) item.title = title;
  setTopTitle(title);
}

/** 顶栏正中的会话标题。
 *  为什么要有它：窗口被别的程序压住一半、或者刚切完会话时，
 *  「我现在在哪个会话里干活」应该一眼可见，而不是回左侧列表里找哪条是高亮的。 */
function setTopTitle(title) {
  const el = $('#topTitle');
  if (!el) return;
  const value = String(title || '').trim();
  el.textContent = value;
  el.title = value;
}

/* ------------------------------------------------------------------ */
/* 会话管理                                                            */
/* ------------------------------------------------------------------ */

async function loadSessions() {
  const data = await api('/sessions');
  state.sessions = data.sessions || [];
  // 会话到手之后才能算「每个工作区下有几个会话」，所以这里也要刷工作区列表
  await refreshWorkspaces();
  renderSessions();
}

/**
 * 会话列表的入口（保留这个名字：会话现在挂在工作区下面，
 * 但调用点有十几处，让它们都改成 renderWorkspaces 只会制造无谓的改动）。
 *
 * 以前这里是独立的「会话」区块，和「工作区」并列；现在两者合成一棵树：
 * 工作区 = 文件夹，会话挂在它下面——用户找的是「我在哪个项目里说过这句话」。
 */
function renderSessions() {
  renderWorkspaces();
}

async function refreshSessions() {
  try {
    const data = await api('/sessions');
    state.sessions = data.sessions || [];
    renderSessions();
  } catch {
    /* 忽略：刷新失败不该打断对话 */
  }
}

/* ------------------------------------------------------------------ */
/* 侧栏：工作区（文件夹）与其下的会话                                  */
/* ------------------------------------------------------------------ */

/**
 * 工作区 = 一个文件夹；会话挂在它下面，一个文件夹可以有多个会话。
 *
 * 为什么改成这样：原来的「工作区」显示的是当前会话的**文件树**——
 * 那是「这个项目里有什么文件」，而不是用户想找的「我在这个项目里聊过什么」。
 * 用户要的是「这段会话所处的文件夹」，所以这里列的是工作区 + 它下面的会话。
 *
 * 数据来源：/api/workspaces（注册表 ∪ 各会话的 cwd），
 * 会话仍然来自 state.sessions（已经带了 cwd 和 archived）。
 */

/** 展开的工作区路径（记在 localStorage：下次打开还保持上次的样子） */
function loadWsOpen() {
  try {
    const raw = JSON.parse(localStorage.getItem('mya.ws.open') || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function saveWsOpen() {
  try {
    localStorage.setItem('mya.ws.open', JSON.stringify([...state.wsOpen]));
  } catch {
    /* 存不下就算了，只影响下次打开的展开状态 */
  }
}

/** 用户手动折起来的工作区（要和「默认展开」区分开，否则下次渲染又给它展开了） */
function loadWsCollapsed() {
  try {
    const raw = JSON.parse(localStorage.getItem('mya.ws.collapsed') || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function saveWsCollapsed() {
  try {
    localStorage.setItem('mya.ws.collapsed', JSON.stringify([...state.wsCollapsed]));
  } catch {
    /* 同上 */
  }
}

/** 拉工作区列表（服务端会把「会话所在的文件夹」自动算进来） */
async function refreshWorkspaces() {
  try {
    const data = await api('/workspaces');
    state.workspaces = data.list || [];
  } catch {
    // 接口失败不该让侧栏空白：退化成「只用会话分组」，至少还能切会话
    state.workspaces = [];
  }
  renderWorkspaces();
}

/**
 * 画工作区树。
 *
 * 每个工作区一行：文件夹名 + 会话数 + 两个动作（在这个文件夹新建会话 / 更多）。
 * 展开后列出它的会话（当前会话高亮），悬停出「归档」「删除」。
 * 已归档的会话不混在里面，单独收到下面的「已归档」组里。
 */
function renderWorkspaces() {
  const box = $('#wsList');
  if (!box) return;
  const sessions = state.sessions || [];
  const active = sessions.filter((s) => !s.archived);
  const archived = sessions.filter((s) => s.archived);

  // 工作区清单：接口给的 + 兜底（接口挂了也要能用会话的 cwd 显示出来）
  let list = state.workspaces && state.workspaces.length ? state.workspaces : [];
  if (!list.length && sessions.length) {
    const seen = new Map();
    for (const s of sessions) {
      const key = String(s.cwd || '').toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.set(key, { path: s.cwd, name: basename(s.cwd), sessionCount: 0, archivedCount: 0, exists: true });
    }
    list = [...seen.values()];
  }

  const countEl = $('#wsCount');
  if (countEl) countEl.textContent = list.length ? String(list.length) : '';

  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML =
      '<div class="ws-empty">还没有工作区。点上面的 <b>+</b> 选一个文件夹，或者在下面「新建会话」时选目录。</div>';
  }

  for (const w of list) {
    const key = String(w.path || '').toLowerCase();
    const mine = active.filter((s) => String(s.cwd || '').toLowerCase() === key);
    /**
     * 展开状态，按优先级：
     *   1. 用户手动折过 → 折着（尊重用户，哪怕里面有当前会话）
     *   2. 用户手动展开过 → 展开
     *   3. 里面装着当前会话 → 展开（否则打开程序只看见一个折起的文件夹，
     *      连自己正在聊的那条都看不到——这曾经是个真 bug）
     *   4. 没有会话的空工作区 → 展开（刚建完，等着用户点「+ 新建会话」）
     */
    const hasCurrent = mine.some((s) => s.id === state.currentId);
    const open =
      !state.wsCollapsed.has(key) && (state.wsOpen.has(key) || hasCurrent || mine.length === 0);
    const row = document.createElement('div');
    row.className = 'ws-item' + (open ? ' open' : '') + (w.exists === false ? ' missing' : '');
    row.dataset.ws = w.path || '';
    row.dataset.count = String(mine.length);

    const head = document.createElement('div');
    head.className = 'ws-head';
    head.title = w.exists === false ? w.path + '（这个文件夹已经不在了）' : w.path;
    head.innerHTML =
      '<span class="ws-caret">▸</span>' +
      '<span class="ws-icon">📁</span>' +
      '<span class="ws-name">' + escapeHtml(w.name || basename(w.path)) + '</span>' +
      '<span class="ws-count">' + mine.length + '</span>';
    head.addEventListener('click', (e) => {
      if (e.target.closest('[data-act]')) return;
      toggleWorkspace(w.path);
    });

    const acts = document.createElement('div');
    acts.className = 'ws-acts';
    acts.innerHTML =
      '<button title="在这个文件夹里新建会话" data-act="new">+</button>' +
      '<button title="更多操作" data-act="more">⋯</button>';
    acts.querySelector('[data-act="new"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      await newSession({ silent: true, cwd: w.path });
    });
    acts.querySelector('[data-act="more"]').addEventListener('click', (e) => {
      e.stopPropagation();
      openWorkspaceMenu(w, e.currentTarget);
    });
    head.appendChild(acts);
    row.appendChild(head);

    const body = document.createElement('div');
    body.className = 'ws-sessions';
    if (open) {
      if (!mine.length) {
        const empty = document.createElement('div');
        empty.className = 'ws-empty-inline';
        empty.textContent = '这个文件夹里还没有会话';
        body.appendChild(empty);
      }
      for (const s of mine) body.appendChild(sessionNode(s, 1));
    }
    row.appendChild(body);
    box.appendChild(row);
  }

  // ---- 已归档 ----
  const archWrap = $('#wsArchived');
  const archList = $('#wsArchList');
  const archCount = $('#wsArchCount');
  if (!archWrap || !archList) return;
  archWrap.hidden = archived.length === 0;
  if (archCount) archCount.textContent = archived.length ? String(archived.length) : '';
  archList.innerHTML = '';
  for (const s of archived) archList.appendChild(sessionNode(s, 1, { archived: true }));
}

/** 会话行（工作区下面用的那种小行） */
function sessionNode(s, depth, opts = {}) {
  const el = document.createElement('div');
  el.className = 'ws-session' + (s.id === state.currentId ? ' active' : '');
  el.style.setProperty('--ws-depth', String(depth));
  el.dataset.session = s.id;
  el.title = s.cwd || '';
  const meta =
    timeAgo(s.updatedAt) +
    (s.blockCount ? ' · ' + s.blockCount + ' 条' : '') +
    (s.running ? ' <span class="live">· 运行中</span>' : '');
  el.innerHTML =
    '<div class="ws-session-main">' +
    '<div class="t">' + escapeHtml(s.title || '新会话') + '</div>' +
    '<div class="m">' + meta + '</div>' +
    '</div>' +
    '<div class="ws-session-acts">' +
    (opts.archived
      ? '<button title="取消归档" data-act="unarchive">恢复</button>'
      : '<button title="归档（不删除，收进「已归档」）" data-act="archive">归档</button>') +
    '<button title="删除会话" data-act="del" class="danger">删除</button>' +
    '</div>';
  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-act]')) return;
    switchSession(s.id);
  });
  el.querySelector('[data-act="archive"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setArchived(s, true);
  });
  el.querySelector('[data-act="unarchive"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    setArchived(s, false);
  });
  el.querySelector('[data-act="del"]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('删除会话「' + (s.title || '新会话') + '」？此操作不可恢复。')) return;
    try {
      await api('/sessions/delete', { body: { sessionId: s.id } });
      toast('会话已删除', 'ok');
      if (s.id === state.currentId) await newSession({ silent: true });
      await refreshSessions();
      await refreshWorkspaces();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
  return el;
}

/** 归档 / 取消归档（不删除；侧栏按这个标志分组） */
async function setArchived(s, archived) {
  try {
    const data = await api('/sessions/archive', { body: { sessionId: s.id, archived } });
    state.sessions = data.sessions || state.sessions;
    renderWorkspaces();
    toast(archived ? '已归档（没删除，可在「已归档」里找回）' : '已取消归档', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function toggleWorkspace(path) {
  const key = String(path || '').toLowerCase();
  if (state.wsOpen.has(key) || (state.wsCollapsed.has(key) === false && state.currentId && isCurrentWs(path))) {
    // 当前是展开的 → 折起来，并记住「这是我手动折的」
    state.wsOpen.delete(key);
    state.wsCollapsed.add(key);
  } else {
    state.wsOpen.add(key);
    state.wsCollapsed.delete(key);
  }
  saveWsOpen();
  saveWsCollapsed();
  renderWorkspaces();
}

/** 这个工作区里有没有当前会话（toggle 时判断「现在是展开还是折起」用） */
function isCurrentWs(path) {
  const key = String(path || '').toLowerCase();
  return (state.sessions || []).some(
    (s) => s.id === state.currentId && String(s.cwd || '').toLowerCase() === key,
  );
}

/** 工作区行的「更多」菜单：新建会话 / 在文件管理器打开 / 从列表移除 */
function openWorkspaceMenu(w, anchor) {
  const menu = document.createElement('div');
  menu.className = 'composer-menu ws-menu';
  const hasSessions = Number(w.sessionCount || 0) > 0;
  menu.innerHTML =
    '<button class="menu-row" data-act="new"><span class="menu-icon">＋</span><span class="menu-text">在这个文件夹新建会话</span></button>' +
    '<button class="menu-row" data-act="open"><span class="menu-icon">📂</span><span class="menu-text">在文件管理器里打开</span></button>' +
    '<button class="menu-row" data-act="remove"' +
    (hasSessions ? ' disabled' : '') +
    '><span class="menu-icon">－</span><span class="menu-text">从工作区列表移除' +
    (hasSessions ? '（还有 ' + w.sessionCount + ' 个会话）' : '') +
    '</span></button>';
  document.body.appendChild(menu);
  const rect = anchor.getBoundingClientRect();
  menu.style.left = Math.max(8, rect.left - 180) + 'px';
  menu.style.top = rect.bottom + 4 + 'px';

  const close = () => {
    menu.remove();
    document.removeEventListener('click', onDoc, true);
  };
  const onDoc = (e) => {
    if (!menu.contains(e.target)) close();
  };
  setTimeout(() => document.addEventListener('click', onDoc, true), 0);

  menu.querySelector('[data-act="new"]').addEventListener('click', async () => {
    close();
    await newSession({ silent: true, cwd: w.path });
  });
  menu.querySelector('[data-act="open"]').addEventListener('click', () => {
    close();
    if (window.myaDesktop && window.myaDesktop.openPath) window.myaDesktop.openPath(w.path);
    else toast('浏览器模式打不开文件管理器', 'warn');
  });
  menu.querySelector('[data-act="remove"]').addEventListener('click', async () => {
    if (hasSessions) return;
    close();
    try {
      const data = await api('/workspaces/remove', { body: { path: w.path } });
      state.workspaces = data.list || [];
      renderWorkspaces();
      toast('已从工作区列表移除（文件夹和文件都没动）', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/** 新建工作区：自己选一个文件夹（选完就出现在列表里，等着建会话） */
/**
 * 新建工作区：自己选一个文件夹。
 *
 * 复用应用自己的目录选择弹窗（pickWorkingDir），而不是直接喊原生选择框：
 * 那个弹窗里能翻目录、能新建文件夹、能校验路径能不能写，桌面模式下它还自带
 * 「用系统对话框选」按钮——两条路都在一个地方，用户学一次就够。
 * （之前这里用的是原生选择框 + prompt 兜底，浏览器模式下 prompt 既不能翻目录
 *   也没法新建文件夹，等于把「自己选地址」这件事做残了。）
 */
async function addWorkspace() {
  const picked = await pickWorkingDir();
  if (!picked) return; // 用户取消
  const dir = String(picked.cwd || '').trim();
  if (!dir) return;
  try {
    const data = await api('/workspaces', { body: { path: dir, create: !!picked.create } });
    state.workspaces = data.list || [];
    // 新建的工作区默认展开，好让用户马上看到「+ 新建会话」
    const key = String(data.path || dir).toLowerCase();
    state.wsOpen.add(key);
    state.wsCollapsed.delete(key);
    saveWsOpen();
    saveWsCollapsed();
    renderWorkspaces();
    toast(data.existed ? '这个文件夹已经在工作区列表里了' : '工作区已添加', 'ok');
    /**
     * 顺手在该文件夹里建一个会话并切过去。
     *
     * 为什么：新建工作区的动机就是「我要在这个文件夹里开始干活」——
     * 让用户再点一次它行上的 + 等于把一步拆成两步，而且建完后对话区
     * 还停在上一场对话，容易对着错的地方发消息。
     * 已存在的就不动（那只是把老文件夹加回列表）。
     */
    if (data.existed !== true) {
      await newSession({ silent: true, cwd: data.path || dir });
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** 取路径最后一段（工作区显示名） */
function basename(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

/* ------------------------------------------------------------------ */
/* 接入运营商：下拉选一个（或新建），弹窗填 API 信息                     */
/* ------------------------------------------------------------------ */

/**
 * 用户要的形态：**不要独立页**，就放在「模型与 API 接入」下面——
 * 一个下拉列出存过的接入运营商，选一下就切过去；选「新建接入」弹窗填地址/Key/模型。
 *
 * 为什么切换必须由服务端做：服务端才有明文 Key，而且它要走「保存设置」那条路
 * （写配置 + 重建 provider），否则会出现"界面显示新地址、请求还发到老地方"。
 */

const PROVIDER_LABELS = {
  deepseek: 'DeepSeek 官方',
  openai: 'OpenAI 官方',
  ollama: '本地 Ollama',
  custom: '自定义 / 中转站',
};

const AP_NEW = '__new__';
const AP_CAPTURE = '__capture__';

/** 拉存档并刷新下拉 */
async function refreshApiProfiles() {
  try {
    const data = await api('/api-profiles');
    state.apiProfiles = data.list || [];
    state.apiActiveId = data.activeId || '';
    renderAccessSelect();
  } catch (err) {
    toast(`读取接入列表失败：${err.message}`, 'err');
  }
}

function renderAccessSelect() {
  const sel = $('#apSelect');
  if (!sel) return;
  const list = state.apiProfiles || [];
  const keep = sel.dataset.pending || '';
  sel.innerHTML = '';

  if (!list.length) {
    const o = document.createElement('option');
    o.value = AP_NEW;
    o.textContent = '还没有存过的接入 —— 点这里新建一个';
    sel.appendChild(o);
  } else {
    for (const p of list) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent =
        `${p.name}${p.active ? '（使用中）' : ''} · ${PROVIDER_LABELS[p.provider] || p.provider} · ${p.model || '未指定模型'}` +
        (p.hasKey ? ` · Key ${p.keyMasked}` : '');
      sel.appendChild(o);
    }
  }
  // 末尾永远留两个动作项：新建 / 把当前配置存下来
  for (const [val, label] of [[AP_NEW, '＋ 新建接入…'], [AP_CAPTURE, '＋ 把当前配置存为一条']]) {
    const o = document.createElement('option');
    o.value = val;
    o.textContent = label;
    sel.appendChild(o);
  }

  // 默认选到"正在用的那条"（没有就停在新建上）
  const active = list.find((p) => p.active);
  sel.value = keep || (active ? active.id : list.length ? list[0].id : AP_NEW);

  const status = $('#apStatus');
  if (status) {
    const cur = list.find((p) => p.active);
    status.textContent = cur
      ? `当前使用：${cur.name}（${PROVIDER_LABELS[cur.provider] || cur.provider} · ${cur.model || '未指定模型'}）`
      : list.length
        ? '当前配置不在存档里 —— 想留住它就选「＋ 把当前配置存为一条」。'
        : '还没有存档。新建一条之后，换环境只要在这里选一下。';
  }
}

/** 下拉选择：选存档 = 立刻切换；选两个动作项 = 弹窗 / 存当前 */
async function onAccessSelectChange() {
  const sel = $('#apSelect');
  if (!sel) return;
  const val = sel.value;
  if (val === AP_NEW) return openAccessModal(null);
  if (val === AP_CAPTURE) return captureApiProfile();
  const p = (state.apiProfiles || []).find((x) => x.id === val);
  if (!p) return;
  if (p.active) return;          // 已经是当前这条，不必再切（避免多余的写配置）
  return activateApiProfile(p);
}

/** 一键切换：交给服务端 */
async function activateApiProfile(p) {
  try {
    const data = await api('/api-profiles/activate', { body: { id: p.id } });
    state.apiActiveId = p.id;
    toast(`已切到「${p.name}」${data && data.warning ? `（${data.warning}）` : ''}`, data && data.warning ? 'warn' : 'ok');
    await refreshApiProfiles();
    await loadSettings();          // 「模型与 API 接入」那几栏显示的当前值要跟着变
  } catch (err) {
    toast(err.message, 'err');
    await refreshApiProfiles();    // 失败要把下拉拨回真实状态
  }
}

/** 把当前生效的配置存成一条（用户的第一条通常这么来） */
async function captureApiProfile() {
  const name = prompt('给这条接入起个名字（以后在下拉里认它）：', (state.info && state.info.model) || '当前配置');
  if (name === null) return;
  try {
    const data = await api('/api-profiles/capture', { body: { name: name.trim() || `当前配置（${(state.info && state.info.model) || ''}）` } });
    state.apiProfiles = data.list || [];
    renderAccessSelect();
    toast('已把当前配置存成一条', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** 打开弹窗：p 为空 = 新建；否则编辑那一条 */
function openAccessModal(p) {
  const back = $('#accessBackdrop');
  if (!back) return;
  back.hidden = false;
  $('#accessTitle').textContent = p ? `编辑「${p.name}」` : '新建接入';
  $('#apName').value = p ? p.name || '' : '';
  $('#apProvider').value = (p && p.provider) || (state.info && state.info.provider) || 'custom';
  $('#apBaseUrl').value = (p && p.baseUrl) || (state.info && state.info.baseUrl) || '';
  $('#apModel').value = (p && p.model) || (state.info && state.info.model) || '';
  $('#apFormat').value = (p && p.apiFormat) || (state.info && state.info.apiFormat) || 'auto';
  $('#apKey').value = '';   // 密码框永远留空：留空 = 不改动已存的 Key
  $('#apKey').placeholder = p && p.hasKey
    ? `已存 Key（${p.keyMasked}），留空即不改动`
    : '本地 Ollama 可以空着';
  const n = $('#apNotice');
  if (n) n.hidden = true;
  $('#apSelect').dataset.pending = p ? p.id : AP_NEW;
  $('#apName').focus();
}

function closeAccessModal() {
  const back = $('#accessBackdrop');
  if (back) back.hidden = true;
  const sel = $('#apSelect');
  if (sel) delete sel.dataset.pending;
  renderAccessSelect();
}

/** 保存（新建或编辑）→ 立刻切换过去 */
async function saveAccessModal() {
  const sel = $('#apSelect');
  const editing = sel && sel.dataset.pending && sel.dataset.pending !== AP_NEW ? sel.dataset.pending : '';
  const bodyIn = {
    id: editing,
    name: $('#apName').value.trim(),
    provider: $('#apProvider').value,
    baseUrl: $('#apBaseUrl').value.trim(),
    model: $('#apModel').value.trim(),
    apiFormat: $('#apFormat').value,
    apiKey: $('#apKey').value.trim(),   // 空 = 保留原 Key（服务端保证）
  };
  const n = $('#apNotice');
  if (!bodyIn.name) {
    if (n) { n.hidden = false; n.className = 'notice err'; n.textContent = '给这条接入起个名字吧，以后好认。'; }
    return;
  }
  try {
    const data = await api('/api-profiles', { body: bodyIn });
    state.apiProfiles = data.list || [];
    const saved = data.profile;
    closeAccessModal();
    // 存完直接切过去——用户点「新建接入」的意图就是"我要用它"
    await activateApiProfile(saved);
    toast(data.created ? `已新建接入「${saved.name}」` : `已保存「${saved.name}」`, 'ok');
  } catch (err) {
    if (n) { n.hidden = false; n.className = 'notice err'; n.textContent = err.message; }
    else toast(err.message, 'err');
  }
}

async function removeSelectedAccess() {
  const sel = $('#apSelect');
  const id = sel && sel.value;
  const p = (state.apiProfiles || []).find((x) => x.id === id);
  if (!p) { toast('先在下拉里选一条要删的接入', 'warn'); return; }
  if (!confirm(`删除接入「${p.name}」？（不会动你正在用的配置）`)) return;
  try {
    const data = await api('/api-profiles/remove', { body: { id: p.id } });
    state.apiProfiles = data.list || [];
    state.apiActiveId = data.activeId || '';
    renderAccessSelect();
    toast('已删除', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

function bindApiLibrary() {
  const on = (sel, ev, fn) => { const el = $(sel); if (el) el.addEventListener(ev, fn); };
  on('#apSelect', 'change', onAccessSelectChange);
  on('#apEdit', 'click', () => {
    const id = $('#apSelect') && $('#apSelect').value;
    const p = (state.apiProfiles || []).find((x) => x.id === id);
    openAccessModal(p || null);
  });
  on('#apDel', 'click', removeSelectedAccess);
  on('#apSave', 'click', saveAccessModal);
  on('#apCancel', 'click', closeAccessModal);
  on('#accessBackdrop', 'click', (e) => { if (e.target && e.target.id === 'accessBackdrop') closeAccessModal(); });
}



/**
 * 侧栏的插件列表。
 *
 * 不从设置浮层那份 DOM 抄：设置里的列表要等浮层打开时节点才存在，
 * 这里独立拉一份数据（同一条 /api 接口），各渲染各的。
 * 点击行为也刻意克制——只跳进设置，不在侧栏里开/关插件：
 * 开关插件是低频而且应该先看代码的动作，塞进侧栏会让人随手就点。
 */
async function loadSidebarPlugins() {
  const box = $('#sidebarPlugins');
  const aux = $('#pluginAux');
  if (!box) return;
  try {
    const data = await api('/plugins');
    const plugins = data.plugins || [];
    const enabled = plugins.filter((p) => p.enabled).length;
    if (aux) aux.textContent = plugins.length ? `${enabled}/${plugins.length}` : '';
    if (!plugins.length) {
      box.innerHTML = `<button class="plugin-row"><span class="plugin-name">还没装插件，去市场看看</span></button>`;
      // 用 children 拿（这个按钮是动态生成的，不在 index.html 里）
      const hint = box.firstElementChild;
      if (hint) hint.addEventListener('click', () => openSettings('market'));
      return;
    }
    box.innerHTML = plugins
      .map(
        (p) =>
          `<button class="plugin-row${p.enabled ? '' : ' off'}" data-plugin="${escapeHtml(p.name)}"` +
          ` title="${p.enabled ? '已启用' : '未启用'} · ${((p.tools || []) || []).length} 个工具 / ${((p.commands || []) || []).length} 条命令——点开看详情">` +
          `<span class="dot ${p.enabled ? 'ok' : ''}"></span>` +
          `<span class="plugin-name">${escapeHtml(p.name)}</span>` +
          `<span class="plugin-meta">${(p.tools || []).length} 工具</span>` +
          `</button>`,
      )
      .join('');
    if (data.failed) {
      const note = document.createElement('div');
      note.className = 'ws-note';
      note.textContent = `${data.failed} 个插件加载失败（设置里看原因）`;
      box.appendChild(note);
    }
    $$('.plugin-row[data-plugin]', box).forEach((row) => {
      row.addEventListener('click', () => openSettings('plugins'));
    });
  } catch (err) {
    box.innerHTML = `<div class="ws-note">读不到插件列表：${escapeHtml(err.message)}</div>`;
  }
}

/** 侧栏三个分区（工作区/会话/插件）的折叠状态，记住用户上次的选择 */
const SIDEBAR_FOLD_KEY = 'mya.sidebarFold';

function bindSidebarSections() {
  const saved = (() => {
    try {
      return JSON.parse(localStorage.getItem(SIDEBAR_FOLD_KEY) || '{}');
    } catch {
      return {};
    }
  })();
  for (const [toggleId, sectionId, key, defaultsOpen] of [
    ['#wsToggle', '#wsSection', 'ws', true],
    ['#sessionToggle', '#sessionSection', 'sessions', true],
    ['#pluginToggle', '#pluginSection', 'plugins', false],
  ]) {
    const section = $(sectionId);
    const toggle = $(toggleId);
    if (!section || !toggle) continue;
    const open = saved[key] === undefined ? defaultsOpen : !!saved[key];
    section.classList.toggle('closed', !open);
    toggle.addEventListener('click', () => {
      const nowClosed = section.classList.toggle('closed');
      if (sectionId === '#pluginSection' && !nowClosed) loadSidebarPlugins();
      try {
        const next = { ...saved };
        next[key] = !nowClosed;
        localStorage.setItem(SIDEBAR_FOLD_KEY, JSON.stringify(next));
      } catch {
        /* 存不上就算了 */
      }
    });
  }
}

async function switchSession(id) {
  if (id === state.currentId) {
    closeSidebar();
    return;
  }
  state.currentId = id;
  localStorage.setItem('mya.session', id);
  clearMessages();
  closeSidebar();
  closeModelPop();

  try {
    const data = await api(`/history?id=${encodeURIComponent(id)}`);
    state.usage = data.usage || null;
    state.context = data.context || (data.session && data.session.context) || null;
    renderUsage();
    renderContext();
    if (!data.blocks.length) {
      messagesEl().innerHTML = emptyStateHtml();
      bindEmptyChips();
    } else {
      for (const b of data.blocks) renderBlock(b);
      // 恢复时默认把工具卡片折叠，界面清爽
      scrollToBottom(true);
    }
    $('#brandSub').textContent = shortPath(data.session.cwd, 40);
    setTopTitle(data.session.title || '新会话');
    setRunning(!!data.session.running);
  } catch (err) {
    toast(err.message, 'err');
  }
  renderSessions();
}

async function newSession(opts = {}) {
  // 新建会话要先问清工作目录（用户明确要求）。
  // silent: 启动时自动建会话、以及删掉当前会话后的兜底，都不该弹窗打断。
  let cwd = '';
  let createDir = false;
  if (!opts.silent) {
    const picked = await pickWorkingDir();
    if (!picked) return; // 用户取消
    cwd = picked.cwd;
    createDir = !!picked.create;
  }

  try {
    const data = await api('/sessions', { body: { cwd, createDir } });
    state.currentId = data.session.id;
    localStorage.setItem('mya.session', state.currentId);
    if (data.session.cwd) rememberDir(data.session.cwd);
    clearMessages();
    messagesEl().innerHTML = emptyStateHtml();
    bindEmptyChips();
    state.usage = null;
    renderUsage();
    setRunning(false);
    $('#brandSub').textContent = shortPath(data.session.cwd, 44);
    setTopTitle(data.session.title || '新会话');
    renderWorkspaces();
    await refreshSessions();
    $('#input').focus();
  } catch (err) {
    if (err.needsSetup) {
      guideToSetup(err.message);
      return;
    }
    toast(`创建会话失败：${err.message}`, 'err');
  }
}

/* ------------------------------------------------------------------ */
/* 工作目录选择                                                        */
/* ------------------------------------------------------------------ */

const RECENT_DIRS_KEY = 'mya.recentDirs';

function readRecentDirs() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_DIRS_KEY) || '[]');
    return Array.isArray(list) ? list.filter((d) => typeof d === 'string' && d) : [];
  } catch {
    return [];
  }
}

function rememberDir(dir) {
  if (!dir) return;
  const list = [dir, ...readRecentDirs().filter((d) => d !== dir)].slice(0, 6);
  try {
    localStorage.setItem(RECENT_DIRS_KEY, JSON.stringify(list));
  } catch {
    /* 存不下不影响本次会话 */
  }
}

/**
 * 弹出「选工作目录」对话框。
 *
 * @returns {Promise<{cwd:string, create?:boolean}|null>} null = 用户取消
 */
function pickWorkingDir() {
  return new Promise((resolve) => {
    const backdrop = $('#dirBackdrop');
    const input = $('#dirInput');
    const errBox = $('#dirError');
    const choices = $('#dirChoices');
    if (!backdrop || !input) {
      resolve({ cwd: '' }); // 界面结构不对时不要卡住新建流程
      return;
    }

    // 桌面程序能用原生目录选择框（能直接翻盘符，比手打路径舒服得多）
    const hasNative = !!(window.myaDesktop && window.myaDesktop.chooseDirectory);
    $('#btnDirBrowse').hidden = !hasNative;

    // 默认值：上次用过的目录 > 程序启动目录
    const fallback = readRecentDirs()[0] || (state.info && state.info.cwd) || '';
    let current = '';
    let lastOk = false;

    const finish = (value) => {
      backdrop.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        finish(null);
      }
    };

    /** 查一遍目录，把结果显示出来 */
    const check = async (path) => {
      let data;
      try {
        data = await api('/fs/check-dir', { body: { path } });
      } catch (err) {
        errBox.hidden = false;
        errBox.textContent = err.message;
        return;
      }
      current = data.path || '';
      lastOk = !!data.ok;
      choices.innerHTML = '';
      $('#btnDirCreate').hidden = true;
      // 目录不合法时把「新建」按灰：不然后面创建会话会以 400 收场，
      // 错误提示还出现在对话里，看起来像 agent 出了问题
      $('#btnDirConfirm').disabled = !lastOk;

      if (data.ok) {
        errBox.hidden = true;
      } else {
        errBox.hidden = false;
        errBox.textContent = data.error || '这个目录不能用';
        if (data.missing) {
          $('#btnDirCreate').hidden = false;
        }
      }

      // 子目录列表：点一下就进去（浏览器模式下这就是「浏览」）
      const dirs = data.dirs || [];
      if (dirs.length) {
        const label = document.createElement('div');
        label.className = 'dir-list-label';
        label.textContent = data.ok ? '这个目录下的子目录（点一下进去）' : `父目录 ${data.parent} 下的子目录`;
        choices.appendChild(label);
        for (const name of dirs.slice(0, 60)) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'dir-chip';
          btn.textContent = name;
          btn.addEventListener('click', () => {
            const base = data.ok ? data.path : data.parent || '';
            const next = `${base}${base.endsWith('/') || base.endsWith('\\') ? '' : sep(base)}${name}`;
            input.value = next;
            check(next);
          });
          choices.appendChild(btn);
        }
      }
    };

    // 渲染「最近用过」
    const recent = readRecentDirs();
    const recentBox = $('#dirRecent');
    recentBox.innerHTML = '';
    if (recent.length) {
      const label = document.createElement('div');
      label.className = 'dir-list-label';
      label.textContent = '最近用过';
      recentBox.appendChild(label);
      for (const dir of recent) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dir-chip';
        btn.title = dir;
        btn.textContent = shortPath(dir, 34);
        btn.addEventListener('click', () => {
          input.value = dir;
          check(dir);
        });
        recentBox.appendChild(btn);
      }
    }

    $('#btnDirCancel').onclick = () => finish(null);
    backdrop.onclick = (e) => {
      if (e.target === backdrop) finish(null);
    };
    $('#btnDirUp').onclick = () => {
      const parent = parentDir(current || input.value.trim());
      if (!parent) return;
      input.value = parent;
      check(parent);
    };
    input.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (lastOk && current) finish({ cwd: current });
        else check(input.value.trim());
      }
    };
    input.onchange = () => check(input.value.trim());
    $('#btnDirCreate').onclick = () => finish({ cwd: current || input.value.trim(), create: true });
    $('#btnDirConfirm').onclick = () => finish({ cwd: current || input.value.trim() });

    if (hasNative) {
      $('#btnDirBrowse').onclick = async () => {
        const res = await window.myaDesktop.chooseDirectory(input.value.trim() || fallback);
        if (res && res.ok && res.path) {
          input.value = res.path;
          check(res.path);
        }
      };
    }

    backdrop.hidden = false;
    input.value = fallback;
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => input.focus(), 30);
    check(fallback);
  });
}

/** 路径分隔符：跟着当前系统走（Windows 上用 \，看起来才像本机路径） */
function sep(base) {
  return /\\/.test(base) || /^[a-zA-Z]:$/.test(base) ? '\\' : '/';
}

function parentDir(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  if (!s) return '';
  const idx = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (idx < 0) return '';
  const head = s.slice(0, idx);
  if (/^[a-zA-Z]:$/.test(head)) return `${head}\\`;
  return head || '/';
}

function emptyStateHtml() {
  return `
    <div class="empty">
      <div class="empty-mark">梦</div>
      <h1>说点什么，我来动手</h1>
      <p>我能读写文件、搜索代码、执行命令。你想加的能力，可以装插件。</p>
      <div class="chips">
        <button class="chip" data-prompt="看看这个项目是做什么的，用几句话总结">了解这个项目</button>
        <button class="chip" data-prompt="检查一下代码里有没有明显的 bug 或安全隐患">检查代码问题</button>
        <button class="chip" data-prompt="跑一下测试，看看当前是否全部通过">跑测试</button>
        <button class="chip" data-prompt="告诉我当前项目的目录结构和主要模块">看目录结构</button>
      </div>
    </div>`;
}

function bindEmptyChips() {
  $$('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $('#input').value = chip.dataset.prompt;
      autoGrow();
      sendMessage();
    });
  });
}

/* ------------------------------------------------------------------ */
/* 发送消息                                                            */
/* ------------------------------------------------------------------ */

async function sendMessage() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  if (state.running && !state.currentId) return;

  // 要开始打字了，别让模型浮层挡着对话
  closeModelPop();

  // 如果只有空状态，先清掉
  if ($('.empty')) messagesEl().innerHTML = '';

  input.value = '';
  autoGrow();

  /**
   * 乐观渲染用户消息（不等后端事件，输入感觉更跟手）。
   *
   * 关键：把渲染出来的节点记到 state.pendingUser 上。服务端随后会把同一条消息
   * 作为 block 广播回来，那时要"认领"这个节点（补上真实 seq），而不是再渲染一遍——
   * 否则就会出现「我发一句话，对话里显示两遍」（用户报的就是这个）。
   * 客户端猜的 seq 与服务端分配的不一定相同，所以必须按"文本 + 待认领"来配对，
   * 光靠 seq 去重解决不了。
   */
  const el = renderBlock({ seq: state.lastSeq + 1, type: 'user', text });
  const pending = { text, el };
  state.pendingUser.push(pending);

  try {
    await api('/message', { body: { sessionId: state.currentId, text } });
    setRunning(true);
  } catch (err) {
    // 这条没发出去：把它从待认领队列里摘掉
    const idx = state.pendingUser.indexOf(pending);
    if (idx !== -1) state.pendingUser.splice(idx, 1);
    if (err.needsSetup) {
      // 还没配模型：把刚才那句话还给用户，配好之后不用重打。
      // 同时撤掉那条乐观渲染的气泡——它其实没发出去，留着会误导。
      el.remove();
      input.value = text;
      autoGrow();
      guideToSetup(err.message);
      return;
    }
    toast(err.message, 'err');
    renderBlock({ seq: state.lastSeq + 1, type: 'error', text: err.message });
  }
}

async function abortRun() {
  try {
    await api('/abort', { body: { sessionId: state.currentId } });
    toast('已请求中断', 'warn');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------------ */
/* 确认弹窗                                                            */
/* ------------------------------------------------------------------ */

function showApproval(approval) {
  // 只显示当前会话的
  if (approval.sessionId && approval.sessionId !== state.currentId) return;
  state.pendingApproval = approval;

  const question = String(approval.question || '');
  // 问句里第一行是「允许执行 X 吗？」，剩下的是具体内容
  const lines = question.split('\n');
  $('#approvalTitle').textContent = lines[0] || '模型想要执行一个操作';
  $('#approvalDetail').textContent = lines.slice(1).join('\n').trim() || '（无详细参数）';

  // 改动预览：有就摊开（这正是用户要判断的东西），没有就整块藏起来
  const wrap = $('#approvalDiffWrap');
  const box = $('#approvalDiff');
  if (wrap && box) {
    const detail = String(approval.detail || '');
    wrap.hidden = !detail;
    box.innerHTML = detail ? diffHtml(detail) : '';
    if (detail) wrap.dataset.detail = detail; // 允许/拒绝时随卡片一起记进对话
  }

  $('#approvalBackdrop').hidden = false;
  renderBlock({ seq: state.lastSeq + 1, type: 'approval_pending', ts: Date.now() });
}

/**
 * 把 diff 文本渲染成带颜色的行。
 *
 * 为什么按行 createElement 而不是 innerHTML 拼字符串：diff 里是**文件内容**，
 * 也就是不可信文本（模型刚写的东西 / 你磁盘上的东西），拼 HTML 就等于开一个 XSS 口子。
 * 这里每行都用 textContent 赋值，标签是我们自己建的，注入无从谈起。
 */
function diffHtml(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const cls = line.startsWith('+ ') ? 'diff-add' : line.startsWith('- ') ? 'diff-del' : /^ {2}…/.test(line) ? 'diff-skip' : 'diff-ctx';
    out.push(`<span class="diff-line ${cls}">${escapeHtml(line)}</span>`);
  }
  return out.join('');
}

function hideApproval() {
  $('#approvalBackdrop').hidden = true;
  state.pendingApproval = null;
  $$('.block.approval-card').forEach((el) => {
    if (el.textContent.includes('等待你确认')) el.remove();
  });
}

async function answerApproval(approved) {
  const pending = state.pendingApproval;
  if (!pending) return;
  hideApproval();
  try {
    await api('/approve', { body: { id: pending.id, approved } });
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------------ */
/* 插件面板                                                            */
/* ------------------------------------------------------------------ */

async function loadPlugins() {
  const list = $('#pluginList');
  const summary = $('#pluginSummary');
  // 插件列表现在住在设置浮层里，浮层没打开时这些节点不在页面上。
  // 事件处理器仍然可能调到这里（比如服务端推来 plugins_changed），
  // 所以要先确认节点存在，免得把控制台刷成 TypeError。
  if (!list || !summary) return;
  try {
    const data = await api('/plugins');
    const plugins = data.plugins || [];
    const on = plugins.filter((p) => p.enabled).length;
    summary.textContent = `${plugins.length} 个插件，${on} 个已启用 · ${data.dirs.map((d) => shortPath(d, 30)).join(' / ')}`;

    if (!plugins.length) {
      list.innerHTML = `<div class="placeholder"><p>还没有插件。</p><p class="muted">去「插件市场」装一个，或者用下面的表单生成一个自己的插件骨架。</p></div>`;
      return;
    }

    list.innerHTML = '';
    for (const p of plugins) list.appendChild(pluginCard(p));
  } catch (err) {
    list.innerHTML = `<div class="notice err">${escapeHtml(err.message)}</div>`;
  }
}

function pluginCard(p) {
  const el = document.createElement('div');
  const cls = ['card'];
  if (!p.enabled) cls.push('off');
  if (p.broken) cls.push('bad');
  el.className = cls.join(' ');

  const badges = [];
  badges.push(p.enabled ? '<span class="badge on">已启用</span>' : '<span class="badge off">已禁用</span>');
  if (p.source) badges.push('<span class="badge purple">来自 GitHub</span>');
  if (p.broken) badges.push('<span class="badge danger">加载失败</span>');
  if (p.permissions && p.permissions.includes('shell:exec')) badges.push('<span class="badge warn">可执行命令</span>');
  else if (p.permissions && p.permissions.includes('fs:write')) badges.push('<span class="badge warn">可写文件</span>');

  const tools = (p.toolDetails || [])
    .map((t) => `<span class="tool-pill" title="${escapeHtml(t.description)}${t.dangerous ? '（危险工具，执行前会问你）' : ''}">${escapeHtml(t.name)}${t.dangerous ? ' ⚠' : ''}</span>`)
    .join('');

  const cmds = (p.commands || []).map((c) => `<span class="tool-pill">/${escapeHtml(c)}</span>`).join('');

  el.innerHTML = `
    <div class="card-head">
      <div class="card-title">
        <strong>${escapeHtml(p.name)} ${p.version ? `<span class="muted">v${escapeHtml(p.version)}</span>` : ''}</strong>
        <div class="desc">${escapeHtml(p.description || (p.broken ? '' : '（无描述）'))}</div>
      </div>
      <div>${badges.join(' ')}</div>
    </div>
    ${p.broken ? `<div class="warn-line high">加载失败：${escapeHtml(p.broken)}</div>` : ''}
    ${tools || cmds ? `<div class="meta-row">${tools}${cmds}</div>` : ''}
    ${p.source ? `<div class="meta-line">来源：<b>${escapeHtml(p.source.repo)}</b>${p.source.ref && p.source.ref !== 'HEAD' ? ` @ ${escapeHtml(p.source.ref)}` : ''}</div>` : ''}
    <div class="meta-line muted" style="font-family:var(--mono);font-size:10.5px">${escapeHtml(shortPath(p.dir, 60))}</div>
    <div class="card-actions"></div>
  `;

  const actions = el.querySelector('.card-actions');
  if (p.enabled) {
    actions.appendChild(button('禁用', 'small', () => pluginAction('/plugins/disable', p.name, '已禁用')));
  } else if (!p.broken) {
    actions.appendChild(button('启用', 'small primary', () => pluginAction('/plugins/enable', p.name, '已启用')));
  }
  actions.appendChild(button('卸载', 'small danger', () => uninstallPlugin(p)));
  return el;
}

function button(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = `btn ${cls || ''}`;
  b.textContent = label;
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await onClick();
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

async function pluginAction(path, name, okText) {
  try {
    const data = await api(path, { body: { name } });
    toast(`${name} ${okText}`, 'ok');
    if (data.reload && data.reload.errors && data.reload.errors.length) {
      for (const e of data.reload.errors) toast(`${e.plugin}: ${e.error}`, 'err');
    }
    await loadPlugins();
    await loadTools();
    await refreshInfo();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function uninstallPlugin(p) {
  const fromGithub = !!p.source;
  const msg = fromGithub
    ? `卸载「${p.name}」？\n\n它来自 ${p.source.repo}。\n插件目录会被移到 .mya/uninstalled/ 备份，不会直接删掉。`
    : `卸载「${p.name}」？\n\n这个插件不是从市场装的（可能是你自己写的），目录会被移到 .mya/uninstalled/ 备份。`;
  if (!confirm(msg)) return;
  try {
    const data = await api('/plugins/uninstall', { body: { name: p.name } });
    toast(`已卸载，备份在 ${shortPath(data.removedTo, 40)}`, 'ok');
    await loadPlugins();
    await loadTools();
    await refreshInfo();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ------------------------------------------------------------------ */
/* 工具面板                                                            */
/* ------------------------------------------------------------------ */

async function loadTools() {
  const list = $('#toolList');
  const summary = $('#toolSummary');
  // 同 loadPlugins：工具清单也在设置浮层里，浮层没开就没这些节点
  if (!list || !summary) return;
  try {
    const data = await api('/tools');
    const tools = data.tools || [];
    const builtin = tools.filter((t) => t.source === 'builtin').length;
    summary.textContent = `${tools.length} 个（内置 ${builtin} 个，插件 ${tools.length - builtin} 个） · ${data.hooks} 个钩子监听`;

    list.innerHTML = '';
    for (const t of tools) {
      const el = document.createElement('div');
      el.className = 'card';
      const isPlugin = t.source.startsWith('plugin:');
      el.innerHTML = `
        <div class="card-head">
          <div class="card-title">
            <strong style="font-family:var(--mono);font-size:12.5px">${escapeHtml(t.name)}</strong>
            <div class="desc">${escapeHtml(t.description.split('\n')[0])}</div>
          </div>
          <div style="display:flex;gap:4px;flex-direction:column;align-items:flex-end">
            <span class="badge ${isPlugin ? 'purple' : ''}">${isPlugin ? escapeHtml(t.source.replace('plugin:', '')) : '内置'}</span>
            ${t.dangerous ? '<span class="badge warn">需确认</span>' : '<span class="badge on">免确认</span>'}
          </div>
        </div>`;
      list.appendChild(el);
    }

    if (data.skipped && data.skipped.length) {
      const el = document.createElement('div');
      el.className = 'card bad';
      el.innerHTML = `<strong>未注册的工具</strong>${data.skipped
        .map((s) => `<div class="meta-line">${escapeHtml(s.name)} — ${escapeHtml(s.reason)}</div>`)
        .join('')}`;
      list.appendChild(el);
    }
  } catch (err) {
    list.innerHTML = `<div class="notice err">${escapeHtml(err.message)}</div>`;
  }
}

/* ------------------------------------------------------------------ */
/* 插件市场                                                            */
/* ------------------------------------------------------------------ */

async function marketSearch(query) {
  const list = $('#marketList');
  const notice = $('#marketNotice');
  const btn = $('#btnMarketSearch');
  const q = String(query ?? $('#marketQuery').value).trim();
  if (!q) {
    toast('请输入关键词或仓库地址', 'warn');
    return;
  }

  btn.disabled = true;
  btn.textContent = '搜索中';
  list.innerHTML = '<div class="skeleton">正在问 GitHub…</div>';
  notice.hidden = true;

  try {
    const data = await api('/market/search', { body: { query: q, limit: 20 } });

    // 配额快用完时优先提醒
    if (data.rate && data.rate.remaining !== undefined && data.rate.remaining <= 3) {
      notice.hidden = false;
      notice.className = 'notice err';
      notice.textContent = `GitHub 配额快用完了（剩 ${data.rate.remaining} 次）。在「设置」里填一个 Token 可以把配额从 60 次/小时提到 5000 次/小时。`;
    } else if (data.note) {
      // 结果都不太相关时用黄色提醒，让用户知道该换个搜法
      notice.hidden = false;
      notice.className = `notice ${data.items.length && data.strong === 0 ? 'warn' : ''}`;
      notice.textContent = data.note;
    } else {
      notice.hidden = true;
    }

    if (!data.items.length) {
      list.innerHTML = `<div class="placeholder">
        <p>没搜到符合条件的仓库。</p>
        <p class="muted">换个关键词试试；或者如果你知道仓库地址，直接粘到上面的输入框里安装。也可以搜 <b>topic:mya-plugin</b>。</p>
      </div>`;
      return;
    }

    list.innerHTML = '';
    for (const repo of data.items) list.appendChild(repoCard(repo));
  } catch (err) {
    list.innerHTML = `<div class="placeholder"><p style="color:var(--red)">${escapeHtml(err.message)}</p></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '搜索';
  }
}

function repoCard(repo) {
  const el = document.createElement('div');
  el.className = 'card repo-card';
  const [owner, name] = repo.fullName.split('/');

  // 相关性提示：让用户一眼看出「这是专门为本项目写的」还是「只是名字里带了几个字母」
  let relevance = '';
  if (repo.hasMarker) {
    relevance = '<span class="badge acc">本项目的插件</span>';
  } else if (repo.relevance === 'exact') {
    relevance = '<span class="badge acc">精确匹配</span>';
  } else if (repo.relevance === 'weak') {
    relevance = '<span class="badge warn" title="名字里恰好带了关键词，但可能不是本项目的插件">可能不相关</span>';
  }

  el.innerHTML = `
    <div class="repo-head">
      <div class="repo-name"><b>${escapeHtml(owner)}</b>/${escapeHtml(name)}</div>
      <span class="stars">★ ${repo.stars}</span>
    </div>
    <div class="repo-desc">${escapeHtml(repo.description || '（无描述）')}</div>
    <div class="repo-meta">
      ${relevance}
      ${repo.language ? `<span>${escapeHtml(repo.language)}</span>` : ''}
      ${repo.updatedAt ? `<span>更新于 ${escapeHtml(repo.updatedAt.slice(0, 10))}</span>` : ''}
      ${repo.license ? `<span>${escapeHtml(repo.license)}</span>` : ''}
      ${repo.archived ? '<span class="badge warn">已归档</span>' : ''}
      ${(repo.topics || []).slice(0, 3).map((t) => `<span class="badge">${escapeHtml(t)}</span>`).join('')}
    </div>
    <div class="card-actions">
      <button class="btn small" data-act="inspect">查看内容</button>
      <button class="btn small primary" data-act="install">安装</button>
    </div>`;

  el.querySelector('[data-act="inspect"]').addEventListener('click', (e) => {
    e.stopPropagation();
    inspectRepo(repo, el);
  });
  el.querySelector('[data-act="install"]').addEventListener('click', (e) => {
    e.stopPropagation();
    inspectRepo(repo, el, true);
  });
  return el;
}

/** 查看仓库内容：列出可安装的插件、文件清单、代码扫描结果 */
async function inspectRepo(repo, hostEl, autoInstall = false) {
  const [owner, name] = repo.fullName.split('/');
  hostEl.querySelectorAll('.inspect-area').forEach((n) => n.remove());
  const area = document.createElement('div');
  area.className = 'inspect-area';
  area.innerHTML = '<div class="skeleton">正在读取仓库内容…</div>';
  hostEl.appendChild(area);

  try {
    const data = await api('/market/inspect', { body: { owner, name } });

    if (!data.candidates.length) {
      area.innerHTML = `<div class="warn-line">这个仓库里没找到插件结构（需要 manifest.json，或根目录有 index.js）。</div>`;
      return;
    }

    area.innerHTML = '';
    const cand = data.candidates[0];
    if (data.candidates.length > 1) {
      const note = document.createElement('div');
      note.className = 'meta-line';
      note.textContent = `这个仓库里发现 ${data.candidates.length} 个插件，默认选第一个。`;
      area.appendChild(note);
    }

    const plan = document.createElement('div');
    plan.className = 'install-plan';
    plan.innerHTML = `
      将安装插件：<b>${escapeHtml(cand.label)}</b><br>
      来源：${escapeHtml(repo.fullName)} @ ${escapeHtml(data.repo.branch || 'default')}<br>
      文件：${cand.fileCount} 个，共 ${humanSize(cand.totalBytes)}
      ${cand.entryFile ? `<br>入口：<code>${escapeHtml(cand.entryFile.split('/').pop())}</code>` : ''}
    `;
    area.appendChild(plan);

    // 文件清单
    const fileList = document.createElement('div');
    fileList.className = 'file-list';
    for (const f of cand.files.slice(0, 30)) {
      const row = document.createElement('div');
      row.className = `file-row${f.path === cand.entryFile ? ' entry' : ''}`;
      row.innerHTML = `<span class="p">${escapeHtml(f.path)}</span><span class="s">${humanSize(f.size)}</span>`;
      fileList.appendChild(row);
    }
    if (cand.files.length > 30) {
      const row = document.createElement('div');
      row.className = 'file-row';
      row.innerHTML = `<span class="p muted">…还有 ${cand.files.length - 30} 个文件</span>`;
      fileList.appendChild(row);
    }
    area.appendChild(fileList);

    // 代码扫描结果
    if (cand.warnings && cand.warnings.length) {
      for (const w of cand.warnings.slice(0, 8)) {
        const line = document.createElement('div');
        line.className = `warn-line${w.level === 'high' ? ' high' : ''}`;
        line.innerHTML = `<span>⚠</span><span>${escapeHtml(w.what)}${w.file ? ` — <code>${escapeHtml(w.file.split('/').pop())}:${w.line}</code>` : ''}<br><code>${escapeHtml(w.code || '')}</code></span>`;
        area.appendChild(line);
      }
    } else if (cand.scanned) {
      const ok = document.createElement('div');
      ok.className = 'meta-line';
      ok.textContent = `已扫描 ${cand.scanned} 个代码文件，没有发现明显的敏感操作。`;
      area.appendChild(ok);
    }

    const actions = document.createElement('div');
    actions.className = 'card-actions';
    actions.appendChild(
      button('安装这个插件', 'small primary', () => openInstallDialog(repo, cand, data.repo)),
    );
    area.appendChild(actions);

    if (autoInstall) openInstallDialog(repo, cand, data.repo);
  } catch (err) {
    area.innerHTML = `<div class="warn-line high">${escapeHtml(err.message)}</div>`;
  }
}

/** 安装确认弹窗 */
function openInstallDialog(repo, cand, repoInfo) {
  state.installTarget = { repo, cand };

  $('#installTitle').textContent = `安装 ${cand.label} 到本地`;
  $('#installBody').innerHTML = `
    <div class="install-plan">
      来源仓库：<b>${escapeHtml(repo.fullName)}</b><br>
      分支：${escapeHtml(repoInfo.branch || 'default')}<br>
      插件目录：${escapeHtml(cand.subdir || '（仓库根目录）')}<br>
      文件数量：${cand.fileCount} 个（${humanSize(cand.totalBytes)}）
    </div>
    <div class="file-list">
      ${cand.files
        .slice(0, 40)
        .map(
          (f) =>
            `<div class="file-row${f.path === cand.entryFile ? ' entry' : ''}"><span class="p">${escapeHtml(f.path)}</span><span class="s">${humanSize(f.size)}</span></div>`,
        )
        .join('')}
      ${cand.files.length > 40 ? `<div class="file-row"><span class="p muted">…还有 ${cand.files.length - 40} 个文件</span></div>` : ''}
    </div>
    ${
      cand.warnings && cand.warnings.length
        ? cand.warnings
            .slice(0, 6)
            .map(
              (w) =>
                `<div class="warn-line${w.level === 'high' ? ' high' : ''}"><span>⚠</span><span>${escapeHtml(w.what)}${w.file ? ` — <code>${escapeHtml(w.file.split('/').pop())}:${w.line}</code>` : ''}</span></div>`,
            )
            .join('')
        : '<div class="meta-line">代码扫描未发现明显的敏感操作。</div>'
    }
    <div class="warn-line" style="margin-top:12px">
      <span>!</span><span>插件会以你的完整权限运行在这个进程里（能读写文件、执行命令）。只装你信任的来源。</span>
    </div>
  `;
  $('#installEnable').checked = false;
  $('#installBackdrop').hidden = false;
}

async function confirmInstall() {
  const target = state.installTarget;
  if (!target) return;
  const btn = $('#btnInstallConfirm');
  btn.disabled = true;
  btn.textContent = '安装中…';

  const [owner, name] = target.repo.fullName.split('/');
  try {
    const data = await api('/market/install', {
      body: {
        owner,
        name,
        ref: '',
        subdir: target.cand.subdir,
        enable: $('#installEnable').checked,
      },
    });
    $('#installBackdrop').hidden = true;
    state.installTarget = null;
    toast(data.note || '安装完成', 'ok');
    await loadPlugins();
    await loadTools();
    await refreshInfo();
    // 装完跳到设置里的插件管理，让用户看到它、并决定要不要启用
    openSettings('plugins', { section: 'section-plugins' });
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '确认安装';
  }
}

/* ------------------------------------------------------------------ */
/* 模型列表（从网关拉取）                                              */
/* ------------------------------------------------------------------ */

/**
 * 从网关拉取可用模型列表。
 *
 * 为什么会需要：模型名错一个字符就是 404，而服务端明明知道自己有哪些模型。
 * 让它自己报出来，用户点一下就行——不用翻文档、不用猜。
 *
 * 用界面上**当前填的**地址/协议/密钥去拉（而不是已保存的），
 * 这样「改了地址想看看有什么模型」不用先保存一次。
 */
async function fetchModelList() {
  const btn = $('#btnFetchModels');
  const box = $('#modelList');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '获取中…';
  box.hidden = true;

  try {
    const data = await api('/models', {
      body: {
        baseUrl: $('#apBaseUrl').value.trim(),
        apiFormat: $('#apFormat').value,
        apiKey: $('#apKey').value.trim() || undefined,
      },
    });
    renderModelList(data.models || []);
    $('#modelHint').textContent = `拉到 ${data.models.length} 个模型，点一下即可填入。`;
  } catch (err) {
    box.hidden = true;
    box.innerHTML = '';
    // 拉不到不是致命问题——不少自建网关没实现 /models，手填就行
    $('#modelHint').textContent = `拉取失败：${err.message}`;
    toast('没能拉到模型列表，手动填模型名即可', 'warn');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/** 把模型列表渲染成一排可点的标签，并灌进 datalist 供输入联想 */
function renderModelList(models) {
  const box = $('#modelList');
  const list = $('#modelOptions');
  box.innerHTML = '';
  if (!models.length) {
    box.hidden = true;
    return;
  }

  // datalist：让输入框自己带联想
  if (list) {
    list.innerHTML = models.map((m) => `<option value="${escapeHtml(m.id)}"></option>`).join('');
  }

  const current = $('#apModel').value.trim();
  for (const m of models) {
    const btn = document.createElement('button');
    btn.type = 'button';
    // 图像 / 视频 / 向量 / 语音类模型基本不支持工具调用，标出来避免踩坑
    const nonChat = /image|video|embedding|rerank|tts|whisper|audio/i.test(m.id);
    btn.className = `model-chip${m.id === current ? ' active' : ''}${nonChat ? ' warn' : ''}`;
    btn.textContent = m.id;
    btn.title = nonChat
      ? `${m.id}\n名字看是图像/视频/向量/语音类模型，通常不支持工具调用——agent 用它干活会失败`
      : `${m.id}${m.label ? `\n${m.label}` : ''}\n点击填入`;
    btn.addEventListener('click', () => {
      $('#apModel').value = m.id;
      $$('.model-chip', box).forEach((el) => el.classList.toggle('active', el === btn));
    });
    box.appendChild(btn);
  }
  box.hidden = false;
  if (!current) $('#modelHint').textContent = '点下面的模型名填入，或直接在输入框里手打。';
}

/* ------------------------------------------------------------------ */
/* 模型快速切换（输入区左下角那个按钮）                                */
/* ------------------------------------------------------------------ */

/** 模型列表缓存在 localStorage：下次点开浮层立刻就有内容，不用干等一次请求 */
const MODEL_CACHE_KEY = 'mya.models';
/** 缓存多久算过期（超过就后台静默刷新一次） */
const MODEL_CACHE_TTL = 10 * 60 * 1000;

function readModelCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_CACHE_KEY) || 'null');
    if (!parsed || !Array.isArray(parsed.models)) return { models: [], at: 0 };
    return { models: parsed.models.filter((m) => m && m.id), at: parsed.at || 0 };
  } catch {
    // 缓存坏了不影响使用，当成没有就行
    return { models: [], at: 0 };
  }
}

function writeModelCache(models) {
  try {
    localStorage.setItem(MODEL_CACHE_KEY, JSON.stringify({ models, at: Date.now() }));
  } catch {
    // 隐私模式 / 配额满：缓存写不进去不是错误，功能照常
  }
}

/** 浮层是不是开着 */
function modelPopOpen() {
  const pop = $('#modelPop');
  return !!pop && !pop.hidden;
}

/** 目前实际在用的模型名（以服务端返回的为准，不是输入框里的草稿） */
function currentModel() {
  return (state.info && state.info.model) || '';
}

/**
 * 把模型名同步到三处显示：输入区按钮、顶栏标签、浮层里的「当前」。
 *
 * 为什么要专门做这件事：这三处显示的其实是同一个值，但分别来自
 * 不同的更新路径（切换模型、保存设置、启动时读配置）。少了任何一处，
 * 界面上就会出现「顶栏写着 A、输入区写着 B」这种自相矛盾的状态。
 */
function syncModelLabels() {
  const model = currentModel();

  const label = $('#composerModelName');
  if (label) label.textContent = model || '选择模型';

  const btn = $('#btnModelSwitch');
  if (btn) {
    btn.classList.toggle('unset', !model);
    // 推理等级也写进 title：它和模型名一样是「下一轮请求会用到什么」的一部分，
    // 但塞进按钮正文会把模型名挤没，所以只在悬停说明里出现
    const level = state.info && state.info.reasoning ? state.info.reasoning : null;
    const levelLabel =
      level && level.level && level.level !== 'auto'
        ? `，推理等级：${(level.options.find((o) => o.value === level.level) || {}).label || level.level}`
        : '';
    btn.title = model
      ? `当前模型：${model}${levelLabel}（点击切换）`
      : '还没配置模型，点这里选一个';
  }

  // 模型浮层里的「当前」一行。modelPopOpen 时点开就能看到，
  // 顶栏的胶囊去掉之后这里就是模型名的唯一落点（除了输入区按钮本体）
  const cur = $('#modelPopCurrent');
  if (cur) cur.textContent = model || '未配置';
}

/** 打开模型浮层（设置抽屉开着就先收起来，免得两层浮层叠在一起） */
function openModelPop() {
  if (settingsOpen()) closeSettings();
  const pop = $('#modelPop');
  if (!pop) return;

  pop.hidden = false;
  $('#btnModelSwitch').classList.add('open');
  syncModelLabels();
  renderReasoning();

  // 有缓存先画出来，用户立刻能看到东西；过期了再后台刷新
  const cached = readModelCache();
  if (cached.models.length) renderModelPopList(cached.models);
  if (!cached.models.length || Date.now() - cached.at > MODEL_CACHE_TTL) {
    loadModelPopList({ silent: true });
  }
}

function closeModelPop() {
  const pop = $('#modelPop');
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  const btn = $('#btnModelSwitch');
  if (btn) btn.classList.remove('open');
}

function toggleModelPop() {
  if (modelPopOpen()) closeModelPop();
  else openModelPop();
}

/**
 * 拉一份可用模型列表填进浮层。
 *
 * 这里用的是**已保存**的接口地址和密钥（不带请求体），
 * 因为浮层切模型改的就是当前配置——拿设置表单里那份还没保存的草稿去拉，
 * 只会拉出一份和实际请求无关的列表。
 *
 * @param {{silent?: boolean}} [opts] silent 时不打断用户（后台刷新用）
 */
async function loadModelPopList(opts = {}) {
  const btn = $('#btnModelRefresh');
  const original = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '获取中…';
  }

  try {
    const data = await api('/models', { body: {} });
    const models = data.models || [];
    writeModelCache(models);
    renderModelPopList(models);
    // 拉到了就什么都不说：模型列表下面不再挂一行「N 个可用模型」——
    // 列表本身就是答案，多一行字只是噪音（用户明确要求去掉）
  } catch (err) {
    // 拉不到不算失败：很多自建网关没有 /models，手填照样能用。
    // 这种情况必须说话，但放在 toast 里，不占浮层位置。
    const cached = readModelCache();
    if (cached.models.length) renderModelPopList(cached.models);
    if (!opts.silent) toast(`没能拉到模型列表（${err.message}），可以直接输入模型名`, 'warn');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = original;
    }
  }
}

/**
 * 把模型名按前缀分组。
 *
 * 为什么分组：网关经常一次给上百个模型（deepseek-chat / deepseek-reasoner /
 * qwen2.5-72b / …），平铺成一列要滚半天；按前缀折叠起来，一屏就能看全。
 * 前缀取第一个分隔符（- _ / . :）之前的那段，没有分隔符就用整个名字。
 */
function groupModels(models) {
  const groups = new Map();
  for (const raw of models || []) {
    const id = String((raw && raw.id) || '').trim();
    if (!id) continue;
    const key = (id.split(/[-_/.:]/)[0] || id).toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(id);
  }
  return [...groups.entries()].map(([key, ids]) => ({ key, ids }));
}

/** 图像 / 视频 / 向量 / 语音类模型基本不支持工具调用，要标出来免得换完发现干活就报错 */
const NON_CHAT_MODEL = /image|video|embedding|rerank|tts|whisper|audio/i;

/**
 * 把模型渲染成「可折叠分组 + 一行一个」的展开式列表（点一行即切换）。
 *
 * 为什么不做成一排小标签：标签堆在一起没有层级，模型一多就变成一堵墙；
 * 分组之后「有哪些系列、每个系列里有什么」一眼能看出来，也是「展开式」的意义所在。
 */
function renderModelPopList(models) {
  const box = $('#modelPopList');
  const options = $('#modelPopOptions');
  if (!box) return;
  box.innerHTML = '';
  if (options) {
    options.innerHTML = models
      .map((m) => `<option value="${escapeHtml(m.id)}"></option>`)
      .join('');
  }

  const current = currentModel();
  const groups = groupModels(models);
  // 组少就全展开；组多只展开含当前模型的那一组，其余折起来
  const expandAll = groups.length <= 3;

  for (const group of groups) {
    const wrap = document.createElement('div');
    wrap.className = 'model-group';
    wrap.dataset.group = group.key;
    if (expandAll || group.ids.includes(current)) wrap.classList.add('open');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'model-group-head';
    // 组名和数量都是我们自己的数据（模型名来自网关，仍然转义一遍）
    head.innerHTML =
      '<span class="model-group-caret">▸</span>' +
      `<span class="model-group-name">${escapeHtml(group.key)}</span>` +
      `<span class="model-group-count">${group.ids.length}</span>`;
    head.addEventListener('click', () => wrap.classList.toggle('open'));
    wrap.appendChild(head);

    const body = document.createElement('div');
    body.className = 'model-group-body';
    for (const id of group.ids) {
      const nonChat = NON_CHAT_MODEL.test(id);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `model-row${id === current ? ' active' : ''}${nonChat ? ' warn' : ''}`;
      row.dataset.model = id;
      row.innerHTML =
        `<span class="model-row-check">${id === current ? '✓' : ''}</span>` +
        `<span class="model-row-name">${escapeHtml(id)}</span>` +
        (nonChat ? '<span class="model-row-tag">非对话</span>' : '');
      row.title = nonChat
        ? `${id}\n名字看是图像/视频/向量/语音类模型，通常不支持工具调用——agent 用它干活会失败`
        : `${id}\n点击切换到这个模型`;
      row.addEventListener('click', () => switchModel(id));
      body.appendChild(row);
    }
    wrap.appendChild(body);
    box.appendChild(wrap);
  }
  box.hidden = models.length === 0;
  // 输入框里可能还留着上次的过滤词，重画之后要重新应用一次
  const input = $('#modelPopInput');
  if (input && input.value.trim()) filterModelPopList(input.value);
}

/**
 * 按输入框里的词过滤：不匹配的行藏起来，命中的组自动展开。
 * 比「只能回车切换」友好——看到想要的那一行，点一下就行。
 */
function filterModelPopList(query) {
  const box = $('#modelPopList');
  if (!box) return;
  const q = String(query || '').trim().toLowerCase();
  $$('.model-group', box).forEach((group) => {
    let hits = 0;
    $$('.model-row', group).forEach((row) => {
      const hit = !q || String(row.dataset.model || '').toLowerCase().includes(q);
      row.classList.toggle('hide', !hit);
      if (hit) hits += 1;
    });
    group.classList.toggle('hide', hits === 0);
    // 过滤时命中就展开；清空过滤词时保持用户手动折过的状态，不强行复位
    if (q && hits > 0) group.classList.add('open');
  });
}

/* ------------------------------------------------------------------ */
/* 推理等级                                                            */
/* ------------------------------------------------------------------ */

/**
 * 画推理等级的选项。
 *
 * 选项来自服务端（/api/info 的 reasoning.options，由 src/reasoning.js 按**当前协议**
 * 生成）：OpenAI 兼容是官方取值 minimal/low/medium/high，Anthropic 和 Gemini
 * 官方没有「等级」这个概念、只有 token 预算，所以那两家显示的是预算。
 * 前端不自己写一份取值表，免得界面显示的和真正发出去的字段对不上。
 */
function renderReasoning() {
  const wrap = $('#modelPopReason');
  const seg = $('#reasonLevels');
  const cur = $('#reasonCurrent');
  if (!wrap || !seg) return;

  const info = state.info && state.info.reasoning;
  if (!info || !Array.isArray(info.options) || !info.options.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  seg.innerHTML = '';
  for (const opt of info.options) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `seg-btn${opt.value === info.level ? ' active' : ''}`;
    btn.dataset.level = opt.value;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', opt.value === info.level ? 'true' : 'false');
    btn.textContent = opt.label;
    // 每档都说清「实际会发什么字段」——三家官方的参数名不一样，
    // 光看「高/中/低」根本不知道请求里到底多了什么
    btn.title = opt.hint;
    btn.addEventListener('click', () => switchReasoning(opt.value));
    seg.appendChild(btn);
  }
  // 抽屉头上只留「当前是哪一档」，不再堆说明文字（用户明确要求别有多余的话）
  if (cur) cur.textContent = (info.options.find((o) => o.value === info.level) || {}).label || '默认';
}

/**
 * 切换推理等级。
 *
 * 只提交 reasoning 一个字段——和换模型同一个道理：服务端是按字段合并的，
 * 地址、密钥、压缩策略都不会被顺手改掉。
 */
async function switchReasoning(level) {
  const info = state.info && state.info.reasoning;
  if (info && info.level === level) {
    toast('已经是这个等级了', '');
    return;
  }
  $$('#reasonLevels .seg-btn').forEach((b) => (b.disabled = true));
  try {
    await api('/settings', { body: { reasoning: { level } } });
    await refreshInfo(); // info 里带着新的等级和选项，refreshInfo 会重画这一块
    toast('推理等级已更新，下一轮请求开始生效', 'ok');
  } catch (err) {
    toast(`切换推理等级失败：${err.message}`, 'err');
  } finally {
    $$('#reasonLevels .seg-btn').forEach((b) => (b.disabled = false));
  }
}

/* ------------------------------------------------------------------ */
/* 权限档位 + 附件                                                     */
/* ------------------------------------------------------------------ */

/** 三档权限的文案与图标（和 index.html 里的菜单一一对应） */
const APPROVAL_META = {
  ask: { label: '询问', icon: '🛡️', toast: '每个危险操作都会先问你一句' },
  workspace: { label: '工作区内执行', icon: '📂', toast: '工作目录内的写文件和命令不再问，越界仍然问' },
  full: { label: '完全权限', icon: '⚡', toast: '不再询问（rm -rf / 这类硬黑名单仍会拦）' },
};

/** 把当前档位画到按钮上 */
function renderApproval() {
  const info = (state.info && state.info.approval) || {};
  const mode = APPROVAL_META[info.mode] ? info.mode : 'ask';
  const meta = APPROVAL_META[mode];
  const btn = $('#btnApproval');
  const label = $('#approvalLabel');
  const icon = $('#approvalIcon');
  if (label) label.textContent = meta.label;
  if (icon) icon.textContent = meta.icon;
  if (btn) {
    btn.dataset.mode = mode;
    btn.title = `权限：${meta.label}——${meta.toast}（点一下切换）`;
  }
  $$('#approvalPop .menu-row').forEach((row) => row.classList.toggle('active', row.dataset.mode === mode));
}

/**
 * 「完全权限」的二次确认。
 *
 * 为什么要多这一步：这一档是唯一「不问就改文件、跑命令」的模式，而且越界也不问了。
 * 它就在一个常驻按钮的下拉里，点错一次要等到发现文件被改了才知道——
 * 所以生效前把代价说清楚，并且给「取消」留出同等显眼的位置。
 *
 * @returns {Promise<boolean>} 用户是否确认放开
 */
/**
 * 看某个检查点改了哪些文件。
 * 用通用确认框当「只读弹窗」：把取消按钮藏掉，只剩一个「关闭」。
 */
async function showCheckpointDiff(ref) {
  try {
    const r = await api('/checkpoint/diff', { body: { ref } });
    const files = (r.files || []).map((f) => `${f.status === 'A' ? '新增' : f.status === 'D' ? '删除' : '修改'}  ${f.path}`);
    await confirmDialog({
      title: `这个检查点改了 ${files.length} 个文件`,
      badge: '检查点',
      danger: false,
      showCancel: false,
      confirmText: '关闭',
      focusConfirm: true,
      body:
        `<p class="modal-note">回滚到它，就是把这些文件恢复成当时的样子。</p>` +
        `<pre class="modal-code">${escapeHtml(files.join('\n') || '（没有文件差异）')}</pre>`,
    });
  } catch (err) {
    toast(err.message, 'err');
  }
}

/** 回滚到某个检查点（破坏性操作，必须先确认） */
async function restoreCheckpoint(ref, btn) {
  const ok = await confirmDialog({
    title: '回滚到这个检查点？',
    badge: '回滚',
    confirmText: '回滚',
    cancelText: '算了',
    body:
      `<p class="modal-note">工作区里这些文件会被恢复成当时的内容，<b>当前未保存的改动会丢失</b>。</p>` +
      `<p class="modal-note">注意：检查点之后<b>新建</b>的文件不会被删掉（回滚只恢复检查点里存在的路径）。</p>` +
      `<p class="modal-note muted">${escapeHtml(ref)}</p>`,
  });
  if (!ok) return;
  if (btn) btn.disabled = true;
  try {
    await api('/checkpoint/restore', { body: { ref } });
    toast('已回滚到那个检查点', 'ok');
    if (btn) {
      btn.textContent = '已回滚';
      btn.disabled = true;
    }
  } catch (err) {
    toast(err.message, 'err');
    if (btn) btn.disabled = false;
  }
}

/**
 * 通用确认框（就是「完全权限」那个弹窗泛化出来的，别的确认也用它）。
 *
 * 为什么不每次新写一个弹窗：坑都在细节里——Esc、点背景、焦点落在哪、监听要不要解绑。
 * 这些只写一遍，才不会出现「有一个弹窗按 Esc 关不掉」这种事。
 *
 * @param {{title:string, body:string, badge?:string, confirmText?:string, cancelText?:string,
 *          showCancel?:boolean, danger?:boolean, focusConfirm?:boolean}} opts
 * @returns {Promise<boolean>}
 */
function confirmDialog(opts = {}) {
  const backdrop = $('#permBackdrop');
  if (!backdrop) return Promise.resolve(true); // 结构不完整时不要卡住功能
  const titleEl = $('#permTitle');
  const bodyEl = $('#permBody');
  const badgeEl = $('#permBadge');
  const cancelBtn = $('#btnPermCancel');
  const confirmBtn = $('#btnPermConfirm');
  if (titleEl) titleEl.textContent = opts.title || '确认一下';
  if (bodyEl) bodyEl.innerHTML = opts.body || '';
  if (badgeEl) {
    badgeEl.textContent = opts.badge || '需要确认';
    badgeEl.className = opts.danger === false ? 'badge' : 'badge danger';
  }
  if (confirmBtn) {
    confirmBtn.textContent = opts.confirmText || '确定';
    confirmBtn.className = opts.danger === false ? 'btn primary' : 'btn danger';
  }
  if (cancelBtn) {
    cancelBtn.textContent = opts.cancelText || '取消';
    cancelBtn.hidden = opts.showCancel === false;
  }

  return new Promise((resolve) => {
    backdrop.hidden = false;
    const onCancel = () => done(false);
    const onConfirm = () => done(true);
    const onBackdrop = (e) => {
      if (e.target === backdrop) done(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        done(false);
      }
    };
    function done(ok) {
      backdrop.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      if (cancelBtn) cancelBtn.removeEventListener('click', onCancel);
      if (confirmBtn) confirmBtn.removeEventListener('click', onConfirm);
      backdrop.removeEventListener('click', onBackdrop);
      resolve(ok);
    }
    if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
    if (confirmBtn) confirmBtn.addEventListener('click', onConfirm);
    backdrop.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey, true);
    // 默认焦点落在「取消」上：误按回车不该直接把权限放开
    const focusEl = opts.focusConfirm ? confirmBtn : cancelBtn;
    if (focusEl) setTimeout(() => focusEl.focus(), 0);
  });
}

function confirmFullAccess() {
  return confirmDialog({
    title: '要让 agent 不再询问吗？',
    badge: '完全权限',
    confirmText: '我知道，放开',
    cancelText: '取消',
    body: `
      <p class="modal-note">
        切到「完全权限」之后，agent 改写文件、执行命令、删除内容都<b>不会再问你</b>——
        包括工作目录以外的路径。只有少数硬黑名单（<code>rm -rf /</code>、<code>git push --force</code> 这类）
        仍然会拦一次。
      </p>
      <p class="modal-note">
        建议只在「我就在旁边看着、而且这批操作我本来就要做」的时候用；平时用「工作区内执行」更稳。
      </p>`,
  });
}

/**
 * 切换权限档位。
 *
 * 只提交 approval 一个字段：服务端是按字段合并的，模型、地址、密钥都不会被顺手改掉。
 * 为什么把这件事做得这么显眼（常驻按钮 + 颜色区分）：它决定「agent 能不能直接动手」，
 * 属于每一轮都在起作用的开关，不该藏在设置里让人忘了自己开过什么。
 */
async function switchApproval(mode) {
  if (!APPROVAL_META[mode]) return;
  const cur = (state.info && state.info.approval && state.info.approval.mode) || 'ask';
  closeComposerMenus();
  if (cur === mode) return;
  // 切到「完全权限」先弹一次确认；取消就什么都不做，档位保持原样
  if (mode === 'full') {
    const ok = await confirmFullAccess();
    if (!ok) {
      toast('已取消：权限保持原样', '');
      return;
    }
  }
  try {
    await api('/settings', { body: { approval: { mode } } });
    await refreshInfo();
    renderApproval();
    toast(`权限已改为「${APPROVAL_META[mode].label}」：${APPROVAL_META[mode].toast}`, mode === 'full' ? 'warn' : 'ok');
  } catch (err) {
    toast(`切换权限失败：${err.message}`, 'err');
  }
}

/** 输入区上的两个小菜单（附件 / 权限）互斥展开 */
function closeComposerMenus(except) {
  for (const id of ['#attachPop', '#approvalPop']) {
    if (id === except) continue;
    const pop = $(id);
    if (pop) pop.hidden = true;
    const btn = id === '#attachPop' ? $('#btnAttach') : $('#btnApproval');
    if (btn) btn.classList.remove('open');
  }
}

function toggleComposerMenu(menuId, btnId) {
  const pop = $(menuId);
  const btn = $(btnId);
  if (!pop) return;
  const willOpen = pop.hidden;
  closeComposerMenus(willOpen ? menuId : null);
  pop.hidden = !willOpen;
  if (btn) btn.classList.toggle('open', willOpen);
  if (willOpen && menuId === '#approvalPop') renderApproval();
}

/**
 * 选一个附件（文件 / 文件夹 / 压缩包），把路径插进输入框。
 *
 * 为什么只插路径、不搬文件：agent 本来就有 read/glob/grep 这些工具，
 * 给它一个真实路径比把内容塞进消息里更好用（大文件也塞不下）。
 * 浏览器里拿不到真实路径（安全限制），所以那里只提示要用桌面程序。
 */
async function pickAttachment(kind) {
  closeComposerMenus();
  const bridge = window.myaDesktop;
  if (!bridge || typeof bridge.chooseAttachment !== 'function') {
    toast('选文件需要在桌面程序里用：浏览器拿不到真实路径', 'warn');
    return;
  }
  let res;
  try {
    res = await bridge.chooseAttachment(kind, state.info && state.info.cwd);
  } catch (err) {
    toast(`选择失败：${err.message}`, 'err');
    return;
  }
  if (!res || !res.ok || !res.path) {
    if (res && res.canceled) return; // 用户自己取消的，不用说
    toast(`选择失败：${(res && res.error) || '没有拿到路径'}`, 'err');
    return;
  }
  const input = $('#input');
  if (input) {
    const needsSpace = input.value && !/\s$/.test(input.value);
    input.value += `${needsSpace ? ' ' : ''}@${res.path} `;
    input.focus();
    autoGrow();
  }
  if (kind === 'archive') {
    toast(`已加入压缩包路径：${shortPath(res.path, 40)}（需要先解压才能读，agent 会用 shell 处理）`, 'ok');
  } else {
    toast(`已加入${kind === 'directory' ? '文件夹' : '文件'}：${shortPath(res.path, 44)}`, 'ok');
  }
}


/**
 * 切换模型。
 *
 * 只提交 model 一个字段——服务端是「按字段合并」的，
 * 所以地址、密钥、压缩策略都不会被动到。这也是这里敢做成一步切换的原因：
 * 换个模型不该有意外的副作用。
 */
async function switchModel(id) {
  const model = String(id || '').trim();
  if (!model) {
    toast('模型名不能为空', 'warn');
    return;
  }
  if (model === currentModel()) {
    closeModelPop();
    toast(`当前已经是 ${model}`, '');
    return;
  }

  const box = $('#modelPopList');
  $$('.model-row', box).forEach((el) => (el.disabled = true));

  try {
    await api('/settings', { body: { model } });
    await refreshInfo(); // 顶栏、上下文用量条的分母都会跟着更新
    // 设置抽屉里已经没有模型输入框了（接入信息收进了「新建接入」弹窗），
    // 这里只需同步界面标签；弹窗下次打开时会按当前配置回填。
    syncModelLabels();
    closeModelPop();
    if ($('#modelPopInput')) $('#modelPopInput').value = '';
    toast(`已切换到 ${model}`, 'ok');
  } catch (err) {
    toast(`切换失败：${err.message}`, 'err');
    $$('.model-row', box).forEach((el) => (el.disabled = false));
  }
}

/* ------------------------------------------------------------------ */
/* 内置插件市场（离线）                                                */
/* ------------------------------------------------------------------ */

let marketSource = 'builtin';

/** 切换插件市场的来源：内置 / 本地 / GitHub */
function switchMarketSource(name) {
  marketSource = ['builtin', 'local', 'github'].includes(name) ? name : 'builtin';
  $$('#marketSrc .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.src === marketSource));
  $$('.market-pane').forEach((p) => {
    p.hidden = p.dataset.pane !== marketSource;
  });
  if (marketSource === 'builtin') loadBuiltinPlugins();
}

/** 读内置插件清单并渲染（完全离线） */
async function loadBuiltinPlugins() {
  const box = $('#builtinList');
  if (!box) return;
  box.innerHTML = '<div class="placeholder"><p class="muted">正在读取内置插件清单…</p></div>';
  try {
    const data = await api('/market/catalog');
    renderBuiltinPlugins(data.plugins || []);
  } catch (err) {
    box.innerHTML = '';
    const p = document.createElement('div');
    p.className = 'placeholder';
    p.textContent = `读不到内置插件清单：${err.message}`;
    box.appendChild(p);
  }
}

function renderBuiltinPlugins(list) {
  const box = $('#builtinList');
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="placeholder"><p class="muted">自带目录里没有插件。</p></div>';
    return;
  }

  for (const item of list) {
    const card = document.createElement('div');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';
    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = item.title;
    head.appendChild(title);

    const badge = document.createElement('span');
    badge.className = `badge${item.installed ? (item.enabled ? ' ok' : ' warn') : ''}`;
    badge.textContent = item.installed ? (item.enabled ? '已启用' : '已安装·未启用') : '未安装';
    head.appendChild(badge);
    card.appendChild(head);

    const desc = document.createElement('p');
    desc.className = 'muted';
    desc.textContent = item.description || '';
    card.appendChild(desc);

    if (item.tags && item.tags.length) {
      const tags = document.createElement('div');
      tags.className = 'quick-tags';
      for (const t of item.tags) {
        const s = document.createElement('span');
        s.className = 'tag';
        s.textContent = t;
        tags.appendChild(s);
      }
      card.appendChild(tags);
    }

    if (item.requires && item.requires.length) {
      const req = document.createElement('p');
      req.className = 'muted';
      req.textContent = `需要：${item.requires.join('；')}`;
      card.appendChild(req);
    }
    if (item.inCatalog === false) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = '（自带目录里有，但清单 catalog/plugins.json 里没登记）';
      card.appendChild(note);
    }

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    if (!item.installed) {
      const btn = document.createElement('button');
      btn.className = 'btn primary';
      btn.textContent = '安装并启用';
      btn.addEventListener('click', () => installBundledPlugin(item, btn));
      actions.appendChild(btn);
    } else {
      const toggle = document.createElement('button');
      toggle.className = 'btn';
      toggle.textContent = item.enabled ? '禁用' : '启用';
      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        try {
          await api(item.enabled ? '/plugins/disable' : '/plugins/enable', { body: { name: item.name } });
          toast(item.enabled ? `已禁用 ${item.title}` : `已启用 ${item.title}`, 'ok');
          await loadBuiltinPlugins();
          await loadPlugins();
          await loadTools();
        } catch (err) {
          toast(err.message, 'err');
        } finally {
          toggle.disabled = false;
        }
      });
      actions.appendChild(toggle);
    }

    card.appendChild(actions);
    box.appendChild(card);
  }
}

async function installBundledPlugin(item, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '安装中…';
  try {
    const data = await api('/market/install-bundled', { body: { name: item.name, enable: true } });
    toast(`已安装并启用：${item.title}（${data.files} 个文件）`, 'ok');
    for (const e of (data.reload && data.reload.errors) || []) toast(`${e.plugin}: ${e.error}`, 'err');
    await loadBuiltinPlugins();
    await loadPlugins();
    await loadTools();
  } catch (err) {
    toast(`安装失败：${err.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* ---- 本地安装（离线） ---- */

function localNotice(text, kind = '') {
  const box = $('#localNotice');
  if (!box) return;
  box.hidden = !text;
  box.className = `notice ${kind}`;
  box.textContent = text || '';
}

/** 桌面程序里能弹系统对话框；浏览器里退回手打路径 */
function bindLocalPicker() {
  const hasDir = !!(window.myaDesktop && window.myaDesktop.chooseDirectory);
  const hasFile = !!(window.myaDesktop && window.myaDesktop.chooseArchive);
  if ($('#btnLocalDir')) $('#btnLocalDir').hidden = !hasDir;
  if ($('#btnLocalZip')) $('#btnLocalZip').hidden = !hasFile;

  if (hasDir) {
    $('#btnLocalDir').addEventListener('click', async () => {
      const res = await window.myaDesktop.chooseDirectory($('#localPath').value.trim());
      if (res && res.ok && res.path) {
        $('#localPath').value = res.path;
        localNotice('');
      }
    });
  }
  if (hasFile) {
    $('#btnLocalZip').addEventListener('click', async () => {
      const res = await window.myaDesktop.chooseArchive($('#localPath').value.trim());
      if (res && res.ok && res.path) {
        $('#localPath').value = res.path;
        localNotice('');
      }
    });
  }
}

/** 装之前先检查：这个路径到底是什么、像不像插件 */
async function checkLocalPlugin() {
  const p = $('#localPath').value.trim();
  if (!p) {
    localNotice('先填一个路径（或点「选文件夹 / 选压缩包」）', 'warn');
    return null;
  }
  try {
    const data = await api('/market/check-local', { body: { path: p } });
    if (data.kind === 'missing') {
      localNotice(`这个路径不存在：${data.path}`, 'err');
      return null;
    }
    if (data.kind === 'other') {
      localNotice('只认文件夹、.zip 和 .tar.gz；其它格式请先解压成文件夹再装。', 'warn');
      return null;
    }
    if (data.kind === 'dir') {
      if (data.preview && data.preview.ok) {
        localNotice(`看起来是个插件（入口：${data.preview.entry || '由 manifest 指定'}），可以装了。`, 'ok');
        return data;
      }
      localNotice(`这个目录不像梦云 Agent 插件：\n${(data.preview && data.preview.error) || ''}`, 'err');
      return null;
    }
    localNotice(`压缩包（${data.kind}），装的时候会再检查一遍内容。`, '');
    return data;
  } catch (err) {
    localNotice(err.message, 'err');
    return null;
  }
}

async function installLocalPlugin() {
  const p = $('#localPath').value.trim();
  if (!p) {
    localNotice('先填一个路径（或点「选文件夹 / 选压缩包」）', 'warn');
    return;
  }
  const btn = $('#btnLocalInstall');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '安装中…';
  localNotice('正在安装…');
  try {
    const data = await api('/market/install-local', {
      body: { path: p, enable: $('#localEnable').checked },
    });
    localNotice(`装好了：${data.name}（${data.files} 个文件）${data.enabled ? '，已启用' : '，还没启用'}`, 'ok');
    toast(`已安装插件 ${data.name}`, 'ok');
    for (const e of (data.reload && data.reload.errors) || []) toast(`${e.plugin}: ${e.error}`, 'err');
    await loadPlugins();
    await loadTools();
    await loadBuiltinPlugins();
  } catch (err) {
    localNotice(err.message, 'err');
    toast(`安装失败：${String(err.message).split('\n')[0]}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/* ------------------------------------------------------------------ */
/* 接口格式（协议）                                                    */
/* ------------------------------------------------------------------ */

/**
 * 「接口地址」输入框的提示随格式变。
 *
 * 用户最容易被这里坑到：选了 Anthropic 却把地址填成 /v1/chat/completions，
 * 或者选了 Gemini 但不知道模型名要出现在地址里。placeholder 直接给出样式，
 * 比事后看 404 报错猜要省事得多。
 */
const BASE_URL_HINTS = {
  openai: {
    placeholder: 'https://api.deepseek.com/v1',
    hint: '写到 /v1 就行，不要带 /chat/completions（会自动补上）',
  },
  anthropic: {
    placeholder: 'https://api.anthropic.com/v1',
    hint: '写到 /v1 就行，不要带 /messages（会自动补上）',
  },
  gemini: {
    placeholder: 'https://generativelanguage.googleapis.com/v1beta',
    hint: '只写到 /v1beta 即可；模型名会自动拼到地址里',
  },
  auto: {
    placeholder: 'https://你的中转站域名/v1',
    hint: '写到 /v1 就行。选自动识别时，这里填的地址会决定用哪种协议',
  },
};

/** 协议名 → 中文标签（测试连接的结果里回显用） */
const FORMAT_LABELS = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic Messages',
  gemini: 'Google Gemini',
};

function updateBaseUrlHint() {
  const format = $('#apFormat') ? $('#apFormat').value : 'auto';
  const preset = BASE_URL_HINTS[format] || BASE_URL_HINTS.auto;
  const input = $('#apBaseUrl');
  const hint = $('#baseUrlHint');
  if (input) input.placeholder = preset.placeholder;
  if (hint) hint.textContent = preset.hint;
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

/** 渲染「目录」这一块：工作目录 / 数据目录 / 插件目录，能打开或复制 */
function renderDirList(dirs) {
  const box = $('#dirList');
  if (!box) return;
  const desktop = !!(window.myaDesktop && window.myaDesktop.isDesktop);

  box.innerHTML = '';
  for (const item of dirs) {
    if (!item.path) continue;
    const row = document.createElement('div');
    row.className = 'dir-row';
    row.innerHTML = `
      <span class="dir-label">${escapeHtml(item.label)}</span>
      <span class="dir-path" title="${escapeHtml(item.path)}">${escapeHtml(item.path)}</span>
    `;

    const actions = document.createElement('span');
    actions.className = 'dir-actions';

    if (desktop) {
      const openBtn = document.createElement('button');
      openBtn.className = 'mini-btn';
      openBtn.textContent = '打开';
      openBtn.addEventListener('click', async () => {
        const res = await window.myaDesktop.openPath(item.path);
        if (res && res.ok === false) toast(res.error || '打开失败', 'err');
      });
      actions.appendChild(openBtn);
    }

    const copyBtn = document.createElement('button');
    copyBtn.className = 'mini-btn';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(item.path).then(
        () => {
          copyBtn.textContent = '已复制';
          setTimeout(() => (copyBtn.textContent = '复制'), 1200);
        },
        () => toast('复制失败', 'err'),
      );
    });
    actions.appendChild(copyBtn);

    row.appendChild(actions);
    box.appendChild(row);
  }
}

/**
 * 手动压缩上下文。
 *
 * 用户按了才压：压缩会改写对话历史，自动压有时会把他正在回看的旧消息折掉。
 * 压缩过程会推 context_compacting 事件（界面上显示「正在总结…」），
 * 结束后推 context_compacted，落成对话里的一条「上下文已压缩」记录。
 */
async function compactContext() {
  const btn = $('#btnCompact');
  if (!state.currentId) {
    toast('先新建一个会话再压缩', 'warn');
    return;
  }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = '压缩中…';
  try {
    const data = await api('/compact', { body: { sessionId: state.currentId } });
    toast(data.message ? String(data.message).split('\n')[0] : '已压缩', 'ok');
    if (data.context) {
      state.context = { ...(state.context || {}), ...data.context };
      renderContext();
    }
    await refreshInfo();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/**
 * 读取当前设置并填进表单。
 * 只填表单，不覆盖主题（主题由 localStorage 管，和配置文件无关）。
 */
/**
 * 只有选了「自定义接口」才需要填地址——Bing 和 DuckDuckGo 都是免密钥的。
 * 一直显示着那个输入框只会让人以为必须填点什么。
 */
function syncWebEndpointField() {
  const field = $('#webEndpointField');
  if (!field) return;
  field.hidden = $('#setWebProvider').value !== 'custom';
}

async function loadSettings() {
  // 设置表单住在设置浮层里。浮层没打开时这些输入框不在页面上——先确认在页上。
  // （接入字段已经搬进「新建接入」弹窗，这里用仍然常驻的 #setStream 当哨兵。）
  if (!$('#setStream')) return;
  try {
    const data = await api('/settings');
    const raw = data.raw || {};
    // 接入信息（服务商/地址/模型/Key/格式）不在这里回填：它们归「接入」下拉与弹窗管
    $('#setStream').checked = raw.stream !== false;
    $('#setMaxTurns').value = raw.maxTurns || 25;
    $('#setAutoApprove').value = (raw.autoApprove || []).join(', ');
    $('#setAllowDangerous').checked = !!raw.allowDangerous;
    $('#setGithubToken').placeholder = raw.githubTokenMasked ? `已配置（${raw.githubTokenMasked}），留空不修改` : '未配置（可选）';
    $('#setGithubToken').value = '';

    // 上下文与压缩：窗口留空/0 表示自动（网关优先，其次按模型名推断）
    const compact = raw.compact || {};
    $('#setContextWindow').value = raw.contextWindow ? String(raw.contextWindow) : '';
    $('#setCompactEnabled').checked = compact.enabled !== false;
    $('#setCompactAuto').checked = !!compact.auto;
    const thresholdPct = Math.round((compact.threshold || 0.75) * 100);
    $('#setCompactThreshold').value = String(thresholdPct);
    $('#compactThresholdLabel').textContent = `${thresholdPct}%`;
    $('#setCompactKeep').value = String(compact.keepRecent || 8);
    // 窗口大小是从哪来的，就写在这儿——用户看得见才敢信那个百分比
    const winHint = $('#contextWindowHint');
    if (winHint) {
      const source = WINDOW_SOURCE_LABELS[raw.contextWindowSource] || '来源未知';
      winHint.textContent =
        `留 0 表示自动。当前窗口 ${Math.round((state.info && state.info.contextWindow) || 0)} token，来源：${source}。`;
    }

    // 联网搜索
    const web = raw.web || {};
    $('#setWebEnabled').checked = web.enabled !== false;
    $('#setWebProvider').value = web.provider || 'bing';
    $('#setWebEndpoint').value = web.endpoint || '';
    $('#setWebTimeout').value = String(web.timeoutSec || 15);
    syncWebEndpointField();

    $('#configDump').textContent = Object.entries(data.config || {})
      .map(([k, v]) => `${k}：${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\n');

    // 关于分区
    const info = state.info || {};
    $('#aboutInfo').textContent = [
      `梦云 Agent v${info.version || '?'}`,
      `模型：${info.provider || '?'} / ${info.model || '?'}`,
      `工具：${info.toolCount || 0} 个`,
      `插件：${info.pluginCount || 0} 个`,
      `运行环境：Node ${info.node || '?'}（${info.platform || '?'}）`,
    ].join('\n');

    // 目录列表（桌面程序里可以直接打开）
    renderDirList([
      { label: '工作目录', path: info.cwd || '' },
      { label: '数据目录', path: info.dataDir || '' },
      ...(data.pluginDirs || []).map((p, i) => ({ label: i === 0 ? '插件目录' : `插件目录 ${i + 1}`, path: p })),
    ]);

    state.autoApprove = raw.autoApprove || [];

    // 外观
    renderAccentSwatches();
    updateThemeButtons();
  } catch (err) {
    toast(`读取设置失败：${err.message}`, 'err');
  }
}

/**
 * 保存设置。
 * 设置面板分成了几个分区，每个分区有自己的保存按钮——只提交这一块的内容，
 * 避免「改了个轮数却把 API Key 也一起覆盖了」这类意外。
 *
 * @param {'model'|'behavior'|'context'} section
 */
async function saveSettings(section = 'model') {
  const body = {};

  if (section === 'model') {
    // 接入信息（服务商/地址/模型/Key/格式）不在这里提交：它们由「接入」弹窗保存并切换。
    // 这一段只管全局开关与可选 Token，避免"改个流式却把接入信息也一起覆盖了"。
    body.stream = $('#setStream').checked;

    const gh = $('#setGithubToken').value.trim();
    if (gh) body.githubToken = gh;
    else if ($('#setGithubToken').dataset.cleared === '1') body.githubToken = '';
  } else if (section === 'behavior') {
    body.maxTurns = Number($('#setMaxTurns').value) || 25;
    body.autoApprove = $('#setAutoApprove')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    body.allowDangerous = $('#setAllowDangerous').checked;
  } else if (section === 'context') {
    // 空字符串 = 交回「按模型推断」，所以显式发 0
    body.contextWindow = Number($('#setContextWindow').value) || 0;
    body.compact = {
      enabled: $('#setCompactEnabled').checked,
      auto: $('#setCompactAuto').checked,
      threshold: (Number($('#setCompactThreshold').value) || 75) / 100,
      keepRecent: Number($('#setCompactKeep').value) || 8,
    };
  } else if (section === 'web') {
    body.web = {
      enabled: $('#setWebEnabled').checked,
      provider: $('#setWebProvider').value,
      endpoint: $('#setWebEndpoint').value.trim(),
      timeoutSec: Number($('#setWebTimeout').value) || 15,
    };
  }

  const btn = $(
    section === 'model'
      ? '#btnSaveModel'
      : section === 'context'
        ? '#btnSaveContext'
        : section === 'web'
          ? '#btnSaveWeb'
          : '#btnSaveBehavior',
  );
  if (btn) btn.disabled = true;
  try {
    const data = await api('/settings', { body });
    if (section === 'model') showNotice('#settingsNotice', data.message || '已保存', 'ok');
    await loadSettings();
    await refreshInfo();
    // 改了窗口大小就立刻重画用量条的分母，别等下一轮才更新
    if (section === 'context') renderContext();
    toast('设置已保存', 'ok');
  } catch (err) {
    if (section === 'model') showNotice('#settingsNotice', err.message, 'err');
    else toast(err.message, 'err');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function testConnection() {
  const btn = $('#btnTest');
  btn.disabled = true;
  btn.textContent = '测试中…';
  // 按钮住在「新建接入」弹窗里，结果也就显示在弹窗里（#settingsNotice 在另一段上，用户看不到）
  showNotice('#apNotice', '正在向模型发一条测试消息…', '');
  try {
    const data = await api('/settings/test', {
      body: {
        provider: $('#apProvider').value,
        apiFormat: $('#apFormat').value,
        baseUrl: $('#apBaseUrl').value.trim(),
        model: $('#apModel').value.trim(),
        apiKey: $('#apKey').value.trim() || undefined,
      },
    });
    const formatLabel =
      (FORMAT_LABELS[data.format] || data.format || '') &&
      `\n协议：${FORMAT_LABELS[data.format] || data.format}`;
    showNotice(
      '#apNotice',
      `连接成功（${humanMs(data.ms)}）${formatLabel}\n模型回复：${data.reply || '(空)'}${
        data.usage ? `\n用量：${data.usage.total_tokens || 0} token` : ''
      }`,
      'ok',
    );
  } catch (err) {
    showNotice('#apNotice', `${err.message}${connectionAdvice(err)}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
}

function showNotice(sel, text, kind) {
  const el = $(sel);
  el.hidden = false;
  el.className = `notice ${kind || ''}`;
  el.textContent = text;
}

/**
 * 「测试连接」失败后该补一句什么提示。
 *
 * 关键是别把人带偏：404 既可能是地址写错，也可能是**地址对但模型名不存在**。
 * 之前统一提示「换个接口格式试试」，结果模型名填错的人会去折腾协议格式。
 * 服务端其实已经说清了原因（"模型 X 不在分组中，可用：..."），
 * 后端把它归类成 kind 传过来，这里按类给建议。
 */
function connectionAdvice(err) {
  switch (err && err.kind) {
    case 'model':
      return '\n\n请把「模型」改成上面列出的可用模型名（服务端报错里已经给了列表）。';
    case 'auth':
      return '\n\n检查 API Key；如果 Key 没问题，试试切换「接口格式」——三家的鉴权头不一样（Bearer / x-api-key / x-goog-api-key）。';
    case 'quota':
      return '\n\n这是账户额度或权限问题，不是配置错。去中转站后台看余额和分组权限。';
    case 'protocol':
      return '\n\n这个模型不支持当前的「接口格式」——网关把不同模型挂在不同的协议下（chat/completions、Responses、messages 各管各的）。在上方换个「接口格式」再点「测试连接」；换了两三个还不行，就是网关没把它挂在你这侧能用的协议上，换模型（同家族总有一款能用）。';
    case 'origin':
      return '\n\n这是网关服务器的问题（Cloudflare 档正常，但它背后的源站不可达），不是你的配置错。先用浏览器打开接口地址确认，等它恢复或换它的备用地址。';
    case 'endpoint':
      return '\n\n地址或协议格式对不上。确认 baseUrl 写到 /v1（不要带 /chat/completions），再换个「接口格式」试试。';
    default:
      return '\n\n如果是 404 或 401，先换个「接口格式」再试一次。';
  }
}

/* ------------------------------------------------------------------ */
/* 界面杂项                                                            */
/* ------------------------------------------------------------------ */

/**
 * 切换设置浮层里的视图（左侧那些标签）。
 *
 * 每个视图的数据都是「切过去才加载」——设置是低频入口，
 * 没必要一打开就把插件列表、工具清单、市场都拉一遍。
 *
 * @param {string} name model | plugins | market | appearance | behavior | about
 * @param {{section?: string, focus?: string}} [opts]
 *        section 直接滚到某个分区（比如装完插件跳到插件管理）
 *        focus   把光标放进某个输入框
 */
function switchDrawerView(name, opts = {}) {
  $$('.drawer-tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  $$('.drawer-view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));

  if (name === 'model') {
    loadSettings();
    refreshApiProfiles();   // 「接入运营商」下拉跟设置一起刷新（它就是这一段的一部分）
  }
  if (name === 'plugins') {
    loadPlugins();
    loadTools();
  }
  if (name === 'market') {
    loadPlugins(); // 市场里要显示已装插件，用于提示重复安装
    // 默认停在「内置插件」（离线可用）——国内网络经常连不上 GitHub，
    // 一进来就撞一堵报错墙不合适
    switchMarketSource(marketSource);
  }
  if (name === 'appearance') renderAccentSwatches();

  if (opts.section) {
    // 等视图显示出来再算位置，否则量到的都是 0
    setTimeout(() => {
      const el = document.getElementById(opts.section);
      if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 80);
  }
  if (opts.focus) {
    setTimeout(() => {
      const el = $(opts.focus);
      if (el) el.focus();
    }, 260);
  }
}

/* ------------------------------------------------------------------ */
/* 设置浮层（右侧滑出的抽屉）                                          */
/* ------------------------------------------------------------------ */

const DRAWER_VIEWS = ['model', 'plugins', 'market', 'appearance', 'behavior', 'about'];
const DRAWER_ANIM_MS = 220;

/** 设置浮层是不是开着 */
function settingsOpen() {
  const el = $('#settingsDrawer');
  return !!el && !el.hidden;
}

/**
 * 打开设置浮层。
 *
 * 做成浮层而不是常驻一栏，是因为设置是低频操作：常驻会一直占着四百像素，
 * 把对话挤窄。用完关掉，页面上不留痕迹。
 *
 * @param {string} [view] 打开时停在哪个视图
 * @param {{section?: string, focus?: string}} [opts] 透传给 switchDrawerView
 */
function openSettings(view, opts = {}) {
  const drawer = $('#settingsDrawer');
  const backdrop = $('#settingsBackdrop');
  if (!drawer) return;

  // 两个浮层不该同时盖在对话上，先收起模型切换那个
  closeModelPop();

  const target = DRAWER_VIEWS.includes(view) ? view : 'model';

  // 浮层每次打开都重建内容太浪费，但视图本身要立刻切好，
  // 否则会先看到上次那个视图再跳一下
  drawer.hidden = false;
  backdrop.hidden = false;
  switchDrawerView(target, opts);

  // 下一帧再加 .open，让浏览器先画出「在屏幕外」的状态，
  // 否则 transition 不会触发，浮层会「啪」地直接出现
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      drawer.classList.add('open');
      backdrop.classList.add('open');
    });
  });
}

/** 关闭设置浮层（带滑出动画） */
function closeSettings() {
  const drawer = $('#settingsDrawer');
  const backdrop = $('#settingsBackdrop');
  if (!drawer || drawer.hidden) return;

  drawer.classList.remove('open');
  backdrop.classList.remove('open');
  setTimeout(() => {
    // 动画期间可能又被打开了，所以这里要再确认一次
    if (!drawer.classList.contains('open')) {
      drawer.hidden = true;
      backdrop.hidden = true;
    }
  }, DRAWER_ANIM_MS);
}

/** 只收起会话栏（窄屏下用它；设置浮层由 closeSettings 负责） */
function closeSidebar() {
  $('.layout').classList.remove('sidebar-open');
}

function autoGrow() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
}

async function refreshInfo() {
  const data = await api('/info');
  state.info = data;
  state.autoApprove = data.autoApprove || [];
  // 顶栏、输入区的模型名都由这里统一刷新，避免多处各写一份
  syncModelLabels();
  // 推理等级的选项是按「当前协议」生成的，协议跟着设置变，所以每次刷新信息都重画一遍
  renderReasoning();
  $('#brandSub').textContent = shortPath(data.cwd, 44);
  $('#cwdLine').textContent = data.cwd;
  $('#cwdLine').title = data.cwd;
  setModelDot(data.hasApiKey || data.provider === 'ollama' ? 'ok' : '');
  // 上下文窗口来自服务端（网关给的 / 用户配的 / 推断的），用量条的分母。
  // 来源也要带上：界面上得说清这个数字可不可信
  if (data.contextWindow) {
    state.context = {
      ...(state.context || {}),
      window: data.contextWindow,
      windowSource: data.contextWindowSource || '',
    };
    renderContext();
  }
  if (!data.hasApiKey && data.provider !== 'ollama') {
    const btn = $('#btnModelSwitch');
    if (btn) btn.title = '还没配置 API Key，点右上角设置去填';
  }
  // 权限档位跟着 info 一起刷新（切换后 refreshInfo 会走到这里）
  renderApproval();
  return data;
}

/* ------------------------------------------------------------------ */
/* 事件绑定 + 启动                                                     */
/* ------------------------------------------------------------------ */

function bindUi() {
  // 发送
  $('#btnSend').addEventListener('click', sendMessage);
  $('#btnStop').addEventListener('click', abortRun);
  $('#btnAbort').addEventListener('click', abortRun);

  const input = $('#input');
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 会话
  $('#btnNew').addEventListener('click', () => newSession());
  // 侧栏的三个分区（工作区/会话/插件）可折叠，用户上次的状态记在 localStorage
  bindSidebarSections();
  // 刷新：重新拉工作区与会话（外部删了文件夹、或在别处新建了会话时用）
  $('#wsRefresh').addEventListener('click', async () => {
    await refreshWorkspaces();
    await refreshSessions();
  });
  // 新建工作区：自己选文件夹
  $('#wsAdd').addEventListener('click', () => addWorkspace());
  bindApiLibrary();
  // 已归档组：默认折起来，点标题才展开
  $('#wsArchToggle').addEventListener('click', () => {
    const body = $('#wsArchList');
    const wrap = $('#wsArchived');
    if (!body || !wrap) return;
    body.hidden = !body.hidden;
    wrap.classList.toggle('open', !body.hidden);
  });

  // 侧栏的「市场」：只是个入口，真正列表和安装都在设置浮层里
  $('#btnSideMarket').addEventListener('click', () => {
    closeModelPop();
    openSettings('market');
  });
  // 侧栏底部的「刷新 / 重扫插件」按钮已去掉：刷新本来就会在启动、切会话、
  // 跑完一轮时自动做；重扫插件在「设置 → 插件管理 → 重载」里（见上面的 btnReloadPlugins）

  // 设置浮层：顶部按钮打开，右上角 × / 遮罩 / Esc 关闭
  $('#btnSettings').addEventListener('click', () => {
    if (settingsOpen()) closeSettings();
    else openSettings('model');
  });
  $('#btnSettingsClose').addEventListener('click', closeSettings);
  $('#settingsBackdrop').addEventListener('click', closeSettings);
  $$('.drawer-tab').forEach((t) => {
    t.addEventListener('click', () => switchDrawerView(t.dataset.view));
  });

  $('#btnSidebar').addEventListener('click', () => {
    const layout = $('.layout');
    const opening = !layout.classList.contains('sidebar-open');
    layout.classList.toggle('sidebar-open', opening);
  });
  // 模型快速切换：输入区左下角的按钮（顶栏不再有模型显示，入口只有这一处）
  $('#btnModelSwitch').addEventListener('click', toggleModelPop);
  $('#btnModelRefresh').addEventListener('click', () => loadModelPopList());
  // 推理等级是上下展开的抽屉：点标题展开/收起，选完一档自动收起
  $('#reasonToggle').addEventListener('click', () => {
    const wrap = $('#modelPopReason');
    if (!wrap) return;
    const open = wrap.classList.toggle('open');
    $('#reasonToggle').setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  // 权限栏：常驻按钮 + 三档菜单
  $('#btnApproval').addEventListener('click', () => toggleComposerMenu('#approvalPop', '#btnApproval'));
  $$('#approvalPop .menu-row').forEach((row) => {
    row.addEventListener('click', () => switchApproval(row.dataset.mode));
  });
  // 附件：+ 号菜单
  $('#btnAttach').addEventListener('click', () => toggleComposerMenu('#attachPop', '#btnAttach'));
  $('#btnAttachFile').addEventListener('click', () => pickAttachment('file'));
  $('#btnAttachDir').addEventListener('click', () => pickAttachment('directory'));
  $('#btnAttachZip').addEventListener('click', () => pickAttachment('archive'));
  // 点菜单外面收起。用 contains 判断而不是给按钮 stopPropagation：
  // 后者会把事件吞掉，别处依赖冒泡的逻辑就失灵了。
  document.addEventListener('click', (e) => {
    const inMenu = ['#attachPop', '#approvalPop'].some((id) => {
      const pop = $(id);
      return pop && !pop.hidden && pop.contains(e.target);
    });
    if (inMenu) return;
    if ($('#btnAttach').contains(e.target) || $('#btnApproval').contains(e.target)) return;
    closeComposerMenus();
  });
  // 手动压缩上下文：走的是插件注册的 /compact 命令（能力只有一份实现）
  $('#btnCompact').addEventListener('click', compactContext);
  $('#btnModelMore').addEventListener('click', () => {
    closeModelPop();
    openSettings('model');
  });
  // 浮层里手打模型名，回车即切换
  $('#modelPopInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      switchModel($('#modelPopInput').value);
    }
  });
  // 边打边过滤列表（不回车也能用）：列表里只剩匹配的行，匹配到的组自动展开
  $('#modelPopInput').addEventListener('input', (e) => filterModelPopList(e.target.value));
  // 上下文圆环：悬停 / 键盘聚焦时展开具体数字。
  // 用真实事件（mouseenter/focusin）加类名，而不是纯 CSS :hover——
  // 这样自检可以派发事件验证「它真的会展开」，纯 :hover 是没法在测试里触发的。
  const ctxMeter = $('#ctxMeter');
  ctxMeter.addEventListener('mouseenter', () => ctxMeter.classList.add('open'));
  ctxMeter.addEventListener('mouseleave', () => ctxMeter.classList.remove('open'));
  ctxMeter.addEventListener('focusin', () => ctxMeter.classList.add('open'));
  ctxMeter.addEventListener('focusout', () => ctxMeter.classList.remove('open'));
  // 点到浮层外面就关掉。用 contains 判断而不是给按钮 stopPropagation：
  // 后者在点按钮时会把事件吞掉，别的地方依赖冒泡的逻辑就失灵了。
  document.addEventListener('click', (e) => {
    if (!modelPopOpen()) return;
    const pop = $('#modelPop');
    if (pop.contains(e.target)) return;
    // 顶栏的模型胶囊已经去掉，按钮只剩输入区那一处
    if ($('#btnModelSwitch').contains(e.target)) return;
    closeModelPop();
  });

  // 确认弹窗
  $('#btnAllow').addEventListener('click', () => answerApproval(true));
  $('#btnDeny').addEventListener('click', () => answerApproval(false));
  $('#approvalBackdrop').addEventListener('click', (e) => {
    if (e.target === $('#approvalBackdrop')) answerApproval(false);
  });

  // 安装弹窗
  $('#btnInstallConfirm').addEventListener('click', confirmInstall);
  $('#btnInstallCancel').addEventListener('click', () => {
    $('#installBackdrop').hidden = true;
    state.installTarget = null;
  });

  // 插件面板
  $('#btnReloadPlugins').addEventListener('click', async () => {
    try {
      const data = await api('/plugins/reload', { body: {} });
      toast(`已重载：${data.loaded} 个插件`, 'ok');
      await loadPlugins();
      await loadTools();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // 插件市场：来源切换 + 内置安装 + 本地安装（后两条都不需要联网）
  $$('#marketSrc .seg-btn').forEach((b) => {
    b.addEventListener('click', () => switchMarketSource(b.dataset.src));
  });
  bindLocalPicker();
  $('#btnLocalCheck').addEventListener('click', checkLocalPlugin);
  $('#btnLocalInstall').addEventListener('click', installLocalPlugin);

  $('#btnScaffold').addEventListener('click', async () => {    const name = $('#scaffoldName').value.trim() || `my-plugin-${Date.now().toString(36).slice(-4)}`;
    try {
      const data = await api('/plugins/scaffold', {
        body: { name, description: $('#scaffoldDesc').value.trim() },
      });
      toast(`已生成 ${data.name}，工具名 ${data.toolPrefix}_demo`, 'ok');
      $('#scaffoldName').value = '';
      $('#scaffoldDesc').value = '';
      await loadPlugins();
      await loadTools();
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // 市场
  $('#btnMarketSearch').addEventListener('click', () => marketSearch());
  $('#marketQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') marketSearch();
  });
  $$('.quick-tags .tag').forEach((tag) =>
    tag.addEventListener('click', () => {
      $('#marketQuery').value = tag.dataset.q;
      marketSearch(tag.dataset.q);
    }),
  );

  // 设置：每个分区独立保存
  $('#btnSaveModel').addEventListener('click', () => saveSettings('model'));
  $('#btnSaveBehavior').addEventListener('click', () => saveSettings('behavior'));
  $('#btnSaveWeb').addEventListener('click', () => saveSettings('web'));
  $('#setWebProvider').addEventListener('change', syncWebEndpointField);
  $('#btnSaveContext').addEventListener('click', () => saveSettings('context'));
  $('#btnTest').addEventListener('click', testConnection);

  // 阈值滑块：拖动时就把百分比显示出来，不用等保存
  $('#setCompactThreshold').addEventListener('input', (e) => {
    $('#compactThresholdLabel').textContent = `${e.target.value}%`;
  });

  // 外观：浅色 / 深色
  $$('#themeSeg .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => setTheme(btn.dataset.themeOpt));
  });

  // 「接入」弹窗里换运营商 → 自动带出该家的地址/模型/协议（省得每次手打）
  if ($('#apProvider')) {
    $('#apProvider').addEventListener('change', () => {
      const presets = {
        deepseek: ['https://api.deepseek.com/v1', 'deepseek-chat', 'openai'],
        openai: ['https://api.openai.com/v1', 'gpt-4o-mini', 'openai'],
        ollama: ['http://127.0.0.1:11434/v1', 'qwen2.5-coder:7b', 'openai'],
        custom: ['', '', 'auto'],
      };
      const p = presets[$('#apProvider').value];
      if (!p) return;
      // 只在"空着"的时候带出默认值：用户已经填过的内容不能被切运营商抹掉
      if (!$('#apBaseUrl').value.trim()) $('#apBaseUrl').value = p[0];
      if (!$('#apModel').value.trim()) $('#apModel').value = p[1];
      if (p[2] && $('#apFormat').value === 'auto') $('#apFormat').value = p[2];
      updateBaseUrlHint();
    });
  }

  // 切协议时更新地址提示，避免「选了 Anthropic 却填 chat/completions」
  if ($('#apFormat')) $('#apFormat').addEventListener('change', updateBaseUrlHint);

  // 从网关拉模型列表：手打模型名太容易错一个字符就 404
  $('#btnFetchModels').addEventListener('click', fetchModelList);

  // 复制按钮（事件委托）
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const code = btn.closest('.code-block')?.querySelector('code');
    if (!code) return;
    navigator.clipboard.writeText(code.textContent).then(
      () => {
        btn.textContent = '已复制';
        setTimeout(() => (btn.textContent = '复制'), 1500);
      },
      () => toast('复制失败', 'err'),
    );
  });

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#approvalBackdrop').hidden) {
        answerApproval(false);
        return;
      }
      if (!$('#installBackdrop').hidden) {
        $('#installBackdrop').hidden = true;
        state.installTarget = null;
        return;
      }
      // 设置浮层压在最上层，Esc 先关它
      if (settingsOpen()) {
        closeSettings();
        return;
      }
      // 模型切换浮层比设置轻，但同样按 Esc 关掉
      if (modelPopOpen()) {
        closeModelPop();
        return;
      }
      closeSidebar();
    }
    // Ctrl+K 新会话
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      newSession();
    }
    // Ctrl+, 打开设置（和大多数编辑器一致）
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      if (settingsOpen()) closeSettings();
      else openSettings('model');
    }
  });

  window.addEventListener('resize', () => {
    if (window.innerWidth > 1180) $('.layout').classList.remove('sidebar-open');
  });
}

/**
 * 桌面程序专属的接线。
 * 同一个页面既能在浏览器里跑，也能在 Electron 窗口里跑：
 * 桌面模式下 preload 会注入 window.myaDesktop，我们据此启用额外能力。
 */
function bindDesktop() {
  const d = window.myaDesktop;
  if (!d || !d.isDesktop) return;

  document.body.classList.add('is-desktop');

  // 主进程菜单里的动作
  if (typeof d.onMenu === 'function') {
    d.onMenu((payload) => {
      const action = payload && payload.action;
      if (action === 'new-session') newSession();
    });
  }

  // 无边框窗口：自己接窗口按钮
  if (d.window) {
    const bind = (sel, fn) => {
      const el = $(sel);
      if (el) el.addEventListener('click', fn);
    };
    bind('#winMin', () => d.window.minimize());
    bind('#winMax', () => d.window.toggleMaximize());
    bind('#winClose', () => d.window.close());

    // 最大化状态变了就换个图标（最大化时显示「还原」的双层方框）
    if (typeof d.window.onMaximizeChange === 'function') {
      d.window.onMaximizeChange((isMax) => {
        const btn = $('#winMax');
        if (!btn) return;
        btn.title = isMax ? '还原' : '最大化';
        btn.innerHTML = isMax
          ? '<svg viewBox="0 0 12 12"><rect x="3" y="1" width="8" height="8" rx="1.2"/><path d="M9 9v1.6a.4.4 0 0 1-.4.4H1.4a.4.4 0 0 1-.4-.4V3.4a.4.4 0 0 1 .4-.4H3"/></svg>'
          : '<svg viewBox="0 0 12 12"><rect x="1.2" y="1.2" width="9.6" height="9.6" rx="1.4"/></svg>';
      });
    }
  }

  // 桌面程序里的窗口按钮（最小化/最大化/关闭）。
  // 那行「Enter 发送 · Shift+Enter 换行」的提示已经去掉了——
  // 输入区现在挤了「附件 + 权限 + 模型」三个控件，快捷键提示属于可以省掉的话。
}

/**
 * 启动流程。
 *
 * 每走完一步都在 <body> 上打个标记（data-boot）。
 * 这不是多余的——启动过程里有好几个 await，任何一步抛错都会让后面的步骤
 * 静默不执行，界面上却「看起来还行」。有了这个标记，出问题时一眼就能看出
 * 卡在哪一步（`mya desktop --selftest` 会读它）。
 */
async function boot() {
  const mark = (step) => document.body.setAttribute('data-boot', step);

  mark('trace');
  traceStart();

  mark('theme');
  // 主题：内联脚本已经在渲染前设过一次，这里再走一遍是为了
  // 把当前选择同步给主进程（窗口边框颜色）并装好按钮提示
  initTheme();

  mark('bind');
  bindUi();
  bindDesktop();
  connectEvents();

  mark('info');
  try {
    await refreshInfo();
  } catch (err) {
    mark('info-failed');
    toast(`无法连接服务端：${err.message}`, 'err');
    return;
  }

  mark('workspace');
  await loadSidebarPlugins();

  mark('sessions');
  await loadSessions();

  // 恢复上次的会话，没有就新建一个。
  // 会话列表现在包含磁盘上的历史会话，所以关掉程序再打开，上次的对话还在。
  const saved = localStorage.getItem('mya.session');
  const exists = saved && state.sessions.some((s) => s.id === saved);
  if (exists) {
    await switchSession(saved);
  } else {
    // 启动时自动建会话不弹「选目录」——开机就弹窗很烦人
    await newSession({ silent: true });
  }

  mark('settings');
  // 设置浮层默认是关着的，但表单先填好：
  // 用户点「设置」时立刻就能看到当前配置，不用等一次请求。
  await loadSettings();

  // 没配 Key 时主动提醒一次
  if (state.info && !state.info.hasApiKey && state.info.provider !== 'ollama') {
    setTimeout(() => {
      toast('还没配置 API Key，在设置里填一下就能开始对话', 'warn');
    }, 600);
  }

  autoGrow();
  $('#input').focus();
  mark('done');
}

boot().catch((err) => {
  console.error(err);
  document.body.setAttribute('data-boot', `error:${err && err.message}`);
  toast(`启动失败：${err.message}`, 'err');
});
