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
  // 15ms 一个 tick：课程自动驾驶的审批要等 1.5 秒（约 100 tick），信号不能在这期间过期
  const stop = drive(station, 15);
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

test('第 7 课：dangerApproval 等待主管决定；否决 → 拦截回传给模型；批准 → 出动', async () => {
  const { station, msgs } = await runLesson('L07');
  const [first, , second] = spans(msgs);
  const firstEnd = first.ev as { isError: boolean; durationMs?: number; result: { content: Array<{ text: string }> } };
  assert.equal(firstEnd.isError, true);
  assert.equal(firstEnd.durationMs, undefined, '被拦截的工具没有执行');
  assert.match(firstEnd.result.content[0].text, /主管否决/);
  assert.equal((second.ev as { isError: boolean }).isError, false);
  assert.equal(station.world.drone('D-1')!.status, 'outbound');
  await station.shutdown();
});

test('第 9 课：只说话不行动 → finishTurn 返回 continue，并在下一轮前追加提醒', async () => {
  const { station, msgs } = await runLesson('L09');
  const requests = msgs.filter((m) => m.ev.type === 'message_start' && m.ev.message.role === 'assistant').length;
  assert.equal(requests, 2);
  const nudge = station.commander.agent.state.messages.find((m) => m.role === 'world_event' && m.kind === 'nudge');
  assert.ok(nudge, '提醒消息写入了上下文');
  await station.shutdown();
});

test('第 9 课（关掉修正轮）：运行在第一句话之后就结束', async () => {
  const station = testStation();
  station.startFreePlay();
  station.setPolicy('nudge', false);
  let requests = 0;
  station.bus.subscribe((m) => m.t === 'agent' && m.ev.type === 'message_start' && m.ev.message.role === 'assistant' && requests++);
  await station.loadLesson('L09', 'faux');
  assert.equal(requests, 1);
  await station.shutdown();
});

test('第 10 课：prepareRequest 刷新态势（看到排队期间出现的信号）并升到危机档位', async () => {
  const station = testStation();
  station.startFreePlay();
  const metas: Array<{ thinkingLevel?: string }> = [];
  const hooks: unknown[] = [];
  station.bus.subscribe((m) => {
    if (m.t === 'app' && m.ev.kind === 'request.meta') metas.push(m.ev);
    if (m.t === 'app' && m.ev.kind === 'hook' && m.ev.hook === 'prepareRequest') hooks.push(m.ev.decision);
  });
  const stop = drive(station);
  await station.loadLesson('L10', 'faux');
  stop();
  const total = station.world.snapshot().signals.length;
  const reply = station.commander.agent.state.messages.filter((m) => m.role === 'assistant').at(-1)!;
  const text = reply.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  assert.match(text, new RegExp(`看到 ${total} 个活跃信号`));
  assert.equal(metas[0].thinkingLevel, 'medium');
  assert.ok(JSON.stringify(hooks[0]).includes('refreshed'));
  await station.shutdown();
});

test('第 11 课：steer 在工具批次之后注入，followUp 在运行将要结束时注入并开启新一轮', async () => {
  const { station } = await runLesson('L11');
  const roles = station.commander.agent.state.messages
    .filter((m) => m.role !== 'system')
    .map((m) => (m.role === 'operator' ? `operator:${m.urgency}` : m.role === 'toolResult' ? `tool:${m.toolName}` : m.role));
  const steer = roles.indexOf('operator:steer');
  const follow = roles.indexOf('operator:followUp');
  assert.ok(roles[steer - 1] === 'tool:scan_sector', `steer 应紧跟扫描结果：${roles.join(' → ')}`);
  assert.ok(roles.lastIndexOf('tool:stand_by', follow) < follow && roles[follow - 1] === 'tool:stand_by', `followUp 应在第一次 stand_by 之后：${roles.join(' → ')}`);
  await station.shutdown();
});

const lastText = (station: Awaited<ReturnType<typeof runLesson>>['station']) =>
  station.commander.agent.state.messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.content)
    .map((c) => (c.type === 'text' ? c.text : c.type === 'thinking' ? c.thinking : ''))
    .join('|');

test('第 12 课：自定义消息转成带前缀的 user 文本；ui_note 被过滤', async () => {
  const { station } = await runLesson('L12');
  const said = lastText(station);
  assert.match(said, /收到 3 条消息：无线电、站务、态势/);
  assert.match(said, /没有看到旁白/);
  await station.shutdown();
});

test('第 13 课：机库受损时工具表里没有 dispatch_drone，提示词显示受损；修复后两者都恢复', async () => {
  const { station } = await runLesson('L13');
  const said = lastText(station);
  assert.match(said, /机库受损；可用工具 \d+ 个，没有 dispatch_drone/);
  assert.match(said, /机库正常，dispatch_drone 回到了工具表/);
  const sys = station.commander.agent.state.messages.filter((m) => m.role === 'system');
  assert.ok(sys.some((m) => m.sections?.station_status), '写入了 sections 补丁');
  assert.ok(sys.some((m) => m.toolsRemoved?.some((t) => t.name === 'dispatch_drone')), 'pi 写入了工具差异');
  await station.shutdown();
});

test('第 14 课：长班次触发书记员压缩，之后的请求能看到摘要', async () => {
  const station = testStation();
  station.startFreePlay();
  const compactions: unknown[] = [];
  station.bus.subscribe((m) => m.t === 'app' && m.ev.kind === 'compaction' && compactions.push(m.ev));
  const stop = drive(station, 15);
  await station.loadLesson('L14', 'faux');
  stop();
  assert.equal(station.lesson?.status, 'done');
  assert.ok(compactions.length >= 1, '至少压缩一次');
  assert.match(lastText(station), /我看到了书记员的摘要/);
  assert.equal(station.contextBudget, 24_000, '课程结束后恢复预算');
  await station.shutdown();
});
