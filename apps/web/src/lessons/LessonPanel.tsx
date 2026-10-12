// 课程讲义面板：浮在态势图右上角。
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { zh } from '../i18n/zh.ts';
import { send } from '../net/client.ts';
import { useUi } from '../store/index.ts';

export function LessonPanel() {
  const lesson = useUi((s) => s.lesson);
  const live = useUi((s) => s.info?.mode === 'live');
  const [collapsed, setCollapsed] = useState(false);
  if (lesson && collapsed) {
    return (
      <button
        className="panel absolute right-3 top-3 z-10 px-2.5 py-1 text-[12px] text-violet-100 hover:border-violet-400/60"
        onClick={(e) => {
          e.stopPropagation();
          setCollapsed(false);
        }}
      >
        ▸ 第 {lesson.meta.index} 课 · {lesson.meta.title}
      </button>
    );
  }
  return (
    <AnimatePresence>
      {lesson && (
        <motion.aside
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 12 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          className="panel absolute right-3 top-3 z-10 w-80 p-3 text-[12.5px]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mb-1 flex items-center gap-2">
            <span className="num rounded bg-violet-500/25 px-1.5 text-violet-100">第 {lesson.meta.index} 课</span>
            <span className="font-semibold text-slate-100">{lesson.meta.title}</span>
            <button className="text-slate-500 hover:text-slate-200" onClick={() => setCollapsed(true)} aria-label="收起讲义" title="收起讲义">
              ▾
            </button>
            <span className={`ml-auto text-[11px] ${lesson.status === 'running' ? 'text-cyan-300' : lesson.status === 'error' ? 'text-rose-300' : 'text-emerald-300'}`}>
              {lesson.status === 'running' ? '进行中' : lesson.status === 'error' ? '出错' : '完成'}
              {lesson.mode ? ` · ${lesson.mode}` : ''}
            </span>
          </div>
          <div className="mb-2 text-[11.5px] text-violet-200/80">{lesson.meta.capability}</div>
          <p className="leading-relaxed text-slate-300">{lesson.meta.summary}</p>
          {lesson.meta.toggle && <p className="mt-2 rounded bg-slate-800/70 p-2 text-[11.5px] text-slate-400">关掉它会怎样：{lesson.meta.toggle}</p>}
          <div className="mt-3 flex gap-2">
            <button
              className="rounded-md bg-violet-500/25 px-2 py-1 text-violet-100 hover:bg-violet-500/40"
              onClick={() => send({ t: 'lesson.load', lessonId: lesson.meta.id, mode: 'faux' })}
            >
              ↻ {zh.bottom.runFaux}
            </button>
            <button
              className="rounded-md bg-cyan-500/20 px-2 py-1 text-cyan-100 hover:bg-cyan-500/35 disabled:opacity-40"
              disabled={!live}
              title={live ? '' : '没有 API key'}
              onClick={() => send({ t: 'lesson.load', lessonId: lesson.meta.id, mode: 'live' })}
            >
              ▶ {zh.bottom.runLive}
            </button>
            <button className="ml-auto rounded-md px-2 py-1 text-slate-400 hover:text-slate-100" onClick={() => send({ t: 'lesson.exit' })}>
              {zh.bottom.exitLesson}
            </button>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
