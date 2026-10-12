// M4：视图裁剪、图片折叠、压缩分段、书记员压缩。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { estimateTokens, foldImages, trimToBudget } from '../pi/context.ts';
import { compact, pickSegment } from '../pi/compaction.ts';
import { testStation } from './helpers.ts';

const sys = (t: string): AgentMessage => ({ role: 'system', content: t, timestamp: 0 });
const user = (t: string): AgentMessage => ({ role: 'user', content: t, timestamp: 0 });
const asst = (t: string, call?: string): AgentMessage =>
  ({ role: 'assistant', content: [{ type: 'text', text: t }, ...(call ? [{ type: 'toolCall', id: call, name: 'x', arguments: {} }] : [])], api: 'x', provider: 'x', model: 'x', usage: {} as never, stopReason: call ? 'toolUse' : 'stop', timestamp: 0 }) as AgentMessage;
const tool = (id: string, image = false): AgentMessage =>
  ({ role: 'toolResult', toolCallId: id, toolName: 'x', content: [{ type: 'text', text: '结果' }, ...(image ? [{ type: 'image', data: 'AA', mimeType: 'image/png' }] : [])], isError: false, timestamp: 0 }) as AgentMessage;

test('图片折叠：只保留最近 2 张，旧图替换为当时回复的首句结论', () => {
  const msgs = [sys('s'), user('看图'), asst('', 'a'), tool('a', true), asst('第一张是诱饵。细节略'), asst('', 'b'), tool('b', true), asst('ok'), asst('', 'c'), tool('c', true), asst('ok')];
  const out = foldImages(msgs);
  const images = out.flatMap((m) => (m.role === 'toolResult' ? m.content.filter((c) => c.type === 'image') : []));
  assert.equal(images.length, 2);
  const folded = out[3] as Extract<AgentMessage, { role: 'toolResult' }>;
  assert.deepEqual(folded.content[1], { type: 'text', text: '[图像已折叠：第一张是诱饵]' });
  assert.notEqual(out, msgs, '返回新数组');
  assert.equal((msgs[3] as Extract<AgentMessage, { role: 'toolResult' }>).content[1].type, 'image', '原始消息未被修改');
});

test('预算裁剪：永远保留全部 system 消息；保留部分不以 toolResult 开头', () => {
  const long = '很长的内容'.repeat(60);
  const msgs = [sys('提示词'), user(long), asst(long, 'a'), tool('a'), sys('补丁'), user(long), asst('ok', 'b'), tool('b'), user('最新')];
  const { messages, dropped } = trimToBudget(msgs, 400);
  assert.ok(dropped > 0);
  assert.equal(messages.filter((m) => m.role === 'system').length, 2);
  const firstBody = messages.find((m) => m.role !== 'system' && !(m.role === 'world_event'));
  assert.ok(firstBody && firstBody.role !== 'toolResult' && firstBody.role !== 'assistant');
  assert.ok(estimateTokens(messages) <= 400 + 60);
  assert.ok(messages.some((m) => m.role === 'world_event' && m.text.includes('视图裁剪')));
});

test('压缩分段：结束在完整边界上（不把调用和结果拆开）', () => {
  const msgs = [sys('s'), user('1'), asst('', 'a'), tool('a'), user('2'), asst('', 'b'), tool('b'), user('3'), asst('ok'), user('4'), asst('ok')];
  const seg = pickSegment(msgs, 4)!;
  assert.equal(seg.start, 1);
  const kept = msgs.slice(seg.end + 1).filter((m) => m.role !== 'system');
  assert.equal(kept[0].role, 'user');
});

test('书记员压缩：用摘要替换最老的一段，发出 compaction 事件；ui_note 不进入模型上下文', async () => {
  const station = testStation();
  station.startFreePlay();
  const m = station.commander;
  const filler: AgentMessage[] = [];
  for (let i = 0; i < 10; i++) filler.push(user(`信号 S-0${i} 研判：应答码有轻微误码`), asst(`S-0${i} 判定为真实遇险`));
  m.agent.state.messages = [...m.agent.state.messages, ...filler];
  const events: unknown[] = [];
  station.bus.subscribe((x) => x.t === 'app' && x.ev.kind === 'compaction' && events.push(x.ev));
  const ok = await compact(m, { hub: station.hub, bus: station.bus, enabled: () => true, budget: () => 50 });
  assert.equal(ok, true);
  const msgs = m.agent.state.messages;
  const c = msgs.find((x) => x.role === 'compaction');
  assert.ok(c && c.role === 'compaction' && c.summary.includes('S-0'));
  assert.ok(msgs.length < filler.length);
  assert.equal(events.length, 1);
  const view = await m.contextView();
  assert.ok(!JSON.stringify(view.llmMessages).includes('书记员把'), 'ui_note 被 convertToLlm 过滤');
  assert.ok(JSON.stringify(view.llmMessages).includes('【此前经过摘要】'));
  await station.shutdown();
});

test('压缩只在空闲且队列为空时进行（§14）', async () => {
  const station = testStation();
  station.startFreePlay();
  const m = station.commander;
  m.agent.followUp(user('排队中'));
  assert.equal(await compact(m, { hub: station.hub, bus: station.bus, enabled: () => true, budget: () => 1 }, true), false);
  await station.shutdown();
});
