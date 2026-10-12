// 工程师工具：diagnose_module（读数，无画面）、inspect_camera（监控画面）、repair_module（长任务 ↻）、vent_section（⚠）。
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import { formatTick, MODULE_NAMES, type WorldEvent } from '@rescue/protocol';
import { renderCamera } from '../../world/render/camera.ts';
import { failure, image, ModuleParam, normalizeCell, normalizeModule, prepare, text, waitForWorldEvent, type ToolDeps } from './shared.ts';

const ModuleOnly = Type.Object({ module: ModuleParam });

const READINGS = {
  fire: { temperatureC: 78, pressureKPa: 99, airQuality: '颗粒物超标' },
  smoke: { temperatureC: 31, pressureKPa: 100, airQuality: '能见度低' },
  breach: { temperatureC: 12, pressureKPa: 61, airQuality: '正常' },
  none: { temperatureC: 22, pressureKPa: 101, airQuality: '正常' },
} as const;

export function diagnoseModuleTool(deps: ToolDeps): AgentTool<typeof ModuleOnly> {
  return {
    name: 'diagnose_module',
    label: '诊断舱段',
    description: '读取舱段的状态与传感读数（温度、气压、空气质量）。只有读数，看不到事故位置。',
    parameters: ModuleOnly,
    outputSchema: Type.Object({
      module: Type.String(),
      status: Type.String(),
      alarm: Type.Union([Type.String(), Type.Null()]),
      readings: Type.Object({ temperatureC: Type.Number(), pressureKPa: Type.Number(), airQuality: Type.String() }),
      repairing: Type.Boolean(),
    }),
    executionMode: 'parallel',
    prepareArguments: prepare<Static<typeof ModuleOnly>>({ module: normalizeModule }),
    async execute(_id, { module }) {
      const world = deps.world;
      const m = world.module(module);
      const readings = READINGS[world.incidentOf(module)?.kind ?? 'none'];
      const result = { module, status: m.status, alarm: m.alarm ?? null, readings: { ...readings }, repairing: !!m.repair };
      const st = m.status === 'ok' ? '正常' : m.status === 'damaged' ? '受损' : '离线';
      return {
        content: [text(`${m.name}：${st}${m.alarm ? `，${m.alarm}` : ''}${m.repair ? '，修复中' : ''}。温度 ${readings.temperatureC}°C，气压 ${readings.pressureKPa} kPa，空气 ${readings.airQuality}。`)],
        details: result,
        structuredContent: result,
      };
    },
  };
}

export function inspectCameraTool(deps: ToolDeps): AgentTool<typeof ModuleOnly> {
  return {
    name: 'inspect_camera',
    label: '查看监控',
    description: '调取舱段的俯视监控画面（4×3 网格，A1–D3）。火点、烟雾、破口的位置只能从画面看出。',
    parameters: ModuleOnly,
    outputSchema: Type.Object({ module: Type.String(), frameTick: Type.Number(), imageHash: Type.String() }),
    executionMode: 'parallel',
    prepareArguments: prepare<Static<typeof ModuleOnly>>({ module: normalizeModule }),
    async execute(_id, { module }) {
      const world = deps.world;
      if (world.module('comms').status === 'offline') return failure('通讯离线，监控信号中断', { module });
      const tick = world.tick;
      const { content, hash } = image(renderCamera({ seed: world.seed, tick, module, incident: world.incidentOf(module) }));
      return {
        content: [text(`${MODULE_NAMES[module]}监控画面（${formatTick(tick)}，网格 A1–D3）。`), content],
        details: { module },
        structuredContent: { module, frameTick: tick, imageHash: hash },
      };
    },
  };
}

export function repairModuleTool(deps: ToolDeps): AgentTool<typeof ModuleOnly> {
  return {
    name: 'repair_module',
    label: '修复舱段',
    description: '修复受损或离线的舱段（长任务，按秒回报进度）。起火的舱段必须先排空处置。',
    parameters: ModuleOnly,
    outputSchema: Type.Object({ module: Type.String(), ticks: Type.Number(), status: Type.String() }),
    executionMode: 'sequential',
    prepareArguments: prepare<Static<typeof ModuleOnly>>({ module: normalizeModule }),
    async execute(toolCallId, { module }, signal, onUpdate) {
      const world = deps.world;
      const accepted = world.enqueue({ type: 'repair', module, correlationId: toolCallId });
      if (!accepted.ok) return failure(`修复未受理：${accepted.reason}`, { module });
      const eta = accepted.etaTicks ?? 1;
      const start = world.tick + 1;
      onUpdate?.({ content: [text(`${MODULE_NAMES[module]}修复已开始，预计 ${eta} 秒`)], details: { progress: 0, eta } });
      try {
        const done = await waitForWorldEvent(
          world,
          (ev): ev is Extract<WorldEvent, { type: 'module.repaired' }> => ev.type === 'module.repaired' && ev.correlationId === toolCallId,
          signal,
          (tick) => {
            const m = world.module(module);
            if (tick > start && m.repair?.correlationId !== toolCallId) return '修复被打断（舱段再次受损）';
            const progress = Math.min(0.99, (tick - start + 1) / eta);
            onUpdate?.({ content: [text(`${MODULE_NAMES[module]}修复 ${Math.round(progress * 100)}%`)], details: { progress, eta } });
          },
        );
        const result = { module, ticks: done.tick - start + 1, status: 'ok' };
        return { content: [text(`${MODULE_NAMES[module]}已修复（${result.ticks} 秒）。`)], details: result, structuredContent: result };
      } catch (err) {
        if (signal?.aborted) throw err;
        return failure(`${MODULE_NAMES[module]}${(err as Error).message}`, { module });
      }
    },
  };
}

const VentParams = Type.Object({ module: ModuleParam, cell: Type.String({ pattern: '^[A-D][1-3]$', description: '要排空的网格，如 C2' }) });

export function ventSectionTool(deps: ToolDeps): AgentTool<typeof VentParams> {
  return {
    name: 'vent_section',
    label: '排空区段',
    description: '对舱段的一个网格区段排空灭火 / 排烟。危险操作：排错区段会造成人员风险。',
    parameters: VentParams,
    outputSchema: Type.Object({ module: Type.String(), cell: Type.String(), success: Type.Boolean() }),
    executionMode: 'sequential',
    prepareArguments: prepare<Static<typeof VentParams>>({ module: normalizeModule, cell: normalizeCell }),
    async execute(toolCallId, { module, cell }, signal) {
      const world = deps.world;
      const accepted = world.enqueue({ type: 'vent', module, cell, correlationId: toolCallId });
      if (!accepted.ok) return failure(`排空未受理：${accepted.reason}`, { module, cell });
      const ev = await waitForWorldEvent(
        world,
        (e): e is Extract<WorldEvent, { type: 'vent.result' }> => e.type === 'vent.result' && e.correlationId === toolCallId,
        signal,
      );
      const result = { module, cell, success: ev.success };
      if (!ev.success) {
        return { content: [text(`${MODULE_NAMES[module]} ${cell} 排空后未发现火源/烟雾：已造成人员风险。`)], details: result, structuredContent: result, isError: true };
      }
      return { content: [text(`${MODULE_NAMES[module]} ${cell} 已排空，险情解除，可以开始修复。`)], details: result, structuredContent: result };
    },
  };
}

export function engineerTools(deps: ToolDeps): AgentTool<any>[] {
  return [diagnoseModuleTool(deps), inspectCameraTool(deps), repairModuleTool(deps), ventSectionTool(deps)];
}
