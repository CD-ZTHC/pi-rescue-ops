// 危险操作审批（§5.5 dangerApproval）：发出 approval.requested，await 主管决定，30 秒超时视为否决。
import { randomUUID } from 'node:crypto';
import type { CrewId } from '@rescue/protocol';
import type { Bus } from '../../runtime/bus.ts';
import type { World } from '../../world/sim.ts';
import type { BeforePolicy } from './compose.ts';

export type Decision = 'approve' | 'deny' | 'timeout';

export interface PendingApproval {
  approvalId: string;
  agentId: CrewId;
  toolCallId: string;
  tool: string;
  args: unknown;
  risk: string;
  expiresAt: number;
}

export class ApprovalCenter {
  readonly timeoutMs: number;
  private pending = new Map<string, { info: PendingApproval; resolve: (d: { decision: Decision; note?: string }) => void; timer: NodeJS.Timeout }>();
  private readonly bus: Bus;
  /** 课程自动驾驶等外部观察者 */
  onRequest?: (info: PendingApproval) => void;

  constructor(bus: Bus, timeoutMs = 30_000) {
    this.bus = bus;
    this.timeoutMs = timeoutMs;
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map((p) => p.info);
  }

  request(agentId: CrewId, toolCallId: string, tool: string, args: unknown, risk: string, signal?: AbortSignal) {
    const info: PendingApproval = { approvalId: randomUUID(), agentId, toolCallId, tool, args, risk, expiresAt: Date.now() + this.timeoutMs };
    return new Promise<{ decision: Decision; note?: string }>((resolve) => {
      const finish = (decision: Decision, note?: string) => {
        const p = this.pending.get(info.approvalId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(info.approvalId);
        signal?.removeEventListener('abort', onAbort);
        this.bus.app({ kind: 'approval.resolved', approvalId: info.approvalId, decision });
        resolve({ decision, note });
      };
      const onAbort = () => finish('deny', '运行已中止');
      const timer = setTimeout(() => finish('timeout'), this.timeoutMs);
      this.pending.set(info.approvalId, { info, resolve: (d) => finish(d.decision, d.note), timer });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.bus.app({ kind: 'approval.requested', ...info });
      this.onRequest?.(info);
    });
  }

  decide(approvalId: string, decision: 'approve' | 'deny', note?: string): boolean {
    const p = this.pending.get(approvalId);
    if (!p) return false;
    p.resolve({ decision, note });
    return true;
  }

  /** 世界切换时清空：一律否决 */
  clear(): void {
    for (const id of [...this.pending.keys()]) this.decide(id, 'deny', '站点重置');
  }
}

/** 判断一次工具调用是否危险，返回风险描述；不危险返回 undefined */
export function riskOf(tool: string, args: Record<string, unknown>, world: World): string | undefined {
  if (tool === 'vent_section') return `排空 ${String(args.module)} 的 ${String(args.cell)} 区段：若判断错误会造成人员伤亡`;
  if (tool === 'dispatch_drone') {
    const plan = world.plan(String(args.signalId), (args.route as 'direct' | 'safe') ?? 'direct');
    if (plan?.route.hazardous) {
      return `航线 ${Math.round(plan.hazardFraction * 100)}% 在危险区（${plan.hazardSectors.join('、')}），燃料 ${plan.fuel}，无人机可能受损`;
    }
  }
  return undefined;
}

export const dangerApproval: BeforePolicy = {
  name: 'dangerApproval',
  flag: 'dangerApproval',
  async run(ctx, env, signal) {
    const risk = riskOf(ctx.toolCall.name, ctx.args as Record<string, unknown>, env.world);
    if (!risk) return undefined;
    if (env.flags.autoApprove) return undefined;
    const { decision, note } = await env.approvals.request(env.agentId, ctx.toolCall.id, ctx.toolCall.name, ctx.args, risk, signal);
    if (decision === 'approve') return undefined;
    return { block: true, reason: decision === 'timeout' ? '主管未在 30 秒内批准，视为否决' : `主管否决${note ? `：${note}` : ''}` };
  },
};
