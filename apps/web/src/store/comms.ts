// 通讯频道模型：由 agent 事件（流式文本、思考、工具）与应用事件（站务、主管、提示）派生。
import type { AppEvent, CrewId, ServerMsg, WorldEvent } from '@rescue/protocol';
import { SECTOR_NAMES } from '@rescue/protocol';
import { zh } from '../i18n/zh.ts';

export type CommsEntry =
  | {
      kind: 'crew';
      id: string;
      agentId: CrewId;
      runId: string;
      at: number;
      text: string;
      thinking: string;
      toolCalls: Array<{ id: string; name: string; args: unknown }>;
      streaming: boolean;
      stopReason?: string;
      error?: string;
      thinkingLevel?: string;
    }
  | { kind: 'operator'; id: string; at: number; target: CrewId; text: string; mode: string }
  | { kind: 'situation'; id: string; at: number; agentId: CrewId; reasons: string[]; signals: number; tick: number }
  | {
      kind: 'tool';
      id: string;
      at: number;
      agentId: CrewId;
      toolCallId: string;
      name: string;
      status: 'running' | 'ok' | 'error';
      progress?: string;
      summary?: string;
      structured?: unknown;
      args?: unknown;
    }
  | { kind: 'world'; id: string; at: number; text: string; tone: 'info' | 'warn' | 'ok' | 'danger'; correlationId?: string }
  | { kind: 'notice'; id: string; at: number; level: 'info' | 'warn' | 'error'; text: string };

const firstText = (content: unknown): string | undefined =>
  Array.isArray(content) ? content.find((c: { type?: string }) => c?.type === 'text')?.text : undefined;

export class CommsModel {
  entries: CommsEntry[] = [];
  private streaming = new Map<CrewId, Extract<CommsEntry, { kind: 'crew' }>>();
  private tools = new Map<string, Extract<CommsEntry, { kind: 'tool' }>>();
  private serial = 0;
  private revs = new Map<string, number>();

  /** 条目修订号：条目对象是可变的，组件用它判断是否需要重渲染 */
  rev(id: string): number {
    return this.revs.get(id) ?? 0;
  }

  private touch(entry: CommsEntry): void {
    this.revs.set(entry.id, (this.revs.get(entry.id) ?? 0) + 1);
  }

  reset(): void {
    this.entries = [];
    this.revs.clear();
    this.streaming.clear();
    this.tools.clear();
  }

  apply(msg: ServerMsg): boolean {
    if (msg.t === 'agent') return this.applyAgent(msg);
    if (msg.t === 'app') return this.applyApp(msg.ev, msg.at);
    return false;
  }

  private push(entry: CommsEntry): void {
    this.entries.push(entry);
    if (this.entries.length > 600) for (const old of this.entries.splice(0, this.entries.length - 600)) this.revs.delete(old.id);
  }

  private id(): string {
    return `c${++this.serial}`;
  }

  private applyAgent(msg: Extract<ServerMsg, { t: 'agent' }>): boolean {
    const { ev, at, agentId, runId } = msg;
    switch (ev.type) {
      case 'message_start': {
        const m = ev.message;
        if (m.role === 'assistant') {
          const entry: Extract<CommsEntry, { kind: 'crew' }> = {
            kind: 'crew', id: this.id(), agentId, runId, at, text: '', thinking: '', toolCalls: [], streaming: true,
          };
          this.streaming.set(agentId, entry);
          this.push(entry);
          return true;
        }
        if (m.role === 'situation') {
          this.push({ kind: 'situation', id: this.id(), at, agentId, reasons: m.reasons, signals: m.brief.signals.length, tick: m.tick });
          return true;
        }
        return false;
      }
      case 'message_update_batch': {
        const entry = this.streaming.get(agentId);
        if (!entry) return false;
        for (const d of ev.deltas) {
          if (d.type === 'text_delta') entry.text += d.delta;
          else if (d.type === 'thinking_delta') entry.thinking += d.delta;
          else if (d.type === 'toolcall_end') entry.toolCalls.push({ id: d.toolCall.id, name: d.toolCall.name, args: d.toolCall.arguments });
        }
        this.touch(entry);
        return true;
      }
      case 'message_end': {
        const m = ev.message;
        if (m.role !== 'assistant') return false;
        const entry = this.streaming.get(agentId);
        if (!entry) return false;
        // message_end 是权威内容：用它覆盖流式拼接的结果
        entry.text = m.content.filter((c) => c.type === 'text').map((c) => (c.type === 'text' ? c.text : '')).join('');
        entry.thinking = m.content.filter((c) => c.type === 'thinking').map((c) => (c.type === 'thinking' ? c.thinking : '')).join('\n');
        entry.toolCalls = m.content.flatMap((c) => (c.type === 'toolCall' ? [{ id: c.id, name: c.name, args: c.arguments }] : []));
        entry.streaming = false;
        entry.stopReason = m.stopReason;
        entry.error = m.errorMessage;
        entry.thinkingLevel = m.thinkingLevel;
        this.streaming.delete(agentId);
        this.touch(entry);
        return true;
      }
      case 'tool_execution_start': {
        const entry: Extract<CommsEntry, { kind: 'tool' }> = {
          kind: 'tool', id: this.id(), at, agentId, toolCallId: ev.toolCallId, name: ev.toolName, status: 'running', args: ev.args,
        };
        this.tools.set(ev.toolCallId, entry);
        this.push(entry);
        return true;
      }
      case 'tool_execution_update': {
        const entry = this.tools.get(ev.toolCallId);
        if (!entry) return false;
        entry.progress = firstText(ev.partialResult?.content);
        this.touch(entry);
        return true;
      }
      case 'tool_execution_end': {
        const entry = this.tools.get(ev.toolCallId);
        if (!entry) return false;
        entry.status = ev.isError ? 'error' : 'ok';
        entry.summary = firstText(ev.result?.content);
        entry.structured = ev.result?.structuredContent;
        this.tools.delete(ev.toolCallId);
        this.touch(entry);
        return true;
      }
      default:
        return false;
    }
  }

  private applyApp(ev: AppEvent, at: number): boolean {
    switch (ev.kind) {
      case 'operator.echo':
        this.push({ kind: 'operator', id: this.id(), at, target: ev.target, text: ev.text, mode: ev.mode });
        return true;
      case 'notice':
        this.push({ kind: 'notice', id: this.id(), at, level: ev.level, text: ev.text });
        return true;
      case 'world.event': {
        const line = worldLine(ev.ev);
        if (!line) return false;
        this.push({ kind: 'world', id: this.id(), at, ...line });
        return true;
      }
      default:
        return false;
    }
  }
}

function worldLine(ev: WorldEvent): { text: string; tone: 'info' | 'warn' | 'ok' | 'danger'; correlationId?: string } | undefined {
  const w = zh.worldEvent;
  switch (ev.type) {
    case 'signal.spawned':
      return { text: w.spawned(ev.signal.id, ev.signal.sector, zh.signalKinds[ev.signal.kind], ev.signal.survivors), tone: 'warn' };
    case 'signal.lost':
      return { text: w.lost(ev.signalId), tone: 'danger' };
    case 'scan.completed':
      return { text: w.scanDone(SECTOR_NAMES[ev.sector].replace(' 区', ''), ev.signalIds.length), tone: 'info', correlationId: ev.correlationId };
    case 'shift.ended':
      return { text: w.shiftEnded(ev.score.total), tone: 'ok' };
    default:
      return undefined;
  }
}
