// 站点运行时：持有世界、船员、调度器，把它们接到总线上。自由模式与课程模式在这里切换。
import type { CrewMember } from '../pi/crew.ts';
import { getLesson, lessonList } from '@rescue/lessons';
import type { CrewView, LessonMeta, ServerInfo, ServerMsg } from '@rescue/protocol';
import type { Config } from '../config.ts';
import { createCrewMember } from '../pi/crew.ts';
import { operatorMessage, situationMessage } from '../pi/messages.ts';
import { createModelHub, type ModelHub } from '../pi/models.ts';
import { offlineCommanderBrain } from '../pi/offline-brain.ts';
import { commanderSpec } from '../pi/roster.ts';
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
}

export interface LessonState {
  meta: LessonMeta;
  mode: 'faux' | 'live';
  status: 'loaded' | 'running' | 'done' | 'error';
}

export class Station {
  readonly bus: Bus;
  readonly hub: ModelHub;
  readonly config: Config;
  readonly missionId: string;
  readonly journal?: Journal;
  world!: World;
  commander!: CrewMember;
  readonly dispatcher: Dispatcher;
  lesson: LessonState | null = null;
  private offWorld?: () => void;
  private offDispatch?: () => void;
  private readonly clock: boolean;
  private readonly autoSpawn: boolean;
  private lessonToken = 0;

  constructor(config: Config, options: StationOptions = {}) {
    this.config = config;
    this.bus = options.bus ?? new Bus();
    this.hub = options.hub ?? createModelHub(config);
    this.clock = options.clock ?? true;
    this.autoSpawn = options.autoSpawn ?? true;
    this.missionId = `mission-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    if (options.journal ?? true) {
      this.journal = new Journal(config.missionsDir, this.missionId);
      this.journal.attach(this.bus);
    }
    this.dispatcher = new Dispatcher({ commander: () => this.commander });
  }

  crew(): CrewMember[] {
    return [this.commander];
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

  /** 自由模式：自动生成信号，离线时由 faux 离线大脑接管 */
  startFreePlay(): void {
    this.lesson = null;
    this.hub.backend = this.hub.liveAvailable ? 'live' : 'faux';
    this.hub.faux.setResponses([]);
    this.hub.setOfflineBrain(offlineCommanderBrain);
    this.installWorld(new World({ seed: this.config.seed, autoSpawn: this.autoSpawn }));
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
    const world = new World({ seed: script.seed, autoSpawn: false });
    this.installWorld(world);
    for (let i = 0; i < script.spawnSignals; i++) world.spawnNow();
    this.lesson = { meta: script.meta, mode, status: 'running' };
    this.bus.app({ kind: 'lesson', lesson: script.meta, mode, status: 'running' });

    try {
      for (const step of script.steps) {
        if (token !== this.lessonToken) return;
        if (step.thinkingLevel) this.commander.agent.state.thinkingLevel = step.thinkingLevel;
        this.bus.app({ kind: 'crew', crew: this.crewViews() });
        if (mode === 'faux') this.hub.faux.setResponses(step.responses);
        const msg =
          step.trigger.kind === 'situation'
            ? situationMessage(this.world.snapshot(), [step.trigger.reason])
            : operatorMessage(step.trigger.text, 'prompt');
        if (step.trigger.kind === 'operator') this.bus.app({ kind: 'operator.echo', target: 'commander', text: step.trigger.text, mode: 'prompt' });
        await this.commander.run(msg);
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
    this.commander?.abort();
    await this.journal?.close();
  }

  private async quiesce(): Promise<void> {
    if (!this.commander) return;
    this.commander.agent.clearAllQueues();
    this.commander.abort();
    await this.commander.agent.waitForIdle();
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
    this.commander = createCrewMember(commanderSpec(this.config), {
      hub: this.hub,
      bus: this.bus,
      world,
      missionId: this.missionId,
      flush: this.journal ? () => this.journal!.flush() : undefined,
    });
    this.bus.world(world.tick, world.snapshot());
    this.bus.app({ kind: 'crew', crew: this.crewViews() });
    if (this.clock) world.start();
  }
}
