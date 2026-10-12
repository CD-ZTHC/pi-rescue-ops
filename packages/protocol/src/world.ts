// 世界快照（§6）。注意：信号的「隐藏真相」不在快照里，只存在于服务端世界内部。

export const SECTOR_IDS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
export type SectorId = (typeof SECTOR_IDS)[number];

export type ModuleId = 'sensors' | 'hangar' | 'medbay' | 'comms';
export type ModuleStatus = 'ok' | 'damaged' | 'offline';
export type SignalKind = 'passenger' | 'miner' | 'science' | 'beacon';
export type SignalStatus = 'active' | 'locked' | 'rescued' | 'lost';
export type WatchPhase = 'calm' | 'storm' | 'crisis' | 'handover';

/** 极坐标：角度（弧度，0 指向右侧，逆时针）、半径 0..100（站点在 0） */
export interface Polar {
  angle: number;
  radius: number;
}

export interface SectorView {
  id: SectorId;
  /** 星区中心角（弧度），每个星区跨 60° */
  angle: number;
  /** 危险度 0..1，随耀斑变化 */
  hazard: number;
  lastScanTick?: number;
}

export interface SignalView {
  id: string;
  sector: SectorId;
  kind: SignalKind;
  pos: Polar;
  /** 报告的幸存者人数（报告值，未必真实） */
  survivors: number;
  spawnedTick: number;
  expiresTick: number;
  status: SignalStatus;
  /** 扫描揭示的线索；未扫描时为空 */
  clues: string[];
  /** 分诊结果摘要（M6 才有） */
  triage?: { severity: string; urgency: number; hoax: number };
}

export interface DroneView {
  id: string;
  status: 'docked' | 'outbound' | 'returning';
  pos: Polar;
  targetSignalId?: string;
  carrying: number;
}

export interface ModuleView {
  id: ModuleId;
  name: string;
  status: ModuleStatus;
}

export interface ScoreView {
  rescued: number;
  hoaxFuel: number;
  missed: number;
  total: number;
}

export interface WorldSnapshot {
  seed: number;
  tick: number;
  shiftTicks: number;
  speed: 0 | 0.5 | 1 | 2;
  phase: WatchPhase;
  fuel: number;
  fuelMax: number;
  beds: number;
  bedsTotal: number;
  modules: ModuleView[];
  sectors: SectorView[];
  signals: SignalView[];
  drones: DroneView[];
  score: ScoreView;
  /** 正在进行的扫描（用于画扫描波纹） */
  scans: Array<{ sector: SectorId; startTick: number; endTick: number; correlationId?: string }>;
  ended: boolean;
}

/** 世界补丁：只包含发生变化的顶层字段 */
export type WorldPatch = Partial<WorldSnapshot>;

export type WorldEvent =
  | { type: 'signal.spawned'; tick: number; signal: SignalView }
  | { type: 'signal.lost'; tick: number; signalId: string; reason: 'expired' }
  | { type: 'scan.started'; tick: number; sector: SectorId; correlationId?: string }
  | { type: 'scan.completed'; tick: number; sector: SectorId; signalIds: string[]; correlationId?: string }
  | { type: 'shift.ended'; tick: number; score: ScoreView }
  | { type: 'command.rejected'; tick: number; reason: string; correlationId?: string };

export const SECTOR_NAMES: Record<SectorId, string> = {
  A: 'A 区', B: 'B 区', C: 'C 区', D: 'D 区', E: 'E 区', F: 'F 区',
};

export const SIGNAL_KIND_NAMES: Record<SignalKind, string> = {
  passenger: '客船', miner: '矿船', science: '科考船', beacon: '信标',
};

export const MODULE_NAMES: Record<ModuleId, string> = {
  sensors: '传感器', hangar: '机库', medbay: '医疗舱', comms: '通讯',
};

export function sectorCenterAngle(id: SectorId): number {
  const i = SECTOR_IDS.indexOf(id);
  // A 区从正上方开始，顺时针排布
  return Math.PI / 2 - i * (Math.PI / 3);
}

export function formatTick(tick: number): string {
  const m = Math.floor(tick / 60);
  const s = tick % 60;
  return `T+${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
