// hook 策略链：审批超时、单步、打码保留 structuredContent、工具试验台走同样的 hook。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerMsg } from '@rescue/protocol';
import { Bus } from '../runtime/bus.ts';
import { ApprovalCenter } from '../pi/hooks/approval.ts';
import { composeAfter } from '../pi/hooks/compose.ts';
import { redact } from '../pi/hooks/after.ts';
import { defaultPolicyFlags } from '@rescue/protocol';
import { testStation, until } from './helpers.ts';

test('审批：超时视为否决；主管决定以先到者为准', async () => {
  const bus = new Bus();
  const center = new ApprovalCenter(bus, 30);
  const r = await center.request('commander', 'tc1', 'vent_section', {}, '风险');
  assert.equal(r.decision, 'timeout');
  const p = center.request('commander', 'tc2', 'vent_section', {}, '风险');
  const id = center.list()[0].approvalId;
  assert.equal(center.decide(id, 'approve'), true);
  assert.equal((await p).decision, 'approve');
  assert.equal(center.decide(id, 'deny'), false, '已处理的审批不能再改');
});

test('打码：改写 content 时连同 structuredContent 一起返回，原文留在 details', async () => {
  const bus = new Bus();
  const env = { agentId: 'commander', bus, flags: defaultPolicyFlags(), runId: () => 'r' } as never;
  const after = composeAfter(env, redact);
  const result = {
    content: [{ type: 'text' as const, text: '船舶登记：曙光号，船长：李明远，联系电话：13800001111' }],
    details: {},
    structuredContent: { name: '曙光号', captain: '李明远', phone: '13800001111' },
  };
  const out = await after({ toolCall: { id: 'x', name: 'ship_registry_lookup' }, result, isError: false } as never);
  assert.ok(out?.content && out.structuredContent);
  const text = (out.content[0] as { text: string }).text;
  assert.ok(!text.includes('李明远') && !text.includes('13800001111'));
  assert.deepEqual(out.structuredContent, { name: '曙光号', captain: '李**', phone: '1******' });
  assert.equal((out.details as { redacted: number }).redacted, 4);
});

test('单步：开启后停在 beforeToolCall，世界暂停；下一步放行', async () => {
  const station = testStation();
  station.startFreePlay();
  const s = station.world.spawnNow();
  const events: ServerMsg[] = [];
  station.bus.subscribe((m) => events.push(m));
  station.setStepping(true);
  assert.equal(station.world.snapshot().speed, 0);
  const pending = station.commander.bench('inspect_signal', { signalId: s.id });
  await until(() => events.some((m) => m.t === 'app' && m.ev.kind === 'step.paused'));
  let done = false;
  void pending.then(() => (done = true));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false, '停住了');
  station.stepper.next();
  const outcome = await pending;
  assert.equal(outcome.isError, false);
  station.setStepping(false);
  assert.equal(station.world.snapshot().speed, 1);
  await station.shutdown();
});

test('工具试验台：runToolCall 经过同样的 hook（过期信号被 staleGuard 拦截）', async () => {
  const station = testStation();
  station.startFreePlay();
  const hooks: unknown[] = [];
  station.bus.subscribe((m) => m.t === 'app' && m.ev.kind === 'hook' && hooks.push(m.ev.decision));
  const outcome = await station.commander.bench('dispatch_drone', { droneId: 'D-1', signalId: 'S-77' });
  assert.equal(outcome.isError, true);
  assert.equal(outcome.durationMs, undefined);
  assert.match(JSON.stringify(outcome.result.content), /S-77 不存在/);
  assert.ok(JSON.stringify(hooks).includes('staleGuard'));
  await station.shutdown();
});
