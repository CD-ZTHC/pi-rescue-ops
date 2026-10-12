// 主管指令（§3.4）：插话、中止、调速、上下文抽屉、课程切换。审批 / 单步 / 工具试验台在 M3 加入。
import type { ClientMsg } from '@rescue/protocol';
import { operatorMessage } from '../pi/messages.ts';
import type { Station } from './station.ts';

const LATER: Partial<Record<ClientMsg['t'], string>> = {
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
      const urgency = !member.isRunning ? 'prompt' : msg.mode === 'steer' ? 'steer' : 'followUp';
      const images = msg.image ? [{ type: 'image' as const, data: msg.image.data, mimeType: msg.image.mimeType }] : undefined;
      if (images && !member.view().vision) bus.app({ kind: 'notice', level: 'info', text: `${member.spec.name}看不到图片：附图将以占位文本送达` });
      const action = member.deliver(operatorMessage(text, urgency, images), msg.mode);
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
    case 'approval.decide':
      if (!station.approvals.decide(msg.approvalId, msg.decision, msg.note)) bus.app({ kind: 'notice', level: 'warn', text: '该审批已失效（超时或已处理）' });
      return;
    case 'step.set':
      station.setStepping(msg.enabled);
      return;
    case 'step.next':
      station.stepper.next();
      return;
    case 'policy.set':
      station.setPolicy(msg.key, msg.value);
      return;
    case 'queue.mode':
      for (const c of station.crew()) if (msg.target === 'all' || msg.target === c.id) c.setQueueModes(msg.steering, msg.followUp);
      return;
    case 'tool.invoke': {
      const member = station.member(msg.agentId);
      if (!member) return;
      const outcome = await member.bench(msg.tool, msg.args);
      bus.app({
        kind: 'bench.result',
        agentId: member.id,
        tool: msg.tool,
        args: msg.args,
        isError: outcome.isError,
        durationMs: outcome.durationMs,
        content: outcome.result.content,
        structured: outcome.result.structuredContent,
        blocked: outcome.isError && outcome.durationMs === undefined,
      });
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
