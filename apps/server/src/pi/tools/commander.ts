// 指挥官工具（M1 简版）：stand_by、scan_sector。
// M2 起 scan_sector 归领航员所有，并返回雷达成像。
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import { SECTOR_IDS, type SectorId, type WorldEvent } from '@rescue/protocol';
import type { World } from '../../world/sim.ts';

export interface ToolDeps {
  world: World;
}

const text = (t: string) => ({ type: 'text' as const, text: t });

const SectorParam = Type.Union(SECTOR_IDS.map((id) => Type.Literal(id)), { description: '星区编号 A–F' });

const ScanParams = Type.Object({ sector: SectorParam });
const ScanOutput = Type.Object({
  sector: Type.String(),
  ticks: Type.Number(),
  signals: Type.Array(Type.Object({ id: Type.String(), kind: Type.String(), survivors: Type.Number(), clues: Type.Array(Type.String()) })),
});
type ScanOutput = Static<typeof ScanOutput>;

/** 把「a区」「Ｂ」「sector c」之类的写法归一化为 A–F（prepareArguments 示例，第 3 课） */
export function normalizeSector(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const half = raw.replace(/[Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const m = half.toUpperCase().match(/[A-F]/);
  return m ? m[0] : raw;
}

export function scanSectorTool(deps: ToolDeps): AgentTool<typeof ScanParams> {
  return {
    name: 'scan_sector',
    label: '扫描星区',
    description: '对一个星区做主动扫描，耗时 3–6 秒，返回该区活跃信号及线索（用于判断信号真伪）。',
    parameters: ScanParams,
    outputSchema: ScanOutput,
    executionMode: 'parallel',
    prepareArguments: (args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      return { ...a, sector: normalizeSector(a.sector) } as Static<typeof ScanParams>;
    },
    async execute(toolCallId, { sector }, signal, onUpdate) {
      const world = deps.world;
      const accepted = world.enqueue({ type: 'scan', sector, correlationId: toolCallId });
      if (!accepted.ok) {
        return { content: [text(`扫描未受理：${accepted.reason}`)], details: { reason: accepted.reason }, isError: true };
      }
      onUpdate?.({ content: [text(`${sector} 区扫描已受理，预计 ${accepted.etaTicks} 秒`)], details: { phase: 'accepted', eta: accepted.etaTicks } });
      const started = world.tick;
      const done = await waitForWorldEvent(
        world,
        (ev): ev is Extract<WorldEvent, { type: 'scan.completed' }> => ev.type === 'scan.completed' && ev.correlationId === toolCallId,
        signal,
      );
      const signals = done.signalIds
        .map((id) => world.signal(id))
        .filter((s) => s !== undefined)
        .map((s) => ({ id: s.id, kind: s.kind, survivors: s.survivors, clues: s.clues }));
      const result: ScanOutput = { sector, ticks: done.tick - started, signals };
      const lines = signals.length
        ? signals.map((s) => `${s.id}：${s.clues.join('；')}`)
        : ['未发现活跃信号'];
      return {
        content: [text(`${sector} 区扫描完成（${result.ticks} 秒）。\n${lines.join('\n')}`)],
        details: { sector },
        structuredContent: result,
      };
    },
  };
}

const StandByParams = Type.Object({ reason: Type.String({ description: '为什么本轮无需行动' }) });

export function standByTool(): AgentTool<typeof StandByParams> {
  return {
    name: 'stand_by',
    label: '待命',
    description: '本轮无需行动时调用，说明理由后结束本轮。',
    parameters: StandByParams,
    outputSchema: Type.Object({ reason: Type.String() }),
    executionMode: 'sequential',
    async execute(_id, { reason }) {
      return { content: [text(`已待命：${reason}`)], details: { reason }, structuredContent: { reason }, terminate: true };
    },
  };
}

export function waitForWorldEvent<T extends WorldEvent>(
  world: World,
  match: (ev: WorldEvent) => ev is T,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const off = world.subscribe(({ events }) => {
      const hit = events.find(match);
      if (hit) {
        cleanup();
        resolve(hit);
      }
    });
    const onAbort = () => {
      cleanup();
      reject(new Error('已中止'));
    };
    const cleanup = () => {
      off();
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function commanderTools(deps: ToolDeps): AgentTool<any>[] {
  return [scanSectorTool(deps), standByTool()];
}

export type { SectorId };
