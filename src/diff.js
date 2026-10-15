'use strict';

/**
 * 梦云 Agent —— 行级 diff（零依赖自研）
 *
 * 为什么自己写：这个项目对外承诺「零依赖、双击即用」，而 diff 只需要一个函数。
 * 引一个库要多一份供应链、多一份体积，还要处理它在浏览器/Node 两处的差异。
 *
 * 用的是最经典的 LCS（最长公共子序列）动态规划，但做了三件工程上的事，
 * 否则它在真实文件上会很难用：
 *
 * 1. **先掐掉公共首尾**。真实场景是「大文件里改了几行」——掐掉首尾之后，
 *    参与 DP 的只剩改动附近那一小段，1 万行的文件也能瞬间出结果。
 * 2. **给 DP 规模设上限**。掐完还超大（比如整段重写）就不做 LCS 了，
 *    退化成「全删 + 全加」。这不是最优 diff，但它**诚实且可预期**，
 *    而且显示时本来就会被截断，硬算只会把界面卡住。
 * 3. **输出限行**。只给用户看改动附近的内容，超出部分明确写「还有 N 行」——
 *    假装展示了全部比不展示更糟。
 */

/**
 * 拆行。
 *
 * 两个刻意的处理：
 *   · CRLF 归一成 LF —— 否则在 Windows 上「同一份内容」会被判成整篇改动；
 *   · 末尾换行只当**行终止符**，不算多出来一个空行。否则「新建文件」永远会多显示
 *     一行 `+ `（真有个空行和文件以换行结尾，是两件事），看起来像 bug；
 *     代价是「少了收尾换行」这种差异不显示——这个取舍对「看改动」更划算。
 */
function splitLines(text) {
  const s = String(text ?? '');
  if (!s) return [];
  const lines = s.replace(/\r\n/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** DP 规模上限：约 400 万格，再大就退化（否则一次编辑能卡住界面几百毫秒） */
const MAX_DP_CELLS = 4_000_000;

/**
 * 计算行级差异。
 * @returns {{ops: Array<{type:'equal'|'del'|'add', text:string}>, added:number, removed:number, degraded:boolean}}
 */
function diffLines(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // 1) 公共前缀
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  // 2) 公共后缀
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops = [];
  for (let i = 0; i < start; i += 1) ops.push({ type: 'equal', text: a[i] });

  let degraded = false;
  if (midA.length * midB.length > MAX_DP_CELLS) {
    // 太大：承认退化成整段替换，别硬算
    degraded = true;
    for (const line of midA) ops.push({ type: 'del', text: line });
    for (const line of midB) ops.push({ type: 'add', text: line });
  } else {
    const n = midA.length;
    const m = midB.length;
    // dp[i][j] = midA[i..] 与 midB[j..] 的最长公共子序列长度
    const dp = new Array((n + 1) * (m + 1)).fill(0);
    const at = (i, j) => i * (m + 1) + j;
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[at(i, j)] =
          midA[i] === midB[j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ type: 'equal', text: midA[i] });
        i += 1;
        j += 1;
      } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) {
        ops.push({ type: 'del', text: midA[i] });
        i += 1;
      } else {
        ops.push({ type: 'add', text: midB[j] });
        j += 1;
      }
    }
    while (i < n) {
      ops.push({ type: 'del', text: midA[i] });
      i += 1;
    }
    while (j < m) {
      ops.push({ type: 'add', text: midB[j] });
      j += 1;
    }
  }

  for (let k = endA; k < a.length; k += 1) ops.push({ type: 'equal', text: a[k] });

  const added = ops.filter((o) => o.type === 'add').length;
  const removed = ops.filter((o) => o.type === 'del').length;
  return { ops, added, removed, degraded };
}

/**
 * 生成给人看的 diff 文本。
 *
 * @param {string} oldText 旧内容
 * @param {string} newText 新内容
 * @param {object} [opts]
 * @param {number} [opts.context=3]  改动前后各留几行上下文
 * @param {number} [opts.maxLines=80] 最多输出多少行（超出写「还有 N 行」）
 * @param {string} [opts.path='']    文件路径（只用于标题）
 * @returns {{text:string, added:number, removed:number, truncated:number, degraded:boolean}}
 */
function formatDiff(oldText, newText, opts = {}) {
  const context = Math.max(0, Number(opts.context ?? 3));
  const maxLines = Math.max(10, Number(opts.maxLines ?? 80));
  const { ops, added, removed, degraded } = diffLines(oldText, newText);

  // 只保留「有改动的那几段 + 每段前后 context 行」，其余折成省略号
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.type === 'equal') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k += 1) keep[k] = true;
  });

  const out = [];
  let skipped = 0;
  for (let idx = 0; idx < ops.length; idx += 1) {
    if (!keep[idx]) {
      skipped += 1;
      continue;
    }
    if (skipped) {
      out.push(`  …（省略 ${skipped} 行未改动）`);
      skipped = 0;
    }
    const op = ops[idx];
    const prefix = op.type === 'add' ? '+' : op.type === 'del' ? '-' : ' ';
    out.push(`${prefix} ${op.text}`);
  }
  if (skipped) out.push(`  …（省略 ${skipped} 行未改动）`);

  const truncated = Math.max(0, out.length - maxLines);
  const shown = truncated ? out.slice(0, maxLines) : out;
  if (truncated) shown.push(`  …（还有 ${truncated} 行没显示，完整内容在文件里）`);

  const header = [];
  if (opts.path) header.push(String(opts.path));
  if (!added && !removed) header.push('（内容没有变化）');
  else header.push(`+${added} 行  -${removed} 行${degraded ? '（改动太大，按整段替换显示）' : ''}`);

  return {
    text: `${header.join('  ')}\n${shown.join('\n')}`,
    added,
    removed,
    truncated,
    degraded,
  };
}

module.exports = { diffLines, formatDiff, splitLines, MAX_DP_CELLS };
