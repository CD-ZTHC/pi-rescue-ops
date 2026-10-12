// 运行配置：读取 GLM 网关（兼容旧的 STRATEGIC_* 变量名）与各角色模型。
export interface PriceTable {
  input: number;
  output: number;
  cacheRead: number;
}

export interface Config {
  mode: 'live' | 'offline';
  baseUrl: string;
  apiKey?: string;
  commanderModel: string;
  specialistModel: string;
  maxConcurrency: number;
  prices: { strong: PriceTable; flash: PriceTable };
  currency: 'USD' | 'CNY';
  usdRate: number;
  port: number;
  seed: number;
  missionsDir: string;
}

function num(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.GLM_API_KEY || env.STRATEGIC_API_KEY || undefined;
  const baseUrl = env.GLM_BASE_URL || env.STRATEGIC_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4';
  return {
    mode: apiKey && env.RESCUE_OFFLINE !== '1' ? 'live' : 'offline',
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    commanderModel: env.COMMANDER_MODEL || 'glm-5.3',
    specialistModel: env.SPECIALIST_MODEL || 'glm-5.3-flash',
    maxConcurrency: Math.max(1, num(env.GLM_MAX_CONCURRENCY, 3)),
    prices: {
      strong: {
        input: num(env.GLM_PRICE_INPUT, 0),
        output: num(env.GLM_PRICE_OUTPUT, 0),
        cacheRead: num(env.GLM_PRICE_CACHE_READ, 0),
      },
      flash: {
        input: num(env.GLM_FLASH_PRICE_INPUT, 0),
        output: num(env.GLM_FLASH_PRICE_OUTPUT, 0),
        cacheRead: num(env.GLM_FLASH_PRICE_CACHE_READ, 0),
      },
    },
    currency: env.COST_CURRENCY === 'USD' ? 'USD' : 'CNY',
    usdRate: num(env.USD_CNY_RATE, 7.1),
    port: num(env.SERVER_PORT, 8787),
    seed: num(env.WORLD_SEED, 20261012),
    missionsDir: env.MISSIONS_DIR || 'missions',
  };
}
