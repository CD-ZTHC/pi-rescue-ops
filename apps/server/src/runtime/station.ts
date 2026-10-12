// 站点运行时：持有世界、船员、调度器，把它们接到总线上。自由模式与课程模式在这里切换。
import { getLesson, lessonList, type LessonScript } from '@rescue/lessons';
import type { CrewId, CrewView, LessonMeta, ServerInfo, ServerMsg } from '@rescue/protocol';
import type { Config } from '../config.ts';
import { createCrewMember, type CrewMember } from '../pi/crew.ts';
import { operatorMessage, situationMessage, worldEventMessage } from '../pi/messages.ts';
import { createModelHub, type ModelHub } from '../pi/models.ts';
import { offlineBrain } from '../pi/offline-brain.ts';
import { crewSpecs } from '../pi/roster.ts';
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
  lesson: LessonState | null = null;
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
    this.dispatcher = new Dispatcher({ crew: (id) => this.members.get(id) });
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
    return { mode: this.config.mode, currency: this.config.currency, usdRate: this.config.usdRate, lessons: lessonList() };
  }

  hello(): Extract<ServerMsg, { t: 'hello' }> {
    return {
      t: 'hello',
      seq: this.bus.lastSeq,
      world: this.world.snapshot(),
      crew: this.crewViews(),
      info: this.info(),
      lesson: this.lesson?.meta ?? null,
      history: this.bus.history(),
    };
  }

  /** 自由模式：自动生成信号与耀斑，离线时由 faux 离线大脑接管 */
  startFreePlay(): void {
    this.lesson = null;
    this.hub.backend = this.hub.liveAvailable ? 'live' : 'faux';
    this.hub.faux.setResponses([]);
    this.hub.setOfflineBrain(offlineBrain);
    this.installWorld(new World({ seed: this.config.seed, autoSpawn: this.autoSpawn, autoHazards: this.autoHazards }));
    this.dispatcher.enabled = true;
    this.bus.app({ kind: 'lesson', lesson: null, status: 'done' });
    if (!this.hub.liveAvailable) this.bus.app({ kind: 'notice', level: 'info', text: '未配置 GLM_API_KEY：离线演示模式（faux 离线大脑）' });
  }

  async loadLesson(id: string, mode: 'faux' | 'live'): Promise<void> {
    const script = getLesson(id);
    if (!script) {
      this.bus.app({ kind: 'notice', level: 'warn', text: `课程 ${id} 尚未实现` });
      return;
    }
    if (mode === 'live' && !this.hub.liveAvailable) {
      this.bus.app({ kind: 'notice', level: 'warn', text: '没有 API key，改用 faux 模式' });
      mode = 'faux';
    }
    const token = ++this.lessonToken;
    await this.quiesce();
    this.dispatcher.enabled = false;
    this.hub.backend = mode;
    this.hub.setOfflineBrain(undefined);
    this.hub.faux.setResponses([]);
    const world = new World({ seed: script.seed, autoSpawn: false, autoHazards: false });
    this.installWorld(world);
    this.applySetup(script, world);
    this.lesson = { meta: script.meta, mode, status: 'running' };
    this.bus.app({ kind: 'lesson', lesson: script.meta, mode, status: 'running' });

    try {
      for (const step of script.steps) {
        if (token !== this.lessonToken) return;
        const member = this.members.get(step.target ?? 'commander')!;
        if (step.thinkingLevel) member.agent.state.thinkingLevel = step.thinkingLevel;
        this.bus.app({ kind: 'crew', crew: [member.view()] });
        if (mode === 'faux') this.hub.faux.setResponses(step.responses);
        const t = step.trigger;
        const msg =
          t.kind === 'situation'
            ? situationMessage(this.world.snapshot(), [t.reason])
            : t.kind === 'duty'
              ? worldEventMessage('duty', t.text)
              : operatorMessage(t.text, 'prompt');
        if (t.kind === 'operator') this.bus.app({ kind: 'operator.echo', target: member.id, text: t.text, mode: 'prompt' });
        await member.run(msg);
      }
      if (token !== this.lessonToken) return;
      this.lesson.status = 'done';
      this.bus.app({ kind: 'lesson', lesson: script.meta, mode, status: 'done' });
    } catch (err) {
      if (token !== this.lessonToken) return;
      this.lesson.status = 'error';
      this.bus.app({ kind: 'lesson', lesson: script.meta, mode, status: 'error', note: String(err) });
    }
  }

  async exitLesson(): Promise<void> {
    this.lessonToken++;
    await this.quiesce();
    this.startFreePlay();
  }

  async shutdown(): Promise<void> {
    this.world?.stop();
    for (const m of this.members.values()) m.abort();
    await this.journal?.close();
  }

  private applySetup(script: LessonScript, world: World): void {
    for (let i = 0; i < (script.spawnSignals ?? 0); i++) world.spawnNow();
    for (const d of script.setup?.damage ?? []) world.damageModule(d.module, d.status, d.incident);
  }

  private async quiesce(): Promise<void> {
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
    this.offWorld = world.subscribe(({ tick, events, patch }) => {
      if (Object.keys(patch).length) this.bus.world(tick, patch);
      for (const ev of events) this.bus.app({ kind: 'world.event', ev });
    });
    this.offDispatch = this.dispatcher.attach(world);
    const specs = crewSpecs(this.config);
    this.members.clear();
    for (const id of CREW_ORDER) {
      this.members.set(
        id,
        createCrewMember(specs[id], {
          hub: this.hub,
          bus: this.bus,
          world,
          missionId: this.missionId,
          flush: this.journal ? () => this.journal!.flush() : undefined,
        }),
      );
    }
    this.bus.world(world.tick, world.snapshot());
    this.bus.app({ kind: 'crew', crew: this.crewViews() });
    if (this.clock) world.start();
  }
}
