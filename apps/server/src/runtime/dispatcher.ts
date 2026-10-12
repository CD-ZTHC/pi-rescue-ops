// 世界事件 → 船员唤醒策略（§4.4）。项目没有自己的调度器，完全依靠 pi 的 prompt / steer / followUp 语义。
//
// | 事件                    | 对象   | 动作                                          |
// | 新信号                  | 指挥官 | 空闲 prompt / 运行中 followUp（紧急则 steer）  |
// | 耀斑预警                | 指挥官 | 紧急：空闲 prompt / 运行中 steer               |
// | 舱段受损                | 工程师 | 值班任务：prompt / followUp；指挥官 append     |
// | 伤员接回                | 医疗官 | 值班任务：prompt / followUp；指挥官 append     |
// | 救援结果、失联等站务    | 指挥官 | append（下次运行时可见，不额外发请求）         |
//
// M5 有了 delegate 之后，「值班任务」改为由指挥官决定是否委派（autoDuty 关闭）。
import type { CrewId, WorldEvent } from '@rescue/protocol';
import { MODULE_NAMES, SIGNAL_KIND_NAMES } from '@rescue/protocol';
import type { CrewMember } from '../pi/crew.ts';
import { radioMessage, situationMessage, worldEventMessage } from '../pi/messages.ts';
import { radioTranscript } from '../world/spawner.ts';
import type { World } from '../world/sim.ts';

export interface DispatcherDeps {
  crew: (id: CrewId) => CrewMember | undefined;
  /** 判断事件是否紧急（M6 由分诊台给出） */
  isUrgent?: (ev: WorldEvent) => boolean;
}

export type DispatchAction = 'prompt' | 'steer' | 'followUp' | 'append' | 'ignored';

export interface DispatchRecord {
  event: WorldEvent['type'];
  target?: CrewId;
  action: DispatchAction;
}

export class Dispatcher {
  enabled = true;
  /** 把舱段受损、伤员接回直接派给工程师 / 医疗官 */
  autoDuty = true;
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

  handle(ev: WorldEvent): DispatchAction {
    if (!this.enabled || !this.world) {
      this.record(ev, undefined, 'ignored');
      return 'ignored';
    }
    let last: DispatchAction = 'ignored';
    for (const [target, action] of this.route(ev, this.world)) {
      this.record(ev, target, action);
      last = action;
    }
    return last;
  }

  private record(ev: WorldEvent, target: CrewId | undefined, action: DispatchAction): void {
    this.log.push({ event: ev.type, target, action });
    if (this.log.length > 500) this.log.shift();
  }

  private route(ev: WorldEvent, world: World): Array<[CrewId, DispatchAction]> {
    const commander = this.deps.crew('commander');
    if (!commander) return [];
    const note = (kind: string, text: string, cid?: string): [CrewId, DispatchAction] => {
      commander.append(worldEventMessage(kind, text, cid));
      return ['commander', 'append'];
    };
    // 值班任务：autoDuty 时直接派给专家；否则（委派模式）唤醒指挥官，由它决定委派给谁
    const duty = (id: CrewId, text: string): Array<[CrewId, DispatchAction]> => {
      if (!this.autoDuty) return [['commander', commander.deliver(worldEventMessage('duty', text), 'followUp')]];
      const member = this.deps.crew(id);
      if (!member) return [];
      return [[id, member.deliver(worldEventMessage('duty', text), 'followUp')]];
    };
    switch (ev.type) {
      case 'signal.spawned': {
        const s = ev.signal;
        const msg = situationMessage(world.snapshot(), [`新信号 ${s.id}（${s.sector} 区${SIGNAL_KIND_NAMES[s.kind]}）`]);
        const radio = radioMessage(s.id, radioTranscript(s));
        return [['commander', commander.deliver([radio, msg], this.deps.isUrgent?.(ev) ? 'steer' : 'followUp')]];
      }
      case 'flare.warning': {
        const msg = situationMessage(world.snapshot(), [`耀斑预警：${ev.sectors.join('、')} 区将在 ${ev.startTick - ev.tick} 秒后爆发`]);
        return [['commander', commander.deliver(msg, 'steer')]];
      }
      case 'module.damaged':
        return [
          ...(this.autoDuty ? [note('module.damaged', `${MODULE_NAMES[ev.module]}受损（${ev.status === 'offline' ? '离线' : '受损'}${ev.alarm ? `，${ev.alarm}` : ''}）`)] : []),
          ...duty('engineer', `${MODULE_NAMES[ev.module]}受损${ev.alarm ? `，${ev.alarm}` : ''}。请诊断并处置。`),
        ];
      case 'patient.arrived':
        return [
          ...(this.autoDuty ? [note('patient.arrived', `伤员组 ${ev.patient.id} 已接回（${ev.patient.count} 人，来自 ${ev.patient.signalId}）`)] : []),
          ...duty('medic', `伤员组 ${ev.patient.id} 已接回：${ev.patient.count} 人，其中 ${ev.patient.members.length} 人状况不明，${ev.patient.deadlineTick - ev.tick} 秒内需决定是否收治。`),
        ];
      case 'drone.arrived': {
        const text =
          ev.outcome === 'rescued'
            ? `${ev.droneId} 抵达 ${ev.signalId}，救出 ${ev.survivors} 人，正在返航`
            : ev.outcome === 'hoax'
              ? `${ev.droneId} 抵达 ${ev.signalId}：现场只有一个自动信标，是诱饵，燃料白白消耗`
              : `${ev.droneId} 抵达 ${ev.signalId}：目标已失联`;
        return [note('drone.arrived', text, ev.correlationId)];
      }
      case 'drone.returned':
        return [note('drone.returned', `${ev.droneId} 已返港${ev.survivors ? `，带回 ${ev.survivors} 人` : ''}${ev.damaged ? '；机体受损，需检修 60 秒' : ''}`, ev.correlationId)];
      case 'drone.damaged':
        return [note('drone.damaged', `${ev.droneId} 在耀斑中受损`)];
      case 'signal.lost':
        return [note('signal.lost', `信号 ${ev.signalId} 已失联（倒计时结束）`)];
      case 'module.repaired':
        return [note('module.repaired', `${MODULE_NAMES[ev.module]}已修复`)];
      case 'patient.lost':
        return [note('patient.lost', `伤员 ${ev.patientId}-${ev.member} 因未及时收治而死亡`)];
      case 'shift.ended':
        return [note('shift.ended', `班次结束：获救 ${ev.score.rescued}，错失 ${ev.score.missed}，得分 ${ev.score.total}`)];
      default:
        return [];
    }
  }
}
