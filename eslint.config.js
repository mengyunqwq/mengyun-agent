'use strict';

/**
 * ESLint 配置（flat config，ESLint 9+）
 *
 * 取舍：只开「能抓到真 bug」的规则，格式化的事交给 prettier。
 * 为什么不开 `eslint:recommended` 全套：里面很多是风格偏好（比如 prefer-const、
 * eqeqeq），一上来就是几百条警告，人就会开始习惯性忽略 lint 输出——
 * 那还不如不装。这里挑的是「写错了会真的出问题」的那一批：
 * 未定义变量、重复键、够不着的代码、空 catch 之外的怪写法……
 *
 * 为什么忽略 web/ 之外的 globals 要手写：为了不再引入 `globals` 这个包
 * （运行时零依赖是这个项目的卖点，构建期依赖也尽量少）。
 */

const NODE_GLOBALS = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  console: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  global: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextDecoder: 'readonly',
  TextEncoder: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  structuredClone: 'readonly',
  fetch: 'readonly',
};

const BROWSER_GLOBALS = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  location: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  fetch: 'readonly',
  EventSource: 'readonly',
  getComputedStyle: 'readonly',
  performance: 'readonly',
  requestAnimationFrame: 'readonly',
  cancelAnimationFrame: 'readonly',
  KeyboardEvent: 'readonly',
  MouseEvent: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  MutationObserver: 'readonly',
  IntersectionObserver: 'readonly',
  Image: 'readonly',
  Blob: 'readonly',
  File: 'readonly',
  FileReader: 'readonly',
  FormData: 'readonly',
  alert: 'readonly',
  confirm: 'readonly',
  prompt: 'readonly',
};

const COMMON_RULES = {
  // —— 真 bug 类 ——
  'no-undef': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-unreachable': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'no-cond-assign': ['error', 'except-parens'],
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-fallthrough': 'error',
  'no-redeclare': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-useless-backreference': 'error',
  'no-async-promise-executor': 'error',
  'no-template-curly-in-string': 'error',
  'no-unmodified-loop-condition': 'error',
  /**
   * 顺序 await 在这个项目里是**刻意的**：插件按注册顺序加载、压缩必须串行、
   * 工具按模型给的顺序执行。开着这条规则会稳定产出 20+ 条噪音警告，
   * 久了人就会开始无视 lint 输出——那还不如关掉，把注意力留给真问题。
   * （代码里原有的 `eslint-disable-next-line no-await-in-loop` 注释保留着，
   *  它们记录了「这里为什么是顺序的」这层意图。）
   */
  'no-await-in-loop': 'off',
  'require-atomic-updates': 'off', // 误报太多

  // —— 可疑写法（警告，不挡路）——
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }],
  'no-prototype-builtins': 'warn',
  'no-useless-escape': 'warn',
  'no-control-regex': 'warn',
  'no-misleading-character-class': 'warn',
  'no-empty-pattern': 'warn',
};

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', '.mya/**', 'build/**', '**/*.min.js'],
  },
  {
    // 代码里有一些针对「本配置没启用的规则」的 disable 注释（比如 no-console）。
    // 把「未使用的 disable 注释」关掉：它们是有意的说明，不该被当成问题报出来。
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    rules: COMMON_RULES,
  },
  {
    // 前端是浏览器环境：window/document/localStorage 这些要认得
    files: ['web/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: { ...NODE_GLOBALS, ...BROWSER_GLOBALS },
    },
    rules: COMMON_RULES,
  },
];
