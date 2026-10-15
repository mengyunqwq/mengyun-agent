'use strict';

/**
 * 梦云 Agent —— 工作区注册表
 *
 * 工作区的定义：**一个文件夹**。会话挂在它下面，一个文件夹可以有多个会话。
 * 这是用户对侧栏的期望：「我这段对话是在哪个项目里干的」——而不是一个抽象分组。
 *
 * 两条设计决定，都有理由：
 *
 * 1. **存在 `.mya/workspaces.json`，不写进 config.json。**
 *    config.json 是用户手写的设置（注释、说明字段都在里面），而这个文件是
 *    程序自己维护的状态。混在一起，用户改配置时会莫名其妙多出字段，
 *    而程序写配置时又可能把用户的注释冲掉。
 *
 * 2. **列表 = 注册表 ∪ 各会话的 cwd。**
 *    用户升级之前建的会话，其 cwd 从来没被注册过；如果只认注册表，
 *    他打开软件会发现「我的历史会话全不见了」。所以会话所在的文件夹
 *    一律自动算作工作区（exists=自动），注册表只额外记住那些**还没有会话**的
 *    空工作区（用户刚新建、还没开始聊）。
 *
 * 「移除工作区」只允许在它下面没有任何会话时执行——否则就是骗人：
 * 移除之后会话还在，它们会立刻把这一行带回来。
 */

const fs = require('fs');
const path = require('path');
const { writeTextFile } = require('./utils');

/** 注册表文件位置：跟着会话目录走（同一个配置目录下） */
function storeFile(cfg) {
  const base = path.dirname(cfg.session.dir || path.join(cfg.rootDir || process.cwd(), '.mya', 'sessions'));
  return path.join(base, 'workspaces.json');
}

/** 路径归一化：Windows 上大小写与斜杠都不该造成两个「同一个文件夹」 */
function normalize(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  const abs = path.resolve(raw);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/** 读出注册表原文（坏文件当作空表，不能因此起不来） */
function readAll(cfg) {
  const file = storeFile(cfg);
  try {
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : data.workspaces;
    if (!Array.isArray(list)) return [];
    return list
      .filter((w) => w && typeof w.path === 'string' && w.path.trim())
      .map((w) => ({
        path: path.resolve(w.path),
        name: String(w.name || path.basename(path.resolve(w.path)) || w.path),
        createdAt: w.createdAt || '',
      }));
  } catch {
    return [];
  }
}

function writeAll(cfg, list) {
  const file = storeFile(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeTextFile(file, JSON.stringify({ workspaces: list }, null, 2));
  return file;
}

/**
 * 完整工作区列表：注册表里的 + 会话 cwd 自动补的。
 * @param {object} cfg
 * @param {Array<{cwd:string, archived?:boolean}>} sessions 当前会话（内存+磁盘的合并结果）
 */
function list(cfg, sessions = []) {
  const registered = readAll(cfg);
  const byKey = new Map();
  for (const w of registered) byKey.set(normalize(w.path), { ...w, registered: true });

  const stat = new Map(); // key -> { total, archived }
  for (const s of sessions) {
    const key = normalize(s.cwd || '');
    if (!key) continue;
    const cur = stat.get(key) || { total: 0, archived: 0 };
    cur.total += 1;
    if (s.archived) cur.archived += 1;
    stat.set(key, cur);
    if (!byKey.has(key)) {
      // 会话所在的文件夹自动成为工作区（老会话因此不会凭空消失）
      byKey.set(key, {
        path: path.resolve(s.cwd),
        name: path.basename(path.resolve(s.cwd)) || s.cwd,
        createdAt: '',
        registered: false,
      });
    }
  }

  const out = [];
  for (const [key, w] of byKey) {
    const count = stat.get(key) || { total: 0, archived: 0 };
    let exists = false;
    try {
      exists = fs.statSync(w.path).isDirectory();
    } catch {
      exists = false;
    }
    out.push({
      path: w.path,
      name: w.name,
      createdAt: w.createdAt,
      registered: w.registered === true,
      exists,
      sessionCount: count.total,
      archivedCount: count.archived,
    });
  }
  // 排序：先按「有没有会话」，再按更新时间倒序——常用的排在上面
  out.sort((a, b) => {
    if (!a.sessionCount !== !b.sessionCount) return a.sessionCount ? -1 : 1;
    return String(b.createdAt).localeCompare(String(a.createdAt)) || a.name.localeCompare(b.name);
  });
  return out;
}

/** 新增一个工作区（目录必须真实存在；create=true 时替用户建出来） */
function add(cfg, dirPath, { create = false } = {}) {
  const raw = String(dirPath || '').trim();
  if (!raw) return { ok: false, error: '请选一个文件夹' };
  const abs = path.resolve(raw);

  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    stat = null;
  }
  if (!stat && create) {
    try {
      fs.mkdirSync(abs, { recursive: true });
      stat = fs.statSync(abs);
    } catch (err) {
      return { ok: false, error: `建不了这个目录：${err.message}` };
    }
  }
  if (!stat) return { ok: false, error: `目录不存在：${abs}` };
  if (!stat.isDirectory()) return { ok: false, error: `这不是目录：${abs}` };

  const all = readAll(cfg);
  if (all.some((w) => normalize(w.path) === normalize(abs))) {
    return { ok: true, existed: true, path: abs };
  }
  all.push({ path: abs, name: path.basename(abs) || abs, createdAt: new Date().toISOString() });
  writeAll(cfg, all);
  return { ok: true, existed: false, path: abs };
}

/**
 * 从注册表移除。
 * @param {number} sessionCount 这个工作区下现有的会话数（含已归档）
 */
function remove(cfg, dirPath, sessionCount = 0) {
  const abs = path.resolve(String(dirPath || '').trim());
  if (!abs) return { ok: false, error: '缺少路径' };
  if (sessionCount > 0) {
    return {
      ok: false,
      error: `这个工作区下还有 ${sessionCount} 个会话，先把它们删除或归档到别处再移除（只移除列表不会动你的文件，但会话会立刻把它带回来）`,
    };
  }
  const all = readAll(cfg);
  const next = all.filter((w) => normalize(w.path) !== normalize(abs));
  if (next.length === all.length) return { ok: false, error: '这个工作区不在列表里' };
  writeAll(cfg, next);
  return { ok: true, path: abs };
}

module.exports = { list, add, remove, storeFile, normalize, readAll };
