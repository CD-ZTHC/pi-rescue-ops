// 低层 API（§5.12）：用 agentLoop() 实现一个无状态的「班末评审」。
// 与基于 Agent 的书记员对照：
// - agentLoop 的事件流是「观察性」的：消费者处理事件再慢，循环也不会等它——工具可能在消费者看到 message_end 之前就执行了；
// - Agent 在 message_end 处形成屏障：beforeToolCall 看到的状态里已经包含发起调用的那条 assistant 消息。
import { agentLoop, Agent, type AgentContext, type AgentLoopConfig, type AgentTool } from '@earendil-works/pi-agent-core';
import type { Message } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import type { ModelHub } from './models.ts';

const JUDGE_PROMPT = '你是「织女-7」救援站的班末评审。根据本班的结算与事件摘要给出评级（A–D）、做得好的地方与需要改进的地方，必须调用 submit_review 提交。';

const ReviewParams = Type.Object({
  grade: Type.Union(['A', 'B', 'C', 'D'].map((g) => Type.Literal(g))),
  strengths: Type.Array(Type.String()),
  improvements: Type.Array(Type.String()),
});

export interface Review {
  grade: string;
  strengths: string[];
  improvements: string[];
  /** 低层事件的顺序（消费者看到的） */
  events: string[];
  /** 工具执行时，慢消费者是否已经处理完 message_end（agentLoop 下通常为 false） */
  consumerCaughtUp: boolean;
  durationMs: number;
}

export async function judgeShift(hub: ModelHub, summary: Record<string, unknown>, opts: { consumerDelayMs?: number; signal?: AbortSignal } = {}): Promise<Review> {
  const t0 = performance.now();
  let submitted: { grade: string; strengths: string[]; improvements: string[] } | undefined;
  let consumerSawMessageEnd = false;
  let consumerCaughtUp = true;
  const submit: AgentTool<typeof ReviewParams> = {
    name: 'submit_review',
    label: '提交评审',
    description: '提交班末评审结论',
    parameters: ReviewParams,
    executionMode: 'sequential',
    async execute(_id, params) {
      consumerCaughtUp = consumerSawMessageEnd; // 工具开始执行的这一刻，消费者跟上了吗？
      submitted = params;
      return { content: [{ type: 'text', text: '评审已提交' }], details: {}, terminate: true };
    },
  };
  const context: AgentContext = {
    messages: [{ role: 'system', content: JUDGE_PROMPT, toolsAdded: [{ name: submit.name, description: submit.description, parameters: submit.parameters }], timestamp: Date.now() }],
    tools: [submit],
  };
  const config: AgentLoopConfig = {
    model: hub.scribeModel(),
    convertToLlm: (messages) => messages as Message[],
    toolExecution: 'sequential',
  };
  const events: string[] = [];
  const stream = agentLoop([{ role: 'user', content: JSON.stringify(summary), timestamp: Date.now() }], context, config, opts.signal, hub.createScribeStreamFn());
  for await (const ev of stream) {
    events.push(ev.type);
    if (ev.type === 'message_end' && ev.message.role === 'assistant') {
      // 故意慢吞吞地处理：低层循环不会等我们
      await new Promise((r) => setTimeout(r, opts.consumerDelayMs ?? 50));
      consumerSawMessageEnd = true;
    }
  }
  return {
    grade: submitted?.grade ?? '?',
    strengths: submitted?.strengths ?? [],
    improvements: submitted?.improvements ?? [],
    events,
    consumerCaughtUp,
    durationMs: performance.now() - t0,
  };
}

/** 对照组：同样的慢监听器挂在 Agent 上——Agent 会等 awaited 监听器处理完 message_end 才去执行工具 */
export async function barrierProbe(hub: ModelHub, delayMs = 50): Promise<boolean> {
  let sawEnd = false;
  let caughtUp = false;
  const tool: AgentTool<typeof ReviewParams> = {
    name: 'submit_review',
    label: '提交评审',
    description: '提交班末评审结论',
    parameters: ReviewParams,
    async execute() {
      caughtUp = sawEnd;
      return { content: [{ type: 'text', text: 'ok' }], details: {}, terminate: true };
    },
  };
  const agent = new Agent({ initialState: { systemPrompt: JUDGE_PROMPT, model: hub.scribeModel(), tools: [tool] }, streamFn: hub.createScribeStreamFn() });
  agent.subscribe(async (ev) => {
    if (ev.type === 'message_end' && ev.message.role === 'assistant') {
      await new Promise((r) => setTimeout(r, delayMs));
      sawEnd = true;
    }
  });
  await agent.prompt(JSON.stringify({ rescued: 0, missed: 0, deaths: 0 }));
  return caughtUp;
}
