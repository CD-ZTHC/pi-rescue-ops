// 自定义 ProviderClassifier（§5.9）：网关不返回 logprobs，pi-ai 内置的分类器都用不了。
// 做法：把 questions 编译成一个工具 schema → 用 chat 模型并行采样 k 次 → 用 k 次结果的经验分布作为概率。
// 约定与 pi-ai 一致：出错时返回 stopReason: 'error'，绝不 reject。
import type {
  Api,
  AssistantMessage,
  ClassifierAnswer,
  ClassifierContext,
  ClassifierModel,
  ClassifierOptions,
  ClassifierQuestion,
  ClassifierResult,
  Context,
  Model,
  ProviderClassifier,
  Usage,
} from '@earendil-works/pi-ai';
import { Type, type TSchema } from 'typebox';

export const GLM_CLASSIFY_API = 'glm-tool-classify';
const TOOL = 'submit_answers';

export interface GlmToolClassifierOptions {
  /** 每次分类并行采样几次（第 18 课对比 k=1 与 k=5） */
  samples: () => number;
  /** 底层 chat 模型（flash） */
  chatModel: () => Model<Api>;
  /** 发一次 chat 请求（走全局信号量）；不得 reject */
  complete: (model: Model<Api>, context: Context, options?: { signal?: AbortSignal }) => Promise<AssistantMessage>;
}

function answerSchema(q: ClassifierQuestion): TSchema {
  switch (q.type) {
    case 'choice':
      return Type.Union(Object.keys(q.criteria).map((k) => Type.Literal(k)), { description: q.instructions });
    case 'score':
      return Type.Integer({ minimum: 0, maximum: q.criteria.length - 1, description: `${q.instructions}（0..${q.criteria.length - 1}）` });
    case 'bool':
      return Type.Boolean({ description: q.instructions });
  }
}

function describe(name: string, q: ClassifierQuestion): string {
  switch (q.type) {
    case 'choice':
      return `- ${name}：${q.instructions}。取值：${Object.entries(q.criteria).map(([k, v]) => `${k}=${v}`).join('，')}`;
    case 'score':
      return `- ${name}：${q.instructions}。取 0..${q.criteria.length - 1}：${q.criteria.map((c, i) => `${i}=${c}`).join('，')}`;
    case 'bool':
      return `- ${name}：${q.instructions}。true=${q.criteria.true}，false=${q.criteria.false}`;
  }
}

const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

/** 从一次回复里取出答案：优先工具调用；模型没调用工具时退而解析文本里的 JSON */
export function extractAnswers(m: AssistantMessage): Record<string, unknown> | undefined {
  const call = m.content.find((c) => c.type === 'toolCall' && c.name === TOOL);
  if (call && call.type === 'toolCall') return call.arguments;
  const text = m.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return undefined;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** k 次样本的经验分布 → ClassifierAnswer */
export function aggregate(questions: Record<string, ClassifierQuestion>, samples: Array<Record<string, unknown>>): Record<string, ClassifierAnswer> {
  const out: Record<string, ClassifierAnswer> = {};
  for (const [name, q] of Object.entries(questions)) {
    const values = samples.map((s) => s[name]).filter((v) => v !== undefined);
    const n = Math.max(1, values.length);
    if (q.type === 'choice') {
      const probabilities = Object.fromEntries(Object.keys(q.criteria).map((k) => [k, values.filter((v) => v === k).length / n]));
      const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
      out[name] = { type: 'choice', choice, probabilities, confidence: probabilities[choice] };
    } else if (q.type === 'score') {
      const nums = values.map(Number).filter((v) => Number.isFinite(v));
      const counts = new Map<number, number>();
      for (const v of nums) counts.set(v, (counts.get(v) ?? 0) + 1);
      const [mode, count] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] ?? [0, 0];
      out[name] = { type: 'score', score: mode, confidence: count / Math.max(1, nums.length) };
    } else {
      out[name] = { type: 'bool', probability: values.filter((v) => v === true || v === 'true').length / n };
    }
  }
  return out;
}

export function glmToolClassifier(opts: GlmToolClassifierOptions): ProviderClassifier {
  return {
    async classify(model: ClassifierModel<string>, context: ClassifierContext, options?: ClassifierOptions): Promise<ClassifierResult> {
      const base = { api: model.api, provider: model.provider, model: model.id, timestamp: Date.now() };
      try {
        const tool = {
          name: TOOL,
          description: '提交分诊结论',
          parameters: Type.Object(Object.fromEntries(Object.entries(context.questions).map(([k, q]) => [k, answerSchema(q)]))),
        };
        const systemPrompt = [
          '你是「织女-7」救援站的分诊台。根据求救信号的信息回答下列问题，必须调用 submit_answers 提交，不要输出别的内容。',
          ...Object.entries(context.questions).map(([k, q]) => describe(k, q)),
        ].join('\n');
        const chat: Context = {
          systemPrompt,
          tools: [tool],
          messages: [{ role: 'user', content: JSON.stringify(context.state), timestamp: Date.now() }],
        };
        const k = Math.max(1, opts.samples());
        const replies = await Promise.all(Array.from({ length: k }, () => opts.complete(opts.chatModel(), chat, { signal: options?.signal })));
        if (options?.signal?.aborted) return { ...base, answers: {}, stopReason: 'aborted' };
        const usage = replies.reduce((u, r) => addUsage(u, r.usage), zeroUsage());
        const parsed = replies.map(extractAnswers).filter((a): a is Record<string, unknown> => !!a);
        if (!parsed.length) {
          const err = replies.find((r) => r.stopReason === 'error');
          return { ...base, answers: {}, usage, stopReason: 'error', errorMessage: err?.errorMessage ?? `${k} 次采样都没有给出答案` };
        }
        return { ...base, answers: aggregate(context.questions, parsed), usage, stopReason: 'stop' };
      } catch (err) {
        return { ...base, answers: {}, stopReason: 'error', errorMessage: (err as Error).message };
      }
    },
  };
}
