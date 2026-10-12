// 测试辅助：离线配置 + 不落盘、不走时的 Station。
import { loadConfig, type Config } from '../config.ts';
import { Station } from '../runtime/station.ts';

export function offlineConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({ RESCUE_OFFLINE: '1', FAUX_TPS: '4000' }), ...overrides };
}

export function testStation(overrides: Partial<Config> = {}, autoSpawn = false): Station {
  const station = new Station(offlineConfig(overrides), { clock: false, journal: false, autoSpawn, autoHazards: false });
  // 分诊是异步的；大多数测试关心同步的唤醒路径，需要分诊的测试自行打开
  station.flags.triage = false;
  return station;
}

export function until(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - t0 > timeoutMs) return reject(new Error('等待超时'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** 测试里没有墙钟：每 2ms 推进一个 tick */
export function drive(station: Station, everyMs = 2): () => void {
  const timer = setInterval(() => station.world.step(), everyMs);
  return () => clearInterval(timer);
}
