'use strict';

/**
 * 梦云 Agent —— API 配置库（多个「服务商 + 地址 + Key + 模型」的存档与一键切换）
 *
 * 为什么要有它：用户手上常有好几套配置——官方 Key、自建网关、公司中转站、
 * 本地 Ollama。现在换一次要手改四个输入框（服务商/地址/模型/Key），
 * 改错一个就是「明明点了保存却连不上」，而旧的那套 Key 一旦被覆盖就再也找不回来。
 * 所以：**存档留在库里，切换只按一个按钮**。
 *
 * 三条设计决定，都有理由：
 *
 * 1. **存在 `.mya/api-profiles.json`，不写进 config.json。**
 *    跟工作区注册表同一个道理：config.json 是用户手写的设置（注释、说明都在里面），
 *    这个文件是程序自己维护的状态。混在一起，用户改配置时会莫名多出字段，
 *    程序写配置时又可能把用户的注释冲掉。
 *
 * 2. **库里存真实 Key，但接口只回掩码。**
 *    不回明文是防「界面被旁看/截图」顺手泄露；不回明文不影响切换——
 *    切换是服务端从库里取真值去用，界面只需要知道"有 Key，尾号 xxx"。
 *    编辑某一条时若没重新填 Key，**保留原 Key**（否则改个模型名就把 Key 清空了）。
 *
 * 3. **切换 = 走和「保存设置」完全相同的那条路**（写配置 + 重建 provider）。
 *    另起一条路一定会分叉：provider 是在构造时把 endpoint/timeout/stream
 *    这些派生状态算好的，只改 cfg 字段会出现「界面显示新地址、请求还发到老地方」。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeTextFile } = require('./utils');

/** 存档文件位置：跟会话目录同一个配置目录（与 workspaces.json 并排） */
function storeFile(cfg) {
  const base = path.dirname(cfg.session.dir || path.join(cfg.rootDir || process.cwd(), '.mya', 'sessions'));
  return path.join(base, 'api-profiles.json');
}

/** 只保留认识的字段：库里存的东西要能长期活着，脏字段只会越长越多 */
function sanitize(p = {}) {
  const out = {
    id: String(p.id || ''),
    name: String(p.name || '').trim().slice(0, 60),
    provider: String(p.provider || '').trim(),
    baseUrl: String(p.baseUrl || '').trim().replace(/\/+$/, ''),
    model: String(p.model || '').trim(),
    apiFormat: String(p.apiFormat || 'auto').trim().toLowerCase(),
    apiKey: String(p.apiKey || ''),
    createdAt: p.createdAt || '',
    updatedAt: p.updatedAt || '',
  };
  return out;
}

function readAll(cfg) {
  const file = storeFile(cfg);
  try {
    if (!fs.existsSync(file)) return { version: 1, activeId: '', profiles: [] };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(data) ? data : data.profiles;
    return {
      version: 1,
      activeId: String((data && data.activeId) || ''),
      profiles: Array.isArray(list) ? list.map(sanitize).filter((p) => p.id) : [],
    };
  } catch {
    // 坏文件当作空库：配置库坏了不该让程序起不来（用户还能手动改 config.json 救）
    return { version: 1, activeId: '', profiles: [] };
  }
}

function writeAll(cfg, data) {
  const file = storeFile(cfg);
  writeTextFile(file, JSON.stringify({ version: 1, activeId: data.activeId || '', profiles: data.profiles || [] }, null, 2));
  return file;
}

/** 掩码：只露头尾，够用户认出「是哪一把」即可 */
function maskKey(key) {
  const k = String(key || '');
  if (!k) return '';
  if (k.length <= 8) return `${k.slice(0, 2)}***`;
  return `${k.slice(0, 4)}***${k.slice(-4)}`;
}

/** 给界面看的形态：**不含明文 Key** */
function publicView(p, activeId) {
  return {
    id: p.id,
    name: p.name,
    provider: p.provider,
    baseUrl: p.baseUrl,
    model: p.model,
    apiFormat: p.apiFormat,
    hasKey: !!p.apiKey,
    keyMasked: maskKey(p.apiKey),
    active: !!activeId && p.id === activeId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

function list(cfg) {
  const data = readAll(cfg);
  return { activeId: data.activeId, profiles: data.profiles };
}

/** 新增或更新；返回更新后的记录（含明文 Key，调用方自己决定怎么用） */
function upsert(cfg, input = {}) {
  const data = readAll(cfg);
  const now = new Date().toISOString();
  const id = String(input.id || '').trim();
  const idx = id ? data.profiles.findIndex((p) => p.id === id) : -1;

  /**
   * 名字的两种"没填"要分开对待：
   *   · 传了空字符串 → 用户明确留空了，拒绝（列表里一屏"未命名"没法认）
   *   · 完全没传字段 → 调用方不在意，替他起一个（比如「把当前配置存为一条」的场景）
   */
  if (input.name !== undefined && !String(input.name).trim()) {
    return { ok: false, error: '给这条配置起个名字吧（比如「官方 Key」「公司网关」），以后好认。' };
  }

  if (idx >= 0) {
    const prev = data.profiles[idx];
    const next = sanitize({ ...prev, ...input, id: prev.id, updatedAt: now });
    // 没重新填 Key 就沿用旧的：否则「只想改个模型名」会把 Key 清空
    next.apiKey = String(input.apiKey || '').trim() ? String(input.apiKey).trim() : prev.apiKey;
    next.createdAt = prev.createdAt || now;
    data.profiles[idx] = next;
    writeAll(cfg, data);
    return { ok: true, profile: next, created: false };
  }

  const created = sanitize({
    ...input,
    id: crypto.randomBytes(6).toString('hex'),
    createdAt: now,
    updatedAt: now,
  });
  if (!created.name) created.name = `${created.provider || 'custom'} · ${created.model || '未指定模型'}`;
  data.profiles.push(created);
  writeAll(cfg, data);
  return { ok: true, profile: created, created: true };
}

function remove(cfg, id) {
  const data = readAll(cfg);
  const before = data.profiles.length;
  data.profiles = data.profiles.filter((p) => p.id !== String(id || ''));
  if (data.profiles.length === before) return { ok: false, error: '这条配置已经不在了（可能被另一个窗口删掉了）。' };
  if (data.activeId === String(id || '')) data.activeId = '';
  writeAll(cfg, data);
  return { ok: true, removed: before - data.profiles.length };
}

function get(cfg, id) {
  return readAll(cfg).profiles.find((p) => p.id === String(id || '')) || null;
}

/** 记下"现在用的是哪一条"（切换成功后调用） */
function setActive(cfg, id) {
  const data = readAll(cfg);
  data.activeId = String(id || '');
  writeAll(cfg, data);
  return data.activeId;
}

/**
 * 界面拿不到明文 Key，所以切换必须在服务端完成：
 * 把存档里的配置转成 handleSaveSettings 能吃的形状（含真 Key）。
 */
function activationPayload(cfg, id) {
  const p = get(cfg, id);
  if (!p) return { ok: false, error: '这条配置不在了，刷新一下列表再试。' };
  return {
    ok: true,
    payload: {
      provider: p.provider,
      baseUrl: p.baseUrl,
      model: p.model,
      apiFormat: p.apiFormat || 'auto',
      // 存档里没 Key（比如本地 Ollama）就不传，别把当前 Key 清成空
      ...(p.apiKey ? { apiKey: p.apiKey } : {}),
    },
    profile: p,
  };
}

module.exports = { storeFile, list, upsert, remove, get, setActive, activationPayload, maskKey, publicView, sanitize };
