import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drive, testStation, until } from './helpers.ts';

test('空闲时新信号 → prompt；运行中到达的信号被 followUp 吸收进同一次运行', async () => {
  const station = testStation();
  station.startFreePlay();
  let agentStarts = 0;
  station.bus.subscribe((m) => m.t === 'agent' && m.agentId === 'commander' && m.ev.type === 'agent_start' && agentStarts++);

  station.world.spawnNow(); // 指挥官空闲 → prompt
  assert.equal(station.dispatcher.log.at(-1)?.action, 'prompt');
  await until(() => station.commander.isRunning);

  station.world.spawnNow(); // 指挥官运行中 → followUp
  assert.equal(station.dispatcher.log.at(-1)?.action, 'followUp');

  const stop = drive(station);
  await until(() => !station.commander.isRunning, 10_000);
  stop();
  await station.commander.agent.waitForIdle();

  assert.equal(agentStarts, 1, '第二条态势没有触发新的运行');
  const situations = station.commander.agent.state.messages.filter((m) => m.role === 'situation');
  assert.equal(situations.length, 2);
  await station.shutdown();
});

test('信号失联只追加到上下文，不唤醒指挥官', async () => {
  const station = testStation();
  station.startFreePlay();
  const before = station.commander.agent.state.messages.length;
  station.dispatcher.handle({ type: 'signal.lost', tick: 1, signalId: 'S-09', reason: 'expired' });
  assert.equal(station.commander.isRunning, false);
  assert.equal(station.commander.agent.state.messages.length, before + 1);
  await station.shutdown();
});

test('离线自由模式：四名船员协同跑完半个班次（救援、值班维修、伤员收治），没有错误', async () => {
  const { Station } = await import('../runtime/station.ts');
  const { offlineConfig } = await import('./helpers.ts');
  const station = new Station(offlineConfig({ seed: 4242 }), { clock: false, journal: false });
  station.startFreePlay();
  const errors: string[] = [];
  const tools = new Map<string, number>();
  station.bus.subscribe((m) => {
    if (m.t === 'app' && m.ev.kind === 'notice' && m.ev.level === 'error') errors.push(m.ev.text);
    if (m.t === 'agent' && m.ev.type === 'tool_execution_start') tools.set(`${m.agentId}:${m.ev.toolName}`, (tools.get(`${m.agentId}:${m.ev.toolName}`) ?? 0) + 1);
  });
  // 每 tick 等船员把手头的事做完再推进，模拟「模型够快」的情况
  for (let i = 0; i < 360; i++) {
    station.world.step();
    for (let k = 0; k < 50 && station.crew().some((c) => c.isRunning); k++) await new Promise((r) => setTimeout(r, 2));
  }
  await Promise.all(station.crew().map((c) => c.agent.waitForIdle()));
  const snap = station.world.snapshot();
  assert.deepEqual(errors, []);
  assert.ok((tools.get('commander:inspect_signal') ?? 0) > 0);
  assert.ok((tools.get('commander:dispatch_drone') ?? 0) > 0);
  assert.ok(snap.score.rescued > 0, '应当救回一些人');
  assert.ok(snap.flares.length > 0 || station.dispatcher.log.some((r) => r.event === 'flare.warning'));
  await station.shutdown();
});
