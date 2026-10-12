import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerMsg } from '@rescue/protocol';
import { getLesson } from '@rescue/lessons';
import { drive, testStation } from './helpers.ts';

function agentTrace(msgs: ServerMsg[]): string[] {
  const out: string[] = [];
  for (const m of msgs) {
    if (m.t !== 'agent') continue;
    const ev = m.ev;
    let label: string = ev.type;
    if (ev.type === 'message_start' || ev.type === 'message_end') label += `:${ev.message.role}`;
    if (ev.type.startsWith('tool_execution') && 'toolName' in ev) label += `:${ev.toolName}`;
    if (out[out.length - 1] !== label) out.push(label); // 合并连续的 message_update_batch
  }
  return out;
}

test('第 1 课（faux）：完整事件序列', async () => {
  const station = testStation();
  station.startFreePlay();
  const msgs: ServerMsg[] = [];
  station.bus.subscribe((m) => msgs.push(m));
  const stop = drive(station);
  await station.loadLesson('L01', 'faux');
  stop();
  assert.equal(station.lesson?.status, 'done');
  assert.deepEqual(agentTrace(msgs), [
    'agent_start',
    'turn_start',
    // 本课关闭了委派：指挥官的工具表变了（+scan_sector −delegate），pi 在请求前写入一条工具差异 system 消息
    'message_start:system',
    'message_end:system',
    'message_start:situation',
    'message_end:situation',
    'message_start:assistant',
    'message_update_batch',
    'message_end:assistant',
    'tool_execution_start:scan_sector',
    'tool_execution_update:scan_sector',
    'tool_execution_end:scan_sector',
    'message_start:toolResult',
    'message_end:toolResult',
    'turn_end',
    'turn_start',
    'message_start:assistant',
    'message_update_batch',
    'message_end:assistant',
    'tool_execution_start:stand_by',
    'tool_execution_end:stand_by',
    'message_start:toolResult',
    'message_end:toolResult',
    'turn_end',
    'agent_end',
  ]);
  const tools = msgs.flatMap((m) => (m.t === 'agent' && m.ev.type === 'tool_execution_start' ? [m.ev.toolName] : []));
  assert.deepEqual(tools, getLesson('L01')!.expectTools);
  // structuredContent 只能从 tool_execution_end 事件获取（§2.4）
  const scanEnd = msgs.find((m) => m.t === 'agent' && m.ev.type === 'tool_execution_end' && m.ev.toolName === 'scan_sector');
  assert.ok(scanEnd && scanEnd.t === 'agent' && scanEnd.ev.type === 'tool_execution_end');
  assert.equal((scanEnd.ev.result.structuredContent as { signals: unknown[] }).signals.length, 1);
  // 每次请求都有一条 request.meta，带耗时与思考档位
  const metas = msgs.flatMap((m) => (m.t === 'app' && m.ev.kind === 'request.meta' ? [m.ev] : []));
  assert.equal(metas.length, 2);
  for (const meta of metas) {
    assert.equal(meta.thinkingLevel, 'low');
    assert.equal(typeof meta.durationMs, 'number');
    assert.ok(meta.durationSource === 'pi' || meta.durationSource === 'wall');
    assert.equal(meta.ttftSource, 'delta');
  }
  await station.shutdown();
});

test('第 2 课（faux）：思考档位 off / low / medium 逐级变化', async () => {
  const station = testStation();
  station.startFreePlay();
  const stop = drive(station);
  await station.loadLesson('L02', 'faux');
  stop();
  assert.equal(station.lesson?.status, 'done');
  const answers = station.commander.agent.state.messages.filter((m) => m.role === 'assistant');
  assert.deepEqual(answers.map((m) => m.thinkingLevel), ['off', 'low', 'medium']);
  assert.deepEqual(
    answers.map((m) => m.content.filter((c) => c.type === 'thinking').length),
    [0, 1, 3],
  );
  await station.shutdown();
});

test('请求失败时 prompt() 正常 resolve，错误体现在 stopReason（§2.4）', async () => {
  const station = testStation();
  station.startFreePlay();
  station.hub.setOfflineBrain(undefined); // faux 队列为空 → 返回 error 消息
  const notices: string[] = [];
  station.bus.subscribe((m) => m.t === 'app' && m.ev.kind === 'notice' && notices.push(m.ev.text));
  const last = await station.commander.run({ role: 'user', content: 'hi', timestamp: Date.now() });
  assert.equal(last?.stopReason, 'error');
  assert.ok(notices.some((t) => t.includes('失联')));
  assert.equal(station.commander.view().status, 'error');
  await station.shutdown();
});
