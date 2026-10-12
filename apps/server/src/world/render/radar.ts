// 雷达成像（§5.14）：极坐标网格；真实遇险船有「热斑 + 碎片尾迹」，恶作剧信标只有一个干净的亮点；
// 耀斑区叠加噪声带与伪热斑，增加误判可能。同样的输入 → 同样的像素。
import { formatTick, type Point, type SectorId } from '@rescue/protocol';
import { sectorCenterAngle } from '@rescue/protocol';
import { Rng } from '../rng.ts';
import { drawText } from './font.ts';
import { Raster, type Rgb } from './raster.ts';

export const RADAR_W = 320;
export const RADAR_H = 240;

export interface RadarBlip {
  id: string;
  point: Point;
  hoax: boolean;
  /** 碎片尾迹方向：漂移的反方向 */
  drift: Point;
}

export interface RadarInput {
  seed: number;
  tick: number;
  sector: SectorId;
  hazard: number;
  /** 传感器受损：只有前半个扇区有数据 */
  partial: boolean;
  blips: RadarBlip[];
}

const GRID: Rgb = [34, 120, 90];
const LABEL: Rgb = [140, 230, 190];
const HOT: Rgb = [255, 150, 50];
const CLEAN: Rgb = [235, 245, 255];

export function sectorProjector(sector: SectorId) {
  const scale = 3.1;
  const ox = RADAR_W / 2;
  const oy = 232 + 30 * scale;
  const center = sectorCenterAngle(sector);
  return (p: Point) => {
    const r = Math.hypot(p.x, p.y);
    let d = Math.atan2(p.y, p.x) - center;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    return { x: ox - Math.sin(d) * r * scale, y: oy - Math.cos(d) * r * scale, d, r };
  };
}

export function drawBlip(img: Raster, x: number, y: number, blip: RadarBlip, rng: Rng, zoom = 1): void {
  if (blip.hoax) {
    img.circle(x, y, 2.6 * zoom, CLEAN);
    return;
  }
  const len = Math.hypot(blip.drift.x, blip.drift.y) || 1;
  const tx = -blip.drift.x / len;
  const ty = blip.drift.y / len; // 屏幕 y 轴向下
  for (let k = 1; k <= 6; k++) {
    const jitter = (rng.next() - 0.5) * 3 * zoom;
    img.circle(x + tx * k * 4.5 * zoom + jitter, y + ty * k * 4.5 * zoom - jitter, Math.max(0.8, (1.6 - k * 0.15) * zoom), [200, 120, 60], 0.85 - k * 0.11);
  }
  img.circle(x, y, 11 * zoom, HOT, 0.18);
  img.circle(x, y, 6.5 * zoom, HOT, 0.4);
  img.circle(x, y, 3.6 * zoom, [255, 210, 120]);
}

export function noise(img: Raster, rng: Rng, count: number, alpha: number): void {
  for (let i = 0; i < count; i++) img.plot(rng.next() * img.width, rng.next() * img.height, [80, 200, 150], alpha * rng.next());
}

export function renderRadar(input: RadarInput): Raster {
  const img = new Raster(RADAR_W, RADAR_H, [4, 14, 12]);
  const rng = new Rng((input.seed ^ (input.tick * 2654435761) ^ input.sector.charCodeAt(0)) >>> 0);
  const project = sectorProjector(input.sector);
  const scale = 3.1;
  const ox = RADAR_W / 2;
  const oy = 232 + 30 * scale;

  // 网格：距离环与方位线
  for (const r of [30, 45, 60, 75, 90]) {
    for (let a = -Math.PI / 6; a <= Math.PI / 6; a += 0.004) img.plot(ox - Math.sin(a) * r * scale, oy - Math.cos(a) * r * scale, GRID, r === 30 || r === 90 ? 0.9 : 0.5);
    drawText(img, ox - Math.sin(-Math.PI / 6) * r * scale + 3, oy - Math.cos(Math.PI / 6) * r * scale - 3, String(r), GRID, 1, 0.9);
  }
  for (const a of [-Math.PI / 6, -Math.PI / 12, 0, Math.PI / 12, Math.PI / 6]) {
    img.line(ox - Math.sin(a) * 30 * scale, oy - Math.cos(a) * 30 * scale, ox - Math.sin(a) * 90 * scale, oy - Math.cos(a) * 90 * scale, GRID, a === 0 ? 0.6 : 0.35);
  }
  noise(img, rng, 900, 0.35);

  // 耀斑噪声带 + 伪热斑（没有碎片尾迹）
  if (input.hazard > 0) {
    const band = Math.round(2500 * input.hazard);
    for (let i = 0; i < band; i++) {
      const r = 40 + rng.next() * 50;
      const a = (rng.next() - 0.5) * (Math.PI / 3);
      img.plot(ox - Math.sin(a) * r * scale, oy - Math.cos(a) * r * scale, [255, 170, 90], 0.25 + rng.next() * 0.35);
    }
    const fakes = input.hazard >= 1 ? 2 : 1;
    for (let i = 0; i < fakes; i++) {
      const r = 45 + rng.next() * 40;
      const a = (rng.next() - 0.5) * (Math.PI / 3.5);
      const x = ox - Math.sin(a) * r * scale;
      const y = oy - Math.cos(a) * r * scale;
      img.circle(x, y, 7, HOT, 0.22);
      img.circle(x, y, 3, [255, 200, 120], 0.8);
    }
  }

  for (const blip of input.blips) {
    const p = project(blip.point);
    if (input.partial && p.d < 0) continue;
    drawBlip(img, p.x, p.y, blip, rng);
    drawText(img, p.x + 9, p.y - 14, blip.id, LABEL);
  }

  if (input.partial) {
    // 后半个扇区（屏幕右侧）没有数据：涂黑并加噪
    for (let y = 0; y < RADAR_H; y++) {
      for (let x = ox; x < RADAR_W; x++) {
        const d = Math.atan2(-(x - ox), oy - y);
        if (d < 0) img.plot(x, y, [10, 10, 10], 0.85);
      }
    }
    noise(img, rng, 1400, 0.5);
    drawText(img, 228, 120, 'NO DATA', [200, 80, 80], 1);
  }

  drawText(img, 6, 6, `RADAR ${input.sector}`, LABEL, 2);
  drawText(img, 6, 24, formatTick(input.tick), LABEL);
  if (input.hazard > 0) drawText(img, 230, 6, 'FLARE', [255, 150, 80], 2);
  return img;
}

export interface FrameInput {
  seed: number;
  tick: number;
  label: string;
  /** 画面中心（固定参考点，两帧相同） */
  center: Point;
  blip: RadarBlip;
}

/** 精扫帧：以固定参考点为中心放大，两帧对比可看出目标是否漂移 */
export function renderCloseFrame(input: FrameInput): Raster {
  const img = new Raster(RADAR_W, RADAR_H, [4, 14, 12]);
  const rng = new Rng((input.seed ^ (input.tick * 40503)) >>> 0);
  const zoom = 10;
  for (let gx = 0; gx <= RADAR_W; gx += 40) img.line(gx, 0, gx, RADAR_H, GRID, 0.35);
  for (let gy = 0; gy <= RADAR_H; gy += 40) img.line(0, gy, RADAR_W, gy, GRID, 0.35);
  img.line(RADAR_W / 2 - 8, RADAR_H / 2, RADAR_W / 2 + 8, RADAR_H / 2, LABEL, 0.7);
  img.line(RADAR_W / 2, RADAR_H / 2 - 8, RADAR_W / 2, RADAR_H / 2 + 8, LABEL, 0.7);
  noise(img, rng, 500, 0.3);
  const x = RADAR_W / 2 + (input.blip.point.x - input.center.x) * zoom;
  const y = RADAR_H / 2 - (input.blip.point.y - input.center.y) * zoom;
  drawBlip(img, x, y, input.blip, rng, 1.2);
  drawText(img, x + 10, y - 16, input.blip.id, LABEL);
  drawText(img, 6, 6, input.label, LABEL, 2);
  drawText(img, 6, 24, formatTick(input.tick), LABEL);
  return img;
}
