// 信号生成：每 40–90 秒一个，约 15% 是恶作剧（§6.3）。
import { SECTOR_IDS, sectorCenterAngle, type SignalKind, type SignalView } from '@rescue/protocol';
import type { Rng } from './rng.ts';
import { RULES } from './rules.ts';

export type Severity = 'minor' | 'serious' | 'critical';

/** 隐藏真相：只存在于服务端世界，永远不进入快照 */
export interface SignalTruth {
  hoax: boolean;
  severity: Severity;
  /** 真实幸存者人数（恶作剧为 0） */
  survivors: number;
}

export interface SpawnedSignal {
  view: SignalView;
  truth: SignalTruth;
}

const KINDS: readonly SignalKind[] = ['passenger', 'miner', 'science', 'beacon'];

export function spawnSignal(rng: Rng, tick: number, serial: number): SpawnedSignal {
  const sector = rng.pick(SECTOR_IDS);
  const angle = sectorCenterAngle(sector) + rng.range(-0.42, 0.42);
  const radius = rng.range(38, 90);
  const kind = rng.pick(KINDS);
  const hoax = rng.chance(RULES.hoaxRate);
  const severityRoll = rng.next();
  const severity: Severity = severityRoll < 0.35 ? 'minor' : severityRoll < 0.75 ? 'serious' : 'critical';
  const reported = kind === 'passenger' ? rng.int(4, 12) : kind === 'beacon' ? rng.int(1, 2) : rng.int(2, 6);
  const life = rng.int(RULES.signalLifeTicks[0], RULES.signalLifeTicks[1]);
  const id = `S-${String(serial).padStart(2, '0')}`;
  return {
    view: {
      id,
      sector,
      kind,
      pos: { angle, radius },
      survivors: reported,
      spawnedTick: tick,
      expiresTick: tick + life,
      status: 'active',
      clues: [],
    },
    truth: { hoax, severity, survivors: hoax ? 0 : reported },
  };
}

/** 扫描揭示的文字线索。刻意不直接说「这是恶作剧」，只给证据。 */
export function scanClues(truth: SignalTruth, signalId: string): string[] {
  const clues: string[] = [];
  if (truth.hoax) {
    clues.push('信号强度恒定，未检测到多普勒漂移');
    clues.push('应答码格式规整，无设备老化特征');
  } else {
    clues.push('检测到微弱多普勒漂移，目标在缓慢翻滚');
    if (truth.severity === 'critical') clues.push('生命维持遥测断续，舱压持续下降');
    else if (truth.severity === 'serious') clues.push('主电源失效，备用电源运行中');
    else clues.push('推进系统故障，舱内环境稳定');
  }
  // 用信号编号做一点确定性的变化，避免所有线索完全相同
  if (signalId.endsWith('3') || signalId.endsWith('7')) clues.push('背景噪声偏高，读数置信度一般');
  return clues;
}
