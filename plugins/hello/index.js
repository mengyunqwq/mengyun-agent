'use strict';

/**
 * 示例插件：hello
 *
 * 用途：把这 40 行代码读懂，你就会写梦云 Agent 插件了。
 * 它演示了四个扩展点：
 *   1. ctx.registerTool()  → 给模型增加一个能力
 *   2. ctx.registerCommand() → 给交互界面增加一个斜杠命令
 *   3. ctx.on() → 挂事件钩子，观察/干预 agent 行为
 *   4. ctx.addPrompt() → 往系统提示词里加自己的要求
 *
 * 改完保存，重启 agent 即生效。
 */

let callCount = 0;

module.exports = {
  name: 'hello',
  version: '0.1.0',
  description: '示例插件：注册一个回声工具和 /hello 命令',

  setup(ctx) {
    ctx.log('已加载（这是我的第一行日志）');

    /* --------------------------------------------------------------
     * 1) 注册工具 —— 注册完模型就能调用它
     * ------------------------------------------------------------ */
    ctx.registerTool({
      name: 'hello_echo',
      description: [
        '回声工具：把传入的文本原样返回，并附带当前环境信息。',
        '用于验证插件链路是否打通，或让模型确认自己运行在什么环境里。',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要回显的文本' },
          upper: { type: 'boolean', description: '是否转成大写，默认 false' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      tags: ['example'],
      async run(args, tctx) {
        callCount += 1;
        const text = args.upper ? String(args.text).toUpperCase() : String(args.text);
        return [
          `回声：${text}`,
          `调用次数：这是第 ${callCount} 次`,
          `工作目录：${tctx.cwd}`,
          `运行平台：${process.platform}`,
          `当前模型：${tctx.cfg.model}`,
        ].join('\n');
      },
    });

    /* --------------------------------------------------------------
     * 2) 注册斜杠命令 —— 在对话界面里输入 /hello 即可触发
     *    命令不经过模型，所以不消耗 token，适合做确定性操作
     * ------------------------------------------------------------ */
    ctx.registerCommand(
      'hello',
      { description: '示例命令：跟插件打个招呼', usage: '/hello [你的名字]' },
      async (input) => {
        const who = input || '朋友';
        return `你好，${who}！这是插件 hello 直接返回的（没走模型，所以不花 token）。`;
      },
    );

    /* --------------------------------------------------------------
     * 3) 挂钩子 —— 监听 agent 的一举一动
     *    常用事件：tool:before / tool:after / turn:start / session:end
     *    钩子返回 false 可以拦截 tool:before
     * ------------------------------------------------------------ */
    ctx.on('tool:before', (e) => {
      if (e.toolName === 'shell') {
        ctx.log(`准备执行命令：${e.args.command}`);
      }
    });

    ctx.once('session:end', (e) => {
      ctx.log(`本次会话结束：${e.turns} 轮、${e.toolCalls} 次工具调用、用时 ${Math.round(e.elapsedMs / 1000)}s`);
    });

    /* --------------------------------------------------------------
     * 4) 贡献系统提示词 —— 让模型知道插件期望它怎么做事
     *    （这只是个示例，实际用时建议写对模型真正有用的约束）
     * ------------------------------------------------------------ */
    // ctx.addPrompt('需要验证环境信息时，可以调用 hello_echo 工具。');
  },
};
