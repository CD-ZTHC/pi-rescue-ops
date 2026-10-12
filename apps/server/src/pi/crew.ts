// CrewMember：组装一个船员的 Agent 与全部 hook（§5.1）。
import { Agent, runToolCall, type AgentMessage, type AgentTool, type ThinkingLevel } from '@earendil-works/pi-agent-core';
import { getCurrentSystemPrompt, getCurrentTools, isRetryableAssistantError, type AssistantMessage, type JsonValue, type Tool } from '@earendil-works/pi-ai';
import type { CrewId, CrewView, PolicyFlags, ToolMeta } from '@rescue/protocol';
import { CREW_COLORS, TOOL_FLAGS } from '@rescue/protocol';
import type { Bus } from '../runtime/bus.ts';
import type { World } from '../world/sim.ts';
import { audit, markStart, redact, terminateOnCommit } from './hooks/after.ts';
import { dangerApproval, type ApprovalCenter } from './hooks/approval.ts';
import { composeAfter, composeBefore, type HookEnv } from './hooks/compose.ts';
import { budgetGuard, staleGuard } from './hooks/guards.ts';
import { stepGate, type Stepper } from './hooks/step-gate.ts';
import { convertToLlm } from './messages.ts';
import { createRequestProbe, type ModelHub } from './models.ts';
import { observe } from './observe.ts';
import { renderBaseSystem, type PromptSpec } from './prompts.ts';
import { createTurnPolicy } from './turn-policy.ts';

export interface CrewSpec extends PromptSpec {
  id: CrewId;
  model: string;
  thinkingLevel: ThinkingLevel;
  maxRequestsPerRun: number;
  tools: (deps: CrewDeps) => AgentTool<any>[];
  /** 收尾工具：指挥官 stand_by，专家 report_back */
  commitTool: string;
}

export interface CrewDeps {
  hub: ModelHub;
  bus: Bus;
  world: World;
  missionId: string;
  /** 所有船员共享同一个开关对象：改一处，全员生效 */
  flags: PolicyFlags;
  stepper: Stepper;
  approvals: ApprovalCenter;
  flush?: () => Promise<void>;
  /** 其他船员（delegate 用） */
  crew?: (id: CrewId) => CrewMember | undefined;
  /** 视图裁剪（M4） */
  transformContext?: (spec: CrewSpec) => ((messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>) | undefined;
  /** 运行结束、确实空闲之后（压缩、溢出恢复都在这里，M4） */
  afterRun?: (member: CrewMember, last: AssistantMessage | undefined) => Promise<void>;
  /** 子 Agent 的事件冒泡到父工具调用时的 parentToolCallId（M5） */
  parentToolCallId?: () => string | undefined;
}

export type Delivery = 'auto' | 'prompt' | 'steer' | 'followUp';

export interface QueueState {
  steer: number;
  followUp: number;
  preview: string[];
}

export interface CrewMember {
  readonly id: CrewId;
  readonly spec: CrewSpec;
  readonly agent: Agent;
  readonly runId: string;
  readonly isRunning: boolean;
  readonly hooks: Pick<Agent, 'beforeToolCall' | 'afterToolCall'>;
  /** 空闲时 prompt；运行中按 mode 选择 steer / followUp（auto 视为 followUp） */
  deliver(messages: AgentMessage | AgentMessage[], mode: Delivery): 'prompt' | 'steer' | 'followUp';
  /** 运行并等待结束，返回本轮最后一条 assistant 消息 */
  run(messages: AgentMessage | AgentMessage[]): Promise<AssistantMessage | undefined>;
  /** 追加到上下文但不触发运行：空闲时立即追加；运行中先暂存，运行结束后追加（避免 followUp 引发额外请求） */
  append(message: AgentMessage): void;
  abort(): void;
  queue(): QueueState;
  setQueueModes(steering: 'all' | 'one-at-a-time', followUp: 'all' | 'one-at-a-time'): void;
  /** 最近一次 report_back 的结构化结果（只能从 tool_execution_end 事件拿到，§2.4） */
  lastReport(): Record<string, unknown> | undefined;
  /** 动态工具（M4）：替换可执行工具表，pi 会在下一次请求前写入一条工具差异 system 消息 */
  setTools(tools: AgentTool<any>[]): void;
  /** 按可用性过滤完整工具表（舱段受损时工具消失，修复后回来）；返回是否有变化 */
  syncTools(available: (name: string) => boolean): boolean;
  /** 加入额外工具（M6：地面站 MCP 工具）；同名替换 */
  addTools(extra: AgentTool<any>[]): void;
  removeTools(names: string[]): void;
  /** system sections 补丁：在下一次 prompt / steer / followUp 的消息批次前插入（§5.3） */
  patchSections(sections: Record<string, string | null>): void;
  /** 被委派时记录父工具调用（事件带 parentToolCallId，Inspector 据此嵌套） */
  setParent(toolCallId: string | undefined): void;
  /** 工具试验台：用 runToolCall 执行，经过与模型调用完全相同的 hook */
  bench(tool: string, args: unknown): ReturnType<typeof runToolCall>;
  view(): CrewView;
  contextView(): Promise<{ systemPrompt: string; tools: string[]; messages: unknown[]; llmMessages: unknown[] }>;
}

export const toToolDecl = (t: AgentTool<any>): Tool => ({ name: t.name, description: t.description, parameters: t.parameters });

const preview = (m: AgentMessage): string => {
  if (m.role === 'operator' || m.role === 'world_event') return m.text;
  if (m.role === 'situation') return `态势（${m.reasons.join('、')}）`;
  if (m.role === 'user') return typeof m.content === 'string' ? m.content : '[多段内容]';
  return m.role;
};

export function createCrewMember(spec: CrewSpec, deps: CrewDeps): CrewMember {
  const probe = createRequestProbe();
  let tools = spec.tools(deps);
  let allTools = tools;
  let pendingSections: Record<string, string | null> | undefined;
  let parent: string | undefined;
  const withSections = (list: AgentMessage[]): AgentMessage[] => {
    if (!pendingSections) return list;
    const sys: AgentMessage = { role: 'system', content: '', sections: pendingSections, timestamp: Date.now() };
    pendingSections = undefined;
    return [sys, ...list];
  };
  const base = renderBaseSystem(spec, deps.world.snapshot());
  let lastError: string | undefined;
  let running = false;
  let deferred: AgentMessage[] = [];
  let report: Record<string, unknown> | undefined;
  const meta = (list: AgentTool<any>[]): ToolMeta[] =>
    list.map((t) => ({
      name: t.name,
      label: t.label,
      description: t.description,
      executionMode: t.executionMode,
      flags: [...(t.outputSchema ? ['OS'] : []), ...(TOOL_FLAGS[t.name] ?? [])],
      parameters: t.parameters,
    }));
  let toolMeta = meta(tools);

  const env: HookEnv = {
    agentId: spec.id,
    bus: deps.bus,
    world: deps.world,
    flags: deps.flags,
    stepper: deps.stepper,
    approvals: deps.approvals,
    runId: () => observer.runId,
    requestsInRun: () => turns.requests(),
    maxRequestsPerRun: spec.maxRequestsPerRun,
  };
  const turns = createTurnPolicy(env, {
    role: spec.id,
    baseThinking: spec.thinkingLevel,
    commitTool: spec.commitTool,
    fastModel: () => deps.hub.chat(deps.hub.config.specialistModel),
    visionModel: () => deps.hub.chat(deps.hub.config.specialistModel),
    baseModel: () => deps.hub.chat(spec.model),
  });
  const beforeToolCall = composeBefore(env, stepGate, staleGuard, budgetGuard, dangerApproval, markStart);
  const afterToolCall = composeAfter(env, audit, redact, terminateOnCommit);

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
    transformContext: deps.transformContext?.(spec),
    sessionId: `${deps.missionId}:${spec.id}`,
    toolExecution: 'parallel',
    steeringMode: 'all',
    followUpMode: 'all',
    beforeToolCall,
    afterToolCall,
    finishTurn: turns.finishTurn,
    prepareNextTurnWithContext: turns.prepareNextTurnWithContext,
    prepareRequest: turns.prepareRequest,
    onProviderStreamEvent: probe.onProviderStreamEvent, // 必须同步、轻量
    maxRetryDelayMs: 8_000,
  });

  // 队列计数：pi 只提供 peekQueuedMessages，这里按消息对象身份记账，以便 UI 显示「插话 1 / 待办 2」
  const queued = { steer: new Set<AgentMessage>(), followUp: new Set<AgentMessage>() };
  const emitQueue = () =>
    deps.bus.app({
      kind: 'queue',
      agentId: spec.id,
      steer: queued.steer.size,
      followUp: queued.followUp.size,
      preview: agent.peekQueuedMessages().map(preview),
      steeringMode: agent.steeringMode,
      followUpMode: agent.followUpMode,
    });

  const observer = observe(spec.id, {
    bus: deps.bus,
    probe,
    flush: deps.flush,
    parentToolCallId: () => parent ?? deps.parentToolCallId?.(),
    onRun: (phase) => {
      running = phase === 'start';
      if (phase === 'start') {
        turns.reset();
        report = undefined;
      }
      deps.bus.app({ kind: 'crew', crew: [member.view()] });
    },
  });
  agent.subscribe(observer.listener);
  agent.subscribe((ev) => {
    if (ev.type === 'message_start' && (queued.steer.delete(ev.message) || queued.followUp.delete(ev.message))) emitQueue();
    if (ev.type === 'message_end' && ev.message.role === 'assistant') {
      lastError = ev.message.stopReason === 'error' ? ev.message.errorMessage : undefined;
    }
    if (ev.type === 'tool_execution_end' && ev.toolName === 'report_back' && !ev.isError) {
      report = ev.result?.structuredContent as Record<string, unknown>;
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
    hooks: { beforeToolCall, afterToolCall },
    get runId() {
      return observer.runId;
    },
    get isRunning() {
      return running || agent.state.isStreaming;
    },
    deliver(messages, mode) {
      const list = withSections(Array.isArray(messages) ? messages : [messages]);
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
    async run(messages) {
      // 已在运行（例如调度器刚唤醒了它）：排到这次运行之后，等它空闲
      if (member.isRunning) {
        member.deliver(messages, 'followUp');
        await agent.waitForIdle();
        while (running) await new Promise((r) => setTimeout(r, 5));
        return lastAssistant(agent.state.messages);
      }
      running = true;
      let last: AssistantMessage | undefined;
      const batch = withSections(Array.isArray(messages) ? messages : [messages]);
      try {
        last = await runToEnd(() => agent.prompt(batch));
        // 竞态：pi 的循环已结束、但 run() 还没返回的这段时间里送达的 steer / followUp 会留在队列里。
        // continue() 在尾部是 assistant 时会取出一批排队消息继续跑。
        while (agent.hasQueuedMessages() && !agent.state.isStreaming && last?.stopReason !== 'error' && last?.stopReason !== 'aborted') {
          last = await runToEnd(() => agent.continue());
        }
      } finally {
        running = agent.state.isStreaming;
        if (!running && deferred.length) {
          agent.state.messages = [...agent.state.messages, ...deferred];
          deferred = [];
        }
        // agent_end 时 running 仍为 true：真正结束后再广播一次状态
        deps.bus.app({ kind: 'crew', crew: [member.view()] });
      }
      if (!agent.state.isStreaming) await deps.afterRun?.(member, last);
      return last;
    },
    append(message) {
      if (member.isRunning) deferred.push(message);
      else agent.state.messages = [...agent.state.messages, message];
    },
    abort() {
      agent.abort();
    },
    queue() {
      return { steer: queued.steer.size, followUp: queued.followUp.size, preview: agent.peekQueuedMessages().map(preview) };
    },
    setQueueModes(steering, followUp) {
      agent.steeringMode = steering;
      agent.followUpMode = followUp;
      emitQueue();
    },
    lastReport: () => report,
    setTools(next) {
      tools = next;
      toolMeta = meta(next);
      agent.state.tools = next;
      deps.bus.app({ kind: 'crew', crew: [member.view()] });
    },
    syncTools(available) {
      const next = allTools.filter((t) => available(t.name));
      if (next.map((t) => t.name).join() === tools.map((t) => t.name).join()) return false;
      member.setTools(next);
      return true;
    },
    addTools(extra) {
      const names = new Set(extra.map((t) => t.name));
      allTools = [...allTools.filter((t) => !names.has(t.name)), ...extra];
      member.setTools([...tools.filter((t) => !names.has(t.name)), ...extra]);
    },
    removeTools(names) {
      allTools = allTools.filter((t) => !names.includes(t.name));
      member.setTools(tools.filter((t) => !names.includes(t.name)));
    },
    setParent(id) {
      parent = id;
    },
    patchSections(sections) {
      pendingSections = { ...pendingSections, ...sections };
    },
    bench(tool, args) {
      const toolCall = { type: 'toolCall' as const, id: `bench-${Date.now().toString(36)}`, name: tool, arguments: (args ?? {}) as Record<string, JsonValue> };
      const assistantMessage: AssistantMessage = {
        role: 'assistant',
        content: [toolCall],
        api: agent.state.model.api,
        provider: agent.state.model.provider,
        model: agent.state.model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'toolUse',
        timestamp: Date.now(),
      };
      return runToolCall(toolCall, {
        tools: agent.state.tools,
        assistantMessage,
        context: { messages: agent.state.messages, tools: agent.state.tools },
        beforeToolCall,
        afterToolCall,
      });
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
        tools: toolMeta,
      };
    },
    async contextView() {
      const messages = agent.state.messages;
      const view = deps.transformContext?.(spec);
      const llm = await convertToLlm(view ? await view(messages) : messages);
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

export function lastAssistant(messages: AgentMessage[]): AssistantMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant') return m;
  }
  return undefined;
}
