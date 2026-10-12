// 体征波形（§5.14）：心电与血氧曲线。危急伤员表现为心律不齐或血氧持续下降——只能从波形看出。
import { formatTick } from '@rescue/protocol';
import { Rng } from '../rng.ts';
import { drawText } from './font.ts';
import { Raster, type Rgb } from './raster.ts';

export interface VitalsMember {
  index: number;
  critical: boolean;
}

export interface VitalsInput {
  seed: number;
  tick: number;
  patientId: string;
  members: VitalsMember[];
}

const ECG: Rgb = [70, 240, 140];
const SPO2: Rgb = [90, 200, 255];

/** 单个心搏（P-QRS-T），x 为相位 0..1 */
function beat(phase: number, wide: boolean): number {
  const g = (mu: number, sigma: number, amp: number) => amp * Math.exp(-((phase - mu) ** 2) / (2 * sigma * sigma));
  return g(0.18, 0.025, 0.12) - g(0.37, 0.01, 0.15) + g(0.4, wide ? 0.03 : 0.012, 1) - g(0.44, 0.012, 0.25) + g(0.68, 0.05, 0.3);
}

export function renderVitals(input: VitalsInput): Raster {
  const img = new Raster(320, 240, [6, 10, 14]);
  const n = Math.max(1, input.members.length);
  const rowH = Math.floor((240 - 22) / n);
  drawText(img, 6, 6, `VITALS ${input.patientId}`, [200, 215, 230]);
  drawText(img, 236, 6, formatTick(input.tick), [140, 155, 170]);
  input.members.forEach((m, i) => {
    const rng = new Rng((input.seed ^ (m.index * 7919) ^ input.patientId.charCodeAt(2) * 104729) >>> 0);
    const top = 20 + i * rowH;
    const mid = top + rowH * 0.5;
    img.line(4, top, 316, top, [40, 50, 60]);
    drawText(img, 8, top + 6, String(m.index), [230, 235, 240], 2);
    drawText(img, 26, top + 6, 'ECG', ECG);
    // 心电：稳定者规律；危急者 RR 间期紊乱并夹杂宽大畸形波
    const mode = m.critical ? (rng.chance(0.5) ? 'arrhythmia' : 'desat') : 'stable';
    const x0 = 26;
    const x1 = 214;
    let x = x0;
    let prevY = mid;
    while (x < x1) {
      const rr = mode === 'arrhythmia' ? 16 + rng.next() * 40 : 36;
      const wide = mode === 'arrhythmia' && rng.chance(0.45);
      for (let k = 0; k < rr && x + k < x1; k++) {
        const y = mid - beat(k / rr, wide) * rowH * 0.36 + (rng.next() - 0.5) * 0.6;
        img.line(x + k - 1, prevY, x + k, y, ECG);
        prevY = y;
      }
      x += rr;
    }
    // 血氧趋势：右侧小图，含 90% 参考虚线
    const sx0 = 226;
    const sx1 = 312;
    const yOf = (v: number) => top + rowH - 6 - ((v - 78) / (100 - 78)) * (rowH - 18);
    drawText(img, sx0, top + 6, 'SPO2', SPO2);
    for (let xx = sx0; xx < sx1; xx += 4) img.plot(xx, yOf(90), [200, 90, 90], 0.8);
    drawText(img, sx1 - 12, yOf(90) - 9, '90', [200, 90, 90]);
    let py = yOf(97);
    for (let xx = sx0; xx < sx1; xx++) {
      const t = (xx - sx0) / (sx1 - sx0);
      const v = mode === 'desat' ? 95 - t * 13 + (rng.next() - 0.5) : 97 + (rng.next() - 0.5) * 1.2;
      const y = yOf(v);
      img.line(xx - 1, py, xx, y, SPO2);
      py = y;
    }
  });
  return img;
}
