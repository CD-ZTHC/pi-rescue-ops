import { formatTick } from '@rescue/protocol';
import { zh } from '../i18n/zh.ts';
import { runsModel, useModels, useUi, useWorld } from '../store/index.ts';
import { formatCost } from './format.ts';

function Meter(props: { value: number; max: number; segments?: number; color: string }) {
  const n = props.segments ?? 5;
  const filled = Math.round((props.value / props.max) * n);
  return (
    <span className="inline-flex gap-[2px]" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <span key={i} className="h-3 w-[6px] rounded-[1px]" style={{ background: i < filled ? props.color : 'rgb(51 65 85 / 0.7)' }} />
      ))}
    </span>
  );
}

function Stat(props: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap" title={props.title}>
      <span className="text-slate-400">{props.label}</span>
      {props.children}
    </div>
  );
}

export function TopBar() {
  const world = useWorld((s) => s.world);
  const { info, connection, crew, lesson } = useUi();
  useModels((s) => s.runs);
  if (!world) return <div className="panel h-11 shrink-0" />;
  const docked = world.drones.filter((d) => d.status === 'docked').length;
  const fuelColor = world.fuel > 50 ? '#22d3ee' : world.fuel > 25 ? '#f59e0b' : '#f43f5e';
  return (
    <header className="panel flex h-11 shrink-0 items-center gap-5 overflow-x-auto px-4 text-[13px] scrollbar-thin">
      <div className="flex items-center gap-2 whitespace-nowrap">
        <span className="relative flex size-2.5">
          <span className={`absolute inline-flex size-full rounded-full ${connection === 'open' ? 'animate-ping bg-emerald-400/60' : 'bg-amber-400/60'}`} />
          <span className={`relative inline-flex size-2.5 rounded-full ${connection === 'open' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
        </span>
        <span className="font-bold tracking-widest text-cyan-200">{zh.station}</span>
        <span className="text-slate-400">{zh.title}</span>
      </div>
      <Stat label={zh.shift}>
        <span className="num text-slate-100">
          {formatTick(world.tick)}
          <span className="text-slate-500">/{formatTick(world.shiftTicks).slice(2)}</span>
        </span>
      </Stat>
      <Stat label={zh.fuel} title={`${world.fuel}/${world.fuelMax}`}>
        <Meter value={world.fuel} max={world.fuelMax} color={fuelColor} />
        <span className="num text-slate-300">{world.fuel}</span>
      </Stat>
      <Stat label={zh.drones}>
        <span className="num">{docked}/{world.drones.length}</span>
      </Stat>
      <Stat label={zh.beds}>
        <span className="num">{world.beds}/{world.bedsTotal}</span>
      </Stat>
      <Stat label={zh.rescued}>
        <span className="num text-emerald-300">{world.score.rescued}</span>
      </Stat>
      <Stat label={zh.score}>
        <span className="num">{world.score.total}</span>
      </Stat>
      <Stat label={zh.cost} title={`累计 ${runsModel.totalTokens} token，按 model.cost 计算`}>
        <span className="num text-pink-200">{formatCost(runsModel.totalCost, info)}</span>
      </Stat>
      <div className="ml-auto flex items-center gap-3">
        {crew.map((c) => (
          <span
            key={c.id}
            className="flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[12px]"
            style={{ borderColor: `${c.color}55`, color: c.color }}
            title={`${c.title} · ${c.model} · 思考 ${c.thinkingLevel}${c.vision ? '' : ' · 看不见图片'}`}
          >
            <span className={`size-1.5 rounded-full ${c.status === 'running' ? 'animate-pulse' : ''}`} style={{ background: c.status === 'error' ? '#f43f5e' : c.color }} />
            {c.name}
            <span className="text-slate-400">{c.status === 'running' ? '运行中' : c.status === 'error' ? '失联' : '待命'}</span>
          </span>
        ))}
        {lesson && (
          <span className="whitespace-nowrap rounded-md bg-violet-500/15 px-2 py-0.5 text-[12px] text-violet-200">
            第 {lesson.meta.index} 课 · {lesson.meta.title}
          </span>
        )}
        <span
          className={`whitespace-nowrap rounded-md px-2 py-0.5 text-[12px] ${info?.mode === 'live' ? 'bg-cyan-500/15 text-cyan-200' : 'bg-amber-500/15 text-amber-200'}`}
        >
          {info?.mode === 'live' ? zh.modeLive : zh.modeOffline}
        </span>
        {connection !== 'open' && <span className="text-amber-300">{zh.reconnecting}</span>}
      </div>
    </header>
  );
}
