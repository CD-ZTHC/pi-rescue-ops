// 领航员工具：scan_sector（雷达成像，↻）、compare_frames（两帧对比）、inspect_signal（文字线索）、plot_course（航线）。
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import { formatTick, type SectorId, type WorldEvent } from '@rescue/protocol';
import { renderCloseFrame, renderRadar, type RadarBlip } from '../../world/render/radar.ts';
import type { World } from '../../world/sim.ts';
import {
  failure,
  image,
  normalizeSector,
  normalizeSignal,
  prepare,
  SectorParam,
  SignalParam,
  text,
  waitForWorldEvent,
  type ToolDeps,
} from './shared.ts';

function blipsFor(world: World, sector: SectorId, tick: number, ids: string[]): RadarBlip[] {
  return ids.flatMap((id) => {
    const truth = world.truthOf(id);
    const point = world.signalPointAt(id, tick);
    return truth && point ? [{ id, point, hoax: truth.hoax, drift: truth.drift }] : [];
  });
}

const ScanParams = Type.Object({ sector: SectorParam });
const ScanOutput = Type.Object({
  sector: Type.String(),
  ticks: Type.Number(),
  signals: Type.Array(Type.String()),
  partial: Type.Boolean(),
  frameTick: Type.Number(),
  imageHash: Type.String(),
});

export function scanSectorTool(deps: ToolDeps): AgentTool<typeof ScanParams> {
  return {
    name: 'scan_sector',
    label: '扫描星区',
    description: '对一个星区做主动扫描（耗时 3–6 秒），返回该区的雷达成像。信号真伪的热信号特征只能从图像判读。',
    parameters: ScanParams,
    outputSchema: ScanOutput,
    executionMode: 'parallel',
    prepareArguments: prepare<Static<typeof ScanParams>>({ sector: normalizeSector }),
    async execute(toolCallId, { sector }, signal, onUpdate) {
      const world = deps.world;
      const accepted = world.enqueue({ type: 'scan', sector, correlationId: toolCallId });
      if (!accepted.ok) return failure(`扫描未受理：${accepted.reason}`, { sector });
      const eta = accepted.etaTicks ?? 1;
      const start = world.tick + 1;
      onUpdate?.({ content: [text(`${sector} 区扫描已受理，预计 ${eta} 秒`)], details: { progress: 0, eta } });
      const done = await waitForWorldEvent(
        world,
        (ev): ev is Extract<WorldEvent, { type: 'scan.completed' }> => ev.type === 'scan.completed' && ev.correlationId === toolCallId,
        signal,
        (tick) => {
          const progress = Math.min(0.99, (tick - start + 1) / eta);
          onUpdate?.({ content: [text(`${sector} 区扫描中 ${Math.round(progress * 100)}%`)], details: { progress, eta } });
        },
      );
      const img = renderRadar({
        seed: world.seed,
        tick: done.tick,
        sector,
        hazard: world.hazard(sector),
        partial: done.partial,
        blips: blipsFor(world, sector, done.tick, done.signalIds),
      });
      const { content: picture, hash } = image(img);
      const structured = { sector, ticks: done.tick - start + 1, signals: done.signalIds, partial: done.partial, frameTick: done.tick, imageHash: hash };
      const ids = done.signalIds.length ? done.signalIds.join('、') : '无';
      if (done.partial) {
        return {
          content: [text(`${sector} 区扫描不完整：传感器受损，只获得前半扇区数据（${formatTick(done.tick)}）。已探测信号：${ids}。`), picture],
          details: { sector, partial: true },
          structuredContent: structured,
          isError: true,
        };
      }
      return {
        content: [text(`${sector} 区雷达成像（${formatTick(done.tick)}）。区内信号：${ids}。热信号特征请看图判读。`), picture],
        details: { sector },
        structuredContent: structured,
      };
    },
  };
}

const SignalOnly = Type.Object({ signalId: SignalParam });

export function compareFramesTool(deps: ToolDeps): AgentTool<typeof SignalOnly> {
  return {
    name: 'compare_frames',
    label: '两帧对比',
    description: '返回同一信号相隔约 30 秒的两帧精扫图（以固定参考点为中心）。真实遇险船会漂移，恶作剧信标通常静止。',
    parameters: SignalOnly,
    outputSchema: Type.Object({ signalId: Type.String(), frames: Type.Array(Type.Number()), imageHashes: Type.Array(Type.String()) }),
    executionMode: 'parallel',
    prepareArguments: prepare<Static<typeof SignalOnly>>({ signalId: normalizeSignal }),
    async execute(_id, { signalId }) {
      const world = deps.world;
      const s = world.signal(signalId);
      const truth = world.truthOf(signalId);
      if (!s || !truth) return failure(`不存在信号 ${signalId}`);
      if (world.module('sensors').status === 'offline') return failure('传感器离线，无法精扫');
      const now = world.tick;
      const earlier = Math.max(s.spawnedTick, now - 30);
      if (now - earlier < 10) return failure(`${signalId} 刚出现，至少 10 秒后才能对比`, { signalId });
      const center = world.signalPointAt(signalId, earlier)!;
      const frames = [earlier, now].map((tick, i) =>
        image(
          renderCloseFrame({
            seed: world.seed,
            tick,
            label: i === 0 ? 'FRAME A' : 'FRAME B',
            center,
            blip: { id: signalId, point: world.signalPointAt(signalId, tick)!, hoax: truth.hoax, drift: truth.drift },
          }),
        ),
      );
      return {
        content: [text(`${signalId} 精扫两帧：A=${formatTick(earlier)}，B=${formatTick(now)}，画面中心为同一参考点。`), frames[0].content, frames[1].content],
        details: { signalId },
        structuredContent: { signalId, frames: [earlier, now], imageHashes: frames.map((f) => f.hash) },
      };
    },
  };
}

const InspectOutput = Type.Object({
  signalId: Type.String(),
  sector: Type.String(),
  kind: Type.String(),
  reportedSurvivors: Type.Number(),
  remaining: Type.Number(),
  status: Type.String(),
  clues: Type.Array(Type.String()),
});

export function inspectSignalTool(deps: ToolDeps): AgentTool<typeof SignalOnly> {
  return {
    name: 'inspect_signal',
    label: '研判信号',
    description: '分析一个信号的应答码与遥测，返回真实度线索（文字）。',
    parameters: SignalOnly,
    outputSchema: InspectOutput,
    executionMode: 'parallel',
    prepareArguments: prepare<Static<typeof SignalOnly>>({ signalId: normalizeSignal }),
    async execute(_id, { signalId }) {
      const world = deps.world;
      const s = world.signal(signalId);
      const clues = world.inspect(signalId);
      if (!s || !clues) return failure(`不存在信号 ${signalId}`);
      const remaining = Math.max(0, s.expiresTick - world.tick);
      const result = { signalId, sector: s.sector, kind: s.kind, reportedSurvivors: s.survivors, remaining, status: s.status, clues };
      return {
        content: [text(`${signalId}（${s.sector} 区，报告 ${s.survivors} 人，剩余 ${remaining} 秒）：${clues.join('；')}`)],
        details: result,
        structuredContent: result,
      };
    },
  };
}

const CourseParams = Type.Object({ signalId: SignalParam });
const RouteOut = Type.Object({
  kind: Type.String(),
  eta: Type.Number(),
  fuel: Type.Number(),
  hazardous: Type.Boolean(),
  hazardShare: Type.Number(),
  hazardSectors: Type.Array(Type.String()),
});

export function plotCourseTool(deps: ToolDeps): AgentTool<typeof CourseParams> {
  return {
    name: 'plot_course',
    label: '规划航线',
    description: '为前往某个信号规划直飞（direct）与绕行（safe）两条航线，返回耗时、燃料与风险。',
    parameters: CourseParams,
    outputSchema: Type.Object({ signalId: Type.String(), routes: Type.Array(RouteOut), recommended: Type.String(), fuelAvailable: Type.Number() }),
    executionMode: 'parallel',
    prepareArguments: prepare<Static<typeof CourseParams>>({ signalId: normalizeSignal }),
    async execute(_id, { signalId }) {
      const world = deps.world;
      const direct = world.plan(signalId, 'direct');
      const safe = world.plan(signalId, 'safe');
      if (!direct || !safe) return failure(`不存在信号 ${signalId}`);
      const routes = (
        [
          ['direct', direct],
          ['safe', safe],
        ] as const
      ).map(([kind, p]) => ({
        kind,
        eta: p.ticks,
        fuel: p.fuel,
        hazardous: p.route.hazardous,
        hazardShare: Math.round(p.hazardFraction * 100) / 100,
        hazardSectors: p.hazardSectors,
      }));
      const recommended = safe.hazardFraction < direct.hazardFraction ? 'safe' : 'direct';
      const fuelAvailable = world.availableFuel(signalId);
      const line = (r: (typeof routes)[number]) =>
        `${r.kind === 'direct' ? '直飞' : '绕行'}：${r.eta} 秒，燃料 ${r.fuel}${r.hazardous ? `，${Math.round(r.hazardShare * 100)}% 航程在危险区（${r.hazardSectors.join('、')}）` : ''}`;
      const target = world.signal(signalId)!;
      return {
        content: [text(`前往 ${signalId}（距站 ${Math.round(target.pos.radius)}）：\n${routes.map(line).join('\n')}\n建议：${recommended === 'safe' ? '绕行' : '直飞'}；可用燃料 ${fuelAvailable}`)],
        details: { signalId },
        structuredContent: { signalId, routes, recommended, fuelAvailable },
      };
    },
  };
}

export function navigatorTools(deps: ToolDeps): AgentTool<any>[] {
  return [scanSectorTool(deps), compareFramesTool(deps), inspectSignalTool(deps), plotCourseTool(deps)];
}
