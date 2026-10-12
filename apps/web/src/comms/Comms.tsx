// ③ 通讯频道：船员消息（流式）、可折叠的思考内容、工具卡片、站务，以及主管输入框。
import { motion } from 'motion/react';
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CREW_COLORS, type CrewId } from '@rescue/protocol';
import { formatTick } from '@rescue/protocol';
import { formatClock } from '../app/format.ts';
import { zh } from '../i18n/zh.ts';
import { send } from '../net/client.ts';
import { commsModel, useModels, useUi } from '../store/index.ts';
import type { CommsEntry } from '../store/comms.ts';
import { ApprovalCard } from './ApprovalCard.tsx';
import { ToolCard } from './ToolCard.tsx';

const NAMES: Record<string, string> = { commander: '北辰', navigator: '星梭', engineer: '铆钉', medic: '白鸽' };

export function Comms() {
  const version = useModels((s) => s.comms);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [version]);

  const focus = useUi((s) => s.focus);
  useEffect(() => {
    if (!focus) return;
    const el = document.getElementById(`tool-${focus}`);
    if (el) {
      stick.current = false;
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [focus]);

  const entries = commsModel.entries;
  return (
    <div className="absolute inset-0 flex flex-col">
      <div
        ref={scroller}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3 scrollbar-thin"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {entries.map((e) => (
          <Entry key={e.id} entry={e} rev={commsModel.rev(e.id)} />
        ))}
      </div>
      <Composer />
    </div>
  );
}

const Entry = memo(function Entry({ entry }: { entry: CommsEntry; rev: number }) {
  const focus = useUi((s) => s.focus);
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18, ease: 'easeOut' }}>
      {entry.kind === 'crew' && <CrewBubble e={entry} />}
      {entry.kind === 'operator' && <OperatorBubble e={entry} />}
      {entry.kind === 'situation' && (
        <div className="flex items-center gap-2 text-[11.5px] text-slate-400">
          <span className="text-cyan-400">📡</span>
          <span>
            {zh.comms.situation} <span className="num">{formatTick(entry.tick)}</span> → {NAMES[entry.agentId]}
          </span>
          <span className="truncate text-slate-500">
            触发：{entry.reasons.join('、') || '例行'} · {entry.signals} 个活跃信号
          </span>
        </div>
      )}
      {entry.kind === 'tool' && <ToolCard e={entry} focused={focus === entry.toolCallId} />}
      {entry.kind === 'approval' && <ApprovalCard e={entry} />}
      {entry.kind === 'radio' && (
        <div className="rounded-md border border-dashed border-orange-400/40 bg-orange-500/5 px-2.5 py-1.5 text-[12px] text-orange-100">
          📻 <span className="num text-orange-300">{entry.signalId}</span> 无线电：<span className="italic">{entry.text}</span>
        </div>
      )}
      {entry.kind === 'system' && (
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <span style={{ color: CREW_COLORS[entry.agentId] }}>🧩</span>
          <span>
            {NAMES[entry.agentId]} · {entry.text}
          </span>
        </div>
      )}
      {entry.kind === 'compaction' && (
        <motion.div
          initial={{ scaleY: 2.2, opacity: 0.2 }}
          animate={{ scaleY: 1, opacity: 1 }}
          transition={{ duration: 0.6, ease: [0.2, 0.9, 0.2, 1] }}
          style={{ originY: 0 }}
          className="rounded-md border border-slate-500/40 bg-slate-800/40 px-2.5 py-1.5 text-[12px]"
        >
          <div className="mb-0.5 text-slate-300">
            📚 书记员为 <span style={{ color: CREW_COLORS[entry.agentId] }}>{NAMES[entry.agentId]}</span> 折叠了上下文
            <span className="num ml-1 text-slate-500">
              {entry.before} → {entry.after} token
            </span>
          </div>
          <div className="whitespace-pre-wrap text-[11.5px] text-slate-400">{entry.summary}</div>
        </motion.div>
      )}
      {entry.kind === 'duty' && (
        <div className="flex items-center gap-2 text-[11.5px] text-slate-400">
          <span style={{ color: CREW_COLORS[entry.agentId] }}>🛠</span>
          <span>
            值班任务 → <span style={{ color: CREW_COLORS[entry.agentId] }}>{NAMES[entry.agentId]}</span>：{entry.text}
          </span>
        </div>
      )}
      {entry.kind === 'world' && (
        <div
          onClick={() => entry.correlationId && useUi.setState({ focus: entry.correlationId })}
          className={`rounded-md px-2 py-1 text-center text-[11.5px] ${
            entry.tone === 'danger' ? 'bg-rose-500/10 text-rose-300' : entry.tone === 'warn' ? 'bg-amber-500/10 text-amber-200' : entry.tone === 'ok' ? 'bg-emerald-500/10 text-emerald-200' : 'bg-slate-500/10 text-slate-300'
          }`}
        >
          【站务】{entry.text}
        </div>
      )}
      {entry.kind === 'notice' && (
        <div className={`text-[11.5px] ${entry.level === 'error' ? 'text-rose-300' : entry.level === 'warn' ? 'text-amber-300' : 'text-slate-400'}`}>
          {entry.level === 'error' ? '⚠ ' : 'ℹ '}
          {entry.text}
        </div>
      )}
    </motion.div>
  );
});

function CrewBubble({ e }: { e: Extract<CommsEntry, { kind: 'crew' }> }) {
  const color = CREW_COLORS[e.agentId];
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border-l-2 bg-slate-900/50 px-3 py-2" style={{ borderColor: color }}>
      <div className="mb-1 flex items-center gap-2 text-[12px]">
        <span className="font-semibold" style={{ color }}>
          {NAMES[e.agentId]}
        </span>
        <span className="num text-slate-500">{formatClock(e.at)}</span>
        {e.thinkingLevel && <span className="text-slate-500">· 思考 {e.thinkingLevel}</span>}
        {e.streaming && <span className="ml-auto size-1.5 animate-pulse rounded-full" style={{ background: color }} />}
      </div>
      {e.thinking && (
        <div className="mb-1">
          <button className="text-[11.5px] text-slate-400 hover:text-slate-200" onClick={() => setOpen(!open)}>
            {open ? '▾' : '▸'} {zh.comms.thinking}
            <span className="num ml-1 text-slate-500">{e.thinking.length} 字</span>
          </button>
          {open && <div className="mt-1 whitespace-pre-wrap border-l border-slate-600 pl-2 text-[12px] italic leading-relaxed text-slate-400">{e.thinking}</div>}
        </div>
      )}
      {e.text && (
        <div className="whitespace-pre-wrap text-[13px] leading-relaxed text-slate-100">
          {e.text}
          {e.streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse" style={{ background: color }} />}
        </div>
      )}
      {e.toolCalls.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {e.toolCalls.map((t) => (
            <button
              key={t.id}
              className="num rounded border border-slate-600/70 px-1.5 py-0.5 text-[11px] text-slate-300 hover:border-cyan-400/60"
              onClick={() => useUi.setState({ focus: t.id })}
            >
              → {t.name}({Object.values((t.args ?? {}) as Record<string, unknown>).map(String).join(', ').slice(0, 40)})
            </button>
          ))}
        </div>
      )}
      {e.error && <div className="mt-1 text-[12px] text-rose-300">✖ {e.error}</div>}
    </div>
  );
}

function OperatorBubble({ e }: { e: Extract<CommsEntry, { kind: 'operator' }> }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-lg bg-slate-100/10 px-3 py-2 text-[13px] text-white">
        <div className="mb-0.5 flex items-center justify-end gap-2 text-[11px] text-slate-400">
          <span className={`rounded px-1 ${e.mode === 'steer' ? 'bg-rose-500/20 text-rose-200' : e.mode === 'followUp' ? 'bg-amber-500/20 text-amber-200' : 'bg-slate-500/20'}`}>
            {zh.comms.tag[e.mode] ?? e.mode}
          </span>
          主管 → {NAMES[e.target]}
        </div>
        <div className="whitespace-pre-wrap">{e.text}</div>
      </div>
    </div>
  );
}

const MODES = ['auto', 'steer', 'followUp'] as const;

function Composer() {
  const crew = useUi((s) => s.crew);
  const [target, setTarget] = useState<CrewId>('commander');
  const [mode, setMode] = useState<(typeof MODES)[number]>('auto');
  const [text, setText] = useState('');
  const running = crew.find((c) => c.id === target)?.status === 'running';
  const queue = useUi((s) => s.queues[target]);
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    send({ t: 'operator.say', target, text: t, mode });
    setText('');
  };
  useEffect(() => {
    if (!crew.some((c) => c.id === target) && crew[0]) setTarget(crew[0].id);
  }, [crew, target]);
  return (
    <div className="shrink-0 border-t border-[var(--color-edge)] p-2.5">
      <div className="mb-2 flex items-center gap-2 text-[12px]">
        <select
          className="rounded-md border border-slate-700 bg-slate-900 px-1.5 py-1 text-slate-200"
          value={target}
          onChange={(e) => setTarget(e.target.value as CrewId)}
          aria-label="发给谁"
        >
          {(['commander', 'navigator', 'engineer', 'medic'] as const).map((id) => (
            <option key={id} value={id} disabled={!crew.some((c) => c.id === id)}>
              {NAMES[id]}
              {crew.some((c) => c.id === id) ? '' : '（M5）'}
            </option>
          ))}
        </select>
        <div className="flex overflow-hidden rounded-md border border-slate-700" role="radiogroup" aria-label="投递方式">
          {MODES.map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              title={zh.comms.modeHint[m]}
              className={`px-2 py-1 ${mode === m ? 'bg-cyan-500/20 text-cyan-100' : 'text-slate-400 hover:text-slate-200'}`}
              onClick={() => setMode(m)}
            >
              {m === 'auto' ? zh.comms.modeAuto : m === 'steer' ? zh.comms.modeSteer : zh.comms.modeFollowUp}
            </button>
          ))}
        </div>
        <button
          className="ml-auto rounded-md border border-rose-500/50 px-2 py-1 text-rose-300 hover:bg-rose-500/15 disabled:opacity-40"
          disabled={!running}
          onClick={() => send({ t: 'run.abort', target: 'all' })}
        >
          ■ {zh.comms.abort}
        </button>
      </div>
      <div className="flex gap-2">
        <textarea
          className="min-h-[38px] flex-1 resize-none rounded-md border border-slate-700 bg-slate-950/70 px-2.5 py-2 text-[13px] text-slate-100 placeholder:text-slate-500 focus:border-cyan-400/60 focus:outline-none"
          rows={1}
          placeholder={zh.comms.placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button className="rounded-md bg-cyan-500/80 px-3 text-[13px] font-medium text-slate-950 hover:bg-cyan-400" onClick={submit}>
          {zh.comms.send}
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
        <span className="min-w-0 flex-1 truncate">
          {running ? zh.comms.modeHint[mode] : `${NAMES[target]}空闲：消息会直接开始一次运行（prompt）`}
          {queue && queue.preview.length > 0 && <span className="text-amber-300"> · 下一次注入：{queue.preview.join(' / ')}</span>}
        </span>
        <label className="flex shrink-0 items-center gap-1" title="steeringMode / followUpMode：一次注入全部排队消息，还是每次一条">
          队列
          <select
            className="rounded border border-slate-700 bg-slate-900 px-1 py-0.5 text-slate-300"
            value={queue?.steeringMode ?? 'all'}
            onChange={(e) => {
              const m = e.target.value as 'all' | 'one-at-a-time';
              send({ t: 'queue.mode', target: 'all', steering: m, followUp: m });
            }}
          >
            <option value="all">all</option>
            <option value="one-at-a-time">one-at-a-time</option>
          </select>
        </label>
      </div>
    </div>
  );
}
