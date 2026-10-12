// 课程脚本即回归测试（§11）：第 3–6 课（M2）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerMsg } from '@rescue/protocol';
import { getLesson } from '@rescue/lessons';
import { drive, testStation } from './helpers.ts';

type AgentMsg = Extract<ServerMsg, { t: 'agent' }>;

async function runLesson(id: string) {
  const station = testStation();
  station.startFreePlay();
  const msgs: AgentMsg[] = [];
  station.bus.subscribe((m) => m.t === 'agent' && msgs.push(m));
  const stop = drive(station);
  try {
    await station.loadLesson(id, 'faux');
  } finally {
    stop();
  }
  assert.equal(station.lesson?.status, 'done', `${id} 未完成`);
  const tools = msgs.flatMap((m) => (m.ev.type === 'tool_execution_start' ? [m.ev.toolName] : []));
  assert.deepEqual(tools, getLesson(id)!.expectTools);
  return { station, msgs };
}

function spans(msgs: AgentMsg[]) {
  const out = new Map<string, { name: string; start: number; end: number; seqStart: number; seqEnd: number; ev?: unknown }>();
  for (const m of msgs) {
    if (m.ev.type === 'tool_execution_start') out.set(m.ev.toolCallId, { name: m.ev.toolName, start: m.at, end: Infinity, seqStart: m.seq, seqEnd: Infinity });
    if (m.ev.type === 'tool_execution_end') Object.assign(out.get(m.ev.toolCallId)!, { end: m.at, seqEnd: m.seq, ev: m.ev });
  }
  return [...out.values()];
}

test('第 3 课：非法星区被 TypeBox 拒绝并回传给模型；「c区」被 prepareArguments 归一化', async () => {
  const { station, msgs } = await runLesson('L03');
  const [bad, good] = spans(msgs);
  const badEnd = bad.ev as { isError: boolean; result: { content: Array<{ text: string }> } };
  assert.equal(badEnd.isError, true);
  assert.match(badEnd.result.content[0].text, /sector|校验|Validation|validation/i);
  assert.equal((good.ev as { isError: boolean }).isError, false);
  // stand_by 返回 terminate → 运行在工具批次之后直接结束：一共 3 次请求
  const requests = msgs.filter((m) => m.ev.type === 'message_start' && m.ev.message.role === 'assistant').length;
  assert.equal(requests, 3);
  await station.shutdown();
});

test('第 4 课：三次扫描并行（时间重叠）；混入 dispatch_drone 的批次串行（首尾相接）', async () => {
  const { station, msgs } = await runLesson('L04');
  const s = spans(msgs);
  const scans = s.slice(0, 3);
  // 并行：三个工具都在第一个结束之前开始
  const firstEnd = Math.min(...scans.map((x) => x.seqEnd));
  assert.ok(scans.every((x) => x.seqStart < firstEnd), '第一批扫描没有并行执行');
  const [inspect, dispatch] = s.slice(3, 5);
  assert.ok(inspect.seqEnd < dispatch.seqStart, '混入 sequential 工具的批次没有串行执行');
  assert.equal(station.world.drone('D-1')!.status, 'outbound');
  await station.shutdown();
});

test('第 5 课：工程师修复机库，onUpdate 产生逐秒的 tool_execution_update', async () => {
  const { station, msgs } = await runLesson('L05');
  const updates = msgs.filter((m) => m.agentId === 'engineer' && m.ev.type === 'tool_execution_update' && m.ev.toolName === 'repair_module');
  assert.ok(updates.length >= 8, `只有 ${updates.length} 次进度`);
  assert.equal(station.world.module('hangar').status, 'ok');
  await station.shutdown();
});

test('第 6 课：扫描部分失败 isError，structuredContent 仍可供 UI 渲染', async () => {
  const { station, msgs } = await runLesson('L06');
  const scan = spans(msgs)[0].ev as { isError: boolean; result: { structuredContent: { partial: boolean; signals: string[] } } };
  assert.equal(scan.isError, true);
  assert.equal(scan.result.structuredContent.partial, true);
  // transcript 里的 toolResult 不含 structuredContent（§2.4）
  const tr = station.commander.agent.state.messages.find((m) => m.role === 'toolResult' && m.toolName === 'scan_sector');
  assert.ok(tr && !('structuredContent' in tr));
  await station.shutdown();
});
