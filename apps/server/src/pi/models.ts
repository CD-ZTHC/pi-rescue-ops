// GLM provider + compat（§2.3）+ 全局并发信号量（§2.6）+ faux 切换。
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  createModels,
  createProvider,
  envApiKeyAuth,
  fauxProvider,
  type Api,
  type AssistantMessage,
  type FauxProviderHandle,
  type FauxResponseFactory,
  type Model,
  type MutableModels,
} from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { Config, PriceTable } from '../config.ts';

export const GLM_PROVIDER = 'glm';
export const FAUX_PROVIDER = 'faux';

const GLM_COMPAT = {
  thinkingFormat: 'zai',
  maxTokensField: 'max_tokens',
  supportsDeveloperRole: false, // flash 不接受 developer 角色（400「角色信息不正确」）
  supportsMidConvoSystemMessages: true,
  supportsMidConvoToolAdditions: false, // 网关不支持中途工具声明
  // zaiToolStream：未验证前保持关闭（§14）
} as const;

function glmModel(id: string, baseUrl: string, vision: boolean, price: PriceTable): Model<'openai-completions'> {
  return {
    id,
    name: id,
    api: 'openai-completions',
    provider: GLM_PROVIDER,
    baseUrl,
    reasoning: true,
    // 这一项决定 pi-ai 怎样处理图片：纯文本模型会把图片降级为占位文本
    input: vision ? ['text', 'image'] : ['text'],
    cost: { input: price.input, output: price.output, cacheRead: price.cacheRead, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    compat: { ...GLM_COMPAT },
  };
}

/** 全局信号量：所有船员、分诊台、书记员共用 */
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get inFlight(): number {
    return this.active;
  }

  get waiting(): number {
    return this.waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.waiters = this.waiters.filter((w) => w !== grant);
        reject(signal?.reason ?? new Error('aborted'));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(grant);
    });
    this.active += 1;
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
}

/** 一次请求的计时探针：wrapper 写入排队与开始时间，onProviderStreamEvent 写入首个 provider 事件 */
export interface RequestTiming {
  queuedAt: number;
  startedAt: number;
  firstProviderEventAt?: number;
  providerEvents: number;
  images: number;
  model: string;
}

export interface RequestProbe {
  begin(timing: RequestTiming): void;
  /** 交给 Agent 的 onProviderStreamEvent：必须同步、轻量，只记一个时间戳 */
  onProviderStreamEvent: (data: unknown) => void;
  current(): RequestTiming | undefined;
}

export function createRequestProbe(): RequestProbe {
  let timing: RequestTiming | undefined;
  return {
    begin(t) {
      timing = t;
    },
    onProviderStreamEvent() {
      if (!timing) return;
      timing.providerEvents += 1;
      timing.firstProviderEventAt ??= Date.now();
    },
    current: () => timing,
  };
}

export type Backend = 'live' | 'faux';

export interface ModelHub {
  readonly config: Config;
  readonly models: MutableModels;
  readonly faux: FauxProviderHandle;
  readonly semaphore: Semaphore;
  readonly liveAvailable: boolean;
  backend: Backend;
  /** 按当前 backend 返回同名模型（faux 下返回同 id 的 faux 模型，input 声明一致） */
  chat(id: string): Model<Api>;
  /** 为某个船员创建 streamFn：信号量 + 计时探针 + 离线大脑补位 */
  createStreamFn(probe?: RequestProbe): StreamFn;
  /** 离线自由模式下 faux 队列空时调用的响应工厂 */
  setOfflineBrain(factory: FauxResponseFactory | undefined): void;
  /** 书记员、分诊台、评审等「一次性」调用用的模型：live 用 flash；faux 用独立的 faux provider，不占课程脚本的响应队列 */
  scribeModel(): Model<Api>;
  createScribeStreamFn(): StreamFn;
  /** 注册书记员等一次性调用的离线响应工厂 */
  setAuxBrain(factory: FauxResponseFactory): void;
}

export function createModelHub(config: Config): ModelHub {
  const models = createModels();
  const liveAvailable = config.mode === 'live';
  const ids = [
    { id: config.commanderModel, vision: false, price: config.prices.strong },
    { id: config.specialistModel, vision: true, price: config.prices.flash },
  ];
  if (liveAvailable) {
    models.setProvider(
      createProvider({
        id: GLM_PROVIDER,
        name: 'GLM 网关',
        baseUrl: config.baseUrl,
        auth: { apiKey: envApiKeyAuth('GLM API key', ['GLM_API_KEY', 'STRATEGIC_API_KEY']) },
        models: ids.map((m) => glmModel(m.id, config.baseUrl, m.vision, m.price)),
        api: openAICompletionsApi(),
      }),
    );
  }
  const faux = fauxProvider({
    provider: FAUX_PROVIDER,
    models: ids.map((m) => ({ id: m.id, reasoning: true, input: m.vision ? ['text', 'image'] : ['text'] })),
    tokensPerSecond: config.fauxTokensPerSecond,
  });
  models.setProvider(faux.provider);

  // 一次性调用（书记员 / 评审）专用的 faux provider：与船员的 faux 队列互不干扰
  const auxFaux = fauxProvider({ provider: 'faux-aux', models: [{ id: config.specialistModel, reasoning: true, input: ['text', 'image'] }], tokensPerSecond: config.fauxTokensPerSecond });
  models.setProvider(auxFaux.provider);
  let auxBrain: FauxResponseFactory | undefined;

  const semaphore = new Semaphore(config.maxConcurrency);
  let offlineBrain: FauxResponseFactory | undefined;

  const hub: ModelHub = {
    config,
    models,
    faux,
    semaphore,
    liveAvailable,
    backend: liveAvailable ? 'live' : 'faux',
    chat(id) {
      const provider = hub.backend === 'live' ? GLM_PROVIDER : FAUX_PROVIDER;
      const model = models.getModel(provider, id);
      if (!model) throw new Error(`未注册的模型 ${provider}/${id}`);
      return model;
    },
    setOfflineBrain(factory) {
      offlineBrain = factory;
    },
    setAuxBrain(factory) {
      auxBrain = factory;
    },
    scribeModel() {
      return hub.backend === 'live' ? hub.chat(config.specialistModel) : auxFaux.getModel();
    },
    createScribeStreamFn() {
      const inner = hub.createStreamFn();
      return (model, context, options) => {
        if (model.provider === 'faux-aux' && auxBrain) auxFaux.appendResponses([auxBrain]);
        return inner(model, context, options);
      };
    },
    createStreamFn(probe) {
      return async (model, context, options) => {
        const queuedAt = Date.now();
        let release: () => void;
        try {
          release = await semaphore.acquire(options?.signal);
        } catch {
          return abortedStream(model, '等待并发配额时被中止');
        }
        probe?.begin({
          queuedAt,
          startedAt: Date.now(),
          providerEvents: 0,
          images: countImages(context.messages),
          model: model.id,
        });
        // 离线自由模式：每个请求排入一个大脑工厂（多名船员并发请求时，按「队列为空才补」会出现竞态）
        if (model.provider === FAUX_PROVIDER && offlineBrain) faux.appendResponses([offlineBrain]);
        const stream = models.streamSimple(model, context, options);
        stream.result().then(release, release);
        return stream;
      };
    },
  };
  return hub;
}

function countImages(messages: readonly { role: string; content?: unknown }[]): number {
  let n = 0;
  for (const m of messages) {
    if (Array.isArray(m.content)) n += m.content.filter((c: { type?: string }) => c?.type === 'image').length;
  }
  return n;
}

function abortedStream(model: Model<Api>, reason: string) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'aborted',
    errorMessage: reason,
    timestamp: Date.now(),
  };
  stream.push({ type: 'error', reason: 'aborted', error: message });
  stream.end(message);
  return stream;
}
