// 无人机航线：二次贝塞尔。direct 走直线；safe 先借道相邻星区、最后才切入目标（更远，但在危险区里飞得少）。
// 燃料 = 基础量 ×（1 + 航线在危险区内的比例）：全程在耀斑区内即翻倍（§6.2）。
import { bezier, sectorOfAngle, toPolar, type DroneRoute, type Point, type SectorId } from '@rescue/protocol';
import { RULES } from './rules.ts';

export type RouteKind = 'direct' | 'safe';

export interface PlannedRoute {
  route: Omit<DroneRoute, 'departTick' | 'arriveTick'>;
  length: number;
  ticks: number;
  fuel: number;
  /** 航线经过的危险星区 */
  hazardSectors: SectorId[];
  /** 航线（站点 25 半径以外部分）落在危险区内的比例 0..1 */
  hazardFraction: number;
}

const STATION: Point = { x: 0, y: 0 };

function sample(route: Omit<DroneRoute, 'departTick' | 'arriveTick' | 'hazardous'>, n = 24): Point[] {
  return Array.from({ length: n + 1 }, (_, i) => bezier(route, i / n));
}

export function routeLength(route: Omit<DroneRoute, 'departTick' | 'arriveTick' | 'hazardous'>): number {
  const pts = sample(route, 32);
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

function hazardsOn(route: Omit<DroneRoute, 'departTick' | 'arriveTick' | 'hazardous'>, hazard: (s: SectorId) => number) {
  const sectors = new Set<SectorId>();
  let inside = 0;
  let total = 0;
  for (const p of sample(route, 40)) {
    const polar = toPolar(p);
    if (polar.radius < 25) continue; // 站点附近不算
    total += 1;
    const s = sectorOfAngle(polar.angle);
    if (hazard(s) > 0) {
      sectors.add(s);
      inside += 1;
    }
  }
  return { sectors: [...sectors], fraction: total ? inside / total : 0 };
}

export function baseFuel(length: number): number {
  return Math.round(Math.min(RULES.fuelCost.max, Math.max(RULES.fuelCost.min, length * RULES.fuelCost.perUnit)));
}

export function fuelFor(length: number, hazardFraction: number): number {
  return Math.round(baseFuel(length) * (1 + hazardFraction));
}

export function planRoute(target: Point, kind: RouteKind, hazard: (s: SectorId) => number): PlannedRoute {
  const mid = { x: target.x / 2, y: target.y / 2 };
  const candidates = [mid];
  if (kind === 'safe') {
    // 控制点沿垂直方向偏移，左右各试几档：航线先经过相邻星区，最后才切入目标
    const len = Math.hypot(target.x, target.y) || 1;
    const perp = { x: -target.y / len, y: target.x / len };
    for (const k of [0.4, -0.4, 0.7, -0.7, 1.0, -1.0]) candidates.push({ x: mid.x + perp.x * len * k, y: mid.y + perp.y * len * k });
  }
  const plans = candidates.map((ctrl): PlannedRoute => {
    const base = { from: STATION, ctrl, to: target };
    const hz = hazardsOn(base, hazard);
    const length = routeLength(base);
    return {
      route: { ...base, hazardous: hz.fraction > 0 },
      length,
      ticks: Math.max(1, Math.ceil(length / RULES.droneSpeed)),
      fuel: fuelFor(length, hz.fraction),
      hazardSectors: hz.sectors,
      hazardFraction: hz.fraction,
    };
  });
  if (kind === 'direct') return plans[0];
  // safe：先比危险区暴露，再比燃料
  return plans.reduce((best, p) => (p.hazardFraction < best.hazardFraction - 1e-9 || (Math.abs(p.hazardFraction - best.hazardFraction) < 1e-9 && p.fuel < best.fuel) ? p : best));
}

/** 返程：沿原路反向 */
export function reverse(route: DroneRoute, departTick: number): DroneRoute {
  const ticks = route.arriveTick - route.departTick;
  return { from: route.to, ctrl: route.ctrl, to: route.from, departTick, arriveTick: departTick + ticks, hazardous: route.hazardous };
}
