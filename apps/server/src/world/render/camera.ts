// 舱段监控（§5.14）：俯视平面图，4×3 网格（A1–D3）；火点（橙）、烟雾（灰团）、破口（黑色缺口）画在真实位置。
import { CAMERA_COLS, CAMERA_ROWS, formatTick, type IncidentKind, type ModuleId } from '@rescue/protocol';
import { Rng } from '../rng.ts';
import { drawText } from './font.ts';
import { Raster, type Rgb } from './raster.ts';

export interface CameraInput {
  seed: number;
  tick: number;
  module: ModuleId;
  incident?: { kind: IncidentKind; cell: string };
}

const TITLES: Record<ModuleId, string> = { sensors: 'SENSOR CAM', hangar: 'HANGAR CAM', medbay: 'MEDBAY CAM', comms: 'COMMS CAM' };
const X0 = 16;
const Y0 = 34;
const CW = 72;
const CH = 64;

export function cellRect(cell: string): { x: number; y: number; w: number; h: number } {
  const col = CAMERA_COLS.indexOf(cell[0] as (typeof CAMERA_COLS)[number]);
  const row = Number(cell.slice(1)) - 1;
  return { x: X0 + col * CW, y: Y0 + row * CH, w: CW, h: CH };
}

export function renderCamera(input: CameraInput): Raster {
  const img = new Raster(320, 240, [16, 20, 26]);
  const rng = new Rng((input.seed ^ (input.tick * 2246822519) ^ input.module.length * 97) >>> 0);
  const floor: Rgb = [38, 46, 58];
  const wall: Rgb = [120, 132, 150];
  img.rect(X0, Y0, CW * 4, CH * 3, floor);
  // 设备（装饰，按舱段固定）
  const deco = new Rng(input.module.charCodeAt(0) * 131 + input.module.length);
  for (let i = 0; i < 7; i++) {
    const c = cellRect(`${CAMERA_COLS[deco.int(0, 3)]}${CAMERA_ROWS[deco.int(0, 2)]}`);
    img.rect(c.x + 10 + deco.int(0, 20), c.y + 12 + deco.int(0, 18), 18 + deco.int(0, 14), 10 + deco.int(0, 10), [62, 72, 88]);
  }
  // 网格线与坐标
  for (let c = 0; c <= 4; c++) img.line(X0 + c * CW, Y0, X0 + c * CW, Y0 + CH * 3, [70, 82, 100], 0.6);
  for (let r = 0; r <= 3; r++) img.line(X0, Y0 + r * CH, X0 + CW * 4, Y0 + r * CH, [70, 82, 100], 0.6);
  for (const col of CAMERA_COLS) for (const row of CAMERA_ROWS) {
    const rc = cellRect(`${col}${row}`);
    drawText(img, rc.x + 4, rc.y + 4, `${col}${row}`, [150, 165, 185]);
  }
  // 外墙
  for (let t = 0; t < 3; t++) {
    img.line(X0 - t, Y0 - t, X0 + CW * 4 + t, Y0 - t, wall);
    img.line(X0 - t, Y0 + CH * 3 + t, X0 + CW * 4 + t, Y0 + CH * 3 + t, wall);
    img.line(X0 - t, Y0 - t, X0 - t, Y0 + CH * 3 + t, wall);
    img.line(X0 + CW * 4 + t, Y0 - t, X0 + CW * 4 + t, Y0 + CH * 3 + t, wall);
  }

  const inc = input.incident;
  if (inc) {
    const rc = cellRect(inc.cell);
    const cx = rc.x + rc.w / 2;
    const cy = rc.y + rc.h / 2 + 4;
    if (inc.kind === 'fire') {
      img.circle(cx, cy, 30, [255, 120, 30], 0.18);
      for (let i = 0; i < 9; i++) {
        img.circle(cx + (rng.next() - 0.5) * 34, cy + (rng.next() - 0.5) * 26, 4 + rng.next() * 6, rng.chance(0.5) ? [255, 140, 30] : [255, 210, 80], 0.85);
      }
    } else if (inc.kind === 'smoke') {
      for (let i = 0; i < 14; i++) img.circle(cx + (rng.next() - 0.5) * 60, cy + (rng.next() - 0.5) * 44, 8 + rng.next() * 10, [150, 150, 155], 0.35);
    } else {
      // 破口：墙边则在外墙开口，内部网格则画一道黑色裂缝
      const onEdge = rc.y === Y0 || rc.y + rc.h === Y0 + CH * 3 || rc.x === X0 || rc.x + rc.w === X0 + CW * 4;
      if (onEdge) {
        const ex = rc.x === X0 ? X0 - 2 : rc.x + rc.w === X0 + CW * 4 ? X0 + CW * 4 - 6 : cx - 14;
        const ey = rc.y === Y0 ? Y0 - 2 : rc.y + rc.h === Y0 + CH * 3 ? Y0 + CH * 3 - 6 : cy - 14;
        img.rect(ex, ey, rc.x === X0 || rc.x + rc.w === X0 + CW * 4 ? 9 : 28, rc.y === Y0 || rc.y + rc.h === Y0 + CH * 3 ? 9 : 28, [0, 0, 0]);
      }
      let x = cx - 22;
      let y = cy;
      for (let i = 0; i < 22; i++) {
        const nx = x + 2;
        const ny = y + (rng.next() - 0.5) * 6;
        img.line(x, y, nx, ny, [0, 0, 0]);
        img.line(x, y + 1, nx, ny + 1, [0, 0, 0]);
        x = nx;
        y = ny;
      }
      for (let i = 0; i < 10; i++) img.circle(cx + (rng.next() - 0.5) * 40, cy + (rng.next() - 0.5) * 30, 1.2, [180, 190, 200], 0.8);
    }
  }
  drawText(img, 16, 10, TITLES[input.module], [200, 210, 225], 2);
  drawText(img, 236, 14, formatTick(input.tick), [150, 165, 185]);
  img.circle(306, 18, 3, [240, 60, 60], 0.9); // REC
  return img;
}
