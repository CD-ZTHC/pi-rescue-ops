// ④ 底栏：事件时间轴 · 单步 · 调速 · 课程 1–22 · 「模型看到的上下文」抽屉
import { formatTick } from '@rescue/protocol';
import { zh } from '../i18n/zh.ts';
import { send } from '../net/client.ts';
import { useUi, useWorld } from '../store/index.ts';

const SPEEDS = [0, 0.5, 1, 2] as const;

export function BottomBar() {
  const world = useWorld((s) => s.world);
  const { info, lesson } = useUi();
  const progress = world ? world.tick / world.shiftTicks : 0;
  return (
    <footer className="panel flex h-12 shrink-0 items-center gap-4 px-3 text-[12px]">
      <div className="relative h-2 w-48 shrink-0 overflow-hidden rounded-full bg-slate-800" title="班次进度（M7 起可拖动回放）">
        <div className="absolute inset-y-0 left-0 bg-gradient-to-r from-cyan-500/60 to-cyan-300" style={{ width: `${progress * 100}%` }} />
        {world?.signals.map((s) => (
          <span
            key={s.id}
            className="absolute top-0 h-2 w-[2px]"
            style={{ left: `${(s.spawnedTick / world.shiftTicks) * 100}%`, background: s.status === 'lost' ? '#f43f5e' : '#fb923c' }}
          />
        ))}
      </div>
      {world && <span className="num text-slate-400">{formatTick(world.tick)}</span>}

      <button className="rounded-md border border-slate-700 px-2 py-1 text-slate-500" disabled title="单步调试在 M3 实现">
        ⏯ {zh.bottom.step}
      </button>

      <div className="flex items-center gap-1">
        <span className="text-slate-400">{zh.bottom.speed}</span>
        <div className="flex overflow-hidden rounded-md border border-slate-700">
          {SPEEDS.map((sp) => (
            <button
              key={sp}
              className={`num px-2 py-1 ${world?.speed === sp ? 'bg-cyan-500/20 text-cyan-100' : 'text-slate-400 hover:text-slate-200'}`}
              onClick={() => send({ t: 'world.speed', speed: sp })}
              aria-pressed={world?.speed === sp}
            >
              {sp === 0 ? '⏸' : `${sp}×`}
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-thin">
        <span className="shrink-0 text-slate-400">{zh.bottom.lessons}</span>
        {info?.lessons.map((l) => {
          const active = lesson?.meta.id === l.id;
          return (
            <button
              key={l.id}
              disabled={!l.available}
              title={`${l.index}. ${l.title} — ${l.capability}${l.available ? '' : `（${zh.bottom.lessonLater(l.milestone)}）`}`}
              className={`num size-6 shrink-0 rounded text-[11px] ${
                active ? 'bg-violet-500 text-white' : l.available ? 'bg-violet-500/15 text-violet-200 hover:bg-violet-500/30' : 'bg-slate-800/60 text-slate-600'
              }`}
              onClick={() => send({ t: 'lesson.load', lessonId: l.id, mode: 'faux' })}
            >
              {l.index}
            </button>
          );
        })}
      </div>

      <button
        className="shrink-0 rounded-md border border-cyan-500/40 px-2.5 py-1 text-cyan-200 hover:bg-cyan-500/10"
        onClick={() => {
          useUi.setState({ contextOpen: true });
          send({ t: 'context.request', agentId: 'commander' });
        }}
      >
        ⧉ {zh.bottom.context}
      </button>
    </footer>
  );
}
