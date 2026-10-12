// Loop Inspector 的运行模型（§7.2）：由 agent 事件与 hook / request.meta / queue 应用事件构建。
// 这是一个可变模型：高频事件直接改它，再按 requestAnimationFrame 通知 React（§7.1）。
import type { AppEvent, CrewId, ServerMsg, WireDelta } from '@rescue/protocol';

export type SegmentKind = 'thinking' | 'text' | 'toolcall';

export interface HookMark {
  hook: string;
  at: number;
  decision: unknown;
  durationMs: number;
  toolCallId?: string;
}

export interface RequestView {
  start: number;
  /** 首个流式增量 / provider 事件到达的时间（相对墙钟） */
  ttftMs?: number;
  end?: number;
  durationMs?: number;
  queuedMs?: number;
  model?: string;
  thinkingLevel?: string;
  stopReason?: string;
  segments: Array<{ kind: SegmentKind; start: number; end?: number }>;
  usage?: Extract<AppEvent, { kind: 'request.meta' }>['usage'];
  images?: number;
}

export interface ToolView {
  toolCallId: string;
  name: string;
  start: number;
  end?: number;
  durationMs?: number;
  isError?: boolean;
  blocked?: { by: string; reason: string };
  updates: Array<{ at: number; text?: string }>;
  hooks: HookMark[];
  args?: unknown;
  structured?: unknown;
}

export interface TurnView {
  index: number;
  start: number;
  end?: number;
  hooks: HookMark[];
  request?: RequestView;
  tools: ToolView[];
}

export interface RunView {
  agentId: CrewId;
  runId: string;
  startedAt: number;
  endedAt?: number;
  outcome?: 'ok' | 'error' | 'aborted';
  turns: TurnView[];
  queue: { steer: number; followUp: number };
}

const SEGMENT_OF: Partial<Record<WireDelta['type'], SegmentKind>> = {
  thinking_start: 'thinking',
  text_start: 'text',
  toolcall_start: 'toolcall',
};
const SEGMENT_END: Partial<Record<WireDelta['type'], true>> = { thinking_end: true, text_end: true, toolcall_end: true };

export class RunsModel {
  runs: RunView[] = [];
  private byId = new Map<string, RunView>();
  private queueByAgent = new Map<CrewId, { steer: number; followUp: number }>();
  totalCost = 0;
  totalTokens = 0;

  reset(): void {
    this.runs = [];
    this.byId.clear();
    this.queueByAgent.clear();
    this.totalCost = 0;
    this.totalTokens = 0;
  }

  latest(agentId: CrewId): RunView | undefined {
    for (let i = this.runs.length - 1; i >= 0; i--) if (this.runs[i].agentId === agentId) return this.runs[i];
    return undefined;
  }

  /** 返回 true 表示模型有变化 */
  apply(msg: ServerMsg): boolean {
    if (msg.t === 'agent') return this.applyAgent(msg);
    if (msg.t === 'app') return this.applyApp(msg.ev, msg.at);
    return false;
  }

  private applyAgent(msg: Extract<ServerMsg, { t: 'agent' }>): boolean {
    const { ev, at, agentId, runId } = msg;
    if (ev.type === 'agent_start') {
      const run: RunView = { agentId, runId, startedAt: at, turns: [], queue: this.queueByAgent.get(agentId) ?? { steer: 0, followUp: 0 } };
      this.runs.push(run);
      this.byId.set(runId, run);
      if (this.runs.length > 200) this.byId.delete(this.runs.shift()!.runId);
      return true;
    }
    const run = this.byId.get(runId);
    if (!run) return false;
    const turn = run.turns[run.turns.length - 1];
    switch (ev.type) {
      case 'turn_start':
        run.turns.push({ index: run.turns.length, start: at, hooks: [], tools: [] });
        return true;
      case 'message_start':
        if (ev.message.role === 'assistant' && turn) turn.request ??= { start: at, segments: [] };
        return true;
      case 'message_update_batch': {
        const req = turn?.request;
        if (!req) return false;
        for (const d of ev.deltas) {
          const kind = SEGMENT_OF[d.type];
          if (kind) req.segments.push({ kind, start: at });
          if (SEGMENT_END[d.type]) {
            const open = [...req.segments].reverse().find((s) => s.end === undefined);
            if (open) open.end = at;
          }
        }
        return true;
      }
      case 'message_end':
        if (ev.message.role === 'assistant' && turn?.request) {
          turn.request.end = at;
          turn.request.stopReason = ev.message.stopReason;
          for (const s of turn.request.segments) s.end ??= at;
        }
        return true;
      case 'tool_execution_start':
        turn?.tools.push({ toolCallId: ev.toolCallId, name: ev.toolName, start: at, updates: [], hooks: [], args: ev.args });
        return true;
      case 'tool_execution_update': {
        const tool = this.tool(run, ev.toolCallId);
        const text = ev.partialResult?.content?.find?.((c: { type: string }) => c.type === 'text')?.text;
        tool?.updates.push({ at, text });
        return true;
      }
      case 'tool_execution_end': {
        const tool = this.tool(run, ev.toolCallId);
        if (tool) {
          tool.end = at;
          tool.durationMs = ev.durationMs;
          tool.isError = ev.isError;
          tool.structured = ev.result?.structuredContent;
          if (ev.durationMs === undefined && ev.isError) {
            const reason = ev.result?.content?.find?.((c: { type: string }) => c.type === 'text')?.text ?? '';
            tool.blocked = { by: 'beforeToolCall', reason };
          }
        }
        return true;
      }
      case 'turn_end':
        if (turn) turn.end = at;
        return true;
      case 'agent_end': {
        run.endedAt = at;
        const last = [...ev.messages].reverse().find((m) => m.role === 'assistant');
        const stop = last && last.role === 'assistant' ? last.stopReason : undefined;
        run.outcome = stop === 'error' ? 'error' : stop === 'aborted' ? 'aborted' : 'ok';
        for (const t of run.turns) t.end ??= at;
        return true;
      }
      default:
        return false;
    }
  }

  private applyApp(ev: AppEvent, at: number): boolean {
    switch (ev.kind) {
      case 'request.meta': {
        const run = this.byId.get(ev.runId);
        const turn = run?.turns[run.turns.length - 1];
        if (!turn) return false;
        const req = (turn.request ??= { start: ev.startedAt, segments: [] });
        req.start = ev.startedAt;
        req.ttftMs = ev.ttftMs;
        req.durationMs = ev.durationMs;
        req.queuedMs = ev.queuedMs;
        req.model = ev.model;
        req.thinkingLevel = ev.thinkingLevel;
        req.stopReason = ev.stopReason;
        req.usage = ev.usage;
        req.images = ev.images;
        if (ev.durationMs !== undefined) req.end = ev.startedAt + ev.durationMs;
        this.totalCost += ev.usage?.cost ?? 0;
        this.totalTokens += ev.usage?.totalTokens ?? 0;
        return true;
      }
      case 'hook': {
        const run = this.byId.get(ev.runId);
        const turn = run?.turns[run.turns.length - 1];
        if (!turn) return false;
        const mark: HookMark = { hook: ev.hook, at, decision: ev.decision, durationMs: ev.durationMs, toolCallId: ev.toolCallId };
        const tool = ev.toolCallId ? turn.tools.find((t) => t.toolCallId === ev.toolCallId) : undefined;
        (tool ? tool.hooks : turn.hooks).push(mark);
        return true;
      }
      case 'queue': {
        const q = { steer: ev.steer, followUp: ev.followUp };
        this.queueByAgent.set(ev.agentId, q);
        const run = this.latest(ev.agentId);
        if (run) run.queue = q;
        return true;
      }
      default:
        return false;
    }
  }

  private tool(run: RunView, id: string): ToolView | undefined {
    for (let i = run.turns.length - 1; i >= 0; i--) {
      const t = run.turns[i].tools.find((x) => x.toolCallId === id);
      if (t) return t;
    }
    return undefined;
  }
}
