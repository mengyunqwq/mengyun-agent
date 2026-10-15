'use strict';

/**
 * 梦云 Agent —— 「卡死」防护的回归测试
 *
 * 用户反馈：「软件里经常会因为一个脚本而卡死」。
 * 追下去是三处 O(n²) 叠在一起，任意一处单独存在都能把界面冻住：
 *
 *   1. 后端 —— 模型每吐一个分片就广播一次「到目前为止的累积全文」，
 *      网络字节量随长度平方增长；
 *   2. 前端 —— 每收到一条就把整段正文重新解析一遍 Markdown、重建 DOM，
 *      同样平方级，主线程直接被占满；
 *   3. 进程 —— 脚本在死循环里刷日志时，输出被无限往内存里堆。
 *
 * 这个文件既做静态检查（确认这几层防护还在），也真跑一个刷屏脚本、
 * 一个等 stdin 的脚本去验证行为——只做静态检查的话，逻辑改坏了照样能过。
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`  \x1b[32m✓\x1b[0m ${name}\x1b[90m${detail ? ` — ${detail}` : ''}\x1b[0m`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${err.message}\x1b[0m`);
  }
}

async function main() {
  console.log('\n\x1b[1m卡死防护\x1b[0m');

  const serverJs = read('src', 'web', 'server.js');
  const appJs = read('web', 'app.js');
  const builtinJs = read('src', 'tools', 'builtin.js');

  /* ---------------- 后端：流式事件合帧 ---------------- */

  await check('后端把同一个块的连续流式事件合帧后再推', () => {
    assert(/COALESCE_TYPES/.test(serverJs), '找不到合帧用的类型白名单');
    assert(/'text'/.test(serverJs) && /'reasoning'/.test(serverJs), 'text / reasoning 都应该参与合帧');
    assert(/makeCoalescer/.test(serverJs), '缺少合帧器');
    assert(/coalescer\.push\(/.test(serverJs), 'sessions.subscribe 没有走合帧器');
    // 非流式事件必须先冲刷挂起的文本，否则正文会比 text_end 还晚到
    assert(/flush\(\);\s*\n\s*send\(event\);/.test(serverJs), '非流式事件前没有先冲刷挂起的文本');
    return 'text / reasoning 按块合并，30ms 一发';
  });

  await check('后端对流式帧做背压保护（浏览器消费不过来时丢弃）', () => {
    assert(/writableLength/.test(serverJs), '没有检查 socket 积压');
    assert(/isStreamFrame/.test(serverJs), '没有区分「可丢的流式帧」和「不可丢的一次性事件」');
    return '积压超过阈值时丢弃可丢的流式帧';
  });

  /* ---------------- 前端：渲染节流与降级 ---------------- */

  await check('前端按帧合并高频重绘，而不是每条事件都重画', () => {
    assert(/function makePainter/.test(appJs), '缺少按帧合并的绘制器');
    assert(/requestAnimationFrame/.test(appJs), '绘制器应该挂在 rAF 上');
    for (const p of ['paintText', 'paintReasoning', 'paintTool']) {
      assert(new RegExp(`const ${p} = makePainter`).test(appJs), `缺少 ${p} 节流器`);
    }
    // 流式回调只能「提交」重绘，绝不能在事件处理里直接改 DOM
    const fn = /function updateStreamingText\([\s\S]*?\n\}/.exec(appJs);
    assert(fn, '找不到 updateStreamingText');
    assert(/paintText\.push\(/.test(fn[0]), 'updateStreamingText 没有走节流器');
    assert(!/innerHTML/.test(fn[0]), 'updateStreamingText 里还在直接重建 innerHTML');
    return 'rAF + 最小间隔，同一块只画最后一次';
  });

  await check('超长正文自动降级成纯文本，定稿时才做一次 Markdown', () => {
    assert(/STREAM_PLAIN_LIMIT/.test(appJs), '缺少流式降级阈值');
    assert(/RENDER_MD_LIMIT/.test(appJs), '缺少 Markdown 渲染上限');
    assert(/function renderBodyInto/.test(appJs), '缺少统一的正文渲染入口');
    // 流式期间长文本走纯文本
    assert(/forcePlain: true/.test(appJs), '流式期间没有走纯文本降级');
    // text_end 时再完整渲染一次
    assert(/paintText\.flush/.test(appJs), 'text_end 没有先把挂起的绘制执行掉');
    assert(/case 'text_end'[\s\S]{0,600}renderBodyInto/.test(appJs), 'text_end 没有做定稿渲染');
    return '流式铺纯文本，定稿渲染一次 Markdown';
  });

  await check('工具输出在卡片里按头尾截断（DOM 体积有上限）', () => {
    assert(/function clampOutput/.test(appJs), '缺少工具输出截断');
    assert(/TOOL_OUTPUT_LIMIT/.test(appJs), '缺少工具输出上限');
    const fn = /function toolCardHtml\([\s\S]*?\n\}/.exec(appJs);
    assert(fn, '找不到 toolCardHtml');
    assert(/clampOutput\(block\.output\)/.test(fn[0]), 'toolCardHtml 没有对输出做截断');
    return '头尾保留、中间省略，并注明省略了多少';
  });

  await check('消息区关掉了平滑滚动（流式时平滑动画会互相打断）', () => {
    const msgs = /\.messages\s*\{([^}]*)\}/.exec(read('web', 'app.css'));
    assert(msgs, '找不到 .messages 样式');
    const decl = msgs[1].replace(/\/\*[\s\S]*?\*\//g, '');
    assert(!/scroll-behavior:\s*smooth/.test(decl), '还开着平滑滚动');
    return 'scroll-behavior: auto';
  });

  /* ---------------- 进程：输出洪泛熔断 ---------------- */

  await check('shell 工具：脚本刷屏时会熔断，而不是无限往内存里堆', async () => {
    const { shellTool } = require('../src/tools/builtin');
    const { CONFIRMED } = require('../src/tools');

    assert(/MAX_OUTPUT_BYTES/.test(builtinJs), '找不到输出上限');

    const started = Date.now();
    const res = await shellTool.run(
      {
        command: 'node -e "for(;;) console.log(\'x\'.repeat(2000))"',
        timeout: 30,
        [CONFIRMED]: true,
      },
      { cwd: ROOT, cfg: {}, env: {} },
    );
    const ms = Date.now() - started;

    assert.strictEqual(res.ok, false, '刷屏脚本不该被当成执行成功');
    assert(
      /输出超过/.test(res.content),
      `应该说明是输出过多被强制终止，实际开头是：${res.content.slice(0, 160)}`,
    );
    assert(ms < 25000, `熔断花了 ${ms}ms，太慢了`);
    assert(res.content.length < 120000, `返回内容过大：${res.content.length} 字符`);
    return `${ms}ms 熔断，返回 ${res.content.length} 字符`;
  });

  await check('shell 工具：命令的 stdin 接空设备，等输入的命令不会挂到超时', async () => {
    const { shellTool } = require('../src/tools/builtin');
    const { CONFIRMED } = require('../src/tools');

    assert(/stdio:\s*\['ignore'/.test(builtinJs), 'spawn 没有把 stdin 接到空设备');

    const started = Date.now();
    // 这个脚本只等 stdin 结束；stdin 不接空设备的话它会一直等下去
    await shellTool.run(
      {
        command: 'node -e "process.stdin.resume(); process.stdin.on(\'end\', () => process.exit(0))"',
        timeout: 20,
        [CONFIRMED]: true,
      },
      { cwd: ROOT, cfg: {}, env: {} },
    );
    const ms = Date.now() - started;
    assert(ms < 12000, `等了 ${ms}ms 才结束，说明 stdin 没有立刻拿到 EOF`);
    return `${ms}ms 就结束了`;
  });

  await check('shell 工具：超时会连子进程一起杀（不留孤儿进程占着端口和文件锁）', () => {
    // Windows 上只杀 powershell 的话，它拉起的 node / npm 会变成孤儿继续跑，
    // 这正是「明明停了，软件还是动不了」的根源。
    assert(/taskkill/.test(builtinJs), 'Windows 上应该用 taskkill');
    assert(/\/T/.test(builtinJs), 'taskkill 必须带 /T 才会连子进程一起杀');
    assert(/const killTree/.test(builtinJs), '缺少统一的杀进程树函数');
    assert(/killer\.on\('error'/.test(builtinJs), 'taskkill 起不来时应该有兜底');
    return 'taskkill /T /F + child.kill 兜底';
  });

  await check('shell 工具：工作目录不存在时给明确原因，而不是误导性的 ENOENT', async () => {
    const { shellTool } = require('../src/tools/builtin');
    const { CONFIRMED } = require('../src/tools');
    const os = require('os');

    // 真踩过的坑：免安装版每次启动都把自己解压到 %TEMP% 下的随机目录，
    // 会话记住它之后，下次打开时目录已被清理。此时 spawn 带上一个不存在的
    // cwd，Node 抛的是 `spawn powershell.exe ENOENT` —— **只提可执行文件名，
    // 完全不提 cwd**。模型据此判断「powershell 没装」，朝错方向排查了整整
    // 一轮，白烧几十万 token。
    const ghost = path.join(os.tmpdir(), `mya-不存在的目录-${Date.now()}`);
    assert(!fs.existsSync(ghost), '测试用的路径不该真的存在');

    const res = await shellTool.run(
      { command: 'echo ok', cwd: ghost, timeout: 10, [CONFIRMED]: true },
      { cwd: ghost, cfg: {}, env: {} },
    );

    assert.strictEqual(res.ok, false, '目录不存在时不该报告成功');
    assert(/工作目录不存在/.test(res.content), `应该说清是目录没了，实际：${res.content.slice(0, 200)}`);
    assert(!/ENOENT/.test(res.content), '不该把 Node 的 ENOENT 原文丢给模型（那会把人带偏）');
    assert(res.content.includes(ghost), '应该把出问题的具体路径写出来');
    return '明确报「工作目录不存在」并给出路';
  });

  await check('免安装版：工作目录不能取进程的启动目录（那是个会被删掉的临时目录）', () => {
    const mainJs = read('desktop', 'main.js');
    // portable exe 会把自己解压到 %TEMP%\<随机>，在那里启动进程。
    // 用 process.cwd() 当默认工作目录 = 每次启动都换一个、退出即失效。
    assert(/PORTABLE_EXECUTABLE_DIR/.test(mainJs), '没有识别 portable 启动器给出的 exe 所在目录');
    assert(
      /if \(!portableDir\) add\(process\.cwd\(\)/.test(mainJs),
      'process.cwd() 必须只在非 portable 启动时才作为候选',
    );
    // 会话恢复时要能发现工作目录已经没了
    const sessionManager = read('src', 'web', 'session-manager.js');
    assert(/existsSync\(record\.cwd\)/.test(sessionManager), '恢复会话时没有检查工作目录还在不在');
    return 'portable 用 exe 所在目录 + 恢复会话时校验';
  });

  /* ---------------- 汇总 ---------------- */

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(50)}`);
  if (!failed.length) {
    console.log(`\x1b[32m\x1b[1m全部通过：${results.length} 项\x1b[0m\n`);
    process.exit(0);
  }
  console.log(`\x1b[31m\x1b[1m${failed.length} 项失败 / 共 ${results.length} 项\x1b[0m\n`);
  process.exit(1);
}

main();
