// Hook 策略链（§5.5）：每个策略都是独立的纯函数，按顺序组合；每次 hook 调用向总线发一个 hook 应用事件。
//   beforeToolCall: stepGate → staleGuard → budgetGuard → dangerApproval
//   afterToolCall:  audit → redact → terminateOnCommit
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from '@earendil-works/pi-agent-core';
import type { CrewId, HookName, PolicyFlags, PolicyKey } from '@rescue/protocol';
import type { Bus } from '../../runtime/bus.ts';
import type { World } from '../../world/sim.ts';
import type { ApprovalCenter } from './approval.ts';
import type { Stepper } from './step-gate.ts';

export interface HookEnv {
  agentId: CrewId;
  bus: Bus;
  world: World;
  flags: PolicyFlags;
  stepper: Stepper;
  approvals: ApprovalCenter;
  runId(): string;
  /** 本次运行已发出的请求数（由回合策略维护） */
  requestsInRun(): number;
  maxRequestsPerRun: number;
}

export interface BeforePolicy {
  name: string;
  /** 由哪个开关控制；不填表示总是启用 */
  flag?: PolicyKey;
  run(ctx: BeforeToolCallContext, env: HookEnv, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> | BeforeToolCallResult | undefined;
}

export interface AfterPolicy {
  name: string;
  flag?: PolicyKey;
  run(ctx: AfterToolCallContext, env: HookEnv, signal?: AbortSignal): Promise<AfterToolCallResult | undefined> | AfterToolCallResult | undefined;
}

type ChainStep = { policy: string; result: unknown; ms: number };

export function reportHook(env: HookEnv, hook: HookName, decision: unknown, durationMs: number, toolCallId?: string): void {
  env.bus.app({ kind: 'hook', agentId: env.agentId, runId: env.runId(), hook, toolCallId, decision, durationMs });
}

/** 依次执行；第一个返回 block 的策略决定结果，后面的不再执行 */
export function composeBefore(env: HookEnv, ...policies: BeforePolicy[]) {
  return async (ctx: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> => {
    const t0 = performance.now();
    const chain: ChainStep[] = [];
    let final: BeforeToolCallResult | undefined;
    for (const p of policies) {
      if (p.flag && !env.flags[p.flag]) continue;
      const t = performance.now();
      const r = await p.run(ctx, env, signal);
      chain.push({ policy: p.name, result: r ?? 'pass', ms: round(performance.now() - t) });
      if (r?.block) {
        final = r;
        break;
      }
    }
    reportHook(env, 'beforeToolCall', { block: !!final?.block, reason: final?.reason, terminate: final?.terminate, chain }, performance.now() - t0, ctx.toolCall.id);
    return final;
  };
}

/**
 * 依次执行，后一个策略看到的是前面改写过的结果。
 * 注意 pi 的合并语义：只返回 content 会丢掉 structuredContent，所以改写 content 时两者一起返回。
 */
export function composeAfter(env: HookEnv, ...policies: AfterPolicy[]) {
  return async (ctx: AfterToolCallContext, signal?: AbortSignal): Promise<AfterToolCallResult | undefined> => {
    const t0 = performance.now();
    const chain: ChainStep[] = [];
    let merged: AfterToolCallResult | undefined;
    let current = ctx;
    for (const p of policies) {
      if (p.flag && !env.flags[p.flag]) continue;
      const t = performance.now();
      const r = await p.run(current, env, signal);
      chain.push({ policy: p.name, result: r ? Object.keys(r) : 'pass', ms: round(performance.now() - t) });
      if (!r) continue;
      merged = { ...merged, ...r };
      current = {
        ...current,
        isError: r.isError ?? current.isError,
        result: {
          ...current.result,
          ...(r.content ? { content: r.content, structuredContent: r.structuredContent } : {}),
          ...(r.structuredContent !== undefined ? { structuredContent: r.structuredContent } : {}),
          ...(r.details !== undefined ? { details: r.details } : {}),
          ...(r.terminate !== undefined ? { terminate: r.terminate } : {}),
        },
      };
    }
    reportHook(env, 'afterToolCall', { modified: merged ? Object.keys(merged) : [], chain }, performance.now() - t0, ctx.toolCall.id);
    return merged;
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
