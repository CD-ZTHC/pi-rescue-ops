import assert from 'node:assert/strict';
import { test } from 'node:test';
import { World } from '../world/sim.ts';

function run(seed: number, ticks: number, scanAt: number): string {
  const w = new World({ seed });
  for (let t = 0; t < ticks; t++) {
    if (t === scanAt) w.enqueue({ type: 'scan', sector: 'C' });
    w.step();
  }
  return JSON.stringify(w.snapshot());
}

test('同一 seed 与同一命令序列，两次运行快照一致', () => {
  assert.equal(run(42, 400, 30), run(42, 400, 30));
  assert.notEqual(run(42, 400, 30), run(43, 400, 30));
});

test('preview 是纯校验：非法星区、重复扫描被拒绝，且不改变世界', () => {
  const w = new World({ seed: 1 });
  const before = JSON.stringify(w.snapshot());
  assert.deepEqual(w.preview({ type: 'scan', sector: 'Z' as never }), { ok: false, reason: '不存在星区 Z' });
  assert.equal(w.preview({ type: 'scan', sector: 'A' }).ok, true);
  assert.equal(JSON.stringify(w.snapshot()), before);
  w.enqueue({ type: 'scan', sector: 'A' });
  w.step();
  assert.equal(w.preview({ type: 'scan', sector: 'A' }).ok, false);
});

test('命令在下一个 tick 生效；扫描完成后揭示线索；隐藏真相不进入快照', () => {
  const w = new World({ seed: 7, autoSpawn: false });
  const s = w.spawnNow();
  w.enqueue({ type: 'scan', sector: s.sector, correlationId: 'tc-1' });
  assert.equal(w.snapshot().scans.length, 0, '入队后、tick 之前尚未生效');
  const events = [];
  for (let i = 0; i < 10; i++) events.push(...w.step().events);
  const done = events.find((e) => e.type === 'scan.completed');
  assert.ok(done && done.type === 'scan.completed');
  assert.equal(done.correlationId, 'tc-1');
  assert.deepEqual(done.signalIds, [s.id]);
  assert.ok(w.signal(s.id)!.clues.length > 0);
  const json = JSON.stringify(w.snapshot().signals);
  assert.ok(!/hoax|severity|truth/.test(json));
});

test('信号倒计时结束后失联；真实信号计入错失', () => {
  const w = new World({ seed: 3, autoSpawn: false });
  const s = w.spawnNow();
  const events = [];
  while (w.tick < s.expiresTick) events.push(...w.step().events);
  assert.ok(events.some((e) => e.type === 'signal.lost' && e.signalId === s.id));
  assert.equal(w.snapshot().score.missed, w.truthOf(s.id)!.hoax ? 0 : 1);
});

test('一班 720 tick 后交班', () => {
  const w = new World({ seed: 9 });
  let ended = false;
  for (let i = 0; i < 720; i++) ended ||= w.step().events.some((e) => e.type === 'shift.ended');
  assert.ok(ended);
  assert.equal(w.snapshot().ended, true);
});
