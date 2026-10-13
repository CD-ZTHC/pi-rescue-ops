// 站点运行时：持有世界、船员、调度器，把它们接到总线上。自由模式与课程模式在这里切换。
import { getLesson, lessonList, type LessonScript } from '@rescue/lessons';
import { defaultPolicyFlags, type CrewId, type CrewView, type LessonMeta, type PolicyFlags, type PolicyKey, type ServerInfo, type ServerMsg } from '@rescue/protocol';
import { ApprovalCenter } from '../pi/hooks/approval.ts';
import { Stepper } from '../pi/hooks/step-gate.ts';
import type { Config } from '../config.ts';
import { createCrewMember, type CrewMember } from '../pi/crew.ts';
import { operatorMessage, radioMessage, situationMessage, worldEventMessage } from '../pi/messages.ts';
import { createModelHub, type ModelHub } from '../pi/models.ts';
import { offlineAux, offlineBrain } from '../pi/offline-brain.ts';
import { crewSpecs, toolAvailable } from '../pi/roster.ts';
import { afterRunCompactor } from '../pi/compaction.ts';
import { viewTrim } from '../pi/context.ts';
import { stationStatusSection, watchPhaseSection } from '../pi/prompts.ts';
import { GroundStation } from '../pi/tools/ground-station.ts';
import { isUrgentTriage, triageSignal } from '../pi/triage.ts';
import { barrierProbe, judgeShift } from '../pi/stateless-judge.ts';
import { radioTranscript } from '../world/spawner.ts';
import { Recorder } from './recorder.ts';
import { loadRecording, ReplayCursor } from './replayer.ts';
import { handleOperator } from './operator.ts';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { WorldCommand } from '../world/sim.ts';
import { InMemoryTelemetryContext } from '@earendil-works/pi-telemetry';
import type { McpTransport } from '@earendil-works/pi-mcp';
import { World } from '../world/sim.ts';
import { Bus } from './bus.ts';
import { Dispatcher } from './dispatcher.ts';
import { Journal } from './journal.ts';

export interface StationOptions {
  bus?: Bus;
  hub?: ModelHub;
  /** 关闭后世界不自动走时（测试用） */
  clock?: boolean;
  journal?: boolean;
  /** 自由模式是否自动生成信号（测试可关闭） */
  autoSpawn?: boolean;
  /** 自由模式是否自动产生耀斑（测试可关闭） */
  autoHazards?: boolean;
  /** 启动 MCP 地面站子进程（测试默认关闭；也可传入自定义 transport） */
  groundStation?: boolean | (() => McpTransport);
  /** 自由模式下天气卫星在第几秒上线（地面站随之新增预报工具） */
  satelliteAt?: number;
  /** 自由模式录制目录（不传则不录制） */
  recordDir?: string;
}

export interface LessonState {
  meta: LessonMeta;
  mode: 'faux' | 'live';
  status: 'loaded' | 'running' | 'done' | 'error';
}

const CREW_ORDER: CrewId[] = ['commander', 'navigator', 'engineer', 'medic'];

export class Station {
  readonly bus: Bus;
  readonly hub: ModelHub;
  readonly config: Config;
  readonly missionId: string;
  readonly journal?: Journal;
  world!: World;
  readonly members = new Map<CrewId, CrewMember>();
  readonly dispatcher: Dispatcher;
  /** 全员共享的策略开关（同一个对象引用） */
  readonly flags: PolicyFlags = defaultPolicyFlags();
  readonly stepper: Stepper;
  readonly approvals: ApprovalCenter;
  lesson: LessonState | null = null;
  /** 上下文预算（估算 token）：超过后视图裁剪、运行间隙压缩 */
  contextBudget = 24_000;
  private lastSections = new Map<CrewId, string>();
  /** span 收集（每次换世界重新开始，避免无限增长） */
  telemetry = new InMemoryTelemetryContext();
  ground?: GroundStation;
  private groundReady?: Promise<void>;
  private readonly satelliteAt: number;
  private readonly recordDir?: string;
  recorder?: Recorder;
  replay?: ReplayCursor;
  private replayCleanup?: () => void;
  private satelliteOnline = false;
  private offWorld?: () => void;
  private offDispatch?: () => void;
  private readonly clock: boolean;
  private readonly autoSpawn: boolean;
  private readonly autoHazards: boolean;
  private lessonToken = 0;

  constructor(config: Config, options: StationOptions = {}) {
    this.config = config;
    this.bus = options.bus ?? new Bus();
    this.hub = options.hub ?? createModelHub(config);
    this.clock = options.clock ?? true;
    this.autoSpawn = options.autoSpawn ?? true;
    this.autoHazards = options.autoHazards ?? true;
    this.missionId = `mission-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (options.journal ?? true) {
      this.journal = new Journal(config.missionsDir, this.missionId);
      this.journal.attach(this.bus);
    }
    this.dispatcher = new Dispatcher({
      crew: (id) => this.members.get(id),
      triage: (signal, radio) => {
        if (this.replay) {
          // 回放：用录制里的分诊结论，不重新分类
          const t = this.replay.rec.triage.get(signal.id);
          if (!t) return undefined;
          this.world.setTriage(signal.id, { severity: t.result.severityChoice, urgency: t.result.urgency, hoax: t.result.hoax });
          this.bus.app({ kind: 'triage', signalId: signal.id, result: t.result, samples: t.samples, durationMs: 0, model: 'replay' });
          return Promise.resolve(isUrgentTriage(t.result));
        }
        return this.flags.triage ? triageSignal(this.hub, this.world, this.bus, signal, radio).then(isUrgentTriage) : undefined;
      },
    });
    this.dispatcher.autoDuty = !this.flags.delegation;
    this.stepper = new Stepper(this.bus, () => this.world);
    this.approvals = new ApprovalCenter(this.bus);
    this.hub.setAuxBrain(offlineAux);
    this.satelliteAt = options.satelliteAt ?? 60;
    this.recordDir = options.recordDir;
    if (options.groundStation) {
      const transport = typeof options.groundStation === 'function' ? options.groundStation() : undefined;
      this.groundReady = this.startGroundStation(transport);
    }
  }

  private async startGroundStation(transport?: McpTransport): Promise<void> {
    const gs = new GroundStation({
      onTools: (tools, added, removed) => {
        const c = this.members.get('commander');
        if (c) {
          if (removed.length) c.removeTools(removed);
          if (tools.length) c.addTools(tools);
          this.syncContext();
        }
        if (added.length) this.bus.app({ kind: 'notice', level: 'info', text: `地面站工具上线：${added.join('、')}` });
        if (removed.length) this.bus.app({ kind: 'notice', level: 'warn', text: `地面站工具下线：${removed.join('、')}` });
      },
      onClosed: (reason) => this.bus.app({ kind: 'notice', level: 'error', text: `地面站失联：${reason}` }),
    });
    try {
      await gs.connect(transport);
      this.ground = gs;
    } catch (err) {
      this.bus.app({ kind: 'notice', level: 'error', text: `地面站启动失败：${(err as Error).message}` });
    }
  }

  /** 等地面站连上（测试与课程用） */
  async groundStationReady(): Promise<GroundStation | undefined> {
    await this.groundReady;
    return this.ground;
  }

  /** 录制回放（§9）：同 seed 的世界 + 按船员依次送出的录制回复 + 按 tick 注入的主管操作；校验工具调用序列 */
  async startReplay(file: string, speed: 0.5 | 1 | 2 = 2): Promise<ReplayCursor> {
    const rec = await loadRecording(file);
    this.lessonToken++;
    await this.quiesce();
    this.stopReplay();
    void this.recorder?.close();
    this.recorder = undefined;
    this.lesson = null;
    for (const [k, v] of Object.entries(rec.header.flags ?? {})) this.setPolicy(k as PolicyKey, v as boolean);
    const cursor = new ReplayCursor(rec, () => this.world.tick);
    this.replay = cursor;
    this.hub.backend = 'faux';
    this.hub.faux.setResponses([]);
    this.hub.setOfflineBrain(cursor.factory);
    this.installWorld(new World({ seed: rec.header.seed, autoSpawn: rec.header.autoSpawn, autoHazards: rec.header.autoHazards }));
    this.dispatcher.enabled = true;
    if (this.clock) this.world.setSpeed(speed);
    let finished = false;
    let shiftEnded = false;
    const emit = (status: 'running' | 'done' | 'diverged', note?: string) => {
      if (finished) return;
      if (status !== 'running') finished = true;
      this.bus.app({ kind: 'replay', status, file, matched: cursor.matched, total: cursor.total, divergence: cursor.divergence, note });
    };
    // 录制回复用完、或班次已结束且船员都空闲时，回放结束
    const maybeDone = () => {
      if (finished || this.crew().some((c) => c.isRunning)) return;
      if (cursor.remaining === 0 || shiftEnded) emit(cursor.divergence ? 'diverged' : 'done', `工具调用吻合 ${cursor.matched}/${cursor.total}`);
    };
    const ops = [...rec.operators].sort((a, b) => a.tick - b.tick);
    const offWorld = this.world.subscribe(({ tick, events }) => {
      while (ops.length && ops[0].tick <= tick) void handleOperator(this, ops.shift()!.msg, { replaying: true });
      if (events.some((e) => e.type === 'shift.ended')) {
        shiftEnded = true;
        setTimeout(maybeDone, 50);
      }
    });
    this.approvals.onRequest = (info) => {
      const d = rec.approvals.get(info.toolCallId);
      if (d) setTimeout(() => this.approvals.decide(info.approvalId, d === 'approve' ? 'approve' : 'deny', '回放：录制时的决定'), 30);
    };
    const offBus = this.bus.subscribe((m) => {
      if (m.t === 'agent' && m.ev.type === 'tool_execution_start') {
        const div = cursor.observeTool(m.agentId, m.ev.toolName);
        if (div) emit('diverged', `首个分歧：${div.agentId} 第 ${div.index + 1} 次工具调用，录制 ${div.expected ?? '（无）'}，回放 ${div.got}`);
      }
      if (m.t === 'app' && m.ev.kind === 'crew' && m.ev.crew.every((c) => c.status !== 'running')) setTimeout(maybeDone, 50);
    });
    this.replayCleanup = () => {
      offWorld();
      offBus();
      this.approvals.onRequest = undefined;
    };
    emit('running');
    return cursor;
  }

  private async runReplayLesson(script: LessonScript): Promise<void> {
    // 精选录制入库在 recordings/；本地录制目录（recordDir）也找一下
    const dirs = [...new Set(['recordings', this.recordDir ?? 'recordings'])];
    let file: string | undefined;
    for (const f of script.replay ?? []) {
      for (const dir of dirs) {
        if (file) break;
        try {
          await stat(join(dir, f));
          file = join(dir, f);
        } catch {
          /* 下一个 */
        }
      }
    }
    if (!file) {
      this.bus.app({ kind: 'notice', level: 'warn', text: `没有找到录制文件：${script.replay?.join('、')}` });
      return;
    }
    const cursor = await this.startReplay(file);
    this.lesson = { meta: script.meta, mode: 'faux', status: 'running' };
    this.bus.app({ kind: 'lesson', lesson: script.meta, mode: 'faux', status: 'running', note: file });
    const token = this.lessonToken;
    await new Promise<void>((resolve) => {
      const off = this.bus.subscribe((m) => {
        if (token !== this.lessonToken) return (off(), resolve());
        if (m.t === 'app' && m.ev.kind === 'replay' && (m.ev.status === 'done' || m.ev.status === 'diverged')) {
          off();
          resolve();
        }
      });
    });
    if (token !== this.lessonToken || !this.lesson) return;
    this.lesson.status = cursor.divergence ? 'error' : 'done';
    this.bus.app({ kind: 'lesson', lesson: script.meta, mode: 'faux', status: this.lesson.status, note: cursor.divergence ? `回放分歧：${JSON.stringify(cursor.divergence)}` : `回放一致：${cursor.matched}/${cursor.total}` });
  }

  private stopReplay(): void {
    this.replayCleanup?.();
    this.replayCleanup = undefined;
    if (this.replay) this.hub.setOfflineBrain(offlineBrain);
    this.replay = undefined;
  }

  /**
   * 会话恢复（§9）：1.1 不再提供 harness 会话存储，这里自己实现。
   * 世界：用日志里记下的 seed 与命令序列逐 tick 重放（世界只依赖这两样，§6.4）；
   * 船员：用日志里各船员的 message_end 重建 agent.state.messages。
   */
  async restoreSession(file: string): Promise<void> {
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const startIdx = lines.findLastIndex((l) => l.t === 'world.start' && !l.lesson);
    if (startIdx < 0) throw new Error('日志里没有可恢复的自由模式世界');
    const start = lines[startIdx] as { seed: number; autoSpawn: boolean; autoHazards: boolean };
    const rest = lines.slice(startIdx + 1);
    const commands = rest.filter((l) => l.t === 'command') as Array<{ tick: number; cmd: WorldCommand }>;
    const lastTick = Math.max(0, ...rest.filter((l) => l.t === 'world').map((l) => Number(l.tick)));
    this.lessonToken++;
    await this.quiesce();
    this.stopReplay();
    this.lesson = null;
    const world = new World({ seed: start.seed, autoSpawn: start.autoSpawn, autoHazards: start.autoHazards });
    let ci = 0;
    while (world.tick < lastTick) {
      while (ci < commands.length && commands[ci].tick <= world.tick + 1) world.enqueue(commands[ci++].cmd);
      world.step();
    }
    this.hub.backend = this.hub.liveAvailable ? 'live' : 'faux';
    this.hub.setOfflineBrain(offlineBrain);
    this.installWorld(world);
    const transcripts = new Map<CrewId, AgentMessage[]>();
    for (const l of rest) {
      const ev = l.ev as { type?: string; message?: AgentMessage } | undefined;
      if (l.t === 'agent' && ev?.type === 'message_end' && ev.message) {
        const id = l.agentId as CrewId;
        (transcripts.get(id) ?? transcripts.set(id, []).get(id)!).push(ev.message);
      }
    }
    for (const m of this.crew()) {
      const restored = transcripts.get(m.id);
      if (restored?.length) m.agent.state.messages = [...m.agent.state.messages.filter((x) => x.role === 'system').slice(0, 1), ...restored];
    }
    this.dispatcher.enabled = true;
    const counts = this.crew().map((m) => `${m.spec.name} ${transcripts.get(m.id)?.length ?? 0}`).join('、');
    this.bus.app({ kind: 'notice', level: 'info', text: `已恢复班次：世界重放到 T+${lastTick}s（${commands.length} 条命令），消息 ${counts}` });
  }

  async listFiles(): Promise<void> {
    const ls = async (dir: string, pred: (f: string) => boolean) => {
      try {
        const files = (await readdir(dir)).filter(pred);
        return Promise.all(files.map(async (f) => ({ file: join(dir, f), size: (await stat(join(dir, f))).size })));
      } catch {
        return [];
      }
    };
    const recordings = (await ls(this.recordDir ?? 'recordings', (f) => f.endsWith('.jsonl'))).map((r) => ({ ...r, curated: !r.file.endsWith('.local.jsonl') }));
    const missions = await ls(this.config.missionsDir, (f) => f.endsWith('.jsonl'));
    this.bus.app({ kind: 'files', recordings, missions });
  }

  /** 班末评审（§5.12）：agentLoop 低层循环，同时跑一次 Agent 对照组，量出屏障语义的差别 */
  async review(): Promise<void> {
    const snap = this.world.snapshot();
    const summary = { ...snap.score, tick: snap.tick, signals: snap.signals.length, flares: this.dispatcher.log.filter((r) => r.event === 'flare.warning').length };
    const review = await judgeShift(this.hub, summary);
    const agentBarrier = await barrierProbe(this.hub);
    this.bus.app({ kind: 'review', ...review, agentBarrier });
  }

  telemetrySnapshot(): void {
    const spans = this.telemetry.getSpans().slice(-400);
    this.bus.app({ kind: 'telemetry', spans: spans.map((s) => ({ ...s, attributes: { ...s.attributes }, events: s.events.map((e) => ({ ...e })) })) as never });
  }

  async setSatellite(state: 'online' | 'offline'): Promise<void> {
    this.satelliteOnline = state === 'online';
    await this.ground?.uplink(this.world.tick, this.world.forecast(), state);
  }

  /**
   * 舱段 / 班次阶段变化时同步每个船员的上下文（§5.3）：
   * - 工具：按舱段状态增删（pi 在下一次请求前自动写入工具差异 system 消息）
   * - 提示词：station_status / watch_phase 两个 section 打补丁，随下一批消息送达
   */
  syncContext(): void {
    const snap = this.world.snapshot();
    const sections = { station_status: stationStatusSection(snap), watch_phase: watchPhaseSection(snap.phase) };
    const key = JSON.stringify(sections);
    for (const m of this.crew()) {
      const gsNames = new Set(this.ground?.tools.map((t) => t.name) ?? []);
      const comms = this.world.module('comms').status !== 'offline';
      m.syncTools((name) => (gsNames.has(name) ? comms : toolAvailable(name, this.world, m.id, this.flags)));
      if (this.lastSections.get(m.id) !== key) {
        if (this.lastSections.has(m.id)) m.patchSections(sections);
        this.lastSections.set(m.id, key);
      }
    }
  }

  setPolicy(key: PolicyKey, value: boolean): void {
    this.flags[key] = value;
    if (!this.replay) this.recorder?.policy(key, value);
    if (key === 'delegation') {
      this.dispatcher.autoDuty = !value;
      if (this.world) this.syncContext();
    }
    this.bus.app({ kind: 'policy', flags: { ...this.flags }, stepping: this.stepper.enabled });
  }

  setStepping(enabled: boolean): void {
    this.stepper.set(enabled);
    this.bus.app({ kind: 'policy', flags: { ...this.flags }, stepping: this.stepper.enabled });
  }

  get commander(): CrewMember {
    return this.members.get('commander')!;
  }

  member(id: CrewId): CrewMember | undefined {
    return this.members.get(id);
  }

  crew(): CrewMember[] {
    return CREW_ORDER.flatMap((id) => this.members.get(id) ?? []);
  }

  crewViews(): CrewView[] {
    return this.crew().map((c) => c.view());
  }

  info(): ServerInfo {
    return { mode: this.config.mode, triageSamples: this.hub.triageSamples, currency: this.config.currency, usdRate: this.config.usdRate, lessons: lessonList() };
  }

  hello(): Extract<ServerMsg, { t: 'hello' }> {
    return {
      t: 'hello',
      seq: this.bus.lastSeq,
      world: this.world.snapshot(),
      crew: this.crewViews(),
      info: this.info(),
      lesson: this.lesson?.meta ?? null,
      policy: { ...this.flags },
      stepping: this.stepper.enabled,
      paused: this.stepper.current,
      approvals: this.approvals.list().map((a) => ({ kind: 'approval.requested' as const, ...a })),
      history: this.bus.history(),
    };
  }

  /** 自由模式：自动生成信号与耀斑，离线时由 faux 离线大脑接管 */
  startFreePlay(): void {
    this.lesson = null;
    this.stopReplay();
    this.hub.backend = this.hub.liveAvailable ? 'live' : 'faux';
    this.hub.faux.setResponses([]);
    this.hub.setOfflineBrain(offlineBrain);
    this.installWorld(new World({ seed: this.config.seed, autoSpawn: this.autoSpawn, autoHazards: this.autoHazards }));
    this.dispatcher.enabled = true;
    if (this.recordDir) {
      void this.recorder?.close();
      this.recorder = new Recorder(join(this.recordDir, `${this.missionId}-${Date.now().toString(36)}.local.jsonl`), () => this.world.tick);
      this.recorder.start(
        {
          seed: this.config.seed,
          autoSpawn: this.autoSpawn,
          autoHazards: this.autoHazards,
          mode: this.hub.backend,
          models: { commander: this.config.commanderModel, specialist: this.config.specialistModel },
          flags: { ...this.flags },
        },
        this.bus,
      );
    }
    this.bus.app({ kind: 'lesson', lesson: null, status: 'done' });
    if (!this.hub.liveAvailable) this.bus.app({ kind: 'notice', level: 'info', text: '未配置 GLM_API_KEY：离线演示模式（faux 离线大脑）' });
  }

  async loadLesson(id: string, mode: 'faux' | 'live'): Promise<void> {
    const script = getLesson(id);
    if (!script) {
      this.bus.app({ kind: 'notice', level: 'warn', text: `课程 ${id} 尚未实现` });
      return;
    }
    if (script.replay) return this.runReplayLesson(script);
    if (mode === 'live' && !this.hub.liveAvailable) {
      this.bus.app({ kind: 'notice', level: 'warn', text: '没有 API key，改用 faux 模式' });
      mode = 'faux';
    }
    const token = ++this.lessonToken;
    await this.quiesce();
    this.stopReplay();
    void this.recorder?.close();
    this.recorder = undefined;
    if (script.setup?.groundStation && !this.groundReady) this.groundReady = this.startGroundStation();
    if (this.groundReady) {
      await this.groundReady;
      if (this.satelliteOnline) await this.setSatellite('offline'); // 每课从「卫星未上线」开始
      await new Promise((r) => setTimeout(r, 50));
    }
    this.dispatcher.enabled = false;
    this.hub.backend = mode;
    this.hub.setOfflineBrain(undefined);
    this.hub.faux.setResponses([]);
    const world = new World({ seed: script.seed, autoSpawn: false, autoHazards: false });
    const savedFlags = { ...this.flags };
    const savedBudget = this.contextBudget;
    const savedSamples = this.hub.triageSamples;
    this.installWorld(world);
    this.applySetup(script, world);
    this.lesson = { meta: script.meta, mode, status: 'running' };
    this.bus.app({ kind: 'lesson', lesson: script.meta, mode, status: 'running' });

    try {
      for (const step of script.steps) {
        if (token !== this.lessonToken) return;
        const member = this.members.get(step.target ?? 'commander')!;
        const cleanup = this.autopilot(step, member.id);
        if (step.thinkingLevel) member.agent.state.thinkingLevel = step.thinkingLevel;
        this.bus.app({ kind: 'crew', crew: [member.view()] });
        if (mode === 'faux') this.hub.faux.setResponses(step.responses);
        for (const [k, v] of Object.entries(step.policy ?? {})) this.setPolicy(k as PolicyKey, v);
        if (step.before?.repair) this.world.repairNow(step.before.repair);
        if (step.before?.satellite) {
          const gs = await this.groundStationReady();
          const changed = new Promise<void>((resolve) => {
            const off = this.bus.subscribe((m) => {
              if (m.t === 'app' && m.ev.kind === 'notice' && m.ev.text.startsWith('地面站工具')) (off(), resolve());
            });
            setTimeout(() => (off(), resolve()), 3000);
          });
          await this.setSatellite(step.before.satellite);
          if (gs) await changed; // 等 tools/list_changed 走完一圈
        }
        if (step.before?.spawn) for (let i = 0; i < step.before.spawn; i++) this.world.spawnNow();
        const t = step.trigger;
        const msg =
          t.kind === 'judge' || t.kind === 'triage'
            ? []
            : t.kind === 'situation'
            ? situationMessage(this.world.snapshot(), [t.reason])
            : t.kind === 'duty'
              ? worldEventMessage('duty', t.text)
              : t.kind === 'custom'
                ? t.messages.map((c) => this.customMessage(c))
                : operatorMessage(t.text, 'prompt');
        if (t.kind === 'judge' || t.kind === 'triage') {
          if (t.kind === 'judge') await this.review();
          else {
            this.hub.triageSamples = t.samples;
            const s = this.world.snapshot().signals[0];
            if (s) await triageSignal(this.hub, this.world, this.bus, s, radioTranscript(s));
          }
          cleanup();
          continue;
        }
        if (t.kind === 'operator') this.bus.app({ kind: 'operator.echo', target: member.id, text: t.text, mode: 'prompt' });
        if (step.changeBeforeRun === 'spawn') this.world.spawnNow();
        try {
          await member.run(msg);
        } finally {
          cleanup();
        }
      }
      if (token !== this.lessonToken) return;
      this.telemetrySnapshot();
      this.lesson.status = 'done';
      this.bus.app({ kind: 'lesson', lesson: script.meta, mode, status: 'done' });
    } catch (err) {
      if (token !== this.lessonToken) return;
      this.lesson.status = 'error';
      this.bus.app({ kind: 'lesson', lesson: script.meta, mode, status: 'error', note: String(err) });
    } finally {
      if (script.setup?.policy || script.steps.some((st) => st.policy)) for (const [k, v] of Object.entries(savedFlags)) this.setPolicy(k as PolicyKey, v);
      this.contextBudget = savedBudget;
      this.hub.triageSamples = savedSamples;
    }
  }

  private autoSpawnOf(world: World): boolean {
    return world.options.autoSpawn ?? true;
  }

  private autoHazardsOf(world: World): boolean {
    return world.options.autoHazards ?? true;
  }

  private customMessage(c: { role: 'radio' | 'world_event' | 'ui_note' | 'situation'; text: string }) {
    const first = this.world.snapshot().signals[0];
    switch (c.role) {
      case 'radio':
        return radioMessage(first?.id ?? 'S-01', c.text);
      case 'world_event':
        return worldEventMessage('lesson', c.text);
      case 'ui_note':
        return { role: 'ui_note' as const, text: c.text, timestamp: Date.now() };
      default:
        return situationMessage(this.world.snapshot(), [c.text]);
    }
  }

  /** 课程自动驾驶：按脚本代替主管审批；在指定工具开始时插话。返回清理函数。 */
  private autopilot(step: LessonScript['steps'][number], target: CrewId): () => void {
    const decisions = [...(step.approvals ?? [])];
    const timers: NodeJS.Timeout[] = [];
    this.approvals.onRequest = decisions.length
      ? (info) => {
          const d = decisions.shift();
          if (d) timers.push(setTimeout(() => this.approvals.decide(info.approvalId, d, '课程自动驾驶'), 1500));
        }
      : undefined;
    const injects = [...(step.inject ?? [])];
    const off = injects.length
      ? this.bus.subscribe((m) => {
          if (m.t !== 'agent' || m.agentId !== target || m.ev.type !== 'tool_execution_start') return;
          const tool = m.ev.toolName;
          for (const inj of injects.filter((i) => i.onTool === tool)) {
            injects.splice(injects.indexOf(inj), 1);
            const member = this.members.get(target)!;
            const action = member.deliver(operatorMessage(inj.text, inj.mode), inj.mode);
            this.bus.app({ kind: 'operator.echo', target, text: inj.text, mode: action });
          }
        })
      : () => {};
    return () => {
      this.approvals.onRequest = undefined;
      timers.forEach(clearTimeout);
      off();
    };
  }

  async exitLesson(): Promise<void> {
    this.lessonToken++;
    await this.quiesce();
    this.startFreePlay();
  }

  async shutdown(): Promise<void> {
    this.world?.stop();
    this.stopReplay();
    await this.recorder?.close();
    await this.ground?.close().catch(() => {});
    for (const m of this.members.values()) m.abort();
    await this.journal?.close();
  }

  private applySetup(script: LessonScript, world: World): void {
    const setup = script.setup ?? {};
    for (let i = 0; i < (script.spawnSignals ?? 0); i++) world.spawnNow();
    for (const d of setup.damage ?? []) world.damageModule(d.module, d.status, d.incident);
    if (setup.flareOnFirstSignal !== undefined) {
      const first = world.snapshot().signals[0];
      if (first) {
        world.scheduleFlare([first.sector], setup.flareOnFirstSignal);
        for (let i = 0; i < setup.flareOnFirstSignal + 1; i++) world.step();
      }
    }
    // 在同一 seed 下一直生成，直到凑够 n 个真实且危急的信号；其余的信号不影响课程
    let critical = 0;
    for (let i = 0; i < 200 && critical < (setup.criticalSignals ?? 0); i++) {
      const s = world.spawnNow();
      const t = world.truthOf(s.id)!;
      if (!t.hoax && t.severity === 'critical') {
        critical++;
        world.inspect(s.id);
      }
    }
    if (setup.criticalSignals) {
      // 只保留危急信号，避免态势过长
      for (const s of world.snapshot().signals) if (!world.signal(s.id)!.clues.length) world.retire(s.id);
    }
    for (const [k, v] of Object.entries(setup.policy ?? {})) this.setPolicy(k as PolicyKey, v);
    if (setup.contextBudget) this.contextBudget = setup.contextBudget;
    if (setup.patient) {
      for (let i = 0; i < 200; i++) {
        const s = world.spawnNow();
        const t = world.truthOf(s.id)!;
        if (!t.hoax && t.members.length >= 2) {
          world.admitSurvivors(s.id);
          break;
        }
        world.retire(s.id);
      }
    }
    this.syncContext();
  }

  private async quiesce(): Promise<void> {
    this.stepper.set(false);
    this.approvals.clear();
    for (const m of this.members.values()) {
      m.agent.clearAllQueues();
      m.abort();
    }
    await Promise.all([...this.members.values()].map((m) => m.agent.waitForIdle()));
  }

  private installWorld(world: World): void {
    this.offWorld?.();
    this.offDispatch?.();
    this.world?.stop();
    this.world = world;
    this.journal?.write({ t: 'world.start', seed: world.seed, autoSpawn: this.autoSpawnOf(world), autoHazards: this.autoHazardsOf(world), lesson: this.lesson?.meta.id ?? null, at: Date.now() });
    let logged = world.commandLog.length;
    this.offWorld = world.subscribe(({ tick, events, patch }) => {
      // 注意：不能写成 journal?.write({ ...log[logged++] })——没有 journal 时可选链会跳过参数求值，logged 永不递增
      for (; logged < world.commandLog.length; logged++) this.journal?.write({ t: 'command', ...world.commandLog[logged] });
      if (Object.keys(patch).length) this.bus.world(tick, patch);
      for (const ev of events) this.bus.app({ kind: 'world.event', ev });
      if (events.some((e) => e.type === 'shift.ended') && !this.lesson) void this.review().catch(() => {});
      if (events.some((e) => e.type === 'module.damaged' || e.type === 'module.repaired' || e.type.startsWith('flare.'))) this.syncContext();
      if (this.ground && tick % 10 === 0) {
        const satellite = !this.lesson && !this.satelliteOnline && tick >= this.satelliteAt ? 'online' : undefined;
        if (satellite) {
          this.satelliteOnline = true;
          this.bus.app({ kind: 'notice', level: 'info', text: '天气卫星上线：地面站开始提供耀斑预报' });
        }
        void this.ground.uplink(tick, world.forecast(), satellite).catch(() => {});
      }
    });
    this.offDispatch = this.dispatcher.attach(world);
    const specs = crewSpecs(this.config);
    this.members.clear();
    this.lastSections.clear();
    const codemodeStore = {};
    this.telemetry = new InMemoryTelemetryContext();
    const transformContext = () => viewTrim(() => this.contextBudget, () => this.flags.viewTrim);
    const afterRun = afterRunCompactor({ hub: this.hub, bus: this.bus, enabled: () => this.flags.compaction, budget: () => this.contextBudget });
    for (const id of CREW_ORDER) {
      this.members.set(
        id,
        createCrewMember(specs[id], {
          hub: this.hub,
          bus: this.bus,
          world,
          missionId: this.missionId,
          flags: this.flags,
          stepper: this.stepper,
          approvals: this.approvals,
          crew: (cid) => this.members.get(cid),
          transformContext,
          afterRun,
          codemodeStore,
          telemetry: this.telemetry,
          flush: this.journal ? () => this.journal!.flush() : undefined,
        }),
      );
    }
    if (this.ground?.tools.length) this.members.get('commander')!.addTools(this.ground.tools);
    this.syncContext();
    this.bus.world(world.tick, world.snapshot());
    this.bus.app({ kind: 'crew', crew: this.crewViews() });
    if (this.clock) world.start();
  }
}
