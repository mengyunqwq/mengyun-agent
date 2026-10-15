'use strict';

/**
 * 梦云 Agent —— 插件市场（从 GitHub 发现并安装插件）
 *
 * 三条安装路径，按可靠性排序：
 *   1. 搜索 GitHub 仓库（未认证可用，10 次/分钟）→ 点安装
 *   2. 粘贴任意 GitHub 仓库地址 → 点安装
 *   3. 本地已有目录（不走这里，用户自己放）
 *
 * 关于认证：
 *   GitHub 从 2023 年起要求登录才能用「代码搜索」接口，未认证调用会返回 401。
 *   所以：不填 Token 也能用（搜仓库名/描述/话题），填了 Token 则额外解锁
 *   「按 manifest.json 内容搜索」和更高的配额（搜索 30 次/分钟）。
 *   Token 申请：https://github.com/settings/tokens （只需 public_repo 只读权限）
 *
 * 安全设计（这一层很关键，因为装插件等于装代码）：
 *   - 安装前把「要下载哪些文件、哪些文件会被执行」明确告诉用户
 *   - 目标文件做静态扫描，发现 child_process / eval / 网络请求等就警告
 *   - 装完后插件处于「已安装未启用」状态，必须用户手动点启用
 *   - 解压时只取插件目录内的文件，拒绝包含 .. 的路径（防目录穿越）
 *   - 限制解压总体积和文件数（防 zip 炸弹）
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const { ensureDir, readJsonFile, writeTextFile, humanSize } = require('../utils');

const API = 'https://api.github.com';
const UA = 'mengyun-agent/0.1 (+local plugin market)';

/** 解压限制：单个插件超过这个体积就拒绝 */
const LIMITS = {
  maxTotalBytes: 12 * 1024 * 1024, // 12MB
  maxFiles: 400,
  maxFileBytes: 2 * 1024 * 1024,
};

/** 插件清单里可以用来标明「这是梦云 Agent 插件」的字段 */

/* ------------------------------------------------------------------ */
/* 网络：两个应急开关 + 把「fetch failed」翻译成人话                    */
/* ------------------------------------------------------------------ */

/**
 * 证书/网络类故障的翻译表。
 *
 * 为什么要做这件事：Node 的 fetch 失败时只给一句 `fetch failed`，
 * 真正的原因藏在 err.cause 里。而国内最常见的情况**不是没网**，
 * 是中间人证书（公司代理、杀软、某些加速器）——Windows 自带工具
 * （浏览器、PowerShell）能连上，Node 却不认那个根证书，于是表现成
 * 「连不上 GitHub」。用户看到「可能需要配置代理」就去折腾代理，
 * 方向完全错了。
 */
const TLS_CAUSE_HINTS = {
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '本机有中间人证书（代理/杀软/加速器），Node 不认这个根证书',
  SELF_SIGNED_CERT_IN_CHAIN: '证书链里有自签名证书（中间人）',
  DEPTH_ZERO_SELF_SIGNED_CERT: '对方用的是自签名证书',
  CERT_HAS_EXPIRED: '对方证书已过期',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书和域名对不上',
};

/** 把 fetch 的报错翻译成「你能照着做」的话 */
function describeFetchError(err, endpoint) {
  const code = (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.code) || '';
  const head = `连不上 ${endpoint}：`;

  if (TLS_CAUSE_HINTS[code]) {
    return (
      `${head}${TLS_CAUSE_HINTS[code]}（${code}）。\n` +
      '  浏览器能打开不代表程序能连——浏览器走系统证书库，Node 走自己那份。两个办法：\n' +
      '  ① 把那个根证书导出成 .crt/.pem，设环境变量 NODE_EXTRA_CA_CERTS=证书路径（推荐，安全）；\n' +
      '  ② 临时用 MYA_INSECURE_TLS=1 跳过证书校验（只是不校验证书，流量该被看还是被看，别长期开）。\n' +
      '  公司网络/杀软把 GitHub 拦了也是同一类问题，关掉那个拦截或用手机热点试试。'
    );
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) {
    return `${head}域名解析失败（${code}）。检查 DNS，或这台机器根本连不上外网。`;
  }
  if (/ECONNREFUSED/.test(code)) {
    return `${head}连接被拒绝（${code}）。如果开了代理软件，确认它的端口和 MYA_PROXY 一致。`;
  }
  if (/ETIMEDOUT|CONNECT_TIMEOUT|UND_ERR_CONNECT_TIMEOUT/.test(code)) {
    return `${head}连接超时（${code}）。网络不通或需要代理：设 MYA_PROXY=http://127.0.0.1:端口 再试。`;
  }
  return `${head}${err.message}${code ? `（${code}）` : ''}`;
}

/**
 * 两个应急开关，都走环境变量（不改配置文件，也不会被误开）：
 *
 *   MYA_INSECURE_TLS=1   不校验证书。专治上面那种中间人证书导致的连不上。
 *   MYA_PROXY=http://…   走代理。Node 24 的 fetch 支持 NODE_USE_ENV_PROXY，
 *                        这里替用户把它打开，省得再去翻文档。
 *
 * 注意 MYA_INSECURE_TLS 会在 stderr 上喊一嗓子——安全相关的开关
 * 不能悄悄地开，哪天忘了自己开过，会把所有中间人攻击一起吃下去。
 */
function applyNetworkOverrides() {
  if (process.env.MYA_PROXY && !process.env.HTTPS_PROXY) {
    process.env.HTTPS_PROXY = process.env.MYA_PROXY;
    process.env.HTTP_PROXY = process.env.MYA_PROXY;
  }
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
    // Node 24+ 认这个开关；老版本上没有副作用
    process.env.NODE_USE_ENV_PROXY = process.env.NODE_USE_ENV_PROXY || '1';
  }
  if (process.env.MYA_INSECURE_TLS === '1' && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    // eslint-disable-next-line no-console
    console.error(
      '[警告] MYA_INSECURE_TLS=1：已关闭 HTTPS 证书校验。\n' +
        '        这是为了绕过本机的中间人证书。用完请关掉——开着的话，任何伪造的证书都会被接受。',
    );
  }
}

applyNetworkOverrides();

/* ------------------------------------------------------------------ */
/* 市场类                                                              */
/* ------------------------------------------------------------------ */

class PluginMarket {
  /**
   * @param {object} cfg 全局配置
   * @param {import('../plugins').PluginHost} pluginsHost
   * @param {object} app createApp() 返回的实例（用于热重载插件）
   */
  constructor(cfg, pluginsHost, app) {
    this.cfg = cfg;
    this.host = pluginsHost;
    this.app = app;
    this.token = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || cfg.githubToken || '').trim();
    this.pluginDir = cfg.pluginDirs[0] || path.resolve(cfg.rootDir, 'plugins');
    /** 上一次请求的配额信息，界面上显示 */
    this.rate = null;
  }

  get authenticated() {
    return !!this.token;
  }

  headers() {
    const h = {
      'User-Agent': UA,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  /** 统一请求：处理配额、错误、超时 */
  async api(url, { timeoutMs = 20000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { headers: this.headers(), signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error(`请求 GitHub 超时（${timeoutMs / 1000}s），检查网络或代理`);
      throw new Error(describeFetchError(err, 'api.github.com'));
    }
    clearTimeout(timer);

    this.rate = readRate(res.headers);

    if (res.status === 403 || res.status === 429) {
      const reset = this.rate && this.rate.reset ? new Date(this.rate.reset * 1000).toLocaleTimeString() : '稍后';
      throw new Error(
        `GitHub 接口限流了（当前${this.authenticated ? '已认证' : '未认证'}）。` +
          `重置时间约 ${reset}。${this.authenticated ? '' : '在设置里填一个 GitHub Token 可以把配额从 60 次/小时提到 5000 次/小时。'}`,
      );
    }
    if (res.status === 401) {
      throw new Error('GitHub Token 无效或已过期，请在「设置」里重新填写，或清空它改用匿名访问。');
    }
    if (res.status === 404) {
      throw new Error('仓库或文件不存在（可能是私有仓库，或地址拼错了）。');
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub 返回 ${res.status}：${text.slice(0, 200)}`);
    }
    return res.json();
  }

  /* ---------------------------------------------------------------- */
  /* 搜索                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 搜索插件仓库。
   * @param {string} query 关键词，或 GitHub 仓库地址
   * @param {object} [opts]
   * @param {number} [opts.limit]
   * @param {boolean} [opts.onlyPlugins] 只返回「看起来像插件」的仓库
   */
  async search(query, { limit = 20, onlyPlugins = true } = {}) {
    const q = String(query || '').trim();
    if (!q) throw new Error('请输入要搜索的关键词');

    // 直接粘地址的情况：不搜索，直接取仓库信息
    const parsed = parseRepoUrl(q);
    if (parsed) {
      const repo = await this.getRepo(parsed.owner, parsed.name);
      return { items: [{ ...repo, relevance: 'direct' }], mode: 'repo', total: 1 };
    }

    // 代码搜索：只在有 Token 时可用，但结果最准（直接找 manifest.json）
    if (this.authenticated) {
      try {
        const codeResult = await this.searchByManifest(q, limit);
        if (codeResult.items.length) {
          return { ...codeResult, items: codeResult.items.map((r) => ({ ...r, relevance: 'exact' })) };
        }
      } catch {
        // 代码搜索失败就退回仓库搜索，不要因此让整个搜索失败
      }
    }

    const url = `${API}/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${Math.min(limit * 2, 50)}`;
    const json = await this.api(url);

    const scored = [];
    for (const repo of json.items || []) {
      const s = scoreRepo(repo, q);
      if (onlyPlugins && s.score <= 0) continue;
      scored.push({ ...formatRepo(repo, s), relevance: relevanceOf(s.score) });
    }
    scored.sort((a, b) => b.score - a.score || b.stars - a.stars);

    const items = scored.slice(0, limit);
    const strong = items.filter((i) => i.relevance !== 'weak').length;

    return {
      items,
      mode: 'repositories',
      total: json.total_count || 0,
      strong,
      note: buildSearchNote({ authenticated: this.authenticated, total: items.length, strong, query: q }),
    };
  }

  /** 用代码搜索精确找插件：搜 manifest.json 里带标记的文件 */
  async searchByManifest(keyword, limit) {
    const q = `${keyword} filename:manifest.json`;
    const url = `${API}/search/code?q=${encodeURIComponent(q)}&per_page=${Math.min(limit, 30)}`;
    const json = await this.api(url);

    // 同一个仓库可能出现多次，去重
    const seen = new Map();
    for (const item of json.items || []) {
      const repo = item.repository;
      if (!repo || seen.has(repo.full_name)) continue;
      seen.set(repo.full_name, formatRepo(repo, { score: 10, reasons: ['manifest.json 内容匹配'] }));
    }
    const items = [...seen.values()];
    return { items, mode: 'code', total: json.total_count || items.length, note: '通过 manifest.json 内容精确匹配' };
  }

  /** 获取单个仓库信息 */
  async getRepo(owner, name) {
    const repo = await this.api(`${API}/repos/${owner}/${name}`);
    return formatRepo(repo, scoreRepo(repo, ''));
  }

  /* ---------------------------------------------------------------- */
  /* 仓库浏览（安装前的体检）                                          */
  /* ---------------------------------------------------------------- */

  /**
   * 列出仓库里的文件（前两级目录就够判断插件结构了）。
   * 用 git tree 接口一次性拿全，比逐层列目录省配额。
   */
  async listTree(owner, name, { ref = '', max = 200 } = {}) {
    const info = await this.api(`${API}/repos/${owner}/${name}`);
    const branch = ref || info.default_branch || 'main';
    const tree = await this.api(`${API}/repos/${owner}/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`);

    const entries = (tree.tree || [])
      .filter((e) => e.type === 'blob' || e.type === 'tree')
      .filter((e) => !e.path.startsWith('.git/'))
      .slice(0, max)
      .map((e) => ({ path: e.path, type: e.type, size: e.size || 0 }));

    return {
      owner,
      name,
      ref: branch,
      sha: tree.sha,
      branch,
      url: info.html_url,
      description: info.description,
      stars: info.stargazers_count,
      license: info.license ? info.license.spdx_id : '',
      defaultBranch: info.default_branch,
      entries,
      truncated: !!tree.truncated,
    };
  }

  /**
   * 分析仓库里有哪些可安装的插件。
   * 这是「安装前确认」的数据来源。
   */
  async inspect(owner, name, { ref = '' } = {}) {
    const tree = await this.listTree(owner, name, { ref });
    const candidates = detectPlugins(tree.entries);

    const results = [];
    for (const cand of candidates) {
      // 只有 index.js 没有 manifest.json 的仓库，需要看一眼代码才能确认是不是插件。
      // 不做这步的话，express 这种普通项目也会被当成插件仓库（根目录同样有 index.js）。
      if (cand.needsProbe) {
        // eslint-disable-next-line no-await-in-loop
        const confirmed = await this.probeRootPlugin(owner, name, tree.branch, cand);
        if (!confirmed) continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const files = await this.previewFiles(owner, name, tree.branch, cand);
      results.push({
        ...cand,
        files,
        fileCount: files.length,
        totalBytes: files.reduce((sum, f) => sum + (f.size || 0), 0),
        warnings: files.flatMap((f) => f.warnings || []),
        scanned: files.filter((f) => f.scanned).length,
      });
    }

    return { repo: { owner, name, ...tree }, candidates: results };
  }

  /**
   * 确认「根目录只有 index.js」的仓库到底是不是插件。
   * 判据（满足任意一条即算）：
   *   1. index.js 里用到了梦云 Agent 的插件 API（ctx.registerTool 之类）
   *   2. index.js 或 package.json 里出现插件标记关键词
   * 这些都能改文件绕过——它只是「减少误报」，不是安全边界。
   */
  async probeRootPlugin(owner, name, ref, cand) {
    const entry = cand.entryFile || 'index.js';
    try {
      const source = await this.fetchRawText(owner, name, ref, entry);
      if (looksLikePluginSource(source)) return true;
    } catch {
      return false;
    }

    // package.json 里的关键词也算（有些人会在 keywords 里标出来）
    try {
      const pkgText = await this.fetchRawText(owner, name, ref, 'package.json');
      return looksLikePluginSource(pkgText);
    } catch {
      return false;
    }
  }

  /**
   * 预览插件目录里的文件内容（只看代码文件，用于静态扫描）。
   * 跳过体积过大的和二进制文件，最多看 8 个。
   */
  async previewFiles(owner, name, ref, cand) {
    const scannable = cand.files.filter((p) => isScannable(p));
    const picked = [cand.entryFile, ...scannable.filter((p) => p !== cand.entryFile)].filter(Boolean).slice(0, 8);

    const out = [];
    for (const entry of cand.files) {
      const item = { path: entry, size: cand.sizes[entry] || 0, scanned: false, warnings: [] };
      if (picked.includes(entry)) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const raw = await this.fetchRawText(owner, name, ref, entry);
          item.scanned = true;
          item.warnings = scanSource(entry, raw);
          item.preview = raw.split('\n').slice(0, 40).join('\n');
        } catch (err) {
          item.warnings = [`读取失败：${err.message}`];
        }
      }
      out.push(item);
    }
    return out;
  }

  /** 读仓库里某个文件的原始内容 */
  async fetchRawText(owner, name, ref, filePath) {
    const url = `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  /** 拿仓库的 README（详情页展示用） */
  async readme(owner, name) {
    try {
      const json = await this.api(`${API}/repos/${owner}/${name}/readme`);
      return Buffer.from(json.content || '', 'base64').toString('utf8').slice(0, 8000);
    } catch {
      return '';
    }
  }

  /* ---------------------------------------------------------------- */
  /* 安装                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * 安装插件。
   * @param {object} opts
   * @param {string} opts.owner
   * @param {string} opts.name
   * @param {string} [opts.ref]         分支/标签/commit
   * @param {string} [opts.subdir]      仓库内的插件子目录（''=仓库根目录）
   * @param {string} [opts.pluginName]  安装到 plugins/ 下的目录名
   * @param {boolean} [opts.enable]     装完是否立即启用（默认 false，更安全）
   */
  async install({ owner, name, ref = '', subdir = '', pluginName = '', enable = false }) {
    if (!owner || !name) throw new Error('缺少仓库信息');
    ensureDir(this.pluginDir);

    const targetName = sanitizeDirName(pluginName || (subdir ? path.basename(subdir) : name));
    if (!targetName) throw new Error('无法确定插件目录名，请手动指定');

    // 同名的装过就加数字后缀，不覆盖已有插件
    let finalName = targetName;
    let counter = 2;
    while (fs.existsSync(path.join(this.pluginDir, finalName))) {
      finalName = `${targetName}-${counter}`;
      counter += 1;
      if (counter > 50) throw new Error('同名插件太多了，请先手动清理 plugins 目录');
    }
    const targetDir = path.join(this.pluginDir, finalName);

    // ---- 1) 下载 tarball（一次请求拿到整个仓库，配额友好）----
    const branch = ref || '';
    const tarballUrl = `https://codeload.github.com/${owner}/${name}/tar.gz/${encodeURIComponent(branch || 'HEAD')}`;
    const buffer = await this.download(tarballUrl);
    const files = readTarGz(buffer);

    // ---- 2) 算出这个插件的根前缀，只保留它下面的文件 ----
    const topPrefix = detectTopPrefix(files);
    const rootPrefix = subdir ? joinPath(topPrefix, subdir) : topPrefix;
    const inRoot = files.filter((f) => f.path.startsWith(`${rootPrefix}/`) || f.path === rootPrefix);
    if (!inRoot.length) {
      throw new Error(`在仓库里找不到目录「${subdir || '(根目录)'}」，可能分支不对或路径拼错了`);
    }

    // ---- 3) 体积和数量检查（防 zip 炸弹）----
    const kept = inRoot.filter((f) => {
      const rel = f.path.slice(rootPrefix.length + 1);
      if (!rel) return false;
      if (rel.startsWith('.git/')) return false;
      if (rel.includes('node_modules/')) return false;
      return f.type === 'file';
    });
    const totalBytes = kept.reduce((sum, f) => sum + f.size, 0);
    if (kept.length > LIMITS.maxFiles) {
      throw new Error(`插件文件太多（${kept.length} 个，上限 ${LIMITS.maxFiles}），已中止安装`);
    }
    if (totalBytes > LIMITS.maxTotalBytes) {
      throw new Error(`插件体积过大（${humanSize(totalBytes)}，上限 ${humanSize(LIMITS.maxTotalBytes)}），已中止安装`);
    }

    // ---- 4) 落盘（逐个文件校验路径，防止目录穿越）----
    ensureDir(targetDir);
    const written = [];
    try {
      for (const file of kept) {
        const rel = file.path.slice(rootPrefix.length + 1);
        const safeRel = sanitizeRelPath(rel);
        if (!safeRel) continue;
        if (file.size > LIMITS.maxFileBytes) continue; // 超大文件（比如示例数据）跳过
        const dest = path.join(targetDir, safeRel);
        // 双保险：解析后的路径必须仍在 targetDir 内
        if (!dest.startsWith(targetDir + path.sep) && dest !== targetDir) {
          throw new Error(`检测到非法路径，已中止：${rel}`);
        }
        ensureDir(path.dirname(dest));
        // eslint-disable-next-line no-await-in-loop
        await fsp.writeFile(dest, file.data);
        written.push(safeRel);
      }
    } catch (err) {
      // 装到一半失败就把半成品删掉，别留个坏插件在目录里
      await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }

    if (!written.length) {
      await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      throw new Error('这个目录里没有可安装的文件');
    }

    // ---- 4.5) 装进来的是不是插件？----
    // 界面上会先「预览」再装，但接口本身不能只靠界面把关：
    // 装一个不是插件的仓库进去，用户启用后会「毫无反应」，最难排查。
    const shape = detectInstalledPluginShape(targetDir);
    if (!shape.ok) {
      await fsp.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(shape.error);
    }

    // ---- 5) 记录来源，方便以后升级或排查 ----
    const manifest = readJsonFile(path.join(targetDir, 'manifest.json'), null);
    writeTextFile(
      path.join(targetDir, '.mya-source.json'),
      `${JSON.stringify(
        {
          source: 'github',
          repo: `${owner}/${name}`,
          url: `https://github.com/${owner}/${name}`,
          ref: branch || 'HEAD',
          subdir: subdir || '',
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );

    // ---- 6) 默认禁用：装完必须用户手动启用（安全底线）----
    const pluginKey = (manifest && manifest.name) || finalName;
    if (!enable) this.setDisabled(pluginKey, true);

    // ---- 7) 热加载：不用重启进程 ----
    const reload = await this.reload();

    return {
      installed: true,
      dir: targetDir,
      name: finalName,
      pluginKey,
      enabled: !!enable,
      files: written.length,
      bytes: totalBytes,
      manifest: manifest || null,
      reload,
      note: enable
        ? '已安装并启用，新会话立即可用。'
        : '已安装但**未启用**。请先看一眼代码，确认没问题再点「启用」。',
    };
  }

  /** 下载并解压，带超时和体积上限 */
  async download(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!res.ok) {
        throw new Error(
          res.status === 404
            ? '下载失败：仓库不存在或分支名不对（试试把分支留空，会自动用默认分支）'
            : `下载失败：HTTP ${res.status}`,
        );
      }
      const arrayBuffer = await res.arrayBuffer();
      const buf = Buffer.from(arrayBuffer);
      if (buf.length > 60 * 1024 * 1024) throw new Error('仓库压缩包超过 60MB，拒绝下载');
      return buf;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('下载超时（60s）');
      // 下载走的是 codeload，同样可能是证书/代理问题
      if (err && (err.cause || /fetch failed/.test(err.message || ''))) {
        throw new Error(describeFetchError(err, 'codeload.github.com'));
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------------------------------------------------------- */
  /* 内置插件（离线）                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * 列出内置插件：清单里的 + 自带目录里实际存在的。
   *
   * 两处都读是为了「加了插件忘了写清单」也不至于看不见——
   * 清单负责好看的文案，目录负责事实。
   */
  listBundled() {
    const bundledDir = this.cfg.bundledPluginDir || path.join(this.cfg.rootDir, 'plugins');
    const catalog = readCatalogFile(this.cfg.catalogDir);
    const byName = new Map();

    for (const item of catalog) {
      if (!item || !item.name) continue;
      byName.set(String(item.name), {
        name: String(item.name),
        title: item.title || String(item.name),
        description: item.description || '',
        tags: Array.isArray(item.tags) ? item.tags : [],
        official: item.official !== false,
        requires: Array.isArray(item.requires) ? item.requires : [],
        default: !!item.default,
        inCatalog: true,
      });
    }

    // 自带目录里实际有的（清单里没写的也补上，并标明「未在清单里」）
    try {
      for (const entry of fs.readdirSync(bundledDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(bundledDir, entry.name);
        if (!fs.existsSync(path.join(dir, 'index.js')) && !fs.existsSync(path.join(dir, 'manifest.json'))) continue;
        if (byName.has(entry.name)) continue;
        const manifest = readJsonFile(path.join(dir, 'manifest.json'), null) || {};
        byName.set(entry.name, {
          name: entry.name,
          title: manifest.title || manifest.name || entry.name,
          description: manifest.description || '（清单里没写说明）',
          tags: ['自带'],
          official: true,
          requires: [],
          default: false,
          inCatalog: false,
        });
      }
    } catch {
      /* 自带目录不存在也不该让整个市场打不开 */
    }

    // 已经装到你工作目录里的，标出来
    const installedNames = new Set();
    try {
      for (const entry of fs.readdirSync(this.pluginDir, { withFileTypes: true })) {
        if (entry.isDirectory()) installedNames.add(entry.name);
      }
    } catch {
      /* 还没有 plugins 目录 */
    }
    const loaded = new Set(this.host ? this.host.plugins.keys() : []);
    const disabled = new Set((this.cfg.plugins && this.cfg.plugins.disabled) || []);

    return [...byName.values()].map((item) => ({
      ...item,
      source: 'bundled',
      installed: installedNames.has(item.name) || loaded.has(item.name),
      enabled: loaded.has(item.name) && !disabled.has(item.name),
    }));
  }

  /**
   * 安装一个内置插件：从自带目录复制到你的工作目录。
   *
   * 为什么是「复制」而不是「直接用自带的」：插件跟着工作目录走
   * （在 A 项目装的插件不该跑到 B 项目生效），复制过来才是这个项目自己的。
   */
  async installBundled(name, { enable = false } = {}) {
    const bundledDir = this.cfg.bundledPluginDir || path.join(this.cfg.rootDir, 'plugins');
    const srcDir = path.join(bundledDir, sanitizeDirName(String(name || '')));
    if (!name || !fs.existsSync(srcDir)) {
      throw new Error(`自带的插件目录里找不到「${name}」`);
    }
    return this.installFromPath(srcDir, { enable, name });
  }

  /**
   * 从本地路径安装：可以是插件文件夹，也可以是 .zip / .tar.gz 压缩包。
   *
   * 这条路完全不联网——你从浏览器手动下好插件包、从同事那儿拷过来、
   * 或者自己写了一个，都能装。GitHub 连不上时这是唯一可用的第三方插件入口。
   */
  async installFromPath(srcPath, { enable = false, name = '' } = {}) {
    const target = path.resolve(String(srcPath || '').trim().replace(/^"(.*)"$/, '$1'));
    if (!target) throw new Error('请填一个路径');
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      throw new Error(`这个路径不存在：${target}`);
    }

    if (stat.isDirectory()) return this.installFromDir(target, { enable, name });

    const lower = target.toLowerCase();
    const buf = fs.readFileSync(target);
    if (buf.length > 60 * 1024 * 1024) throw new Error('压缩包超过 60MB，拒绝安装');
    if (lower.endsWith('.zip')) return this.installFromArchive(buf, { enable, name, archive: target, kind: 'zip' });
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      return this.installFromArchive(buf, { enable, name, archive: target, kind: 'tar' });
    }
    throw new Error('只认文件夹、.zip 和 .tar.gz / .tgz 三种；其它格式请先解压成文件夹再装');
  }

  /** 从一个文件夹安装（内置插件也走这里） */
  async installFromDir(srcDir, { enable = false, name = '' } = {}) {
    // 先看看它像不像插件：宁可现在拒绝，也别让用户启用后「毫无反应」
    const shape = detectInstalledPluginShape(srcDir);
    if (!shape.ok) throw new Error(shape.error);

    ensureDir(this.pluginDir);
    const finalName = uniquePluginName(this.pluginDir, name || path.basename(srcDir));
    const targetDir = path.join(this.pluginDir, finalName);

    const written = copyPluginDir(srcDir, targetDir, LIMITS);
    const manifest = readJsonFile(path.join(targetDir, 'manifest.json'), null);
    writeTextFile(
      path.join(targetDir, '.mya-source.json'),
      `${JSON.stringify({ source: 'local', from: srcDir, installedAt: new Date().toISOString() }, null, 2)}\n`,
    );

    const pluginKey = (manifest && manifest.name) || finalName;
    if (!enable) this.setDisabled(pluginKey, true);
    const reload = await this.reload();

    return {
      installed: true,
      dir: targetDir,
      name: finalName,
      pluginKey,
      enabled: !!enable,
      files: written.files,
      bytes: written.bytes,
      manifest: manifest || null,
      reload,
      note: enable ? '已安装并启用，新会话立即可用。' : '已安装但**未启用**。看一眼代码再点「启用」。',
    };
  }

  /** 从压缩包安装（zip / tar.gz 共用） */
  async installFromArchive(buffer, { enable = false, name = '', archive = '', kind = 'zip' } = {}) {
    const files = kind === 'zip' ? readZip(buffer) : readTarGz(buffer);
    const topPrefix = detectTopPrefix(files);
    const inRoot = files.filter((f) => f.path.startsWith(`${topPrefix}/`) || f.path === topPrefix);
    if (!inRoot.length) throw new Error('压缩包里没有文件');

    const kept = inRoot.filter((f) => {
      const rel = f.path.slice(topPrefix.length + 1);
      if (!rel || rel.startsWith('.git/')) return false;
      if (rel.includes('node_modules/')) return false;
      return f.type === 'file';
    });
    const totalBytes = kept.reduce((sum, f) => sum + f.size, 0);
    if (kept.length > LIMITS.maxFiles) throw new Error(`压缩包里文件太多（${kept.length} 个），已中止`);
    if (totalBytes > LIMITS.maxTotalBytes) throw new Error(`压缩包太大（${humanSize(totalBytes)}），已中止`);

    ensureDir(this.pluginDir);
    const finalName = uniquePluginName(this.pluginDir, name || path.basename(archive || 'plugin').replace(/\.(zip|tar\.gz|tgz)$/i, ''));
    const targetDir = path.join(this.pluginDir, finalName);

    try {
      for (const file of kept) {
        const rel = file.path.slice(topPrefix.length + 1);
        const safeRel = sanitizeRelPath(rel);
        if (!safeRel) continue;
        if (file.size > LIMITS.maxFileBytes) continue;
        const dest = path.join(targetDir, safeRel);
        if (!dest.startsWith(targetDir + path.sep) && dest !== targetDir) {
          throw new Error(`检测到非法路径，已中止：${rel}`);
        }
        ensureDir(path.dirname(dest));
        fs.writeFileSync(dest, file.data);
      }
    } catch (err) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      throw err;
    }

    const shape = detectInstalledPluginShape(targetDir);
    if (!shape.ok) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      throw new Error(shape.error);
    }

    const manifest = readJsonFile(path.join(targetDir, 'manifest.json'), null);
    writeTextFile(
      path.join(targetDir, '.mya-source.json'),
      `${JSON.stringify({ source: 'archive', from: archive, installedAt: new Date().toISOString() }, null, 2)}\n`,
    );

    const pluginKey = (manifest && manifest.name) || finalName;
    if (!enable) this.setDisabled(pluginKey, true);
    const reload = await this.reload();

    return {
      installed: true,
      dir: targetDir,
      name: finalName,
      pluginKey,
      enabled: !!enable,
      files: kept.length,
      bytes: totalBytes,
      manifest: manifest || null,
      reload,
      note: enable ? '已安装并启用，新会话立即可用。' : '已安装但**未启用**。看一眼代码再点「启用」。',
    };
  }

  /* ---------------------------------------------------------------- */
  /* 已安装插件的管理                                                  */
  /* ---------------------------------------------------------------- */

  /** 列出已安装的插件（含来源、启停状态、注册的工具） */
  list() {
    const enabledNames = new Set(this.host.plugins.keys());
    const out = [];

    for (const record of this.host.plugins.values()) {
      out.push({
        name: record.name,
        version: record.version,
        description: record.description,
        dir: record.dir,
        enabled: true,
        kind: record.kind,
        tools: record.toolNames,
        commands: record.commandNames,
        hooks: [...new Set(record.hookEvents)],
        permissions: record.permissions,
        source: this.readSource(record.dir),
        toolDetails: record.toolNames.map((t) => {
          const tool = this.host.registry.get(t);
          return {
            name: t,
            description: tool ? tool.description.split('\n')[0] : '',
            dangerous: tool ? tool.dangerous : false,
            source: tool ? tool.source : '',
          };
        }),
      });
    }

    // 被禁用的插件：在发现列表里但没被加载
    for (const cand of this.host.discover()) {
      const key = (cand.manifest && cand.manifest.name) || cand.id;
      if (enabledNames.has(key)) continue;
      out.push({
        name: key,
        version: (cand.manifest && cand.manifest.version) || '',
        description: (cand.manifest && cand.manifest.description) || '',
        dir: cand.dir,
        enabled: false,
        kind: cand.kind,
        tools: [],
        commands: [],
        hooks: [],
        permissions: (cand.manifest && cand.manifest.permissions) || [],
        source: this.readSource(cand.kind === 'dir' ? cand.dir : path.dirname(cand.dir)),
        broken: cand.error || '',
        toolDetails: [],
      });
    }

    // 加载失败的也列出来，让用户能删掉
    for (const err of this.host.errors) {
      if (out.some((p) => p.name === err.plugin)) continue;
      out.push({
        name: err.plugin,
        version: '',
        description: '',
        dir: err.dir || '',
        enabled: false,
        kind: 'dir',
        tools: [],
        commands: [],
        hooks: [],
        permissions: [],
        source: err.dir ? this.readSource(err.dir) : null,
        broken: err.error,
        toolDetails: [],
      });
    }

    return out.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  }

  readSource(dir) {
    const file = path.join(dir, '.mya-source.json');
    if (!fs.existsSync(file)) return null;
    return readJsonFile(file, null);
  }

  /** 启用插件（需要在配置里解禁，然后热重载） */
  async enable(name) {
    this.setDisabled(name, false);
    const reload = await this.reload();
    const ok = this.host.plugins.has(name);
    if (!ok) {
      // 启用失败就把状态改回去，别让界面显示成已启用
      this.setDisabled(name, true);
      const err = this.host.errors.find((e) => e.plugin === name);
      throw new Error(err ? `启用失败：${err.error}` : `启用失败：找不到插件「${name}」`);
    }
    return { name, enabled: true, reload };
  }

  /** 禁用插件 */
  async disable(name) {
    this.setDisabled(name, true);
    const reload = await this.reload();
    return { name, enabled: false, reload };
  }

  /**
   * 卸载插件：把目录移到回收站目录（而不是直接删），
   * 万一用户删错了还能找回来。
   */
  async uninstall(name) {
    const record = this.host.plugins.get(name);
    const dir = record ? record.dir : this.findDirByName(name);
    if (!dir) throw new Error(`找不到插件「${name}」的目录`);

    // 安全检查：只允许删 plugins 目录下的东西
    const rel = path.relative(this.pluginDir, dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`拒绝卸载：${dir} 不在插件目录内（可能是你自己写的插件，请手动处理）`);
    }

    const trashDir = path.join(this.cfg.dataDir, 'uninstalled');
    ensureDir(trashDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(trashDir, `${name}-${stamp}`);
    await fsp.rename(dir, dest).catch(async (err) => {
      // 跨盘符 rename 会失败，退化成复制后删除
      if (err.code === 'EXDEV') {
        await fsp.cp(dir, dest, { recursive: true });
        await fsp.rm(dir, { recursive: true, force: true });
      } else {
        throw err;
      }
    });

    this.setDisabled(name, true);
    const reload = await this.reload();
    return { name, removedTo: dest, reload };
  }

  findDirByName(name) {
    for (const cand of this.host.discover()) {
      const key = (cand.manifest && cand.manifest.name) || cand.id;
      if (key === name) return cand.dir;
    }
    const direct = path.join(this.pluginDir, name);
    return fs.existsSync(direct) ? direct : null;
  }

  /**
   * 写 config.json 的 plugins.disabled 列表。
   *
   * 写在「工作目录」的 config.json 里——插件是跟项目走的。
   * 这一条很关键：早期版本写到了程序目录的 config.json，
   * 结果在 A 项目里禁用的插件，会莫名其妙地在 B 项目里也被禁用。
   */
  setDisabled(name, disabled) {
    const cwd = this.cfg.cwd || this.cfg.rootDir;
    const cwdConfig = path.join(cwd, 'config.json');
    const homeConfig = path.join(this.cfg.rootDir, 'config.json');

    // 工作目录没有配置文件时，拿程序目录那份当基底（但不要把插件禁用状态一起继承过来）
    let json = readJsonFile(cwdConfig, null);
    if (!json) {
      json = readJsonFile(homeConfig, null) || {};
      if (json.plugins && typeof json.plugins === 'object') json.plugins = { ...json.plugins, disabled: [] };
    }
    if (typeof json !== 'object' || json === null) json = {};
    if (!json.plugins || typeof json.plugins !== 'object') json.plugins = {};

    const list = new Set(Array.isArray(json.plugins.disabled) ? json.plugins.disabled : []);
    if (disabled) list.add(name);
    else list.delete(name);
    json.plugins.disabled = [...list];

    writeTextFile(cwdConfig, `${JSON.stringify(json, null, 2)}\n`);

    // 内存里的配置也要同步，否则热重载读到的还是旧列表
    this.cfg.plugins.disabled = json.plugins.disabled;
  }

  /**
   * 热重载所有插件。
   * 不用重启进程，也不用重连页面——但已经在跑的会话需要重新生成系统提示词，
   * 否则模型看到的工具清单还是旧的。
   */
  async reload() {
    const host = this.host;
    /**
     * 先**真正卸载**全部，再重新加载。
     *
     * 以前这里只摘了工具和命令，漏掉了两样东西，于是长出两个查不出原因的坑：
     *   1) 事件钩子没摘 → 禁用掉的插件依然在拦危险命令；重扫三次同一个钩子跑三遍
     *      （实测监听器数 6 → 12 → 18）；
     *   2) require 缓存没清 → 改了插件代码点「重扫」，加载到的还是旧代码。
     * 现在交给 host.unloadAll()：钩子按 label 摘净、工具/命令/提示词贡献一起撤、
     * 模块缓存清掉、插件的 teardown 也会被叫到。
     */
    const disposed = await host.unloadAll();
    host.errors.length = 0;

    const stats = await host.loadAll();

    // 所有活跃会话的系统提示词都要重新生成（工具清单变了）。
    // agent 是懒创建的：没配模型时它还是 null，而「装/卸插件」并不需要模型，
    // 所以这里必须判空——否则用户一点「重扫插件」就吃一个
    // "Cannot read properties of null (reading 'refreshSystemPrompt')"。
    // 真到开跑的时候 runOnce() 还会再刷一次，漏不掉。
    if (this.app && this.app.sessions && this.app.agent) {
      for (const record of this.app.sessions.sessions.values()) {
        this.app.agent.refreshSystemPrompt(record.session);
      }
    }

    return {
      loaded: stats.loaded,
      failed: stats.failed,
      errors: host.errors.map((e) => ({ plugin: e.plugin, error: e.error })),
      tools: host.registry.list().length,
      // 如实汇报摘掉了什么：出问题时这几个数字就是最直接的线索
      disposed,
      hooks: host.bus.count(),
    };
  }
}

/** 相关性分级：给界面用来区分「就是这个」和「只是名字像」 */
function relevanceOf(score) {
  if (score >= 100) return 'exact'; // 打了本项目的话题标签
  if (score >= 40) return 'likely'; // 名字/描述里明确带品牌词
  return 'weak'; // 只是沾点边
}

/** 生成搜索提示，说清「为什么结果看起来不太对」以及怎么办 */
function buildSearchNote({ authenticated, total, strong, query }) {
  const q = String(query || '').toLowerCase();
  // 用户已经用话题搜了，就别再建议他搜话题
  const alreadyTopic = q.includes('topic:');

  if (!total) {
    const tips = ['没有找到相关仓库。可以试试：'];
    if (alreadyTopic) {
      tips.push('  · 目前 GitHub 上还没有仓库打这个话题标签');
      tips.push('  · 直接粘贴仓库地址安装（如果你已经知道地址）');
      tips.push('  · 自己写一个：右栏「我的插件」→ 生成插件骨架');
    } else {
      tips.push('  · 换更短的关键词，或直接粘贴仓库地址');
      tips.push('  · 搜 "topic:mya-plugin" 找专门为本项目写的插件');
    }
    if (!authenticated) tips.push('  · 填一个 GitHub Token 后可按 manifest.json 内容精确搜索');
    return tips.join('\n');
  }

  if (strong === 0) {
    return `这些仓库的名字里恰好带了「${query}」这几个字母，但看起来不像是为本项目写的插件。建议直接粘贴仓库地址，或去「我的插件」里自己生成一个骨架。`;
  }
  if (!authenticated) {
    return '当前是匿名搜索（按仓库名/描述/话题匹配）。填一个 GitHub Token 后可按 manifest.json 内容精确搜索，结果会准很多。';
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* 仓库分析：找出可安装的插件                                          */
/* ------------------------------------------------------------------ */

/**
 * 从文件清单里识别插件。
 * 规则：
 *   - 任意位置的 manifest.json → 该目录是一个插件（最可靠的信号）
 *   - 根目录有 package.json 且带插件标记字段 → 整个仓库是一个插件
 *   - 根目录有 index.js → 候选，但这个信号太弱（express 这种普通项目根目录也有 index.js），
 *     必须再读一下内容确认，见 inspect() 里的 needsProbe 分支
 */
function detectPlugins(entries) {
  const files = entries.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, size: e.size || 0 }));
  const byPath = new Map(files.map((f) => [f.path, f]));
  const candidates = [];
  const used = new Set();

  // 1) 所有 manifest.json
  for (const f of files) {
    if (path.posix.basename(f.path) !== 'manifest.json') continue;
    const dir = path.posix.dirname(f.path);
    const base = dir === '.' ? '' : dir;
    if (used.has(base)) continue;
    used.add(base);
    candidates.push(buildCandidate(base, files, byPath));
  }

  // 2) 根目录的 index.js：先记为「需要看内容才能确认」
  if (!candidates.length && byPath.has('index.js')) {
    const cand = buildCandidate('', files, byPath);
    cand.needsProbe = true;
    candidates.push(cand);
  }

  return candidates;
}

function buildCandidate(subdir, allFiles, byPath) {
  const prefix = subdir ? `${subdir}/` : '';
  const files = allFiles
    .filter((f) => (subdir ? f.path.startsWith(prefix) : !f.path.includes('/')))
    .map((f) => f.path.slice(prefix.length))
    .filter((p) => p && !p.startsWith('.'));

  const entryFile = ['index.js', 'index.cjs', 'index.mjs', 'main.js'].map((n) => `${subdir ? `${subdir}/` : ''}${n}`).find((p) => byPath.has(p)) || null;

  const sizes = {};
  for (const f of allFiles) {
    if (subdir ? f.path.startsWith(prefix) : !f.path.includes('/')) {
      sizes[f.path.slice(prefix.length)] = f.size;
    }
  }

  return {
    subdir,
    label: subdir || '(仓库根目录)',
    files: files.sort(),
    entryFile,
    sizes,
    hasManifest: files.includes('manifest.json'),
    hasPackageJson: files.includes('package.json'),
    name: subdir ? path.posix.basename(subdir) : '',
  };
}

/* ------------------------------------------------------------------ */
/* 静态扫描：装之前先看一眼代码在干什么                                */
/* ------------------------------------------------------------------ */

/** 这些模式出现在插件代码里就值得提醒用户 */
const RISKY_PATTERNS = [
  { re: /\bchild_process\b|\bexecSync\b|\bspawnSync\b|\bexec\(/, level: 'high', what: '执行系统命令' },
  { re: /\beval\s*\(|new Function\s*\(/, level: 'high', what: '动态执行代码（eval）' },
  { re: /process\.env/, level: 'medium', what: '读取环境变量（可能拿到你的 API Key）' },
  { re: /\bfetch\s*\(|https?\.request|axios|node-fetch/, level: 'medium', what: '发起网络请求' },
  { re: /fs\.(unlink|rm|rmdir|rmSync)|removeItem|rimraf/, level: 'high', what: '删除文件' },
  { re: /os\.homedir|process\.env\.(USERPROFILE|HOME)/, level: 'medium', what: '访问用户主目录' },
  { re: /\.ssh|id_rsa|\.aws|credentials/, level: 'high', what: '涉及敏感凭据路径' },
  { re: /Buffer\.from\([^)]*base64|atob\(/, level: 'medium', what: '解码 base64（可能用于隐藏代码）' },
];

/** 哪些扩展名值得读进来看 */
const SCANNABLE_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.jsx', '.tsx']);

function isScannable(filePath) {
  return SCANNABLE_EXT.has(path.extname(filePath).toLowerCase());
}

/**
 * 判断一段源码/配置文本像不像梦云 Agent 插件。
 * 用于「仓库根目录只有 index.js」时排除普通 Node 项目。
 * 注意：这是启发式判断，故意写关键词就能绕过——它只用来减少误报，不是安全措施。
 */
function looksLikePluginSource(text) {
  const s = String(text || '');
  // setup(ctx) 是本项目插件的招牌写法：每个插件的入口都长这样
  if (/setup\s*\(\s*ctx\b/.test(s)) return true;
  if (/registerTool|registerCommand|addPrompt|createPlugin|myaPlugin/i.test(s)) return true;
  if (/ctx\.on\(|ctx\.register|ctx\.getConfig\(/.test(s)) return true;
  if (/mya-plugin|mengyun|梦云/i.test(s)) return true;
  return false;
}

/** 插件入口文件名（和 plugins.js 的发现规则保持一致） */
const ENTRY_FILES = ['index.js', 'index.cjs', 'index.mjs', 'main.js'];

/**
 * 判断一个已经落盘的目录是不是「梦云 Agent 插件」。
 *
 * 判定条件故意宽松但有底线：
 *   · 有 manifest.json → 是（这是本项目的插件清单）
 *   · 有入口文件，且入口或目录里任何一个 .js 里出现了插件特征
 *     （registerTool / registerCommand / addPrompt …）→ 是
 *   · 其它一律不是
 *
 * 为什么要卡这一刀：装一个「不是插件的仓库」进去，用户启用之后
 * 界面上毫无变化——没有报错、没有新工具，只有一句「怎么没反应」，
 * 是最难排查的那种问题。宁可装的时候就明确拒绝。
 */
function detectInstalledPluginShape(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  const hasManifest = fs.existsSync(manifestPath);
  const entry = ENTRY_FILES.find((n) => fs.existsSync(path.join(dir, n)));

  if (hasManifest) {
    // 有清单还不够：没有入口文件的清单只说明「这不是本项目的插件」。
    // Chrome 扩展的 manifest.json 正好长这样——装进去后启用时会
    // 「什么都没有发生」，所以这里直接拦掉。
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      return { ok: false, error: 'manifest.json 不是合法的 JSON，装进来也加载不了。' };
    }
    const declared = String((manifest && (manifest.entry || manifest.main)) || '');
    const declaredOk = declared && fs.existsSync(path.join(dir, declared));
    if (declaredOk) return { ok: true, entry: declared };

    // 浏览器扩展的 manifest.json 也在这个目录名上，但它跟本项目的插件
    // 完全不是一回事：装进去启用后「什么都没发生」。用 manifest_version
    // 这个字段认它——那是 Chrome/Edge/Firefox 扩展的必备字段。
    if (manifest && manifest.manifest_version) {
      return {
        ok: false,
        error:
          '这是一个浏览器扩展（manifest.json 里有 manifest_version），不是梦云 Agent 插件。\n' +
          '  扩展的 manifest.json 和本项目的同名但含义不同：本项目要的是包含 name/version/entry 的插件清单。',
      };
    }
    if (entry) return { ok: true, entry };
    return {
      ok: false,
      error:
        '这个仓库有 manifest.json，但找不到入口文件（index.js / manifest.entry 指向的文件）。\n' +
        '  梦云 Agent 插件的入口要么叫 index.js，要么在 manifest.json 里用 "entry" 指明。',
    };
  }

  let hit = false;
  if (entry) {
    // 先看入口；入口只是个转发文件时，就再看一层目录里的其它 js
    const candidates = [entry];
    try {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.js') || name.endsWith('.cjs') || name.endsWith('.mjs')) candidates.push(name);
      }
    } catch {
      /* 读不到就只看入口 */
    }
    for (const name of candidates.slice(0, 40)) {
      try {
        if (looksLikePluginSource(fs.readFileSync(path.join(dir, name), 'utf8'))) {
          hit = true;
          break;
        }
      } catch {
        /* 单个文件读不了不影响结论 */
      }
    }
  }

  if (entry && hit) return { ok: true, entry };
  return {
    ok: false,
    error:
      '这个仓库不像梦云 Agent 插件：没有 manifest.json，入口文件里也没有 registerTool / registerCommand / addPrompt 这类插件特征。\n' +
      '  插件要按本项目的接口写，最小形态是一个 index.js：\n' +
      '    module.exports = { name: "我的插件", setup(ctx) { ctx.registerTool({...}) } }\n' +
      '  别的工具的插件（Claude Code / Cursor / MCP 服务器 / Chrome 扩展等）接口不同，装进来也不会被加载。\n' +
      '  想自己写一个：设置 →「插件管理」→ 生成插件骨架。',
  };
}

/**
 * 扫描源码，返回警告列表。
 * 注意：这只是「提醒」，不是安全判定——真正的安全边界是「默认不启用 + 你亲自看一眼」。
 */function scanSource(filePath, source) {
  const warnings = [];
  const lines = String(source).split('\n');
  for (const pattern of RISKY_PATTERNS) {
    for (let i = 0; i < lines.length; i += 1) {
      if (pattern.re.test(lines[i])) {
        warnings.push({
          level: pattern.level,
          what: pattern.what,
          file: filePath,
          line: i + 1,
          code: lines[i].trim().slice(0, 160),
        });
        break; // 同一个模式每个文件只报一次，避免刷屏
      }
    }
  }
  return warnings;
}

/* ------------------------------------------------------------------ */
/* tar.gz 解压（零依赖：zlib 解压 + 手写 tar 解析）                     */
/* ------------------------------------------------------------------ */

/**
 * 解析 tar.gz，返回 {path, size, type, data} 列表。
 * tar 格式很简单：每个文件 512 字节头 + 内容（补齐到 512 的倍数）。
 */
function readTarGz(buffer) {
  let tar;
  try {
    tar = zlib.gunzipSync(buffer);
  } catch (err) {
    throw new Error(`解压失败（可能不是合法的 tar.gz）：${err.message}`);
  }

  const files = [];
  let offset = 0;
  const BLOCK = 512;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);

    // 连续两个全零块表示结束
    if (header.every((b) => b === 0)) break;

    let name = readCString(header, 0, 100);
    const sizeField = readCString(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] || 48);
    const prefix = readCString(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;

    const size = parseInt(sizeField.replace(/[^0-7]/g, '') || '0', 8) || 0;
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;

    // 类型：0/'\0'=普通文件, 5=目录；x/g 是 pax 扩展头，跳过
    if (typeFlag === '0' || typeFlag === '\0' || typeFlag === '') {
      if (dataEnd <= tar.length) {
        files.push({
          path: normalizeTarPath(name),
          size,
          type: 'file',
          data: Buffer.from(tar.subarray(dataStart, dataEnd)),
        });
      }
    } else if (typeFlag === '5') {
      files.push({ path: normalizeTarPath(name), size: 0, type: 'dir', data: Buffer.alloc(0) });
    }

    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (size === 0 && typeFlag !== '0' && typeFlag !== '\0' && typeFlag !== '' && typeFlag !== '5') {
      // 未知类型且没有内容，防止死循环
      offset += 0;
    }
  }

  return files;
}

function readCString(buf, start, length) {
  let end = start;
  const limit = start + length;
  while (end < limit && buf[end] !== 0) end += 1;
  return buf.subarray(start, end).toString('utf8');
}

/** tar 里的路径统一成 / 分隔、去掉 ./ 前缀 */
function normalizeTarPath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** GitHub 的 tarball 所有文件都在 `<repo>-<sha>/` 下面，这里找出这个前缀 */
function detectTopPrefix(files) {
  if (!files.length) return '';
  const first = files[0].path;
  const slash = first.indexOf('/');
  if (slash === -1) return '';
  const top = first.slice(0, slash);
  // 确认所有文件都在这个前缀下（偶尔会有例外，那就当作没有前缀）
  const allInside = files.every((f) => f.path === top || f.path.startsWith(`${top}/`));
  return allInside ? top : '';
}

function joinPath(a, b) {
  if (!a) return b;
  if (!b) return a;
  return `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`;
}

/* ------------------------------------------------------------------ */
/* 各种小工具                                                          */
/* ------------------------------------------------------------------ */

/** 从各种 GitHub 地址形式里解析出 owner/name */
function parseRepoUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  // https://github.com/owner/name  |  git@github.com:owner/name.git  |  owner/name
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(s);
  if (!m) m = /^git@github\.com:([^/\s]+)\/([^/\s#?]+)/i.exec(s);
  if (!m) {
    const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
    if (short && !short[1].includes('.')) m = short;
  }
  if (!m) return null;
  const name = m[2].replace(/\.git$/, '');
  if (!m[1] || !name) return null;
  return { owner: m[1], name };
}

/** 给仓库打分：像插件的排前面，完全不像的直接淘汰（score <= 0） */
function scoreRepo(repo, query) {
  const reasons = [];
  let score = 0;

  const name = (repo.name || '').toLowerCase();
  const desc = (repo.description || '').toLowerCase();
  const topics = (repo.topics || []).map((t) => t.toLowerCase());
  const q = String(query || '').toLowerCase().trim();

  // 明确属于这个项目的标记
  const EXACT_TAGS = ['mya-plugin', 'mengyun-plugin', 'mengyun-agent', 'dreamyun-agent'];
  const BRAND = /(^|[^a-z])(mya|mengyun)([^a-z]|$)/; // 用词边界，避免 myanimelist 这种误命中

  if (topics.some((t) => EXACT_TAGS.includes(t))) {
    score += 100;
    reasons.push('带有本项目的插件话题标签');
  }
  if (topics.some((t) => BRAND.test(t))) {
    score += 40;
    reasons.push('话题带有 mya / mengyun 品牌词');
  }
  if (BRAND.test(name)) {
    score += 50;
    reasons.push('仓库名带有品牌词');
  }
  if (BRAND.test(desc)) {
    score += 25;
    reasons.push('描述带有品牌词');
  }
  if (/mya[-_.]?plugin|mengyun|梦云/i.test(name)) {
    score += 40;
    reasons.push('仓库名包含插件关键字');
  }
  if (/mya[-_.]?plugin|mengyun|梦云/i.test(desc)) {
    score += 20;
    reasons.push('描述包含插件关键字');
  }

  // 用户搜什么，就优先什么（用词边界，避免子串误判）
  if (q) {
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let qRe = null;
    try {
      qRe = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i');
    } catch {
      qRe = null;
    }
    if (qRe && qRe.test(name)) {
      score += 15;
      reasons.push('仓库名匹配关键词');
    } else if (qRe && qRe.test(desc)) {
      score += 8;
      reasons.push('描述匹配关键词');
    }
  }

  if (/[-_.]plugin$|^plugin[-_.]/.test(name)) {
    score += 12;
    reasons.push('命名像插件仓库');
  }
  if (repo.archived) {
    score -= 60;
    reasons.push('仓库已归档');
  }

  return { score, reasons };
}

function formatRepo(repo, scored) {
  const topics = repo.topics || [];
  return {
    owner: repo.owner ? repo.owner.login : (repo.full_name || '/').split('/')[0],
    name: repo.name,
    fullName: repo.full_name,
    url: repo.html_url,
    description: repo.description || '',
    stars: repo.stargazers_count || 0,
    forks: repo.forks_count || 0,
    language: repo.language || '',
    updatedAt: repo.updated_at || repo.pushed_at || '',
    topics,
    license: repo.license ? repo.license.spdx_id : '',
    archived: !!repo.archived,
    defaultBranch: repo.default_branch || 'main',
    score: scored.score,
    reasons: scored.reasons,
    /** 是否打了本项目的插件话题标签——最可靠的「这是给梦云 Agent 写的」信号 */
    hasMarker: topics.some((t) => String(t).toLowerCase() === 'mya-plugin'),
  };
}

function readRate(headers) {
  const get = (k) => headers.get(k);
  const limit = Number(get('x-ratelimit-limit'));
  if (!Number.isFinite(limit)) return null;
  return {
    limit,
    remaining: Number(get('x-ratelimit-remaining')),
    reset: Number(get('x-ratelimit-reset')),
    resource: get('x-ratelimit-resource') || 'core',
  };
}

/** 插件目录名：只保留安全字符，中文也允许 */
function sanitizeDirName(name) {
  return String(name || '')
    .replace(/[^\p{L}\p{N}_.-]+/gu, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 64);
}

/** 相对路径：去掉 .. 和绝对路径，防止目录穿越 */
function sanitizeRelPath(rel) {
  const parts = String(rel)
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..');
  if (parts.some((p) => p.includes(':'))) return null; // 防 Windows 盘符
  return parts.join('/');
}

/** 读出 zip 的中央目录，支持 store(0) 和 deflate(8) 两种方式 */
function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  // 从尾部找 EOCD（0x06054b50），注释最长 65535 字节
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法的 zip 文件（找不到结尾记录）');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const files = [];

  for (let n = 0; n < count && offset + 46 <= buf.length; n += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break; // 中央目录项签名
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString('utf8');
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // 目录项
    // 本地头：签名(4) + 版本(2) + 标志(2) + 方式(2) + 时间(2) + 日期(2) + crc(4) + 压缩(4) + 原始(4) + 名长(2) + 扩展长(2)
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else continue; // 其它压缩方式（bzip2/lzma 等）很少见，跳过
    files.push({ path: normalizeTarPath(name), size: data.length, type: 'file', data });
  }

  if (!files.length) throw new Error('zip 里没有可读取的文件（可能是加密包或用了不支持的压缩方式）');
  return files;
}

/* ------------------------------------------------------------------ */
/* 内置插件市场（完全离线，不碰 GitHub）                                */
/* ------------------------------------------------------------------ */

/**
 * 为什么要有这一块：
 * 插件市场原本只有 GitHub 一条路——可这台机器（以及很多国内网络）
 * 根本连不上 api.github.com（中间人证书 / 被墙）。于是「装插件」这件事
 * 直接做不了，而这恰恰是最常用的功能。
 *
 * 所以把市场拆成三种来源，按「需不需要网络」从低到高排：
 *   1. 内置插件：随程序发布，装它 = 从自带目录复制一份到你工作目录
 *   2. 本地安装：你把 zip / tar.gz / 一个文件夹给它，不联网也能装
 *   3. GitHub：联网时才用得上
 *
 * 前两条完全离线，所以插件市场在断网环境下是可用的。
 */

/** 读内置插件清单（catalog/plugins.json） */
function readCatalogFile(catalogDir) {
  const file = path.join(catalogDir || '', 'plugins.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : data.plugins;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 复制一个插件目录（递归，跳过 .git / node_modules / 回收站痕迹） */
function copyPluginDir(srcDir, destDir, { maxFiles = 400, maxBytes = 12 * 1024 * 1024 } = {}) {
  let files = 0;
  let bytes = 0;
  const write = (from, to) => {
    const stat = fs.statSync(from);
    if (stat.isDirectory()) {
      const name = path.basename(from);
      if (name === 'node_modules' || name === '.git') return;
      ensureDir(to);
      for (const child of fs.readdirSync(from)) write(path.join(from, child), path.join(to, child));
      return;
    }
    files += 1;
    bytes += stat.size;
    if (files > maxFiles) throw new Error(`插件文件太多（超过 ${maxFiles} 个）`);
    if (bytes > maxBytes) throw new Error(`插件体积过大（超过 ${humanSize(maxBytes)}）`);
    ensureDir(path.dirname(to));
    fs.copyFileSync(from, to);
  };
  write(srcDir, destDir);
  return { files, bytes };
}

/** 目标插件目录名：不覆盖已装的，重名就加 -2 / -3 */
function uniquePluginName(pluginDir, wanted) {
  const base = sanitizeDirName(wanted);
  if (!base) throw new Error('无法确定插件目录名，请手动指定一个名字');
  let name = base;
  let counter = 2;
  while (fs.existsSync(path.join(pluginDir, name))) {
    name = `${base}-${counter}`;
    counter += 1;
    if (counter > 50) throw new Error(`已经装了太多同名插件（${base}），请先清理 plugins 目录`);
  }
  return name;
}

module.exports = {
  PluginMarket,
  readTarGz,
  readZip,
  readCatalogFile,
  copyPluginDir,
  uniquePluginName,
  detectPlugins,
  parseRepoUrl,
  scoreRepo,
  scanSource,
  looksLikePluginSource,
  detectInstalledPluginShape,
  describeFetchError,
  sanitizeDirName,
  sanitizeRelPath,
  detectTopPrefix,
  LIMITS,
  RISKY_PATTERNS,
};
