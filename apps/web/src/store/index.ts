// Zustand：按 slice 划分（§7.1）。runs / comms 是可变模型，按 requestAnimationFrame 合并刷新。
import { create } from 'zustand';
import { defaultPolicyFlags, type AppEvent, type CrewId, type CrewView, type LessonMeta, type PolicyFlags, type ServerInfo, type ServerMsg, type WorldSnapshot } from '@rescue/protocol';
import { CommsModel } from './comms.ts';
import { RunsModel } from './runs.ts';

export const runsModel = new RunsModel();
export const commsModel = new CommsModel();

interface WorldSlice {
  world?: WorldSnapshot;
  /** 最近一次世界补丁到达的本地时间，用于 1 Hz → 60 fps 插值 */
  receivedAt: number;
}
export const useWorld = create<WorldSlice>(() => ({ receivedAt: 0 }));

/** runs / comms 的版本号：组件订阅它来重渲染 */
export const useModels = create<{ runs: number; comms: number }>(() => ({ runs: 0, comms: 0 }));

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  text: string;
}

interface UiSlice {
  connection: 'connecting' | 'open' | 'closed';
  info?: ServerInfo;
  crew: CrewView[];
  lesson: { meta: LessonMeta; mode?: 'faux' | 'live'; status: string; note?: string } | null;
  selectedSignal?: string;
  /** 三处联动焦点：toolCallId / correlationId */
  focus?: string;
  contextOpen: boolean;
  contextView?: Extract<AppEvent, { kind: 'context.view' }>;
  toasts: Toast[];
  widths: [number, number];
  policy: PolicyFlags;
  stepping: boolean;
  paused: Extract<AppEvent, { kind: 'step.paused' }> | null;
  approvals: Array<Extract<AppEvent, { kind: 'approval.requested' }>>;
  queues: Partial<Record<CrewId, Extract<AppEvent, { kind: 'queue' }>>>;
  meters: Partial<Record<CrewId, Extract<AppEvent, { kind: 'context.meter' }>>>;
  bench: Array<Extract<AppEvent, { kind: 'bench.result' }> & { at: number }>;
  contextAgent: CrewId;
  benchOpen: boolean;
  policyOpen: boolean;
  spansOpen: boolean;
  spans?: Extract<AppEvent, { kind: 'telemetry' }>['spans'];
  /** Inspector 里点开的请求（第 21 课：耗时构成与原始 chunk） */
  requestDetail?: import('./runs.ts').RequestView & { agentId: CrewId };
}

export const useUi = create<UiSlice>(() => ({
  connection: 'connecting',
  crew: [],
  lesson: null,
  contextOpen: false,
  toasts: [],
  widths: [0.34, 0.36],
  policy: defaultPolicyFlags(),
  stepping: false,
  paused: null,
  approvals: [],
  queues: {},
  meters: {},
  bench: [],
  contextAgent: 'commander',
  benchOpen: false,
  policyOpen: false,
  spansOpen: false,
}));

/** 服务端墙钟与本地时钟的偏差：取观测到的最小值（网络延迟只会让差值变大） */
let clockOffset: number | undefined;
export function serverNow(): number {
  return Date.now() - (clockOffset ?? 0);
}
function observeClock(at: number): void {
  const d = Date.now() - at;
  if (clockOffset === undefined || d < clockOffset) clockOffset = d;
}

let frame = 0;
let dirtyRuns = false;
let dirtyComms = false;

function schedule(): void {
  if (frame) return;
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: () => void) => setTimeout(cb, 16);
  frame = raf(() => {
    frame = 0;
    const s = useModels.getState();
    useModels.setState({ runs: s.runs + (dirtyRuns ? 1 : 0), comms: s.comms + (dirtyComms ? 1 : 0) });
    dirtyRuns = dirtyComms = false;
  }) as unknown as number;
}

let toastSerial = 0;
export function toast(level: Toast['level'], text: string): void {
  const id = ++toastSerial;
  useUi.setState((s) => ({ toasts: [...s.toasts.slice(-3), { id, level, text }] }));
  setTimeout(() => useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), level === 'error' ? 8000 : 4500);
}

function mergeCrew(list: CrewView[], updates: CrewView[]): CrewView[] {
  const map = new Map(list.map((c) => [c.id, c]));
  for (const u of updates) map.set(u.id, u);
  return [...map.values()];
}

export function ingest(msg: ServerMsg): void {
  switch (msg.t) {
    case 'hello':
      runsModel.reset();
      commsModel.reset();
      useWorld.setState({ world: msg.world, receivedAt: performance.now() });
      useUi.setState({
        info: msg.info,
        crew: msg.crew,
        lesson: msg.lesson ? { meta: msg.lesson, status: 'loaded' } : null,
        policy: msg.policy,
        stepping: msg.stepping,
        paused: msg.paused ? { kind: 'step.paused', ...msg.paused } : null,
        approvals: msg.approvals,
      });
      for (const h of msg.history) {
        runsModel.apply(h);
        commsModel.apply(h);
        // 状态型的应用事件也要回放（提示类、审批类不回放，避免弹出过期的提醒）
        if (h.t === 'app' && (h.ev.kind === 'context.meter' || h.ev.kind === 'queue' || h.ev.kind === 'crew')) applyUi(h.ev);
        observeClock(h.at);
      }
      dirtyRuns = dirtyComms = true;
      schedule();
      return;
    case 'world': {
      const prev = useWorld.getState().world;
      if (prev) useWorld.setState({ world: { ...prev, ...msg.patch }, receivedAt: performance.now() });
      return;
    }
    case 'agent':
      observeClock(msg.at);
      dirtyRuns = runsModel.apply(msg) || dirtyRuns;
      dirtyComms = commsModel.apply(msg) || dirtyComms;
      schedule();
      return;
    case 'app':
      observeClock(msg.at);
      dirtyRuns = runsModel.apply(msg) || dirtyRuns;
      dirtyComms = commsModel.apply(msg) || dirtyComms;
      applyUi(msg.ev);
      schedule();
      return;
  }
}

function applyUi(ev: AppEvent): void {
  switch (ev.kind) {
    case 'crew':
      useUi.setState((s) => ({ crew: mergeCrew(s.crew, ev.crew) }));
      return;
    case 'lesson':
      useUi.setState({ lesson: ev.lesson ? { meta: ev.lesson, mode: ev.mode, status: ev.status, note: ev.note } : null });
      if (ev.status === 'done' && ev.lesson) toast('info', `第 ${ev.lesson.index} 课完成`);
      if (ev.status === 'error') toast('error', `课程出错：${ev.note ?? ''}`);
      return;
    case 'notice':
      toast(ev.level, ev.text);
      return;
    case 'context.view':
      useUi.setState({ contextView: ev });
      return;
    case 'policy':
      useUi.setState({ policy: ev.flags, stepping: ev.stepping, ...(ev.stepping ? {} : { paused: null }) });
      return;
    case 'step.paused':
      useUi.setState({ paused: ev });
      return;
    case 'step.resumed':
      useUi.setState((s) => (s.paused?.agentId === ev.agentId ? { paused: null } : {}));
      return;
    case 'approval.requested':
      useUi.setState((s) => ({ approvals: [...s.approvals, ev] }));
      return;
    case 'approval.resolved':
      useUi.setState((s) => ({ approvals: s.approvals.filter((a) => a.approvalId !== ev.approvalId) }));
      if (ev.decision === 'timeout') toast('warn', '审批超时，视为否决');
      return;
    case 'queue':
      useUi.setState((s) => ({ queues: { ...s.queues, [ev.agentId]: ev } }));
      return;
    case 'telemetry':
      useUi.setState({ spans: ev.spans });
      return;
    case 'context.meter':
      useUi.setState((s) => ({ meters: { ...s.meters, [ev.agentId]: ev } }));
      return;
    case 'bench.result':
      useUi.setState((s) => ({ bench: [{ ...ev, at: Date.now() }, ...s.bench].slice(0, 20) }));
      return;
  }
}

export function crewColor(id: CrewId | string): string {
  return useUi.getState().crew.find((c) => c.id === id)?.color ?? '#94a3b8';
}
