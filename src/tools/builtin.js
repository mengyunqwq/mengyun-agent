'use strict';

/**
 * 梦云 Agent —— 内置工具集
 *
 * 设计原则：
 *   1. 每个工具都返回「给模型看的文本」，出错也返回文本，不抛异常给上层。
 *   2. 危险操作（写文件、执行命令）标记 dangerous:true，由注册表的确认闸门把关。
 *   3. 路径默认只能在工作目录内活动，防止模型乱翻你的整个硬盘。
 *      需要放开时把 config.json 的 tools.insideOnly 设为 false。
 *
 * 想加自己的工具？不用改这个文件，去 plugins/ 下照着示例写插件即可。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { formatDiff } = require('../diff');
const {
  resolvePath,
  isDir,
  isIgnored,
  globToRegExp,
  truncate,
  humanSize,
  DEFAULT_IGNORE,
} = require('../utils');
const { CONFIRMED } = require('../tools');

/* ------------------------------------------------------------------ */
/* 路径与读取辅助                                                      */
/* ------------------------------------------------------------------ */

function ctxCwd(ctx) {
  return ctx.cwd || process.cwd();
}

/** 统一解析工具里的路径参数（兼容 path / file_path 两种写法） */
function pickPath(args, ctx) {
  const raw = args.path || args.file_path || args.filePath || args.file;
  return resolvePath(raw, ctxCwd(ctx), insideOnlyEnabled(ctx));
}

/**
 * 路径要不要限制在工作目录内（默认要）。
 *
 * 以前只有 read/write/edit 走这道检查，glob/grep/shell 传的是 `false`——
 * 于是 `grep { pattern: "PRIVATE KEY", path: "C:/Users" }` 能免确认地把
 * 工作目录之外的私钥读进上下文（而 grep 默认就在 tools.autoApprove 里）。
 * 文档写的是「路径默认锁在工作目录内」，实现却只有一部分工具做到了——
 * 这种「承诺与实现不一致」比明说不限制更糟，因为用户会照着文档去信任它。
 *
 * 真要让 agent 满盘跑，把 config.json 的 tools.insideOnly 设为 false（显式选择，
 * 也便于事后追溯是谁放开的）。
 */
function insideOnlyEnabled(ctx) {
  return ctx?.cfg?.tools?.insideOnly === false ? false : true;
}

/** 目录类参数（glob/grep 的 path、shell 的 cwd）统一走这里，享受同一套限域 */
function pickDirPath(raw, ctx) {
  if (!raw) return ctxCwd(ctx);
  return resolvePath(raw, ctxCwd(ctx), insideOnlyEnabled(ctx));
}

/**
 * 写文件/改文件之前记一个 git 检查点。
 *
 * 为什么放在工具这一层而不是 agent 里统一包：只有真正会改文件的工具需要它
 * （read/glob/grep 打点纯属浪费），而且工具自己最清楚「这次改的是哪个文件」，
 * 记进检查点的标签里最好用。
 *
 * 失败一律安静：不是 git 仓库、没装 git、目录太大超时——都不该让一次正常的写入失败。
 * 成功则返回一行提示，拼进工具结果（模型和用户都能看到怎么回滚）。
 */
async function checkpointBefore(ctx, label) {
  if (!ctx || typeof ctx.checkpoint !== 'function') return '';
  try {
    const ck = await ctx.checkpoint(label);
    if (!ck || !ck.ok) return '';
    return `（已记录检查点 ${String(ck.commit || '').slice(0, 7)}，可用 mya checkpoint restore ${ck.ref} 回滚）`;
  } catch {
    return ''; // 检查点是增强能力，不是依赖
  }
}

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.class', '.jar', '.wasm', '.mp3', '.mp4', '.mov',
  '.avi', '.ttf', '.woff', '.woff2', '.eot', '.sqlite', '.db', '.pyc',
]);

/** 只看扩展名的快速判断（用于决定要不要读文件） */
function extLooksBinary(filePath) {
  return BINARY_EXT.has(path.extname(filePath).toLowerCase());
}

/** 完整判断：扩展名 + 前 8KB 是否含 NUL 字节 */
function looksBinary(buffer, filePath) {
  if (extLooksBinary(filePath)) return true;
  return buffer.subarray(0, 8192).includes(0);
}

/** 带行号渲染内容，并限制单行长度（压缩过的 js 一行几万字符会把上下文撑爆） */
function withLineNumbers(text, startLine = 1, { maxLineLength = 2000 } = {}) {
  const lines = text.split(/\r?\n/);
  const width = String(startLine + lines.length - 1).length;
  return lines
    .map((line, i) => {
      const no = String(startLine + i).padStart(width, ' ');
      const shown = line.length > maxLineLength ? `${line.slice(0, maxLineLength)} …[本行还有 ${line.length - maxLineLength} 字符]` : line;
      return `${no}| ${shown}`;
    })
    .join('\n');
}

/* ------------------------------------------------------------------ */
/* 1. read —— 读文件                                                    */
/* ------------------------------------------------------------------ */

const readTool = {
  name: 'read',
  description: [
    '读取文本文件内容，返回带行号的文本，便于后续精确修改。',
    '支持 offset/limit 分段读取超大文件。图片等二进制文件会提示不支持。',
    '相对路径以工作目录为基准。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径（相对或绝对）' },
      offset: { type: 'integer', description: '从第几行开始读，从 1 计数，默认 1' },
      limit: { type: 'integer', description: '最多读取多少行，默认 2000' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const filePath = pickPath(args, ctx);
    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      const suggestion = await suggestSimilar(filePath);
      return { ok: false, content: `文件不存在：${filePath}${suggestion}` };
    }
    if (stat.isDirectory()) {
      const entries = await fsp.readdir(filePath, { withFileTypes: true });
      const listing = entries
        .slice(0, 200)
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .join('\n');
      return {
        ok: false,
        content: `${filePath} 是一个目录，不是文件。目录内容：\n${listing}\n（要列目录请用 glob 工具）`,
      };
    }
    if (stat.size > 5 * 1024 * 1024) {
      return {
        ok: false,
        content: `文件过大（${humanSize(stat.size)}），拒绝整体读取。请用 offset/limit 分段读取，或用 grep 定位关键片段。`,
      };
    }

    const buffer = await fsp.readFile(filePath);
    if (looksBinary(buffer, filePath)) {
      return { ok: false, content: `${path.basename(filePath)} 看起来是二进制文件（${humanSize(stat.size)}），无法作为文本读取。` };
    }

    const text = buffer.toString('utf8');
    const allLines = text.split(/\r?\n/);
    const offset = Math.max(1, Number(args.offset) || 1);
    const limit = Math.max(1, Number(args.limit) || 2000);
    const slice = allLines.slice(offset - 1, offset - 1 + limit);

    if (!slice.length) {
      return { ok: false, content: `offset=${offset} 超出文件行数（共 ${allLines.length} 行）。` };
    }

    const shown = withLineNumbers(slice.join('\n'), offset);
    const more = offset - 1 + slice.length < allLines.length;
    const footer = more
      ? `\n…（文件共 ${allLines.length} 行，已显示到第 ${offset - 1 + slice.length} 行；继续读请用 offset=${offset + slice.length}）`
      : `\n（文件结束，共 ${allLines.length} 行）`;

    return { ok: true, content: shown + footer };
  },
};

/** 文件不存在时，找找同目录下名字相近的文件，帮模型自己纠错 */
async function suggestSimilar(filePath) {
  try {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath).toLowerCase().replace(/\.[^.]+$/, '');
    const entries = await fsp.readdir(dir);
    const hit = entries.filter((e) => e.toLowerCase().includes(base) || base.includes(e.toLowerCase().replace(/\.[^.]+$/, '')));
    if (hit.length) return `\n同目录下相近的文件：${hit.slice(0, 8).join(', ')}`;
  } catch {
    /* 忽略 */
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* 2. write —— 写文件                                                   */
/* ------------------------------------------------------------------ */

const writeTool = {
  name: 'write',
  description: [
    '写入文件（覆盖整个文件，不存在则新建并自动创建父目录）。',
    '修改已有文件请优先用 edit，避免误删未读到的内容。',
    'append=true 时改为追加到文件末尾。',
  ].join('\n'),
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      content: { type: 'string', description: '完整文件内容' },
      append: { type: 'boolean', description: '是否追加模式，默认 false（覆盖）' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  /**
   * 写入前给用户看 diff。
   * 覆盖写入 = 旧内容 vs 新内容；追加 = 只显示新增的部分；新文件 = 全是 +。
   */
  async preview(args, ctx) {
    const filePath = pickPath(args, ctx);
    const content = String(args.content ?? '');
    const existed = fs.existsSync(filePath);
    const before = existed ? await fsp.readFile(filePath, 'utf8').catch(() => '') : '';
    if (args.append) {
      const after = before + content;
      return formatDiff(before, after, { path: `${args.path}（追加）` }).text;
    }
    const title = existed ? String(args.path) : `${args.path}（新文件）`;
    return formatDiff(before, content, { path: title }).text;
  },
  async run(args, ctx) {
    const filePath = pickPath(args, ctx);
    const content = String(args.content ?? '');
    if (isDir(filePath)) return { ok: false, content: `${filePath} 是目录，不能写入。` };

    // 动文件之前先记一个 git 检查点（在 git 仓库里才有意义；不是仓库就安静跳过）
    const ckNote = await checkpointBefore(ctx, `write ${args.path}`);

    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const existed = fs.existsSync(filePath);
    const before = existed ? (await fsp.stat(filePath)).size : 0;

    if (args.append) await fsp.appendFile(filePath, content, 'utf8');
    else await fsp.writeFile(filePath, content, 'utf8');

    const after = (await fsp.stat(filePath)).size;
    const lines = content.split(/\r?\n/).length;
    const action = args.append ? '追加' : existed ? '覆盖写入' : '新建';
    return {
      ok: true,
      content:
        `${action}成功：${filePath}\n${args.append ? '新增' : '共'} ${lines} 行，文件大小 ${humanSize(before)} → ${humanSize(after)}` +
        (ckNote ? `\n${ckNote}` : ''),
    };
  },
};

/* ------------------------------------------------------------------ */
/* 3. edit —— 精确替换                                                  */
/* ------------------------------------------------------------------ */

const editTool = {
  name: 'edit',
  description: [
    '对文件做精确字符串替换。old_string 必须在文件中唯一出现，否则会报错，',
    '此时请提供更长的上下文来保证唯一性。replace_all=true 可替换全部匹配。',
    '注意：old_string 必须与文件内容逐字符一致（包括缩进）。',
  ].join('\n'),
  dangerous: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要被替换的原文本（必须唯一）' },
      new_string: { type: 'string', description: '替换成的新文本' },
      replace_all: { type: 'boolean', description: '是否替换所有出现，默认 false' },
    },
    required: ['path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  /**
   * 编辑前给用户看 diff。
   *
   * 这里把 run() 的替换逻辑**重算一遍**（而不是把 new_string 直接贴出来）：
   * 用户要看的是「这个文件会变成什么样」，只看 new_string 看不出上下文，
   * 也看不出替换发生在哪几行。
   * 注意别在这里报错：找不到 old_string 这类问题由 run() 去说，预览只负责展示。
   */
  async preview(args, ctx) {
    const filePath = pickPath(args, ctx);
    if (!fs.existsSync(filePath)) return `（文件不存在：${args.path}，预览不可用）`;
    const original = await fsp.readFile(filePath, 'utf8').catch(() => '');
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');
    if (!oldStr || !original.includes(oldStr)) {
      return `（目前在 ${args.path} 里找不到 old_string，预览不可用——真正执行时会给出更具体的原因）`;
    }
    const updated = args.replace_all ? original.split(oldStr).join(newStr) : original.replace(oldStr, newStr);
    return formatDiff(original, updated, { path: args.path }).text;
  },
  async run(args, ctx) {
    const filePath = pickPath(args, ctx);
    if (!fs.existsSync(filePath)) return { ok: false, content: `文件不存在：${filePath}（修改前请先 read）` };

    const original = await fsp.readFile(filePath, 'utf8');
    const oldStr = String(args.old_string ?? '');
    const newStr = String(args.new_string ?? '');

    if (oldStr === newStr) return { ok: false, content: 'old_string 与 new_string 完全相同，无需修改。' };
    if (!oldStr) return { ok: false, content: 'old_string 不能为空。' };

    // 统计出现次数（用 split 计数，避免正则转义问题）
    const occurrences = original.split(oldStr).length - 1;
    if (occurrences === 0) {
      const hint = hintWhitespace(original, oldStr);
      return { ok: false, content: `在 ${filePath} 中找不到 old_string。${hint}` };
    }
    if (occurrences > 1 && !args.replace_all) {
      return {
        ok: false,
        content: `old_string 在文件中出现了 ${occurrences} 次，无法确定改哪一处。请提供更长的上下文使其唯一，或设置 replace_all=true。`,
      };
    }

    // 改文件之前先记一个 git 检查点（想精细到"改前 diff"就是从这里接）。
    // 放在所有校验之后：校验失败（找不到 old_string 之类）根本没动文件，不该白打一个点。
    const ckNote = await checkpointBefore(ctx, `edit ${args.path}`);

    /**
     * 统一用 split/join 做替换。
     *
     * 为什么不用 String.replace：它会在**替换串**里解释 `$$`、`$&`、`` $` ``、`$'`
     * 这些特殊模式，而 split/join 不会。于是同一个 new_string 在两种模式下结果不同：
     *   "PRICE = 100;".replace('100', '$$5')      → "PRICE = $5;"    ← 被悄悄改错
     *   "PRICE = 100;".split('100').join('$$5')   → "PRICE = $$5;"   ← 原文写什么就是什么
     * 走到这里时 old_string 已经校验过唯一性（除非 replace_all），所以 split/join
     * 与「只替换第一处」等价。
     */
    const updated = original.split(oldStr).join(newStr);

    await fsp.writeFile(filePath, updated, 'utf8');

    const replaced = args.replace_all ? occurrences : 1;
    return {
      ok: true,
      content:
        `修改成功：${filePath}\n替换 ${replaced} 处，文件行数 ${original.split('\n').length} → ${updated.split('\n').length}` +
        (ckNote ? `\n${ckNote}` : ''),
    };
  },
};

/** 替换失败时给点有用的提示：是不是缩进/行尾风格不一致 */
function hintWhitespace(original, oldStr) {
  const normalize = (s) => s.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (normalize(original).includes(normalize(oldStr))) {
    return '看起来内容存在，但缩进或换行符不一致。请先 read 该区域，严格照抄原文（注意空格与 CRLF）。';
  }
  const firstLine = oldStr.split('\n')[0].trim();
  if (firstLine && original.includes(firstLine)) {
    return `文件中存在片段 "${firstLine}"，但整段不匹配。建议用 read 查看该行附近的确切内容。`;
  }
  return '请先 read 该文件确认当前内容。';
}

/* ------------------------------------------------------------------ */
/* 4. glob —— 按文件名找                                               */
/* ------------------------------------------------------------------ */

const globTool = {
  name: 'glob',
  description: [
    '按通配符查找文件路径，返回按修改时间排序的结果。',
    '支持 **（跨目录）、*（单层）、?（单字符），例如 "src/**/*.ts"。',
    '自动跳过 node_modules、.git 等目录。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '通配符模式，如 "**/*.js"' },
      path: { type: 'string', description: '搜索起始目录，默认工作目录' },
      max_results: { type: 'integer', description: '最多返回条数，默认 200' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    // 搜索根目录同样限域：越界会直接报错，而不是把别人的文件读进来
    const rootDir = pickDirPath(args.path, ctx);
    const pattern = String(args.pattern);
    const maxResults = Math.max(1, Number(args.max_results) || 200);

    // 若 pattern 是绝对路径，转成相对 rootDir 的形式
    let relPattern = pattern.replace(/\\/g, '/');
    if (path.isAbsolute(pattern)) {
      relPattern = path.relative(rootDir, pattern).replace(/\\/g, '/');
    }
    const re = globToRegExp(relPattern);

    const results = [];
    const walk = async (dir, rel) => {
      if (results.length >= maxResults * 4) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= maxResults * 4) return;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (isIgnored(childRel)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, childRel);
        } else if (re.test(childRel) || re.test(entry.name)) {
          let mtime = 0;
          let size = 0;
          try {
            const st = await fsp.stat(full);
            mtime = st.mtimeMs;
            size = st.size;
          } catch {
            /* 忽略 */
          }
          results.push({ rel: childRel, mtime, size });
        }
      }
    };
    await walk(rootDir, '');

    if (!results.length) {
      return { ok: true, content: `没有匹配 "${pattern}" 的文件（搜索目录：${rootDir}）` };
    }
    results.sort((a, b) => b.mtime - a.mtime);
    const shown = results.slice(0, maxResults);
    const body = shown.map((r) => `${r.rel}  (${humanSize(r.size)})`).join('\n');
    const more = results.length > shown.length ? `\n…还有 ${results.length - shown.length} 个匹配未显示` : '';
    return { ok: true, content: `匹配到 ${results.length} 个文件（按修改时间从新到旧）：\n${body}${more}` };
  },
};

/* ------------------------------------------------------------------ */
/* 5. grep —— 按内容找                                                 */
/* ------------------------------------------------------------------ */

const grepTool = {
  name: 'grep',
  description: [
    '用正则表达式在文件内容里搜索，返回「文件:行号: 内容」。',
    '这是定位代码最快的方式，建议在 read 大文件之前先用它缩小范围。',
    '可用 include 限定文件类型，如 "*.js"；自动跳过 node_modules、.git 等目录。',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式，如 "function\\s+main"' },
      path: { type: 'string', description: '搜索目录或单个文件，默认工作目录' },
      include: { type: 'string', description: '文件名通配符过滤，如 "*.ts"' },
      ignore_case: { type: 'boolean', description: '是否忽略大小写，默认 false' },
      max_results: { type: 'integer', description: '最多返回匹配行数，默认 100' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const pattern = String(args.pattern);
    /**
     * 先用编译校验正则合法性（真正的匹配在 worker 里做）。
     * 编译结果不需要留下来——留着反而会被 eslint 判为未使用变量。
     */
    try {
      void new RegExp(pattern, args.ignore_case ? 'i' : '');
    } catch (err) {
      return { ok: false, content: `正则表达式无效：${err.message}` };
    }
    /**
     * 模式长度上限：又长又嵌套的正则几乎必然是回溯炸弹，
     * 与其让 worker 去撞 5 秒超时，不如直接说清楚。
     */
    if (pattern.length > 500) {
      return { ok: false, content: `正则太长了（${pattern.length} 字符，上限 500）：请缩小模式，或改用关键词搜索。` };
    }

    // 搜索目标同样限域（grep 默认免确认，绝不能满盘搜）
    const target = pickDirPath(args.path, ctx);
    const maxResults = Math.max(1, Number(args.max_results) || 100);
    const scanOpts = {
      root: target,
      pattern,
      ignoreCase: !!args.ignore_case,
      include: args.include ? String(args.include) : '',
      maxResults,
    };

    /**
     * 扫描丢进 worker 跑，带超时。
     *
     * 为什么非这样做：正则没有超时机制，`(a+)+$` 打在一行长文本上会把事件循环钉死
     * （实测 8 秒没出来）。而这个进程同时服务所有会话和 Web/SSE——那不是单个工具失败，
     * 是整个 agent 假死。放进 worker 之后，撞上回溯爆炸就把 worker 掐掉，
     * 主进程照常响应，并如实说明「结果可能不全」。
     *
     * worker 起不来（极老的 Node / 受限环境）就退回主线程直跑：
     * 宁可保留这个已知风险，也不能让 grep 直接不可用。
     */
    const { runGrepScan } = require('./grep-runner');
    const result = await runGrepScan(scanOpts, { timeoutMs: 5000, ctx });
    if (!result.ok) return { ok: false, content: result.error };

    const { matches, scanned, timedOut } = result;
    if (!matches.length) {
      // 超时时 scanned 是拿不到的真实值（worker 被掐掉了），别谎报"已扫描 0 个文件"
      const head = timedOut
        ? `没有找到匹配 "${pattern}"${args.include ? `（限定 ${args.include}）` : ''}——但这次搜索超时被中止了，结果不可信。`
        : `没有匹配 "${pattern}"${args.include ? `（限定 ${args.include}）` : ''}，已扫描 ${scanned} 个文件。`;
      return { ok: true, content: head };
    }
    const capped = matches.length >= maxResults ? `\n（已达上限 ${maxResults} 条，可能还有更多，请缩小搜索范围）` : '';
    const timeoutNote = timedOut
      ? '\n（这次搜索超时被中止了：模式可能有严重的回溯问题，结果不保证完整。建议换个更具体的模式。）'
      : '';
    return { ok: true, content: `找到 ${matches.length} 处匹配：\n${matches.join('\n')}${capped}${timeoutNote}` };
  },
};

/* ------------------------------------------------------------------ */
/* 6. shell —— 执行命令                                                */
/* ------------------------------------------------------------------ */

/**
 * 即使开了「允许任意命令」，这些破坏性操作也永远要人确认一次。
 *
 * 这是**体验护栏**，不是安全边界：正则黑名单天生可以被绕过（改个写法就行）。
 * 它的作用是挡住「顺手把根目录删了」这类显而易见的灾难，真正的边界是权限档位本身。
 * 底下这几条是补漏：`rm -fr /`、`rm -r -f /`、`git push -f`、`del /s /q C:\`
 * 以前都不在名单里（只认字面 `-rf` 和 `--force`）。
 */
const ALWAYS_DANGEROUS = [
  /rm\s+-(rf|fr)\s+[/~]/i,
  /rm\s+-r\s+-f\s+[/~]/i,
  /rm\s+-f\s+-r\s+[/~]/i,
  /Remove-Item.*-Recurse.*-Force/i,
  /\bdel\s+\/[sq]/i,
  /format\s+[a-z]:/i,
  /Format-Volume/i,
  /mkfs/i,
  /dd\s+if=/i,
  /:\(\)\s*\{.*\};\s*:/, // fork 炸弹
  /shutdown|Restart-Computer|Stop-Computer/i,
  /git\s+push\s+.*(-f\b|--force)/i,
  /npm\s+publish|pnpm\s+publish/i,
  /curl.*\|\s*(ba)?sh/i,
  /\bdiskpart\b/i,
];

/**
 * allowDangerous=false 时只放行这些「只读查询」命令。
 *
 * 收录标准（改这份清单前先读一遍）：
 *   · **不能执行代码** —— 所以 node / python / find 这类通用解释器与执行器不能进来。
 *     曾经 `node` 就在里面：`node -p "..."` 一个被拦字符都没有，
 *     等于把「任意代码执行」伪装成「只读查询」（实测在工作区档下免确认就跑起来了）。
 *   · **不能打印文件内容** —— 所以 cat / type / head / tail / wc / Get-Content /
 *     Select-String / git show / git diff 不能进来。它们能读**工作目录之外**的文件，
 *     这就是「读一段恶意文本 → 顺手把 ~/.ssh/id_rsa、config.json 读进上下文」的直达路径。
 *     要看文件内容就走 read 工具：它受限域 + 敏感文件确认两道闸门。
 *   · 剩下的只有「列目录 / 看环境 / 查版本 / 查 git 状态」这类信息量有限的命令。
 *
 * 它是**体验护栏**，不是安全边界：真正兜底的是确认闸门（见 isAlwaysDangerous 与工具自身判断）。
 */
const SAFE_COMMAND_PREFIXES = [
  'ls', 'dir', 'pwd', 'cd', 'echo', 'where', 'which',
  'Get-ChildItem', 'Get-Location', 'Test-Path',
  'tree', 'date', 'whoami', 'hostname', 'ver', 'systeminfo',
  'node --version', 'node -v', 'npm ls', 'pnpm ls', 'yarn list',
  'python --version', 'python3 --version', 'py --version',
  'git status', 'git branch', 'git remote', 'git log',
  'tsc --noEmit', 'pytest --collect-only', 'go version', 'java -version', 'dotnet --version',
];

function isSafeCommand(command) {
  const trimmed = String(command).trim();
  if (!trimmed) return false;
  /**
   * 出现下面任何东西，就一律不算「安全只读」：
   *   ; & | > < `        —— 命令链、重定向、反引号
   *   $( ${ $            —— 命令替换与变量展开（`$` 全挡：PowerShell 的 `$env:X`
   *                          能直接打印环境变量，只挡 `${`/`$(` 是不够的）
   *   \n \r              —— 多行命令在 `powershell -Command` 下会被依次执行，
   *                          只在第一行看着像只读，第二行想干什么都行
   * 注意：不能把这几个字符先删掉再判断，否则 `ls || rm -rf /`
   * 会被替换成 `ls  rm -rf /` 从而骗过白名单。
   */
  if (/[;&|><`$\r\n]/.test(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  return SAFE_COMMAND_PREFIXES.some((p) => lower === p.toLowerCase() || lower.startsWith(`${p.toLowerCase()} `));
}

function isAlwaysDangerous(command) {
  return ALWAYS_DANGEROUS.some((re) => re.test(command));
}

/**
 * 子进程的环境变量白名单。
 *
 * 为什么不再整体继承 process.env：任何被执行的命令（包括 npm install 触发的
 * postinstall）本来都能读到父进程的全部环境变量——代理凭据、云厂商 token、
 * 用户自己 export 的密钥都在里面。agent 没有理由把这些交给一条命令。
 *
 * 名字里像密钥的一律不给（KEY / TOKEN / SECRET / PASSWORD / CREDENTIAL），
 * 只留真正跑得起来所必需的那几个。
 */
const ENV_KEEP = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'LANG', 'LC_ALL', 'TZ', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData',
  'SHELL', 'TERM', 'USER', 'USERNAME', 'LOGNAME', 'PWD',
];

function childEnv(ctx) {
  const out = {};
  const deny = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE)/i;
  for (const name of ENV_KEEP) {
    const value = process.env[name];
    if (value !== undefined) out[name] = value;
  }
  // 兜底：没有 PATH 就没法执行任何东西，尽量凑一个
  if (!out.PATH && !out.Path) {
    const base = process.env.PATH || process.env.Path || '';
    if (base) out.PATH = base;
  }
  // 工具自己额外要传的变量（很少用），但同样不许覆盖敏感名字
  for (const [k, v] of Object.entries((ctx && ctx.env) || {})) {
    if (deny.test(k)) continue;
    out[k] = v;
  }
  void deny;
  return out;
}

const shellTool = {
  name: 'shell',
  description: [
    '在系统 shell 中执行一条命令并返回输出，用于运行测试、构建、安装依赖、查看环境等。',
    'Windows 上走 PowerShell，Linux/macOS 上走 sh。',
    '默认只允许只读命令；其他命令需要用户确认。请一次只执行一条命令，不要用 && 串很长的链。',
  ].join('\n'),
  dangerous: true,
  needsConfirm: true,
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      cwd: { type: 'string', description: '执行目录，默认工作目录' },
      timeout: { type: 'integer', description: '超时秒数，默认取配置 shell.timeoutSec' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  /**
   * 「这次要不要问用户」由 shell 自己判断：
   *   - 只读白名单命令（ls/cat/git status…）→ 直接执行，体验流畅
   *   - 其他命令 → 交给注册表弹确认
   * （高破坏性命令在 run() 里还有第二道确认）
   */
  /**
   * 「这次要不要问用户」由 shell 自己判断，并且**跟着权限档位走**：
   *   - 高破坏性命令（rm -rf /、git push --force…）→ 永远要问，任何档位都不绕
   *   - ask 档：只读白名单（ls/cat/git status…）免问，其它都问
   *   - workspace / full 档：命令不再逐条问（agent 本来就在工作目录里干活）
   */
  needsConfirmation(args, cfg, mode) {
    const command = String((args && args.command) || '');
    if (isAlwaysDangerous(command)) return true;
    if (mode === 'workspace' || mode === 'full') return false;
    return !isSafeCommand(command);
  },
  /**
   * 自定义确认策略：
   *  - 只读白名单命令 → 免确认（体验接近 Codex 的自动执行）
   *  - 破坏性命令 → 即使开了 --yes 也要确认（在 registry 之上再兜一层）
   */
  async run(args, ctx) {
    const command = String(args.command || '').trim();
    // 命令的执行目录也限域：不然先 cd 到外面再干别的就绕过了所有检查
    const cwd = pickDirPath(args.cwd, ctx);
    const timeoutSec = Math.max(1, Number(args.timeout) || ctx.cfg?.shell?.timeoutSec || 60);

    if (!command) return { ok: false, content: 'command 不能为空。' };

    // 注册表已经把「允许执行 shell 吗」问过一遍了，这里不再重复问；
    // 而且要不要问是跟着权限档位走的（见 needsConfirmation）：
    // 工作区/完全权限档下普通命令直接跑，只对「高破坏性命令」追加一道确认。
    const alreadyConfirmed = args[CONFIRMED] === true;
    const dangerous = isAlwaysDangerous(command);
    const safe = isSafeCommand(command);
    const mode = (ctx.cfg && ctx.cfg.approval && ctx.cfg.approval.mode) || 'ask';
    const permissive = mode === 'workspace' || mode === 'full';

    if (dangerous && !alreadyConfirmed) {
      const approved = await ctx.confirm(`⚠ 高破坏性命令，确认执行？\n     $ ${command}`, {
        defaultValue: false,
      });
      if (!approved) return { ok: false, content: '用户拒绝执行该高破坏性命令。' };
    } else if (!safe && !alreadyConfirmed && !permissive) {
      const approved = await ctx.confirm(
        `只读白名单没覆盖这条命令。\n     仍要执行吗？\n     $ ${command}`,
        { defaultValue: false },
      );
      if (!approved) {
        return {
          ok: false,
          content: `命令未获批准，未执行：${command}\n提示：想少弹确认，可以在输入区的「权限」里切到「工作区内」；要临时全放开则是「完全权限」。`,
        };
      }
    }

    return runCommand(command, cwd, timeoutSec, ctx);
  },
};

/**
 * 一次命令最多容忍多少输出（stdout + stderr 合计）。
 *
 * 为什么要有这个上限：脚本一旦进入「while(true) 里 print」这类状态，
 * 输出是没有尽头的。只做「截断」的话内存会一直涨，SSE 也会被刷爆，
 * 前端跟着卡死。到这条线就直接把进程砍掉，并如实告诉用户原因。
 */
const MAX_OUTPUT_BYTES = 512 * 1024;

/** 真正做进程调用；用 spawn 而不是 exec，避免命令注入和 shell 转义问题 */
function runCommand(command, cwd, timeoutSec, ctx) {
  return new Promise((resolve) => {
    // 工作目录不存在时，绝不能往下走。
    //
    // 不检查的话 Node 会抛 `spawn powershell.exe ENOENT` —— 这个错误**只提
    // 可执行文件名，完全不提 cwd**。于是「工作目录被删了」会被读成
    // 「powershell 没装 / PATH 坏了」，模型会朝完全错误的方向排查好几轮，
    // 每一轮还都要用户点一次确认（真踩过：白白烧掉几十万 token）。
    if (!fs.existsSync(cwd)) {
      resolve({
        ok: false,
        content:
          `工作目录不存在：${cwd}\n` +
          '命令没有执行。常见原因是会话记住的是一个临时目录，而它已经被系统清理掉了。\n' +
          '正确做法是让用户重新选一个工作目录（界面上点「新建会话」可以选），' +
          '不要反复重试同一条命令，也不要改动命令内容再试。',
      });
      return;
    }

    const isWin = process.platform === 'win32';
    const file = isWin ? 'powershell.exe' : '/bin/sh';
    const shellArgs = isWin
      ? [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          // 中文 Windows 上 powershell 默认按 GBK 往管道里写字节，我们按
          // UTF-8 解码就会满屏乱码。先把它掰成 UTF-8（个别环境设不了就跳过）。
          `try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}; ${command}`,
        ]
      : ['-c', command];

    let child;
    try {
      child = spawn(file, shellArgs, {
        cwd,
        windowsHide: true,
        // stdin 接空设备：脚本里若有 Read-Host / pause / read 之类的交互等待，
        // 会立刻拿到 EOF，而不是把命令一直挂到超时。
        stdio: ['ignore', 'pipe', 'pipe'],
        // 只给一份白名单环境变量：命令拿不到父进程里的密钥/凭据（见 childEnv）
        env: childEnv(ctx),
      });
    } catch (err) {
      resolve({ ok: false, content: `无法启动命令：${err.message}` });
      return;
    }

    let stdout = '';
    let stderr = '';
    let received = 0;
    let stopReason = ''; // '' | 'timeout' | 'flood'
    let settled = false;

    /**
     * 杀掉整棵进程树。
     * Windows 上必须用 taskkill /T：只杀 powershell 的话，它拉起的
     * 子进程（node、npm、脚本自己）会变成孤儿继续跑，端口和文件锁
     * 都不释放——就是「明明停了，软件还是动不了」的根源。
     */
    const killTree = () => {
      try {
        if (isWin) {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
          killer.on('error', () => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* 已经退出了 */
            }
          });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经退出了 */
        }
      }
    };

    const timer = setTimeout(() => {
      stopReason = 'timeout';
      killTree();
    }, timeoutSec * 1000);

    /** 收输出：到上限就砍进程，而不是无限往字符串里堆 */
    const collect = (d, which) => {
      received += d.length;
      if (received > MAX_OUTPUT_BYTES) {
        if (!stopReason) {
          stopReason = 'flood';
          killTree();
        }
        return;
      }
      if (which === 'out') stdout += d.toString();
      else stderr += d.toString();
    };

    child.stdout.on('data', (d) => collect(d, 'out'));
    child.stderr.on('data', (d) => collect(d, 'err'));

    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const parts = [];
      if (stopReason === 'timeout') parts.push(`命令超时（${timeoutSec}s）已被终止。`);
      if (stopReason === 'flood') {
        parts.push(
          `命令输出超过 ${humanSize(MAX_OUTPUT_BYTES)} 已被强制终止——通常是脚本在死循环里刷日志。`,
        );
      }
      parts.push(`退出码：${exitCode === null ? '被终止' : exitCode}`);
      if (stdout.trim()) parts.push(`--- 标准输出 ---\n${stdout.trim()}`);
      if (stderr.trim()) parts.push(`--- 标准错误 ---\n${stderr.trim()}`);
      if (!stdout.trim() && !stderr.trim()) parts.push('(命令没有任何输出)');

      const ok = !stopReason && exitCode === 0;
      resolve({ ok, content: truncate(parts.join('\n'), 60000) });
    };

    child.on('error', (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ ok: false, content: `命令执行失败：${err.message}` });
    });
    child.on('close', (code) => finish(code));
  });
}

/* ------------------------------------------------------------------ */

/** 导出：注册表会遍历这个数组逐个注册 */
const builtinTools = [readTool, writeTool, editTool, globTool, grepTool, shellTool];

module.exports = {
  builtinTools,
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  shellTool,
  isSafeCommand,
  isAlwaysDangerous,
  childEnv,
  SAFE_COMMAND_PREFIXES,
  DEFAULT_IGNORE,
};
