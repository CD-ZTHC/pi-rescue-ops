// 点开一次请求：耗时构成与 provider 原始 chunk（第 21 课）。
import { CREW_COLORS } from '@rescue/protocol';
import { formatCost, seconds } from '../app/format.ts';
import { useUi } from '../store/index.ts';

export function RequestDetail() {
  const r = useUi((s) => s.requestDetail);
  const info = useUi((s) => s.info);
  if (!r) return null;
  const rows: Array<[string, string]> = [
    ['模型', `${r.model ?? '?'} · 思考 ${r.thinkingLevel ?? '?'}`],
    ['等待并发配额', seconds(r.queuedMs)],
    ['TTFT', `${seconds(r.ttftMs)}（${r.ttftSource === 'provider' ? 'onProviderStreamEvent' : '首个流式增量'}）`],
    ['总耗时', `${seconds(r.durationMs)}（${r.durationSource === 'pi' ? 'AssistantMessage.durationMs' : '墙钟补算'}）`],
    ['provider 事件', String(r.providerEvents ?? 0)],
    ['stopReason', r.stopReason ?? '—'],
  ];
  if (r.usage) {
    rows.push(['token', `输入 ${r.usage.input} · 输出 ${r.usage.output}${r.usage.reasoning !== undefined ? `（推理 ${r.usage.reasoning}）` : ''} · 缓存命中 ${r.usage.cacheRead}`]);
    rows.push(['费用', formatCost(r.usage.cost, info)]);
  }
  if (r.images) rows.push(['图片', `${r.images} 张（约 ${r.images * 105} token）`]);
  return (
    <div className="panel absolute bottom-2 left-2 z-20 w-[380px] p-2.5 text-[11.5px]" onPointerDown={(e) => e.stopPropagation()}>
      <div className="mb-1 flex items-center">
        <span className="font-semibold" style={{ color: CREW_COLORS[r.agentId] }}>
          请求详情
        </span>
        <button className="ml-auto text-slate-400 hover:text-white" onClick={() => useUi.setState({ requestDetail: undefined })} aria-label="关闭">
          ✕
        </button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-slate-500">{k}</dt>
            <dd className="num text-slate-200">{v}</dd>
          </div>
        ))}
      </dl>
      <details className="mt-1.5">
        <summary className="cursor-pointer text-slate-400">原始 chunk（{r.rawChunks?.length ?? 0}）</summary>
        {r.rawChunks?.length ? (
          <pre className="num mt-1 max-h-44 overflow-auto rounded bg-slate-950/80 p-1.5 text-[10px] text-slate-400 scrollbar-thin">{r.rawChunks.join('\n')}</pre>
        ) : (
          <div className="mt-1 text-slate-500">faux 模型不触发 onProviderStreamEvent；用真实模型再跑一次就能看到。</div>
        )}
      </details>
    </div>
  );
}
