import assert from 'node:assert/strict';
import { test } from 'node:test';
import { drive, testStation, until } from './helpers.ts';

test('空闲时新信号 → prompt；运行中到达的信号被 followUp 吸收进同一次运行', async () => {
  const station = testStation();
  station.startFreePlay();
  let agentStarts = 0;
  station.bus.subscribe((m) => m.t === 'agent' && m.ev.type === 'agent_start' && agentStarts++);

  station.world.spawnNow(); // 指挥官空闲 → prompt
  assert.equal(station.dispatcher.log.at(-1)?.action, 'prompt');
  await until(() => station.commander.isRunning);

  station.world.spawnNow(); // 指挥官运行中（扫描在等世界 tick）→ followUp
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
