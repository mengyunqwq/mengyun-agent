'use strict';

/**
 * 梦云 Agent —— 终端界面层
 * 只负责「好看的输出」和「读用户输入」，不含任何业务逻辑。
 * 想换成 Web / GUI 界面时，改这一个文件即可（或再写一个 ui.web.js 替换）。
 */

const readline = require('readline');

/* ---------------- 颜色 ---------------- */
const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.NO_COLOR !== '1' &&
  (process.stdout.isTTY || process.env.FORCE_COLOR === '1');

const wrap = (code) => (s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s));

const c = {
  reset: wrap(0),
  bold: wrap(1),
  dim: wrap(2),
  italic: wrap(3),
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  blue: wrap(34),
  magenta: wrap(35),
  cyan: wrap(36),
  gray: wrap(90),
  bgBlue: wrap(44),
};

/* ---------------- 基础打印 ---------------- */
const out = (s = '') => process.stdout.write(`${s}\n`);
const raw = (s = '') => process.stdout.write(s);
/** 不做任何修饰的直出（日志、表格、导出内容用） */
const plain = out;

const log = {
  info: (s) => out(`${c.cyan('·')} ${s}`),
  ok: (s) => out(`${c.green('✓')} ${s}`),
  warn: (s) => out(`${c.yellow('!')} ${s}`),
  error: (s) => out(`${c.red('✗')} ${s}`),
  dim: (s) => out(c.gray(s)),
  title: (s) => out(`\n${c.bold(c.cyan(s))}`),
  plain: out,
  raw,
  c,
};

/** 带缩进的多行文本块 */
function block(text, { indent = '  ', color = c.gray, maxLines = 0 } = {}) {
  let lines = String(text).split(/\r?\n/);
  let truncated = 0;
  if (maxLines > 0 && lines.length > maxLines) {
    truncated = lines.length - maxLines;
    lines = lines.slice(0, maxLines);
  }
  for (const line of lines) out(indent + color(line));
  if (truncated > 0) out(indent + c.gray(`… 省略 ${truncated} 行`));
}

/* ---------------- 会话标题 ---------------- */
function banner({ version, model, provider, rootDir, plugins }) {
  const line = '─'.repeat(56);
  out('');
  out(c.bold(c.magenta('  梦云 Agent')) + c.gray(`  v${version}`));
  out(c.gray(`  ${line}`));
  out(`  ${c.gray('模型  ')} ${c.bold(model || '(未配置)')}  ${c.gray(`@ ${provider}`)}`);
  out(`  ${c.gray('目录  ')} ${rootDir}`);
  out(`  ${c.gray('插件  ')} ${plugins && plugins.length ? plugins.join(', ') : '(无)'}`);
  out(c.gray(`  ${line}`));
  out(c.gray('  输入你的需求；/help 看命令，/exit 退出'));
  out('');
}

/* ---------------- 工具调用可视化 ---------------- */
function toolCall(name, args) {
  const brief = summarizeArgs(args);
  out(`${c.blue('▶')} ${c.bold(name)}${brief ? c.gray(` ${brief}`) : ''}`);
}

function toolResult(name, { ok = true, summary = '', ms = 0 } = {}) {
  const mark = ok ? c.green('✓') : c.red('✗');
  const time = ms > 0 ? c.gray(` (${ms}ms)`) : '';
  out(`  ${mark} ${c.gray(summary || name)}${time}`);
}

/** 把工具参数压成一行短摘要，避免刷屏 */
function summarizeArgs(args) {
  if (args === undefined || args === null) return '';
  if (typeof args !== 'object') return String(args).slice(0, 80);
  const priority = ['path', 'file_path', 'pattern', 'command', 'query', 'url', 'name'];
  for (const key of priority) {
    if (args[key]) {
      const v = String(args[key]).replace(/\s+/g, ' ');
      return `${key}=${v.length > 60 ? `${v.slice(0, 60)}…` : v}`;
    }
  }
  const json = JSON.stringify(args);
  return json.length > 80 ? `${json.slice(0, 80)}…` : json;
}

/* ---------------- 等待动画 ---------------- */
function createSpinner(text = '思考中') {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let timer = null;
  const enabled = process.stdout.isTTY === true && useColor;

  return {
    start() {
      if (!enabled || timer) return;
      timer = setInterval(() => {
        raw(`\r${c.cyan(frames[(i += 1) % frames.length])} ${c.gray(text)}   `);
      }, 80);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      raw('\r\u001b[2K'); // 清掉当前行
    },
    update(next) {
      text = next;
    },
  };
}

/* ---------------- 询问用户 ---------------- */
let sharedRl = null;
function getRl() {
  if (!sharedRl) {
    sharedRl = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return sharedRl;
}

function closeInput() {
  if (sharedRl) {
    sharedRl.close();
    sharedRl = null;
  }
}

/** 普通提问，返回用户输入的字符串 */
function ask(question) {
  const rl = getRl();
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer)));
}

/**
 * 是否允许执行某个敏感操作。
 * @returns {Promise<boolean>}
 */
async function confirm(question, { assumeYes = false, defaultValue = false, detail = '' } = {}) {
  if (assumeYes) {
    out(`${c.yellow('?')} ${question} ${c.gray('(已按 --yes 自动放行)')}`);
    return true;
  }
  // 改动预览（diff）单独打一块：+/- 前缀在终端里同样一眼能看出来，
  // 硬挤进问句那一行就全糊在一起了。
  if (detail) {
    out('');
    for (const line of String(detail).split('\n')) {
      const color = line.startsWith('+ ') ? c.green : line.startsWith('- ') ? c.red : c.gray;
      out(`  ${color(line)}`);
    }
    out('');
  }
  const hint = defaultValue ? '[Y/n]' : '[y/N]';
  const answer = (await ask(`${c.yellow('?')} ${question} ${c.gray(hint)} `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return ['y', 'yes', '是', '好', '确认'].includes(answer);
}

/** 单行输入提示（用于交互式 chat） */
function prompt(text) {
  return ask(`${c.bold(c.green('你'))} ${c.gray('›')} ${text || ''}`);
}

module.exports = {
  c,
  log,
  out,
  raw,
  plain,
  block,
  banner,
  toolCall,
  toolResult,
  summarizeArgs,
  createSpinner,
  ask,
  confirm,
  prompt,
  closeInput,
  useColor,
};
