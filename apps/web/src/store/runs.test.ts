import { describe, expect, it } from 'vitest';
import type { ServerMsg } from '@rescue/protocol';
import { CommsModel } from './comms.ts';
import { RunsModel } from './runs.ts';

let seq = 0;
const agent = (at: number, ev: unknown): ServerMsg => ({ t: 'agent', seq: ++seq, agentId: 'commander', runId: 'r1', at, ev: ev as never });
const app = (at: number, ev: unknown): ServerMsg => ({ t: 'app', seq: ++seq, at, ev: ev as never });

const assistant = (content: unknown[], stopReason = 'toolUse') => ({ role: 'assistant', content, stopReason, usage: {}, timestamp: 0 });

/** 一次两 turn 的运行：思考 → 文本 → 工具调用 → 执行 scan_sector → stand_by */
const script: ServerMsg[] = [
  agent(1000, { type: 'agent_start' }),
  agent(1000, { type: 'turn_start' }),
  agent(1001, { type: 'message_start', message: { role: 'situation', tick: 5, reasons: ['新信号'], brief: { signals: [{}] }, timestamp: 0 } }),
  agent(1100, { type: 'message_start', message: assistant([]) }),
  agent(1500, {
    type: 'message_update_batch',
    deltas: [
      { type: 'thinking_start', contentIndex: 0 },
      { type: 'thinking_delta', contentIndex: 0, delta: '先扫描' },
      { type: 'thinking_end', contentIndex: 0, content: '先扫描' },
    ],
  }),
  agent(1700, {
    type: 'message_update_batch',
    deltas: [
      { type: 'text_start', contentIndex: 1 },
      { type: 'text_delta', contentIndex: 1, delta: '扫描 C 区' },
      { type: 'text_end', contentIndex: 1, content: '扫描 C 区' },
      { type: 'toolcall_start', contentIndex: 2 },
      { type: 'toolcall_end', contentIndex: 2, toolCall: { type: 'toolCall', id: 'tc1', name: 'scan_sector', arguments: { sector: 'C' } } },
    ],
  }),
  agent(1800, {
    type: 'message_end',
    message: assistant([
      { type: 'thinking', thinking: '先扫描' },
      { type: 'text', text: '扫描 C 区。' },
      { type: 'toolCall', id: 'tc1', name: 'scan_sector', arguments: { sector: 'C' } },
    ]),
  }),
  app(1801, {
    kind: 'request.meta', agentId: 'commander', runId: 'r1', startedAt: 1050, queuedMs: 50, ttftMs: 400, ttftSource: 'provider',
    providerEvents: 9, model: 'glm-5.3', thinkingLevel: 'low', durationMs: 750, durationSource: 'pi', stopReason: 'toolUse',
    usage: { input: 900, output: 40, cacheRead: 512, totalTokens: 940, cost: 0.001 },
  }),
  agent(1810, { type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'scan_sector', args: { sector: 'C' } }),
  agent(1900, { type: 'tool_execution_update', toolCallId: 'tc1', toolName: 'scan_sector', args: {}, partialResult: { content: [{ type: 'text', text: '已受理' }] } }),
  agent(5000, {
    type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'scan_sector', isError: false, durationMs: 3190,
    result: { content: [{ type: 'text', text: 'C 区扫描完成' }], structuredContent: { sector: 'C', signals: [] } },
  }),
  app(5010, { kind: 'hook', agentId: 'commander', runId: 'r1', hook: 'finishTurn', decision: { action: 'default' }, durationMs: 0.1 }),
  agent(5020, { type: 'turn_end', message: {}, toolResults: [] }),
  agent(5030, { type: 'turn_start' }),
  app(5040, { kind: 'queue', agentId: 'commander', steer: 1, followUp: 2 }),
  agent(6000, { type: 'agent_end', messages: [assistant([], 'stop')] }),
];

describe('RunsModel', () => {
  it('从事件构建 run → turn → request / tools 结构', () => {
    const m = new RunsModel();
    for (const msg of script) m.apply(msg);
    expect(m.runs).toHaveLength(1);
    const run = m.runs[0];
    expect(run.outcome).toBe('ok');
    expect(run.endedAt).toBe(6000);
    expect(run.queue).toEqual({ steer: 1, followUp: 2 });
    expect(run.turns).toHaveLength(2);
    const [t1, t2] = run.turns;
    expect(t1.request).toMatchObject({ start: 1050, ttftMs: 400, durationMs: 750, end: 1800, queuedMs: 50, thinkingLevel: 'low', model: 'glm-5.3' });
    expect(t1.request!.segments.map((s) => s.kind)).toEqual(['thinking', 'text', 'toolcall']);
    expect(t1.request!.segments.every((s) => s.end !== undefined)).toBe(true);
    expect(t1.tools).toHaveLength(1);
    expect(t1.tools[0]).toMatchObject({ name: 'scan_sector', start: 1810, end: 5000, durationMs: 3190, isError: false });
    expect(t1.tools[0].updates).toHaveLength(1);
    expect(t1.hooks.map((h) => h.hook)).toEqual(['finishTurn']);
    expect(t2.end).toBe(6000);
    expect(m.totalCost).toBeCloseTo(0.001);
  });

  it('未执行就结束的出错工具被标记为拦截', () => {
    const m = new RunsModel();
    m.apply(agent(0, { type: 'agent_start' }));
    m.apply(agent(1, { type: 'turn_start' }));
    m.apply(agent(2, { type: 'tool_execution_start', toolCallId: 'x', toolName: 'dispatch_drone', args: {} }));
    m.apply(agent(3, { type: 'tool_execution_end', toolCallId: 'x', toolName: 'dispatch_drone', isError: true, result: { content: [{ type: 'text', text: '主管否决' }] } }));
    expect(m.runs[0].turns[0].tools[0].blocked).toEqual({ by: 'beforeToolCall', reason: '主管否决' });
  });
});

describe('CommsModel', () => {
  it('流式拼接，message_end 以权威内容覆盖；工具卡片随执行更新', () => {
    const c = new CommsModel();
    for (const msg of script.slice(0, 6)) c.apply(msg);
    const crew = c.entries.find((e) => e.kind === 'crew');
    expect(crew).toMatchObject({ text: '扫描 C 区', thinking: '先扫描', streaming: true });
    const before = c.rev(crew!.id);
    for (const msg of script.slice(6)) c.apply(msg);
    expect(crew).toMatchObject({ text: '扫描 C 区。', streaming: false });
    expect(c.rev(crew!.id)).toBeGreaterThan(before);
    expect(c.entries.map((e) => e.kind)).toEqual(['situation', 'crew', 'tool']);
    expect(c.entries[2]).toMatchObject({ status: 'ok', summary: 'C 区扫描完成' });
  });
});
