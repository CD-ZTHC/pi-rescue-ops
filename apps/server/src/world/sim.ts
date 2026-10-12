// 单写者世界（§4.3）：只有 World 能修改世界状态。
// 工具先 preview(cmd)（纯校验），通过后 enqueue(cmd)，命令在下一个 tick 生效。
import {
  MODULE_NAMES,
  SECTOR_IDS,
  sectorCenterAngle,
  type ModuleId,
  type SectorId,
  type SignalView,
  type WorldEvent,
  type WorldPatch,
  type WorldSnapshot,
} from '@rescue/protocol';
import { Rng } from './rng.ts';
import { computeScore, RULES } from './rules.ts';
import { scanClues, spawnSignal, type SignalTruth } from './spawner.ts';

export type WorldCommand = { type: 'scan'; sector: SectorId; correlationId?: string };

export type PreviewResult = { ok: true; etaTicks?: number } | { ok: false; reason: string };

export interface WorldOptions {
  seed: number;
  /** 关闭后不自动生成信号（课程用） */
  autoSpawn?: boolean;
}

export interface TickResult {
  tick: number;
  events: WorldEvent[];
  patch: WorldPatch;
}

type Listener = (result: TickResult) => void;

export class World {
  readonly seed: number;
  private rng: Rng;
  private state: WorldSnapshot;
  private truths = new Map<string, SignalTruth>();
  private queue: WorldCommand[] = [];
  private nextSpawnTick: number = RULES.firstSignalTick;
  private serial = 0;
  private listeners = new Set<Listener>();
  private timer?: NodeJS.Timeout;
  private autoSpawn: boolean;
  /** 已执行的命令日志（含生效 tick），用于录制回放 */
  readonly commandLog: Array<{ tick: number; cmd: WorldCommand }> = [];

  constructor(options: WorldOptions) {
    this.seed = options.seed;
    this.autoSpawn = options.autoSpawn ?? true;
    this.rng = new Rng(options.seed);
    this.state = initialState(options.seed);
  }

  snapshot(): WorldSnapshot {
    return structuredClone(this.state);
  }

  get tick(): number {
    return this.state.tick;
  }

  signal(id: string): SignalView | undefined {
    return this.state.signals.find((s) => s.id === id);
  }

  /** 仅限服务端内部（结算、测试、渲染）使用；不得写入工具的 content 或 structuredContent */
  truthOf(id: string): SignalTruth | undefined {
    return this.truths.get(id);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  preview(cmd: WorldCommand): PreviewResult {
    if (this.state.ended) return { ok: false, reason: '本班次已结束' };
    switch (cmd.type) {
      case 'scan': {
        if (!SECTOR_IDS.includes(cmd.sector)) return { ok: false, reason: `不存在星区 ${cmd.sector}` };
        const sensors = this.state.modules.find((m) => m.id === 'sensors');
        if (sensors?.status === 'offline') return { ok: false, reason: '传感器离线，无法扫描' };
        if (this.state.scans.some((s) => s.sector === cmd.sector)) {
          return { ok: false, reason: `${cmd.sector} 区正在扫描中` };
        }
        return { ok: true, etaTicks: this.scanTicks(cmd.sector) };
      }
    }
  }

  enqueue(cmd: WorldCommand): PreviewResult {
    const check = this.preview(cmd);
    if (check.ok) this.queue.push(cmd);
    return check;
  }

  /** 推进一个 tick，返回本 tick 的事件与补丁 */
  step(): TickResult {
    const before = this.state;
    const next = structuredClone(before);
    const events: WorldEvent[] = [];
    if (next.ended) return { tick: next.tick, events, patch: {} };
    next.tick += 1;
    const tick = next.tick;

    // 1. 执行排队命令
    for (const cmd of this.queue.splice(0)) {
      this.commandLog.push({ tick, cmd });
      if (cmd.type === 'scan') {
        const eta = this.scanTicks(cmd.sector);
        next.scans.push({ sector: cmd.sector, startTick: tick, endTick: tick + eta, correlationId: cmd.correlationId });
        events.push({ type: 'scan.started', tick, sector: cmd.sector, correlationId: cmd.correlationId });
      }
    }

    // 2. 扫描完成
    for (const scan of next.scans.filter((s) => s.endTick <= tick)) {
      const found = next.signals.filter((s) => s.sector === scan.sector && s.status === 'active');
      for (const s of found) {
        const truth = this.truths.get(s.id);
        if (truth) s.clues = scanClues(truth, s.id);
      }
      const sector = next.sectors.find((s) => s.id === scan.sector);
      if (sector) sector.lastScanTick = tick;
      events.push({ type: 'scan.completed', tick, sector: scan.sector, signalIds: found.map((s) => s.id), correlationId: scan.correlationId });
    }
    next.scans = next.scans.filter((s) => s.endTick > tick);

    // 3. 信号过期
    for (const s of next.signals) {
      if (s.status === 'active' && tick >= s.expiresTick) {
        s.status = 'lost';
        if (!this.truths.get(s.id)?.hoax) next.score = computeScore(next.score.rescued, next.score.hoaxFuel, next.score.missed + 1);
        events.push({ type: 'signal.lost', tick, signalId: s.id, reason: 'expired' });
      }
    }

    // 4. 生成新信号
    if (this.autoSpawn && tick >= this.nextSpawnTick) {
      this.spawnInto(next, events);
      this.nextSpawnTick = tick + this.rng.int(RULES.signalIntervalTicks[0], RULES.signalIntervalTicks[1]);
    }

    // 5. 交班
    if (tick >= next.shiftTicks) {
      next.ended = true;
      next.phase = 'handover';
      events.push({ type: 'shift.ended', tick, score: next.score });
    }

    this.state = next;
    const result = { tick, events, patch: diff(before, next) };
    for (const l of this.listeners) l(result);
    return result;
  }

  /** 课程用：立即生成一个信号（在下一次 step 时广播） */
  spawnNow(): SignalView {
    const events: WorldEvent[] = [];
    const next = structuredClone(this.state);
    const view = this.spawnInto(next, events);
    const before = this.state;
    this.state = next;
    const result = { tick: next.tick, events, patch: diff(before, next) };
    for (const l of this.listeners) l(result);
    return view;
  }

  setSpeed(speed: WorldSnapshot['speed']): void {
    const before = this.state;
    this.state = { ...this.state, speed };
    const result = { tick: this.state.tick, events: [], patch: diff(before, this.state) };
    for (const l of this.listeners) l(result);
    if (this.timer) this.start();
  }

  /** 以墙钟驱动世界：1 tick = 1 秒 ÷ 速率 */
  start(): void {
    this.stop();
    const loop = () => {
      const speed = this.state.speed;
      const delay = speed === 0 ? 250 : 1000 / speed;
      this.timer = setTimeout(() => {
        if (this.state.speed !== 0) this.step();
        loop();
      }, delay);
    };
    loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private spawnInto(next: WorldSnapshot, events: WorldEvent[]): SignalView {
    this.serial += 1;
    const { view, truth } = spawnSignal(this.rng, next.tick, this.serial);
    this.truths.set(view.id, truth);
    next.signals.push(view);
    events.push({ type: 'signal.spawned', tick: next.tick, signal: structuredClone(view) });
    return view;
  }

  private scanTicks(sector: SectorId): number {
    // 由星区与当前 tick 决定，不消耗随机数，保证预览与执行一致
    const i = SECTOR_IDS.indexOf(sector);
    return RULES.scanTicks[0] + ((i + this.state.tick) % (RULES.scanTicks[1] - RULES.scanTicks[0] + 1));
  }
}

function initialState(seed: number): WorldSnapshot {
  const moduleIds: ModuleId[] = ['sensors', 'hangar', 'medbay', 'comms'];
  return {
    seed,
    tick: 0,
    shiftTicks: RULES.shiftTicks,
    speed: 1,
    phase: 'calm',
    fuel: RULES.fuelMax,
    fuelMax: RULES.fuelMax,
    beds: RULES.bedsTotal,
    bedsTotal: RULES.bedsTotal,
    modules: moduleIds.map((id) => ({ id, name: MODULE_NAMES[id], status: 'ok' })),
    sectors: SECTOR_IDS.map((id) => ({ id, angle: sectorCenterAngle(id), hazard: 0 })),
    signals: [],
    drones: Array.from({ length: RULES.drones }, (_, i) => ({
      id: `D-${i + 1}`,
      status: 'docked' as const,
      pos: { angle: (i * 2 * Math.PI) / RULES.drones, radius: 6 },
      carrying: 0,
    })),
    score: computeScore(0, 0, 0),
    scans: [],
    ended: false,
  };
}

function diff(a: WorldSnapshot, b: WorldSnapshot): WorldPatch {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(b) as Array<keyof WorldSnapshot>) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) patch[key] = b[key];
  }
  return patch as WorldPatch;
}
