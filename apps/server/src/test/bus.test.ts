import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import WebSocket from 'ws';
import type { ServerMsg } from '@rescue/protocol';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { Bus } from '../runtime/bus.ts';
import { attachWebSocket } from '../runtime/ws.ts';
import { testStation, until } from './helpers.ts';

const update = (delta: string) =>
  ({ type: 'message_update', message: {} as never, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta, partial: {} as never } }) as AgentEvent;

test('seq 单调递增；message_update 合批，且在同一 Agent 的下一个事件前冲刷', () => {
  const bus = new Bus({ batchMs: 10_000 });
  const got: ServerMsg[] = [];
  bus.subscribe((m) => got.push(m));
  bus.agent('commander', 'r1', { type: 'turn_start' });
  bus.agent('commander', 'r1', update('你'));
  bus.agent('commander', 'r1', update('好'));
  bus.app({ kind: 'notice', level: 'info', text: '另一类消息不影响合批' });
  bus.agent('commander', 'r1', { type: 'turn_end', message: {} as never, toolResults: [] });
  assert.deepEqual(got.map((m) => m.seq), [1, 2, 3, 4]);
  const batch = got[2];
  assert.ok(batch.t === 'agent' && batch.ev.type === 'message_update_batch');
  assert.deepEqual(batch.ev.deltas, [
    { type: 'text_delta', contentIndex: 0, delta: '你' },
    { type: 'text_delta', contentIndex: 0, delta: '好' },
  ]);
  assert.ok(got[3].t === 'agent' && got[3].ev.type === 'turn_end');
});

test('since：返回缺失的消息；被挤出缓冲时返回 undefined', () => {
  const bus = new Bus({ capacity: 5 });
  for (let i = 0; i < 8; i++) bus.app({ kind: 'notice', level: 'info', text: String(i) });
  assert.deepEqual(bus.since(6)?.map((m) => m.seq), [7, 8]);
  assert.deepEqual(bus.since(8), []);
  assert.equal(bus.since(1), undefined);
});

test('WebSocket：断线后用 ?since 重连，补发无缺失、无重复', async () => {
  const station = testStation();
  station.startFreePlay();
  const server: Server = createServer();
  attachWebSocket(server, station);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;

  const seen: number[] = [];
  const connect = (since?: number) =>
    new Promise<WebSocket>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${since ? `?since=${since}` : ''}`);
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString()) as ServerMsg;
        if (m.t !== 'hello') seen.push(m.seq);
        else seen.push(m.seq);
      });
      ws.on('open', () => resolve(ws));
    });

  const first = await connect();
  await until(() => seen.length > 0);
  for (let i = 0; i < 5; i++) station.world.step();
  await until(() => seen.at(-1) === station.bus.lastSeq);
  first.close();
  await new Promise((r) => setTimeout(r, 20));

  const lastSeen = seen.at(-1)!;
  for (let i = 0; i < 20; i++) station.world.step(); // 断线期间产生的消息
  const second = await connect(lastSeen);
  await until(() => seen.at(-1) === station.bus.lastSeq);
  second.close();

  const expected = Array.from({ length: station.bus.lastSeq - seen[0] + 1 }, (_, i) => seen[0] + i);
  assert.deepEqual(seen, expected);
  await new Promise<void>((r) => server.close(() => r()));
  await station.shutdown();
});
