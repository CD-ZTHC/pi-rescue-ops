// M2 世界规则：无人机、燃料、耀斑、舱段事故、医疗舱。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WorldEvent } from '@rescue/protocol';
import { World } from '../world/sim.ts';
import { RULES } from '../world/rules.ts';
import { baseFuel } from '../world/drones.ts';

function quiet(seed = 11): World {
  return new World({ seed, autoSpawn: false, autoHazards: false });
}

/** 一直生成信号，直到得到一个满足条件的 */
function spawnUntil(w: World, pred: (hoax: boolean, members: boolean[]) => boolean) {
  for (let i = 0; i < 200; i++) {
    const s = w.spawnNow();
    const t = w.truthOf(s.id)!;
    if (pred(t.hoax, t.members)) return s;
  }
  throw new Error('没有找到满足条件的信号');
}

function runUntil(w: World, pred: (ev: WorldEvent) => boolean, max = 400): WorldEvent[] {
  const all: WorldEvent[] = [];
  for (let i = 0; i < max; i++) {
    const { events } = w.step();
    all.push(...events);
    if (events.some(pred)) return all;
  }
  throw new Error('等待事件超时');
}

test('出动 → 抵达 → 救出 → 返港 → 伤员组接回；燃料按航线扣除', () => {
  const w = quiet();
  const s = spawnUntil(w, (hoax, members) => !hoax && members.length > 0);
  const plan = w.plan(s.id, 'direct')!;
  assert.equal(w.enqueue({ type: 'dispatch', droneId: 'D-1', signalId: s.id, route: 'direct', correlationId: 'c1' }).ok, true);
  const events = runUntil(w, (e) => e.type === 'drone.returned');
  const snap = w.snapshot();
  assert.equal(snap.fuel, RULES.fuelMax - plan.fuel);
  const arrived = events.find((e) => e.type === 'drone.arrived');
  assert.ok(arrived && arrived.type === 'drone.arrived' && arrived.outcome === 'rescued' && arrived.correlationId === 'c1');
  assert.equal(w.signal(s.id)!.status, 'rescued');
  assert.equal(snap.score.rescued, w.truthOf(s.id)!.survivors);
  assert.equal(snap.patients.length, 1);
  assert.equal(snap.patients[0].members.length, w.truthOf(s.id)!.members.length);
  assert.equal(w.drone('D-1')!.status, 'docked');
});

test('诱饵信号：无人机白跑，燃料计入恶作剧损耗', () => {
  const w = quiet(12);
  const s = spawnUntil(w, (hoax) => hoax);
  w.enqueue({ type: 'dispatch', droneId: 'D-2', signalId: s.id, route: 'direct' });
  const events = runUntil(w, (e) => e.type === 'drone.arrived');
  const ev = events.find((e) => e.type === 'drone.dispatched')!;
  assert.ok(ev.type === 'drone.dispatched');
  assert.equal(w.snapshot().score.hoaxFuel, ev.fuel);
  assert.equal(w.signal(s.id)!.outcome, 'hoax');
});

test('耀斑：燃料按危险区暴露比例增加；safe 航线暴露更少；飞行中遭遇耀斑的无人机受损', () => {
  const w = quiet(13);
  const s = w.spawnNow();
  w.scheduleFlare([s.sector], 2);
  for (let i = 0; i < 3; i++) w.step();
  assert.equal(w.hazard(s.sector), 1);
  const direct = w.plan(s.id, 'direct')!;
  assert.equal(direct.route.hazardous, true);
  assert.ok(direct.hazardFraction > 0.9, '直飞几乎全程在目标星区内');
  assert.equal(direct.fuel, Math.round(baseFuel(direct.length) * (1 + direct.hazardFraction)));
  const safe = w.plan(s.id, 'safe')!;
  assert.ok(safe.hazardFraction < direct.hazardFraction, '绕行在危险区里飞得更少');
  assert.ok(safe.length > direct.length, '代价是航程更长');
  w.enqueue({ type: 'dispatch', droneId: 'D-1', signalId: s.id, route: 'direct' });
  const events = runUntil(w, (e) => e.type === 'drone.damaged', 60);
  assert.ok(events.some((e) => e.type === 'drone.damaged'));
});

test('耀斑预警提前 60 秒；击中舱段时产生事故；同 seed 可复现', () => {
  const run = () => {
    const w = new World({ seed: 99, autoSpawn: false });
    const events: WorldEvent[] = [];
    for (let i = 0; i < 400; i++) events.push(...w.step().events);
    return { w, events };
  };
  const a = run();
  const warn = a.events.find((e) => e.type === 'flare.warning');
  const start = a.events.find((e) => e.type === 'flare.started');
  assert.ok(warn && start && warn.type === 'flare.warning');
  assert.equal(start.tick - warn.tick, RULES.flare.warning);
  assert.deepEqual(a.events.map((e) => `${e.tick}:${e.type}`), run().events.map((e) => `${e.tick}:${e.type}`));
});

test('起火的舱段：先排空正确网格才能修复；排错网格扣分', () => {
  const w = quiet(14);
  w.damageModule('hangar', 'damaged', { kind: 'fire', cell: 'C2' });
  assert.match((w.preview({ type: 'repair', module: 'hangar' }) as { reason: string }).reason, /火情未处置/);
  w.enqueue({ type: 'vent', module: 'hangar', cell: 'A1' });
  w.step();
  assert.equal(w.snapshot().score.penalties, 1);
  w.enqueue({ type: 'vent', module: 'hangar', cell: 'C2' });
  const ev = w.step().events.find((e) => e.type === 'vent.result');
  assert.ok(ev && ev.type === 'vent.result' && ev.success);
  assert.equal(w.preview({ type: 'repair', module: 'hangar' }).ok, true);
  w.enqueue({ type: 'repair', module: 'hangar', correlationId: 'r1' });
  const events = runUntil(w, (e) => e.type === 'module.repaired');
  const started = events.find((e) => e.type === 'repair.started')!;
  const done = events.find((e) => e.type === 'module.repaired')!;
  assert.equal(done.tick - started.tick, RULES.repairTicks.damaged);
  assert.equal(w.module('hangar').status, 'ok');
});

test('机库受损时不能出动；传感器受损时扫描只有半个扇区', () => {
  const w = quiet(15);
  const s = w.spawnNow();
  w.damageModule('hangar', 'damaged');
  assert.match((w.preview({ type: 'dispatch', droneId: 'D-1', signalId: s.id, route: 'direct' }) as { reason: string }).reason, /机库受损/);
  w.damageModule('sensors', 'damaged');
  w.enqueue({ type: 'scan', sector: s.sector });
  const events = runUntil(w, (e) => e.type === 'scan.completed', 10);
  const done = events.find((e) => e.type === 'scan.completed');
  assert.ok(done && done.type === 'scan.completed' && done.partial);
});

test('燃料预留：别的出动不能动用预留部分', () => {
  const w = quiet(16);
  const a = w.spawnNow();
  const b = w.spawnNow();
  assert.equal(w.enqueue({ type: 'allocate', signalId: a.id, amount: 90 }).ok, true);
  w.step();
  assert.equal(w.availableFuel(), 10);
  const r = w.preview({ type: 'dispatch', droneId: 'D-1', signalId: b.id, route: 'direct' });
  const need = w.plan(b.id, 'direct')!.fuel;
  assert.equal(r.ok, need <= 10);
  assert.equal(w.preview({ type: 'dispatch', droneId: 'D-1', signalId: a.id, route: 'direct' }).ok, true, '预留给自己的燃料可以用');
});

test('医疗舱：危急成员未收治会死亡；收治后稳定并释放床位', () => {
  const w = quiet(17);
  const s = spawnUntil(w, (hoax, members) => !hoax && members.filter(Boolean).length >= 1 && members.length >= 2);
  w.enqueue({ type: 'dispatch', droneId: 'D-1', signalId: s.id, route: 'direct' });
  runUntil(w, (e) => e.type === 'patient.arrived');
  const p = w.snapshot().patients[0];
  const truth = w.patientMembersTruth(p.id)!;
  const critical = truth.map((c, i) => (c ? i + 1 : 0)).filter(Boolean);
  const first = critical[0];
  w.enqueue({ type: 'bed', patientId: p.id, members: [first] });
  w.step();
  assert.equal(w.snapshot().beds, RULES.bedsTotal - 1);
  const rescuedBefore = w.snapshot().score.rescued;
  const events = runUntil(w, (e) => e.type === 'patient.stable' && e.member === first, RULES.patient.stabilize + 5);
  const lost = events.filter((e) => e.type === 'patient.lost').length;
  assert.equal(lost, critical.length - 1, '其余危急成员在期限后死亡');
  assert.equal(w.snapshot().score.rescued, rescuedBefore - lost);
  assert.equal(w.snapshot().beds, RULES.bedsTotal);
});
