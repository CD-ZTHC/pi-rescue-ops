// 世界事件 → 指挥官唤醒策略（§4.4）。项目没有自己的调度器，完全依靠 pi 的 prompt / steer / followUp 语义。
//
// | 指挥官状态 | 事件            | 动作                     |
// | 空闲       | 新信号          | prompt([situation])       |
// | 运行中     | 新信号（普通）  | followUp(situation)       |
// | 运行中     | 紧急            | steer(situation)          |
// | 任意       | 低优先级站务    | append（下次运行时可见）  |
import type { WorldEvent } from '@rescue/protocol';
import { SIGNAL_KIND_NAMES } from '@rescue/protocol';
import type { CrewMember } from '../pi/crew.ts';
import { situationMessage, worldEventMessage } from '../pi/messages.ts';
import type { World } from '../world/sim.ts';

export interface DispatcherDeps {
  commander: () => CrewMember;
  /** 判断事件是否紧急（M6 由分诊台给出；M1 一律普通） */
  isUrgent?: (ev: WorldEvent) => boolean;
}

export interface DispatchRecord {
  event: WorldEvent['type'];
  action: 'prompt' | 'steer' | 'followUp' | 'append' | 'ignored';
}

export class Dispatcher {
  enabled = true;
  readonly log: DispatchRecord[] = [];
  private readonly deps: DispatcherDeps;
  private world?: World;

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
  }

  /** 订阅一个世界的事件；返回取消函数。世界切换时由调用方先取消旧的。 */
  attach(world: World): () => void {
    this.world = world;
    return world.subscribe(({ events }) => {
      for (const ev of events) this.handle(ev);
    });
  }

  handle(ev: WorldEvent): DispatchRecord['action'] {
    const action = this.enabled && this.world ? this.route(ev, this.world) : 'ignored';
    this.log.push({ event: ev.type, action });
    if (this.log.length > 500) this.log.shift();
    return action;
  }

  private route(ev: WorldEvent, world: World): DispatchRecord['action'] {
    const commander = this.deps.commander();
    switch (ev.type) {
      case 'signal.spawned': {
        const s = ev.signal;
        const msg = situationMessage(world.snapshot(), [`新信号 ${s.id}（${s.sector} 区${SIGNAL_KIND_NAMES[s.kind]}）`]);
        const urgent = this.deps.isUrgent?.(ev) ?? false;
        return commander.deliver(msg, urgent ? 'steer' : 'followUp');
      }
      case 'signal.lost':
        commander.append(worldEventMessage('signal.lost', `信号 ${ev.signalId} 已失联（倒计时结束）`));
        return 'append';
      case 'shift.ended':
        commander.append(worldEventMessage('shift.ended', `班次结束：获救 ${ev.score.rescued}，错失 ${ev.score.missed}，得分 ${ev.score.total}`));
        return 'append';
      default:
        return 'ignored';
    }
  }
}
