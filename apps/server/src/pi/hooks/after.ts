// afterToolCall 策略（§5.5）：audit → redact → terminateOnCommit
import type { TextContent } from '@earendil-works/pi-ai';
import { RULES } from '../../world/rules.ts';
import type { AfterPolicy } from './compose.ts';

/** 执行开始时间：beforeToolCall 末尾记录，afterToolCall 计算耗时 */
export const startedAt = new Map<string, number>();

export const audit: AfterPolicy = {
  name: 'audit',
  flag: 'audit',
  run(ctx, env) {
    const t0 = startedAt.get(ctx.toolCall.id);
    startedAt.delete(ctx.toolCall.id);
    const prev = (ctx.result.details ?? {}) as Record<string, unknown>;
    return {
      details: {
        ...prev,
        audit: {
          correlationId: ctx.toolCall.id,
          agentId: env.agentId,
          rules: RULES.version,
          tick: env.world.tick,
          wallMs: t0 !== undefined ? Math.round(performance.now() - t0) : undefined,
        },
      },
    };
  },
};

/** 需要打码的个人信息字段（地面站船舶登记里有） */
const PII = ['captain', 'crew', 'phone', 'idNumber', 'homePort', '船长', '联系电话', '证件号'];

function mask(v: unknown): unknown {
  if (typeof v === 'string') return v.length <= 1 ? '*' : `${v[0]}${'*'.repeat(Math.min(6, v.length - 1))}`;
  if (Array.isArray(v)) return v.map(mask);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mask(x)]));
  return '***';
}

export function redactValue(v: unknown): { value: unknown; hits: number } {
  let hits = 0;
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      return Object.fromEntries(
        Object.entries(x).map(([k, val]) => {
          if (PII.includes(k)) {
            hits++;
            return [k, mask(val)];
          }
          return [k, walk(val)];
        }),
      );
    }
    return x;
  };
  return { value: walk(v), hits };
}

export function redactText(text: string): { text: string; hits: number } {
  let hits = 0;
  const out = text.replace(/(船长|联系电话|证件号)[:：]\s*([^\s，,；;]+)/g, (_m, k: string, v: string) => {
    hits++;
    return `${k}：${String(mask(v))}`;
  });
  return { text: out, hits };
}

/** 模型只看到打码后的 content；原文保留在 details.unredacted 供 UI 切换查看 */
export const redact: AfterPolicy = {
  name: 'redact',
  flag: 'redact',
  run(ctx) {
    const s = redactValue(ctx.result.structuredContent);
    let hits = s.hits;
    const content = ctx.result.content.map((c) => {
      if (c.type !== 'text') return c;
      const r = redactText(c.text);
      hits += r.hits;
      return { ...c, text: r.text } satisfies TextContent;
    });
    if (hits === 0) return undefined;
    return {
      content,
      // 只返回 content 会让 pi 丢掉 structuredContent：两者一起返回
      structuredContent: s.value as never,
      details: { ...((ctx.result.details ?? {}) as object), redacted: hits, unredacted: { content: ctx.result.content, structuredContent: ctx.result.structuredContent } },
    };
  },
};

const COMMIT_TOOLS = new Set(['stand_by', 'end_watch', 'report_back']);

export const terminateOnCommit: AfterPolicy = {
  name: 'terminateOnCommit',
  flag: 'terminateOnCommit',
  run(ctx) {
    if (!COMMIT_TOOLS.has(ctx.toolCall.name) || ctx.isError) return undefined;
    return { terminate: true };
  },
};

/** 放在 beforeToolCall 链末尾：记下真正开始执行的时间，供 audit 计算耗时 */
export const markStart = {
  name: 'markStart',
  run(ctx: { toolCall: { id: string } }) {
    startedAt.set(ctx.toolCall.id, performance.now());
    return undefined;
  },
};
