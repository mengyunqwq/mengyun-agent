#!/usr/bin/env node
'use strict';

/**
 * 梦云 Agent 命令行入口
 * 这一层只做一件事：把参数交给 src/cli.js，并把退出码带出去。
 * 真正的逻辑都在 src/ 里，方便以后再加 Web / HTTP 入口。
 */

const { main } = require('../src/cli');

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = typeof code === 'number' ? code : 0;
  })
  .catch((err) => {
    // 走到这里说明是没被捕获的意外错误，尽量把信息给全
    console.error('');
    console.error(`\u001b[31m✗ 发生未预期的错误：\u001b[0m${err && err.message ? err.message : err}`);
    if (process.env.MYA_DEBUG && err && err.stack) console.error(err.stack);
    console.error('');
    console.error('  建议：运行 `mya doctor` 检查配置；加 --debug 查看堆栈。');
    process.exitCode = 1;
  });
