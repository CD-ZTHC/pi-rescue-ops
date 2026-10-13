// M7：录制回放与会话恢复。
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ServerMsg } from '@rescue/protocol';
import { Station } from '../runtime/station.ts';
import { loadRecording } from '../runtime/replayer.ts';
import { offlineConfig, until } from './helpers.ts';

/** 每 tick 等船员把手头的事做完再推进（与离线自由模式的集成测试相同） */
async function play(station: Station, ticks: number) {
  for (let i = 0; i < ticks; i++) {
    station.world.step();
    await new Promise((r) => setTimeout(r, 1)); // 让异步的分诊等有机会完成
    for (let k = 0; k < 60 && station.crew().some((c) => c.isRunning); k++) await new Promise((r) => setTimeout(r, 2));
  }
  await Promise.all(station.crew().map((c) => c.agent.waitForIdle()));
}

async function recordShift(dir: string, ticks = 260) {
  const station = new Station(offlineConfig({ seed: 777, missionsDir: dir }), { clock: false, journal: true, recordDir: dir });
  station.startFreePlay();
  station.setPolicy('autoApprove', true);
  await play(station, ticks);
  await station.shutdown();
  const files = await readdir(dir);
  return { station, recording: join(dir, files.find((f) => f.endsWith('.local.jsonl'))!), journal: join(dir, files.find((f) => f.startsWith('mission-') && !f.includes('.local'))!) };
}

test('录制 → 回放：同 seed 世界 + 录制的回复与主管操作，工具调用序列逐一吻合', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rescue-rec-'));
  const { station: original, recording } = await recordShift(dir);
  const rec = await loadRecording(recording);
  assert.ok(rec.header.seed === 777);
  const tools = [...rec.tools.values()].flat();
  assert.ok(tools.length > 5, `录到 ${tools.length} 次工具调用`);
  assert.ok(rec.triage.size > 0, '分诊结论也被录下');

  const replay = new Station(offlineConfig({ seed: 1 }), { clock: false, journal: false });
  const events: Array<Extract<ServerMsg, { t: 'app' }>['ev']> = [];
  replay.bus.subscribe((m) => m.t === 'app' && (m.ev.kind === 'replay' || m.ev.kind === 'notice') && events.push(m.ev));
  replay.startFreePlay();
  const cursor = await replay.startReplay(recording);
  await play(replay, 260);
  assert.equal(cursor.divergence, undefined, JSON.stringify(cursor.divergence));
  assert.equal(cursor.matched, cursor.total);
  assert.equal(replay.world.snapshot().score.total, original.world.snapshot().score.total, '结算一致');
  await until(() => events.some((e) => e.kind === 'replay' && e.status === 'done'), 3000);
  await replay.shutdown();
});

test('回放检出分歧：篡改录制的一次工具调用，报告首个分歧点', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rescue-rec-'));
  const { recording } = await recordShift(dir, 120);
  const { readFile, writeFile } = await import('node:fs/promises');
  const lines = (await readFile(recording, 'utf8')).split('\n');
  const i = lines.findIndex((l) => l.includes('"type":"tool"') && l.includes('"agentId":"commander"'));
  lines[i] = lines[i].replace(/"name":"[a-z_]+"/, '"name":"end_watch"');
  await writeFile(recording, lines.join('\n'));
  const replay = new Station(offlineConfig(), { clock: false, journal: false });
  replay.startFreePlay();
  const cursor = await replay.startReplay(recording);
  await play(replay, 120);
  assert.deepEqual({ agentId: cursor.divergence?.agentId, index: cursor.divergence?.index, expected: cursor.divergence?.expected }, { agentId: 'commander', index: 0, expected: 'end_watch' });
  await replay.shutdown();
});

test('会话恢复：按日志里的 seed 与命令序列重放世界，重建各船员的消息', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rescue-rec-'));
  const { station: original, journal } = await recordShift(dir, 200);
  const before = original.world.snapshot();
  const restored = new Station(offlineConfig(), { clock: false, journal: false });
  restored.startFreePlay();
  await restored.restoreSession(journal);
  const after = restored.world.snapshot();
  assert.equal(after.tick, before.tick);
  assert.deepEqual(after.score, before.score);
  assert.deepEqual(after.drones.map((d) => d.status), before.drones.map((d) => d.status));
  const count = (s: Station) => s.commander.agent.state.messages.filter((m) => m.role === 'assistant').length;
  assert.equal(count(restored), count(original));
  await restored.shutdown();
});
