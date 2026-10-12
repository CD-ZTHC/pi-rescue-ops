// M6 的频道卡片：分诊台概率条、班末评审。
import { CREW_COLORS } from '@rescue/protocol';
import type { CommsEntry } from '../store/comms.ts';

const SEV: Record<string, string> = { minor: '轻微', serious: '严重', critical: '危急' };
const URG = ['十分钟以上', '五到十分钟', '五分钟内', '立即'];

export function Bar(props: { label: string; value: number; color: string }) {
  return (
    <div className="flex items-center gap-2 text-[11.5px]">
      <span className="w-14 shrink-0 text-slate-400">{props.label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-800">
        <div className="h-full rounded-full" style={{ width: `${Math.round(props.value * 100)}%`, background: props.color }} />
      </div>
      <span className="num w-9 shrink-0 text-right text-slate-300">{Math.round(props.value * 100)}%</span>
    </div>
  );
}

export function TriageView({ result, samples }: { result: Extract<CommsEntry, { kind: 'triage' }>['result']; samples: number }) {
  if (result.error) return <div className="text-rose-300">分诊失败：{result.error}（信号标为「未分诊」）</div>;
  return (
    <div className="space-y-1">
      {Object.entries(result.severity).map(([k, v]) => (
        <Bar key={k} label={SEV[k] ?? k} value={v} color={k === 'critical' ? '#f43f5e' : k === 'serious' ? '#f59e0b' : '#10b981'} />
      ))}
      <Bar label="恶作剧" value={result.hoax} color="#94a3b8" />
      <div className="text-[11px] text-slate-400">
        紧急度：{URG[result.urgency] ?? result.urgency}（{Math.round(result.urgencyConfidence * 100)}%）·{' '}
        <span className="text-pink-300">采样估计（k={samples}），不是 logprob 置信度</span>
      </div>
    </div>
  );
}

export function TriageCard({ e }: { e: Extract<CommsEntry, { kind: 'triage' }> }) {
  return (
    <div className="rounded-md border border-pink-400/40 bg-pink-500/5 px-2.5 py-1.5 text-[12px]">
      <div className="mb-1 flex items-center gap-2">
        <span style={{ color: CREW_COLORS.triage }}>🩺 分诊台</span>
        <span className="num text-orange-300">{e.signalId}</span>
        <span className="text-slate-400">结论：{SEV[e.result.severityChoice] ?? '未分诊'}</span>
        <span className="num ml-auto text-slate-500">{(e.durationMs / 1000).toFixed(1)}s</span>
      </div>
      <TriageView result={e.result} samples={e.samples} />
    </div>
  );
}

export function ReviewCard({ e }: { e: Extract<CommsEntry, { kind: 'review' }> }) {
  const r = e.review;
  return (
    <div className="rounded-lg border border-violet-400/40 bg-violet-500/10 px-3 py-2 text-[12.5px]">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-semibold text-violet-200">📋 班末评审（agentLoop）</span>
        <span className="num rounded bg-violet-500/30 px-1.5 text-[14px] font-bold text-white">{r.grade}</span>
      </div>
      <div className="text-slate-300">做得好：{r.strengths.join('；') || '—'}</div>
      <div className="text-slate-300">待改进：{r.improvements.join('；') || '—'}</div>
      <div className="mt-1 text-[11px] text-slate-400">
        屏障对照：低层 agentLoop 执行工具时，慢消费者{r.consumerCaughtUp ? '已' : '还没'}处理完 message_end；Agent{r.agentBarrier ? '会' : '不会'}等监听器处理完再执行工具。
      </div>
      <div className="num mt-0.5 truncate text-[10.5px] text-slate-500">{r.events.join(' → ')}</div>
    </div>
  );
}
