// beforeToolCall 的两道守卫（§5.5）：staleGuard（目标已失效）与 budgetGuard（燃料 / 无人机 / 请求预算）。
import type { BeforePolicy } from './compose.ts';

const SIGNAL_TOOLS = new Set(['dispatch_drone', 'allocate_fuel', 'compare_frames', 'plot_course']);

export const staleGuard: BeforePolicy = {
  name: 'staleGuard',
  flag: 'staleGuard',
  run(ctx, env) {
    if (!SIGNAL_TOOLS.has(ctx.toolCall.name)) return undefined;
    const id = String((ctx.args as { signalId?: unknown }).signalId ?? '');
    const s = env.world.signal(id);
    if (!s) return { block: true, reason: `信号 ${id} 不存在` };
    if (s.status === 'lost') return { block: true, reason: `信号 ${id} 已失联${s.outcome === 'hoax' ? '（已证实是诱饵）' : ''}` };
    if (s.status === 'rescued') return { block: true, reason: `信号 ${id} 已获救` };
    if (s.status === 'locked' && ctx.toolCall.name !== 'plot_course') return { block: true, reason: `信号 ${id} 已被锁定：已有无人机前往` };
    return undefined;
  },
};

export const budgetGuard: BeforePolicy = {
  name: 'budgetGuard',
  flag: 'budgetGuard',
  run(ctx, env) {
    // 本轮请求数已到上限：放行这次调用，但提示运行在本批工具之后结束
    const lastRequest = env.requestsInRun() >= env.maxRequestsPerRun;
    if (ctx.toolCall.name !== 'dispatch_drone') return undefined;
    const a = ctx.args as { droneId: string; signalId: string; route?: 'direct' | 'safe' };
    const drone = env.world.drone(a.droneId);
    if (!drone || drone.status !== 'docked') {
      const docked = env.world.snapshot().drones.filter((d) => d.status === 'docked').map((d) => d.id);
      return { block: true, reason: `${a.droneId} 不可用；在港无人机：${docked.join('、') || '无'}`, terminate: lastRequest || undefined };
    }
    const plan = env.world.plan(a.signalId, a.route ?? 'direct');
    const available = env.world.availableFuel(a.signalId);
    if (plan && plan.fuel > available) {
      return { block: true, reason: `燃料不足：需要 ${plan.fuel}，可用 ${available}`, terminate: lastRequest || undefined };
    }
    return undefined;
  },
};
