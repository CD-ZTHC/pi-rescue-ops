// 单写者世界（§4.3）：只有 World 能修改世界状态。
// 工具先 preview(cmd)（纯校验），通过后 enqueue(cmd)，命令在下一个 tick 生效。
import {
  bezier,
  CAMERA_CELLS,
  MODULE_IDS,
  MODULE_NAMES,
  SECTOR_IDS,
  sectorCenterAngle,
  sectorOfAngle,
  toPoint,
  toPolar,
  type DroneView,
  type ModuleId,
  type ModuleStatus,
  type PatientView,
  type SectorId,
  type SignalView,
  type WorldEvent,
  type WorldPatch,
  type WorldSnapshot,
} from '@rescue/protocol';
import { planRoute, reverse, type PlannedRoute, type RouteKind } from './drones.ts';
import { ALARM_TEXT, planFlare, repairTicks, rollIncident, sectorHazard, worsen, type Incident } from './hazards.ts';
import { Rng } from './rng.ts';
import { computeScore, emptyScore, RULES } from './rules.ts';
import { positionAt, signalClues, spawnSignal, type SignalTruth } from './spawner.ts';

export type WorldCommand =
  | { type: 'scan'; sector: SectorId; correlationId?: string }
  | { type: 'dispatch'; droneId: string; signalId: string; route: RouteKind; correlationId?: string }
  | { type: 'allocate'; signalId: string; amount: number; correlationId?: string }
  | { type: 'repair'; module: ModuleId; correlationId?: string }
  | { type: 'vent'; module: ModuleId; cell: string; correlationId?: string }
  | { type: 'bed'; patientId: string; members: number[]; correlationId?: string }
  | { type: 'endWatch'; report: string; correlationId?: string };

export type PreviewResult =
  | { ok: true; etaTicks?: number; fuel?: number; hazardous?: boolean; plan?: PlannedRoute }
  | { ok: false; reason: string };

export interface WorldOptions {
  seed: number;
  /** 关闭后不自动生成信号（课程用） */
  autoSpawn?: boolean;
  /** 关闭后不自动产生耀斑（课程用） */
  autoHazards?: boolean;
}

export interface TickResult {
  tick: number;
  events: WorldEvent[];
  patch: WorldPatch;
}

type Listener = (result: TickResult) => void;

const DOCK_RADIUS = 6;

export class World {
  readonly seed: number;
  private rng: Rng;
  private state: WorldSnapshot;
  private truths = new Map<string, SignalTruth>();
  private incidents = new Map<ModuleId, Incident>();
  private patientTruth = new Map<string, boolean[]>();
  private bedTicks = new Map<string, number>();
  private scanPartial = new Map<string, boolean>();
  private queue: WorldCommand[] = [];
  private nextSpawnTick: number = RULES.firstSignalTick;
  private nextFlare?: WorldSnapshot['flares'][number];
  private serial = { signal: 0, flare: 0, patient: 0 };
  private listeners = new Set<Listener>();
  private timer?: NodeJS.Timeout;
  private autoSpawn: boolean;
  private autoHazards: boolean;
  /** 已执行的命令日志（含生效 tick），用于录制回放 */
  readonly commandLog: Array<{ tick: number; cmd: WorldCommand }> = [];

  constructor(options: WorldOptions) {
    this.seed = options.seed;
    this.autoSpawn = options.autoSpawn ?? true;
    this.rng = new Rng(options.seed);
    this.state = initialState(options.seed);
    this.autoHazards = options.autoHazards ?? true;
    if (this.autoHazards) {
      this.nextFlare = planFlare(this.rng, this.rng.int(RULES.flare.firstTick[0], RULES.flare.firstTick[1]), ++this.serial.flare);
    }
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

  drone(id: string): DroneView | undefined {
    return this.state.drones.find((d) => d.id === id);
  }

  module(id: ModuleId) {
    return this.state.modules.find((m) => m.id === id)!;
  }

  patient(id: string): PatientView | undefined {
    return this.state.patients.find((p) => p.id === id);
  }

  hazard(sector: SectorId): number {
    return this.state.sectors.find((s) => s.id === sector)?.hazard ?? 0;
  }

  /** 仅限服务端内部（结算、测试、渲染）使用；不得写入工具的 content 文本或 structuredContent */
  truthOf(id: string): SignalTruth | undefined {
    return this.truths.get(id);
  }

  incidentOf(id: ModuleId): Incident | undefined {
    return this.incidents.get(id);
  }

  patientMembersTruth(id: string): boolean[] | undefined {
    return this.patientTruth.get(id);
  }

  /** 信号在过去某一时刻的位置（compare_frames 用） */
  signalPointAt(id: string, tick: number) {
    const truth = this.truths.get(id);
    return truth ? positionAt(truth, tick) : undefined;
  }

  /** 文字线索（inspect_signal）：同时写入快照，地图详情卡可见 */
  inspect(id: string): string[] | undefined {
    const truth = this.truths.get(id);
    const s = this.state.signals.find((x) => x.id === id);
    if (!truth || !s) return undefined;
    const clues = signalClues(truth, id);
    this.mutate((next) => {
      const sig = next.signals.find((x) => x.id === id)!;
      sig.clues = clues;
    });
    return clues;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 航线规划（plot_course 与 dispatch 共用），不改变世界 */
  plan(signalId: string, route: RouteKind): PlannedRoute | undefined {
    const s = this.signal(signalId);
    if (!s) return undefined;
    return planRoute(toPoint(s.pos), route, (sec) => this.hazard(sec));
  }

  availableFuel(forSignal?: string): number {
    const own = forSignal ? (this.signal(forSignal)?.reservedFuel ?? 0) : 0;
    return this.state.fuel - this.state.fuelReserved + own;
  }

  preview(cmd: WorldCommand): PreviewResult {
    const st = this.state;
    if (st.ended) return { ok: false, reason: '本班次已结束' };
    switch (cmd.type) {
      case 'scan': {
        if (!SECTOR_IDS.includes(cmd.sector)) return { ok: false, reason: `不存在星区 ${cmd.sector}` };
        if (this.module('sensors').status === 'offline') return { ok: false, reason: '传感器离线，无法扫描' };
        if (st.scans.some((s) => s.sector === cmd.sector)) return { ok: false, reason: `${cmd.sector} 区正在扫描中` };
        return { ok: true, etaTicks: this.scanTicks(cmd.sector) };
      }
      case 'dispatch': {
        const drone = this.drone(cmd.droneId);
        if (!drone) return { ok: false, reason: `不存在无人机 ${cmd.droneId}` };
        if (drone.status !== 'docked') return { ok: false, reason: `${drone.id} 当前${drone.status === 'repairing' ? '在检修' : '不在港'}` };
        if (this.module('hangar').status !== 'ok') return { ok: false, reason: '机库受损，无法弹射无人机' };
        const s = this.signal(cmd.signalId);
        if (!s) return { ok: false, reason: `不存在信号 ${cmd.signalId}` };
        if (s.status !== 'active') return { ok: false, reason: `信号 ${s.id} ${s.status === 'locked' ? '已有无人机前往' : '已失效'}` };
        const plan = this.plan(cmd.signalId, cmd.route)!;
        const available = this.availableFuel(cmd.signalId);
        if (available < plan.fuel) return { ok: false, reason: `燃料不足：需要 ${plan.fuel}，可用 ${available}` };
        return { ok: true, etaTicks: plan.ticks, fuel: plan.fuel, hazardous: plan.route.hazardous, plan };
      }
      case 'allocate': {
        const s = this.signal(cmd.signalId);
        if (!s || s.status !== 'active') return { ok: false, reason: `信号 ${cmd.signalId} 不可预留` };
        if (!(cmd.amount > 0)) return { ok: false, reason: '预留量必须为正数' };
        if (this.availableFuel() < cmd.amount) return { ok: false, reason: `可用燃料只有 ${this.availableFuel()}` };
        return { ok: true, fuel: cmd.amount };
      }
      case 'repair': {
        const m = this.module(cmd.module);
        if (m.status === 'ok') return { ok: false, reason: `${m.name}运行正常，无需修复` };
        if (m.repair) return { ok: false, reason: `${m.name}正在修复中` };
        if (this.incidents.get(cmd.module)?.kind === 'fire') return { ok: false, reason: `${m.name}火情未处置，先排空起火区段` };
        return { ok: true, etaTicks: repairTicks(m.status, this.incidents.get(cmd.module)) };
      }
      case 'vent': {
        const m = this.module(cmd.module);
        if (!CAMERA_CELLS.includes(cmd.cell)) return { ok: false, reason: `不存在网格 ${cmd.cell}（A1–D3）` };
        const inc = this.incidents.get(cmd.module);
        if (!inc) return { ok: false, reason: `${m.name}没有需要排空处置的火情或烟雾` };
        if (inc.kind === 'breach') return { ok: false, reason: `${m.name}是失压事故，排空无济于事` };
        return { ok: true };
      }
      case 'bed': {
        const p = this.patient(cmd.patientId);
        if (!p) return { ok: false, reason: `不存在伤员组 ${cmd.patientId}` };
        if (this.module('medbay').status !== 'ok') return { ok: false, reason: '医疗舱受损，无法收治' };
        if (cmd.members.length === 0) return { ok: false, reason: '没有指定成员' };
        for (const i of cmd.members) {
          const mem = p.members.find((x) => x.index === i);
          if (!mem) return { ok: false, reason: `${p.id} 没有成员 ${i}` };
          if (mem.status !== 'unknown') return { ok: false, reason: `${p.id}-${i} 已${mem.status === 'bedded' ? '入住' : '处置'}` };
        }
        if (st.beds < cmd.members.length) return { ok: false, reason: `床位不足：空床 ${st.beds}` };
        return { ok: true };
      }
      case 'endWatch':
        return { ok: true };
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
    if (before.ended) return { tick: before.tick, events: [], patch: {} };
    const next = structuredClone(before);
    const events: WorldEvent[] = [];
    next.tick += 1;
    const tick = next.tick;

    for (const cmd of this.queue.splice(0)) {
      this.commandLog.push({ tick, cmd });
      this.apply(next, cmd, events);
    }
    if (!next.ended) {
      this.advanceHazards(next, events);
      this.advanceDrones(next, events);
      this.advanceScans(next, events);
      this.advanceRepairs(next, events);
      this.advanceSignals(next, events);
      this.advancePatients(next, events);
      if (this.autoSpawn && tick >= this.nextSpawnTick) {
        this.spawnInto(next, events);
        this.nextSpawnTick = tick + this.rng.int(RULES.signalIntervalTicks[0], RULES.signalIntervalTicks[1]);
      }
      if (tick >= next.shiftTicks) this.end(next, events);
    }
    next.score = computeScore(next.score);
    return this.commit(before, next, events);
  }

  /** 课程用：立即生成一个信号 */
  spawnNow(): SignalView {
    let view!: SignalView;
    this.mutate((next, events) => (view = this.spawnInto(next, events)));
    return view;
  }

  /** 分诊台的结论写回快照（不是世界规则的一部分，只是标注） */
  setTriage(id: string, triage: { severity: string; urgency: number; hoax: number }): void {
    if (!this.signal(id)) return;
    this.mutate((next) => {
      const s = next.signals.find((x) => x.id === id);
      if (s) s.triage = triage;
    });
  }

  /** 课程用：立即修好一个舱段 */
  repairNow(id: ModuleId): void {
    this.incidents.delete(id);
    this.mutate((next, events) => {
      const m = next.modules.find((x) => x.id === id)!;
      m.status = 'ok';
      m.alarm = undefined;
      m.repair = undefined;
      events.push({ type: 'module.repaired', tick: next.tick, module: id });
    });
  }

  /** 课程用：直接把一个真实信号的幸存者接回站里（跳过飞行） */
  admitSurvivors(signalId: string): string | undefined {
    let pid: string | undefined;
    this.mutate((next, events) => {
      const s = next.signals.find((x) => x.id === signalId)!;
      s.status = 'rescued';
      s.outcome = 'rescued';
      pid = this.admitInto(next, signalId, this.truths.get(signalId)?.survivors ?? s.survivors, events);
    });
    return pid;
  }

  /** 课程用：直接移除一个信号（不计入错失） */
  retire(id: string): void {
    this.mutate((next) => {
      next.signals = next.signals.filter((s) => s.id !== id);
    });
    this.truths.delete(id);
  }

  /** 课程用：立即让某个舱段受损 */
  damageModule(id: ModuleId, status: ModuleStatus, incident?: Incident): void {
    this.mutate((next, events) => {
      const m = next.modules.find((x) => x.id === id)!;
      m.status = status;
      if (incident) this.incidents.set(id, incident);
      else this.incidents.delete(id);
      m.alarm = incident ? ALARM_TEXT[incident.kind] : undefined;
      events.push({ type: 'module.damaged', tick: next.tick, module: id, status, alarm: m.alarm });
    });
  }

  /** 下一次耀斑的计划（预警之前也知道）：只上行给地面站做「预报」 */
  forecast(): { sectors: SectorId[]; startTick: number } | undefined {
    const f = this.nextFlare ?? this.state.flares[0];
    return f ? { sectors: [...f.sectors], startTick: f.startTick } : undefined;
  }

  /** 课程 / 测试用：安排一次耀斑，startIn 秒后爆发（预警在爆发前 60 秒；不足 60 秒则立即预警） */
  scheduleFlare(sectors: SectorId[], startIn: number, hitModule = false): void {
    const startTick = this.state.tick + Math.max(1, startIn);
    this.nextFlare = {
      id: `FL-${++this.serial.flare}`,
      sectors,
      warnTick: Math.max(this.state.tick + 1, startTick - RULES.flare.warning),
      startTick,
      endTick: startTick + RULES.flare.duration,
    };
    this.flareHits = hitModule;
  }
  private flareHits?: boolean;

  setSpeed(speed: WorldSnapshot['speed']): void {
    this.mutate((next) => (next.speed = speed));
    if (this.timer) this.start();
  }

  /** 以墙钟驱动世界：1 tick = 1 秒 ÷ 速率 */
  start(): void {
    this.stop();
    const loop = () => {
      const speed = this.state.speed;
      this.timer = setTimeout(() => {
        if (this.state.speed !== 0) this.step();
        loop();
      }, speed === 0 ? 250 : 1000 / speed);
    };
    loop();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  // ───────────────────────── 内部 ─────────────────────────

  private mutate(fn: (next: WorldSnapshot, events: WorldEvent[]) => void): void {
    const before = this.state;
    const next = structuredClone(before);
    const events: WorldEvent[] = [];
    fn(next, events);
    next.score = computeScore(next.score);
    this.commit(before, next, events);
  }

  private commit(before: WorldSnapshot, next: WorldSnapshot, events: WorldEvent[]): TickResult {
    this.state = next;
    const result = { tick: next.tick, events, patch: diff(before, next) };
    for (const l of this.listeners) l(result);
    return result;
  }

  private apply(next: WorldSnapshot, cmd: WorldCommand, events: WorldEvent[]): void {
    const tick = next.tick;
    const cid = cmd.correlationId;
    switch (cmd.type) {
      case 'scan': {
        const eta = this.scanTicks(cmd.sector);
        this.scanPartial.set(`${cmd.sector}:${tick}`, next.modules.find((m) => m.id === 'sensors')!.status === 'damaged');
        next.scans.push({ sector: cmd.sector, startTick: tick, endTick: tick + eta, correlationId: cid });
        events.push({ type: 'scan.started', tick, sector: cmd.sector, correlationId: cid });
        return;
      }
      case 'dispatch': {
        const drone = next.drones.find((d) => d.id === cmd.droneId)!;
        const signal = next.signals.find((s) => s.id === cmd.signalId)!;
        const plan = planRoute(toPoint(signal.pos), cmd.route, (s) => next.sectors.find((x) => x.id === s)!.hazard);
        const reserved = signal.reservedFuel ?? 0;
        next.fuelReserved -= reserved;
        signal.reservedFuel = undefined;
        next.fuel -= plan.fuel;
        signal.status = 'locked';
        Object.assign(drone, {
          status: 'outbound',
          targetSignalId: signal.id,
          route: { ...plan.route, departTick: tick, arriveTick: tick + plan.ticks },
          correlationId: cid,
          fuelCost: plan.fuel,
          damaged: false,
        } satisfies Partial<DroneView>);
        events.push({ type: 'drone.dispatched', tick, droneId: drone.id, signalId: signal.id, fuel: plan.fuel, eta: plan.ticks, hazardous: plan.route.hazardous, correlationId: cid });
        return;
      }
      case 'allocate': {
        const s = next.signals.find((x) => x.id === cmd.signalId)!;
        s.reservedFuel = (s.reservedFuel ?? 0) + cmd.amount;
        next.fuelReserved += cmd.amount;
        events.push({ type: 'fuel.allocated', tick, signalId: s.id, amount: cmd.amount, correlationId: cid });
        return;
      }
      case 'repair': {
        const m = next.modules.find((x) => x.id === cmd.module)!;
        const endTick = tick + repairTicks(m.status, this.incidents.get(cmd.module));
        m.repair = { startTick: tick, endTick, correlationId: cid };
        events.push({ type: 'repair.started', tick, module: m.id, endTick, correlationId: cid });
        return;
      }
      case 'vent': {
        const inc = this.incidents.get(cmd.module);
        const m = next.modules.find((x) => x.id === cmd.module)!;
        const success = !!inc && inc.cell === cmd.cell;
        if (success) {
          this.incidents.delete(cmd.module);
          m.alarm = undefined;
        } else {
          next.score.penalties += 1; // 排空了无关区段：人员风险
        }
        events.push({ type: 'vent.result', tick, module: m.id, cell: cmd.cell, success, correlationId: cid });
        return;
      }
      case 'bed': {
        const p = next.patients.find((x) => x.id === cmd.patientId)!;
        for (const i of cmd.members) {
          p.members.find((x) => x.index === i)!.status = 'bedded';
          this.bedTicks.set(`${p.id}:${i}`, tick);
        }
        next.beds -= cmd.members.length;
        events.push({ type: 'patient.bedded', tick, patientId: p.id, members: cmd.members, correlationId: cid });
        return;
      }
      case 'endWatch':
        next.report = cmd.report;
        this.end(next, events);
        return;
    }
  }

  private advanceHazards(next: WorldSnapshot, events: WorldEvent[]): void {
    const tick = next.tick;
    const f = this.nextFlare;
    if (f && tick === f.warnTick) {
      next.flares.push(f);
      events.push({ type: 'flare.warning', tick, flareId: f.id, sectors: f.sectors, startTick: f.startTick });
    }
    if (f && tick === f.startTick) {
      events.push({ type: 'flare.started', tick, flareId: f.id, sectors: f.sectors });
      const hits = this.flareHits ?? this.rng.chance(RULES.flare.moduleHitChance);
      this.flareHits = undefined;
      if (hits) {
        const hit = this.rng.pick(MODULE_IDS);
        const m = next.modules.find((x) => x.id === hit)!;
        const incident = rollIncident(this.rng);
        m.status = worsen(m.status);
        m.repair = undefined;
        m.alarm = ALARM_TEXT[incident.kind];
        this.incidents.set(m.id, incident);
        events.push({ type: 'module.damaged', tick, module: m.id, status: m.status, alarm: m.alarm });
      }
    }
    if (f && tick === f.endTick) {
      next.flares = next.flares.filter((x) => x.id !== f.id);
      events.push({ type: 'flare.ended', tick, flareId: f.id });
      this.nextFlare = undefined;
      if (this.autoHazards) {
        const start = f.startTick + this.rng.int(RULES.flare.interval[0], RULES.flare.interval[1]);
        this.nextFlare = planFlare(this.rng, Math.max(start, tick + RULES.flare.warning + 1), ++this.serial.flare);
      }
    }
    for (const s of next.sectors) s.hazard = sectorHazard(next.flares, tick, s.id);
    next.phase = next.flares.length ? 'storm' : 'calm';
  }

  private advanceDrones(next: WorldSnapshot, events: WorldEvent[]): void {
    const tick = next.tick;
    for (const d of next.drones) {
      if (d.status === 'repairing' && tick >= (d.repairedTick ?? 0)) {
        d.status = 'docked';
        d.repairedTick = undefined;
        d.damaged = false;
      }
      if (!d.route) continue;
      const r = d.route;
      const t = Math.min(1, (tick - r.departTick) / Math.max(1, r.arriveTick - r.departTick));
      d.pos = toPolar(bezier(r, t));
      const sector = sectorOfAngle(d.pos.angle);
      const flare = next.flares.find((f) => f.sectors.includes(sector) && tick >= f.startTick && tick < f.endTick);
      if (flare && !d.damaged && d.pos.radius > 25) {
        d.damaged = true;
        events.push({ type: 'drone.damaged', tick, droneId: d.id, flareId: flare.id });
      }
      if (tick < r.arriveTick) continue;
      if (d.status === 'outbound') this.arrive(next, d, events);
      else this.dock(next, d, events);
    }
  }

  private arrive(next: WorldSnapshot, d: DroneView, events: WorldEvent[]): void {
    const tick = next.tick;
    const s = next.signals.find((x) => x.id === d.targetSignalId);
    const truth = s ? this.truths.get(s.id) : undefined;
    let outcome: 'rescued' | 'hoax' | 'gone' = 'gone';
    if (s && truth && s.status === 'locked') {
      if (truth.hoax) {
        outcome = 'hoax';
        s.status = 'lost';
        s.outcome = 'hoax';
        next.score.hoaxFuel += d.fuelCost ?? 0;
      } else {
        outcome = 'rescued';
        s.status = 'rescued';
        s.outcome = 'rescued';
        d.carrying = truth.survivors;
      }
    }
    events.push({ type: 'drone.arrived', tick, droneId: d.id, signalId: d.targetSignalId ?? '?', outcome, survivors: d.carrying, correlationId: d.correlationId });
    d.status = 'returning';
    d.route = reverse(d.route!, tick);
  }

  private dock(next: WorldSnapshot, d: DroneView, events: WorldEvent[]): void {
    const tick = next.tick;
    const index = next.drones.indexOf(d);
    let patientId: string | undefined;
    if (d.carrying > 0) patientId = this.admitInto(next, d.targetSignalId!, d.carrying, events);
    events.push({ type: 'drone.returned', tick, droneId: d.id, survivors: d.carrying, patientId, damaged: !!d.damaged, correlationId: d.correlationId });
    Object.assign(d, {
      status: d.damaged ? 'repairing' : 'docked',
      repairedTick: d.damaged ? tick + RULES.droneRepairTicks : undefined,
      pos: dockPos(index),
      route: undefined,
      targetSignalId: undefined,
      carrying: 0,
      fuelCost: undefined,
    } satisfies Partial<DroneView>);
  }

  /** 幸存者入站：计入获救；有待评估成员时建立伤员组 */
  private admitInto(next: WorldSnapshot, signalId: string, count: number, events: WorldEvent[]): string | undefined {
    const tick = next.tick;
    next.score.rescued += count;
    const members = this.truths.get(signalId)?.members ?? [];
    if (!members.length) return undefined;
    const patientId = `P-${String(++this.serial.patient).padStart(2, '0')}`;
    const patient: PatientView = {
      id: patientId,
      signalId,
      count,
      arrivedTick: tick,
      members: members.map((_, i) => ({ index: i + 1, status: 'unknown' })),
      deadlineTick: tick + RULES.patient.deadline,
    };
    this.patientTruth.set(patientId, [...members]);
    next.patients.push(patient);
    events.push({ type: 'patient.arrived', tick, patient: structuredClone(patient) });
    return patientId;
  }

  private advanceScans(next: WorldSnapshot, events: WorldEvent[]): void {
    const tick = next.tick;
    for (const scan of next.scans.filter((s) => s.endTick <= tick)) {
      const partial = this.scanPartial.get(`${scan.sector}:${scan.startTick}`) ?? false;
      const found = next.signals.filter((s) => s.sector === scan.sector && (s.status === 'active' || s.status === 'locked') && (!partial || inScannedHalf(s, scan.sector)));
      for (const s of found) s.scanned = true;
      const sector = next.sectors.find((s) => s.id === scan.sector);
      if (sector) sector.lastScanTick = tick;
      events.push({ type: 'scan.completed', tick, sector: scan.sector, signalIds: found.map((s) => s.id), partial, correlationId: scan.correlationId });
    }
    next.scans = next.scans.filter((s) => s.endTick > tick);
  }

  private advanceRepairs(next: WorldSnapshot, events: WorldEvent[]): void {
    for (const m of next.modules) {
      if (!m.repair || next.tick < m.repair.endTick) continue;
      const cid = m.repair.correlationId;
      m.status = 'ok';
      m.repair = undefined;
      m.alarm = undefined;
      this.incidents.delete(m.id);
      events.push({ type: 'module.repaired', tick: next.tick, module: m.id, correlationId: cid });
    }
  }

  private advanceSignals(next: WorldSnapshot, events: WorldEvent[]): void {
    const tick = next.tick;
    for (const s of next.signals) {
      if (s.status !== 'active' && s.status !== 'locked') continue;
      const truth = this.truths.get(s.id);
      if (truth) s.pos = toPolar(positionAt(truth, tick));
      if (tick >= s.expiresTick) {
        s.status = 'lost';
        s.outcome = 'expired';
        if (s.reservedFuel) {
          next.fuelReserved -= s.reservedFuel;
          s.reservedFuel = undefined;
        }
        if (!truth?.hoax) next.score.missed += 1;
        events.push({ type: 'signal.lost', tick, signalId: s.id, reason: 'expired' });
      }
    }
  }

  private advancePatients(next: WorldSnapshot, events: WorldEvent[]): void {
    const tick = next.tick;
    for (const p of next.patients) {
      const truth = this.patientTruth.get(p.id) ?? [];
      for (const mem of p.members) {
        const critical = truth[mem.index - 1];
        if (mem.status === 'unknown' && tick >= p.deadlineTick) {
          mem.status = critical ? 'lost' : 'stable';
          if (critical) {
            next.score.rescued -= 1;
            next.score.deaths += 1;
            events.push({ type: 'patient.lost', tick, patientId: p.id, member: mem.index });
          } else events.push({ type: 'patient.stable', tick, patientId: p.id, member: mem.index });
        }
        const bedded = this.bedTicks.get(`${p.id}:${mem.index}`);
        if (mem.status === 'bedded' && bedded !== undefined && tick >= bedded + RULES.patient.stabilize) {
          mem.status = 'stable';
          next.beds += 1;
          events.push({ type: 'patient.stable', tick, patientId: p.id, member: mem.index });
        }
      }
    }
  }

  private end(next: WorldSnapshot, events: WorldEvent[]): void {
    next.ended = true;
    next.phase = 'handover';
    next.score = computeScore(next.score);
    events.push({ type: 'shift.ended', tick: next.tick, score: next.score, report: next.report });
  }

  private spawnInto(next: WorldSnapshot, events: WorldEvent[]): SignalView {
    const { view, truth } = spawnSignal(this.rng, next.tick, ++this.serial.signal);
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

/** 传感器受损时只扫到扇区的前一半（按角度） */
export function inScannedHalf(s: Pick<SignalView, 'pos'>, sector: SectorId): boolean {
  const center = sectorCenterAngle(sector);
  let d = s.pos.angle - center;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  return d >= 0;
}

function dockPos(i: number) {
  return { angle: (i * 2 * Math.PI) / RULES.drones, radius: DOCK_RADIUS };
}

function initialState(seed: number): WorldSnapshot {
  return {
    seed,
    tick: 0,
    shiftTicks: RULES.shiftTicks,
    speed: 1,
    phase: 'calm',
    fuel: RULES.fuelMax,
    fuelMax: RULES.fuelMax,
    fuelReserved: 0,
    beds: RULES.bedsTotal,
    bedsTotal: RULES.bedsTotal,
    modules: MODULE_IDS.map((id) => ({ id, name: MODULE_NAMES[id], status: 'ok' })),
    sectors: SECTOR_IDS.map((id) => ({ id, angle: sectorCenterAngle(id), hazard: 0 })),
    signals: [],
    drones: Array.from({ length: RULES.drones }, (_, i) => ({ id: `D-${i + 1}`, status: 'docked' as const, pos: dockPos(i), carrying: 0 })),
    flares: [],
    patients: [],
    score: emptyScore(),
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
