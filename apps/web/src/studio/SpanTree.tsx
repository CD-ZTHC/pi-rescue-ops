// Span 树（§5.13）：pi-telemetry 的 InMemoryTelemetryContext 收集的 rescue.run → rescue.request / rescue.tool。
import { AnimatePresence, motion } from 'motion/react';
import { send } from '../net/client.ts';
import { useUi } from '../store/index.ts';

type Span = NonNullable<ReturnType<typeof useUi.getState>['spans']>[number];

function Node({ span, all, depth }: { span: Span; all: Span[]; depth: number }) {
  const children = all.filter((s) => s.parentId === span.id);
  const status = (span.status as { status?: string })?.status;
  const attrs = Object.entries(span.attributes).filter(([k]) => k !== 'rescue.agent' && k !== 'rescue.tool' && k !== 'rescue.model');
  const label = String(span.attributes['rescue.agent'] ?? span.attributes['rescue.tool'] ?? span.attributes['rescue.model'] ?? '');
  return (
    <li>
      <div className="num flex items-baseline gap-2 py-0.5 text-[11.5px]" style={{ paddingLeft: depth * 14 }}>
        <span className={status === 'error' ? 'text-rose-300' : 'text-cyan-200'}>{span.name}</span>
        <span className="text-slate-200">{label}</span>
        <span className="truncate text-slate-500">{attrs.map(([k, v]) => `${k.replace(/^rescue\./, '')}=${String(v)}`).join(' ')}</span>
        {span.events.length > 0 && <span className="text-amber-300">· {span.events.map((e) => e.name.replace(/^rescue\./, '')).join(',')}</span>}
        {!span.settled && <span className="text-violet-300">（进行中）</span>}
      </div>
      {children.length > 0 && (
        <ul>
          {children.map((c) => (
            <Node key={c.id} span={c} all={all} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function SpanTree() {
  const { spansOpen, spans } = useUi();
  const all = spans ?? [];
  const ids = new Set(all.map((s) => s.id));
  const roots = all.filter((s) => s.parentId === null || !ids.has(s.parentId));
  return (
    <AnimatePresence>
      {spansOpen && (
        <motion.aside
          className="panel fixed bottom-16 left-3 top-16 z-30 flex w-[520px] flex-col p-3"
          initial={{ opacity: 0, x: -24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -24 }}
          transition={{ duration: 0.2 }}
        >
          <div className="mb-2 flex items-center gap-2">
            <h3 className="font-semibold text-slate-100">Span 树</h3>
            <span className="text-[11px] text-slate-500">pi-telemetry · InMemoryTelemetryContext（不记录时间戳）</span>
            <button className="ml-auto rounded px-2 py-0.5 text-[12px] text-cyan-200 hover:bg-cyan-500/10" onClick={() => send({ t: 'telemetry.request' })}>
              ↻ 刷新
            </button>
            <button className="text-slate-400 hover:text-white" onClick={() => useUi.setState({ spansOpen: false })} aria-label="关闭">
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
            {roots.length ? (
              <ul>
                {roots.slice(-60).map((r) => (
                  <Node key={r.id} span={r} all={all} depth={0} />
                ))}
              </ul>
            ) : (
              <div className="text-[12px] text-slate-500">还没有 span：让船员跑一次再刷新。</div>
            )}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
