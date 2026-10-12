// 回合策略（§5.6）：finishTurn + prepareNextTurnWithContext + prepareRequest。
import type { AgentMessage, FinishTurn, PrepareRequest, PrepareNextTurnContext, AgentLoopTurnUpdate, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { CrewId } from '@rescue/protocol';
import { reportHook, type HookEnv } from './hooks/compose.ts';
import { briefFromWorld, worldEventMessage } from './messages.ts';

export interface TurnPolicyOptions {
  role: CrewId;
  baseThinking: ThinkingLevel;
  /** 收尾工具名：指挥官 stand_by，专家 report_back */
  commitTool: string;
  /** 临时换用的快模型 / 能看图的模型 */
  fastModel?: () => Model<Api>;
  visionModel?: () => Model<Api>;
  /** 船员本来的模型：临时换过之后要换回来（prepareRequest 的返回值对本次运行后续请求都生效） */
  baseModel?: () => Model<Api>;
}

export interface TurnPolicy {
  finishTurn: FinishTurn;
  prepareNextTurnWithContext: (ctx: PrepareNextTurnContext) => AgentLoopTurnUpdate | undefined;
  prepareRequest: PrepareRequest;
  requests(): number;
  reset(): void;
}

/** 危机：研判或分诊认为危急的活跃信号 ≥ 2 */
export function criticalSignals(env: HookEnv): string[] {
  return env.world
    .snapshot()
    .signals.filter((s) => (s.status === 'active' || s.status === 'locked') && (s.triage?.severity === 'critical' || s.clues.some((c) => c.includes('生命维持'))))
    .map((s) => s.id);
}

function hasFreshImages(messages: AgentMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant') return false;
    if (m.role === 'toolResult' && m.content.some((c) => c.type === 'image')) return true;
  }
  return false;
}

export function createTurnPolicy(env: HookEnv, opts: TurnPolicyOptions): TurnPolicy {
  let requests = 0;
  let nudgeNext = false;
  /** 危机模式升档前的档位；只有自己升过档才负责恢复（不覆盖主管或课程手动设置的档位） */
  let raisedFrom: ThinkingLevel | undefined;

  const finishTurn: FinishTurn = async (turn, signal) => {
    const t0 = performance.now();
    requests += 1;
    nudgeNext = false;
    let decision: { action: 'end' } | { action: 'continue' } | undefined;
    let why = 'default';
    const stop = turn.message.stopReason;
    // 1. 错误 / 中止：交给运行时统一处理（pi 也会忽略这里的决定）
    if (stop === 'error' || stop === 'aborted') why = `stopReason=${stop}`;
    // 2. 请求预算用尽
    else if (requests >= env.maxRequestsPerRun) {
      decision = { action: 'end' };
      why = `请求数 ${requests} 达到上限 ${env.maxRequestsPerRun}`;
    }
    // 3. 只说话没行动，且还有预算：再给一轮，并在下一轮前追加提醒
    else if (env.flags.nudge && turn.toolResults.length === 0 && !turn.message.content.some((c) => c.type === 'toolCall')) {
      decision = { action: 'continue' };
      nudgeNext = true;
      why = '只输出了文字，没有调用工具';
    }
    await env.stepper.gate(env.agentId, 'finishTurn', { requests, decision: decision?.action ?? 'default' }, signal);
    reportHook(env, 'finishTurn', { action: decision?.action ?? 'default', why, requests }, performance.now() - t0);
    return decision;
  };

  const prepareNextTurnWithContext = (): AgentLoopTurnUpdate | undefined => {
    if (!nudgeNext) return undefined;
    nudgeNext = false;
    const text = `请用工具行动；如果确实无需行动，请调用 ${opts.commitTool} 说明理由。`;
    reportHook(env, 'prepareNextTurn', { appended: text }, 0);
    return { messages: [worldEventMessage('nudge', text)] };
  };

  const prepareRequest: PrepareRequest = async ({ context, model, thinkingLevel }, signal) => {
    const t0 = performance.now();
    const update: { context?: typeof context; model?: Model<Api>; thinkingLevel?: ThinkingLevel } = {};
    const decision: Record<string, unknown> = {};
    await env.stepper.gate(env.agentId, 'prepareRequest', { model: model.id, thinkingLevel }, signal);

    // 1. 把最新那条 situation 的 brief 刷新为「请求时刻」的世界快照（排队期间世界已经变了）
    if (env.flags.situationRefresh) {
      const idx = context.messages.findLastIndex((m) => m.role === 'situation');
      const old = context.messages[idx];
      const brief = old && old.role === 'situation' ? briefFromWorld(env.world.snapshot()) : undefined;
      if (old && old.role === 'situation' && brief && JSON.stringify({ ...brief, tick: 0 }) !== JSON.stringify({ ...old.brief, tick: 0 })) {
        const messages = [...context.messages];
        messages[idx] = { ...old, tick: env.world.tick, brief };
        update.context = { ...context, messages };
        decision.refreshed = { from: old.tick, to: env.world.tick };
      }
    }
    // 2. 危机模式：≥ 2 个危急信号时升到 medium，解除后恢复
    if (opts.role === 'commander' && env.flags.crisisMode) {
      const critical = criticalSignals(env);
      if (critical.length >= 2 && raisedFrom === undefined && thinkingLevel !== 'medium' && thinkingLevel !== 'high') {
        raisedFrom = thinkingLevel;
        update.thinkingLevel = 'medium';
        decision.thinkingLevel = { to: 'medium', critical };
      } else if (critical.length < 2 && raisedFrom !== undefined) {
        update.thinkingLevel = raisedFrom;
        decision.thinkingLevel = { to: raisedFrom, reason: '危机解除' };
        raisedFrom = undefined;
      }
    }
    // 3. 第 10 课：临时换快模型；第 22 课：上下文里有未分析的图片而当前模型看不见 → 这一次请求换成 flash
    if (env.flags.fastModel && opts.fastModel) {
      update.model = opts.fastModel();
      decision.model = update.model.id;
    } else if (env.flags.visionSwitch && opts.visionModel && !model.input.includes('image') && hasFreshImages((update.context ?? context).messages)) {
      update.model = opts.visionModel();
      decision.model = `${update.model.id}（有图，换眼睛）`;
    } else if (opts.baseModel && model.id !== opts.baseModel().id) {
      update.model = opts.baseModel();
      decision.model = `${update.model.id}（换回）`;
    }
    reportHook(env, 'prepareRequest', Object.keys(decision).length ? decision : 'unchanged', performance.now() - t0);
    return Object.keys(update).length ? update : undefined;
  };

  return {
    finishTurn,
    prepareNextTurnWithContext,
    prepareRequest,
    requests: () => requests,
    reset() {
      requests = 0;
      nudgeNext = false;
    },
  };
}
