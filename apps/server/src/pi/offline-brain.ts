// faux 离线大脑（G3）：没有 API key 时的「规则型指挥官」。
// 它是一个 FauxResponseFactory：读取模型此刻能看到的上下文（convertToLlm 之后），给出确定性的回复。
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxContentBlock,
  type FauxResponseFactory,
  type Message,
} from '@earendil-works/pi-ai';

const textOf = (m: Message | undefined): string => {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return m.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
};

function thinking(level: string | undefined, short: string, long: string): FauxContentBlock[] {
  if (!level || level === 'off') return [];
  if (level === 'minimal' || level === 'low') return [fauxThinking(short)];
  return [fauxThinking(`${short}\n${long}`)];
}

/** 从最新态势里找出「尚未扫描」的信号所在星区（去重，最多 3 个） */
export function unscannedSectors(situation: string): string[] {
  const sectors = new Set<string>();
  for (const line of situation.split('\n')) {
    const m = line.match(/^- (S-\d+)｜([A-F]) 区.*尚未扫描/);
    if (m) sectors.add(m[2]);
  }
  return [...sectors].slice(0, 3);
}

export const offlineCommanderBrain: FauxResponseFactory = (context, options) => {
  const messages = context.messages.filter((m) => m.role !== 'system');
  const last = messages[messages.length - 1];
  const level = options?.reasoning;

  if (last?.role === 'toolResult') {
    const results = [];
    for (let i = messages.length - 1; i >= 0 && messages[i].role === 'toolResult'; i--) results.unshift(messages[i]);
    const scanText = results.filter((r) => r.role === 'toolResult' && r.toolName === 'scan_sector').map(textOf).join('\n');
    const suspicious = /无多普勒漂移|格式规整/.test(scanText);
    const critical = /生命维持遥测断续/.test(scanText);
    const verdict = suspicious
      ? '扫描显示有信号特征过于干净，疑似诱饵，先不投入资源。'
      : critical
        ? '扫描确认有危急目标，生命维持在恶化，需要尽快安排救援。'
        : '扫描结果正常，目标真实，情况可控。';
    return fauxAssistantMessage(
      [
        ...thinking(level, '对照扫描线索判断真伪。', '恒定信号强度、规整应答码是诱饵的典型特征；多普勒漂移说明目标在真实运动。'),
        fauxText(verdict),
        fauxToolCall('stand_by', { reason: `${verdict}（离线演示：M2 起才能派出无人机）` }),
      ],
      { stopReason: 'toolUse' },
    );
  }

  const prompt = textOf(last);
  if (prompt.startsWith('【主管')) {
    const body = prompt.replace(/^【[^】]*】/, '');
    return fauxAssistantMessage(
      [
        ...thinking(level, '主管有新指示，先确认再执行。', '把指示和当前态势对照，判断是否需要调整计划。'),
        fauxText(`收到主管指示：「${body.slice(0, 40)}」。我会据此调整。`),
        fauxToolCall('stand_by', { reason: '已记录主管指示，等待下一条态势' }),
      ],
      { stopReason: 'toolUse' },
    );
  }

  // 找到最新一条完整态势
  const situation = [...messages].reverse().map(textOf).find((t) => t.startsWith('【态势')) ?? '';
  const sectors = unscannedSectors(situation);
  if (sectors.length > 0) {
    return fauxAssistantMessage(
      [
        ...thinking(
          level,
          `有 ${sectors.length} 个星区的信号尚未核实。`,
          '约 15% 的信号是诱饵。派无人机之前先扫描，扫描可以并行进行，代价只是几秒钟。',
        ),
        fauxText(`先核实信号：扫描 ${sectors.join('、')} 区。`),
        ...sectors.map((sector) => fauxToolCall('scan_sector', { sector })),
      ],
      { stopReason: 'toolUse' },
    );
  }
  return fauxAssistantMessage(
    [
      ...thinking(level, '没有需要核实的新信号。', '保持待命，节省燃料。'),
      fauxText('态势平稳，暂无需要行动的信号。'),
      fauxToolCall('stand_by', { reason: '无新的未核实信号' }),
    ],
    { stopReason: 'toolUse' },
  );
};
