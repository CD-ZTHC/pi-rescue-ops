// pi-telemetry（§5.13）：rescue.run → rescue.request → rescue.tool 的 span 树。
// 包装后的 streamFn 把 telemetryContext 传给 pi-ai；用 InMemoryTelemetryContext 收集，供「span 视图」展示。
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { createTypedSpanStarter, defineTelemetrySchema, type TelemetryContext, type TelemetrySpan } from '@earendil-works/pi-telemetry';

export const RESCUE_TELEMETRY_SCHEMA = defineTelemetrySchema({
  version: 1,
  spans: {
    'rescue.run': {
      description: '一名船员的一次运行（prompt 到 agent_end）',
      parents: { kind: 'any' },
      startAttributes: {
        'rescue.agent': { type: 'string', required: true, description: '船员', values: ['commander', 'navigator', 'engineer', 'medic'] },
      },
      endAttributes: {
        'rescue.requests': { type: 'number', description: '本次运行的请求数' },
        'rescue.stop_reason': { type: 'string', description: '最后一条 assistant 的 stopReason' },
      },
      events: {},
      status: { default: 'ok', errorWhen: '最后一次请求失败' },
    },
    'rescue.request': {
      description: '一次模型请求（含排队等待配额）',
      parents: { kind: 'any' },
      startAttributes: {
        'rescue.model': { type: 'string', required: true, description: '模型 id' },
      },
      endAttributes: {
        'rescue.duration_ms': { type: 'number', description: 'AssistantMessage.durationMs' },
        'rescue.input_tokens': { type: 'number', description: 'usage.input' },
        'rescue.output_tokens': { type: 'number', description: 'usage.output' },
      },
      events: {},
      status: { default: 'ok', errorWhen: 'stopReason 为 error' },
    },
    'rescue.tool': {
      description: '一次工具执行',
      parents: { kind: 'any' },
      startAttributes: {
        'rescue.tool': { type: 'string', required: true, description: '工具名' },
      },
      endAttributes: {
        'rescue.is_error': { type: 'boolean', description: '业务失败（isError）' },
      },
      events: {
        'rescue.world_apply': {
          description: '工具向世界提交了命令（已受理）',
          attributes: { 'rescue.receipt': { type: 'string', required: true, description: '回执摘要' } },
        },
      },
      status: { default: 'ok', errorWhen: '工具抛出异常' },
    },
  },
} as const);

const SCHEMAS = [RESCUE_TELEMETRY_SCHEMA] as const;

/** 每名船员当前运行的 span（运行之外为 undefined） */
export interface SpanHolder {
  current?: TelemetrySpan;
}

export function startRunSpan<T>(ctx: TelemetryContext, agent: 'commander' | 'navigator' | 'engineer' | 'medic', holder: SpanHolder, body: () => Promise<T>, finish: (r: T) => { requests: number; stopReason?: string }): Promise<T> {
  const start = createTypedSpanStarter(ctx, SCHEMAS);
  return start('rescue.run', { 'rescue.agent': agent }, async (span) => {
    holder.current = span;
    try {
      const r = await body();
      const f = finish(r);
      span.setAttributes({ 'rescue.requests': f.requests, 'rescue.stop_reason': f.stopReason ?? 'none' });
      if (f.stopReason === 'error') span.setStatus({ status: 'error', error: { name: 'RequestError', message: '最后一次请求失败' } });
      return r;
    } finally {
      holder.current = undefined;
    }
  });
}

/** streamFn 包装：在当前运行 span 下开 rescue.request，并把它作为 telemetryContext 交给 pi-ai */
export function withTelemetry(inner: StreamFn, holder: SpanHolder): StreamFn {
  return async (model, context, options) => {
    const parent = holder.current;
    if (!parent) return inner(model, context, options);
    const start = createTypedSpanStarter(parent, SCHEMAS);
    return new Promise((resolve, reject) => {
      void start('rescue.request', { 'rescue.model': model.id }, async (span) => {
        try {
          const stream = await inner(model, context, { ...options, telemetryContext: span });
          resolve(stream);
          const m = await stream.result();
          span.setAttributes({ 'rescue.duration_ms': m.durationMs ?? 0, 'rescue.input_tokens': m.usage.input, 'rescue.output_tokens': m.usage.output });
          if (m.stopReason === 'error') span.setStatus({ status: 'error', error: { name: 'ProviderError', message: m.errorMessage ?? 'error' } });
        } catch (err) {
          reject(err);
        }
      });
    });
  };
}

/** 工具包装：在当前运行 span 下开 rescue.tool */
export function traceTool<T extends AgentTool<any>>(tool: T, holder: SpanHolder): T {
  return {
    ...tool,
    execute: (id, params, signal, onUpdate) => {
      const parent = holder.current;
      if (!parent) return tool.execute(id, params, signal, onUpdate);
      const start = createTypedSpanStarter(parent, SCHEMAS);
      return start('rescue.tool', { 'rescue.tool': tool.name }, async (span) => {
        const r = await tool.execute(id, params, signal, onUpdate);
        span.setAttributes({ 'rescue.is_error': r.isError === true });
        const receipt = r.structuredContent as { accepted?: boolean } | undefined;
        if (receipt && typeof receipt === 'object' && 'accepted' in receipt) span.addEvent('rescue.world_apply', { 'rescue.receipt': JSON.stringify(receipt).slice(0, 120) });
        return r;
      });
    },
  };
}
