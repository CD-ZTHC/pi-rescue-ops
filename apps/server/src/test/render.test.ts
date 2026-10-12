// 三种图：确定性、尺寸、「图里有」的真相确实画在图里。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAMERA_CELLS, sectorCenterAngle, toPoint } from '@rescue/protocol';
import { peekCamera } from '../pi/offline-brain.ts';
import { renderCamera } from '../world/render/camera.ts';
import { renderRadar, sectorProjector } from '../world/render/radar.ts';
import { renderVitals } from '../world/render/vitals.ts';
import type { Raster } from '../world/render/raster.ts';

function orangeNear(img: Raster, x: number, y: number, r = 6): number {
  let n = 0;
  for (let yy = Math.round(y - r); yy <= y + r; yy++) {
    for (let xx = Math.round(x - r); xx <= x + r; xx++) {
      const i = (yy * img.width + xx) * 4;
      if (img.data[i] > 200 && img.data[i + 1] > 100 && img.data[i + 2] < 160) n++;
    }
  }
  return n;
}

test('雷达：真实信号是橙色热斑，恶作剧信标没有；同输入同字节', () => {
  const c = sectorCenterAngle('B');
  const real = { id: 'S-01', point: toPoint({ angle: c + 0.15, radius: 60 }), hoax: false, drift: { x: 0.04, y: 0 } };
  const hoax = { id: 'S-02', point: toPoint({ angle: c - 0.2, radius: 75 }), hoax: true, drift: { x: 0, y: 0 } };
  const input = { seed: 5, tick: 40, sector: 'B' as const, hazard: 0, partial: false, blips: [real, hoax] };
  const img = renderRadar(input);
  const project = sectorProjector('B');
  const pr = project(real.point);
  const ph = project(hoax.point);
  assert.ok(orangeNear(img, pr.x, pr.y) > 20);
  assert.equal(orangeNear(img, ph.x, ph.y), 0);
  assert.ok(renderRadar(input).toPng().equals(img.toPng()));
  assert.equal(img.width, 320);
  assert.equal(img.height, 240);
});

test('监控：离线「眼睛」能在 12 个网格里找到火点与烟雾', () => {
  for (const cell of CAMERA_CELLS) {
    for (const kind of ['fire', 'smoke'] as const) {
      const img = renderCamera({ seed: 3, tick: 10, module: 'hangar', incident: { kind, cell } });
      assert.equal(peekCamera(img.toBase64()), cell, `${kind}@${cell}`);
    }
  }
  assert.equal(peekCamera(renderCamera({ seed: 3, tick: 10, module: 'hangar' }).toBase64()), undefined);
});

test('体征：危急与稳定成员的图像不同，且可复现', () => {
  const a = renderVitals({ seed: 1, tick: 9, patientId: 'P-01', members: [{ index: 1, critical: false }, { index: 2, critical: true }] });
  const b = renderVitals({ seed: 1, tick: 9, patientId: 'P-01', members: [{ index: 1, critical: false }, { index: 2, critical: false }] });
  assert.ok(!a.toPng().equals(b.toPng()));
  assert.ok(a.toPng().equals(renderVitals({ seed: 1, tick: 9, patientId: 'P-01', members: [{ index: 1, critical: false }, { index: 2, critical: true }] }).toPng()));
});
