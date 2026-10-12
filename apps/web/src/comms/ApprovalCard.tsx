// 审批卡片（§3.4）：30 秒倒计时环，超时视为否决。
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { CREW_COLORS } from '@rescue/protocol';
import { send } from '../net/client.ts';
import { serverNow } from '../store/index.ts';
import type { CommsEntry } from '../store/comms.ts';

const NAMES: Record<string, string> = { commander: '北辰', navigator: '星梭', engineer: '铆钉', medic: '白鸽' };
const TOTAL = 30_000;

function Ring({ remaining }: { remaining: number }) {
  const r = 13;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, remaining / TOTAL));
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" className="shrink-0" aria-label={`剩余 ${Math.ceil(remaining / 1000)} 秒`}>
      <circle cx="17" cy="17" r={r} fill="none" stroke="#334155" strokeWidth="3" />
      <circle
        cx="17"
        cy="17"
        r={r}
        fill="none"
        stroke={frac > 0.33 ? '#f59e0b' : '#f43f5e'}
        strokeWidth="3"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - frac)}
        strokeLinecap="round"
        transform="rotate(-90 17 17)"
      />
      <text x="17" y="21" textAnchor="middle" fontSize="11" fill="#f8fafc" className="num">
        {Math.ceil(remaining / 1000)}
      </text>
    </svg>
  );
}

export function ApprovalCard({ e }: { e: Extract<CommsEntry, { kind: 'approval' }> }) {
  const [now, setNow] = useState(serverNow());
  const [note, setNote] = useState('');
  useEffect(() => {
    if (e.decision) return;
    const t = setInterval(() => setNow(serverNow()), 250);
    return () => clearInterval(t);
  }, [e.decision]);
  const remaining = e.expiresAt - now;
  const decided = e.decision;
  return (
    <motion.div
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 22 }}
      className={`rounded-lg border px-3 py-2 text-[12.5px] ${decided ? 'border-slate-700 bg-slate-900/40' : 'border-amber-400/60 bg-amber-500/10 shadow-[0_0_24px_-8px_rgba(245,158,11,0.6)]'}`}
      role="alertdialog"
      aria-label="危险操作审批"
    >
      <div className="flex items-start gap-3">
        {!decided && <Ring remaining={remaining} />}
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-center gap-2">
            <span className="font-semibold text-amber-200">⚠ 危险操作审批</span>
            <span style={{ color: CREW_COLORS[e.agentId] }}>{NAMES[e.agentId]}</span>
            <span className="num text-slate-300">
              {e.tool}({Object.values((e.args ?? {}) as Record<string, unknown>).map(String).join(', ')})
            </span>
          </div>
          <div className="text-slate-300">{e.risk}</div>
          {decided ? (
            <div className={`mt-1 ${decided === 'approve' ? 'text-emerald-300' : 'text-rose-300'}`}>
              {decided === 'approve' ? '✓ 已批准' : decided === 'deny' ? '✖ 已否决' : '⌛ 超时，视为否决'}
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950/70 px-2 py-1 text-[12px] text-slate-100 placeholder:text-slate-500 focus:border-amber-400/60 focus:outline-none"
                placeholder="备注（否决理由会回传给模型）"
                value={note}
                onChange={(ev) => setNote(ev.target.value)}
              />
              <button className="rounded-md bg-emerald-500/80 px-3 py-1 font-medium text-slate-950 hover:bg-emerald-400" onClick={() => send({ t: 'approval.decide', approvalId: e.approvalId, decision: 'approve', note })}>
                批准
              </button>
              <button className="rounded-md bg-rose-500/80 px-3 py-1 font-medium text-white hover:bg-rose-400" onClick={() => send({ t: 'approval.decide', approvalId: e.approvalId, decision: 'deny', note })}>
                否决
              </button>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
