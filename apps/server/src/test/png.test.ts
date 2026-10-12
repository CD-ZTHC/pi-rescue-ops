import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { crc32 } from '../world/render/png.ts';
import { Raster } from '../world/render/raster.ts';

test('CRC32 标准校验值', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('PNG 结构正确、可解压，同样的绘制产生同样的字节', () => {
  const draw = () => {
    const r = new Raster(64, 64);
    r.circle(40, 30, 6, [255, 140, 40]);
    return r.toPng();
  };
  const png = draw();
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 64);
  const idatLen = png.readUInt32BE(33);
  assert.equal(png.toString('ascii', 37, 41), 'IDAT');
  assert.equal(inflateSync(png.subarray(41, 41 + idatLen)).length, (64 * 4 + 1) * 64);
  assert.ok(draw().equals(png));
});

test('小于 64px 的图片在渲染阶段就被拒绝（网关对 8px 返回 1210）', () => {
  assert.throws(() => new Raster(8, 8));
});
