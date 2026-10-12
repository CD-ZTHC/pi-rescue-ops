// 信号生成：每 40–90 秒一个，约 15% 是恶作剧（§6.3）。
import { SECTOR_IDS, sectorCenterAngle, toPoint, type Point, type SignalKind, type SignalView } from '@rescue/protocol';
import type { Rng } from './rng.ts';
import { RULES } from './rules.ts';

export type Severity = 'minor' | 'serious' | 'critical';

/** 隐藏真相：只存在于服务端世界，永远不进入快照 */
export interface SignalTruth {
  hoax: boolean;
  severity: Severity;
  /** 真实幸存者人数（恶作剧为 0） */
  survivors: number;
  origin: Point;
  /** 漂移速度（笛卡尔，单位 / tick）；恶作剧为 0——只能从雷达前后两帧看出 */
  drift: Point;
  spawnTick: number;
  /** 需要评估的成员是否危急（只能从体征波形看出） */
  members: boolean[];
}

export interface SpawnedSignal {
  view: SignalView;
  truth: SignalTruth;
}

const KINDS: readonly SignalKind[] = ['passenger', 'miner', 'science', 'beacon'];

export function spawnSignal(rng: Rng, tick: number, serial: number): SpawnedSignal {
  const sector = rng.pick(SECTOR_IDS);
  const angle = sectorCenterAngle(sector) + rng.range(-0.42, 0.42);
  const radius = rng.range(40, 86);
  const kind = rng.pick(KINDS);
  const hoax = rng.chance(RULES.hoaxRate);
  const severityRoll = rng.next();
  const severity: Severity = severityRoll < 0.35 ? 'minor' : severityRoll < 0.75 ? 'serious' : 'critical';
  const reported = kind === 'passenger' ? rng.int(4, 12) : kind === 'beacon' ? rng.int(1, 2) : rng.int(2, 6);
  const life = rng.int(RULES.signalLifeTicks[0], RULES.signalLifeTicks[1]);
  const driftDir = rng.range(0, Math.PI * 2);
  const driftSpeed = rng.range(RULES.driftSpeed[0], RULES.driftSpeed[1]);
  const uncertain = Math.min(reported, severity === 'minor' ? rng.int(0, 1) : severity === 'serious' ? rng.int(1, 2) : rng.int(2, 3));
  const criticalCount = severity === 'minor' ? 0 : severity === 'serious' ? rng.int(0, 1) : rng.int(1, 2);
  const members = Array.from({ length: uncertain }, (_, i) => i < Math.min(criticalCount, uncertain));
  // 打乱危急成员的位置，避免「总是第 1 个」
  for (let i = members.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [members[i], members[j]] = [members[j], members[i]];
  }
  const pos = { angle, radius };
  const id = `S-${String(serial).padStart(2, '0')}`;
  return {
    view: { id, sector, kind, pos, survivors: reported, spawnedTick: tick, expiresTick: tick + life, status: 'active', scanned: false, clues: [] },
    truth: {
      hoax,
      severity,
      survivors: hoax ? 0 : reported,
      origin: toPoint(pos),
      drift: hoax ? { x: 0, y: 0 } : { x: Math.cos(driftDir) * driftSpeed, y: Math.sin(driftDir) * driftSpeed },
      spawnTick: tick,
      members: hoax ? [] : members,
    },
  };
}

/** 信号在某个 tick 的真实位置（雷达成像与快照共用） */
export function positionAt(truth: SignalTruth, tick: number): Point {
  const dt = Math.max(0, tick - truth.spawnTick);
  return { x: truth.origin.x + truth.drift.x * dt, y: truth.origin.y + truth.drift.y * dt };
}

/** inspect_signal 揭示的文字线索：给出证据，但刻意不直接说「这是恶作剧」，也不给热信号特征 */
export function signalClues(truth: SignalTruth, signalId: string): string[] {
  const clues: string[] = [];
  if (truth.hoax) {
    clues.push('应答码格式规整，无设备老化特征');
    clues.push('信号强度恒定');
  } else {
    clues.push('应答码有轻微误码，符合老化设备特征');
    if (truth.severity === 'critical') clues.push('生命维持遥测断续，舱压持续下降');
    else if (truth.severity === 'serious') clues.push('主电源失效，备用电源运行中');
    else clues.push('推进系统故障，舱内环境稳定');
  }
  if (signalId.endsWith('3') || signalId.endsWith('7')) clues.push('背景噪声偏高，读数置信度一般');
  return clues;
}

const VESSEL_NAMES = ['曙光', '远航', '青鸟', '启明', '长庚', '玄武', '白鹭', '海燕', '天枢', '摇光'];

/** 求救无线电的文字转写（自定义消息 radio 的内容）。措辞不泄露真伪。 */
export function radioTranscript(view: { id: string; kind: string; survivors: number }): string {
  const n = Number(view.id.replace(/\D/g, '')) || 0;
  const name = VESSEL_NAMES[n % VESSEL_NAMES.length];
  switch (view.kind) {
    case 'passenger':
      return `这里是客船「${name}号」，主引擎失效，舱内 ${view.survivors} 人，请求救援，重复，请求救援。`;
    case 'miner':
      return `「${name}」矿船呼叫织女-7，船体受损，${view.survivors} 名矿工等待撤离。`;
    case 'science':
      return `科考船「${name}」……通讯断续……${view.survivors} 人……生命维持……`;
    default:
      return `自动信标 ${view.id}：检测到遇险，船员 ${view.survivors} 人。`;
  }
}
