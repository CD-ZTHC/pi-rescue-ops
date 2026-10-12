// 页面布局（§3.5）：三栏可拖动；窄屏（< 1280px）时 ② 和 ③ 合并成标签页。
import { useEffect, useRef, useState } from 'react';
import { Comms } from '../comms/Comms.tsx';
import { zh } from '../i18n/zh.ts';
import { Inspector, InspectorLegend } from '../inspector/Inspector.tsx';
import { LessonPanel } from '../lessons/LessonPanel.tsx';
import { StarMap } from '../scene/StarMap.tsx';
import { useUi } from '../store/index.ts';
import { ContextDrawer } from '../studio/ContextDrawer.tsx';
import { BottomBar } from './BottomBar.tsx';
import { Panel } from './Panel.tsx';
import { Toasts } from './Toasts.tsx';
import { TopBar } from './TopBar.tsx';

function useWide(): boolean {
  const [wide, setWide] = useState(() => window.innerWidth >= 1280);
  useEffect(() => {
    const on = () => setWide(window.innerWidth >= 1280);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return wide;
}

function Handle(props: { onDrag: (dx: number) => void }) {
  const start = useRef<number | undefined>(undefined);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className="group w-2 shrink-0 cursor-col-resize"
      onPointerDown={(e) => {
        start.current = e.clientX;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (start.current === undefined) return;
        props.onDrag(e.clientX - start.current);
        start.current = e.clientX;
      }}
      onPointerUp={() => (start.current = undefined)}
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-cyan-400/40" />
    </div>
  );
}

export function App() {
  const wide = useWide();
  const widths = useUi((s) => s.widths);
  const main = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<'inspector' | 'comms'>('inspector');

  const resize = (which: 0 | 1, dx: number) => {
    const total = main.current?.clientWidth ?? 1;
    const next: [number, number] = [...widths];
    next[which] = Math.min(0.6, Math.max(0.18, next[which] + dx / total));
    if (next[0] + next[1] > 0.82) return;
    useUi.setState({ widths: next });
  };

  const map = (
    <Panel index="①" title={zh.panels.map} className="h-full">
      <StarMap />
      <LessonPanel />
    </Panel>
  );

  return (
    <>
      <div className="stardust" />
      <div className="relative flex h-full flex-col gap-2 p-2">
        <TopBar />
        <main ref={main} className="flex min-h-0 flex-1">
          {wide ? (
            <>
              <div style={{ width: `${widths[0] * 100}%` }} className="min-w-0">
                {map}
              </div>
              <Handle onDrag={(dx) => resize(0, dx)} />
              <div style={{ width: `${widths[1] * 100}%` }} className="min-w-0">
                <Panel index="②" title={zh.panels.inspector} className="h-full" right={<InspectorLegend />}>
                  <Inspector />
                </Panel>
              </div>
              <Handle onDrag={(dx) => resize(1, dx)} />
              <div className="min-w-0 flex-1">
                <Panel index="③" title={zh.panels.comms} className="h-full">
                  <Comms />
                </Panel>
              </div>
            </>
          ) : (
            <>
              <div className="w-1/2 min-w-0 pr-1">{map}</div>
              <div className="w-1/2 min-w-0 pl-1">
                <Panel
                  index={tab === 'inspector' ? '②' : '③'}
                  title={tab === 'inspector' ? zh.panels.inspector : zh.panels.comms}
                  className="h-full"
                  right={
                    <div className="flex overflow-hidden rounded-md border border-slate-700">
                      {(['inspector', 'comms'] as const).map((t) => (
                        <button key={t} className={`px-2 py-0.5 ${tab === t ? 'bg-cyan-500/20 text-cyan-100' : ''}`} onClick={() => setTab(t)}>
                          {t === 'inspector' ? 'Inspector' : '频道'}
                        </button>
                      ))}
                    </div>
                  }
                >
                  {tab === 'inspector' ? <Inspector /> : <Comms />}
                </Panel>
              </div>
            </>
          )}
        </main>
        <BottomBar />
      </div>
      <ContextDrawer />
      <Toasts />
    </>
  );
}
