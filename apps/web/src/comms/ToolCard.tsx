// 工具结果卡片：content 是给模型看的，structuredContent 是给这里渲染富卡片的（§5.4「两份结果」）。
import { CREW_COLORS, MODULE_NAMES, type ModuleId } from '@rescue/protocol';
import type { ReactNode } from 'react';
import { zh } from '../i18n/zh.ts';
import { useUi } from '../store/index.ts';
import type { CommsEntry } from '../store/comms.ts';
import { useLightbox } from './Lightbox.tsx';

type ToolEntry = Extract<CommsEntry, { kind: 'tool' }>;
type Any = Record<string, any>;

const ICON: Record<string, string> = {
  scan_sector: '📡', compare_frames: '🎞', inspect_signal: '🔎', plot_course: '🧭', dispatch_drone: '🛸', allocate_fuel: '⛽',
  end_watch: '📝', stand_by: '⏸', diagnose_module: '🩺', inspect_camera: '📹', repair_module: '🔧', vent_section: '💨',
  assess_survivors: '🧑‍⚕️', read_vitals: '💓', prepare_medbay: '🛏', report_back: '📨',
};

function Kv(props: { k: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-slate-500">{props.k}</dt>
      <dd className="num text-slate-200">{props.children}</dd>
    </>
  );
}

function Body({ e }: { e: ToolEntry }) {
  const s = e.structured as Any | undefined;
  if (!s) return e.summary && e.status !== 'running' ? <div className="mt-1 whitespace-pre-wrap text-slate-400">{e.summary}</div> : null;
  switch (e.name) {
    case 'scan_sector':
      return (
        <div className="mt-1 text-slate-300">
          {s.partial && <div className="mb-0.5 text-amber-300">⚠ 部分结果：传感器受损，只有半个扇区</div>}
          探测到 {s.signals.length ? s.signals.map((id: string) => <span key={id} className="num mr-1 text-orange-300">{id}</span>) : '无信号'}
          <span className="text-slate-500"> · 用时 {s.ticks} 秒 · #{s.imageHash}</span>
        </div>
      );
    case 'inspect_signal':
      return (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-300">
          {s.clues.map((c: string) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      );
    case 'plot_course':
      return (
        <table className="num mt-1 w-full text-left text-[11.5px]">
          <tbody>
            {s.routes.map((r: Any) => (
              <tr key={r.kind} className={r.kind === s.recommended ? 'text-cyan-200' : 'text-slate-400'}>
                <td>{r.kind === 'direct' ? '直飞' : '绕行'}{r.kind === s.recommended ? ' ★' : ''}</td>
                <td>{r.eta}s</td>
                <td>⛽{r.fuel}</td>
                <td>{r.hazardous ? `⚠ ${Math.round(r.hazardShare * 100)}% 危险区` : '安全'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'dispatch_drone':
      return (
        <dl className="mt-1 grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 text-[11.5px]">
          <Kv k="无人机">{s.droneId} → {s.signalId}</Kv>
          <Kv k="航线">{s.route === 'safe' ? '绕行' : '直飞'}{s.hazardous ? ' ⚠' : ''}</Kv>
          <Kv k="预计">{s.eta}s</Kv>
          <Kv k="燃料">−{s.fuel}</Kv>
        </dl>
      );
    case 'diagnose_module':
      return (
        <dl className="mt-1 grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 text-[11.5px]">
          <Kv k="状态">{zh.moduleStatus[s.status] ?? s.status}{s.alarm ? ` · ${s.alarm}` : ''}</Kv>
          <Kv k="温度">{s.readings.temperatureC}°C</Kv>
          <Kv k="气压">{s.readings.pressureKPa} kPa</Kv>
          <Kv k="空气">{s.readings.airQuality}</Kv>
        </dl>
      );
    case 'repair_module':
      return <div className="mt-1 text-emerald-300">{MODULE_NAMES[s.module as ModuleId]}已修复 · {s.ticks} 秒</div>;
    case 'vent_section':
      return <div className={`mt-1 ${s.success ? 'text-emerald-300' : 'text-rose-300'}`}>{s.cell} {s.success ? '排空成功' : '排错区段：人员风险'}</div>;
    case 'assess_survivors':
      return (
        <ul className="mt-1 space-y-0.5 text-slate-300">
          {s.patients.map((p: Any) => (
            <li key={p.id}>
              <span className="num text-emerald-300">{p.id}</span> {p.count} 人 · 待评估 {p.pending.join('、') || '无'} · {p.deadlineIn}s 内决定
            </li>
          ))}
          <li className="text-slate-500">空床 {s.beds}</li>
        </ul>
      );
    case 'prepare_medbay':
      return <div className="mt-1 text-emerald-300">{s.patientId} 成员 {s.members.join('、')} 入住 · 剩余空床 {s.bedsLeft}</div>;
    case 'report_back':
      return (
        <div className="mt-1 text-slate-200">
          {s.summary}
          {s.findings.length > 0 && (
            <ul className="mt-0.5 list-disc pl-4 text-slate-400">
              {s.findings.map((f: string) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      );
    default:
      return e.summary ? <div className="mt-1 whitespace-pre-wrap text-slate-400">{e.summary}</div> : null;
  }
}

export function ToolCard({ e, focused }: { e: ToolEntry; focused: boolean }) {
  const color = CREW_COLORS[e.agentId];
  return (
    <div
      id={`tool-${e.toolCallId}`}
      className={`ml-4 rounded-md border px-2.5 py-1.5 text-[12px] transition-colors ${
        focused ? 'border-white/70 bg-white/5' : e.status === 'error' ? 'border-rose-500/50 bg-rose-950/20' : 'border-slate-700/70 bg-slate-950/40'
      }`}
      onClick={() => useUi.setState({ focus: e.toolCallId })}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden>{ICON[e.name] ?? '⚙'}</span>
        <span className="num text-slate-200" style={{ color }}>
          {e.name}
        </span>
        <span className="num truncate text-slate-500">{JSON.stringify(e.args)}</span>
        <span className={`ml-auto shrink-0 ${e.status === 'error' ? 'text-rose-300' : e.status === 'ok' ? 'text-emerald-400' : 'text-slate-400'}`}>
          {e.status === 'running' ? <span className="inline-block animate-spin">◌</span> : e.status === 'ok' ? '✓' : `✖ ${zh.comms.toolError}`}
        </span>
      </div>
      {e.status === 'running' && (
        <div className="mt-1">
          {e.progressRatio !== undefined && (
            <div className="h-1 overflow-hidden rounded-full bg-slate-800">
              <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.round(e.progressRatio * 100)}%`, background: color }} />
            </div>
          )}
          {e.progress && <div className="mt-0.5 text-slate-400">{e.progress}</div>}
        </div>
      )}
      {e.status !== 'running' && <Body e={e} />}
      {e.status === 'error' && e.structured !== undefined && e.summary && <div className="mt-0.5 text-rose-300/90">{e.summary.split('\n')[0]}</div>}
      {e.images.length > 0 && (
        <div className="mt-1.5 flex gap-1.5">
          {e.images.map((src, i) => (
            <button
              key={i}
              className="overflow-hidden rounded border border-slate-600/70 hover:border-cyan-400/70"
              onClick={(ev) => {
                ev.stopPropagation();
                useLightbox.setState({ src, caption: `${e.name} ${JSON.stringify(e.args)}${e.images.length > 1 ? ` · ${i === 0 ? 'A' : 'B'}` : ''}` });
              }}
            >
              <img src={src} alt={`${e.name} 结果图 ${i + 1}`} className="block h-[90px] w-[120px]" style={{ imageRendering: 'pixelated' }} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
