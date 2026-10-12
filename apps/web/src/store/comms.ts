// 通讯频道模型：由 agent 事件（流式文本、思考、工具）与应用事件（站务、主管、提示）派生。
import type { AppEvent, CrewId, ServerMsg, WorldEvent } from '@rescue/protocol';
import { MODULE_NAMES, SECTOR_NAMES } from '@rescue/protocol';
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
      /** onUpdate 里的 details.progress（0..1） */
      progressRatio?: number;
      summary?: string;
      structured?: unknown;
      args?: unknown;
      /** 工具结果里的图片（data URL） */
      images: string[];
    }
  | { kind: 'duty'; id: string; at: number; agentId: CrewId; text: string }
  | { kind: 'radio'; id: string; at: number; signalId: string; text: string }
  | { kind: 'system'; id: string; at: number; agentId: CrewId; text: string }
  | { kind: 'compaction'; id: string; at: number; agentId: CrewId; before: number; after: number; summary: string }
  | { kind: 'approval'; id: string; at: number; approvalId: string; agentId: CrewId; tool: string; args: unknown; risk: string; expiresAt: number; decision?: string }
  | { kind: 'world'; id: string; at: number; text: string; tone: 'info' | 'warn' | 'ok' | 'danger'; correlationId?: string }
  | { kind: 'notice'; id: string; at: number; level: 'info' | 'warn' | 'error'; text: string };

function imagesOf(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((c: { type?: string; data?: string; mimeType?: string }) => (c?.type === 'image' && c.data ? [`data:${c.mimeType ?? 'image/png'};base64,${c.data}`] : []));
}

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
        if (m.role === 'radio') {
          this.push({ kind: 'radio', id: this.id(), at, signalId: m.signalId, text: m.transcript });
          return true;
        }
        if (m.role === 'system') {
          const parts: string[] = [];
          if (m.sections) parts.push(`提示词补丁：${Object.keys(m.sections).join('、')}`);
          if (m.toolsAdded?.length) parts.push(`工具 +${m.toolsAdded.map((t) => t.name).join(' +')}`);
          if (m.toolsRemoved?.length) parts.push(`工具 −${m.toolsRemoved.map((t) => t.name).join(' −')}`);
          if (!parts.length) return false;
          this.push({ kind: 'system', id: this.id(), at, agentId, text: parts.join('；') });
          return true;
        }
        if (m.role === 'world_event' && (m.kind === 'nudge' || m.kind === 'view_trim')) {
          this.push({ kind: 'system', id: this.id(), at, agentId, text: m.text });
          return true;
        }
        if (m.role === 'world_event' && m.kind === 'duty') {
          this.push({ kind: 'duty', id: this.id(), at, agentId, text: m.text });
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
          kind: 'tool', id: this.id(), at, agentId, toolCallId: ev.toolCallId, name: ev.toolName, status: 'running', args: ev.args, images: [],
        };
        this.tools.set(ev.toolCallId, entry);
        this.push(entry);
        return true;
      }
      case 'tool_execution_update': {
        const entry = this.tools.get(ev.toolCallId);
        if (!entry) return false;
        entry.progress = firstText(ev.partialResult?.content);
        const ratio = ev.partialResult?.details?.progress;
        if (typeof ratio === 'number') entry.progressRatio = ratio;
        this.touch(entry);
        return true;
      }
      case 'tool_execution_end': {
        const entry = this.tools.get(ev.toolCallId);
        if (!entry) return false;
        entry.status = ev.isError ? 'error' : 'ok';
        entry.summary = firstText(ev.result?.content);
        entry.structured = ev.result?.structuredContent;
        entry.images = imagesOf(ev.result?.content);
        entry.progressRatio = undefined;
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
      case 'compaction':
        this.push({ kind: 'compaction', id: this.id(), at, agentId: ev.agentId, before: ev.beforeTokens, after: ev.afterTokens, summary: ev.summary });
        return true;
      case 'approval.requested':
        this.push({ kind: 'approval', id: this.id(), at, approvalId: ev.approvalId, agentId: ev.agentId, tool: ev.tool, args: ev.args, risk: ev.risk, expiresAt: ev.expiresAt });
        return true;
      case 'approval.resolved': {
        const e = this.entries.find((x) => x.kind === 'approval' && x.approvalId === ev.approvalId);
        if (!e || e.kind !== 'approval') return false;
        e.decision = ev.decision;
        this.touch(e);
        return true;
      }
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
      return { text: w.scanDone(SECTOR_NAMES[ev.sector].replace(' 区', ''), ev.signalIds.length, ev.partial), tone: ev.partial ? 'warn' : 'info', correlationId: ev.correlationId };
    case 'shift.ended':
      return { text: w.shiftEnded(ev.score.total), tone: 'ok' };
    case 'drone.dispatched':
      return { text: w.dispatched(ev.droneId, ev.signalId, ev.eta, ev.fuel, ev.hazardous), tone: 'info', correlationId: ev.correlationId };
    case 'drone.arrived':
      return { text: w.arrived(ev.droneId, ev.signalId, ev.outcome, ev.survivors), tone: ev.outcome === 'rescued' ? 'ok' : 'danger', correlationId: ev.correlationId };
    case 'drone.returned':
      return { text: w.returned(ev.droneId, ev.survivors, ev.damaged), tone: ev.damaged ? 'warn' : 'ok', correlationId: ev.correlationId };
    case 'drone.damaged':
      return { text: w.droneDamaged(ev.droneId), tone: 'danger' };
    case 'flare.warning':
      return { text: w.flareWarning(ev.sectors.join('、'), ev.startTick - ev.tick), tone: 'warn' };
    case 'flare.started':
      return { text: w.flareStarted(ev.sectors.join('、')), tone: 'danger' };
    case 'flare.ended':
      return { text: w.flareEnded, tone: 'info' };
    case 'module.damaged':
      return { text: w.moduleDamaged(MODULE_NAMES[ev.module], ev.status, ev.alarm), tone: 'danger' };
    case 'module.repaired':
      return { text: w.moduleRepaired(MODULE_NAMES[ev.module]), tone: 'ok', correlationId: ev.correlationId };
    case 'vent.result':
      return { text: w.vent(MODULE_NAMES[ev.module], ev.cell, ev.success), tone: ev.success ? 'ok' : 'danger', correlationId: ev.correlationId };
    case 'patient.arrived':
      return { text: w.patientArrived(ev.patient.id, ev.patient.count, ev.patient.members.length), tone: 'warn' };
    case 'patient.bedded':
      return { text: w.patientBedded(ev.patientId, ev.members), tone: 'ok', correlationId: ev.correlationId };
    case 'patient.lost':
      return { text: w.patientLost(ev.patientId, ev.member), tone: 'danger' };
    case 'fuel.allocated':
      return { text: w.fuelAllocated(ev.signalId, ev.amount), tone: 'info', correlationId: ev.correlationId };
    default:
      return undefined;
  }
}
