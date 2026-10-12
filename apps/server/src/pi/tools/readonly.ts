// 只读查询工具：供 run_script（codemode）在沙箱里组合调用（§5.8）。
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import { SECTOR_IDS } from '@rescue/protocol';
import { failure, normalizeSector, normalizeSignal, prepare, SectorParam, SignalParam, text, type ToolDeps } from './shared.ts';

const Empty = Type.Object({});

export function listSignalsTool(deps: ToolDeps): AgentTool<typeof Empty> {
  return {
    name: 'list_signals',
    label: '列出信号',
    description: '列出全部活跃信号（编号、星区、报告人数、剩余秒数、是否已扫描 / 研判）。',
    parameters: Empty,
    outputSchema: Type.Array(Type.Object({ id: Type.String(), sector: Type.String(), survivors: Type.Number(), remaining: Type.Number(), status: Type.String(), scanned: Type.Boolean(), judged: Type.Boolean() })),
    executionMode: 'parallel',
    async execute() {
      const snap = deps.world.snapshot();
      const list = snap.signals
        .filter((s) => s.status === 'active' || s.status === 'locked')
        .map((s) => ({ id: s.id, sector: s.sector, survivors: s.survivors, remaining: s.expiresTick - snap.tick, status: s.status, scanned: s.scanned, judged: s.clues.length > 0 }));
      return { content: [text(JSON.stringify(list))], details: {}, structuredContent: list };
    },
  };
}

const SectorOnly = Type.Object({ sector: SectorParam });

export function sectorHazardTool(deps: ToolDeps): AgentTool<typeof SectorOnly> {
  return {
    name: 'sector_hazard',
    label: '星区危险度',
    description: '查询星区当前危险度（0 安全，0.3 耀斑预警，1 耀斑中）。',
    parameters: SectorOnly,
    outputSchema: Type.Object({ sector: Type.String(), hazard: Type.Number() }),
    executionMode: 'parallel',
    prepareArguments: prepare<Static<typeof SectorOnly>>({ sector: normalizeSector }),
    async execute(_id, { sector }) {
      const r = { sector, hazard: deps.world.hazard(sector) };
      return { content: [text(JSON.stringify(r))], details: {}, structuredContent: r };
    },
  };
}

const SignalRoute = Type.Object({ signalId: SignalParam, route: Type.Optional(Type.Union([Type.Literal('direct'), Type.Literal('safe')])) });

export function fuelEstimateTool(deps: ToolDeps): AgentTool<typeof SignalRoute> {
  return {
    name: 'fuel_estimate',
    label: '燃料估算',
    description: '估算前往某信号的燃料消耗与可用燃料。',
    parameters: SignalRoute,
    outputSchema: Type.Object({ signalId: Type.String(), fuel: Type.Number(), available: Type.Number(), hazardous: Type.Boolean() }),
    executionMode: 'parallel',
    prepareArguments: prepare<Static<typeof SignalRoute>>({ signalId: normalizeSignal }),
    async execute(_id, { signalId, route = 'direct' }) {
      const plan = deps.world.plan(signalId, route);
      if (!plan) return failure(`不存在信号 ${signalId}`);
      const r = { signalId, fuel: plan.fuel, available: deps.world.availableFuel(signalId), hazardous: plan.route.hazardous };
      return { content: [text(JSON.stringify(r))], details: {}, structuredContent: r };
    },
  };
}

export function droneEtaTool(deps: ToolDeps): AgentTool<typeof SignalRoute> {
  return {
    name: 'drone_eta',
    label: '抵达时间',
    description: '估算无人机前往某信号需要的秒数，以及信号剩余秒数（是否来得及）。',
    parameters: SignalRoute,
    outputSchema: Type.Object({ signalId: Type.String(), eta: Type.Number(), remaining: Type.Number(), inTime: Type.Boolean() }),
    executionMode: 'parallel',
    prepareArguments: prepare<Static<typeof SignalRoute>>({ signalId: normalizeSignal }),
    async execute(_id, { signalId, route = 'direct' }) {
      const plan = deps.world.plan(signalId, route);
      const s = deps.world.signal(signalId);
      if (!plan || !s) return failure(`不存在信号 ${signalId}`);
      const remaining = s.expiresTick - deps.world.tick;
      const r = { signalId, eta: plan.ticks, remaining, inTime: plan.ticks < remaining };
      return { content: [text(JSON.stringify(r))], details: {}, structuredContent: r };
    },
  };
}

export { SECTOR_IDS };
