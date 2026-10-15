'use strict';

/**
 * 示例插件：fs-extra
 *
 * 用途：演示「怎么在插件里安全地访问文件系统」。
 * 关键点：
 *   - 用 ctx.resolvePath(p) 解析路径，自动限制在工作目录内
 *   - 用 ctx.utils 里现成的工具函数（哪些目录该忽略、怎么算文件大小）
 *   - 工具出错时 return { ok:false, content:'...' }，而不是 throw
 */

const fsp = require('fs/promises');
const path = require('path');

module.exports = {
  name: 'fs-extra',
  version: '0.1.0',
  description: '目录树 / 文件信息 工具',

  setup(ctx) {
    const { isIgnored, humanSize, timestamp } = ctx.utils;

    /* ---------------- 工具 1：目录树 ---------------- */
    ctx.registerTool({
      name: 'list_tree',
      description: [
        '以树状结构列出目录内容，比 glob 更适合「先概览项目结构」。',
        '自动跳过 node_modules、.git 等噪音目录，并限制输出规模。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径，默认工作目录' },
          depth: { type: 'integer', description: '最大递归深度，默认 3' },
          max_entries: { type: 'integer', description: '最多显示多少个条目，默认 200' },
        },
        required: [],
        additionalProperties: false,
      },
      tags: ['files', 'explore'],
      async run(args, tctx) {
        // 注意：insideOnly=true，插件也不能越出工作目录乱翻
        const root = args.path ? ctx.resolvePath(args.path, true) : tctx.cwd;
        const maxDepth = Math.max(1, Math.min(Number(args.depth) || 3, 8));
        const maxEntries = Math.max(10, Math.min(Number(args.max_entries) || 200, 1000));

        const lines = [];
        let count = 0;

        const walk = async (dir, prefix, depth) => {
          if (depth > maxDepth || count >= maxEntries) return;
          let entries;
          try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
          } catch (err) {
            lines.push(`${prefix}└─ [无法读取: ${err.code}]`);
            return;
          }
          entries.sort((a, b) => {
            if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
            return a.name.localeCompare(b.name);
          });

          for (const entry of entries) {
            if (count >= maxEntries) return;
            if (isIgnored(entry.name)) continue;
            count += 1;
            const isDir = entry.isDirectory();
            lines.push(`${prefix}${isDir ? '📁' : '📄'} ${entry.name}${isDir ? '/' : ''}`);
            if (isDir) {
              // eslint-disable-next-line no-await-in-loop
              await walk(path.join(dir, entry.name), `${prefix}   `, depth + 1);
            }
          }
        };

        await walk(root, '', 1);
        if (!lines.length) return { ok: true, content: `目录为空：${root}` };
        const truncated = count >= maxEntries ? `\n…（已达 ${maxEntries} 条上限，用 depth 或 path 缩小范围）` : '';
        return { ok: true, content: `${root}\n${lines.join('\n')}${truncated}` };
      },
    });

    /* ---------------- 工具 2：文件信息 ---------------- */
    ctx.registerTool({
      name: 'file_info',
      description: '查看文件或目录的元信息：大小、修改时间、类型、行数（文本文件）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件或目录路径' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      tags: ['files'],
      async run(args) {
        const target = ctx.resolvePath(args.path, true);
        let stat;
        try {
          stat = await fsp.stat(target);
        } catch {
          return { ok: false, content: `路径不存在：${target}` };
        }

        const info = [
          `路径：${target}`,
          `类型：${stat.isDirectory() ? '目录' : '文件'}`,
          `大小：${humanSize(stat.size)}`,
          `修改时间：${timestamp(stat.mtime)}`,
          `创建时间：${timestamp(stat.birthtime)}`,
        ];

        if (stat.isFile() && stat.size < 2 * 1024 * 1024) {
          try {
            const text = await fsp.readFile(target, 'utf8');
            info.push(`行数：${text.split(/\r?\n/).length}`);
          } catch {
            info.push('行数：无法作为文本读取（可能是二进制）');
          }
        }
        return { ok: true, content: info.join('\n') };
      },
    });

    /* ---------------- 工具 3：综合统计 ---------------- */
    ctx.registerTool({
      name: 'project_stats',
      description: '统计工作目录下的文件数量、体积分布和按扩展名排行，快速了解项目规模',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '统计起点，默认工作目录' },
          top: { type: 'integer', description: '显示前几名扩展名，默认 10' },
        },
        required: [],
        additionalProperties: false,
      },
      tags: ['files', 'explore'],
      autoApprove: true,
      async run(args, tctx) {
        const root = args.path ? ctx.resolvePath(args.path, true) : tctx.cwd;
        const top = Math.max(1, Math.min(Number(args.top) || 10, 50));
        const byExt = new Map();
        let files = 0;
        let dirs = 0;
        let totalBytes = 0;
        const visited = { count: 0 };

        const walk = async (dir) => {
          if (visited.count > 20000) return; // 防止在超大仓库里卡死
          let entries;
          try {
            entries = await fsp.readdir(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            if (isIgnored(entry.name)) continue;
            visited.count += 1;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              dirs += 1;
              // eslint-disable-next-line no-await-in-loop
              await walk(full);
            } else {
              files += 1;
              try {
                // eslint-disable-next-line no-await-in-loop
                const st = await fsp.stat(full);
                totalBytes += st.size;
                const ext = path.extname(entry.name).toLowerCase() || '(无扩展名)';
                const rec = byExt.get(ext) || { count: 0, bytes: 0 };
                rec.count += 1;
                rec.bytes += st.size;
                byExt.set(ext, rec);
              } catch {
                /* 忽略读不到的文件 */
              }
            }
          }
        };

        await walk(root);
        const ranking = [...byExt.entries()]
          .sort((a, b) => b[1].bytes - a[1].bytes)
          .slice(0, top)
          .map(([ext, rec], i) => `${String(i + 1).padStart(2, ' ')}. ${ext.padEnd(16)} ${String(rec.count).padStart(5)} 个  ${humanSize(rec.bytes)}`);

        return {
          ok: true,
          content: [
            `统计目录：${root}`,
            `文件 ${files} 个，目录 ${dirs} 个，总大小 ${humanSize(totalBytes)}`,
            '',
            '按体积排行的文件类型：',
            ...ranking,
            visited.count > 20000 ? '\n（目录过大，统计已提前结束）' : '',
          ].join('\n'),
        };
      },
    });
  },
};
