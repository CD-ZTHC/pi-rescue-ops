import type { ReactNode } from 'react';

export function Panel(props: { title: string; index: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel flex min-h-0 min-w-0 flex-col overflow-hidden ${props.className ?? ''}`}>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--color-edge)] px-3 text-[13px]">
        <span className="num text-[11px] text-cyan-300/70">{props.index}</span>
        <h2 className="font-medium tracking-wide text-slate-200">{props.title}</h2>
        <div className="ml-auto flex items-center gap-2 text-[12px] text-slate-400">{props.right}</div>
      </header>
      <div className="relative min-h-0 flex-1">{props.children}</div>
    </section>
  );
}
