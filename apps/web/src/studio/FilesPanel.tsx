// 录制回放与会话恢复（§9）：列出 recordings/ 与 missions/，一键回放或恢复。
import { AnimatePresence, motion } from 'motion/react';
import { send } from '../net/client.ts';
import { useUi } from '../store/index.ts';

const name = (f: string) => f.split('/').at(-1) ?? f;
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;

export function FilesPanel() {
  const { filesOpen, files, replay } = useUi();
  return (
    <AnimatePresence>
      {filesOpen && (
        <motion.div
          className="panel fixed bottom-16 right-3 z-30 w-[440px] p-3 text-[12.5px]"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.18 }}
        >
          <div className="mb-2 flex items-center gap-2">
            <h3 className="font-semibold text-slate-100">录制与日志</h3>
            <button className="ml-auto rounded px-2 py-0.5 text-[12px] text-cyan-200 hover:bg-cyan-500/10" onClick={() => send({ t: 'files.list' })}>
              ↻ 刷新
            </button>
            <button className="text-slate-400 hover:text-white" onClick={() => useUi.setState({ filesOpen: false })} aria-label="关闭">
              ✕
            </button>
          </div>
          {replay && (
            <div className={`mb-2 rounded px-2 py-1 text-[12px] ${replay.status === 'diverged' || replay.status === 'error' ? 'bg-rose-500/15 text-rose-200' : 'bg-cyan-500/10 text-cyan-100'}`}>
              回放 {name(replay.file)}：{replay.status === 'running' ? '进行中' : replay.status === 'done' ? '完成' : replay.status === 'diverged' ? '出现分歧' : '失败'} · 工具调用吻合 {replay.matched}/{replay.total}
              {replay.note && <div className="text-[11px] opacity-80">{replay.note}</div>}
            </div>
          )}
          <div className="mb-1 text-[11.5px] text-violet-300">录制（faux 回放：同 seed + 录制的回复与主管操作）</div>
          <ul className="mb-3 max-h-48 space-y-1 overflow-y-auto pr-1 scrollbar-thin">
            {(files?.recordings ?? []).map((r) => (
              <li key={r.file} className="flex items-center gap-2">
                <span className={`rounded px-1 text-[10.5px] ${r.curated ? 'bg-violet-500/25 text-violet-100' : 'bg-slate-700 text-slate-300'}`}>{r.curated ? '精选' : '本地'}</span>
                <span className="num min-w-0 flex-1 truncate text-slate-200">{name(r.file)}</span>
                <span className="num text-slate-500">{kb(r.size)}</span>
                <button className="rounded bg-cyan-500/20 px-2 text-cyan-100 hover:bg-cyan-500/35" onClick={() => send({ t: 'replay.load', file: r.file })}>
                  ▶ 回放
                </button>
              </li>
            ))}
            {!files?.recordings.length && <li className="text-slate-500">没有录制</li>}
          </ul>
          <div className="mb-1 text-[11.5px] text-violet-300">班次日志（恢复：按 seed 与命令序列重放世界，重建船员消息）</div>
          <ul className="max-h-40 space-y-1 overflow-y-auto pr-1 scrollbar-thin">
            {(files?.missions ?? []).map((m) => (
              <li key={m.file} className="flex items-center gap-2">
                <span className="num min-w-0 flex-1 truncate text-slate-200">{name(m.file)}</span>
                <span className="num text-slate-500">{kb(m.size)}</span>
                <button className="rounded bg-slate-600/40 px-2 text-slate-100 hover:bg-slate-600/70" onClick={() => send({ t: 'session.restore', file: m.file })}>
                  ⟲ 恢复
                </button>
              </li>
            ))}
            {!files?.missions.length && <li className="text-slate-500">没有日志</li>}
          </ul>
          <button className="mt-3 w-full rounded-md border border-slate-600 py-1 text-slate-300 hover:text-white" onClick={() => send({ t: 'lesson.exit' })}>
            回到自由模式（重新开始录制）
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
