// 指挥官工具：dispatch_drone（S）、allocate_fuel（S）、end_watch（S ⏹）、stand_by（S ⏹）。
// 审批（⚠）与预算拦截在 M3 由 beforeToolCall 策略链实现，这里只做世界的 preview 校验。
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import type { WorldEvent } from '@rescue/protocol';
import { inspectSignalTool, plotCourseTool, scanSectorTool } from './navigator.ts';
import { DroneParam, failure, normalizeDrone, normalizeSignal, prepare, SignalParam, text, waitForWorldEvent, type ToolDeps } from './shared.ts';

const DispatchParams = Type.Object({
  droneId: DroneParam,
  signalId: SignalParam,
  route: Type.Optional(Type.Union([Type.Literal('direct'), Type.Literal('safe')], { description: 'direct 直飞（默认）/ safe 绕开危险区' })),
});
const DispatchOutput = Type.Object({
  accepted: Type.Boolean(),
  droneId: Type.String(),
  signalId: Type.String(),
  route: Type.String(),
  fuel: Type.Number(),
  eta: Type.Number(),
  hazardous: Type.Boolean(),
  departTick: Type.Number(),
});

export function dispatchDroneTool(deps: ToolDeps): AgentTool<typeof DispatchParams> {
  return {
    name: 'dispatch_drone',
    label: '派出无人机',
    description: '派一架在港无人机前往信号救援。返回的是「已受理」回执；抵达与救援结果会以【站务】消息告知。',
    parameters: DispatchParams,
    outputSchema: DispatchOutput,
    executionMode: 'sequential',
    prepareArguments: prepare<Static<typeof DispatchParams>>({ droneId: normalizeDrone, signalId: normalizeSignal }),
    async execute(toolCallId, { droneId, signalId, route = 'direct' }, signal) {
      const world = deps.world;
      const accepted = world.enqueue({ type: 'dispatch', droneId, signalId, route, correlationId: toolCallId });
      if (!accepted.ok) return failure(`出动未受理：${accepted.reason}`, { droneId, signalId });
      // 命令在下一个 tick 生效：等到它真正出发，回执里的数字才是事实
      const ev = await waitForWorldEvent(
        world,
        (e): e is Extract<WorldEvent, { type: 'drone.dispatched' }> => e.type === 'drone.dispatched' && e.correlationId === toolCallId,
        signal,
      );
      const receipt = { accepted: true, droneId, signalId, route, fuel: ev.fuel, eta: ev.eta, hazardous: ev.hazardous, departTick: ev.tick };
      return {
        content: [text(`${droneId} 已出发前往 ${signalId}（${route === 'safe' ? '绕行' : '直飞'}），预计 ${ev.eta} 秒抵达，消耗燃料 ${ev.fuel}${ev.hazardous ? '，航线经过危险区' : ''}。`)],
        details: receipt,
        structuredContent: receipt,
      };
    },
  };
}

const AllocateParams = Type.Object({ signalId: SignalParam, amount: Type.Integer({ minimum: 1, maximum: 60, description: '预留燃料量' }) });

export function allocateFuelTool(deps: ToolDeps): AgentTool<typeof AllocateParams> {
  return {
    name: 'allocate_fuel',
    label: '预留燃料',
    description: '为某个信号预留燃料，其他出动不能动用这部分。',
    parameters: AllocateParams,
    outputSchema: Type.Object({ signalId: Type.String(), amount: Type.Number(), fuelAvailable: Type.Number() }),
    executionMode: 'sequential',
    prepareArguments: prepare<Static<typeof AllocateParams>>({ signalId: normalizeSignal }),
    async execute(_id, { signalId, amount }) {
      const world = deps.world;
      const accepted = world.enqueue({ type: 'allocate', signalId, amount, correlationId: _id });
      if (!accepted.ok) return failure(`预留未受理：${accepted.reason}`, { signalId, amount });
      const fuelAvailable = world.availableFuel() - amount;
      return {
        content: [text(`已为 ${signalId} 预留燃料 ${amount}，其余可用 ${fuelAvailable}。`)],
        details: { signalId, amount },
        structuredContent: { signalId, amount, fuelAvailable },
      };
    },
  };
}

const EndParams = Type.Object({ report: Type.String({ description: '交班报告：获救、错失、教训，三五句即可' }) });

export function endWatchTool(deps: ToolDeps): AgentTool<typeof EndParams> {
  return {
    name: 'end_watch',
    label: '交班',
    description: '提前结束本班次并提交交班报告。',
    parameters: EndParams,
    outputSchema: Type.Object({ report: Type.String(), tick: Type.Number() }),
    executionMode: 'sequential',
    async execute(_id, { report }) {
      const world = deps.world;
      const accepted = world.enqueue({ type: 'endWatch', report });
      if (!accepted.ok) return failure(`交班未受理：${accepted.reason}`);
      return { content: [text('交班报告已提交。')], details: { report }, structuredContent: { report, tick: world.tick } };
    },
  };
}

const StandByParams = Type.Object({ reason: Type.String({ description: '为什么本轮无需行动' }) });

export function standByTool(): AgentTool<typeof StandByParams> {
  return {
    name: 'stand_by',
    label: '待命',
    description: '本轮无需行动（或已安排好）时调用，说明理由后结束本轮。',
    parameters: StandByParams,
    outputSchema: Type.Object({ reason: Type.String() }),
    executionMode: 'sequential',
    async execute(_id, { reason }) {
      return { content: [text(`已待命：${reason}`)], details: { reason }, structuredContent: { reason } };
    },
  };
}

/**
 * M2 的指挥官工具表。scan_sector / inspect_signal / plot_course 暂借领航员的实现：
 * M5 有了 delegate 之后，scan_sector 只留给能看图的领航员。
 */
export function commanderTools(deps: ToolDeps): AgentTool<any>[] {
  return [
    scanSectorTool(deps),
    inspectSignalTool(deps),
    plotCourseTool(deps),
    dispatchDroneTool(deps),
    allocateFuelTool(deps),
    endWatchTool(deps),
    standByTool(),
  ];
}
