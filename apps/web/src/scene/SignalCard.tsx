import { AnimatePresence, motion } from 'motion/react';
import { zh } from '../i18n/zh.ts';
import { useUi, useWorld } from '../store/index.ts';

export function SignalCard() {
  const selected = useUi((s) => s.selectedSignal);
  const signal = useWorld((s) => s.world?.signals.find((x) => x.id === selected));
  const tick = useWorld((s) => s.world?.tick ?? 0);
  return (
    <AnimatePresence>
      {signal && (
        <motion.div
          key={signal.id}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="panel absolute bottom-3 left-3 w-64 p-3 text-[12px]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="num text-[14px] font-semibold text-orange-300">{signal.id}</span>
            <span className="text-slate-300">
              {signal.sector} 区 · {zh.signalKinds[signal.kind]}
            </span>
            <button className="ml-auto text-slate-500 hover:text-slate-200" onClick={() => useUi.setState({ selectedSignal: undefined })} aria-label="关闭">
              ✕
            </button>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-slate-300">
            <dt className="text-slate-500">状态</dt>
            <dd>{zh.signalStatus[signal.status]}</dd>
            <dt className="text-slate-500">报告人数</dt>
            <dd className="num">{signal.survivors}</dd>
            <dt className="text-slate-500">剩余</dt>
            <dd className="num">{signal.status === 'active' ? `${Math.max(0, signal.expiresTick - tick)} 秒` : '—'}</dd>
          </dl>
          <div className="mt-2 border-t border-slate-700/60 pt-2">
            <div className="mb-1 text-slate-500">扫描线索</div>
            {signal.clues.length ? (
              <ul className="list-disc space-y-0.5 pl-4 text-slate-200">
                {signal.clues.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            ) : (
              <div className="text-slate-500">尚未扫描</div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
