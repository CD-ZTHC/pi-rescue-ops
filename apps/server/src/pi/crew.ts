// CrewMember：组装一个船员的 Agent 与全部 hook（§5.1）。
import { Agent, type AgentMessage, type AgentTool, type ThinkingLevel } from '@earendil-works/pi-agent-core';
import { getCurrentSystemPrompt, getCurrentTools, isRetryableAssistantError, type AssistantMessage, type Tool } from '@earendil-works/pi-ai';
import type { CrewId, CrewView } from '@rescue/protocol';
import { CREW_COLORS } from '@rescue/protocol';
import type { Bus } from '../runtime/bus.ts';
import type { World } from '../world/sim.ts';
import { convertToLlm } from './messages.ts';
import { createRequestProbe, type ModelHub } from './models.ts';
import { observe } from './observe.ts';
import { renderBaseSystem, type PromptSpec } from './prompts.ts';
import { turnBudget } from './turn-policy.ts';

export interface CrewSpec extends PromptSpec {
  id: CrewId;
  model: string;
  thinkingLevel: ThinkingLevel;
  maxRequestsPerRun: number;
  tools: (deps: CrewDeps) => AgentTool<any>[];
}

export interface CrewDeps {
  hub: ModelHub;
  bus: Bus;
  world: World;
  missionId: string;
  flush?: () => Promise<void>;
}

export type Delivery = 'auto' | 'prompt' | 'steer' | 'followUp';

export interface CrewMember {
  readonly id: CrewId;
  readonly spec: CrewSpec;
  readonly agent: Agent;
  readonly runId: string;
  readonly isRunning: boolean;
  /** 空闲时 prompt；运行中按 mode 选择 steer / followUp（auto 视为 followUp） */
  deliver(messages: AgentMessage | AgentMessage[], mode: Delivery): 'prompt' | 'steer' | 'followUp';
  /** 运行并等待结束，返回本轮最后一条 assistant 消息 */
  run(messages: AgentMessage | AgentMessage[]): Promise<AssistantMessage | undefined>;
  /** 空闲时直接追加到上下文（不触发运行），下次运行时模型会看到 */
  append(message: AgentMessage): void;
  abort(): void;
  view(): CrewView;
  contextView(): Promise<{ systemPrompt: string; tools: string[]; messages: unknown[]; llmMessages: unknown[] }>;
}

const toToolDecl = (t: AgentTool<any>): Tool => ({ name: t.name, description: t.description, parameters: t.parameters });

export function createCrewMember(spec: CrewSpec, deps: CrewDeps): CrewMember {
  const probe = createRequestProbe();
  const tools = spec.tools(deps);
  const base = renderBaseSystem(spec, deps.world.snapshot());
  let lastError: string | undefined;
  let running = false;

  const budget = turnBudget(spec.maxRequestsPerRun, (hook, decision, durationMs) =>
    deps.bus.app({ kind: 'hook', agentId: spec.id, runId: observer.runId, hook, decision, durationMs }),
  );

  const agent = new Agent({
    initialState: {
      model: deps.hub.chat(spec.model),
      thinkingLevel: spec.thinkingLevel,
      tools,
      // 首条 system 消息直接声明 sections 与工具，避免 pi 再追加一条「工具变化」消息
      messages: [{ role: 'system', ...base, toolsAdded: tools.map(toToolDecl), timestamp: Date.now() }],
    },
    streamFn: deps.hub.createStreamFn(probe),
    convertToLlm,
    sessionId: `${deps.missionId}:${spec.id}`,
    toolExecution: 'parallel',
    steeringMode: 'all',
    followUpMode: 'all',
    finishTurn: budget.finishTurn,
    onProviderStreamEvent: probe.onProviderStreamEvent, // 必须同步、轻量
    maxRetryDelayMs: 8_000,
  });

  // 队列计数：pi 只提供 peekQueuedMessages，这里按消息对象身份记账，以便 UI 显示「插话 1 / 待办 2」
  const queued = { steer: new Set<AgentMessage>(), followUp: new Set<AgentMessage>() };
  const emitQueue = () =>
    deps.bus.app({ kind: 'queue', agentId: spec.id, steer: queued.steer.size, followUp: queued.followUp.size });

  const observer = observe(spec.id, {
    bus: deps.bus,
    probe,
    flush: deps.flush,
    onRun: (phase) => {
      running = phase === 'start';
      if (phase === 'start') budget.reset();
      deps.bus.app({ kind: 'crew', crew: [member.view()] });
    },
  });
  agent.subscribe(observer.listener);
  agent.subscribe((ev) => {
    if (ev.type === 'message_start' && (queued.steer.delete(ev.message) || queued.followUp.delete(ev.message))) emitQueue();
    if (ev.type === 'message_end' && ev.message.role === 'assistant') {
      lastError = ev.message.stopReason === 'error' ? ev.message.errorMessage : undefined;
    }
  });

  async function runToEnd(start: () => Promise<void>): Promise<AssistantMessage | undefined> {
    await start();
    let last = lastAssistant(agent.state.messages);
    // §2.4：请求失败时 prompt() 正常 resolve，必须检查 stopReason，不能依赖 try/catch
    if (last?.stopReason === 'error' && isRetryableAssistantError(last)) {
      deps.bus.app({ kind: 'notice', level: 'warn', text: `${spec.name}：${last.errorMessage ?? '请求失败'}，4 秒后重试一次` });
      await new Promise((r) => setTimeout(r, 4_000));
      // continue() 要求尾部不是 assistant：去掉失败的那条再续跑
      agent.state.messages = agent.state.messages.slice(0, -1);
      await agent.continue();
      last = lastAssistant(agent.state.messages);
    }
    if (last?.stopReason === 'error') {
      deps.bus.app({ kind: 'notice', level: 'error', text: `${spec.name} 失联：${last.errorMessage ?? agent.state.errorMessage ?? '未知错误'}` });
    }
    return last;
  }

  const member: CrewMember = {
    id: spec.id,
    spec,
    agent,
    get runId() {
      return observer.runId;
    },
    get isRunning() {
      return running || agent.state.isStreaming;
    },
    deliver(messages, mode) {
      const list = Array.isArray(messages) ? messages : [messages];
      // 空闲时无论哪种模式都直接开始一次运行
      if (!member.isRunning) {
        void member.run(list);
        return 'prompt';
      }
      const kind = mode === 'steer' ? 'steer' : 'followUp';
      for (const m of list) {
        if (kind === 'steer') agent.steer(m);
        else agent.followUp(m);
        queued[kind].add(m);
      }
      emitQueue();
      return kind;
    },
    run(messages) {
      running = true;
      return runToEnd(() => agent.prompt(messages)).finally(() => {
        running = agent.state.isStreaming;
      });
    },
    append(message) {
      if (member.isRunning) agent.followUp(message);
      else agent.state.messages = [...agent.state.messages, message];
    },
    abort() {
      agent.abort();
    },
    view() {
      const model = agent.state.model;
      return {
        id: spec.id,
        name: spec.name,
        title: spec.title,
        color: CREW_COLORS[spec.id],
        model: `${model.provider}/${model.id}`,
        thinkingLevel: agent.state.thinkingLevel,
        status: member.isRunning ? 'running' : lastError ? 'error' : 'idle',
        vision: model.input.includes('image'),
      };
    },
    async contextView() {
      const messages = agent.state.messages;
      const llm = await convertToLlm(messages);
      return {
        systemPrompt: getCurrentSystemPrompt(llm) ?? '',
        tools: getCurrentTools(llm).map((t) => t.name),
        messages: messages as unknown[],
        llmMessages: llm as unknown[],
      };
    },
  };
  return member;
}

function lastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant') return m;
  }
  return undefined;
}
