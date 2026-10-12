// 分诊台（§5.9）：新信号到达时用 classify() 给出严重度、紧急度、恶作剧概率。
import type { ClassifierAnswer, ClassifierQuestion } from '@earendil-works/pi-ai';
import type { ClassifierView, SignalView } from '@rescue/protocol';
import { SIGNAL_KIND_NAMES } from '@rescue/protocol';
import type { Bus } from '../runtime/bus.ts';
import type { World } from '../world/sim.ts';
import type { ModelHub } from './models.ts';

export const TRIAGE_QUESTIONS: Record<string, ClassifierQuestion> = {
  severity: { type: 'choice', instructions: '判断事故严重度', criteria: { minor: '轻微', serious: '严重', critical: '危急' } },
  urgency: { type: 'score', instructions: '多久内必须赶到', criteria: ['十分钟以上', '五到十分钟', '五分钟内', '立即'] },
  hoax: { type: 'bool', instructions: '这是否为恶作剧或诱饵信号', criteria: { true: '可疑', false: '可信' } },
};

export function toView(answers: Record<string, ClassifierAnswer>): ClassifierView {
  const sev = answers.severity;
  const urg = answers.urgency;
  const hoax = answers.hoax;
  return {
    severity: sev?.type === 'choice' ? sev.probabilities : {},
    severityChoice: sev?.type === 'choice' ? sev.choice : 'unknown',
    urgency: urg?.type === 'score' ? urg.score : 0,
    urgencyConfidence: urg?.type === 'score' ? urg.confidence : 0,
    hoax: hoax?.type === 'bool' ? hoax.probability : 0,
  };
}

export async function triageSignal(hub: ModelHub, world: World, bus: Bus, signal: SignalView, radio: string): Promise<ClassifierView | undefined> {
  const t0 = performance.now();
  const model = hub.triageModel();
  const result = await hub.models.classify(model, {
    state: {
      id: signal.id,
      sector: signal.sector,
      kind: signal.kind,
      kindName: SIGNAL_KIND_NAMES[signal.kind],
      survivors: signal.survivors,
      remaining: signal.expiresTick - world.tick,
      radio,
    },
    questions: TRIAGE_QUESTIONS,
  });
  const durationMs = performance.now() - t0;
  // classify() 从不 reject：错误在 stopReason 里（§10：信号标为「未分诊」，指挥官照常被唤醒）
  if (result.stopReason !== 'stop') {
    bus.app({ kind: 'triage', signalId: signal.id, result: { severity: {}, severityChoice: 'unknown', urgency: 0, urgencyConfidence: 0, hoax: 0, error: result.errorMessage ?? result.stopReason }, samples: hub.triageSamples, durationMs, model: model.id });
    return undefined;
  }
  const view = { ...toView(result.answers), cost: result.usage?.cost.total };
  world.setTriage(signal.id, { severity: view.severityChoice, urgency: view.urgency, hoax: view.hoax });
  bus.app({ kind: 'triage', signalId: signal.id, result: view, samples: hub.triageSamples, durationMs, model: model.id });
  return view;
}

/** 紧急：分诊为危急，或紧急度「立即」 */
export const isUrgentTriage = (v: ClassifierView | undefined) => !!v && (v.severityChoice === 'critical' || v.urgency >= 3);
