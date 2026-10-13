// 真实模型冒烟（§11，手动执行，不进入 CI）：npm run smoke:live
// M1 验收（§13.1 #4）：两个模型各完成一次工具调用；flash 识别一张工具返回的图片；信号量下 6 个并发请求无 429。
// 另外验证 §14 的待验证项：zaiToolStream、flash 的 thinking: disabled。
import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model, Api } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { loadConfig } from '../config.ts';
import { convertToLlm } from '../pi/messages.ts';
import { createModelHub, type ModelHub } from '../pi/models.ts';
import { Raster } from '../world/render/raster.ts';
import { Station } from '../runtime/station.ts';
import { worldEventMessage } from '../pi/messages.ts';

const config = loadConfig();
if (config.mode !== 'live') {
  console.error('需要 GLM_API_KEY（或 STRATEGIC_API_KEY）');
  process.exit(1);
}
const hub = createModelHub(config);
const only = process.argv.slice(2);
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  if (only.length && !only.some((o) => name.includes(o))) return;
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: `${detail}（${((Date.now() - t0) / 1000).toFixed(1)}s）` });
  } catch (err) {
    results.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
  }
  const r = results[results.length - 1];
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}：${r.detail}`);
}

const text = (t: string) => ({ type: 'text' as const, text: t });

function makeAgent(model: Model<Api>, tools: AgentTool<any>[], thinkingLevel: 'off' | 'low' = 'off', h: ModelHub = hub): Agent {
  return new Agent({
    initialState: { systemPrompt: '你是测试助手，用简体中文简短回答。需要时调用工具。', model, thinkingLevel, tools },
    streamFn: h.createStreamFn(),
    convertToLlm,
  });
}

function lastAssistant(agent: Agent): AssistantMessage {
  const m = [...agent.state.messages].reverse().find((x) => x.role === 'assistant');
  if (!m || m.role !== 'assistant') throw new Error('没有 assistant 消息');
  if (m.stopReason === 'error') throw new Error(`请求失败：${m.errorMessage}`);
  return m;
}

const echoTool: AgentTool<any> = {
  name: 'lookup_sector',
  label: '查询星区',
  description: '查询一个星区（A–F）的信号数量',
  parameters: Type.Object({ sector: Type.String() }),
  async execute(_id, params) {
    const { sector } = params as { sector: string };
    return { content: [text(`${sector} 区当前有 2 个信号`)], details: {} };
  },
};

function anomalyImage(): string {
  const r = new Raster(320, 240);
  r.circle(240, 170, 14, [255, 140, 40]); // 75% 宽、71% 高
  r.circle(240, 170, 26, [255, 140, 40], 0.25);
  return r.toBase64();
}

const cameraTool: AgentTool<any> = {
  name: 'inspect_camera',
  label: '查看监控',
  description: '查看舱段监控画面',
  parameters: Type.Object({}),
  async execute() {
    return { content: [text('监控画面如下（320×240）'), { type: 'image', data: anomalyImage(), mimeType: 'image/png' }], details: {} };
  },
};

for (const id of [config.commanderModel, config.specialistModel]) {
  await check(`工具调用 · ${id}`, async () => {
    const agent = makeAgent(hub.chat(id), [echoTool]);
    await agent.prompt('请调用工具查询 C 区的信号数量，然后告诉我结果。');
    const calls = agent.state.messages.flatMap((m) => (m.role === 'assistant' ? m.content.filter((c) => c.type === 'toolCall') : []));
    const last = lastAssistant(agent);
    if (!calls.some((c) => c.type === 'toolCall' && c.name === 'lookup_sector')) throw new Error('模型没有调用工具');
    const answer = last.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    return `调用 ${calls.length} 次；回答「${answer.slice(0, 40)}」；durationMs=${last.durationMs}`;
  });
}

await check(`看图 · ${config.specialistModel}（工具结果图片）`, async () => {
  const agent = makeAgent(hub.chat(config.specialistModel), [cameraTool]);
  await agent.prompt('调用 inspect_camera 查看监控，告诉我异常物体的颜色和它在画面中的大致位置（例如左上、右下）。');
  const answer = lastAssistant(agent).content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  if (!/右下/.test(answer)) throw new Error(`位置判断不符：「${answer.slice(0, 80)}」`);
  return `「${answer.slice(0, 60)}」`;
});

await check(`纯文本降级 · ${config.commanderModel}（同一张图）`, async () => {
  const agent = makeAgent(hub.chat(config.commanderModel), [cameraTool]);
  await agent.prompt('调用 inspect_camera 查看监控，描述你看到的画面。');
  const answer = lastAssistant(agent).content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  return `不报错；回答「${answer.slice(0, 50)}」`;
});

await check(`并发 · 6 个 flash 请求经信号量（上限 ${config.maxConcurrency}）`, async () => {
  let peak = 0;
  const timer = setInterval(() => (peak = Math.max(peak, hub.semaphore.inFlight)), 20);
  const runs = await Promise.all(
    Array.from({ length: 6 }, async (_, i) => {
      const agent = makeAgent(hub.chat(config.specialistModel), []);
      await agent.prompt(`只回答数字：${i} + 1 = ?`);
      return [...agent.state.messages].reverse().find((m) => m.role === 'assistant') as AssistantMessage;
    }),
  );
  clearInterval(timer);
  const errors = runs.filter((m) => m.stopReason === 'error');
  const rateLimited = errors.filter((m) => /429|1302|速率/.test(m.errorMessage ?? ''));
  if (rateLimited.length) throw new Error(`${rateLimited.length} 个请求被限流：${rateLimited[0].errorMessage}`);
  if (errors.length) throw new Error(`${errors.length} 个请求失败：${errors[0].errorMessage}`);
  if (peak > config.maxConcurrency) throw new Error(`峰值并发 ${peak} 超过上限`);
  return `6/6 成功，峰值并发 ${peak}`;
});

await check(`thinking off · ${config.specialistModel}`, async () => {
  const agent = makeAgent(hub.chat(config.specialistModel), [], 'off');
  await agent.prompt('一句话：为什么要先扫描再派无人机？');
  const m = lastAssistant(agent);
  const thinkingChars = m.content.filter((c) => c.type === 'thinking').reduce((n, c) => n + (c.type === 'thinking' ? c.thinking.length : 0), 0);
  return `usage.reasoning=${m.usage.reasoning ?? '未报告'}，思考字符 ${thinkingChars}（>0 说明 disabled 被忽略）`;
});

await check('zaiToolStream（tool_stream: true）', async () => {
  const streamHub = createModelHub(config);
  const base = streamHub.chat(config.specialistModel) as Model<'openai-completions'>;
  const model: Model<'openai-completions'> = { ...base, compat: { ...base.compat, zaiToolStream: true } };
  const agent = makeAgent(model, [echoTool], 'off', streamHub);
  let deltas = 0;
  agent.subscribe((ev) => {
    if (ev.type === 'message_update' && ev.assistantMessageEvent.type === 'toolcall_delta') deltas++;
  });
  await agent.prompt('请调用工具查询 E 区的信号数量。');
  lastAssistant(agent);
  return `toolcall_delta ${deltas} 次`;
});

await check('第 1 课 · 真实模型', async () => {
  const station = new Station(config, { hub, journal: false });
  station.startFreePlay();
  station.dispatcher.enabled = false;
  const metas: Array<{ ttftMs?: number; durationMs?: number; model: string }> = [];
  const tools: string[] = [];
  station.bus.subscribe((m) => {
    if (m.t === 'app' && m.ev.kind === 'request.meta') metas.push(m.ev);
    if (m.t === 'agent' && m.ev.type === 'tool_execution_start') tools.push(m.ev.toolName);
  });
  await station.loadLesson('L01', 'live');
  await station.shutdown();
  if (station.lesson?.status !== 'done') throw new Error(`课程状态 ${station.lesson?.status}`);
  return `请求 ${metas.length} 次（${metas.map((m) => `TTFT ${m.ttftMs}ms / 总 ${m.durationMs}ms`).join('；')}）；工具 ${tools.join(' → ') || '无'}`;
});

// ───────── M2：专家看图（真实 flash 模型） ─────────

function liveStation() {
  const station = new Station(config, { hub, journal: false, clock: false, autoSpawn: false, autoHazards: false });
  station.startFreePlay();
  station.dispatcher.enabled = false;
  return { station };
}

async function runMember(station: Station, id: 'navigator' | 'engineer' | 'medic', text: string) {
  const calls: Array<{ name: string; args: any; structured?: any }> = [];
  station.bus.subscribe((m) => {
    if (m.t !== 'agent' || m.agentId !== id) return;
    const ev = m.ev;
    if (ev.type === 'tool_execution_end') {
      const start = calls.find((c) => c.name === ev.toolName && c.structured === undefined);
      if (start) start.structured = ev.result?.structuredContent ?? null;
    }
    if (ev.type === 'tool_execution_start') calls.push({ name: ev.toolName, args: ev.args });
  });
  const timer = setInterval(() => station.world.step(), 250);
  try {
    const last = await station.member(id)!.run(worldEventMessage('duty', text));
    if (last?.stopReason === 'error') throw new Error(last.errorMessage);
  } finally {
    clearInterval(timer);
  }
  return calls;
}

await check('雷达研判 · 领航员（flash 看雷达图分辨真伪）', async () => {
  const { station } = liveStation();
  const w = station.world;
  let real, fake;
  for (let i = 0; i < 300 && !(real && fake); i++) {
    const s = w.spawnNow();
    const t = w.truthOf(s.id)!;
    if (t.hoax && !fake && (!real || s.sector === real.sector)) fake = s;
    else if (!t.hoax && !real && (!fake || s.sector === fake.sector)) real = s;
  }
  if (!real || !fake) throw new Error('没有生成同星区的真假信号');
  const calls = await runMember(station, 'navigator', `扫描 ${real.sector} 区，逐个判断区内信号是真实遇险还是诱饵，用 report_back 交付，findings 每条写成「S-xx：真实」或「S-xx：诱饵」。`);
  const report = calls.find((c) => c.name === 'report_back');
  if (!report) throw new Error(`没有交付报告：${calls.map((c) => c.name).join(' → ')}`);
  const text = JSON.stringify(report.args);
  const verdict = (id: string) => new RegExp(`${id}[^"]{0,12}(诱饵|恶作剧|可疑|虚假)`).test(text) ? 'hoax' : new RegExp(`${id}[^"]{0,12}(真实|可信)`).test(text) ? 'real' : '?';
  const got = { [real.id]: verdict(real.id), [fake.id]: verdict(fake.id) };
  const ok = got[real.id] === 'real' && got[fake.id] === 'hoax';
  await station.shutdown();
  if (!ok) throw new Error(`判断有误（真实 ${real.id}、诱饵 ${fake.id}）：${JSON.stringify(got)}；工具链 ${calls.map((c) => c.name).join(' → ')}`);
  return `正确：${real.id} 真实、${fake.id} 诱饵；工具链 ${calls.map((c) => c.name).join(' → ')}`;
});

await check('监控定位 · 工程师（flash 看监控找火点）', async () => {
  const { station } = liveStation();
  station.setPolicy('autoApprove', true); // 这里考的是看图，不是审批（审批在第 7 课）
  station.world.damageModule('hangar', 'damaged', { kind: 'fire', cell: 'C2' });
  const calls = await runMember(station, 'engineer', '机库受损，高温告警。请诊断并处置。');
  const vents = calls.filter((c) => c.name === 'vent_section').map((c) => c.args.cell);
  await station.shutdown();
  if (!vents.includes('C2')) throw new Error(`没有排空 C2：排空 ${vents.join('、') || '无'}；工具链 ${calls.map((c) => c.name).join(' → ')}`);
  return `排空 ${vents.join('、')}；工具链 ${calls.map((c) => c.name).join(' → ')}；机库 ${station.world.module('hangar').status}`;
});

await check('体征判读 · 医疗官（flash 看波形只收治危急者）', async () => {
  const { station } = liveStation();
  const w = station.world;
  let s;
  for (let i = 0; i < 300; i++) {
    s = w.spawnNow();
    const t = w.truthOf(s.id)!;
    if (!t.hoax && t.members.length >= 2 && t.members.some(Boolean) && t.members.some((x) => !x)) break;
  }
  w.enqueue({ type: 'dispatch', droneId: 'D-1', signalId: s!.id, route: 'direct' });
  while (!w.snapshot().patients.length) w.step();
  const p = w.snapshot().patients[0];
  const truth = w.patientMembersTruth(p.id)!;
  const critical = truth.flatMap((c, i) => (c ? [i + 1] : []));
  const calls = await runMember(station, 'medic', `伤员组 ${p.id} 已接回，请评估并只收治危急成员。`);
  const bedded = calls.filter((c) => c.name === 'prepare_medbay').flatMap((c) => c.args.members as number[]).sort();
  await station.shutdown();
  const ok = JSON.stringify(bedded) === JSON.stringify(critical);
  if (!ok) throw new Error(`收治 ${JSON.stringify(bedded)}，实际危急 ${JSON.stringify(critical)}（共 ${truth.length} 人待评估）`);
  return `收治 ${JSON.stringify(bedded)} = 危急 ${JSON.stringify(critical)}`;
});

// ───────── M3–M6：委派、分诊、脚本编排（真实模型） ─────────

async function commanderRun(station: Station, text: string) {
  const calls: string[] = [];
  station.bus.subscribe((m) => m.t === 'agent' && m.ev.type === 'tool_execution_start' && calls.push(`${m.agentId}:${m.ev.toolName}`));
  const timer = setInterval(() => station.world.step(), 250);
  try {
    const last = await station.commander.run(worldEventMessage('duty', text));
    if (last?.stopReason === 'error') throw new Error(last.errorMessage);
  } finally {
    clearInterval(timer);
  }
  return calls;
}

await check('委派 · 指挥官（glm-5.3）把看图交给领航员（flash）', async () => {
  const { station } = liveStation();
  station.setPolicy('autoApprove', true);
  const s = station.world.spawnNow();
  const calls = await commanderRun(station, `${s.sector} 区出现信号 ${s.id}，你看不见雷达图。请委派能看图的船员扫描并判断真伪，然后待命。`);
  await station.shutdown();
  if (!calls.includes('commander:delegate')) throw new Error(`没有委派：${calls.join(' → ')}`);
  if (!calls.includes('navigator:scan_sector')) throw new Error(`领航员没有扫描：${calls.join(' → ')}`);
  return calls.join(' → ');
});

await check('分诊台 · 自定义分类器（flash 工具采样 k=3）', async () => {
  const { station } = liveStation();
  const s = station.world.spawnNow();
  station.hub.triageSamples = 3;
  const { triageSignal } = await import('../pi/triage.ts');
  const { radioTranscript } = await import('../world/spawner.ts');
  const view = await triageSignal(station.hub, station.world, station.bus, s, radioTranscript(s));
  await station.shutdown();
  if (!view) throw new Error('分类失败');
  return `${s.id}（${s.kind}）：${view.severityChoice} ${JSON.stringify(view.severity)} · 紧急度 ${view.urgency} · 恶作剧 ${view.hoax}`;
});

await check('脚本编排 · 指挥官写 run_script 一次查询多个信号', async () => {
  const { station } = liveStation();
  for (let i = 0; i < 6; i++) station.world.spawnNow();
  const calls = await commanderRun(station, '现在有 6 个信号。请用 run_script 写一段脚本，一次算出每个信号的燃料消耗与能否及时赶到，列出最划算的 3 个，然后待命。');
  const end = station.commander.agent.state.messages.find((m) => m.role === 'toolResult' && m.toolName === 'run_script');
  await station.shutdown();
  if (!calls.includes('commander:run_script')) throw new Error(`没有用脚本：${calls.join(' → ')}`);
  return `${calls.join(' → ')}；脚本输出「${end && end.role === 'toolResult' ? end.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ').slice(0, 60) : ''}」`;
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
