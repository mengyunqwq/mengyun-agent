'use strict';

/**
 * 梦云 Agent —— 通用小工具集合
 * 所有模块都从这里取工具函数，避免各写一份。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/* ---------------- 字符串 ---------------- */

/** 截断长文本，中间保留头尾，方便模型看到结构 */
function truncate(text, max = 30000) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  const tail = Math.floor(max * 0.3);
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n\n… …（此处省略 ${omitted} 个字符，因超出长度上限 ${max}）… …\n\n${s.slice(-tail)}`;
}

/** 目录项展示：目录加后缀 / */
function displayPath(p, base) {
  const rel = base ? path.relative(base, p) : p;
  return rel === '' ? '.' : rel.split(path.sep).join('/');
}

/** 生成短 id，用于会话名 */
function shortId(len = 8) {
  return crypto.randomBytes(16).toString('hex').slice(0, len);
}

/** 时间戳，形如 2025-05-01 12:30:45 */
function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 文件系统安全的时间戳，形如 20250501-123045 */
function fileStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 人类可读的字节数 */
function humanSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

/** 人类可读的耗时 */
function humanMs(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
}

/* ---------------- 文件系统 ---------------- */

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readTextFile(p, fallback = null) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return fallback;
  }
}

function writeTextFile(p, content) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

function readJsonFile(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 解析出「真实路径」：把符号链接 / junction 展开。
 *
 * 为什么必须有这一步：路径越界检查如果只做字符串比较，在工作目录里建一个
 * junction 指向 C:\ 就能让 read/write 畅通无阻（Windows 普通用户即可 mklink /J）。
 * 这不是理论问题，是实测可利用的绕过。
 *
 * 目标可能还不存在（比如要新建文件），所以只能对**存在的最长前缀**取真实路径，
 * 再把剩下那几段接回去。
 */
function resolveRealPath(target) {
  let p = path.resolve(target);
  const tail = [];
  for (let i = 0; i < 64 && !fs.existsSync(p); i += 1) {
    const parent = path.dirname(p);
    if (parent === p) break;
    tail.unshift(path.basename(p));
    p = parent;
  }
  let real = p;
  try {
    real = fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    try {
      real = fs.realpathSync(p);
    } catch {
      /* 真解析不了（权限等）就用原路径，别把功能卡死 */
    }
  }
  return tail.length ? path.join(real, ...tail) : real;
}

/** child 是否落在 parent 之内（含相等） */
function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 安全解析路径：相对路径一律相对「工作目录」解析，并可选限制在工作目录内。
 *
 * 限域用的是**解析过符号链接的真实路径**（两侧都解析），所以
 * 「工作目录里的 junction → C:\」这类绕过会被拦下（实测过）。
 *
 * @param {string} input 用户/模型给的路径
 * @param {string} cwd   工作目录
 * @param {boolean} [insideOnly] 是否禁止越出工作目录
 */
function resolvePath(input, cwd, insideOnly = false) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new Error('路径不能为空');
  let normalized = raw;
  // 兼容模型偶尔写出的 ~ 前缀
  if (normalized === '~') normalized = os.homedir();
  else if (normalized.startsWith('~/') || normalized.startsWith('~\\')) {
    normalized = path.join(os.homedir(), normalized.slice(2));
  }
  const abs = path.isAbsolute(normalized) ? path.normalize(normalized) : path.resolve(cwd, normalized);
  if (insideOnly) {
    const root = path.resolve(cwd);
    // ① 字面路径必须在里面（挡住 ../../）
    if (!isInside(abs, root)) throw new Error(`路径越出工作目录，已拒绝：${abs}`);
    // ② 真实路径也必须在里面（挡住 junction / 符号链接）
    const realTarget = resolveRealPath(abs);
    if (!isInside(realTarget, resolveRealPath(root))) {
      throw new Error(
        `路径越出工作目录，已拒绝：${abs}\n（它经符号链接/junction 指向了 ${realTarget}；越界检查按真实路径判定）`,
      );
    }
  }
  return abs;
}

/* ---------------- 通配符 / 忽略规则 ---------------- */

/** 把 glob 片段转成正则（支持 ** * ? ） */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`);
}

const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.mya',
  '.idea',
  '.vscode',
  'target',
  'vendor',
  // ---- 敏感文件 ----
  // 为什么默认忽略：这些文件里装的是密钥，而 glob/grep 是**默认免确认**的工具。
  // 一次「顺手搜一下」就能把整份 .env 或 config.json 灌进上下文、随后发给上游模型。
  // 忽略它们不代表读不到：明确 read 时会走「敏感文件要确认」那道闸门（见 tools.js）。
  '.env',
  '.env.local',
  '.env.production',
  'config.json',
  'config.local.json',
  '.npmrc',
  '.pypirc',
  'credentials',
  'id_rsa',
  'id_ed25519',
  '.ssh',
  '.aws',
  '.gnupg',
];

/**
 * 敏感文件名/目录名：命中就该在读取前问一句。
 * 只按**文件名或路径段**判断，不做内容嗅探（那既慢又不准）。
 */
const SENSITIVE_NAMES = [
  /^\.env(\..+)?$/i,
  /^config(\.local)?\.json$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^credentials(\.json)?$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|pfx|p12|keystore|jks)$/i,
  /^(secrets?|\.secrets?)(\.(json|ya?ml|txt))?$/i,
  /^\.netrc$/i,
  /^\.git-credentials$/i,
];

/** 路径里有没有敏感文件名（逐段比对，目录名也算：.ssh/id_rsa 会命中两段） */
function isSensitivePath(target) {
  const raw = String(target || '').trim().replace(/^"(.*)"$/, '$1');
  if (!raw) return false;
  const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.some((seg) => SENSITIVE_NAMES.some((re) => re.test(seg)));
}

/** 判断路径（相对路径字符串）是否命中忽略规则 */
function isIgnored(relPath, ignoreList = DEFAULT_IGNORE) {
  const parts = relPath.split('/');
  return parts.some((seg) => ignoreList.includes(seg));
}

/* ---------------- 模糊匹配（插件/工具名纠错） ---------------- */

/** 简单的 Levenshtein 距离 */
function levenshtein(a, b) {
  const s = String(a);
  const t = String(b);
  const dp = Array.from({ length: s.length + 1 }, (_, i) => [i, ...Array(t.length).fill(0)]);
  for (let j = 0; j <= t.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[s.length][t.length];
}

/** 从候选里挑出最接近输入的几个（用于「你是不是想用 X」） */
function closest(input, candidates, limit = 3) {
  return candidates
    .map((name) => ({ name, d: levenshtein(input, name) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, limit)
    .filter((x) => x.d <= Math.max(2, Math.floor(String(input).length / 2)))
    .map((x) => x.name);
}

/* ---------------- 其它 ---------------- */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 简易深拷贝（配置对象用，够用即可） */
function clone(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(clone);
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = clone(v);
  return out;
}

module.exports = {
  truncate,
  displayPath,
  shortId,
  timestamp,
  fileStamp,
  humanSize,
  humanMs,
  exists,
  isDir,
  isFile,
  ensureDir,
  readTextFile,
  writeTextFile,
  readJsonFile,
  resolvePath,
  resolveRealPath,
  isInside,
  isSensitivePath,
  SENSITIVE_NAMES,
  globToRegExp,
  isIgnored,
  levenshtein,
  closest,
  sleep,
  clone,
  DEFAULT_IGNORE,
};
