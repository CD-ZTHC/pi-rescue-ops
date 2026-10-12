import { AnimatePresence, motion } from 'motion/react';
import { useUi } from '../store/index.ts';

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-3 top-14 z-40 flex w-80 flex-col gap-2" aria-live="polite">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16 }}
            className={`panel px-3 py-2 text-[12.5px] ${t.level === 'error' ? 'border-rose-500/60 text-rose-100' : t.level === 'warn' ? 'border-amber-500/60 text-amber-100' : 'text-slate-200'}`}
          >
            {t.level === 'error' ? '⚠ ' : t.level === 'warn' ? '△ ' : 'ℹ '}
            {t.text}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
