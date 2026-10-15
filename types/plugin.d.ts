/**
 * 梦云 Agent 插件接口类型契约（给插件作者用的 .d.ts）
 *
 * 为什么要有这个文件：插件宿主是「可插拔」的，但插件作者以前只能读 README 猜
 * ctx 上有什么、registerTool 的 def 支持哪些字段、钩子事件的 payload 长什么样。
 * 猜错的代价是「写完不生效」或者「跑起来才知道参数名不对」。
 * 这里把宿主真正提供的东西写成类型，编辑器里就有补全和报错。
 *
 * 它和实现的一致性由 `test/plugin-contract.js` 盯着：
 * 宿主 ctx 上每多一个成员、这里漏了，测试就会红——防止文档和代码慢慢走散。
 *
 * 用法（插件目录下放一个 jsconfig.json 即可在 VS Code 里获得提示）：
 *   { "compilerOptions": { "checkJs": true, "types": ["../types/plugin.d.ts"] } }
 */

/** 插件可以声明的权限（宿主只做加载时告警，不做强制，见 README：插件不是沙箱） */
export type PluginPermission =
  | 'fs:read'
  | 'fs:write'
  | 'shell:exec'
  | 'net:fetch'
  | 'env'
  | 'session';

/** manifest.json 的形状（也可以没有 manifest，改用 package.json 的 main） */
export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  /** 入口文件，默认 index.js */
  entry?: string;
  author?: string;
  /** 声明式权限：只为告警，不构成沙箱 */
  permissions?: PluginPermission[];
  /** 设为 'module' 时按 ESM 加载 */
  type?: 'module' | 'commonjs';
}

/** 工具的参数 schema（JSON Schema 的实用子集，宿主只校验 type/properties/required/items/enum/default） */
export interface ToolParameter {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
  additionalProperties?: boolean;
}

/** 注册给模型的工具定义 */
export interface ToolDefinition<A = Record<string, unknown>> {
  /** 工具名。只允许 [a-zA-Z0-9_-]（OpenAI 协议要求），中文会被规范化 */
  name: string;
  description: string;
  parameters?: ToolParameter;
  /** 别名，模型用别名也能调到（会进 aliasIndex） */
  aliases?: string[];
  /** 分类标签，界面上用来分组 */
  tags?: string[];
  /** true = 免确认直接执行。**插件工具默认要确认**，只读工具才建议开 */
  autoApprove?: boolean;
  /** 强制每次都问用户（优先级高于 autoApprove） */
  needsConfirm?: boolean;
  /** 标记为危险工具（等价于 needsConfirm） */
  dangerous?: boolean;
  /**
   * 更细的确认判断：返回 true 就弹确认框。
   * 参数相关的判断写这里（比如「只读命令不问、写命令才问」）。
   */
  needsConfirmation?: (args: A, cfg: MyaConfig) => boolean;
  /** 工具主体。返回字符串或 { ok, content } */
  run: (
    args: A,
    ctx: ToolRunContext,
  ) => Promise<string | { ok?: boolean; content: string }> | string | { ok?: boolean; content: string };
}

/** 工具执行时的上下文（run 的第二个参数） */
export interface ToolRunContext {
  /** 当前会话的工作目录 */
  cwd: string;
  cfg: MyaConfig;
  /** 让用户确认一次（返回 false = 用户拒绝） */
  confirm?: (question: string) => Promise<boolean>;
  /** 会话对象（id / cwd / toMessages 等） */
  session?: { id?: string; cwd?: string };
  /** 打日志（会带插件名前缀） */
  log?: (...args: unknown[]) => void;
  /** 中止信号（用户点「停止」时触发） */
  signal?: AbortSignal;
}

/** 插件上下文：setup(ctx) 收到的那个对象 */
export interface PluginContext {
  /** 插件名（manifest.name 或目录名） */
  readonly name: string;
  readonly version: string;
  /** 插件自己所在目录（绝对路径） */
  readonly dir: string;
  /** 全局配置（只读用；要改配置请走宿主的能力，不要直接写文件） */
  readonly config: MyaConfig;
  /** 当前工作目录 */
  readonly cwd: string;
  /** 插件自己的状态袋：跨钩子共享，宿主不会碰 */
  readonly state: Record<string, unknown>;
  /** 宿主注入的额外依赖（ui / log 等） */
  readonly deps: Record<string, unknown>;

  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;

  /** 注册一个工具。重名（尤其是与内置工具重名）会抛错 */
  registerTool: <A = Record<string, unknown>>(def: ToolDefinition<A>) => unknown;
  /** 批量注册，返回注册成功的工具数组 */
  registerTools: (defs: ToolDefinition[]) => unknown[];
  /** 注销自己注册的工具 */
  unregisterTool: (name: string) => void;

  /** 注册斜杠命令：聊天里输入 /name 就能用 */
  registerCommand: (
    name: string,
    meta: { description?: string; usage?: string },
    handler: (arg: string, extra?: Record<string, unknown>) => Promise<unknown> | unknown,
  ) => string;

  /** 挂钩子。返回取消注册的函数 */
  on: (event: MyaEventName | '*', fn: (payload: any, meta: { event: string; label: string }) => unknown, opts?: { once?: boolean }) => () => void;
  once: (event: MyaEventName | '*', fn: (payload: any) => unknown) => () => void;
  off: (event: MyaEventName, fn: (...args: any[]) => unknown) => void;
  /** 主动触发一个事件（宿主会 await 所有监听者） */
  emit: (event: string, payload?: object, opts?: { bail?: boolean; throwOnError?: boolean }) => Promise<boolean>;

  /** 给系统提示词追加一段要求（会带上插件名） */
  addPrompt: (text: string) => void;

  /**
   * 读插件自己的配置：config.json 的 plugins.config.<插件名>，
   * 叠加环境变量 MYA_PLUGIN_<大写插件名>_<KEY>（小写化后作为键）
   */
  getConfig: <T extends object>(defaults?: T) => T & Record<string, unknown>;

  /** 宿主自带的工具函数（isIgnored / humanSize / timestamp / resolvePath 等） */
  utils: Record<string, any>;

  /** 调另一个工具（插件之间协作）。走的是同一套确认与事件 */
  callTool: (toolName: string, args: object, runCtx?: ToolRunContext) => Promise<unknown>;

  /** 安全解析路径：insideOnly=true 时限制在工作目录内（插件也别越界乱翻） */
  resolvePath: (p: string, insideOnly?: boolean) => string;
}

/** 钩子事件名与它们的 payload（对应 src/events.js 的 EVENTS） */
export type MyaEventName =
  | 'session:start'
  | 'turn:start'
  | 'prompt:build'
  | 'messages:before'
  | 'turn:context'
  | 'context:compacting'
  | 'context:compacted'
  | 'context:compact-failed'
  | 'assistant:reasoning'
  | 'assistant:delta'
  | 'assistant:done'
  | 'step:usage'
  | 'tool:before'
  | 'tool:after'
  | 'turn:end'
  | 'session:end'
  | 'error';

/** 插件导出对象 */
export interface MyaPlugin {
  name: string;
  version?: string;
  description?: string;
  permissions?: PluginPermission[];
  /** enabled: false 的插件宿主要求它自己不加载 */
  enabled?: boolean;
  /** 加载时调用一次；抛错会导致这个插件加载失败（已注册的东西会被回滚） */
  setup: (ctx: PluginContext) => void | Promise<void>;
  /** 卸载/重载时调用（清理定时器、句柄等） */
  teardown?: (ctx: PluginContext) => void | Promise<void>;
}

/** 全局配置（config.json 的结构，这里只列插件常用的字段） */
export interface MyaConfig {
  provider: string;
  apiFormat: string;
  model: string;
  baseUrl: string;
  cwd: string;
  rootDir: string;
  dataDir: string;
  temperature: number | null;
  maxTurns: number;
  timeoutSec: number;
  stream: boolean;
  lang: string;
  contextWindow: number;
  /** 推理等级：auto | minimal | low | medium | high */
  reasoning?: { level: string };
  compact: { enabled: boolean; auto: boolean; threshold: number; keepRecent: number; maxSummaryTokens: number };
  tools: { autoApprove: string[]; deny: string[]; maxOutputChars: number };
  plugins: { enabled: boolean; dirs: string[]; disabled: string[]; config?: Record<string, Record<string, unknown>> };
  session: { save: boolean; dir: string; maxHistoryMessages: number };
  shell: { allowDangerous: boolean; timeoutSec: number };
  web?: { enabled: boolean; provider: string; endpoint: string; maxResults: number; timeoutSec: number; maxChars: number };
}
