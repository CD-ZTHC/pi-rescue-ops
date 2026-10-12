// 世界规则常量与纯函数（§6.3）。刻意保持简单。
import type { ScoreView } from '@rescue/protocol';

export const RULES = {
  version: 'rules-0.1',
  shiftTicks: 720,
  signalIntervalTicks: [40, 90] as const,
  firstSignalTick: 5,
  signalLifeTicks: [180, 420] as const,
  hoaxRate: 0.15,
  fuelMax: 100,
  bedsTotal: 4,
  drones: 3,
  scanTicks: [3, 6] as const,
  score: { rescued: 10, hoaxFuel: -1, missed: -15 },
};

export function computeScore(rescued: number, hoaxFuel: number, missed: number): ScoreView {
  const total = rescued * RULES.score.rescued + hoaxFuel * RULES.score.hoaxFuel + missed * RULES.score.missed;
  return { rescued, hoaxFuel, missed, total };
}
