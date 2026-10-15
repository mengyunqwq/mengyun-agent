'use strict';

/**
 * 梦云 Agent —— 前端一致性检查
 *
 * 单页应用最常见的低级 bug 就是「JS 里写了一个 HTML 里不存在的 id」，
 * 这种错误在浏览器控制台里只表现为一句 undefined，很容易漏掉。
 * 这个脚本静态地把两边对一遍，不需要启动浏览器。
 *
 * 用法：node test/web-check.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');

const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(WEB, 'app.css'), 'utf8');

const results = [];
const check = (name, fn) => {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `\x1b[90m — ${detail}\x1b[0m` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, error: err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${err.message}\x1b[0m`);
  }
};

const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log('\n\x1b[1m\x1b[35m前端一致性检查\x1b[0m\n');

/* ---------------- id 引用一致性 ---------------- */

const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const jsIds = new Set();
// $('#xxx') 形式
for (const m of js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) jsIds.add(m[1]);
for (const m of js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) jsIds.add(m[1]);
// $('#toasts') 这类在模板字符串里也算了，上面正则已覆盖

check('JS 引用的 DOM id 在 HTML 中都存在', () => {
  const missing = [...jsIds].filter((id) => !htmlIds.has(id));
  assert(missing.length === 0, `以下 id 在 index.html 里找不到：${missing.join(', ')}`);
  return `核对 ${jsIds.size} 个 id`;
});

check('HTML 里的关键容器都存在', () => {
  const required = [
    'messages', 'input', 'btnSend', 'btnStop', 'toasts',
    // 设置现在是一个按钮打开的浮层
    'btnSettings', 'settingsDrawer', 'settingsBackdrop', 'btnSettingsClose',
    'pluginList', 'marketList', 'toolList',
    // 上下文用量
    // 上下文用量：圆环 + 悬停才出现的气泡
    'ctxMeter', 'ctxFill', 'ctxText', 'ctxTip', 'ctxSub',
    // 模型列表：手打模型名太容易错一个字符，得有「获取列表」的入口
    // 这些现在住在「新建接入」弹窗里（接入信息统一在弹窗填）
    'btnFetchModels', 'modelList', 'modelOptions', 'apFormat',
    // 输入区的模型快速切换
    'btnModelSwitch', 'composerModelName', 'modelPop', 'modelPopList',
    'modelPopInput', 'modelPopOptions', 'btnModelRefresh', 'btnModelMore',
  ];
  const missing = required.filter((id) => !htmlIds.has(id));
  assert(missing.length === 0, `缺少容器：${missing.join(', ')}`);
  return `${htmlIds.size} 个 id`;
});

/* ---------------- class 引用一致性 ---------------- */

check('JS 操作的主要 class 在 HTML 或 CSS 中有定义', () => {
  // JS 里动态创建的元素，class 必须能在 CSS 里找到样式，否则会「看起来没生效」
  const usedInJs = [
    'session-item', 'block', 'bubble', 'assistant-body', 'plain', 'tool-head', 'tool-body',
    'tool-name', 'tool-args', 'tool-meta', 'tool-status', 'tool-chevron', 'tool-clip-note',
    'state-dot', 'spinner-mini', 'caret', 'reasoning-head', 'reasoning-icon', 'reasoning-title',
    'error-card', 'summary', 'thinking', 'queued-note', 'approval-card',
    'code-block', 'code-block-head', 'copy-btn', 'diff', 'add', 'del',
    'toast', 'card', 'card-head', 'card-title', 'card-actions', 'badge',
    'repo-card', 'repo-head', 'repo-name', 'repo-desc', 'repo-meta', 'stars',
    'file-list', 'file-row', 'warn-line', 'install-plan', 'modal-check', 'notice',
    'meta-row', 'meta-line', 'tool-pill', 'placeholder', 'skeleton', 'empty', 'chip',
    'drawer-tab', 'drawer-view',
  ];
  const missing = usedInJs.filter((cls) => !css.includes(`.${cls}`));
  assert(missing.length === 0, `以下 class 在 app.css 里没有样式定义：${missing.join(', ')}`);
  return `核对 ${usedInJs.length} 个 class`;
});

/* ---------------- 设置浮层 ---------------- */

check('设置里的每个视图都有对应的面板', () => {
  const tabs = [...html.matchAll(/data-view="([^"]+)"/g)].map((m) => m[1]);
  assert(tabs.length > 0, '没有找到设置视图');
  // 导航按钮和内容面板共用 data-view，所以每个名字都应该出现两次
  const counts = {};
  for (const t of tabs) counts[t] = (counts[t] || 0) + 1;
  const bad = Object.entries(counts).filter(([, n]) => n !== 2).map(([k, n]) => `${k}(${n} 次)`);
  assert(bad.length === 0, `这些视图缺按钮或面板：${bad.join('、')}`);
  return `${Object.keys(counts).length} 个视图：${Object.keys(counts).join(' / ')}`;
});

check('设置默认是收起的（不占页面）', () => {
  // 用户明确要求：设置点开才显示，不要一直占着页面
  const drawer = /<aside class="drawer"[^>]*>/.exec(html);
  assert(drawer, '找不到设置浮层');
  assert(/\bhidden\b/.test(drawer[0]), '设置浮层默认应该是隐藏的');
  assert(/\.drawer\[hidden\]\s*\{\s*display:\s*none/.test(css), '浮层用了 flex，[hidden] 必须显式覆盖成 display:none');
  return '默认 hidden，由顶部按钮打开';
});

check('界面里没有遗留的占位符文本', () => {
  // 只在 HTML 的可见文本里找；JS 源码里出现 undefined 是合法的（比较、属性访问）
  const bad = ['TODO', 'FIXME', 'lorem ipsum', '待补充', 'xxx占位'];
  const found = bad.filter((w) => html.toLowerCase().includes(w.toLowerCase()));
  assert(found.length === 0, `发现占位符：${found.join(', ')}`);
});

/* ---------------- 安全性静态检查 ---------------- */

check('innerHTML 插入的动态内容都经过转义', () => {
  const lines = js.split('\n');
  const risky = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('.innerHTML')) continue;

    // 把这次赋值涉及的所有行收集起来（模板字符串可能跨行）。
    // 判定标准：从这一行开始持续往后读，直到引号/反引号闭合。
    let chunk = lines[i];
    let j = i;
    const countQuotes = (s) => (s.match(/`/g) || []).length;
    const countSingle = (s) => (s.match(/'/g) || []).length;
    const countDouble = (s) => (s.match(/"/g) || []).length;

    const needBacktick = countQuotes(chunk) % 2 === 1;
    const needSingle = !needBacktick && countSingle(chunk) % 2 === 1;
    const needDouble = !needBacktick && !needSingle && countDouble(chunk) % 2 === 1;

    // 往下读，直到引号闭合（三个 needX 在循环里不会变，闭合时靠下面的 break 退出，
    // 所以循环条件里不再重复判断它们——否则就是「条件永远不变」的死写法）
    if (needBacktick || needSingle || needDouble) {
      while (j + 1 < lines.length && j - i < 60) {
        j += 1;
        chunk += `\n${lines[j]}`;
        if (needBacktick && countQuotes(chunk) % 2 === 0) break;
        if (needSingle && countSingle(chunk) % 2 === 0) break;
        if (needDouble && countDouble(chunk) % 2 === 0) break;
      }
    }

    // 纯静态 HTML（没有任何 ${} 插值）不构成风险
    if (!chunk.includes('${')) continue;
    // 插值处用了转义函数就算安全
    if (/escapeHtml|renderMarkdown|toolCardHtml|emptyStateHtml|pluginCard|repoCard|diffHtml/.test(chunk)) continue;

    // 只插数字/长度的无害表达式也放过（例如 ${files.length} 个文件）
    const interpolations = [...chunk.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1].trim());
    const harmless = interpolations.every((expr) => /^[\w.]*(length|size|count|ms|\d+)[\w.\s*+-]*$/.test(expr) || /^\d+$/.test(expr));
    if (harmless && interpolations.length) continue;

    risky.push(`第 ${i + 1} 行: ${lines[i].trim().slice(0, 90)}`);
    i = j; // 跳过已经检查过的行
  }

  assert(risky.length === 0, `以下位置插入了未转义的动态内容：\n      ${risky.join('\n      ')}`);
});

check('Markdown 渲染会转义 HTML（防 XSS）', () => {
  assert(/function renderMarkdown/.test(js), '找不到 renderMarkdown');
  assert(/escapeHtml\(work\)/.test(js), 'renderMarkdown 里应该先 escapeHtml 再插标签');
  assert(!/innerHTML\s*=\s*[^;]*\$\{text\}/.test(js), '不应该把原始 text 直接塞进 innerHTML');
});

check('外链带了 noopener（防 tabnabbing）', () => {
  const links = [...js.matchAll(/<a [^>]*target="_blank"[^>]*>/g)].map((m) => m[0]);
  assert(links.length > 0, '应该有外链');
  const bad = links.filter((l) => !l.includes('noopener'));
  assert(bad.length === 0, `以下外链缺少 noopener：${bad.join(' | ')}`);
  return `${links.length} 个外链`;
});

/* ---------------- 资源完整性 ---------------- */

check('index.html 引用的资源文件都存在', () => {
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
  const missing = refs.filter((r) => !fs.existsSync(path.join(WEB, r.replace(/^\//, ''))));
  assert(missing.length === 0, `找不到文件：${missing.join(', ')}`);
  return refs.join(', ');
});

check('CSS 里的变量都有定义', () => {
  const defined = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]));
  const missing = [...used].filter((v) => !defined.has(v));
  assert(missing.length === 0, `使用了未定义的变量：${missing.join(', ')}`);
  // 同时检查 JS 里内联样式用到的变量
  const usedInJs = new Set([...js.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1]));
  const missingJs = [...usedInJs].filter((v) => !defined.has(v));
  assert(missingJs.length === 0, `JS 里使用了未定义的变量：${missingJs.join(', ')}`);
  return `${defined.size} 个变量`;
});

/* ---------------- 主题 ---------------- */

check('浅色和深色两套主题都定义了完整变量', () => {
  // 浅色是 :root，深色是 :root[data-theme='dark']。
  // 关键：深色没覆盖的变量会从浅色继承——如果颜色类变量漏了，
  // 深色界面里就会突然冒出白块，那种 bug 很难一眼看出来。
  const blocks = [...css.matchAll(/:root(\[data-theme='dark'\])?\s*\{([^}]*)\}/g)];
  assert(blocks.length >= 2, `应该有两套主题定义，实际找到 ${blocks.length} 个 :root 块`);

  const light = new Set();
  const dark = new Set();
  for (const b of blocks) {
    const isDark = !!b[1];
    for (const m of b[2].matchAll(/--([a-z0-9-]+)\s*:/g)) {
      (isDark ? dark : light).add(m[1]);
    }
  }
  assert(light.size > 10, `浅色主题变量太少：${light.size}`);

  // 颜色类变量必须在深色里也覆盖一遍，否则会串色。
  // 例外：--acc-dim / --acc-soft 是由 --acc 用 color-mix 派生的，
  // 派生变量的取值会自动跟着 --acc 变，不需要（也不该）两处都写。
  const DERIVED = ['acc-dim', 'acc-soft'];
  const colorVars = [...light].filter(
    (v) => /^(bg|fg|line|acc|purple|blue|green|yellow|orange|red|shadow)/.test(v) && !DERIVED.includes(v),
  );
  const missing = colorVars.filter((v) => !dark.has(v));
  assert(
    missing.length === 0,
    `这些颜色变量在深色主题里没有覆盖，深色下会串色：${missing.join(', ')}`,
  );
  return `浅色 ${light.size} 个 / 深色 ${dark.size} 个`;
});

check('主题切换的初始化脚本在样式表之前', () => {
  // 主题和主题色都必须在首次渲染前定下来，否则会闪一下默认色。
  // 所以这段内联脚本要排在 <link rel=stylesheet> 前面，且不能带 defer/async。
  const scriptIdx = html.indexOf("localStorage.getItem('mya.theme')");
  const cssIdx = html.indexOf('rel="stylesheet"');
  assert(scriptIdx !== -1, 'index.html 里找不到主题初始化脚本');
  assert(cssIdx !== -1, 'index.html 里找不到样式表引用');
  assert(scriptIdx < cssIdx, '主题脚本必须在样式表之前执行，否则会闪色');

  // 只看承载这段代码的那个 <script ...> 开标签本身，
  // 不能把周围的注释也算进来（注释里提到 defer 是正常的）
  const openTag = html.lastIndexOf('<script', scriptIdx);
  assert(openTag !== -1, '找不到主题脚本的 <script> 标签');
  const tag = html.slice(openTag, html.indexOf('>', openTag) + 1);
  assert(!/defer|async/.test(tag), `主题脚本的标签不能带 defer/async：${tag}`);
  return '内联在样式表之前';
});

check('主题色在渲染前也被应用（避免闪色）', () => {
  // 只设 data-theme 不够：主色是行内样式覆盖上去的，
  // 如果不在渲染前设好，打开时会先闪一下默认的青色。
  const scriptIdx = html.indexOf("localStorage.getItem('mya.theme')");
  const scriptEnd = html.indexOf('</script>', scriptIdx);
  const script = html.slice(scriptIdx, scriptEnd);
  assert(script.includes("localStorage.getItem('mya.accent')"), '内联脚本应该读取保存的主题色');
  assert(script.includes("setProperty('--acc'"), '内联脚本应该设置 --acc');
  assert(script.includes("setProperty('--acc-strong'"), '内联脚本应该设置 --acc-strong');
  return '主题 + 主题色都在渲染前设好';
});

check('主题色色板数据定义完整', () => {
  const { js: jsText } = { js };
  // ACCENTS 里每一项必须有 key、name 和浅色/深色两套取值
  const block = /const ACCENTS = \[([\s\S]*?)\n\];/.exec(jsText);
  assert(block, 'app.js 里找不到 ACCENTS 定义');
  const items = [...block[1].matchAll(/key:\s*'([a-z]+)'/g)].map((m) => m[1]);
  assert(items.length >= 6, `主题色太少了：${items.length} 个`);

  for (const key of items) {
    const line = block[1].split('\n').find((l) => l.includes(`key: '${key}'`));
    assert(/name:\s*'[^']+'/.test(line), `${key} 缺少中文名`);
    assert(/light:\s*\[\s*'#[0-9a-f]{6}',\s*'#[0-9a-f]{6}',\s*'#[0-9a-f]{6}'/.test(line), `${key} 的浅色取值不完整`);
    assert(/dark:\s*\[\s*'#[0-9a-f]{6}',\s*'#[0-9a-f]{6}',\s*'#[0-9a-f]{6}'/.test(line), `${key} 的深色取值不完整`);
  }

  // 内联脚本那份（只存取值）必须和 ACCENTS 对得上，否则首屏和切换后颜色会不一致
  const inline = /var ACCENTS = \{([\s\S]*?)\n    \};/.exec(html);
  assert(inline, 'index.html 里找不到内联的 ACCENTS');
  for (const key of items) {
    assert(inline[1].includes(`${key}: [`), `内联 ACCENTS 里缺少 ${key}（两处必须一致）`);
  }
  return `${items.length} 个颜色，两处定义一致`;
});

check('设置浮层包含要求的几个分区', () => {
  // 用户要求「插件和接入 API 写进设置」以及「设置里能切主题颜色」，
  // 后来又把设置改成点按钮才打开的浮层（不再常驻页面）
  const drawer = /<aside class="drawer"[\s\S]*?<\/aside>/.exec(html);
  assert(drawer, '找不到设置浮层');
  const body = drawer[0];
  for (const id of [
    'section-model', 'section-plugins', 'section-market',
    'section-appearance', 'section-behavior', 'section-about',
    // 上下文用量与压缩策略
    'section-context',
  ]) {
    assert(body.includes(`id="${id}"`), `设置里缺少分区：${id}`);
  }
  assert(body.includes('id="accentSwatches"'), '设置里缺少主题色选择器');
  assert(body.includes('id="pluginList"'), '插件管理应该收进设置里');
  assert(body.includes('id="toolList"'), '工具清单应该收进设置里');
  // 接入收在「模型与 API」里：浮层内是「接入运营商」下拉；
  // 填 Key 的弹窗在浮层外面（文档级 modal），那一半由「接入运营商」那条断言负责
  assert(
    body.includes('id="apSelect"') && body.includes('id="section-access"'),
    '接入要收在「模型与 API」里：接入运营商下拉',
  );
  assert(body.includes('id="setContextWindow"'), '设置里应该能改上下文窗口大小');
  assert(body.includes('id="setCompactThreshold"'), '设置里应该能改压缩阈值');
  return '模型接入 / 插件管理 / 插件市场 / 外观 / 行为安全 / 关于';
});

check('上下文用量是个圆环，具体数字悬停才出现', () => {
  // 用户要求「上下文改成圆圈显示，鼠标放上去再出现具体」
  assert(html.includes('id="ctxMeter"'), '缺少上下文用量容器');
  assert(html.includes('id="ctxFill"'), '圆环需要一个能画进度的圈');
  assert(html.includes('id="ctxText"'), '悬停气泡里要有具体数字');
  assert(html.includes('id="ctxTip"'), '缺少悬停用的气泡容器');
  assert(css.includes('.ctx-ring') && css.includes('.ctx-fill'), '圆环没有样式');
  assert(/\.ctx-fill\s*\{/.test(css), '圆环的进度圈没有样式');
  // 分档变色必须还在：宽裕 / 需要注意 / 快满了（挂在容器上，圆环跟着变色）
  assert(
    css.includes('.ctx-meter.warn .ctx-fill') && css.includes('.ctx-meter.danger .ctx-fill'),
    '圆环应该分档变色',
  );
  // 「鼠标放上去才出现」这件事得能验证：靠 .open 类控制，
  // 自检可以派发 mouseenter 验证它真的会展开（纯 :hover 在测试里触发不了）
  assert(/\.ctx-meter\.open \.ctx-tip/.test(css), '气泡没有「展开」的样式规则');
  assert(/addEventListener\('mouseenter'[\s\S]{0,80}classList\.add\('open'\)/.test(js), '悬停时没有把它展开');
  // 「压缩上下文」入口跟着用量走，必须还在这个容器里
  assert(/id="btnCompact"/.test(html), '缺少「压缩上下文」按钮');
  return '圆环进度 + 悬停气泡 + 分档配色';
});

check('思考内容有独立的可折叠样式', () => {
  // 用户要求「思考内容做得像 codex 一样」——核心就是独立成块 + 可折叠
  assert(css.includes('.block.reasoning'), '缺少思考块的样式');
  assert(css.includes('.block.reasoning.collapsed .reasoning-body'), '思考块应该能折叠');
  assert(js.includes("case 'reasoning'"), '前端没有处理 reasoning 块');
  assert(js.includes('.reasoning.streaming'), '应该跟踪思考的流式状态');
  return '独立成块 + 默认折叠';
});

check('模型列表：能拉取、能点选、能标记非对话模型', () => {
  // 用户要求「不能直接获取模型吗」——手打模型名错一个字符就 404
  assert(js.includes('fetchModelList'), '缺少拉取模型列表的实现');
  assert(js.includes("api('/models'"), '应该调用 /api/models');
  // 图像/视频/向量类模型不支持工具调用，要标出来
  assert(/nonChat|非对话/.test(js + css), '应该标记出非对话模型（它们不支持工具调用）');
  assert(css.includes('.model-chip'), '模型标签缺少样式');
  // 拉取失败不能阻断用户——很多自建网关没有 /models
  assert(/拉取失败|手动填/.test(js), '拉取失败时应提示可以手填');
  return '一键拉取 + 点选 + 非对话标记';
});

check('输入区有换模型的按钮，点开是一个浮层', () => {
  // 用户要求「在对话框位置添加一个更换模型的按钮」。
  // 要点：按钮必须真的在输入区里（不是又藏进设置），浮层默认收起，
  // 而且切换时只提交 model 一个字段——不能顺手把地址/密钥覆盖掉。
  const composer = /<div class="composer">[\s\S]*?<\/div>\s*<\/section>/.exec(html);
  assert(composer, '找不到输入区');
  assert(composer[0].includes('id="btnModelSwitch"'), '输入区里没有换模型的按钮');
  assert(composer[0].includes('id="modelPop"'), '模型切换浮层应该在输入区附近');

  const pop = /<div class="model-pop" id="modelPop"[^>]*>/.exec(html);
  assert(pop, '找不到模型切换浮层');
  assert(/\bhidden\b/.test(pop[0]), '模型浮层默认应该是收起的');
  assert(
    /\.model-pop\[hidden\]\s*\{\s*display:\s*none/.test(css),
    '浮层用了 flex，[hidden] 必须显式覆盖成 display:none',
  );

  // 切换动作必须存在，而且是「只发 model」
  assert(/function switchModel/.test(js), '缺少切换模型的实现');
  // 展开式列表里点一行就切（原来是点一个小标签）
  assert(/switchModel\(id\)/.test(js), '模型那一行点了应该直接切换');
  assert(/api\('\/settings',\s*\{\s*body:\s*\{\s*model\s*\}\s*\}\)/.test(js), '切换模型时只应该提交 model 字段');
  assert(js.includes("MODEL_CACHE_KEY"), '应该缓存模型列表，省得每次点开都等一次请求');
  assert(/currentModel\(\)/.test(js), '应该以服务端返回的模型名为准');

  // 展开式：按前缀分组、每组可折叠、输入框能过滤
  assert(/function groupModels/.test(js), '缺少按前缀分组的实现');
  assert(/function filterModelPopList/.test(js), '缺少输入过滤的实现');
  assert(html.includes('class="model-list model-tree"'), '模型列表应该用展开式的树形容器');
  const treeClasses = ['.model-tree', '.model-group', '.model-group-head', '.model-group-body', '.model-row', '.model-row.active'];
  const noStyle = treeClasses.filter((cls) => !css.includes(cls));
  assert(noStyle.length === 0, `展开式列表这些 class 没有样式：${noStyle.join(', ')}`);
  assert(/\.model-group\.open \.model-group-body/.test(css), '分组的折叠/展开没有样式规则');

  // 模型名**后面**那个圆点（原来那里是个下拉箭头，用户嫌它糊成一小坨）
  assert(html.includes('id="composerDot"'), '模型名后面应该是个圆点');
  assert(
    /id="composerModelName"[\s\S]{0,120}id="composerDot"/.test(html),
    '圆点要在模型名后面（顺序反了就不是用户要的那个位置）',
  );
  assert(!/id="btnModelSwitch"[\s\S]{0,200}<svg/.test(html), '模型按钮里不该再有箭头/盾牌之类的图标');
  assert(/function setModelDot[\s\S]{0,220}composerDot/.test(js), '两处状态点要一起变颜色');
  assert(/\.dot\s*\{[^}]*border-radius:\s*50%/.test(css), '状态点必须是圆的');

  // 新加的 class 必须真的有样式，否则会「看起来没生效」
  const missing = ['.model-btn', '.model-pop', '.model-pop-head', '.model-pop-cur', '.model-pop-foot']
    .filter((cls) => !css.includes(cls));
  assert(missing.length === 0, `以下 class 没有样式：${missing.join(', ')}`);
  assert(/\.hint-left\s*\{/.test(css), '输入区提示行的左半部分缺样式');
  return '输入区按钮 + 收起式浮层 + 单字段切换';
});

check('输入区是 Codex 那种「一个框」，顶栏有会话标题', () => {
  // 这里只做静态检查（真实 DOM 里的包含关系与尺寸由 desktop 自检去量）：
  // 目的是一旦有人把工具条挪出圆角框、或把顶栏标题删了，能立刻报出来。
  const missing = ['.top-title', '.composer-bar', '.composer-bar-right'].filter((c) => !css.includes(c));
  assert(missing.length === 0, `以下 class 没有样式：${missing.join(', ')}`);
  assert(html.includes('id="topTitle"'), '顶栏缺少会话标题容器');
  assert(/function setTopTitle/.test(js), '缺少设置顶栏标题的实现');

  // 顺序必须「输入框 → 框内工具条（模型按钮 → 累计用量 → 上下文圆环 → 发送键）」。
  // 上下文那个圆环现在也在框里（用户要求改成圆圈、悬停才展开），
  // 所以它排在发送键前面——用量属于「输入区这一行」的一部分。
  const order = [
    'id="input"',
    'composer-bar',
    'id="btnModelSwitch"',
    'id="usageHint"',
    'id="ctxMeter"',
    'id="btnSend"',
  ];
  const at = order.map((needle) => html.indexOf(needle));
  assert(at.every((i) => i > -1), `输入区里缺元素：${order.filter((n, i) => at[i] === -1).join(', ')}`);
  for (let i = 1; i < at.length; i += 1) {
    assert(at[i] > at[i - 1], `输入区的顺序不对（${order[i - 1]} 应该在 ${order[i]} 之前）`);
  }
  return '框内工具条 + 顶栏会话标题 + 圆环在框里';
});

check('侧栏不再有「刷新 / 重扫插件」这两个按钮', () => {
  // 用户明确要求去掉：刷新在启动/切会话/跑完一轮时本来就会自动做，
  // 重扫插件在「设置 → 插件管理 → 重载」里。这条断言是防止有人「顺手加回来」。
  const gone = ['btnRefresh', 'btnRescan', 'side-actions'];
  const back = gone.filter((name) => html.includes(name) || js.includes(name));
  assert(back.length === 0, `这些应该已经被删掉：${back.join(', ')}`);
  // 插件重载的入口必须还在（只是搬到了设置里）
  assert(html.includes('id="btnReloadPlugins"'), '设置里缺少「重载插件」入口');
  assert(/btnReloadPlugins'\)\.addEventListener/.test(js), '「重载插件」按钮没有绑事件');
  return '侧栏干净，重载入口在设置里';
});

check('顶栏不显示模型，侧栏是「工作区 / 会话 / 插件」三分区', () => {
  // ① 顶栏的模型胶囊（#modelChip + #modelDot + #modelName）整块去掉：
  //    它和输入区左下角的模型按钮是重复入口，而模型名一长还会把「设置」挤偏。
  //    防回归：既不能出现在 HTML 里，JS 里也不能再引用它。
  const back = ['id="modelChip"', 'id="modelDot"', 'id="modelName"', "modelChip'"].filter((n) => html.includes(n) || js.includes(n));
  assert(back.length === 0, `顶栏的模型显示应该删干净：${back.join(', ')}`);
  // 模型的唯一常驻住处仍必须在输入区里
  assert(html.includes('id="composerModelName"') && html.includes('id="btnModelSwitch"'), '输入区的模型按钮还在吗？');

  // ② 侧栏两段：工作区（= 文件夹，会话挂在下面）与插件。
  //    会话不再单独占一段——同一个东西不重复出现。
  for (const id of ['wsSection', 'pluginSection', 'wsList', 'wsAdd', 'wsRefresh', 'wsArchived', 'wsArchList', 'sidebarPlugins', 'btnSideMarket']) {
    assert(html.includes(`id="${id}"`), `侧栏缺少 ${id}`);
  }
  assert(
    !html.includes('id="sessionSection"') && !html.includes('id="wsTree"'),
    '旧的「会话」分区和文件树容器应当已经去掉（工作区树取代了它们）',
  );
  assert(/function renderWorkspaces/.test(js), '缺少工作区树的实现');
  assert(/function refreshWorkspaces/.test(js), '缺少拉取工作区列表的实现');
  assert(/function addWorkspace/.test(js), '缺少「新建工作区」的实现');
  assert(/function setArchived/.test(js), '缺少归档的实现');
  assert(/function loadSidebarPlugins/.test(js), '缺少侧栏插件列表的实现');
  assert(/bindSidebarSections/.test(js), '分区折叠没有绑定');

  // ③ 后端的文件树接口要真的存在，并且有路径约束（以会话工作目录为根）
  const server = fs.readFileSync(path.join(ROOT, 'src', 'web', 'server.js'), 'utf8');
  assert(server.includes('POST /api/fs/list'), '服务端缺少工作区文件树接口');
  const routeText = server.slice(server.indexOf("case 'POST /api/fs/list'"), server.indexOf("case 'POST /api/fs/list'") + 3200);
  assert(/path\.relative/.test(routeText), '文件树接口应该用 path.relative 算 containment');
  assert(
    /startsWith\('\.\.'\)/.test(routeText) && /只能查看工作目录/.test(routeText),
    '文件树接口没有「只能看工作目录里面」的拒绝分支',
  );
  // 缺会话/目录都不该 500：侧栏是常驻区域，报错要能被 UI 画出来
  assert(/missing: true/.test(routeText), '工作目录不存在时应返回 missing 标记（前端好引导重建会话）');
  return '顶栏只留标题，侧栏三分区带目录树';
});

check('并行子任务：调度器/工具/配置/界面/提示词 都到位', () => {
  // 这个功能横跨五个地方，任何一处漏了都会表现成「功能时灵时不灵」，
  // 所以用一组静态断言把它们钉在一起。
  const server = fs.readFileSync(path.join(ROOT, 'src', 'web', 'server.js'), 'utf8');
  const agent = fs.readFileSync(path.join(ROOT, 'src', 'agent.js'), 'utf8');
  const tasksJs = fs.readFileSync(path.join(ROOT, 'src', 'tasks.js'), 'utf8');
  const taskTools = fs.readFileSync(path.join(ROOT, 'src', 'tools', 'task.js'), 'utf8');
  const cfgJs = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8');
  const prompt = fs.readFileSync(path.join(ROOT, 'prompts', 'system.zh.md'), 'utf8');

  // ① 四个工具都在，而且都是「不用问用户」+「同轮串行」
  for (const name of ['task_spawn', 'task_wait', 'task_status', 'task_cancel']) {
    assert(taskTools.includes(`name: '${name}'`), `缺少工具 ${name}`);
  }
  assert((taskTools.match(/autoApprove: true/g) || []).length >= 4, '任务工具都该标 autoApprove（不然每次都弹确认）');
  assert((taskTools.match(/sequential: true/g) || []).length >= 4, '任务工具都该标 sequential（不然同轮 spawn/wait 会抢跑）');
  assert(/subtask-result/.test(taskTools), '摘要要有边界标记（防提示词注入）');

  // ② 调度器里的硬约束
  for (const key of ['maxParallel', 'maxDepth', 'subTimeoutSec', 'budgetTurns', 'budgetTokens', 'readonlyTools']) {
    assert(tasksJs.includes(key), `调度器缺少约束：${key}`);
  }
  assert(/cancelAll\(/.test(tasksJs) && /closeParent\(/.test(tasksJs), '缺「父任务结束就收掉子任务」的实现（僵尸子任务防线）');
  assert(/clone\(/.test(tasksJs) || /clone\(/.test(require('fs').readFileSync(path.join(ROOT, 'src', 'tools.js'), 'utf8')), '缺工具集掩码（子任务只读的落点）');

  // ③ agent 侧：串行判定 + 深度的透传 + 收尾级联
  assert(/sequential/.test(agent), 'agent 没有处理 sequential 标志');
  assert(/wantsSequential/.test(agent), 'agent 缺「含串行工具就整轮顺序执行」的判定');
  assert(/tasks: this\.tasks/.test(agent), 'agent 没有把 tasks 传进工具上下文');
  assert(/closeParent\(runId/.test(agent), 'agent 收尾时没有收掉子任务');

  // ④ 配置默认值必须保守
  assert(/tasks: \{/.test(cfgJs), 'config.js 里没有 tasks 默认块');
  assert(/readonlyTools: \['read', 'glob', 'grep'\]/.test(cfgJs), 'tasks 默认工具集应该是只读三件套');

  // ⑤ 界面：任务块有渲染、有样式、有增量更新
  assert(/case 'task'/.test(js), '前端 renderBlock 没有处理 task 块');
  assert(/renderTaskBlock/.test(js), '缺少任务块渲染函数');
  assert(/case 'task_update'/.test(js), '前端没有处理 task_update（进度不刷新）');
  assert(/case 'task_usage'/.test(js), '前端没有把子任务 token 计入显示');
  assert(/\.block\.task/.test(css), '缺少任务块样式');

  // ⑥ web 服务端：延迟创建 agent 时必须一起接上调度器
  assert(/tasks: app\.tasks/.test(server), 'ensureAgent 里没有把调度器接给 agent（设置里配完 Key 之后功能会失效）');

  // ⑦ 提示词里要有使用说明，否则模型根本不知道有这个能力
  assert(/task_spawn/.test(prompt) && /task_wait/.test(prompt), '系统提示词没写拆分任务怎么用');

  return '调度器/工具/配置/界面/提示词 五处齐备';
});

check('输入区：权限三档 + 附件加号 + 推理等级抽屉', () => {
  const tools = fs.readFileSync(path.join(ROOT, 'src', 'tools.js'), 'utf8');
  const cfgJs = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8');
  const preload = fs.readFileSync(path.join(ROOT, 'desktop', 'preload.js'), 'utf8');
  const mainJs = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');

  // ① 权限三档：UI 控件 + 服务端读写 + 工具层判定
  for (const id of ['btnApproval', 'approvalLabel', 'approvalPop', 'btnAttach', 'attachPop', 'reasonToggle', 'reasonLevels']) {
    assert(html.includes(`id="${id}"`), `输入区缺少 ${id}`);
  }
  for (const mode of ['ask', 'workspace', 'full']) {
    assert(html.includes(`data-mode="${mode}"`), `权限菜单缺少「${mode}」这一档`);
  }
  assert(/APPROVAL_MODES = \['ask', 'workspace', 'full'\]/.test(tools), '档位取值没有集中定义');
  assert(/function approvalMode/.test(tools), '缺少读取当前档位的实现');
  assert(/function insideWorkspace/.test(tools), '工作区档缺少「是否落在工作目录内」的判断');
  // config.js 里这几行是分多行写的，用跨行匹配（写死单行会假失败）
  assert(/approval: \{[\s\S]{0,80}mode: 'ask'/.test(cfgJs), 'config.js 里默认档应该是 ask（最保守）');
  const server = fs.readFileSync(path.join(ROOT, 'src', 'web', 'server.js'), 'utf8');
  assert(/approval: \{ mode: require\('\.\.\/tools'\)\.approvalMode/.test(server), '/api 没有暴露权限档位');
  assert(/APPROVAL_MODES\.includes\(mode\)/.test(server), '保存设置时没有校验档位取值');
  assert(/app\.cfg\.approval = /.test(server), '改档位之后没有立刻作用到运行中的配置');

  // ② 附件：桌面桥要真有对应能力（浏览器拿不到真实路径，所以必须走桥）
  assert(/chooseAttachment\(kind, defaultPath\)/.test(preload), 'preload 没有暴露 chooseAttachment');
  assert(/ipcMain\.handle\('choose-attachment'/.test(mainJs), '主进程没有 choose-attachment 处理器');
  for (const kind of ['file', 'directory', 'archive']) {
    assert(mainJs.includes(`${kind}: {`), `附件对话框缺少 ${kind} 这一种`);
  }
  assert(/function pickAttachment/.test(js), '前端缺少附件选择的实现');
  assert(/chooseAttachment/.test(js), '前端没有调用桌面桥');
  assert(/bridge\.chooseAttachment|window\.myaDesktop/.test(js), '前端没有判断桌面/浏览器两种环境');

  // ③ 推理等级：抽屉（上下展开）而不是一排标签
  assert(/function renderReasoning/.test(js), '缺少渲染推理等级的实现');
  assert(/reasonToggle'\)\.addEventListener/.test(js), '抽屉标题没有绑展开/收起');
  assert(/\.model-pop-reason\.open \.reason-drawer/.test(css), '抽屉展开的样式缺失');
  assert(
    /\.model-pop-reason \.reason-drawer \{[^}]*display: none/.test(css),
    '抽屉默认必须是收起的（并且选择器要压过 .seg 的 flex）',
  );
  assert(/flex-direction: column/.test(css), '抽屉里的选项应该上下排');

  // ④ 「完全权限」必须先弹一次确认，而且取消之后不能生效
  assert(html.includes('id="permBackdrop"'), '缺少「完全权限」的确认弹窗');
  assert(html.includes('id="btnPermCancel"') && html.includes('id="btnPermConfirm"'), '确认弹窗缺少取消/确认按钮');
  assert(/function confirmFullAccess/.test(js), '缺少二次确认的实现');
  assert(
    /mode === 'full'[\s\S]{0,160}await confirmFullAccess\(\)/.test(js),
    '切到「完全权限」时必须先等用户确认',
  );
  assert(/if \(!ok\) \{[\s\S]{0,120}return;/.test(js), '用户取消之后不能继续切换');
  // 主动把焦点放到取消上（具体是不是取消那个按钮，由桌面自检的实机断言盯着）。
  // 焦点逻辑住在通用确认框 confirmDialog 里（完全权限弹窗只是它的一个调用方）。
  const dialogBody = js.slice(js.indexOf('function confirmDialog'), js.indexOf('function confirmFullAccess'));
  assert(/focusConfirm \? confirmBtn : cancelBtn/.test(dialogBody), '焦点应当默认落在「取消」上');
  assert(/\.focus\(\)/.test(dialogBody), '确认弹窗没有主动设置焦点（误按回车会放开权限）');
  assert(/permBackdrop/.test(js), '确认弹窗没有接线');

  // ④ 「不要多余的话」：模型浮层里那两行说明必须删干净
  assert(!html.includes('modelPopHint') && !js.includes('modelPopHint'), '模型浮层里的说明文字应该删掉');
  assert(!html.includes('reasonHint') && !js.includes('reasonHint'), '推理等级下面那行说明应该删掉');
  assert(!html.includes('composerHint'), '输入区的快捷键提示行应该删掉（位置让给附件和权限）');

  return '权限三档 / 附件加号 / 推理抽屉 都齐备';
});

check('上下文计量 / 审计写盘 / 安全头 / 本机配置层 都到位', () => {
  const session = fs.readFileSync(path.join(ROOT, 'src', 'session.js'), 'utf8');
  const audit = fs.readFileSync(path.join(ROOT, 'plugins', 'audit', 'index.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'src', 'web', 'server.js'), 'utf8');
  const config = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8');

  // ① 上下文计量：拿到上游实测就按较大值算，压缩后旧锚点作废
  assert(/function lastRealPromptTokens/.test(session), '缺少「用上游实测值兜底」的实现');
  assert(/Math\.max\(estimated, anchor\)/.test(session), '计量时应当取估算与实测的较大值');
  assert(/_compacted\.at|lastCompactedAt/.test(session), '压缩之后必须让旧锚点作废（否则压了也白压）');
  assert(/anchorUsed/.test(session), '应当把「是否用了实测值」暴露出去（界面要如实说）');

  // ② 自动压缩默认开、阈值留余量
  assert(/auto: true/.test(config), 'compact.auto 默认应为 true');
  assert(/threshold: 0\.62/.test(config), '自动压缩阈值应为 0.62（留出余量，不贴边才动）');

  // ③ config.local.json 必须真的被读（被忽略却没人读 = 骗人的配置项）
  assert(/config\.local\.json/.test(config), 'loadConfig 没有读 config.local.json');
  assert(/deepMerge\(cfg, localConfig\)/.test(config), 'config.local.json 应当覆盖 config.json');

  // ④ 审计写盘：热路径不能同步写
  assert(/enqueue\(/.test(audit), '审计应当走攒批队列');
  assert(/fs\.appendFile\(/.test(audit), '审计应当用异步 appendFile');
  assert(/process\.once\('exit', onExit\)/.test(audit), '进程退出时应当兜底 flush（否则 CLI 一次性任务会丢记录）');
  const hotPath = audit.slice(audit.indexOf("ctx.on('tool:after'"), audit.indexOf("ctx.on('session:end'"));
  assert(!/appendFileSync/.test(hotPath), 'tool:after 热路径里不能有同步写');

  // ⑤ 安全响应头
  assert(/SECURITY_HEADERS/.test(server), '缺少安全响应头定义');
  assert(/Content-Security-Policy/.test(server), '缺少 CSP');
  assert(/object-src 'none'/.test(server), 'CSP 应当禁掉 object-src');
  assert(/res\.setHeader\(key, value\)|res\.setHeader\(k, v\)/.test(server), '应当在请求入口统一挂头（静态资源也要有）');

  return '计量校准 / 自动压缩 / 本机层 / 审计异步 / 安全头';
});

check('git 检查点：模块 / 接线 / 命令 / 配置 都在位', () => {
  const ckpt = fs.readFileSync(path.join(ROOT, 'src', 'checkpoint.js'), 'utf8');
  const agent = fs.readFileSync(path.join(ROOT, 'src', 'agent.js'), 'utf8');
  const builtin = fs.readFileSync(path.join(ROOT, 'src', 'tools', 'builtin.js'), 'utf8');
  const cli = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');
  const config = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8');

  // ① 模块：独立索引 + 隐藏 ref + 一次性身份（这三条决定「不碰用户仓库」）
  assert(/GIT_INDEX_FILE/.test(ckpt), '必须用独立索引文件，否则会动用户的暂存区');
  assert(/refs\/mya\/checkpoints/.test(ckpt), '检查点要挂在隐藏 ref 下');
  assert(/GIT_AUTHOR_NAME/.test(ckpt), '要显式给一次性身份（全新机器没配 user.name 会失败）');
  assert(/restore/.test(ckpt) && !/reset', '--hard|reset'[\s\S]{0,20}--hard/.test(ckpt), '回滚不能用 reset --hard（会移动用户 HEAD）');

  // ② 接线：agent 提供 ctx.checkpoint，且一轮只打一次
  assert(/checkpoint: async \(label\)/.test(agent), 'agent 没有把 checkpoint 放进运行上下文');
  assert(/this\.checkpoints\.has\(runId\)/.test(agent), '一轮里要复用同一个检查点，不能每次改动都打点');
  assert(/createCheckpoint\(/.test(agent), 'agent 没有真的调用打点');
  // ③ 真正改文件的工具才打点
  assert(/checkpointBefore\(ctx, `write/.test(builtin), 'write 之前没有打点');
  assert(/checkpointBefore\(ctx, `edit/.test(builtin), 'edit 之前没有打点');
  assert(!/checkpointBefore\(ctx, `read/.test(builtin), 'read 不该打点（纯浪费）');
  // ④ CLI
  assert(/case 'checkpoint'/.test(cli) && /async function cmdCheckpoint/.test(cli), '缺少 mya checkpoint 命令');
  assert(/restore'[\s\S]{0,400}--yes/.test(cli) || /flags\.yes/.test(cli), '回滚是破坏性操作，必须显式确认');
  // ⑤ 配置默认开，且不自动 git init
  assert(/checkpoint: \{[\s\S]{0,120}enabled: true/.test(config), 'checkpoint 默认应当开启');
  assert(!/git init/.test(ckpt), '绝不能替用户 git init');

  return '独立索引 / 隐藏 ref / 自动打点 / mya checkpoint';
});

check('改动预览（diff）：算法、闸门接线、界面渲染 三层都到位', () => {
  const diff = fs.readFileSync(path.join(ROOT, 'src', 'diff.js'), 'utf8');
  const tools = fs.readFileSync(path.join(ROOT, 'src', 'tools.js'), 'utf8');
  const builtin = fs.readFileSync(path.join(ROOT, 'src', 'tools', 'builtin.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'src', 'web', 'server.js'), 'utf8');
  const mgr = fs.readFileSync(path.join(ROOT, 'src', 'web', 'session-manager.js'), 'utf8');
  const ui = fs.readFileSync(path.join(ROOT, 'src', 'ui.js'), 'utf8');

  // ① 算法：先掐公共首尾（大文件才快）+ 规模上限（整段重写不卡死）+ 限行
  assert(/while \(start < a\.length && start < b\.length/.test(diff), '缺少「先掐掉公共前缀」这一步');
  assert(/MAX_DP_CELLS/.test(diff), '缺少 DP 规模上限（整段重写会卡死）');
  assert(/还有 \$\{truncated\} 行没显示/.test(diff), '限行时要如实说明还有多少行');
  assert(/lines\[lines\.length - 1\] === ''/.test(diff), '末尾换行不该被当成多出一个空行');

  // ② 契约：Tool 有 preview 字段；注册表只在真要问的时候调用它，并走 detail 通道
  assert(/this\.preview = typeof def\.preview === 'function'/.test(tools), 'Tool 契约里缺少 preview()');
  assert(/if \(tool\.preview\)/.test(tools) && /tool\.preview\(args, ctx\)/.test(tools), '注册表没有调用 preview()');
  assert(/\{ detail \}/.test(tools), '改动预览必须走 confirm 的 detail 通道（否则界面没法着色）');
  assert(/preview\(args, ctx\)/.test(builtin), 'write/edit 没有实现 preview()');
  assert(/formatDiff\(/.test(builtin), 'write/edit 的预览应当用 diff 而不是原样贴内容');

  // ③ 界面：确认弹窗渲染 diff；对话里事后能看；终端也打一份
  assert(html.includes('id="approvalDiff"'), '确认弹窗缺少 diff 容器');
  assert(/function diffHtml/.test(js), '缺少 diff 渲染函数');
  assert(/approval\.detail/.test(js), '确认弹窗没有使用 approval.detail');
  assert(/diff-add|diff-del/.test(css), 'diff 没有 +/- 着色样式');
  assert(/case 'checkpoint'/.test(js), '对话里没有检查点块（回滚入口）');
  assert(/checkpoint\/restore/.test(js), '界面没有调用回滚接口');
  assert(/detail/.test(ui), 'CLI 的 confirm 没有打印改动预览');

  // ④ 后端：事件要落块；回滚接口要校验 ref（不能变成任意 checkout）
  assert(/bus\.on\('checkpoint', onCheckpoint\)/.test(mgr), '检查点事件没有接进对话流');
  assert(/type: 'checkpoint'/.test(mgr), '检查点块没有落进 blocks');
  assert(/startsWith\(ck\.REF_PREFIX\)/.test(server), '回滚接口必须限定 ref 命名空间');
  assert(/listCheckpoints\(cwd, 500\)\.some/.test(server), '回滚前必须确认 ref 属于当前工作区');

  return '算法 / 契约 / 界面 / 接口 四层齐';
});

check('局域网模式：令牌闸门真的接上了（以前页面能开、API 全 403）', () => {
  const server = fs.readFileSync(path.join(ROOT, 'src', 'web', 'server.js'), 'utf8');
  const gate = fs.readFileSync(path.join(ROOT, 'src', 'web', 'lan-gate.js'), 'utf8');
  const cli = fs.readFileSync(path.join(ROOT, 'src', 'cli.js'), 'utf8');

  // ① 闸门自己：三条进入路径 + HttpOnly cookie
  assert(/TOKEN_COOKIE = 'mya_token'/.test(gate), '缺少令牌 Cookie 名');
  assert(/HttpOnly/.test(gate) && /SameSite=Strict/.test(gate), 'Cookie 必须是 HttpOnly + SameSite');
  assert(/url\.searchParams\.get\('token'\)/.test(gate), '要支持 URL 上的 ?token=');
  assert(/'x-mya-token'/.test(gate), '要支持请求头令牌（脚本/curl）');
  // ② 必须在静态资源之前拦：否则局域网用户能打开页面却什么都点不动
  const handlerStart = server.indexOf('const server = http.createServer');
  const gateIdx = server.indexOf('if (lanGate.enabled)', handlerStart);
  const staticIdx = server.indexOf('serveStatic(req, res, url)', handlerStart);
  assert(gateIdx !== -1, '请求入口没有接局域网闸门');
  assert(gateIdx < staticIdx, '闸门必须在静态资源之前生效');
  assert(/lanGate\.cookieHeader\(\)/.test(server), '带 token 打开时要种 cookie');
  assert(/location: |Location:/.test(server), '种完 cookie 要把地址栏里的 token 跳掉');
  // ③ 不能再对局域网访问者说「来源不是本机页面」（那是误导）
  assert(/!lanGate\.enabled && !checkOrigin\(req\)/.test(server), '本机校验只应管本机监听的情况');
  // ④ 启动时要给出真正能用的链接（手机要的是局域网 IP，不是 127.0.0.1）
  assert(/lanAddresses/.test(cli), '局域网模式要打印局域网地址的链接');
  return '闸门优先于静态资源 / Cookie / 链接带 token';
});

check('安全加固：路径限域 / 白名单 / 敏感文件 / 子进程环境 / 正则隔离', () => {
  const utils = fs.readFileSync(path.join(ROOT, 'src', 'utils.js'), 'utf8');
  const builtin = fs.readFileSync(path.join(ROOT, 'src', 'tools', 'builtin.js'), 'utf8');
  const tools = fs.readFileSync(path.join(ROOT, 'src', 'tools.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'src', 'web', 'server.js'), 'utf8');
  const gate = fs.readFileSync(path.join(ROOT, 'src', 'web', 'lan-gate.js'), 'utf8');
  const config = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8');
  const runner = fs.readFileSync(path.join(ROOT, 'src', 'tools', 'grep-runner.js'), 'utf8');
  const scan = fs.readFileSync(path.join(ROOT, 'src', 'grep-scan.js'), 'utf8');

  // ① 越界判定必须解析真实路径（只做字符串比较会被 junction 绕过，实测过）
  assert(/function resolveRealPath/.test(utils), '缺少真实路径解析');
  assert(/realpathSync/.test(utils), '越界检查必须解析符号链接/junction');
  assert(/isInside\(realTarget, resolveRealPath\(root\)\)/.test(utils), '真实路径也要在内才算通过');

  // ② glob / grep / shell.cwd 都要走限域（以前它们传的是 false）
  assert(/function pickDirPath/.test(builtin), '缺少目录类参数的限域封装');
  const confineUses = (builtin.match(/pickDirPath\(/g) || []).length;
  assert(confineUses >= 4, `glob/grep/shell 都该用上限域封装，实际出现 ${confineUses} 次`);
  assert(!/resolvePath\(args\.(path|cwd), ctxCwd\(ctx\), false\)/.test(builtin), '不该再有传 false 的路径解析');

  // ③ 白名单里不能再有「能执行代码 / 能读文件内容」的命令
  const listStart = builtin.indexOf('const SAFE_COMMAND_PREFIXES');
  const listBody = builtin.slice(listStart, builtin.indexOf('];', listStart));
  for (const forbidden of ["'node'", "'cat'", "'type'", "'find'", "'head'", "'tail'", "'wc'", "'Get-Content'", "'Select-String'", "'git show'", "'git diff'", "'Measure-Object'"]) {
    assert(!listBody.includes(forbidden), `白名单里不该有 ${forbidden}`);
  }
  assert(/\[;&\|><`\$\\r\\n\]/.test(builtin), '禁用字符集要包含 $ 与换行');

  // ④ 子进程环境变量白名单
  assert(/function childEnv/.test(builtin), '缺少子进程环境白名单');
  assert(/env: childEnv\(ctx\)/.test(builtin), 'spawn 必须用白名单环境，而不是继承 process.env');
  assert(!/env: \{ \.\.\.process\.env/.test(builtin), '不该再整体继承 process.env');

  // ⑤ 敏感文件闸门：要在免确认白名单之前生效，且可配置
  assert(/touchesSensitivePath/.test(tools), '缺少敏感文件判定');
  assert(/guardSensitive !== false && touchesSensitivePath/.test(tools), '敏感文件闸门要在自动放行之前');
  assert(/guardSensitive: true/.test(config), 'tools.guardSensitive 默认应当开启');
  assert(/function isSensitivePath/.test(utils) && /SENSITIVE_NAMES/.test(utils), '缺少敏感文件名清单');
  assert(/'config\.json'/.test(utils), '忽略名单要含 config.json');
  assert(/commandMentionsSensitive/.test(tools), '命令串里点名敏感文件也要拦');

  // ⑥ grep：长度上限 + worker 超时（正则没有超时机制，实测能把主进程钉死）
  assert(/pattern\.length > 500/.test(builtin), 'grep 应当有模式长度上限');
  assert(/runGrepScan/.test(builtin), 'grep 应当通过执行器跑（worker + 超时）');
  assert(/timedOut/.test(builtin) && /超时被中止/.test(builtin), '超时要如实说明结果不完整');
  assert(/worker_threads/.test(runner) && /terminate\(\)/.test(runner), '执行器要能掐掉卡住的 worker');
  assert(/MAX_LINE_TEST/.test(scan), '单行测试长度要有上限');

  // ⑦ 畸形 URL 编码不能把请求挂住
  assert(/try \{\s*rel = decodeURIComponent/.test(server), 'serveStatic 的 decodeURIComponent 要包 try/catch');
  assert(/res\.writeHead\(400, \{ 'Content-Type': 'text\/plain/.test(server), '解不出来应当返回 400');
  assert(/try \{\s*out\[k\] = decodeURIComponent/.test(gate), 'cookie 解码也要容错');

  // ⑧ 局域网拒绝页：转义 + 真实局域网地址
  assert(/function escapeHtml/.test(gate), '拒绝页要有转义');
  assert(/escapeHtml\(where\)/.test(gate), '拼进 HTML 的地址必须转义');
  assert(/lanAddresses\(\)/.test(gate), '局域网模式下应当给出真实局域网 IP');
  assert(!/const where = displayHost && port \?/.test(gate), '不该再直接把 0.0.0.0 写进页面');
  return '限域 / 白名单 / 敏感文件 / env / 正则隔离 / URI 容错 / 局域网页';
});

check('推理等级：选项按各家官方定义生成，默认不发送', () => {
  // 用户要求「可以切换推理等级，推理等级按照官方定义为标准」。
  // 关键点：三家官方的字段名/取值完全不同，所以选项表只有一份（src/reasoning.js），
  // 界面照服务端返回的渲染，不能在前端另写一份。
  const reasoning = fs.readFileSync(path.join(ROOT, 'src', 'reasoning.js'), 'utf8');
  assert(/'minimal'/.test(reasoning) && /'low'/.test(reasoning) && /'high'/.test(reasoning), 'OpenAI 的官方取值不齐');
  assert(/reasoning_effort/.test(reasoning), 'OpenAI 兼容协议应该用官方的 reasoning_effort');
  assert(/budget_tokens/.test(reasoning), 'Anthropic 应该用官方的 thinking.budget_tokens');
  assert(/thinkingBudget/.test(reasoning), 'Gemini 应该用官方的 thinkingConfig.thinkingBudget');
  assert(/delete body\.temperature/.test(reasoning), '开 thinking 时必须去掉 temperature（Anthropic 官方要求）');
  assert(/auto/.test(reasoning), '缺少「默认」这一档');

  // 三个 provider 都要真的用上它
  for (const [file, needle] of [
    ['openai.js', 'applyOpenAI'],
    ['anthropic.js', 'applyAnthropicThinking'],
    ['gemini.js', 'applyGeminiThinking'],
  ]) {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'providers', file), 'utf8');
    assert(src.includes(needle), `${file} 没有接推理等级`);
  }

  // 界面上要能切：分段控件 + 只提交 reasoning 字段
  assert(html.includes('id="reasonLevels"'), '模型面板里缺少推理等级的选项容器');
  assert(/function renderReasoning/.test(js), '缺少渲染推理等级的实现');
  assert(/function switchReasoning/.test(js), '缺少切换推理等级的实现');
  assert(
    /api\('\/settings',\s*\{\s*body:\s*\{\s*reasoning:\s*\{\s*level\s*\}\s*\}\s*\}\)/.test(js),
    '切换推理等级时只应该提交 reasoning 字段',
  );
  assert(js.includes('state.info.reasoning'), '推理等级的选项应该来自服务端');
  assert(css.includes('.reason-seg'), '推理等级的分段控件没有样式');
  // 服务端得真的把它暴露出去、并且只收合法取值
  const server = fs.readFileSync(path.join(ROOT, 'src', 'web', 'server.js'), 'utf8');
  assert(/reasoning:\s*require\('\.\.\/reasoning'\)\.describe/.test(server), '/api 没有暴露推理等级');
  assert(/require\('\.\.\/reasoning'\)\.normalize/.test(server), '保存设置时没有校验推理等级');
  return '官方取值单点定义 + 三协议落地 + 界面可切';
});

check('界面里没有写死的颜色值', () => {
  // 写死颜色会导致切主题时「大部分变了、某几处没变」，很难排查。
  // 只允许出现在主题变量定义块里。
  const body = css.replace(/:root(\[data-theme='dark'\])?\s*\{[^}]*\}/g, '');
  const hits = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([0-9]/g)].map((m) => m[0]);
  // #e81123 是 Windows 关闭按钮的标准红，允许写死
  const allowed = hits.filter((h) => !['#e81123', '#fff', '#ffffff'].includes(h));
  assert(
    allowed.length === 0,
    `组件样式里还有写死的颜色（切主题时会不一致）：${[...new Set(allowed)].join(', ')}`,
  );
  return '全部走主题变量';
});

check('HTML 里的 id 不重复', () => {
  // 重复 id 的表现很阴：$('#x') 永远只拿到第一个，
  // 于是「新写的那个控件怎么点都没反应」，而代码看起来完全正确。
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  const seen = new Map();
  const dup = [];
  for (const id of ids) {
    seen.set(id, (seen.get(id) || 0) + 1);
    if (seen.get(id) === 2) dup.push(id);
  }
  assert(dup.length === 0, `这些 id 出现了多次：${dup.join(', ')}`);
  return `${ids.length} 个 id 都唯一`;
});

check('新建会话会先让用户选工作目录', () => {
  // 用户要求「新建对话应该出现让我选择目录」
  assert(html.includes('id="dirBackdrop"'), '缺少选目录的弹窗');
  assert(html.includes('id="dirInput"'), '缺少路径输入框');
  assert(html.includes('id="dirChoices"'), '缺少子目录列表容器');
  // 弹窗里的列表用 dirChoices：「关于」里已经有一个 dirList 了，
  // 撞 id 会让 $('#dirList') 永远只拿到第一个
  assert((html.match(/id="dirList"/g) || []).length === 1, 'dirList 只应出现在「关于」里');
  assert(/function pickWorkingDir/.test(js), '缺少选目录的实现');
  assert(/api\('\/sessions',\s*\{\s*body:\s*\{\s*cwd/.test(js), '新建会话要把 cwd 传给服务端');
  assert(/newSession\(\{\s*silent:\s*true\s*\}\)/.test(js), '启动时自动建会话不该弹窗（silent）');
  // 桌面程序里用原生目录选择框，浏览器里退回手打 + 逐层点
  const preload = fs.readFileSync(path.join(ROOT, 'desktop', 'preload.js'), 'utf8');
  const mainJs = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
  assert(preload.includes('chooseDirectory'), 'preload 应该暴露 chooseDirectory');
  assert(mainJs.includes("'choose-directory'"), '主进程应该实现 choose-directory');
  assert(mainJs.includes('openDirectory'), '原生对话框要以「选目录」模式打开');
  assert(/function resolveUserPath/.test(fs.readFileSync(path.join(ROOT, 'src', 'web', 'server.js'), 'utf8')), '服务端要能把用户填的路径规范化');
  return '弹窗 + 原生选择框 + 逐层浏览';
});

check('每一步的 token 都显示出来', () => {
  assert(/case 'step'/.test(js), '前端没有渲染 step 块');
  assert(/function stepText/.test(js), '缺少每步用量的文案函数');
  assert(/step:usage/.test(fs.readFileSync(path.join(ROOT, 'src', 'agent.js'), 'utf8')), 'agent 没有推送每步用量事件');
  assert(/\.block\.step\s*\{/.test(css), 'step 块缺少样式');
  assert(/_usage/.test(fs.readFileSync(path.join(ROOT, 'src', 'session.js'), 'utf8')), '每步用量要落盘，否则刷新就没了');
  return 'agent → SSE → 块 → 界面';
});

check('压缩：默认自动（留余量），手动按钮仍然在', () => {
  // 演进过程：最早是自动 → 用户要求改成按键触发 → 现在是「默认自动 + 阈值留余量」。
  // 改回去的理由：手动意味着用户得自己盯圆环，真撞上窗口的代价是上游 400、这一轮白跑。
  // 所以约束换成了两条：阈值不贴边（0.62），以及每次压缩都在对话里留一条可展开的记录。
  assert(html.includes('id="btnCompact"'), '输入区缺少「压缩上下文」按钮');
  assert(/function compactContext/.test(js), '缺少手动压缩的实现');
  assert(/api\('\/compact'/.test(js), '按钮应该调用 /api/compact');
  assert(html.includes('id="setCompactAuto"'), '设置里应该有「用完自动压缩」开关');
  const plugin = fs.readFileSync(path.join(ROOT, 'plugins', 'context-compact', 'index.js'), 'utf8');
  assert(/auto:\s*true/.test(plugin), '插件默认应当是自动压缩');
  assert(/threshold:\s*0\.62/.test(plugin), '插件默认阈值应当是 0.62（留余量）');
  assert(/runCommand/.test(fs.readFileSync(path.join(ROOT, 'src', 'plugins.js'), 'utf8')), '界面按钮要靠插件命令复用同一份能力');
  // 压缩必须可见：界面上要有一块记录（否则历史被改写而用户毫不知情）
  assert(/case 'compaction'/.test(js), '压缩要在对话里留一条可见记录');
  return '默认自动 0.62 + 手动按钮 + 压缩可见';
});

check('上下文窗口来自网关，而不是写死的表', () => {
  // 用户要求「上下文大小应该从官方获取，而不是你给」
  const modelInfo = fs.readFileSync(path.join(ROOT, 'src', 'model-info.js'), 'utf8');
  assert(modelInfo.includes('inputTokenLimit'), 'Gemini 的 inputTokenLimit 要认');
  assert(modelInfo.includes('context_length'), 'OpenRouter 那类网关的 context_length 要认');
  const sessionJs = fs.readFileSync(path.join(ROOT, 'src', 'session.js'), 'utf8');
  assert(/function resolveContextWindowInfo/.test(sessionJs), '缺少「窗口大小 + 来源」的解析函数');
  assert(/source:\s*'gateway'/.test(sessionJs), '网关给的值要能被识别出来');
  assert(/WINDOW_SOURCE_LABELS/.test(js), '界面上要说明这个窗口是从哪来的');
  return '网关优先 / 用户配置最优先 / 推断要标明';
});

check('插件市场有内置（离线）那一页', () => {
  // 用户要求：「内置的插件市场，插件由我们添加」——
  // GitHub 连不上时，装插件这件事必须还能做，所以内置页要是默认页
  for (const id of ['marketSrc', 'builtinList', 'localPath', 'btnLocalCheck', 'btnLocalInstall', 'localNotice', 'localEnable']) {
    assert(html.includes(`id="${id}"`), `缺少 ${id}`);
  }
  assert(html.includes('data-src="builtin"') && html.includes('data-pane="builtin"'), '缺少内置插件页');
  assert(html.includes('data-pane="local"') && html.includes('data-pane="github"'), '本地/GitHub 页要分开');
  // 默认停在「内置插件」：不是 GitHub
  assert(/class="seg-btn active" data-src="builtin"/.test(html), '默认应该停在「内置插件」而不是 GitHub');
  assert(/\.market-pane\[hidden\]\s*\{\s*display:\s*none/.test(css), '分页用了 display，[hidden] 必须显式覆盖');

  assert(/function switchMarketSource/.test(js), '缺少来源切换');
  assert(/function loadBuiltinPlugins/.test(js), '缺少内置清单加载');
  assert(/function installBundledPlugin/.test(js), '缺少内置插件安装');
  assert(/function installLocalPlugin/.test(js), '缺少本地安装');
  assert(/api\('\/market\/catalog'/.test(js) && /api\('\/market\/install-local'/.test(js), '应该调用内置/本地安装接口');

  const preload = fs.readFileSync(path.join(ROOT, 'desktop', 'preload.js'), 'utf8');
  const mainJs = fs.readFileSync(path.join(ROOT, 'desktop', 'main.js'), 'utf8');
  assert(preload.includes('chooseArchive'), 'preload 应该暴露 chooseArchive');
  assert(mainJs.includes("'choose-archive'"), '主进程应该实现 choose-archive');

  // 内置清单：加插件 = 往 plugins/ 放一份 + 在 catalog 里登记一条
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'plugins.json'), 'utf8'));
  assert(Array.isArray(catalog.plugins) && catalog.plugins.length >= 5, `内置清单太短：${catalog.plugins.length}`);
  for (const p of catalog.plugins) {
    assert(p.name && p.title && p.description, `清单项缺字段：${JSON.stringify(p)}`);
    assert(fs.existsSync(path.join(ROOT, 'plugins', p.name)), `清单里的 ${p.name} 在 plugins/ 里不存在`);
  }

  const server = fs.readFileSync(path.join(ROOT, 'src', 'web', 'server.js'), 'utf8');
  for (const route of ['GET /api/market/catalog', 'POST /api/market/install-bundled', 'POST /api/market/install-local', 'POST /api/market/check-local']) {
    assert(server.includes(`'${route}'`), `服务端缺少路由 ${route}`);
  }
  const cfgJs = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8');
  assert(cfgJs.includes('bundledPluginDir'), '配置里要有「自带插件目录」（打包后它在 asar 里，和配置目录不是一回事）');
  return `${catalog.plugins.length} 个内置插件 + 本地安装`;
});

check('状态点不闪（只用颜色说话）', () => {
  // 用户反馈：「模型后面有个绿点在闪，好丑」。
  // 顶栏是常驻区域，常驻的东西不该有动画——一闪一闪盯着很累；
  // 运行中的提示交给消息区的「思考中…」和停止按钮。
  const dotBlock = /\.dot\s*\{[\s\S]*?\n\}/.exec(css);
  assert(dotBlock, '找不到 .dot 的样式');
  for (const cls of ['ok', 'bad', 'busy']) {
    const rule = new RegExp(`\\.dot\\.${cls}\\s*\\{([^}]*)\\}`).exec(css);
    assert(rule, `找不到 .dot.${cls}`);
    assert(!/animation/.test(rule[1]), `.dot.${cls} 不该有动画（用户嫌闪）`);
    assert(!/box-shadow/.test(rule[1]), `.dot.${cls} 不该发光（那也是一种闪）`);
  }
  // 压缩提示那个小点还是要动的：它只在压缩的几秒内出现，属于「进度」而不是常驻状态
  assert(/\.dot-pulse[\s\S]*?animation:\s*pulse/.test(css), '压缩进度点应该保留动画');
  return '常驻点静止 / 进度点保留';
});

/* ---------------- 对话区观感（对齐 Codex） ---------------- */

check('对话区是 Codex 那套观感：全宽平铺、中性灰气泡、无边框工具行', () => {
  // 助手消息不再带头像：同一个方块头像每轮都重复出现，
  // 除了吃掉左边一大截正文宽度，没有任何信息量。
  assert(!/class="avatar"/.test(js), '助手消息还在插头像');
  assert(!/\.avatar\s*\{/.test(css), '头像的样式还留着');
  assert(
    /\.block\.assistant\s*\{\s*display:\s*block;/.test(css),
    '助手消息应该整块平铺，不再用 flex + 头像槽',
  );

  // 用户气泡只靠底色区分，不描边（小气泡上的一圈线显得很碎）
  const bubble = /\.block\.user \.bubble\s*\{([^}]*)\}/.exec(css);
  assert(bubble, '找不到用户气泡样式');
  assert(/background:\s*var\(--bubble\)/.test(bubble[1]), '用户气泡应该用 --bubble 底色');
  assert(!/border:\s*1px/.test(bubble[1]), '用户气泡不该有描边');

  // 工具行 / 思考行回归成一行灰字：没有卡片边框，也不再为头像留缩进
  const tool = /\.block\.tool\s*\{([^}]*)\}/.exec(css);
  assert(tool, '找不到工具行样式');
  assert(!/border/.test(tool[1]), '工具行还在画卡片边框');
  for (const sel of ['reasoning', 'tool', 'approval-card', 'error-card', 'step']) {
    const rule = new RegExp(`\\.block\\.${sel}\\s*\\{([^}]*)\\}`).exec(css);
    assert(rule, `找不到 .block.${sel} 的样式`);
    assert(!/38px/.test(rule[1]), `.block.${sel} 还留着为头像让位的缩进`);
  }

  // 正文按列宽居中：一行铺满整个宽屏，读起来非常累
  assert(/--content-w:/.test(css), '缺少正文列宽变量');
  const msgs = /\.messages\s*\{([^}]*)\}/.exec(css);
  assert(msgs, '找不到 .messages 样式');
  // 去掉注释再判断，否则注释里写的「不用 scroll-behavior: smooth」会被当成真的开了
  const msgsDecl = msgs[1].replace(/\/\*[\s\S]*?\*\//g, '');
  assert(/var\(--content-w\)/.test(msgsDecl), '消息区没有按列宽居中');

  // 流式滚动必须关掉平滑动画：我们每 50ms 就要把视图拉到底，
  // 而平滑滚动是几百毫秒的动画，高频调用会互相打断，
  // 表现出来就是「滚不动 / 像卡死」。
  assert(!/scroll-behavior:\s*smooth/.test(msgsDecl), '消息区不该开平滑滚动（流式时会互相打断）');

  return '全宽平铺 + 浅色气泡 + 无边框工具行 + 居中列宽';
});

check('布局：主体高度不依赖「隐藏的标题栏占位」', () => {
  // 踩过的坑：body 原来用「标题栏 / 顶栏 / 主体」三行的 grid 模板。
  // 自绘标题栏在浏览器模式下是 display:none，而 **display:none 的元素
  // 不是 grid item**——于是本该给主体的那一行被顶栏占掉，
  // 整个界面塌成 52px 高：输入框挤在最上面，下面一片空白。
  // 桌面模式因为标题栏是显示的，一直没暴露出来。
  const body = /(?:^|\n)body\s*\{([^}]*)\}/.exec(css);
  assert(body, '找不到 body 的样式');
  assert(
    !/grid-template-rows\s*:\s*var\(--titlebar-h\)/.test(body[1]),
    'body 又用回了依赖标题栏占位的 grid 行模板（浏览器里会塌）',
  );
  assert(/display:\s*flex/.test(body[1]), 'body 应该是 flex column');
  assert(/flex-direction:\s*column/.test(body[1]), 'body 应该纵向排列');

  // 顶栏的高度原来由 grid 行给，改成 flex 之后必须自己声明
  const topbar = /\.topbar\s*\{([^}]*)\}/.exec(css);
  assert(topbar, '找不到 .topbar 的样式');
  assert(/height:\s*52px/.test(topbar[1]), '顶栏要自己声明 52px 高度');
  assert(/flex:\s*none/.test(topbar[1]), '顶栏不该被主体挤压');

  // 主体吃掉剩余高度；min-height:0 不能省，否则内容会把整页顶出去
  const layout = /\.layout\s*\{([^}]*)\}/.exec(css);
  assert(layout, '找不到 .layout 的样式');
  assert(/flex:\s*1/.test(layout[1]), '.layout 应该吃掉剩余高度');
  assert(/min-height:\s*0/.test(layout[1]), '.layout 需要 min-height:0');
  return 'flex column，隐藏的标题栏不占位';
});

/* ---------------- 联网搜索 ---------------- */

check('联网搜索：界面上有开关，默认后端是能连通的那个', () => {
  for (const id of ['setWebEnabled', 'setWebProvider', 'setWebEndpoint', 'setWebTimeout', 'btnSaveWeb']) {
    assert(html.includes(`id="${id}"`), `设置里缺少 ${id}`);
  }
  // 默认后端必须选能连通的那个：默认值连不上，这个功能就等于没有
  const cfgJs = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8');
  assert(/provider:\s*'bing'/.test(cfgJs), '默认搜索后端应该是 bing');
  assert(/web:\s*\{/.test(cfgJs), '配置里应该有 web 段');
  return '开关 + 三后端 + 默认 bing';
});

check('联网搜索：关掉时工具从模型的能力列表里消失（不是调用时才报错）', () => {
  const srcApp = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  assert(/applyWebToolVisibility/.test(srcApp), '缺少按配置显隐联网工具的函数');
  assert(/registry\.registerAll\(webTools/.test(srcApp), '联网工具没有被注册');

  // 用隐藏位而不是注销：注销之后想再打开就得重启进程
  const toolsJs = fs.readFileSync(path.join(ROOT, 'src', 'tools.js'), 'utf8');
  assert(/setHidden\(/.test(toolsJs), '注册表缺少 setHidden');

  // 保存设置时必须立刻刷新，否则模型还会照旧列表去调一个已经关掉的工具
  const srcServer = fs.readFileSync(path.join(ROOT, 'src', 'web', 'server.js'), 'utf8');
  assert(
    /applyWebToolVisibility\(app\.cfg, app\.registry\)/.test(srcServer),
    '保存设置后没有立刻刷新工具可见性',
  );
  return '隐藏位可逆 + 保存即生效';
});

check('联网搜索：Bing 结果能解析出标题/链接/摘要，并还原中转链接', () => {
  const { parseBingHtml, normalizeBingUrl } = require(path.join(ROOT, 'src', 'tools', 'web.js'));

  // Bing 偶尔把结果包成 ck/a?...&u=a1<base64url>；
  // 不还原的话用户点开看到的是 Bing 的中转页，web_fetch 也会抓到一堆脚本
  const real = 'https://example.org/redirected';
  const wrapped = `https://www.bing.com/ck/a?!&&u=a1${Buffer.from(real).toString('base64url')}&ntb=1`;
  assert(normalizeBingUrl(wrapped) === real, '没有还原 Bing 的跳转链接');
  assert(normalizeBingUrl('//example.net/x') === 'https://example.net/x', '没有补全协议相对地址');

  const sample = `
    <ol id="b_results">
      <li class="b_algo" data-id iid=SERP.1>
        <div class="b_tpcn"><a class="tilk" href="https://example.com/">example.com</a></div>
        <h2 class=""><a target="_blank" href="https://example.com/a">示例 &amp; 标题</a></h2>
        <div class="b_caption"><p class="b_lineclamp2">这是摘要 &#183; 带实体</p></div>
      </li>
      <li class="b_algo b_algoBorder">
        <h2><a href="${wrapped}">跳转链接要还原</a></h2>
        <div class="b_caption"><p>第二条摘要</p></div>
      </li>
      <li class="b_algo">
        <h2><a href="https://example.com/a">重复地址要去重</a></h2>
      </li>
    </ol>`;

  const results = parseBingHtml(sample);
  assert(results.length === 2, `应该解析出 2 条（重复地址要去重），实际 ${results.length} 条`);
  assert(results[0].title === '示例 & 标题', `标题实体没解对：${results[0].title}`);
  assert(results[0].url === 'https://example.com/a', `第一条地址不对：${results[0].url}`);
  assert(/这是摘要 · 带实体/.test(results[0].snippet), `摘要没解对：${results[0].snippet}`);
  assert(results[1].url === real, `中转链接没还原：${results[1].url}`);
  assert(results[1].snippet === '第二条摘要', `第二条摘要不对：${results[1].snippet}`);
  return '2 条（含跳转还原与去重）';
});

check('接入运营商：下拉选一个 + 弹窗填 API 信息，且界面拿不到明文 Key', () => {
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  const mod = fs.readFileSync(path.join(ROOT, 'src', 'api-profiles.js'), 'utf8');

  // ① 形态：不再是独立页，而是「模型与 API 接入」里的下拉 + 弹窗
  assert(!html.includes('data-view="apilibrary"'), '不该再有独立的 API 库标签页（用户要求放到接入下面）');
  assert(/<div class="set-section" id="section-access">/.test(html), '接入运营商要作为「模型与 API 接入」下的一段');
  for (const id of ['apSelect', 'apEdit', 'apDel', 'apStatus']) {
    assert(html.includes(`id="${id}"`), `接入段缺少 ${id}`);
  }
  // 弹窗（选运营商之后才出现）与它的字段
  assert(/id="accessBackdrop"/.test(html) && /class="modal-backdrop"/.test(html), '缺少接入弹窗');
  for (const id of ['apName', 'apProvider', 'apBaseUrl', 'apModel', 'apFormat', 'apKey', 'apSave', 'apCancel']) {
    assert(html.includes(`id="${id}"`), `接入弹窗缺少 ${id}`);
  }
  assert(html.includes('id="accessBackdrop" hidden'), '弹窗默认必须是隐藏的（选运营商才弹）');

  // ② 前端接线：选存档 = 切换（走服务端）；两个动作项 = 新建 / 存当前
  assert(/function renderAccessSelect/.test(js), '缺少渲染下拉的实现');
  assert(/function onAccessSelectChange/.test(js), '缺少下拉选择处理');
  assert(/AP_NEW = '__new__'/.test(js) && /AP_CAPTURE = '__capture__'/.test(js), '下拉要带「新建接入」与「把当前配置存为一条」两个动作项');
  assert(/function openAccessModal/.test(js) && /function saveAccessModal/.test(js), '缺少弹窗的打开/保存');
  assert(/api\('\/api-profiles\/activate'/.test(js), '切换必须调服务端接口（界面没有明文 Key，也不能自己改配置）');
  assert(/api\('\/api-profiles\/capture'/.test(js), '缺少「把当前配置存为一条」');
  assert(/name === 'model'[\s\S]{0,80}refreshApiProfiles\(\)/.test(js), '打开「模型与 API」时要刷新接入下拉');

  // ③ 服务端：界面形态不含明文 Key（防截图/旁看泄露）
  const viewBody = mod.slice(mod.indexOf('function publicView'), mod.indexOf('function list('));
  assert(/keyMasked/.test(viewBody) && /hasKey/.test(viewBody), '界面形态要给掩码与"有 Key"标记');
  assert(!/apiKey:/.test(viewBody), '界面形态里不能出现 apiKey 字段（否则明文就出网了）');
  assert(/api-profiles\.json/.test(mod), '存档要落在 .mya/api-profiles.json');
  return '下拉/弹窗/动作项/掩码/独立存档';
});

check('错误人话化：协议/源站分类、网络层翻译、Key 占位符前置、模板防覆盖', () => {
  const base = fs.readFileSync(path.join(ROOT, 'src', 'providers', 'base.js'), 'utf8');
  const configSrc = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8');
  const app = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');
  const envT = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

  // ① classifyError：protocol 要先于 model 判（更具体的先胜），且导出了网络层翻译
  const protoIdx = base.indexOf("out.kind = 'protocol'");
  const modelIdx = base.indexOf("out.kind = 'model'");
  const originIdx = base.indexOf("out.kind = 'origin'");
  assert(protoIdx !== -1 && modelIdx !== -1 && originIdx !== -1, '缺少 protocol/origin 分类');
  assert(protoIdx < modelIdx, 'protocol 必须在 model 之前判（否则 Model does not support... 会被当成模型名问题）');
  assert(/humanNetworkError/.test(base), '缺少网络层错误翻译');
  assert(/humanNetworkError };/.test(base) || /humanNetworkError,?\s*\};/.test(base), 'humanNetworkError 要导出（测试与 doctor 用）');

  // ② Key 占位符：配置层检测 + 启动警告点名来源文件
  assert(/apiKeyIssue\(key\)/.test(configSrc), '缺少 apiKeyIssue 检测');
  assert(/在这里|填你的/.test(configSrc), '占位符词表要覆盖模板文本');
  assert(/cfg\.keySource = /.test(configSrc), '要记录 Key 来自哪一层（警告要点名文件）');
  assert(/apiKeyIssue\(cfg\.apiKey\)/.test(app), '启动时没有做 Key 占位符校验');
  assert(/来自 \$\{cfg\.keySource\}/.test(app), '警告要指明是哪个文件给的值');

  // ③ 界面：测试连接的两类新建议
  assert(/case 'protocol':/.test(js), '测试连接缺少「协议不匹配」的建议');
  assert(/case 'origin':/.test(js), '测试连接缺少「源站不可达」的建议');

  // ④ 模板脚枪：.env.example 的示例行必须全部是注释状態（复制即生效 = 覆盖真 Key）
  const live = envT.split('\n').filter((l) => /^[A-Z_]+\s*=/.test(l.trim()));
  assert(live.length === 0, `.env.example 里还有未注释的示例行（复制到 .env 就会覆盖真 Key）：${live.join(' | ')}｜这是真实踩过的大坑`);
  assert(/取消注释其中一组/.test(envT), '模板要告诉用户“取消注释即可”');

  // ⑤ 新建工作区后顺手建会话
  assert(/async function addWorkspace/.test(js) && /await newSession\(\{ silent: true, cwd: data\.path \|\| dir \}\)/.test(js), '新建工作区后应自动建会话');
  return '分类顺序 / 来源点名 / 模板注释 / 建区即建会话';
});

check('用户消息只渲染一条：乐观渲染 + 服务端广播必须去重', () => {
  // 用户报过「点发送之后我说的话出现两行」：客户端先乐观渲染一条，
  // 服务端随后把同一条作为 block 广播回来，渲染函数当时无条件新建节点。
  const js = fs.readFileSync(path.join(ROOT, 'web', 'app.js'), 'utf8');

  // ① 发送时记住那个节点，等着被认领
  assert(/state\.pendingUser\.push\(pending\)/.test(js), '乐观渲染的用户消息节点要记进 pendingUser 队列');
  assert(/const el = renderBlock\(\{ seq: state\.lastSeq \+ 1, type: 'user', text \}\)/.test(js), '乐观渲染要拿到返回的节点');
  assert(/pendingUser: \[\]/.test(js), 'state 里的 pendingUser 应当是队列（单槽会被后一条覆盖）');
  assert(/state\.pendingUser = \[\]/.test(js), '换会话时要把待认领队列清空');

  // ② 服务端 block 回来时按「文本 + 待认领」配对，认领而不是重复渲染
  const blockCase = js.slice(js.indexOf("case 'block':"), js.indexOf("case 'block':") + 1600);
  assert(/ev\.block\.type === 'user' && state\.pendingUser\.length/.test(blockCase), 'block 事件里要对用户消息做认领');
  assert(/findIndex\(\(p\) => p\.text === ev\.block\.text\)/.test(blockCase), '按文本配对（客户端猜的 seq 与服务端不同）');
  assert(/state\.pendingUser\.splice\(idx, 1\)/.test(blockCase), '认领后要从队列里摘掉（连着发多条才不会错配）');
  assert(/state\.blocks\.set\(Number\(ev\.block\.seq\), el\)/.test(blockCase), '认领后要登记真实 seq');
  assert(/el\.dataset\.seq = String\(ev\.block\.seq\)/.test(blockCase), '认领后要把真实 seq 写到节点上');

  // ③ 渲染函数本身也要幂等：同 seq 再渲染一次不能长出第二个节点
  assert(/const prev = state\.blocks\.get\(block\.seq\)/.test(js), 'renderBlock 没有按 seq 去重');
  assert(/prev && prev\.isConnected\) prev\.replaceWith\(wrap\)/.test(js), '同 seq 应当替换旧节点而不是追加');

  // ④ 没配模型时不留下"其实没发出去"的气泡
  assert(/el\.remove\(\);\s*\n\s*input\.value = text/.test(js), 'needsSetup 分支要撤掉乐观渲染的气泡并把文字还回输入框');
  return '乐观渲染 + 认领 + seq 幂等';
});

/* ---------------- 汇总 ---------------- */

const failed = results.filter((r) => !r.ok);
console.log(`\n${'─'.repeat(50)}`);
if (!failed.length) {
  console.log(`\x1b[32m\x1b[1m全部通过：${results.length} 项\x1b[0m\n`);
} else {
  console.log(`\x1b[31m\x1b[1m${failed.length} 项失败 / 共 ${results.length} 项\x1b[0m\n`);
}
process.exitCode = failed.length ? 1 : 0;
