// faux 回放（§9）：把录制里每个船员的 AssistantMessage 依次交给 faux provider。
// - 多名船员会并发请求：响应工厂按 system prompt 认出是谁，再取该船员的下一条录制回复
// - 世界节奏：回复要等世界走到录制时的 tick 才送出，世界演化才和录制时一致
// - 校验：回放产生的工具调用序列必须与录制一致，不一致则报告首个分歧点
import { readFile } from 'node:fs/promises';
import { getCurrentSystemPrompt, type AssistantMessage, type FauxResponseFactory } from '@earendil-works/pi-ai';
import type { ClassifierView, ClientMsg, CrewId } from '@rescue/protocol';
import type { RecordingLine } from './recorder.ts';

export interface Recording {
  file: string;
  header: Extract<RecordingLine, { type: 'header' }>;
  assistants: Map<CrewId, Array<{ tick: number; message: AssistantMessage }>>;
  tools: Map<CrewId, string[]>;
  operators: Array<{ tick: number; msg: ClientMsg }>;
  approvals: Map<string, 'approve' | 'deny' | 'timeout'>;
  triage: Map<string, { result: ClassifierView; samples: number }>;
  end?: Extract<RecordingLine, { type: 'end' }>;
}

export function parseRecording(file: string, text: string): Recording {
  const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as RecordingLine);
  const header = lines.find((l): l is Extract<RecordingLine, { type: 'header' }> => l.type === 'header');
  if (!header) throw new Error(`${file} 不是录制文件（没有 header）`);
  const rec: Recording = { file, header, assistants: new Map(), tools: new Map(), operators: [], approvals: new Map(), triage: new Map() };
  for (const l of lines) {
    if (l.type === 'assistant') (rec.assistants.get(l.agentId) ?? rec.assistants.set(l.agentId, []).get(l.agentId)!).push({ tick: l.tick, message: l.message });
    if (l.type === 'tool') (rec.tools.get(l.agentId) ?? rec.tools.set(l.agentId, []).get(l.agentId)!).push(l.name);
    if (l.type === 'operator') rec.operators.push({ tick: l.tick, msg: l.msg });
    if (l.type === 'approval') rec.approvals.set(l.toolCallId, l.decision);
    if (l.type === 'triage') rec.triage.set(l.signalId, { result: l.result, samples: l.samples });
    if (l.type === 'end') rec.end = l;
  }
  return rec;
}

export async function loadRecording(file: string): Promise<Recording> {
  return parseRecording(file, await readFile(file, 'utf8'));
}

const ROLE: Record<string, CrewId> = { 值班指挥官: 'commander', 领航员: 'navigator', 工程师: 'engineer', 医疗官: 'medic' };

export interface ReplayDivergence {
  agentId: CrewId;
  index: number;
  expected?: string;
  got?: string;
}

export class ReplayCursor {
  private cursor = new Map<CrewId, number>();
  private toolCursor = new Map<CrewId, number>();
  divergence?: ReplayDivergence;
  matched = 0;
  readonly total: number;
  readonly rec: Recording;
  private readonly tick: () => number;

  constructor(rec: Recording, tick: () => number) {
    this.rec = rec;
    this.tick = tick;
    this.total = [...rec.tools.values()].reduce((n, l) => n + l.length, 0);
  }

  get remaining(): number {
    let n = 0;
    for (const [id, list] of this.rec.assistants) n += list.length - (this.cursor.get(id) ?? 0);
    return n;
  }

  /** faux 响应工厂：取该船员的下一条录制回复，等世界走到录制时的 tick 再送出 */
  factory: FauxResponseFactory = async (context, options) => {
    const role = ROLE[getCurrentSystemPrompt(context.messages)?.match(/救援站的(\S+?)「/)?.[1] ?? ''];
    const list = role ? this.rec.assistants.get(role) : undefined;
    const i = role ? (this.cursor.get(role) ?? 0) : 0;
    const next = list?.[i];
    if (!role || !next) {
      return { ...EMPTY, stopReason: 'error', errorMessage: `录制里没有 ${role ?? '?'} 的第 ${i + 1} 条回复`, timestamp: Date.now() };
    }
    this.cursor.set(role, i + 1);
    while (this.tick() < next.tick && !options?.signal?.aborted) await new Promise((r) => setTimeout(r, 20));
    // 去掉 durationMs，让流重新计时；timestamp 用现在
    const { durationMs: _d, ...message } = structuredClone(next.message);
    return { ...message, timestamp: Date.now() };
  };

  /** 每个工具调用开始时比对；返回首个分歧（只报告一次） */
  observeTool(agentId: CrewId, name: string): ReplayDivergence | undefined {
    const i = this.toolCursor.get(agentId) ?? 0;
    this.toolCursor.set(agentId, i + 1);
    const expected = this.rec.tools.get(agentId)?.[i];
    if (expected === name) {
      this.matched++;
      return undefined;
    }
    if (!this.divergence) {
      this.divergence = { agentId, index: i, expected, got: name };
      return this.divergence;
    }
    return undefined;
  }
}

const EMPTY: AssistantMessage = {
  role: 'assistant',
  content: [],
  api: 'faux',
  provider: 'faux',
  model: 'replay',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: 'stop',
  timestamp: 0,
};
