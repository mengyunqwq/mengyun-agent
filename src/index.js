'use strict';

/**
 * 梦云 Agent —— 库入口
 *
 * 除了命令行，你也可以把 agent 当成库来用（写自己的脚本、接 HTTP 服务、做微信机器人）：
 *
 *   const { createApp } = require('./src');
 *   const app = await createApp({ cwd: process.cwd() });
 *   const session = app.agent.createSession();
 *   const result = await app.agent.run(session, '把这个项目的 README 翻译成中文', { verbose: false });
 *   console.log(result.text);
 */

const { createApp } = require('./app');
const { ChatAgent } = require('./agent');
const { Session, buildSystemPrompt } = require('./session');
const { ToolRegistry, Tool, validateArgs } = require('./tools');
const { PluginHost } = require('./plugins');
const { EventBus, EVENTS } = require('./events');
const { createProvider, OpenAICompatProvider, ProviderError } = require('./provider');
const { loadConfig, describeConfig, PROVIDER_PRESETS } = require('./config');
const ui = require('./ui');
const utils = require('./utils');

module.exports = {
  // 一站式创建
  createApp,
  // 核心构件（想深度定制时直接用）
  ChatAgent,
  Session,
  EventBus,
  EVENTS,
  ToolRegistry,
  Tool,
  PluginHost,
  createProvider,
  OpenAICompatProvider,
  ProviderError,
  loadConfig,
  describeConfig,
  PROVIDER_PRESETS,
  buildSystemPrompt,
  validateArgs,
  ui,
  utils,
};
