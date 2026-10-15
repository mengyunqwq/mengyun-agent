'use strict';

/**
 * 梦云 Agent —— 测试总入口（跨平台）
 *
 * 为什么不再用 package.json 里的 `a && b && c`：
 *   1. `&&` 是 **shell** 语法。npm 在 Windows 上走 cmd、在 macOS/Linux 上走 sh，
 *      两边行为不完全一致；直接粘进 PowerShell 5.1 更是直接报
 *      `The token '&&' is not a valid statement separator`（踩过）。
 *   2. `&&` 是**一失败就全停**：第 3 个套件挂了，后面 6 个根本不会跑，
 *      你拿不到「一共坏了几个」的全貌，只能修一个跑一次。
 *   3. 没有汇总：九个套件各打各的，最后一眼看不出整体是绿的还是红的。
 *
 * 这个脚本用 child_process 直接起 node（不经过 shell），所以三个平台行为一致；
 * 默认**失败也继续跑完**（keep-going），最后给一张汇总表 + 一个退出码。
 *
 * 用法：
 *   node test/run-all.js                  # 全部套件，顺序跑
 *   node test/run-all.js --skip-desktop   # 跳过需要 Electron 的 desktop-e2e（CI/Linux 常用）
 *   node test/run-all.js --only web-check,selftest
 *   node test/run-all.js --parallel=3     # 并行（抢 CPU，时序敏感的用例可能变慢）
 *   node test/run-all.js --stop-on-fail   # 想要「第一处失败就停」的旧行为
 *   node test/run-all.js --json           # 机器可读的结果（也写 .mya/test-report.json）
 *   node test/run-all.js --self-test      # 自检：验证这个运行器自己的汇总/退出码逻辑
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 套件清单。needsDesktop 的会在缺少 Electron 时由套件自己跳过并返回 0 */
const SUITES = [
  { name: 'selftest', file: 'test/selftest.js', label: '核心自检' },
  { name: 'web-check', file: 'test/web-check.js', label: '前端静态一致性' },
  { name: 'freeze-guard', file: 'test/freeze-guard.js', label: '防卡死回归' },
  { name: 'web-search', file: 'test/web-search.js', label: '联网搜索（离线注入）' },
  { name: 'context-compact', file: 'test/context-compact.js', label: '上下文压缩边界' },
  { name: 'provider-formats', file: 'test/provider-formats.js', label: '三种协议适配' },
  { name: 'mock-server', file: 'test/mock-server.js', label: '端到端（假网关）' },
  { name: 'web-e2e', file: 'test/web-e2e.js', label: '网页服务端到端' },
  { name: 'plugin-contract', file: 'test/plugin-contract.js', label: '插件接口契约' },
  { name: 'tasks', file: 'test/tasks.js', label: '并行子任务调度' },
  { name: 'logging', file: 'test/logging.js', label: '结构化日志' },
  {
    name: 'desktop-e2e',
    file: 'test/desktop-e2e.js',
    label: '桌面程序 + 打包产物',
    needsDesktop: true,
    timeoutMs: 10 * 60 * 1000,
  },
];

// eslint-disable-next-line no-control-regex -- 就是要匹配终端里的 ESC 控制序列
const ANSI = /\u001b\[[0-9;]*m/g;
const strip = (s) => String(s).replace(ANSI, '');

function parseArgs(argv) {
  const opts = { parallel: 1, keepGoing: true, json: false, selfTest: false, only: null, skip: new Set() };
  for (const raw of argv) {
    const arg = String(raw);
    if (arg === '--skip-desktop') opts.skip.add('desktop-e2e');
    else if (arg === '--stop-on-fail') opts.keepGoing = false;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--self-test') opts.selfTest = true;
    else if (arg.startsWith('--only='))
      opts.only = arg
        .slice(7)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else if (arg.startsWith('--skip='))
      arg
        .slice(7)
        .split(',')
        .forEach((s) => s.trim() && opts.skip.add(s.trim()));
    else if (arg.startsWith('--parallel')) {
      const n = Number(arg.split('=')[1]);
      opts.parallel = Number.isFinite(n) && n > 0 ? Math.min(n, 4) : 2;
    }
  }
  return opts;
}

/** 从套件输出里抠出「通过/失败了多少项」，抠不到就留空（不编数字） */
function summarize(output) {
  const text = strip(output);
  // 各套件的历史格式不完全统一，这里把见过的几种都认了：
  //   「全部通过：72 项测试」「全部通过：48 项」「全部通过」
  //   「2 项失败 / 共 17 项」
  //   「通过 29 项 / 失败 0 项 / 共 29 项」
  const failTotal = /(\d+)\s*项失败\s*\/\s*共\s*(\d+)\s*项/.exec(text);
  if (failTotal) return { passed: Number(failTotal[2]) - Number(failTotal[1]), failed: Number(failTotal[1]) };
  const passFail = /通过\s*(\d+)\s*项\s*\/\s*失败\s*(\d+)\s*项/.exec(text);
  if (passFail) return { passed: Number(passFail[1]), failed: Number(passFail[2]) };
  const pass = /全部通过：\s*(\d+)\s*项/.exec(text) || /端到端验证通过：\s*(\d+)\s*项/.exec(text);
  if (pass) return { passed: Number(pass[1]), failed: 0 };
  if (/全部通过/.test(text)) return { passed: null, failed: 0 };
  return { passed: null, failed: null };
}

function runSuite(suite, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    // 支持绝对路径（自检会传临时目录里的假套件）；
    // 注意 path.join 不会把绝对路径当绝对路径处理，拼出来会变成 E:\repo\C:\...
    const script = path.isAbsolute(suite.file) ? suite.file : path.join(ROOT, suite.file);
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      // 不用 shell：三个平台行为一致，也不会被 PowerShell 的引号/&& 规则坑到
      shell: false,
      env: { ...process.env, NO_COLOR: process.env.NO_COLOR || '1' },
      windowsHide: true,
    });

    let out = '';
    const feed = (chunk, isErr) => {
      const text = chunk.toString();
      out += text;
      if (!quiet) (isErr ? process.stderr : process.stdout).write(text);
    };
    child.stdout.on('data', (c) => feed(c, false));
    child.stderr.on('data', (c) => feed(c, true));

    const timeoutMs = suite.timeoutMs || 5 * 60 * 1000;
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
      out += `\n[run-all] 超时（${Math.round(timeoutMs / 1000)}s），已强制结束\n`;
    }, timeoutMs);

    const done = (code, extra = {}) => {
      clearTimeout(timer);
      const ms = Date.now() - startedAt;
      const { passed, failed } = summarize(out);
      // 判定以退出码为准（套件的契约），但输出里**明确写了失败项**时以它为准：
      // 有些套件（比如 desktop-e2e 在没装 Electron 时）会跳过并返回 0，
      // 那种情况下抠不到「全部通过」的字样，不能因此判红。
      resolve({
        name: suite.name,
        label: suite.label,
        code: code === null ? -1 : code,
        ok: code === 0 && (failed === null || failed === 0),
        passed,
        failed,
        ms,
        out,
        ...extra,
      });
    };

    child.on('close', (code) => done(code));
    child.on('error', (err) => done(null, { spawnError: err.message }));
  });
}

/* ------------------------------------------------------------------ */
/* 自检：验证运行器自己的汇总与退出码逻辑                                */
/* ------------------------------------------------------------------ */

async function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-runall-'));
  const passFile = path.join(dir, 'pass.js');
  const failFile = path.join(dir, 'fail.js');
  fs.writeFileSync(passFile, "console.log('全部通过：3 项');process.exit(0);\n");
  fs.writeFileSync(failFile, "console.log('1 项失败 / 共 5 项');process.exit(1);\n");

  const make = (name, file, code) => ({ name, file, label: name });
  const results = [];
  results.push(
    await runSuite({ ...make('fake-pass', path.relative(ROOT, passFile)), timeoutMs: 20000 }, { quiet: true }),
  );
  results.push(
    await runSuite({ ...make('fake-fail', path.relative(ROOT, failFile)), timeoutMs: 20000 }, { quiet: true }),
  );

  const failures = [];
  const [p, f] = results;
  if (!p.ok || p.passed !== 3 || p.failed !== 0) failures.push(`通过用例的解析不对：${JSON.stringify(p)}`);
  if (f.ok || f.failed !== 1) failures.push(`失败用例的解析不对：${JSON.stringify(f)}`);
  const totals = aggregate(results);
  if (totals.failedSuites !== 1) failures.push(`汇总的失败套件数应为 1，实际 ${totals.failedSuites}`);
  if (exitCodeFor(results) !== 1) failures.push('有失败套件时退出码应为 1');
  if (exitCodeFor([p]) !== 0) failures.push('全通过时退出码应为 0');

  fs.rmSync(dir, { recursive: true, force: true });
  if (failures.length) {
    console.error('\x1b[31m运行器自检失败：\x1b[0m');
    for (const line of failures) console.error('  · ' + line);
    return 1;
  }
  console.log('\x1b[32m✓ 运行器自检通过\x1b[0m（汇总解析 / 失败计数 / 退出码 都正确）');
  return 0;
}

function aggregate(results) {
  let suites = results.length;
  let passedSuites = 0;
  let failedSuites = 0;
  let casesPassed = 0;
  let casesFailed = 0;
  let casesUnknown = 0;
  for (const r of results) {
    if (r.ok) passedSuites += 1;
    else failedSuites += 1;
    if (typeof r.passed === 'number') casesPassed += r.passed;
    else casesUnknown += 1;
    if (typeof r.failed === 'number') casesFailed += r.failed;
  }
  return { suites, passedSuites, failedSuites, casesPassed, casesFailed, casesUnknown };
}

function exitCodeFor(results) {
  return results.every((r) => r.ok) ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfTest) {
    process.exitCode = await selfTest();
    return;
  }

  let suites = SUITES.filter((s) => !opts.skip.has(s.name));
  if (opts.only) suites = suites.filter((s) => opts.only.includes(s.name));
  if (!suites.length) {
    console.error('没有可运行的套件（检查 --only / --skip）');
    process.exitCode = 2;
    return;
  }

  const startedAt = Date.now();
  console.log(`\n\x1b[1m\x1b[35m梦云 Agent 测试总入口\x1b[0m  ${suites.length} 个套件`);
  console.log(
    `  模式：${opts.parallel > 1 ? `并行 ${opts.parallel}` : '顺序'} · ${
      opts.keepGoing ? '失败继续' : '失败即停'
    }${opts.skip.size ? ` · 跳过 ${[...opts.skip].join(',')}` : ''}\n`,
  );

  const results = [];
  if (opts.parallel > 1) {
    // 并行：拿一个游标让所有 worker 抢下一个套件，避免固定分片造成的长尾
    const queue = [...suites];
    const workers = Array.from({ length: Math.min(opts.parallel, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        console.log(`\n\x1b[36m▌ ${next.label}（${next.name}）\x1b[0m`);
        // eslint-disable-next-line no-await-in-loop
        const r = await runSuite(next, { quiet: false });
        results.push(r);
        console.log(`  → ${r.ok ? '\x1b[32m通过\x1b[0m' : '\x1b[31m失败\x1b[0m'}（${(r.ms / 1000).toFixed(1)}s）`);
        if (!r.ok && !opts.keepGoing) return;
      }
    });
    await Promise.all(workers);
  } else {
    for (const suite of suites) {
      console.log(`\n\x1b[36m▌ ${suite.label}（${suite.name}）\x1b[0m`);
      // eslint-disable-next-line no-await-in-loop
      const r = await runSuite(suite, { quiet: false });
      results.push(r);
      console.log(`  → ${r.ok ? '\x1b[32m通过\x1b[0m' : '\x1b[31m失败\x1b[0m'}（${(r.ms / 1000).toFixed(1)}s）`);
      if (!r.ok && !opts.keepGoing) break;
    }
  }

  // 按清单顺序输出汇总（并行时 results 的顺序是乱的）
  const ordered = suites.map((s) => results.find((r) => r.name === s.name)).filter(Boolean);
  const totals = aggregate(ordered);
  const wall = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log('\n' + '─'.repeat(72));
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - strip(String(s)).length));
  console.log(pad('套件', 20) + pad('结果', 10) + pad('用例', 18) + '耗时');
  for (const r of ordered) {
    const cases =
      typeof r.passed === 'number' || typeof r.failed === 'number'
        ? `通过 ${r.passed ?? '?'} / 失败 ${r.failed ?? '?'}`
        : '（未统计）';
    const markPlain = r.ok ? '✓ 通过' : '✗ 失败';
    const mark = r.ok ? `\x1b[32m${markPlain}\x1b[0m` : `\x1b[31m${markPlain}\x1b[0m`;
    // 先按「无色」文本对齐，再把那一段换成带色的，避免 ANSI 码把列宽算歪
    const line = pad(r.name, 20) + pad(markPlain, 10) + pad(cases, 18) + `${(r.ms / 1000).toFixed(1)}s`;
    console.log(line.replace(markPlain, mark));
  }
  console.log('─'.repeat(72));
  console.log(
    `${totals.passedSuites}/${totals.suites} 个套件通过` +
      `（用例：通过 ${totals.casesPassed}${totals.casesFailed ? ` / 失败 ${totals.casesFailed}` : ''}` +
      `${totals.casesUnknown ? `，${totals.casesUnknown} 个套件未给出计数` : ''}），总计 ${wall}s`,
  );

  const failed = ordered.filter((r) => !r.ok);
  if (failed.length) {
    console.log('\n\x1b[31m失败详情（每套件最后 25 行）：\x1b[0m');
    for (const r of failed) {
      const tail = strip(r.out).trim().split('\n').slice(-25).join('\n');
      console.log(`\n\x1b[31m▌ ${r.name}\x1b[0m${r.spawnError ? ` 启动失败：${r.spawnError}` : ''}\n${tail}`);
    }
  } else {
    console.log('\n\x1b[32m\x1b[1m全部套件通过\x1b[0m');
  }

  // 机器可读的结果：CI 里好看，出问题也好留证
  const report = {
    at: new Date().toISOString(),
    wallMs: Date.now() - startedAt,
    parallel: opts.parallel,
    totals,
    suites: ordered.map((r) => ({
      name: r.name,
      ok: r.ok,
      code: r.code,
      passed: r.passed,
      failed: r.failed,
      ms: r.ms,
      spawnError: r.spawnError || '',
    })),
  };
  try {
    const dir = path.join(ROOT, '.mya');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'test-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  } catch {
    /* 写不了报告不影响结论 */
  }
  if (opts.json) console.log('\n' + JSON.stringify(report, null, 2));

  process.exitCode = exitCodeFor(ordered);
}

main().catch((err) => {
  console.error('测试入口自身出错：' + (err && err.stack ? err.stack : err));
  process.exitCode = 2;
});
