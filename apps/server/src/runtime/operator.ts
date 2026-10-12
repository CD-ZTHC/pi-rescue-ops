// 主管指令（§3.4）：插话、中止、调速、上下文抽屉、课程切换。审批 / 单步 / 工具试验台在 M3 加入。
import type { ClientMsg } from '@rescue/protocol';
import { operatorMessage } from '../pi/messages.ts';
import type { Station } from './station.ts';

const LATER: Partial<Record<ClientMsg['t'], string>> = {
  'approval.decide': 'M3',
  'step.set': 'M3',
  'step.next': 'M3',
  'tool.invoke': 'M3',
  'replay.load': 'M7',
};

export async function handleOperator(station: Station, msg: ClientMsg): Promise<void> {
  const { bus } = station;
  switch (msg.t) {
    case 'operator.say': {
      const member = station.crew().find((c) => c.id === msg.target);
      if (!member) {
        bus.app({ kind: 'notice', level: 'warn', text: `船员 ${msg.target} 尚未上岗（M5 加入专家团队）` });
        return;
      }
      const text = msg.text.trim();
      if (!text) return;
      if (msg.image) bus.app({ kind: 'notice', level: 'info', text: '附图功能在 M5 开放，本次只发送文字' });
      const urgency = !member.isRunning ? 'prompt' : msg.mode === 'steer' ? 'steer' : 'followUp';
      const action = member.deliver(operatorMessage(text, urgency), msg.mode);
      bus.app({ kind: 'operator.echo', target: member.id, text, mode: action });
      return;
    }
    case 'run.abort':
      for (const c of station.crew()) if (msg.target === 'all' || msg.target === c.id) c.abort();
      return;
    case 'world.speed':
      station.world.setSpeed(msg.speed);
      return;
    case 'context.request': {
      const member = station.crew().find((c) => c.id === msg.agentId);
      if (!member) return;
      bus.app({ kind: 'context.view', agentId: member.id, ...(await member.contextView()) });
      return;
    }
    case 'lesson.load':
      void station.loadLesson(msg.lessonId, msg.mode);
      return;
    case 'lesson.exit':
      await station.exitLesson();
      return;
    default:
      bus.app({ kind: 'notice', level: 'info', text: `「${msg.t}」在 ${LATER[msg.t] ?? '后续里程碑'} 实现` });
  }
}
