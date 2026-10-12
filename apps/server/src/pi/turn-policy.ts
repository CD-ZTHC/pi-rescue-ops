// 回合策略（§5.6）。M1 只有 finishTurn 的请求预算；修正轮与 prepareRequest 在 M3 加入。
import type { FinishTurn } from '@earendil-works/pi-agent-core';

export interface TurnHookReporter {
  (hook: 'finishTurn', decision: unknown, durationMs: number): void;
}

/**
 * 本轮请求数达到上限时结束运行。
 * - stopReason 为 error / aborted 时返回 undefined（错误由运行时统一处理，pi 也会忽略决定）
 */
export function turnBudget(maxRequestsPerRun: number, report?: TurnHookReporter): { finishTurn: FinishTurn; reset(): void } {
  let requests = 0;
  return {
    reset() {
      requests = 0;
    },
    finishTurn(turn) {
      const t0 = performance.now();
      requests += 1;
      let decision: { action: 'end' } | undefined;
      const stop = turn.message.stopReason;
      if (stop !== 'error' && stop !== 'aborted' && requests >= maxRequestsPerRun) decision = { action: 'end' };
      report?.('finishTurn', decision ?? { action: 'default', requests }, performance.now() - t0);
      return decision;
    },
  };
}
