// M2 工具：outputSchema 一致、参数归一化、视觉工具不泄露真相、onUpdate 进度、isError 部分结果。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { Value } from 'typebox/value';
import { CAMERA_CELLS } from '@rescue/protocol';
import { World } from '../world/sim.ts';
import { commanderTools } from '../pi/tools/commander.ts';
import { engineerTools } from '../pi/tools/engineer.ts';
import { medicTools } from '../pi/tools/medic.ts';
import { navigatorTools } from '../pi/tools/navigator.ts';
import { reportBackTool } from '../pi/tools/report.ts';
import { terminateOnCommit } from '../pi/hooks/after.ts';
import { normalizeCell, normalizeDrone, normalizeModule, normalizeSector, normalizeSignal } from '../pi/tools/shared.ts';

function setup(seed = 21) {
  const world = new World({ seed, autoSpawn: false, autoHazards: false });
  const deps = { world };
  const all = [...commanderTools(deps), ...navigatorTools(deps), ...engineerTools(deps), ...medicTools(deps), reportBackTool()];
  const tool = (name: string) => all.find((t) => t.name === name)! as AgentTool<any>;
  /** 执行工具，同时以 2ms 一个 tick 推进世界，直到工具结束 */
  const run = async (name: string, args: unknown, updates: unknown[] = []): Promise<AgentToolResult<any>> => {
    const t = tool(name);
    const params = t.prepareArguments ? t.prepareArguments(args) : args;
    assert.ok(Value.Check(t.parameters, params), `${name} 参数不符合 schema：${JSON.stringify(params)}`);
    const timer = setInterval(() => world.step(), 2);
    try {
      const result = await t.execute(`tc-${name}-${Math.random()}`, params as never, undefined, (u) => updates.push(u));
      if (!result.isError && t.outputSchema) {
        assert.ok(Value.Check(t.outputSchema, result.structuredContent), `${name} 的 structuredContent 不符合 outputSchema：${JSON.stringify(result.structuredContent)}`);
      }
      return result;
    } finally {
      clearInterval(timer);
    }
  };
  return { world, tool, run, all };
}

const textOf = (r: AgentToolResult<any>) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

test('参数归一化（prepareArguments）', () => {
  assert.equal(normalizeSector('c区'), 'C');
  assert.equal(normalizeSector('Ｂ'), 'B');
  assert.equal(normalizeSector('G区'), 'G区', '无法识别时原样返回，交给 TypeBox 报错');
  assert.equal(normalizeSignal('s3'), 'S-03');
  assert.equal(normalizeSignal('S-12'), 'S-12');
  assert.equal(normalizeDrone('d2'), 'D-2');
  assert.equal(normalizeModule('机库'), 'hangar');
  assert.equal(normalizeModule('Sensors'), 'sensors');
  assert.equal(normalizeCell('c-2'), 'C2');
});

test('每个工具都声明了执行模式；提交型与危险工具为 sequential', () => {
  const { all } = setup();
  for (const t of all) assert.ok(t.executionMode, `${t.name} 未声明 executionMode`);
  for (const name of ['dispatch_drone', 'allocate_fuel', 'end_watch', 'stand_by', 'repair_module', 'vent_section', 'prepare_medbay', 'report_back']) {
    assert.equal(all.find((t) => t.name === name)!.executionMode, 'sequential', name);
  }
});

test('scan_sector：onUpdate 逐秒进度；返回文字 + 雷达图；structuredContent 不含真相', async () => {
  const { world, run } = setup();
  const s = world.spawnNow();
  const updates: unknown[] = [];
  const r = await run('scan_sector', { sector: s.sector.toLowerCase() }, updates);
  assert.equal(r.isError, undefined);
  assert.ok(updates.length >= 3, `进度更新只有 ${updates.length} 次`);
  assert.deepEqual(r.content.map((c) => c.type), ['text', 'image']);
  assert.ok(!/诱饵|恶作剧|真实|热斑/.test(textOf(r)));
  assert.ok(!/hoax|severity|drift/.test(JSON.stringify(r.structuredContent)));
  assert.deepEqual((r.structuredContent as { signals: string[] }).signals, [s.id]);
});

test('scan_sector：传感器受损 → isError，但 structuredContent 保留部分结果', async () => {
  const { world, run } = setup(22);
  const s = world.spawnNow();
  world.damageModule('sensors', 'damaged');
  const r = await run('scan_sector', { sector: s.sector });
  assert.equal(r.isError, true);
  assert.equal((r.structuredContent as { partial: boolean }).partial, true);
  assert.ok(r.content.some((c) => c.type === 'image'), '部分结果仍然附图');
});

test('参数校验失败与业务失败的区别：业务失败返回 isError 而不是抛错', async () => {
  const { run } = setup();
  const r = await run('dispatch_drone', { droneId: 'D-1', signalId: 'S-99' });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /不存在信号 S-99/);
});

test('dispatch_drone 回执的数字来自世界（出发后才返回）；plot_course 给出两条航线', async () => {
  const { world, run } = setup(23);
  const s = world.spawnNow();
  const course = await run('plot_course', { signalId: s.id });
  const routes = (course.structuredContent as { routes: Array<{ kind: string; fuel: number }> }).routes;
  assert.deepEqual(routes.map((r) => r.kind), ['direct', 'safe']);
  const r = await run('dispatch_drone', { droneId: 'd1', signalId: s.id });
  const receipt = r.structuredContent as { fuel: number; departTick: number };
  assert.equal(receipt.fuel, routes[0].fuel);
  assert.equal(world.drone('D-1')!.status, 'outbound');
  assert.equal(world.snapshot().fuel, 100 - receipt.fuel);
});

test('compare_frames：信号太新时失败；30 秒后返回两张图', async () => {
  const { world, run } = setup(24);
  const s = world.spawnNow();
  assert.equal((await run('compare_frames', { signalId: s.id })).isError, true);
  for (let i = 0; i < 31; i++) world.step();
  const r = await run('compare_frames', { signalId: s.id });
  assert.equal(r.content.filter((c) => c.type === 'image').length, 2);
});

test('工程师：诊断只有读数；监控画面不在文字里泄露火点网格；排空 + 修复流程', async () => {
  const { world, run } = setup(25);
  world.damageModule('hangar', 'damaged', { kind: 'fire', cell: 'B3' });
  const d = await run('diagnose_module', { module: '机库' });
  assert.match(textOf(d), /高温告警/);
  const cam = await run('inspect_camera', { module: 'hangar' });
  assert.ok(!textOf(cam).includes('B3') && !JSON.stringify(cam.structuredContent).includes('B3'));
  assert.equal((await run('repair_module', { module: 'hangar' })).isError, true, '起火时不能直接修复');
  const wrong = await run('vent_section', { module: 'hangar', cell: 'a1' });
  assert.equal(wrong.isError, true);
  assert.equal((await run('vent_section', { module: 'hangar', cell: 'B3' })).isError, undefined);
  const updates: unknown[] = [];
  const rep = await run('repair_module', { module: 'hangar' }, updates);
  assert.equal(rep.isError, undefined);
  assert.ok(updates.length >= 5);
  assert.equal(world.module('hangar').status, 'ok');
});

test('医疗官：分级 → 体征图 → 收治；床位不足时拒绝', async () => {
  const { world, run } = setup(26);
  let s = world.spawnNow();
  while (world.truthOf(s.id)!.hoax || world.truthOf(s.id)!.members.length < 2) s = world.spawnNow();
  world.enqueue({ type: 'dispatch', droneId: 'D-1', signalId: s.id, route: 'direct' });
  while (!world.snapshot().patients.length) world.step();
  const p = world.snapshot().patients[0];
  const a = await run('assess_survivors', {});
  assert.match(textOf(a), new RegExp(`${p.id}`));
  const v = await run('read_vitals', { patientId: p.id.toLowerCase() });
  assert.ok(v.content.some((c) => c.type === 'image'));
  assert.ok(!/critical|危急/.test(JSON.stringify(v.structuredContent)));
  const bed = await run('prepare_medbay', { patientId: p.id, members: [1] });
  assert.equal(bed.isError, undefined);
  assert.equal((bed.structuredContent as { bedsLeft: number }).bedsLeft, 3);
  world.damageModule('medbay', 'damaged');
  assert.equal((await run('prepare_medbay', { patientId: p.id, members: [2] })).isError, true);
});

test('提交型工具自身不带 terminate：由 afterToolCall 的 terminateOnCommit 统一补上', async () => {
  const { run } = setup();
  for (const [name, args] of [['stand_by', { reason: 'x' }], ['report_back', { summary: 'ok' }], ['end_watch', { report: '交班' }]] as const) {
    const r = await run(name, args);
    assert.equal(r.terminate, undefined);
    const after = await terminateOnCommit.run({ toolCall: { name }, isError: false } as never, {} as never);
    assert.deepEqual(after, { terminate: true });
  }
});

test('监控网格覆盖 12 格', () => {
  assert.equal(CAMERA_CELLS.length, 12);
});
