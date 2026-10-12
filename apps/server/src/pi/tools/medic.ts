// 医疗官工具：assess_survivors（文字分级）、read_vitals（体征波形图）、prepare_medbay（安排床位）。
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from 'typebox';
import { formatTick, type WorldEvent } from '@rescue/protocol';
import { renderVitals } from '../../world/render/vitals.ts';
import { failure, image, prepare, text, waitForWorldEvent, type ToolDeps } from './shared.ts';

const PatientParam = Type.String({ pattern: '^P-\\d{2,}$', description: '伤员组编号，如 P-01' });
const normalizePatient = (raw: unknown) => {
  const m = typeof raw === 'string' || typeof raw === 'number' ? String(raw).match(/(\d+)/) : null;
  return m ? `P-${m[1].padStart(2, '0')}` : raw;
};

const AssessParams = Type.Object({ patientId: Type.Optional(PatientParam) });
const PatientOut = Type.Object({ id: Type.String(), signalId: Type.String(), count: Type.Number(), pending: Type.Array(Type.Number()), deadlineIn: Type.Number() });

export function assessSurvivorsTool(deps: ToolDeps): AgentTool<typeof AssessParams> {
  return {
    name: 'assess_survivors',
    label: '伤员分级',
    description: '查看已接回的伤员组：人数、哪些成员需要进一步评估。不指定编号则列出全部待处置的组。',
    parameters: AssessParams,
    outputSchema: Type.Object({ patients: Type.Array(PatientOut), beds: Type.Number() }),
    executionMode: 'parallel',
    prepareArguments: prepare<Static<typeof AssessParams>>({ patientId: normalizePatient }),
    async execute(_id, { patientId }) {
      const world = deps.world;
      const snap = world.snapshot();
      const list = snap.patients.filter((p) => (patientId ? p.id === patientId : p.members.some((m) => m.status === 'unknown')));
      if (patientId && list.length === 0) return failure(`不存在伤员组 ${patientId}`);
      const patients = list.map((p) => ({
        id: p.id,
        signalId: p.signalId,
        count: p.count,
        pending: p.members.filter((m) => m.status === 'unknown').map((m) => m.index),
        deadlineIn: Math.max(0, p.deadlineTick - snap.tick),
      }));
      const lines = patients.map(
        (p) =>
          `${p.id}（来自 ${p.signalId}）：共 ${p.count} 人；${p.count - p.pending.length} 人意识清醒、可自行行走；${
            p.pending.length ? `成员 ${p.pending.join('、')} 状况不明，需看体征（${p.deadlineIn} 秒内决定）` : '无待评估成员'
          }`,
      );
      return {
        content: [text(lines.length ? `${lines.join('\n')}\n医疗舱空床 ${snap.beds}` : `没有待处置的伤员。医疗舱空床 ${snap.beds}`)],
        details: { patients },
        structuredContent: { patients, beds: snap.beds },
      };
    },
  };
}

const VitalsParams = Type.Object({ patientId: PatientParam });

export function readVitalsTool(deps: ToolDeps): AgentTool<typeof VitalsParams> {
  return {
    name: 'read_vitals',
    label: '读取体征',
    description: '读取伤员组中待评估成员的心电与血氧波形图。危急者只能从波形异常看出（心律不齐、血氧持续下降）。',
    parameters: VitalsParams,
    outputSchema: Type.Object({ patientId: Type.String(), members: Type.Array(Type.Number()), frameTick: Type.Number(), imageHash: Type.String() }),
    executionMode: 'parallel',
    prepareArguments: prepare<Static<typeof VitalsParams>>({ patientId: normalizePatient }),
    async execute(_id, { patientId }) {
      const world = deps.world;
      const p = world.patient(patientId);
      const truth = world.patientMembersTruth(patientId);
      if (!p || !truth) return failure(`不存在伤员组 ${patientId}`);
      const members = p.members.filter((m) => m.status === 'unknown').map((m) => m.index);
      if (members.length === 0) return failure(`${patientId} 没有待评估的成员`, { patientId });
      const tick = world.tick;
      const { content, hash } = image(
        renderVitals({ seed: world.seed, tick, patientId, members: members.map((index) => ({ index, critical: truth[index - 1] })) }),
      );
      return {
        content: [text(`${patientId} 体征（${formatTick(tick)}）：成员 ${members.join('、')}，每行左侧心电、右侧血氧趋势（虚线为 90%）。`), content],
        details: { patientId },
        structuredContent: { patientId, members, frameTick: tick, imageHash: hash },
      };
    },
  };
}

const BedParams = Type.Object({ patientId: PatientParam, members: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1, description: '要入住医疗舱的成员序号' }) });

export function prepareMedbayTool(deps: ToolDeps): AgentTool<typeof BedParams> {
  return {
    name: 'prepare_medbay',
    label: '安排床位',
    description: '为伤员组中的指定成员安排医疗舱床位。床位有限，只给危急者。',
    parameters: BedParams,
    outputSchema: Type.Object({ patientId: Type.String(), members: Type.Array(Type.Number()), bedsLeft: Type.Number() }),
    executionMode: 'sequential',
    prepareArguments: prepare<Static<typeof BedParams>>({ patientId: normalizePatient }),
    async execute(toolCallId, { patientId, members }, signal) {
      const world = deps.world;
      const accepted = world.enqueue({ type: 'bed', patientId, members, correlationId: toolCallId });
      if (!accepted.ok) return failure(`收治未受理：${accepted.reason}`, { patientId, members });
      await waitForWorldEvent(
        world,
        (e): e is Extract<WorldEvent, { type: 'patient.bedded' }> => e.type === 'patient.bedded' && e.correlationId === toolCallId,
        signal,
      );
      const result = { patientId, members, bedsLeft: world.snapshot().beds };
      return { content: [text(`${patientId} 成员 ${members.join('、')} 已入住医疗舱，剩余空床 ${result.bedsLeft}。`)], details: result, structuredContent: result };
    },
  };
}

export function medicTools(deps: ToolDeps): AgentTool<any>[] {
  return [assessSurvivorsTool(deps), readVitalsTool(deps), prepareMedbayTool(deps)];
}
