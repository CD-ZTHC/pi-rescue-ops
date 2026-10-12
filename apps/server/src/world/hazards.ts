// 耀斑与舱段事故（§6.3）：每 3–5 分钟一次，提前 60 秒预警，可能损坏舱段。
import { CAMERA_CELLS, SECTOR_IDS, type FlareView, type IncidentKind, type ModuleStatus, type SectorId } from '@rescue/protocol';
import type { Rng } from './rng.ts';
import { RULES } from './rules.ts';

/** 舱段事故的真相：火点 / 烟雾 / 破口所在网格只画在监控画面里 */
export interface Incident {
  kind: IncidentKind;
  cell: string;
}

export const ALARM_TEXT: Record<IncidentKind, string> = {
  fire: '高温告警',
  smoke: '烟雾告警',
  breach: '失压告警',
};

export function planFlare(rng: Rng, startTick: number, serial: number): FlareView {
  const i = rng.int(0, SECTOR_IDS.length - 1);
  const sectors: SectorId[] = [SECTOR_IDS[i], SECTOR_IDS[(i + 1) % SECTOR_IDS.length]];
  return {
    id: `FL-${serial}`,
    sectors,
    warnTick: startTick - RULES.flare.warning,
    startTick,
    endTick: startTick + RULES.flare.duration,
  };
}

export function sectorHazard(flares: readonly FlareView[], tick: number, sector: SectorId): number {
  let h = 0;
  for (const f of flares) {
    if (!f.sectors.includes(sector)) continue;
    if (tick >= f.startTick && tick < f.endTick) h = Math.max(h, 1);
    else if (tick >= f.warnTick && tick < f.startTick) h = Math.max(h, 0.3);
  }
  return h;
}

export function worsen(status: ModuleStatus): ModuleStatus {
  return status === 'ok' ? 'damaged' : 'offline';
}

export function rollIncident(rng: Rng): Incident {
  const kind = rng.pick<IncidentKind>(['fire', 'smoke', 'breach']);
  return { kind, cell: rng.pick(CAMERA_CELLS) };
}

export function repairTicks(status: ModuleStatus, incident?: Incident): number {
  const base = status === 'offline' ? RULES.repairTicks.offline : RULES.repairTicks.damaged;
  return base + (incident?.kind === 'breach' ? RULES.repairTicks.breachExtra : 0);
}
