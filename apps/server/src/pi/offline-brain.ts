// faux 离线大脑（G3）：没有 API key 时的规则型船员。
// 它是一个 FauxResponseFactory：按 system prompt 判断角色，读取模型此刻能看到的上下文（convertToLlm 之后），给出确定性的回复。
import { inflateSync } from 'node:zlib';
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  getCurrentSystemPrompt,
  type FauxContentBlock,
  type FauxResponseFactory,
  type Message,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import { CAMERA_CELLS } from '@rescue/protocol';
import { cellRect } from '../world/render/camera.ts';

const textOf = (m: Message | undefined): string => {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return m.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
};

function think(level: string | undefined, short: string, long = ''): FauxContentBlock[] {
  if (!level || level === 'off') return [];
  if (level === 'minimal' || level === 'low' || !long) return [fauxThinking(short)];
  return [fauxThinking(`${short}\n${long}`)];
}

const reply = (blocks: FauxContentBlock[]) => fauxAssistantMessage(blocks, { stopReason: 'toolUse' });

/** 最后一个 assistant 之后的全部 toolResult（即上一批工具的结果） */
function lastBatch(messages: Message[]): ToolResultMessage[] {
  const out: ToolResultMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && messages[i].role === 'toolResult'; i--) out.unshift(messages[i] as ToolResultMessage);
  return out;
}

function latest(messages: Message[], prefix: string): string {
  return [...messages].reverse().map(textOf).find((t) => t.startsWith(prefix)) ?? '';
}

// ───────────── 指挥官 ─────────────

/** 从态势里找出尚未研判、也没有无人机前往的信号 */
export function unjudgedSignals(situation: string): string[] {
  return situation
    .split('\n')
    .filter((l) => /^- S-\d+/.test(l) && /尚未研判|未研判/.test(l) && !l.includes('已有无人机前往'))
    .map((l) => l.match(/^- (S-\d+)/)![1])
    .slice(0, 3);
}

function dockedDrones(situation: string): string[] {
  const line = situation.split('\n').find((l) => l.startsWith('无人机：')) ?? '';
  return [...line.matchAll(/(D-\d)在港/g)].map((m) => m[1]);
}

function commander(messages: Message[], level?: string) {
  const batch = lastBatch(messages);
  const situation = latest(messages, '【态势');
  const flare = situation.includes('耀斑');
  if (batch.length) {
    const inspected = batch.filter((r) => r.toolName === 'inspect_signal' && !r.isError).map(textOf);
    if (inspected.length) {
      const real = inspected.filter((t) => t.includes('轻微误码')).map((t) => t.match(/^(S-\d+)/)?.[1]).filter((x): x is string => !!x);
      const fake = inspected.filter((t) => t.includes('格式规整')).map((t) => t.match(/^(S-\d+)/)?.[1]);
      const drones = dockedDrones(situation);
      const pairs = real.slice(0, drones.length).map((s, i) => [drones[i], s] as const);
      const verdict = `${real.length ? `${real.join('、')} 判定为真实遇险` : ''}${fake.length ? `${real.length ? '；' : ''}${fake.join('、')} 疑似诱饵，不投入资源` : ''}。`;
      if (pairs.length) {
        return reply([
          ...think(level, '按研判结果分派无人机。', flare ? '耀斑活跃，走绕行航线。' : ''),
          fauxText(`${verdict}派出 ${pairs.map(([d, s]) => `${d}→${s}`).join('，')}。`),
          ...pairs.map(([droneId, signalId]) => fauxToolCall('dispatch_drone', { droneId, signalId, route: flare ? 'safe' : 'direct' })),
        ]);
      }
      return reply([fauxText(verdict), fauxToolCall('stand_by', { reason: drones.length ? '没有需要出动的真实信号' : '暂无在港无人机' })]);
    }
    const dispatched = batch.filter((r) => r.toolName === 'dispatch_drone');
    const reason = dispatched.length
      ? `已派出 ${dispatched.filter((r) => !r.isError).length} 架无人机，等待站务回报`
      : `已完成 ${batch.map((r) => r.toolName).join('、')}`;
    return reply([fauxText('收到。'), fauxToolCall('stand_by', { reason })]);
  }
  const prompt = textOf(messages[messages.length - 1]);
  if (prompt.startsWith('【主管')) {
    return reply([
      ...think(level, '主管有新指示，先确认再执行。'),
      fauxText(`收到主管指示：「${prompt.replace(/^【[^】]*】/, '').slice(0, 40)}」。`),
      fauxToolCall('stand_by', { reason: '已记录主管指示，等待下一条态势' }),
    ]);
  }
  const todo = unjudgedSignals(situation);
  if (todo.length) {
    return reply([
      ...think(level, `有 ${todo.length} 个信号尚未研判。`, '约 15% 的信号是诱饵。派无人机之前先研判，研判可以并行。'),
      fauxText(`先研判 ${todo.join('、')}。`),
      ...todo.map((signalId) => fauxToolCall('inspect_signal', { signalId })),
    ]);
  }
  return reply([...think(level, '没有需要研判的新信号。'), fauxText('态势平稳。'), fauxToolCall('stand_by', { reason: '无新的待研判信号' })]);
}

// ───────────── 专家 ─────────────

const MODULES: Array<[RegExp, string]> = [
  [/传感器/, 'sensors'],
  [/机库/, 'hangar'],
  [/医疗舱/, 'medbay'],
  [/通讯/, 'comms'],
];
const moduleIn = (t: string) => MODULES.find(([re]) => re.test(t))?.[1];

/** 离线「眼睛」：解码我们自己编码的 PNG（过滤器恒为 0），找火光 / 烟雾最多的网格 */
export function peekCamera(base64: string): string | undefined {
  const png = Buffer.from(base64, 'base64');
  const width = png.readUInt32BE(16);
  const chunks: Buffer[] = [];
  for (let off = 8; off < png.length; ) {
    const len = png.readUInt32BE(off);
    if (png.toString('ascii', off + 4, off + 8) === 'IDAT') chunks.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const px = (x: number, y: number) => {
    const i = y * (width * 4 + 1) + 1 + x * 4;
    return [raw[i], raw[i + 1], raw[i + 2]];
  };
  let best: { cell: string; score: number } | undefined;
  for (const cell of CAMERA_CELLS) {
    const r = cellRect(cell);
    let score = 0;
    for (let y = r.y + 12; y < r.y + r.h; y += 2) {
      for (let x = r.x + 2; x < r.x + r.w; x += 2) {
        const [cr, cg, cb] = px(x, y);
        if (cr > 200 && cg > 90 && cb < 130) score += 2; // 火光
        else if (Math.abs(cr - cg) < 12 && cr > 85 && cr < 180 && Math.abs(cg - cb) < 12) score += 1; // 烟雾
      }
    }
    if (score > 20 && (!best || score > best.score)) best = { cell, score };
  }
  return best?.cell;
}

function engineer(messages: Message[]) {
  const batch = lastBatch(messages);
  const brief = textOf(messages.find((m) => m.role === 'user' && /受损|修|舱/.test(textOf(m))));
  const module = moduleIn(textOf(messages[messages.length - 1])) ?? moduleIn(brief) ?? moduleIn(batch.map(textOf).join('')) ?? 'hangar';
  if (!batch.length) return reply([fauxText(`先诊断${module}。`), fauxToolCall('diagnose_module', { module })]);
  const r = batch[0];
  const t = textOf(r);
  switch (r.toolName) {
    case 'diagnose_module':
      if (t.includes('正常。')) return reply([fauxToolCall('report_back', { summary: '舱段运行正常，无需处置', findings: [t] })]);
      if (/高温|烟雾/.test(t)) return reply([fauxText('有告警，调监控看位置。'), fauxToolCall('inspect_camera', { module })]);
      if (t.includes('修复中')) return reply([fauxToolCall('report_back', { summary: '舱段已在修复中', findings: [t] })]);
      return reply([fauxText('无明火，直接修复。'), fauxToolCall('repair_module', { module })]);
    case 'inspect_camera': {
      const img = r.content.find((c) => c.type === 'image');
      const cell = img && img.type === 'image' ? peekCamera(img.data) : undefined;
      if (!cell) return reply([fauxText('画面里没看到异常。'), fauxToolCall('repair_module', { module })]);
      return reply([fauxText(`画面里 ${cell} 网格有异常，排空该区段。`), fauxToolCall('vent_section', { module, cell })]);
    }
    case 'vent_section':
      if (r.isError) return reply([fauxToolCall('report_back', { summary: '排空未能处置险情', findings: [t], confidence: 'low' })]);
      return reply([fauxText('险情解除，开始修复。'), fauxToolCall('repair_module', { module })]);
    case 'repair_module':
      return reply([fauxToolCall('report_back', { summary: r.isError ? `修复未完成：${t}` : t, findings: [t] })]);
    default:
      return reply([fauxToolCall('report_back', { summary: t || '已处置' })]);
  }
}

function medic(messages: Message[]) {
  const batch = lastBatch(messages);
  const prompt = textOf(messages.filter((m) => m.role === 'user').at(-1));
  const pid = prompt.match(/P-\d+/)?.[0];
  if (!batch.length) return reply([fauxText('先评估伤员。'), fauxToolCall('assess_survivors', pid ? { patientId: pid } : {})]);
  const r = batch[0];
  const t = textOf(r);
  if (r.toolName === 'assess_survivors') {
    const m = t.match(/(P-\d+)（[^）]*）：[^\n]*成员 ([\d、]+) 状况不明/);
    if (!m) return reply([fauxToolCall('report_back', { summary: '没有需要评估的成员', findings: [t] })]);
    return reply([fauxText(`读取 ${m[1]} 的体征。`), fauxToolCall('read_vitals', { patientId: m[1] })]);
  }
  if (r.toolName === 'read_vitals' && !r.isError) {
    const p = t.match(/^(P-\d+)/)?.[1];
    const members = (t.match(/成员 ([\d、]+)/)?.[1] ?? '').split('、').map(Number).filter(Boolean);
    // 离线大脑看不懂波形：保守起见全部收治（床位不够时由世界拒绝）
    return reply([fauxText('离线模式无法判读波形，保守收治。'), fauxToolCall('prepare_medbay', { patientId: p ?? pid ?? '', members })]);
  }
  return reply([fauxToolCall('report_back', { summary: t || '已处置', findings: [t] })]);
}

function navigator(messages: Message[]) {
  const batch = lastBatch(messages);
  const prompt = textOf(messages.filter((m) => m.role === 'user').at(-1));
  if (!batch.length) {
    const sector = prompt.match(/([A-F])\s*区/)?.[1];
    const sid = prompt.match(/S-\d+/)?.[0];
    if (sector) return reply([fauxText(`扫描 ${sector} 区。`), fauxToolCall('scan_sector', { sector })]);
    if (sid) return reply([fauxText(`研判 ${sid}。`), fauxToolCall('inspect_signal', { signalId: sid })]);
    return reply([fauxToolCall('report_back', { summary: '没有收到具体的星区或信号' })]);
  }
  const r = batch[0];
  if (r.toolName === 'scan_sector') {
    const ids = (textOf(r).match(/区内信号：([^。]+)/)?.[1] ?? '').split('、').filter((x) => x.startsWith('S-'));
    if (!ids.length) return reply([fauxToolCall('report_back', { summary: '该区没有活跃信号' })]);
    return reply([fauxText('离线模式看不懂雷达图，改用文字线索研判。'), ...ids.map((signalId) => fauxToolCall('inspect_signal', { signalId }))]);
  }
  const findings = batch.map(textOf);
  return reply([fauxToolCall('report_back', { summary: findings.map((f) => `${f.match(/^S-\d+/)?.[0]}${f.includes('轻微误码') ? ' 可信' : ' 可疑'}`).join('；'), findings })]);
}

export const offlineBrain: FauxResponseFactory = (context, options) => {
  const system = getCurrentSystemPrompt(context.messages) ?? '';
  const messages = context.messages.filter((m) => m.role !== 'system');
  if (system.includes('工程师')) return engineer(messages);
  if (system.includes('医疗官')) return medic(messages);
  if (system.includes('领航员')) return navigator(messages);
  return commander(messages, options?.reasoning);
};
