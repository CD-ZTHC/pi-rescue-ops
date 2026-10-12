// 世界快照（§6）。注意：信号与伤员的「隐藏真相」、火点所在网格都不在快照里，只存在于服务端世界内部。

export const SECTOR_IDS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
export type SectorId = (typeof SECTOR_IDS)[number];

export const MODULE_IDS = ['sensors', 'hangar', 'medbay', 'comms'] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
export type ModuleStatus = 'ok' | 'damaged' | 'offline';
export type SignalKind = 'passenger' | 'miner' | 'science' | 'beacon';
export type SignalStatus = 'active' | 'locked' | 'rescued' | 'lost';
export type WatchPhase = 'calm' | 'storm' | 'crisis' | 'handover';
export type DroneStatus = 'docked' | 'outbound' | 'returning' | 'repairing';
export type IncidentKind = 'fire' | 'smoke' | 'breach';

/** 舱段监控的网格：4 列（A–D）× 3 行（1–3） */
export const CAMERA_COLS = ['A', 'B', 'C', 'D'] as const;
export const CAMERA_ROWS = [1, 2, 3] as const;
export const CAMERA_CELLS = CAMERA_COLS.flatMap((c) => CAMERA_ROWS.map((r) => `${c}${r}`));

/** 极坐标：角度（弧度，0 指向右侧，逆时针）、半径 0..100（站点在 0） */
export interface Polar {
  angle: number;
  radius: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface SectorView {
  id: SectorId;
  /** 星区中心角（弧度），每个星区跨 60° */
  angle: number;
  /** 危险度 0..1：耀斑预警 0.3，耀斑期间 1 */
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
  /** 结局：获救 / 证实为恶作剧 / 倒计时结束 */
  outcome?: 'rescued' | 'hoax' | 'expired';
  /** 是否已被扫描过（扫描只给出图像，不在快照里写线索） */
  scanned: boolean;
  /** inspect_signal 揭示的文字线索 */
  clues: string[];
  /** 已为它预留的燃料 */
  reservedFuel?: number;
  /** 分诊结果摘要（M6 才有） */
  triage?: { severity: string; urgency: number; hoax: number };
}

export interface DroneRoute {
  /** 二次贝塞尔：起点、控制点、终点（笛卡尔坐标，单位同半径） */
  from: Point;
  ctrl: Point;
  to: Point;
  departTick: number;
  arriveTick: number;
  hazardous: boolean;
}

export interface DroneView {
  id: string;
  status: DroneStatus;
  pos: Polar;
  targetSignalId?: string;
  carrying: number;
  route?: DroneRoute;
  /** 下达这次出动的工具调用 id，地图 → Inspector → 频道联动用 */
  correlationId?: string;
  fuelCost?: number;
  /** 飞行中遭遇耀斑：返航后需要检修 */
  damaged?: boolean;
  repairedTick?: number;
}

export interface ModuleView {
  id: ModuleId;
  name: string;
  status: ModuleStatus;
  /** 告警文字（不含位置），例如「高温告警」 */
  alarm?: string;
  repair?: { startTick: number; endTick: number; correlationId?: string };
}

export interface FlareView {
  id: string;
  sectors: SectorId[];
  warnTick: number;
  startTick: number;
  endTick: number;
}

export interface PatientMemberView {
  index: number;
  status: 'unknown' | 'bedded' | 'stable' | 'lost';
}

export interface PatientView {
  id: string;
  signalId: string;
  /** 伤员组总人数 */
  count: number;
  arrivedTick: number;
  /** 需要进一步评估（看体征）的成员；其中谁危急只能从波形看出 */
  members: PatientMemberView[];
  /** 危急成员必须在这个 tick 之前入住医疗舱，否则失去 */
  deadlineTick: number;
}

export interface ScoreView {
  rescued: number;
  hoaxFuel: number;
  missed: number;
  deaths: number;
  penalties: number;
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
  fuelReserved: number;
  beds: number;
  bedsTotal: number;
  modules: ModuleView[];
  sectors: SectorView[];
  signals: SignalView[];
  drones: DroneView[];
  flares: FlareView[];
  patients: PatientView[];
  score: ScoreView;
  /** 正在进行的扫描（用于画扫描波纹） */
  scans: Array<{ sector: SectorId; startTick: number; endTick: number; correlationId?: string }>;
  ended: boolean;
  report?: string;
}

/** 世界补丁：只包含发生变化的顶层字段 */
export type WorldPatch = Partial<WorldSnapshot>;

export type WorldEvent =
  | { type: 'signal.spawned'; tick: number; signal: SignalView }
  | { type: 'signal.lost'; tick: number; signalId: string; reason: 'expired' }
  | { type: 'scan.started'; tick: number; sector: SectorId; correlationId?: string }
  | { type: 'scan.completed'; tick: number; sector: SectorId; signalIds: string[]; partial: boolean; correlationId?: string }
  | { type: 'drone.dispatched'; tick: number; droneId: string; signalId: string; fuel: number; eta: number; hazardous: boolean; correlationId?: string }
  | { type: 'drone.arrived'; tick: number; droneId: string; signalId: string; outcome: 'rescued' | 'hoax' | 'gone'; survivors: number; correlationId?: string }
  | { type: 'drone.returned'; tick: number; droneId: string; survivors: number; patientId?: string; damaged: boolean; correlationId?: string }
  | { type: 'drone.damaged'; tick: number; droneId: string; flareId: string }
  | { type: 'fuel.allocated'; tick: number; signalId: string; amount: number; correlationId?: string }
  | { type: 'flare.warning'; tick: number; flareId: string; sectors: SectorId[]; startTick: number }
  | { type: 'flare.started'; tick: number; flareId: string; sectors: SectorId[] }
  | { type: 'flare.ended'; tick: number; flareId: string }
  | { type: 'module.damaged'; tick: number; module: ModuleId; status: ModuleStatus; alarm?: string }
  | { type: 'repair.started'; tick: number; module: ModuleId; endTick: number; correlationId?: string }
  | { type: 'module.repaired'; tick: number; module: ModuleId; correlationId?: string }
  | { type: 'vent.result'; tick: number; module: ModuleId; cell: string; success: boolean; correlationId?: string }
  | { type: 'patient.arrived'; tick: number; patient: PatientView }
  | { type: 'patient.bedded'; tick: number; patientId: string; members: number[]; correlationId?: string }
  | { type: 'patient.lost'; tick: number; patientId: string; member: number }
  | { type: 'patient.stable'; tick: number; patientId: string; member: number }
  | { type: 'shift.ended'; tick: number; score: ScoreView; report?: string }
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

/** 由角度求所在星区 */
export function sectorOfAngle(angle: number): SectorId {
  const fromA = Math.PI / 2 - angle + Math.PI / 6;
  const norm = ((fromA % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return SECTOR_IDS[Math.floor(norm / (Math.PI / 3)) % 6];
}

export function toPoint(p: Polar): Point {
  return { x: Math.cos(p.angle) * p.radius, y: Math.sin(p.angle) * p.radius };
}

export function toPolar(p: Point): Polar {
  return { angle: Math.atan2(p.y, p.x), radius: Math.hypot(p.x, p.y) };
}

/** 二次贝塞尔上的点 */
export function bezier(r: Pick<DroneRoute, 'from' | 'ctrl' | 'to'>, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * r.from.x + 2 * u * t * r.ctrl.x + t * t * r.to.x,
    y: u * u * r.from.y + 2 * u * t * r.ctrl.y + t * t * r.to.y,
  };
}

export function formatTick(tick: number): string {
  const m = Math.floor(tick / 60);
  const s = tick % 60;
  return `T+${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
