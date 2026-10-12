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

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
