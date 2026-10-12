// run_script（§5.8）：指挥官用 JavaScript 组合只读工具。
// 与 pi-codemode README 示例的关键区别：沙箱里的工具不直接调用 tool.execute()，而是经 runToolCall() 执行，
// 并带上指挥官自己的 beforeToolCall / afterToolCall——嵌套调用同样受单步、过期检查、审计等策略约束。
// 核心不会填充 nestedCalls：这里自己按 pi-ai 的 NestedToolCallRecord 收集，放进 details.nestedCalls。
import { runToolCall, type AgentContext, type AgentTool, type BeforeToolCallContext } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, JsonObject, JsonValue, NestedToolCallRecord } from '@earendil-works/pi-ai';
import { CodemodeSandbox, renderDeclarations, type CodemodeJsonSchema, type CodemodeTool } from '@earendil-works/pi-codemode';
import { Type } from 'typebox';
import { text } from './shared.ts';

export interface CodemodeDeps {
  tools: AgentTool<any>[];
  hooks: () => { beforeToolCall?: (ctx: BeforeToolCallContext, signal?: AbortSignal) => Promise<unknown>; afterToolCall?: unknown };
  context: () => AgentContext;
  /** 一个班次内跨次运行的笔记（store / load） */
  store: Record<string, JsonValue>;
}

const Params = Type.Object({ code: Type.String({ description: '异步函数体：await tools.<name>(args)；用 text() 输出，或 return 一个值' }) });
const Output = Type.Object({ ok: Type.Boolean(), value: Type.Unknown(), error: Type.Optional(Type.String()), calls: Type.Number() });

const MAX_ARG_BYTES = 2048;

export function runScriptTool(deps: CodemodeDeps): AgentTool<typeof Params> {
  const declare = (t: AgentTool<any>): Omit<CodemodeTool, 'execute'> => ({
    name: t.name,
    description: t.description,
    inputSchema: t.parameters as CodemodeJsonSchema,
    outputSchema: (t.outputSchema as CodemodeJsonSchema | undefined) ?? { type: 'string' },
  });
  return {
    name: 'run_script',
    label: '脚本编排',
    description: [
      '运行一段 JavaScript，一次组合多个只读查询（例如遍历全部信号、比较燃料与抵达时间）。嵌套调用不进入你的上下文，只有 text() 输出与返回值回来。',
      '可用 store(key, value) / load(key) 在本班次内保存笔记。',
      renderDeclarations({ tools: deps.tools.map(declare) as CodemodeTool[] }),
    ].join('\n'),
    parameters: Params,
    outputSchema: Output,
    executionMode: 'sequential',
    async execute(toolCallId, { code }, signal, onUpdate) {
      const calls: NestedToolCallRecord[] = [];
      const hooks = deps.hooks();
      const sandboxTools: CodemodeTool[] = deps.tools.map((tool) => ({
        ...declare(tool),
        execute: async (args, { signal: callSignal }) => {
          const id = `${toolCallId}.${calls.length + 1}`;
          const json = JSON.stringify(args ?? {});
          const record: NestedToolCallRecord = { id, name: tool.name, status: 'unfinished' };
          if (json.length <= MAX_ARG_BYTES) record.arguments = (args ?? {}) as JsonObject;
          else record.argumentsBytes = json.length;
          calls.push(record);
          const toolCall = { type: 'toolCall' as const, id, name: tool.name, arguments: (args ?? {}) as JsonObject };
          const assistantMessage = { role: 'assistant', content: [toolCall], api: 'nested', provider: 'codemode', model: 'run_script', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'toolUse', timestamp: Date.now() } as AssistantMessage;
          const outcome = await runToolCall(toolCall, {
            tools: deps.tools,
            assistantMessage,
            context: deps.context(),
            beforeToolCall: hooks.beforeToolCall as never,
            afterToolCall: hooks.afterToolCall as never,
            signal: callSignal,
          });
          record.durationMs = outcome.durationMs;
          const message = outcome.result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
          onUpdate?.({ content: [text(`脚本调用 ${tool.name}`)], details: { nested: calls.length, tool: tool.name } });
          if (outcome.isError) {
            record.status = 'error';
            record.error = message.slice(0, 200);
            throw new Error(message); // 在脚本里表现为 rejected promise
          }
          record.status = 'ok';
          return outcome.result.structuredContent ?? message;
        },
      }));
      const sandbox = new CodemodeSandbox({ tools: sandboxTools, timeoutMs: 15_000, memoryLimitBytes: 32 * 1024 * 1024 });
      try {
        const result = await sandbox.execute(code, { signal, store: deps.store });
        if (result.ok) {
          for (const k of result.storeWrites.delete) delete deps.store[k];
          Object.assign(deps.store, result.storeWrites.set);
        }
        const content = result.output.map((o) => (o.type === 'text' ? text(o.text) : o));
        const value = result.ok ? (result.value as JsonValue) ?? null : null;
        if (result.ok && result.value !== undefined) content.push(text(`返回值：${JSON.stringify(result.value)}`));
        if (!result.ok) content.push(text(`脚本失败（${result.error.kind}）：${result.error.stack ?? result.error.message}`));
        if (!content.length) content.push(text('（脚本没有输出）'));
        const nestedCalls = { calls, complete: calls.every((c) => c.status !== 'unfinished') && calls.every((c) => c.arguments !== undefined) };
        return {
          content: content as never,
          details: { nestedCalls, code },
          structuredContent: (result.ok ? { ok: true, value, calls: calls.length } : { ok: false, value, error: result.error.message, calls: calls.length }) as JsonObject,
          isError: !result.ok,
        };
      } finally {
        await sandbox.close();
      }
    },
  };
}
