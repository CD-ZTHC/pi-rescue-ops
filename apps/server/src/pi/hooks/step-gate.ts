// 单步调试（§5.5 stepGate）：开启后在 hook 里 await 主管点击「下一步」；世界同时暂停。必须响应中止信号。
import type { CrewId, HookName } from '@rescue/protocol';
import type { Bus } from '../../runtime/bus.ts';
import type { World } from '../../world/sim.ts';
import type { BeforePolicy } from './compose.ts';

export class Stepper {
  private waiting: Array<{ resolve: () => void; agentId: CrewId; at: HookName; detail: unknown }> = [];
  private _enabled = false;
  private savedSpeed: 0 | 0.5 | 1 | 2 = 1;
  private readonly bus: Bus;
  private readonly world: () => World;

  constructor(bus: Bus, world: () => World) {
    this.bus = bus;
    this.world = world;
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /** 最早停住、等待放行的位置（新连接的页面用它恢复「下一步」按钮） */
  get current(): { agentId: CrewId; at: HookName; detail: unknown } | undefined {
    const w = this.waiting[0];
    return w ? { agentId: w.agentId, at: w.at, detail: w.detail } : undefined;
  }

  set(enabled: boolean): void {
    if (enabled === this._enabled) return;
    this._enabled = enabled;
    const w = this.world();
    if (enabled) {
      this.savedSpeed = w.snapshot().speed || 1;
      w.setSpeed(0);
    } else {
      w.setSpeed(this.savedSpeed);
      for (const p of this.waiting.splice(0)) p.resolve();
    }
  }

  /** 放行最早停住的一个 */
  next(): void {
    this.waiting.shift()?.resolve();
  }

  /** 在某个 hook 处停住，直到 next() / 关闭单步 / 中止 */
  async gate(agentId: CrewId, at: HookName, detail: unknown, signal?: AbortSignal): Promise<void> {
    if (!this._enabled) return;
    this.bus.app({ kind: 'step.paused', agentId, at, detail });
    await new Promise<void>((resolve) => {
      const entry = { resolve: () => done(), agentId, at, detail };
      const done = () => {
        signal?.removeEventListener('abort', done);
        this.waiting = this.waiting.filter((w) => w !== entry);
        resolve();
      };
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', done, { once: true });
      this.waiting.push(entry);
    });
    this.bus.app({ kind: 'step.resumed', agentId });
  }
}

export const stepGate: BeforePolicy = {
  name: 'stepGate',
  async run(ctx, env, signal) {
    await env.stepper.gate(env.agentId, 'beforeToolCall', { tool: ctx.toolCall.name, args: ctx.args }, signal);
    return undefined;
  },
};
