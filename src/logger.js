'use strict';

/**
 * 梦云 Agent —— 结构化日志
 *
 * 为什么单独做一个：以前排障只有两条路——控制台（关了窗口就没了）和散落各处的
 * `console.log`（没有级别、没有上下文、没法过滤）。程序是「开着窗口一直跑」的，
 * 出问题时最想知道的是「刚才那 30 秒发生了什么」，而不是「现在屏幕上有什么」。
 *
 * 设计取舍：
 *   · **零依赖**：自己写 120 行，比引 pino/winston 更符合这个项目的调性（运行时零依赖）。
 *   · **JSON Lines 落盘**：一行一条记录，`tail`/`grep`/喂给别的工具都好使；
 *     控制台仍然是给人看的一行文本。
 *   · **永不抛异常**：日志写不进去（目录只读、盘满）只吞掉——日志把程序搞崩是最蠢的失败。
 *   · **默认脱敏**：key/token/secret/password/authorization 这类字段一律打码，
 *     免得「为了排障把密钥写进日志」这种经典事故。
 *
 * 环境变量：
 *   MYA_LOG_LEVEL   error | warn | info | debug | trace（默认 info）
 *   MYA_LOG_DIR     日志目录（默认 <dataDir>/logs）
 *   MYA_LOG_CONSOLE 1/0 强制开关控制台输出（默认：TTY 时开）
 *   MYA_LOG_STDERR  1 时把日志写到 stderr 而不是 stdout（CLI 管道友好）
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const LEVEL_LABELS = ['error', 'warn', 'info', 'debug', 'trace'];
/** 超过这个大小就轮转（单文件，最多留 3 个历史文件） */
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_FILES = 3;
/** 字段名命中这些词的，值一律打码 */
const SECRET_KEY = /(api[_-]?key|token|secret|password|passwd|authorization|cookie|credential)/i;

function levelValue(name) {
  const key = String(name || '')
    .trim()
    .toLowerCase();
  return LEVELS[key] === undefined ? LEVELS.info : LEVELS[key];
}

/** 打码：保留前后各 2~4 个字符，够辨认「是不是同一个 key」，又不泄漏内容 */
function mask(value) {
  const s = String(value);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}***${s.slice(-2)}`;
}

/** 递归脱敏（只处理普通对象/数组，深度有限，避免大对象把日志拖死） */
function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…(截断)` : value;
  if (typeof value !== 'object') return value;
  if (depth > 3) return '[对象太深，已省略]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) ? mask(v) : redact(v, depth + 1);
  }
  return out;
}

class Logger {
  /**
   * @param {object} [opts]
   * @param {string} [opts.name]    日志器名字（会写进每条记录）
   * @param {string} [opts.dir]     日志目录；给了才落盘
   * @param {string} [opts.level]   级别名
   * @param {boolean} [opts.console] 是否同时打控制台
   * @param {Logger} [opts.parent]  父日志器（继承 dir/level/console，名字用 / 拼）
   */
  constructor(opts = {}) {
    const parent = opts.parent || null;
    this.name = opts.name || (parent ? parent.name : 'mya');
    this.dir = opts.dir !== undefined ? opts.dir : parent ? parent.dir : '';
    this.level = levelValue(opts.level !== undefined ? opts.level : parent ? parent.level : process.env.MYA_LOG_LEVEL);
    this.levelName = LEVEL_LABELS[this.level];
    this.file = this.dir ? path.join(this.dir, 'mya.log') : '';
    this.console =
      opts.console !== undefined
        ? !!opts.console
        : parent
          ? parent.console
          : process.env.MYA_LOG_CONSOLE !== undefined
            ? process.env.MYA_LOG_CONSOLE !== '0'
            : Boolean(process.stdout && process.stdout.isTTY);
    this.fd = null;
    this.errors = 0;
  }

  /** 派生一个子日志器（共享文件与级别，名字带上父名） */
  child(name) {
    return new Logger({ parent: this, name: `${this.name}/${name}` });
  }

  /**
   * 打开日志文件（懒加载：第一次真要写时才建目录）。
   *
   * 为什么用一个常驻 fd + fs.writeSync，而不是 createWriteStream：
   * 流是缓冲的，刚写的一条要等下一个 tick 才落盘，于是
   * 「刚出错 → 立刻打开 /api/logs 或 mya logs 看」会**看不到那条**（本地测试踩到过）。
   * 日志的价值就在于「出事的当下能读到」，所以这里宁可同步写。
   * 量级上也不心疼：一次工具调用才几条，同步 write 的开销远小于一次网络请求。
   */
  #ensureFd() {
    if (!this.file || this.fd !== null) return this.fd;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      this.fd = fs.openSync(this.file, 'a');
    } catch {
      this.errors += 1;
      this.fd = null;
    }
    return this.fd;
  }

  #closeFd() {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch {
      /* 忽略 */
    }
    this.fd = null;
  }

  /** 超过上限就轮转：mya.log → mya.log.1 → mya.log.2 … */
  #rotateIfNeeded() {
    if (!this.file) return;
    try {
      if (!fs.existsSync(this.file)) return;
      if (fs.statSync(this.file).size < MAX_BYTES) return;
      this.#closeFd();
      for (let i = KEEP_FILES - 1; i >= 1; i -= 1) {
        const from = `${this.file}.${i}`;
        const to = `${this.file}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      /* 文件不存在 / 被占用：跳过轮转，继续写 */
    }
  }

  /** 组装一条记录（控制台文本 + JSON 行都用它） */
  #build(level, message, fields) {
    return {
      ts: new Date().toISOString(),
      level,
      logger: this.name,
      msg: typeof message === 'string' ? message : JSON.stringify(redact(message)),
      ...(fields && typeof fields === 'object' ? redact(fields) : {}),
    };
  }

  #emit(record, toConsole) {
    if (toConsole && this.console) {
      // 控制台（给人看）：时间只留时分秒，短一点
      const time = record.ts.slice(11, 19);
      const { ts, level, logger, msg, ...rest } = record;
      const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
      const line = `${time} [${level}] ${logger}: ${msg}${extra}`;
      const out = process.env.MYA_LOG_STDERR === '1' ? process.stderr : process.stdout;
      try {
        out.write(line + '\n');
      } catch {
        /* 控制台写不进去就算了 */
      }
    }
    // 落盘（给机器看）：JSON Lines
    try {
      this.#rotateIfNeeded();
      const fd = this.#ensureFd();
      if (fd !== null) fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    } catch {
      this.errors += 1;
      this.#closeFd(); // fd 可能已经失效（磁盘满/句柄被回收），下次重开
    }
  }

  log(level, message, fields) {
    const name = LEVELS[level] === undefined ? 'info' : level;
    if (LEVELS[name] > this.level) return;
    this.#emit(this.#build(name, message, fields), true);
  }

  /**
   * 只写文件、不打控制台。
   * 用途：调用点已经自己往控制台打了一行（比如插件宿主保留了原来的 [插件:xxx] 格式），
   * 不想在控制台上出现两份，只想在日志文件里留一条结构化记录。
   */
  record(level, message, fields) {
    const name = LEVELS[level] === undefined ? 'info' : level;
    if (LEVELS[name] > this.level) return;
    this.#emit(this.#build(name, message, fields), false);
  }

  error(message, fields) {
    this.log('error', message, fields);
  }

  warn(message, fields) {
    this.log('warn', message, fields);
  }

  info(message, fields) {
    this.log('info', message, fields);
  }

  debug(message, fields) {
    this.log('debug', message, fields);
  }

  trace(message, fields) {
    this.log('trace', message, fields);
  }

  /** 是否值得记这条级别的日志（给「拼字符串很贵」的调用点省开销） */
  enabled(level) {
    return (LEVELS[level] === undefined ? LEVELS.info : LEVELS[level]) <= this.level;
  }

  /** 读最近 n 条（从当前文件尾部倒着扫，不把整个文件读进内存） */
  tail(n = 100) {
    if (!this.file || !fs.existsSync(this.file)) return [];
    const want = Math.max(1, Math.min(Number(n) || 100, 2000));
    let fd = null;
    try {
      fd = fs.openSync(this.file, 'r');
      const size = fs.fstatSync(fd).size;
      const chunk = Math.min(size, 256 * 1024); // 最多回读 256KB，够 100 条了
      const buf = Buffer.alloc(chunk);
      fs.readSync(fd, buf, 0, chunk, size - chunk);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      return lines
        .slice(-want)
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { ts: '', level: 'info', logger: this.name, msg: line };
          }
        })
        .reverse();
    } catch {
      return [];
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          /* 忽略 */
        }
      }
    }
  }

  /**
   * 关掉文件句柄。
   *
   * 注意：写是同步的，所以这里没有「还没落盘的数据」——它的用途是
   * 让 Windows 上能安全地移动/删除日志目录（比如测试收尾、卸载程序）。
   */
  async flush() {
    this.#closeFd();
  }

  /** 同步关闭（进程退出钩子里用） */
  close() {
    this.#closeFd();
  }
}

/**
 * 给某份配置建一个根日志器。
 *
 * 日志默认落在 **工作目录的 .mya/logs** 里——和 audit.log 同一个地方，
 * 一来「这个项目的日志」天然聚在一起，二来 .mya/ 早就在 .gitignore 里，
 * 不会因为跑一次命令就在仓库根冒出一个新目录。
 */
function createLogger(cfg, opts = {}) {
  const dir = opts.dir || process.env.MYA_LOG_DIR || (cfg && cfg.cwd ? path.join(cfg.cwd, '.mya', 'logs') : '');
  return new Logger({ name: opts.name || 'mya', dir, level: opts.level, console: opts.console });
}

module.exports = { Logger, createLogger, LEVELS, LEVEL_LABELS, redact, mask, MAX_BYTES };
