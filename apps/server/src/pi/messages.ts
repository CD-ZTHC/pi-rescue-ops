// convertToLlm（§5.2）。CustomAgentMessages 的声明合并在 @rescue/protocol 的 messages.ts。
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import {
  formatTick,
  MODULE_NAMES,
  SIGNAL_KIND_NAMES,
  type ModuleStatus,
  type SituationBrief,
  type WorldSnapshot,
} from '@rescue/protocol';

export type SituationMessage = Extract<AgentMessage, { role: 'situation' }>;
export type WorldEventMessage = Extract<AgentMessage, { role: 'world_event' }>;
export type OperatorMessage = Extract<AgentMessage, { role: 'operator' }>;

export function briefFromWorld(world: WorldSnapshot): SituationBrief {
  return {
    tick: world.tick,
    fuel: world.fuel,
    beds: world.beds,
    dronesDocked: world.drones.filter((d) => d.status === 'docked').length,
    dronesTotal: world.drones.length,
    modules: world.modules.map((m) => ({ name: MODULE_NAMES[m.id], status: m.status })),
    signals: world.signals
      .filter((s) => s.status === 'active')
      .map((s) => ({
        id: s.id,
        sector: s.sector,
        kind: SIGNAL_KIND_NAMES[s.kind],
        survivors: s.survivors,
        remaining: s.expiresTick - world.tick,
        clues: s.clues,
      })),
  };
}

export function situationMessage(world: WorldSnapshot, reasons: string[]): SituationMessage {
  return { role: 'situation', tick: world.tick, brief: briefFromWorld(world), reasons, timestamp: Date.now() };
}

export function worldEventMessage(kind: string, text: string, correlationId?: string): WorldEventMessage {
  return { role: 'world_event', kind, text, correlationId, timestamp: Date.now() };
}

export function operatorMessage(text: string, urgency: OperatorMessage['urgency']): OperatorMessage {
  return { role: 'operator', text, urgency, timestamp: Date.now() };
}

const MODULE_STATUS: Record<ModuleStatus, string> = { ok: '正常', damaged: '受损', offline: '离线' };

export function renderSituation(m: SituationMessage): string {
  const b = m.brief;
  const lines = [
    `【态势 ${formatTick(b.tick)}】${m.reasons.length ? `（触发：${m.reasons.join('、')}）` : ''}`,
    `资源：燃料 ${b.fuel}，医疗舱空床 ${b.beds}，在港无人机 ${b.dronesDocked}/${b.dronesTotal}`,
    `舱段：${b.modules.map((x) => `${x.name}${MODULE_STATUS[x.status]}`).join('，')}`,
  ];
  if (b.signals.length === 0) {
    lines.push('活跃信号：无');
  } else {
    lines.push('活跃信号：');
    for (const s of b.signals) {
      const clue = s.clues.length ? `；扫描线索：${s.clues.join('；')}` : '；尚未扫描';
      lines.push(`- ${s.id}｜${s.sector} 区｜${s.kind}｜报告 ${s.survivors} 人｜剩余 ${s.remaining} 秒${clue}`);
    }
  }
  return lines.join('\n');
}

/**
 * 转换规则：
 * - situation：只有最新一条完整渲染；旧的只保留一行
 * - world_event / operator / radio / compaction：带前缀的 user 文本
 * - ui_note：过滤掉
 * 约定：不得抛错（pi 的 convertToLlm 契约）。
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  let latestSituation = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'situation') {
      latestSituation = i;
      break;
    }
  }
  const out: Message[] = [];
  messages.forEach((m, i) => {
    switch (m.role) {
      case 'situation': {
        const text =
          i === latestSituation
            ? renderSituation(m)
            : `【旧态势 ${formatTick(m.tick)}，原因：${m.reasons.join('、') || '例行'}】`;
        out.push({ role: 'user', content: text, timestamp: m.timestamp });
        return;
      }
      case 'world_event':
        out.push({ role: 'user', content: `【站务】${m.text}`, timestamp: m.timestamp });
        return;
      case 'operator':
        out.push({
          role: 'user',
          content: `【主管 · ${m.urgency === 'steer' ? '插话' : m.urgency === 'followUp' ? '待办' : '指令'}】${m.text}`,
          timestamp: m.timestamp,
        });
        return;
      case 'radio':
        out.push({ role: 'user', content: `【无线电 · 信号 ${m.signalId}】${m.transcript}`, timestamp: m.timestamp });
        return;
      case 'compaction':
        out.push({ role: 'user', content: `【此前经过摘要】${m.summary}`, timestamp: m.timestamp });
        return;
      case 'ui_note':
        return;
      default:
        out.push(m);
    }
  });
  return out;
}
