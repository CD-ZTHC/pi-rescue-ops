// subscribe → 运行记录；onProviderStreamEvent → TTFT（§5.13）。
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { CrewId } from '@rescue/protocol';
import type { Bus } from '../runtime/bus.ts';
import type { RequestProbe } from './models.ts';

export interface ObserveDeps {
  bus: Bus;
  probe: RequestProbe;
  /** agent_end 时 await 落盘 */
  flush?: () => Promise<void>;
  /** 运行开始 / 结束时回调，CrewMember 用来维护 runId 与状态 */
  onRun?: (phase: 'start' | 'end', runId: string) => void;
  parentToolCallId?: () => string | undefined;
}

export interface Observer {
  readonly runId: string;
  listener: (ev: AgentEvent, signal: AbortSignal) => Promise<void> | void;
}

let runCounter = 0;

export function observe(agentId: CrewId, deps: ObserveDeps): Observer {
  let runId = '';
  let firstDeltaAt: number | undefined;

  const obs: Observer = {
    get runId() {
      return runId;
    },
    async listener(ev) {
      if (ev.type === 'agent_start') {
        runId = `${agentId}-${Date.now().toString(36)}-${(++runCounter).toString(36)}`;
        deps.onRun?.('start', runId);
      }
      if (ev.type === 'message_start' && ev.message.role === 'assistant') firstDeltaAt = undefined;
      if (ev.type === 'message_update') firstDeltaAt ??= Date.now();

      deps.bus.agent(agentId, runId, ev, deps.parentToolCallId?.());

      if (ev.type === 'message_end' && ev.message.role === 'assistant') {
        emitRequestMeta(agentId, runId, ev.message, firstDeltaAt, deps);
      }
      if (ev.type === 'agent_end') {
        deps.bus.flush(agentId);
        await deps.flush?.();
        deps.onRun?.('end', runId);
      }
    },
  };
  return obs;
}

function emitRequestMeta(
  agentId: CrewId,
  runId: string,
  message: AssistantMessage,
  firstDeltaAt: number | undefined,
  deps: ObserveDeps,
): void {
  const timing = deps.probe.current();
  const startedAt = timing?.startedAt ?? message.timestamp;
  const providerFirst = timing?.firstProviderEventAt;
  const ttftAt = providerFirst ?? firstDeltaAt;
  deps.bus.app({
    kind: 'request.meta',
    agentId,
    runId,
    startedAt,
    queuedMs: timing ? timing.startedAt - timing.queuedAt : 0,
    ttftMs: ttftAt !== undefined ? Math.max(0, ttftAt - startedAt) : undefined,
    ttftSource: providerFirst !== undefined ? 'provider' : firstDeltaAt !== undefined ? 'delta' : undefined,
    providerEvents: timing?.providerEvents ?? 0,
    model: message.model,
    thinkingLevel: message.thinkingLevel,
    durationMs: message.durationMs ?? Date.now() - startedAt,
    durationSource: message.durationMs !== undefined ? 'pi' : 'wall',
    stopReason: message.stopReason,
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      reasoning: message.usage.reasoning,
      cacheRead: message.usage.cacheRead,
      totalTokens: message.usage.totalTokens,
      cost: message.usage.cost.total,
    },
    images: timing?.images,
    rawChunks: timing?.raw.length ? [...timing.raw] : undefined,
  });
}
