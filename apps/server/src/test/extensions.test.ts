// M6：分类器聚合、地面站崩溃降级。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { StdioTransport } from '@earendil-works/pi-mcp';
import { aggregate, extractAnswers } from '../pi/classifier-glm.ts';
import { TRIAGE_QUESTIONS } from '../pi/triage.ts';
import { Station } from '../runtime/station.ts';
import { offlineConfig, until } from './helpers.ts';

test('分类器：k 次样本的经验分布；score 取众数，confidence 为占比', () => {
  const a = aggregate(TRIAGE_QUESTIONS, [
    { severity: 'critical', urgency: 3, hoax: false },
    { severity: 'critical', urgency: 2, hoax: false },
    { severity: 'serious', urgency: 3, hoax: true },
    { severity: 'critical', urgency: 3, hoax: false },
  ]);
  assert.deepEqual(a.severity, { type: 'choice', choice: 'critical', probabilities: { minor: 0, serious: 0.25, critical: 0.75 }, confidence: 0.75 });
  assert.deepEqual(a.urgency, { type: 'score', score: 3, confidence: 0.75 });
  assert.deepEqual(a.hoax, { type: 'bool', probability: 0.25 });
});

test('分类器：模型没调用工具时退而解析文本里的 JSON', () => {
  const m = { content: [{ type: 'text', text: '结论如下 {"severity":"minor","urgency":0,"hoax":true}' }] } as AssistantMessage;
  assert.deepEqual(extractAnswers(m), { severity: 'minor', urgency: 0, hoax: true });
  assert.equal(extractAnswers({ content: [{ type: 'text', text: '不知道' }] } as AssistantMessage), undefined);
});

test('地面站子进程崩溃：工具从指挥官的工具表移除，频道提示失联（§10）', async () => {
  const station = new Station(offlineConfig(), { clock: false, journal: false, groundStation: true, autoSpawn: false, autoHazards: false });
  station.startFreePlay();
  const notices: string[] = [];
  station.bus.subscribe((m) => m.t === 'app' && m.ev.kind === 'notice' && notices.push(m.ev.text));
  const gs = await station.groundStationReady();
  assert.ok(gs);
  const names = () => station.commander.view().tools.map((t) => t.name);
  assert.ok(names().includes('ship_registry_lookup'));
  process.kill((gs.transport as StdioTransport).pid!, 'SIGKILL');
  await until(() => !names().includes('ship_registry_lookup'), 5000);
  assert.ok(notices.some((t) => t.startsWith('地面站失联')));
  await station.shutdown();
});

test('通讯离线时地面站工具不可用（动态工具）', async () => {
  const station = new Station(offlineConfig(), { clock: false, journal: false, groundStation: true, autoSpawn: false, autoHazards: false });
  station.startFreePlay();
  await station.groundStationReady();
  station.world.damageModule('comms', 'offline');
  assert.ok(!station.commander.view().tools.some((t) => t.name === 'station_manual_search'));
  station.world.repairNow('comms');
  assert.ok(station.commander.view().tools.some((t) => t.name === 'station_manual_search'));
  await station.shutdown();
});
