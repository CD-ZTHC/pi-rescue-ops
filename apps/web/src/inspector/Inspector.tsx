// ② Loop Inspector（§7.2）：横轴为墙钟时间，可缩放（滚轮）和平移（拖动）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { CREW_COLORS, type CrewId } from '@rescue/protocol';
import { seconds } from '../app/format.ts';
import { zh } from '../i18n/zh.ts';
import { serverNow, runsModel, useModels, useUi } from '../store/index.ts';
import type { HookMark, RunView, ToolView, TurnView } from '../store/runs.ts';

export function InspectorLegend() {
  return (
    <div className="hidden items-center gap-3 text-[11px] text-slate-400 xl:flex">
      <Legend />
    </div>
  );
}

const LANES: Array<{ id: CrewId; name: string }> = [
  { id: 'commander', name: '北辰' },
  { id: 'navigator', name: '星梭' },
  { id: 'engineer', name: '铆钉' },
  { id: 'medic', name: '白鸽' },
];
const GUTTER = 64;
const LANE_ACTIVE = 150;
const LANE_IDLE = 34;
const REQ_Y = 26;
const REQ_H = 14;
const TOOL_Y = 50;
const TOOL_H = 11;
const TOOL_GAP = 4;

function useNow(active: boolean): number {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    if (!active) {
      setNow(serverNow());
      return;
    }
    let id = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last > 90) {
        last = t;
        setNow(serverNow());
      }
      id = requestAnimationFrame(loop);
    };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
  }, [active]);
  return now;
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 600, h: 400 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

function hookColor(m: HookMark): string {
  if (m.hook === 'finishTurn' || m.hook === 'prepareNextTurn') return '#a78bfa';
  const d = m.decision as { block?: boolean } | undefined;
  if (d && typeof d === 'object' && d.block) return '#f43f5e';
  if (m.hook === 'afterToolCall' || m.hook === 'prepareRequest' || m.hook === 'transformContext') return '#60a5fa';
  return '#10b981';
}

export function Inspector() {
  useModels((s) => s.runs);
  const focus = useUi((s) => s.focus);
  const crew = useUi((s) => s.crew);
  const running = runsModel.runs.some((r) => r.endedAt === undefined);
  const now = useNow(running);
  const [ref, size] = useSize<HTMLDivElement>();
  const [span, setSpan] = useState(60_000);
  const [pinnedEnd, setPinnedEnd] = useState<number | undefined>();
  const drag = useRef<{ x: number; end: number } | undefined>(undefined);

  const end = pinnedEnd ?? now + span * 0.06;
  const start = end - span;
  const width = Math.max(100, size.w - GUTTER - 8);
  const x = (t: number) => GUTTER + ((t - start) / span) * width;
  const onDuty = new Set(crew.map((c) => c.id));

  const lanes = useMemo(() => {
    let y = 26;
    return LANES.map((l) => {
      const h = onDuty.has(l.id) ? LANE_ACTIVE : LANE_IDLE;
      const lane = { ...l, y, h, active: onDuty.has(l.id) };
      y += h + 8;
      return lane;
    });
  }, [crew]);
  const totalH = Math.max(size.h, lanes[lanes.length - 1].y + lanes[lanes.length - 1].h + 10);

  const ticks = useMemo(() => {
    const step = span <= 30_000 ? 5_000 : span <= 120_000 ? 10_000 : span <= 300_000 ? 30_000 : 60_000;
    const out: number[] = [];
    for (let t = Math.ceil(start / step) * step; t < end; t += step) out.push(t);
    return out;
  }, [start, end, span]);

  const visible = runsModel.runs.filter((r) => (r.endedAt ?? now) >= start && r.startedAt <= end);

  return (
    <div
      ref={ref}
      className="absolute inset-0 select-none overflow-y-auto overflow-x-hidden scrollbar-thin"
      onWheel={(e) => {
        const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
        setSpan((s) => Math.min(600_000, Math.max(8_000, s * factor)));
      }}
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, end };
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const dx = e.clientX - drag.current.x;
        if (Math.abs(dx) < 3 && pinnedEnd === undefined) return;
        setPinnedEnd(drag.current.end - (dx / width) * span);
      }}
      onPointerUp={() => (drag.current = undefined)}
    >
      {pinnedEnd !== undefined && (
        <button
          className="absolute bottom-2 right-2 z-10 rounded-md bg-cyan-500/20 px-2 py-0.5 text-[12px] text-cyan-200 hover:bg-cyan-500/30"
          onClick={() => setPinnedEnd(undefined)}
        >
          ⟳ {zh.inspector.follow}
        </button>
      )}
      <svg width={size.w} height={totalH} className="block">
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="currentColor" opacity="0.18" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" strokeWidth="2.5" opacity="0.55" />
          </pattern>
          <pattern id="dots" width="4" height="4" patternUnits="userSpaceOnUse">
            <rect width="4" height="4" fill="currentColor" opacity="0.25" />
            <circle cx="2" cy="2" r="1" fill="currentColor" />
          </pattern>
          <pattern id="blocked" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="#64748b" opacity="0.25" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="#64748b" strokeWidth="2" />
          </pattern>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={18} y2={totalH} stroke="#1e293b" strokeDasharray="2 4" />
            <text x={x(t) + 3} y={13} className="num" fontSize={10} fill="#64748b">
              {new Date(t).toLocaleTimeString('zh-CN', { hour12: false })}
            </text>
          </g>
        ))}
        <line x1={x(now)} x2={x(now)} y1={18} y2={totalH} stroke="#22d3ee" strokeOpacity={0.35} />
        {lanes.map((lane) => (
          <g key={lane.id}>
            <rect x={4} y={lane.y} width={size.w - 8} height={lane.h} rx={8} fill="#0b1224" fillOpacity={lane.active ? 0.55 : 0.25} />
            <text x={12} y={lane.y + 18} fontSize={12} fill={CREW_COLORS[lane.id]} fontWeight={600} opacity={lane.active ? 1 : 0.4}>
              {lane.name}
            </text>
            {!lane.active && (
              <text x={GUTTER + 8} y={lane.y + 21} fontSize={11} fill="#475569">
                {zh.inspector.notOnDuty}
              </text>
            )}
            {lane.active &&
              visible
                .filter((r) => r.agentId === lane.id)
                .map((run) => <RunShape key={run.runId} run={run} y={lane.y} h={lane.h} x={x} now={now} focus={focus} />)}
          </g>
        ))}
        {visible.length === 0 && (
          <text x={GUTTER + 8} y={lanes[0].y + 60} fontSize={12} fill="#64748b">
            {zh.inspector.empty}
          </text>
        )}
      </svg>
    </div>
  );
}

export function Legend() {
  return (
    <>
      <span className="flex items-center gap-1">
        <svg width="14" height="8" className="text-cyan-300">
          <rect width="14" height="8" fill="url(#hatch)" />
        </svg>
        {zh.inspector.legendThinking}
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-2 w-3.5 bg-cyan-400" />
        {zh.inspector.legendText}
      </span>
      <span className="flex items-center gap-1">
        <svg width="14" height="8" className="text-cyan-300">
          <rect width="14" height="8" fill="url(#dots)" />
        </svg>
        {zh.inspector.legendTool}
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-px bg-white" />
        {zh.inspector.legendTtft}
      </span>
    </>
  );
}

function RunShape(props: { run: RunView; y: number; h: number; x: (t: number) => number; now: number; focus?: string }) {
  const { run, y, h, x, now } = props;
  const color = CREW_COLORS[run.agentId];
  const x0 = x(run.startedAt);
  const x1 = Math.max(x0 + 4, x(run.endedAt ?? now));
  const outcomeColor = run.outcome === 'error' ? '#f43f5e' : run.outcome === 'aborted' ? '#f59e0b' : color;
  return (
    <g>
      <rect x={x0} y={y + 4} width={x1 - x0} height={h - 8} rx={7} fill={color} fillOpacity={0.05} stroke={outcomeColor} strokeOpacity={0.55} />
      {run.turns.map((turn, i) => (
        <TurnShape key={i} turn={turn} y={y} x={x} now={now} color={color} focus={props.focus} />
      ))}
      {(run.queue.steer > 0 || run.queue.followUp > 0) && (
        <g transform={`translate(${x1 + 4}, ${y + 8})`}>
          <rect width={92} height={18} rx={9} fill="#0f172a" stroke={color} strokeOpacity={0.6} />
          <text x={8} y={13} fontSize={10.5} fill="#e2e8f0">
            {run.queue.steer ? `${zh.inspector.queueSteer} ${run.queue.steer} ` : ''}
            {run.queue.followUp ? `${zh.inspector.queueFollowUp} ${run.queue.followUp}` : ''}
          </text>
        </g>
      )}
      {run.outcome && run.outcome !== 'ok' && (
        <text x={x1 - 4} y={y + h - 10} textAnchor="end" fontSize={10} fill={outcomeColor}>
          {run.outcome === 'error' ? '✖ error' : '■ aborted'}
        </text>
      )}
    </g>
  );
}

function TurnShape(props: { turn: TurnView; y: number; x: (t: number) => number; now: number; color: string; focus?: string }) {
  const { turn, y, x, now, color } = props;
  const tx0 = x(turn.start);
  const tx1 = Math.max(tx0 + 2, x(turn.end ?? now));
  const req = turn.request;
  // 工具纵向叠放：与前一个时间重叠就下移一行（并行），否则复用（串行首尾相接）
  const rows: number[] = [];
  const toolRows = turn.tools.map((t) => {
    const s = t.start;
    let row = rows.findIndex((endAt) => endAt <= s);
    if (row === -1) {
      row = rows.length;
      rows.push(0);
    }
    rows[row] = t.end ?? now;
    return row;
  });
  return (
    <g>
      <rect x={tx0} y={y + 8} width={tx1 - tx0} height={12} rx={3} fill={color} fillOpacity={turn.index % 2 ? 0.1 : 0.18} />
      <text x={tx0 + 3} y={y + 17.5} fontSize={9} fill={color} opacity={0.9} className="num">
        T{turn.index + 1}
      </text>
      {req && <RequestShape req={req} y={y + REQ_Y} x={x} now={now} color={color} />}
      {turn.tools.map((tool, i) => (
        <ToolShape key={tool.toolCallId} tool={tool} y={y + TOOL_Y + toolRows[i] * (TOOL_H + TOOL_GAP)} x={x} now={now} color={color} focused={props.focus === tool.toolCallId} />
      ))}
      {turn.hooks.map((m, i) => (
        <Diamond key={i} cx={x(m.at)} cy={y + 14} mark={m} />
      ))}
    </g>
  );
}

function RequestShape(props: { req: NonNullable<TurnView['request']>; y: number; x: (t: number) => number; now: number; color: string }) {
  const { req, y, x, now, color } = props;
  const end = req.end ?? now;
  const queuedStart = req.queuedMs ? req.start - req.queuedMs : undefined;
  const tip = `${zh.inspector.reqTooltip(req.model ?? '?', req.thinkingLevel ?? '?', req.ttftMs, req.durationMs)}${
    req.usage ? `\n输入 ${req.usage.input} · 输出 ${req.usage.output}${req.usage.reasoning !== undefined ? `（推理 ${req.usage.reasoning}）` : ''} · 缓存命中 ${req.usage.cacheRead}` : ''
  }${req.queuedMs ? `\n等待并发配额 ${seconds(req.queuedMs)}` : ''}${req.images ? `\n图片 ${req.images} 张` : ''}`;
  return (
    <g style={{ color }}>
      <title>{tip}</title>
      {queuedStart !== undefined && req.queuedMs! > 30 && (
        <rect x={x(queuedStart)} y={y + 3} width={Math.max(1, x(req.start) - x(queuedStart))} height={REQ_H - 6} fill="#64748b" opacity={0.5} rx={2} />
      )}
      <rect x={x(req.start)} y={y} width={Math.max(2, x(end) - x(req.start))} height={REQ_H} rx={3} fill={color} fillOpacity={0.12} stroke={color} strokeOpacity={0.5} />
      {req.segments.map((s, i) => {
        const sx = x(s.start);
        const w = Math.max(1.5, x(s.end ?? now) - sx);
        const fill = s.kind === 'thinking' ? 'url(#hatch)' : s.kind === 'toolcall' ? 'url(#dots)' : color;
        return <rect key={i} x={sx} y={y + 2} width={w} height={REQ_H - 4} fill={fill} opacity={s.kind === 'text' ? 0.85 : 1} />;
      })}
      {req.ttftMs !== undefined && <line x1={x(req.start + req.ttftMs)} x2={x(req.start + req.ttftMs)} y1={y - 3} y2={y + REQ_H + 3} stroke="#fff" strokeWidth={1.5} />}
      {req.end !== undefined && x(req.end) - x(req.start) > 70 && (
        <text x={x(req.end) - 4} y={y + REQ_H - 3.5} textAnchor="end" fontSize={9.5} fill="#e2e8f0" className="num">
          {seconds(req.durationMs)}
        </text>
      )}
    </g>
  );
}

function ToolShape(props: { tool: ToolView; y: number; x: (t: number) => number; now: number; color: string; focused: boolean }) {
  const { tool, y, x, now, color } = props;
  const sx = x(tool.start);
  const w = Math.max(3, x(tool.end ?? now) - sx);
  const fill = tool.blocked ? 'url(#blocked)' : tool.isError ? '#f43f5e' : color;
  return (
    <g className="cursor-pointer" onClick={() => useUi.setState({ focus: tool.toolCallId })}>
      <title>{`${tool.name}${tool.durationMs !== undefined ? ` · ${seconds(tool.durationMs)}` : ' · 执行中'}${tool.blocked ? `\n被拦截：${tool.blocked.reason}` : ''}${tool.isError && !tool.blocked ? '\nisError' : ''}\n参数 ${JSON.stringify(tool.args)}`}</title>
      <rect x={sx} y={y} width={w} height={TOOL_H} rx={2.5} fill={fill} fillOpacity={tool.end ? 0.55 : 0.35} stroke={props.focused ? '#fff' : color} strokeOpacity={props.focused ? 1 : 0.6} />
      {tool.updates.map((u, i) => (
        <line key={i} x1={x(u.at)} x2={x(u.at)} y1={y + 1} y2={y + TOOL_H - 1} stroke="#fff" strokeOpacity={0.7} />
      ))}
      <text x={sx + 4} y={y + 8.8} fontSize={9} fill="#f8fafc">
        {tool.name}
      </text>
      {tool.hooks.map((m, i) => (
        <Diamond key={i} cx={x(m.at)} cy={y + TOOL_H / 2} mark={m} small />
      ))}
    </g>
  );
}

function Diamond(props: { cx: number; cy: number; mark: HookMark; small?: boolean }) {
  const r = props.small ? 4 : 5;
  const { cx, cy, mark } = props;
  return (
    <path d={`M${cx} ${cy - r} L${cx + r} ${cy} L${cx} ${cy + r} L${cx - r} ${cy} Z`} fill={hookColor(mark)} stroke="#0f172a" strokeWidth={1}>
      <title>{`${mark.hook} · ${mark.durationMs.toFixed(2)}ms\n${JSON.stringify(mark.decision)}`}</title>
    </path>
  );
}
