// 前后端共享协议（§4.5）。这里只放类型与少量纯常量，不依赖运行时。
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { AssistantMessageEvent, ToolCall } from '@earendil-works/pi-ai';

export * from './world.ts';
export * from './messages.ts';
import type { WorldEvent, WorldPatch, WorldSnapshot } from './world.ts';

export type CrewId = 'commander' | 'navigator' | 'engineer' | 'medic';

export interface CrewView {
  id: CrewId;
  name: string;
  title: string;
  color: string;
  model: string;
  thinkingLevel: string;
  status: 'idle' | 'running' | 'error';
  vision: boolean;
  tools: ToolMeta[];
}

export interface ToolMeta {
  name: string;
  label: string;
  description: string;
  executionMode?: 'parallel' | 'sequential';
  /** §5.4 记号：OS / ↻ / IMG / ⚠ / ⏹ */
  flags: string[];
  /** TypeBox schema（即 JSON Schema），工具试验台据此生成表单 */
  parameters: unknown;
}

/** 可单独开关的策略（§5.1「每个课程只启用自己要讲的那一个 hook」，以及「关掉它会怎样」） */
export const POLICY_FLAGS = {
  staleGuard: { label: '过期拦截', hook: 'beforeToolCall', default: true },
  budgetGuard: { label: '预算拦截', hook: 'beforeToolCall', default: true },
  dangerApproval: { label: '危险操作审批', hook: 'beforeToolCall', default: true },
  autoApprove: { label: '自动批准（无人值守）', hook: 'beforeToolCall', default: false },
  audit: { label: '审计', hook: 'afterToolCall', default: true },
  redact: { label: '个人信息打码', hook: 'afterToolCall', default: true },
  terminateOnCommit: { label: '提交即终止', hook: 'afterToolCall', default: true },
  nudge: { label: '修正轮（只说不做时）', hook: 'finishTurn', default: true },
  situationRefresh: { label: '请求前刷新态势', hook: 'prepareRequest', default: true },
  crisisMode: { label: '危机模式升档', hook: 'prepareRequest', default: true },
  fastModel: { label: '临时换快模型', hook: 'prepareRequest', default: false },
  visionSwitch: { label: '有图时换眼睛', hook: 'prepareRequest', default: false },
  viewTrim: { label: '视图裁剪', hook: 'transformContext', default: true },
  compaction: { label: '运行间隙压缩', hook: 'agent_end', default: true },
  delegation: { label: '指挥官委派专家（关闭则调度器直接派活）', hook: 'tools', default: true },
  triage: { label: '分诊台（新信号先分类再唤醒）', hook: 'classifier', default: true },
} as const;
export type PolicyKey = keyof typeof POLICY_FLAGS;
export type PolicyFlags = Record<PolicyKey, boolean>;
export function defaultPolicyFlags(): PolicyFlags {
  return Object.fromEntries(Object.entries(POLICY_FLAGS).map(([k, v]) => [k, v.default])) as PolicyFlags;
}

/** §5.4 中无法从工具定义推导的记号（OS 由 outputSchema 推导） */
export const TOOL_FLAGS: Record<string, string[]> = {
  scan_sector: ['↻', 'IMG'],
  compare_frames: ['IMG'],
  inspect_camera: ['IMG'],
  read_vitals: ['IMG'],
  repair_module: ['↻'],
  dispatch_drone: ['⚠'],
  vent_section: ['⚠'],
  end_watch: ['⏹'],
  stand_by: ['⏹'],
  report_back: ['⏹'],
};

/** message_update 合批后发送的增量：去掉 partial 快照，只保留增量本身 */
export type WireDelta =
  | { type: 'start' }
  | { type: 'text_start' | 'thinking_start' | 'toolcall_start'; contentIndex: number }
  | { type: 'text_delta' | 'thinking_delta' | 'toolcall_delta'; contentIndex: number; delta: string }
  | { type: 'text_end' | 'thinking_end'; contentIndex: number; content: string }
  | { type: 'toolcall_end'; contentIndex: number; toolCall: ToolCall }
  | { type: 'done' | 'error'; reason: string };

export function toWireDelta(ev: AssistantMessageEvent): WireDelta {
  switch (ev.type) {
    case 'start':
      return { type: 'start' };
    case 'text_start':
    case 'thinking_start':
    case 'toolcall_start':
      return { type: ev.type, contentIndex: ev.contentIndex };
    case 'text_delta':
    case 'thinking_delta':
    case 'toolcall_delta':
      return { type: ev.type, contentIndex: ev.contentIndex, delta: ev.delta };
    case 'text_end':
    case 'thinking_end':
      return { type: ev.type, contentIndex: ev.contentIndex, content: ev.content };
    case 'toolcall_end':
      return { type: 'toolcall_end', contentIndex: ev.contentIndex, toolCall: ev.toolCall };
    case 'done':
    case 'error':
      return { type: ev.type, reason: ev.reason };
  }
}

/** pi 的 AgentEvent 原样转发；message_update 被合批成 message_update_batch */
export type WireAgentEvent =
  | Exclude<AgentEvent, { type: 'message_update' }>
  | { type: 'message_update_batch'; deltas: WireDelta[] };

export type HookName =
  | 'prepareRequest'
  | 'beforeToolCall'
  | 'afterToolCall'
  | 'finishTurn'
  | 'prepareNextTurn'
  | 'transformContext';

/** 分诊结果（§5.9）：概率来自 k 次采样的经验分布，不是 logprob */
export interface ClassifierView {
  severity: Record<string, number>;
  severityChoice: string;
  urgency: number;
  urgencyConfidence: number;
  hoax: number;
  error?: string;
  cost?: number;
}

export type AppEvent =
  | { kind: 'hook'; agentId: CrewId; runId: string; hook: HookName; toolCallId?: string; decision: unknown; durationMs: number }
  | { kind: 'approval.requested'; approvalId: string; agentId: CrewId; toolCallId: string; tool: string; args: unknown; risk: string; expiresAt: number }
  | { kind: 'approval.resolved'; approvalId: string; decision: 'approve' | 'deny' | 'timeout' }
  | { kind: 'step.paused'; agentId: CrewId; at: HookName; detail: unknown }
  | { kind: 'triage'; signalId: string; result: ClassifierView; samples: number; durationMs: number; model: string }
  | { kind: 'compaction'; agentId: CrewId; beforeTokens: number; afterTokens: number; summary: string }
  | {
      kind: 'request.meta';
      agentId: CrewId;
      runId: string;
      /** 请求开始（拿到并发配额）的墙钟时间 */
      startedAt: number;
      /** 等待并发配额的毫秒数（§2.6） */
      queuedMs: number;
      ttftMs?: number;
      /** TTFT 来源：provider 原始事件，或首个流式增量（faux 不触发 provider 事件） */
      ttftSource?: 'provider' | 'delta';
      providerEvents: number;
      model: string;
      thinkingLevel?: string;
      durationMs?: number;
      /** pi：AssistantMessage.durationMs；wall：消息未带 durationMs（faux 预制响应），用墙钟补算 */
      durationSource?: 'pi' | 'wall';
      stopReason?: string;
      usage?: { input: number; output: number; reasoning?: number; cacheRead: number; totalTokens: number; cost: number };
      images?: number;
      /** provider 原始事件（前 20 个，截断），只有真实模型会有 */
      rawChunks?: string[];
    }
  | { kind: 'queue'; agentId: CrewId; steer: number; followUp: number; preview: string[]; steeringMode: 'all' | 'one-at-a-time'; followUpMode: 'all' | 'one-at-a-time' }
  | { kind: 'policy'; flags: PolicyFlags; stepping: boolean }
  | { kind: 'review'; grade: string; strengths: string[]; improvements: string[]; events: string[]; consumerCaughtUp: boolean; agentBarrier?: boolean; durationMs: number }
  | { kind: 'telemetry'; spans: Array<{ id: number; parentId: number | null; name: string; attributes: Record<string, unknown>; events: Array<{ name: string; attributes?: Record<string, unknown> }>; status: unknown; settled: boolean }> }
  | { kind: 'context.meter'; agentId: CrewId; estTokens: number; viewTokens: number; budget: number; messages: number }
  | { kind: 'step.resumed'; agentId: CrewId }
  | { kind: 'bench.result'; agentId: CrewId; tool: string; args: unknown; isError: boolean; durationMs?: number; content: unknown[]; structured?: unknown; blocked?: boolean }
  | { kind: 'context.view'; agentId: CrewId; systemPrompt: string; tools: string[]; messages: unknown[]; llmMessages: unknown[] }
  | { kind: 'crew'; crew: CrewView[] }
  | { kind: 'lesson'; lesson: LessonMeta | null; mode?: 'faux' | 'live'; status: 'loaded' | 'running' | 'done' | 'error'; note?: string }
  | { kind: 'operator.echo'; target: CrewId; text: string; mode: 'prompt' | 'steer' | 'followUp' }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'world.event'; ev: WorldEvent };

export interface LessonMeta {
  id: string;
  index: number;
  title: string;
  capability: string;
  scenario: string;
  summary: string;
  /** 「关掉它会怎样」的对比开关说明；为空表示本课没有 */
  toggle?: string;
  /** 「关掉它会怎样」对应的策略开关，讲义面板可一键切换 */
  toggleKey?: PolicyKey;
  milestone: string;
  available: boolean;
}

export interface ServerInfo {
  mode: 'live' | 'offline';
  triageSamples: number;
  currency: 'USD' | 'CNY';
  usdRate: number;
  lessons: LessonMeta[];
}

// 服务端 → 浏览器。所有消息共享一个单调递增的 seq；断线后用 ?since=seq 补发
export type ServerMsg =
  | {
      t: 'hello';
      seq: number;
      world: WorldSnapshot;
      crew: CrewView[];
      info: ServerInfo;
      lesson?: LessonMeta | null;
      policy: PolicyFlags;
      stepping: boolean;
      paused?: { agentId: CrewId; at: HookName; detail: unknown };
      approvals: Array<Extract<AppEvent, { kind: 'approval.requested' }>>;
      /** 新连接补上最近的 agent / app 历史（不含 world 补丁：快照已是最新），让 Inspector 与频道不从空白开始 */
      history: Array<Extract<ServerMsg, { t: 'agent' | 'app' }>>;
    }
  | { t: 'world'; seq: number; tick: number; patch: WorldPatch }
  | { t: 'agent'; seq: number; agentId: CrewId; runId: string; parentToolCallId?: string; at: number; ev: WireAgentEvent }
  | { t: 'app'; seq: number; at: number; ev: AppEvent };

export type SeqlessServerMsg =
  | Omit<Extract<ServerMsg, { t: 'world' }>, 'seq'>
  | Omit<Extract<ServerMsg, { t: 'agent' }>, 'seq'>
  | Omit<Extract<ServerMsg, { t: 'app' }>, 'seq'>;

// 浏览器 → 服务端
export type ClientMsg =
  | { t: 'operator.say'; target: CrewId; text: string; mode: 'auto' | 'steer' | 'followUp'; image?: { data: string; mimeType: string } }
  | { t: 'approval.decide'; approvalId: string; decision: 'approve' | 'deny'; note?: string }
  | { t: 'run.abort'; target: CrewId | 'all' }
  | { t: 'step.set'; enabled: boolean }
  | { t: 'step.next' }
  | { t: 'world.speed'; speed: 0 | 0.5 | 1 | 2 }
  | { t: 'tool.invoke'; agentId: CrewId; tool: string; args: unknown }
  | { t: 'context.request'; agentId: CrewId }
  | { t: 'lesson.load'; lessonId: string; mode: 'faux' | 'live' }
  | { t: 'lesson.exit' }
  | { t: 'policy.set'; key: PolicyKey; value: boolean }
  | { t: 'review.request' }
  | { t: 'telemetry.request' }
  | { t: 'triage.samples'; k: number }
  | { t: 'queue.mode'; target: CrewId | 'all'; steering: 'all' | 'one-at-a-time'; followUp: 'all' | 'one-at-a-time' }
  | { t: 'replay.load'; file: string };

export const CREW_COLORS: Record<CrewId | 'operator' | 'triage' | 'scribe' | 'ground', string> = {
  operator: '#f8fafc',
  commander: '#22d3ee',
  navigator: '#a78bfa',
  engineer: '#fbbf24',
  medic: '#34d399',
  triage: '#f472b6',
  scribe: '#94a3b8',
  ground: '#60a5fa',
};

export const DEFAULT_PORT = 8787;
