// 持久压缩（§5.11）：运行间隙（运行结束、确实空闲、队列为空）由书记员把最老的一段对话写成摘要，
// 替换为一条 compaction 消息——这会直接修改 agent.state.messages。溢出时强制压缩后 continue()。
import { Agent, type AgentMessage } from '@earendil-works/pi-agent-core';
import { isContextOverflow, type AssistantMessage } from '@earendil-works/pi-ai';
import type { Bus } from '../runtime/bus.ts';
import type { CrewMember } from './crew.ts';
import { estimateTokens, foldImages, trimToBudget } from './context.ts';
import { convertToLlm } from './messages.ts';
import type { ModelHub } from './models.ts';

export interface CompactorDeps {
  hub: ModelHub;
  bus: Bus;
  enabled: () => boolean;
  budget: () => number;
  /** 保留最近多少条非 system 消息不压缩 */
  keepRecent?: number;
}

const SCRIBE_PROMPT = '你是「织女-7」救援站的书记员。把下面这段值班记录压缩成 5 条以内的要点：保留信号编号、判断结论、已派出的无人机、未完成的事项；删去寒暄与重复。只输出要点，每条一行。';

/** 无工具的一次性 Agent */
export async function scribe(hub: ModelHub, transcript: string): Promise<string> {
  const agent = new Agent({
    initialState: { systemPrompt: SCRIBE_PROMPT, model: hub.scribeModel(), thinkingLevel: 'off', tools: [] },
    streamFn: hub.createScribeStreamFn(),
  });
  await agent.prompt(transcript);
  const last = agent.state.messages.at(-1);
  if (!last || last.role !== 'assistant' || last.stopReason === 'error') throw new Error(last && last.role === 'assistant' ? last.errorMessage : '书记员没有回复');
  return last.content.map((c) => (c.type === 'text' ? c.text : '')).join('').trim();
}

function render(messages: AgentMessage[]): string {
  return convertToLlm(messages as AgentMessage[])
    .filter((m) => m.role !== 'system')
    .map((m) => {
      const body = typeof m.content === 'string' ? m.content : m.content.map((c) => (c.type === 'text' ? c.text : c.type === 'toolCall' ? `→ ${c.name}(${JSON.stringify(c.arguments)})` : c.type === 'image' ? '[图片]' : '')).join(' ');
      const who = m.role === 'assistant' ? '船员' : m.role === 'toolResult' ? `工具 ${m.toolName}` : '来信';
      return `${who}：${body.slice(0, 300)}`;
    })
    .join('\n');
}

/** 选出要压缩的一段：除最近 keepRecent 条之外的非 system 消息，结束处落在完整边界上 */
export function pickSegment(messages: AgentMessage[], keepRecent: number): { start: number; end: number } | undefined {
  const body = messages.map((m, i) => ({ m, i })).filter(({ m }) => m.role !== 'system');
  if (body.length <= keepRecent + 2) return undefined;
  let cut = body.length - keepRecent; // body 下标：从这里开始保留
  while (cut < body.length && (body[cut].m.role === 'toolResult' || body[cut].m.role === 'assistant')) cut++;
  if (cut >= body.length || cut < 2) return undefined;
  return { start: body[0].i, end: body[cut - 1].i };
}

export async function compact(member: CrewMember, deps: CompactorDeps, force = false): Promise<boolean> {
  const agent = member.agent;
  // §14 风险：压缩与 steer / followUp 竞态——只在空闲且队列为空时进行，否则推迟到下一次
  if (agent.state.isStreaming || agent.hasQueuedMessages()) return false;
  if (!force && !deps.enabled()) return false;
  const messages = agent.state.messages;
  const before = estimateTokens(messages);
  if (!force && before <= deps.budget()) return false;
  const seg = pickSegment(messages, deps.keepRecent ?? 6);
  if (!seg) return false;
  const segment = messages.slice(seg.start, seg.end + 1);
  const replaced = segment.filter((m) => m.role !== 'system');
  let summary: string;
  try {
    summary = await scribe(deps.hub, render(replaced));
  } catch (err) {
    deps.bus.app({ kind: 'notice', level: 'warn', text: `书记员压缩失败：${(err as Error).message}` });
    return false;
  }
  if (agent.state.isStreaming) return false; // 书记员工作期间又开始了新运行：放弃，下次再压
  const next: AgentMessage[] = [
    ...messages.slice(0, seg.start),
    ...segment.filter((m) => m.role === 'system'),
    { role: 'compaction', summary, replacedCount: replaced.length, timestamp: Date.now() },
    { role: 'ui_note', text: `书记员把 ${replaced.length} 条消息折叠成了摘要`, timestamp: Date.now() },
    ...messages.slice(seg.end + 1),
  ];
  agent.state.messages = next;
  deps.bus.app({ kind: 'compaction', agentId: member.id, beforeTokens: before, afterTokens: estimateTokens(next), summary });
  return true;
}

/** 运行结束后：先处理上下文溢出（强制压缩 + continue），再按预算压缩 */
export function afterRunCompactor(deps: CompactorDeps) {
  return async (member: CrewMember, last: AssistantMessage | undefined): Promise<void> => {
    if (last?.stopReason === 'error' && isContextOverflow(last, member.agent.state.model.contextWindow)) {
      deps.bus.app({ kind: 'notice', level: 'warn', text: `${member.spec.name} 上下文溢出：强制压缩后继续` });
      member.agent.state.messages = member.agent.state.messages.slice(0, -1); // 去掉失败的那条
      if (await compact(member, deps, true)) await member.agent.continue();
      return;
    }
    await compact(member, deps);
    emitMeter(member, deps);
  };
}

/** 上下文水位：原始消息的估算 token，以及视图裁剪之后实际发送的估算 token */
export function emitMeter(member: CrewMember, deps: Pick<CompactorDeps, 'bus' | 'budget'>): void {
  const messages = member.agent.state.messages;
  const view = trimToBudget(foldImages(messages), deps.budget()).messages;
  deps.bus.app({ kind: 'context.meter', agentId: member.id, estTokens: estimateTokens(messages), viewTokens: estimateTokens(view), budget: deps.budget(), messages: messages.length });
}
