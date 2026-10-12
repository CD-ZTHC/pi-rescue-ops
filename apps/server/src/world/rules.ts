// 世界规则常量与纯函数（§6.3）。刻意保持简单。
import type { ScoreView } from '@rescue/protocol';

export const RULES = {
  version: 'rules-0.2',
  shiftTicks: 720,
  signalIntervalTicks: [40, 90] as const,
  firstSignalTick: 5,
  signalLifeTicks: [180, 420] as const,
  hoaxRate: 0.15,
  /** 真实遇险船的漂移速度（半径单位 / tick）；恶作剧信标静止 */
  driftSpeed: [0.03, 0.05] as const,
  fuelMax: 100,
  bedsTotal: 4,
  drones: 3,
  droneSpeed: 3,
  /** 出动一次 8–20，进入危险区翻倍 */
  fuelCost: { min: 8, max: 20, perUnit: 0.12 },
  droneRepairTicks: 60,
  scanTicks: [3, 6] as const,
  flare: { firstTick: [150, 240] as const, interval: [180, 300] as const, warning: 60, duration: 40, moduleHitChance: 0.7 },
  repairTicks: { damaged: 8, offline: 15, breachExtra: 5 },
  patient: { deadline: 90, stabilize: 150 },
  score: { rescued: 10, hoaxFuel: -1, missed: -15, death: -10, penalty: -5 },
};

export function computeScore(s: Omit<ScoreView, 'total'>): ScoreView {
  const r = RULES.score;
  const total = s.rescued * r.rescued + s.hoaxFuel * r.hoaxFuel + s.missed * r.missed + s.deaths * r.death + s.penalties * r.penalty;
  return { ...s, total };
}

export function emptyScore(): ScoreView {
  return computeScore({ rescued: 0, hoaxFuel: 0, missed: 0, deaths: 0, penalties: 0 });
}
