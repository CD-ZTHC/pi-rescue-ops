// 船员定义（§3.2）。M1 只有指挥官；专家在 M2/M5 加入。
import type { Config } from '../config.ts';
import type { CrewSpec } from './crew.ts';
import { commanderTools } from './tools/commander.ts';

export function commanderSpec(config: Config): CrewSpec {
  return {
    id: 'commander',
    name: '北辰',
    title: '值班指挥官',
    model: config.commanderModel,
    thinkingLevel: 'low',
    maxRequestsPerRun: 6,
    mission: [
      '你统筹整个夜班的救援：研判求救信号、调度资源、决定先救谁。',
      '每次被唤醒时先看【态势】，再决定行动。不确定信号真伪时，先扫描对应星区。',
      '回复要短：一两句结论，然后用工具行动。',
    ].join('\n'),
    toolsGuide: [
      'scan_sector：核实某星区信号真伪，可在一次回复里并行扫描多个星区。',
      'stand_by：本轮无需行动（或已安排好）时调用，并说明理由。每次运行都应以行动或 stand_by 结束。',
    ].join('\n'),
    tools: (deps) => commanderTools({ world: deps.world }),
  };
}
