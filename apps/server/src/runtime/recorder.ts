// 录制（§9）：把一个班次里「模型说了什么」与「主管做了什么」写成 JSONL，供 faux 回放。
// 世界只依赖 seed 与命令序列（§6.4），所以录制里不需要世界状态：同一个 seed + 同样的模型回复 + 同样的主管操作，
// 就能把整班重演一遍。
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { ClassifierView, ClientMsg, CrewId, ScoreView } from '@rescue/protocol';
import type { Bus } from './bus.ts';

export type RecordingLine =
  | { type: 'header'; version: 1; seed: number; autoSpawn: boolean; autoHazards: boolean; mode: 'live' | 'faux'; models: { commander: string; specialist: string }; flags?: Record<string, boolean>; createdAt: string }
  | { type: 'assistant'; agentId: CrewId; tick: number; message: AssistantMessage }
  | { type: 'tool'; agentId: CrewId; tick: number; name: string; toolCallId: string }
  | { type: 'operator'; tick: number; msg: ClientMsg }
  | { type: 'approval'; tick: number; toolCallId: string; decision: 'approve' | 'deny' | 'timeout' }
  | { type: 'triage'; tick: number; signalId: string; result: ClassifierView; samples: number }
  | { type: 'end'; tick: number; score: ScoreView };

/** 会被录制的主管操作：会影响船员或世界的那些 */
// policy.set 由 Station.setPolicy 统一录制（课程、测试也会直接改开关）
const RECORDED_OPS = new Set<ClientMsg['t']>(['operator.say', 'run.abort', 'world.speed', 'queue.mode', 'triage.samples']);

export class Recorder {
  readonly file: string;
  private writing: Promise<void> = Promise.resolve();
  private off?: () => void;
  private approvalToolCall = new Map<string, string>();
  private readonly tick: () => number;

  constructor(file: string, tick: () => number) {
    this.file = file;
    this.tick = tick;
  }

  start(header: Omit<Extract<RecordingLine, { type: 'header' }>, 'type' | 'version' | 'createdAt'>, bus: Bus): void {
    this.write({ type: 'header', version: 1, createdAt: new Date().toISOString(), ...header });
    this.off = bus.subscribe((m) => {
      if (m.t === 'agent') {
        const ev = m.ev;
        if (ev.type === 'message_end' && ev.message.role === 'assistant') this.write({ type: 'assistant', agentId: m.agentId, tick: this.tick(), message: ev.message });
        if (ev.type === 'tool_execution_start') this.write({ type: 'tool', agentId: m.agentId, tick: this.tick(), name: ev.toolName, toolCallId: ev.toolCallId });
      } else if (m.t === 'app') {
        const ev = m.ev;
        if (ev.kind === 'approval.requested') this.approvalToolCall.set(ev.approvalId, ev.toolCallId);
        if (ev.kind === 'approval.resolved') {
          const toolCallId = this.approvalToolCall.get(ev.approvalId);
          if (toolCallId) this.write({ type: 'approval', tick: this.tick(), toolCallId, decision: ev.decision });
        }
        if (ev.kind === 'triage') this.write({ type: 'triage', tick: this.tick(), signalId: ev.signalId, result: ev.result, samples: ev.samples });
        if (ev.kind === 'world.event' && ev.ev.type === 'shift.ended') this.write({ type: 'end', tick: ev.ev.tick, score: ev.ev.score });
      }
    });
  }

  operator(msg: ClientMsg): void {
    if (RECORDED_OPS.has(msg.t)) this.write({ type: 'operator', tick: this.tick(), msg });
  }

  policy(key: string, value: boolean): void {
    this.write({ type: 'operator', tick: this.tick(), msg: { t: 'policy.set', key: key as never, value } });
  }

  private write(line: RecordingLine): void {
    const text = JSON.stringify(line) + '\n';
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await appendFile(this.file, text, 'utf8');
    });
  }

  async close(): Promise<void> {
    this.off?.();
    await this.writing;
  }
}
