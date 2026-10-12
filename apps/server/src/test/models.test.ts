import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fauxAssistantMessage, normalizeContext } from '@earendil-works/pi-ai';
import { createModelHub, Semaphore } from '../pi/models.ts';
import { offlineConfig } from './helpers.ts';

test('信号量：并发不超过上限，排队者按顺序获得配额', async () => {
  const sem = new Semaphore(3);
  let peak = 0;
  await Promise.all(
    Array.from({ length: 7 }, async () => {
      const release = await sem.acquire();
      peak = Math.max(peak, sem.inFlight);
      await new Promise((r) => setTimeout(r, 5));
      release();
    }),
  );
  assert.equal(peak, 3);
  assert.equal(sem.inFlight, 0);
});

test('等待配额时被中止 → 返回 aborted 流，而不是抛错', async () => {
  const hub = createModelHub(offlineConfig({ maxConcurrency: 1 }));
  const hold = await hub.semaphore.acquire();
  const ac = new AbortController();
  const streamFn = hub.createStreamFn();
  const pending = streamFn(hub.chat('glm-5.3'), normalizeContext({ messages: [] }), { signal: ac.signal });
  ac.abort();
  const result = await (await pending).result();
  assert.equal(result.stopReason, 'aborted');
  hold();
});

test('glm-5.3 声明为纯文本、glm-5.3-flash 声明支持图片（faux 与真实模型一致）', () => {
  const hub = createModelHub(offlineConfig());
  assert.deepEqual(hub.chat('glm-5.3').input, ['text']);
  assert.deepEqual(hub.chat('glm-5.3-flash').input, ['text', 'image']);
});

test('探针记录排队时间与图片数', async () => {
  const hub = createModelHub(offlineConfig());
  hub.faux.setResponses([fauxAssistantMessage('ok')]);
  let timing: unknown;
  const streamFn = hub.createStreamFn({ begin: (t) => (timing = t), onProviderStreamEvent: () => {}, current: () => undefined });
  const s = await streamFn(
    hub.chat('glm-5.3-flash'),
    normalizeContext({ messages: [{ role: 'user', content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], timestamp: 0 }] }),
  );
  await s.result();
  assert.equal((timing as { images: number }).images, 1);
});
