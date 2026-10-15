'use strict';

/**
 * 梦云 Agent —— grep 的扫描器（独立模块，专门给 worker 用）
 *
 * 为什么要单独一个文件 + 放进 worker：
 * 正则匹配是**没有超时机制**的。模型完全可以给出 `(a+)+$` 这种回溯爆炸的模式，
 * 只要有一行够长，主线程就会被钉死在一次 `re.test()` 里——而这个进程同时服务
 * 所有会话和 Web/SSE，所以那不是「一个会话失败」，是**整个 agent 假死**（实测 8 秒没出来）。
 *
 * 放在 worker 里的好处：真撞上回溯爆炸时，主线程照常响应，我们按超时把 worker
 * `terminate()` 掉，返回已经找到的部分结果并说明原因。零依赖（Node 自带 worker_threads）。
 *
 * 扫描逻辑和原来的实现保持一致（逐文件、跳过忽略目录与二进制、超大文件跳过、
 * 单行输出截断到 300 字符），只是把「谁在跑」换了个地方。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { globToRegExp, isIgnored } = require('./utils');

/** 单行最多测多少字符（超出部分不参与匹配，避免超长行把回溯成本放大） */
const MAX_LINE_TEST = 4000;

async function extLooksBinary(file) {
  const bin = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.tgz',
    '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.bin', '.woff', '.woff2', '.ttf', '.mp3',
    '.mp4', '.mov', '.avi', '.class', '.jar', '.pyc', '.node', '.wasm',
  ]);
  return bin.has(path.extname(file).toLowerCase());
}

/**
 * 扫描一批文件。
 * @param {{root:string, pattern:string, ignoreCase?:boolean, include?:string, maxResults?:number}} opts
 * @returns {Promise<{matches:string[], scanned:number, timedOutLine?:boolean}>}
 */
async function scan(opts) {
  const { root, pattern, ignoreCase = false, include = '', maxResults = 100 } = opts || {};
  const flags = ignoreCase ? 'i' : '';
  const re = new RegExp(String(pattern), flags); // 非法正则由调用方先校验
  const includeRe = include ? globToRegExp(String(include).replace(/\\/g, '/')) : null;
  const matches = [];
  let scanned = 0;

  const checkFile = async (full, rel) => {
    if (matches.length >= maxResults) return;
    if (includeRe && !includeRe.test(path.basename(full))) return;
    if (await extLooksBinary(full)) return;
    let stat;
    try {
      stat = await fsp.stat(full);
    } catch {
      return;
    }
    if (stat.size > 2 * 1024 * 1024) return; // 超大文件跳过，避免卡死
    let text;
    try {
      text = await fsp.readFile(full, 'utf8');
    } catch {
      return;
    }
    scanned += 1;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (matches.length >= maxResults) return;
      const line = lines[i].length > MAX_LINE_TEST ? lines[i].slice(0, MAX_LINE_TEST) : lines[i];
      if (re.test(line)) {
        const shown = line.length > 300 ? `${line.slice(0, 300)}…` : line;
        matches.push(`${rel}:${i + 1}: ${shown}`);
      }
      re.lastIndex = 0; // 防御性重置（pattern 可能带 g 标志）
    }
  };

  const walk = async (dir, rel) => {
    if (matches.length >= maxResults) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (matches.length >= maxResults) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (isIgnored(childRel)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, childRel);
      else await checkFile(full, childRel);
    }
  };

  let isDirTarget = false;
  try {
    isDirTarget = fs.statSync(root).isDirectory();
  } catch {
    throw new Error(`路径不存在或读不了：${root}`);
  }
  if (isDirTarget) await walk(root, '');
  else await checkFile(root, path.basename(root));

  return { matches, scanned };
}

module.exports = { scan, MAX_LINE_TEST };

/* ------------------------------------------------------------------ */
/* worker 入口：只有被 worker_threads 拉起时才走这里                    */
/* ------------------------------------------------------------------ */

if (require('worker_threads').isMainThread === false) {
  const { parentPort, workerData } = require('worker_threads');
  scan(workerData)
    .then((result) => parentPort.postMessage({ ok: true, ...result }))
    .catch((err) => parentPort.postMessage({ ok: false, error: String((err && err.message) || err) }));
}
