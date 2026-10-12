// 有序事件总线（§4.3）：所有对外消息共享一个单调递增的 seq。
// message_update 按 50ms 合批成 message_update_batch；同一 Agent 的其他事件到来前先冲刷，保证顺序。
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import {
  toWireDelta,
  type AppEvent,
  type CrewId,
  type SeqlessServerMsg,
  type ServerMsg,
  type WireAgentEvent,
  type WireDelta,
  type WorldPatch,
} from '@rescue/protocol';

type Listener = (msg: ServerMsg) => void;

interface PendingBatch {
  runId: string;
  parentToolCallId?: string;
  deltas: WireDelta[];
  timer: NodeJS.Timeout;
}

export interface BusOptions {
  /** 合批窗口，默认 50ms */
  batchMs?: number;
  /** 保留多少条历史用于断线补发 */
  capacity?: number;
}

export class Bus {
  private seq = 0;
  private ring: ServerMsg[] = [];
  private listeners = new Set<Listener>();
  private pending = new Map<CrewId, PendingBatch>();
  private readonly batchMs: number;
  private readonly capacity: number;

  constructor(options: BusOptions = {}) {
    this.batchMs = options.batchMs ?? 50;
    this.capacity = options.capacity ?? 50_000;
  }

  get lastSeq(): number {
    return this.seq;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(msg: SeqlessServerMsg): ServerMsg {
    const full = { ...msg, seq: ++this.seq } as ServerMsg;
    this.ring.push(full);
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity);
    for (const l of this.listeners) l(full);
    return full;
  }

  app(ev: AppEvent): void {
    this.publish({ t: 'app', at: Date.now(), ev });
  }

  world(tick: number, patch: WorldPatch): void {
    this.publish({ t: 'world', tick, patch });
  }

  agent(agentId: CrewId, runId: string, ev: AgentEvent, parentToolCallId?: string): void {
    if (ev.type === 'message_update') {
      const delta = toWireDelta(ev.assistantMessageEvent);
      const batch = this.pending.get(agentId);
      if (batch && batch.runId === runId) {
        batch.deltas.push(delta);
        return;
      }
      if (batch) this.flush(agentId);
      this.pending.set(agentId, {
        runId,
        parentToolCallId,
        deltas: [delta],
        timer: setTimeout(() => this.flush(agentId), this.batchMs),
      });
      return;
    }
    this.flush(agentId);
    this.publish({ t: 'agent', agentId, runId, parentToolCallId, at: Date.now(), ev: ev as WireAgentEvent });
  }

  flush(agentId?: CrewId): void {
    const ids = agentId ? [agentId] : [...this.pending.keys()];
    for (const id of ids) {
      const batch = this.pending.get(id);
      if (!batch) continue;
      clearTimeout(batch.timer);
      this.pending.delete(id);
      this.publish({
        t: 'agent',
        agentId: id,
        runId: batch.runId,
        parentToolCallId: batch.parentToolCallId,
        at: Date.now(),
        ev: { type: 'message_update_batch', deltas: batch.deltas },
      });
    }
  }

  /** 新连接用的历史：最近 limit 条 agent / app 消息 */
  history(limit = 4000): Array<Extract<ServerMsg, { t: 'agent' | 'app' }>> {
    const out = this.ring.filter((m): m is Extract<ServerMsg, { t: 'agent' | 'app' }> => m.t === 'agent' || m.t === 'app');
    return out.slice(-limit);
  }

  /**
   * 断线补发：返回 seq > since 的全部消息。
   * 如果 since 之后的消息已被挤出环形缓冲，返回 undefined（调用方应改发 hello 全量快照）。
   */
  since(since: number): ServerMsg[] | undefined {
    if (since >= this.seq) return [];
    const first = this.ring[0];
    if (!first || first.seq > since + 1) return undefined;
    return this.ring.filter((m) => m.seq > since);
  }
}
