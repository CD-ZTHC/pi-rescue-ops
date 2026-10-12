// 工具试验台（§3.4）：表单由工具的 TypeBox schema 生成，经 runToolCall 执行——与模型调用走完全相同的 hook。
import { AnimatePresence, motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { CREW_COLORS, type CrewId, type ToolMeta } from '@rescue/protocol';
import { send } from '../net/client.ts';
import { useUi } from '../store/index.ts';
import { useLightbox } from '../comms/Lightbox.tsx';

type Schema = { type?: string; anyOf?: Schema[]; const?: unknown; properties?: Record<string, Schema>; required?: string[]; items?: Schema; description?: string; minimum?: number };

function literals(s: Schema): string[] | undefined {
  const opts = s.anyOf;
  if (opts && opts.every((o) => o.const !== undefined)) return opts.map((o) => String(o.const));
  return undefined;
}

function Field(props: { name: string; schema: Schema; required: boolean; value: string; onChange: (v: string) => void }) {
  const { schema } = props;
  const lits = literals(schema);
  const cls = 'w-full rounded border border-slate-700 bg-slate-950/70 px-2 py-1 text-[12px] text-slate-100 focus:border-cyan-400/60 focus:outline-none';
  return (
    <label className="block">
      <span className="num text-[11px] text-slate-400">
        {props.name}
        {props.required ? ' *' : ''} <span className="text-slate-600">{schema.description ?? schema.type ?? ''}</span>
      </span>
      {lits ? (
        <select className={cls} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
          <option value="">—</option>
          {lits.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      ) : schema.type === 'boolean' ? (
        <select className={cls} value={props.value} onChange={(e) => props.onChange(e.target.value)}>
          <option value="">—</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input className={cls} value={props.value} placeholder={schema.type === 'array' ? '逗号分隔' : ''} onChange={(e) => props.onChange(e.target.value)} />
      )}
    </label>
  );
}

function coerce(schema: Schema, raw: string): unknown {
  if (raw === '') return undefined;
  if (schema.type === 'number' || schema.type === 'integer') return Number(raw);
  if (schema.type === 'boolean') return raw === 'true';
  if (schema.type === 'array') return raw.split(/[,，\s]+/).filter(Boolean).map((x) => (schema.items?.type === 'integer' || schema.items?.type === 'number' ? Number(x) : x));
  return raw;
}

export function ToolBench() {
  const { benchOpen, crew, bench } = useUi();
  const [agentId, setAgent] = useState<CrewId>('commander');
  const [tool, setTool] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const member = crew.find((c) => c.id === agentId);
  const meta: ToolMeta | undefined = member?.tools.find((t) => t.name === tool) ?? member?.tools[0];
  const schema = (meta?.parameters ?? {}) as Schema;
  const fields = useMemo(() => Object.entries(schema.properties ?? {}), [schema]);

  const invoke = () => {
    if (!meta) return;
    const args: Record<string, unknown> = {};
    for (const [k, s] of fields) {
      const v = coerce(s, values[k] ?? '');
      if (v !== undefined) args[k] = v;
    }
    send({ t: 'tool.invoke', agentId, tool: meta.name, args });
  };

  return (
    <AnimatePresence>
      {benchOpen && (
        <motion.aside
          className="panel fixed bottom-16 right-3 top-16 z-30 flex w-[420px] flex-col p-3 text-[12.5px]"
          initial={{ opacity: 0, x: 24 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 24 }}
          transition={{ duration: 0.2 }}
        >
          <div className="mb-2 flex items-center gap-2">
            <h3 className="font-semibold text-slate-100">工具试验台</h3>
            <span className="text-[11px] text-slate-500">runToolCall · 经过同样的 before/after hook</span>
            <button className="ml-auto text-slate-400 hover:text-white" onClick={() => useUi.setState({ benchOpen: false })} aria-label="关闭">
              ✕
            </button>
          </div>
          <div className="mb-2 flex gap-2">
            <select className="rounded border border-slate-700 bg-slate-900 px-1.5 py-1" value={agentId} onChange={(e) => (setAgent(e.target.value as CrewId), setTool(''), setValues({}))}>
              {crew.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select className="num min-w-0 flex-1 rounded border border-slate-700 bg-slate-900 px-1.5 py-1" value={meta?.name ?? ''} onChange={(e) => (setTool(e.target.value), setValues({}))}>
              {member?.tools.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} {t.flags.join(' ')}
                </option>
              ))}
            </select>
          </div>
          {meta && (
            <div className="space-y-2 rounded-md border border-slate-700/70 bg-slate-950/40 p-2">
              <div className="text-[11.5px] text-slate-400">{meta.description}</div>
              {fields.map(([k, s]) => (
                <Field key={k} name={k} schema={s} required={schema.required?.includes(k) ?? false} value={values[k] ?? ''} onChange={(v) => setValues({ ...values, [k]: v })} />
              ))}
              <button className="w-full rounded-md bg-cyan-500/80 py-1 font-medium text-slate-950 hover:bg-cyan-400" onClick={invoke}>
                执行 {meta.name}
              </button>
            </div>
          )}
          <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 scrollbar-thin">
            {bench.map((b, i) => (
              <div key={i} className={`rounded-md border p-2 ${b.isError ? 'border-rose-500/50 bg-rose-950/20' : 'border-slate-700/70 bg-slate-950/40'}`}>
                <div className="num mb-1 flex gap-2 text-[11.5px]">
                  <span style={{ color: CREW_COLORS[b.agentId] }}>{b.tool}</span>
                  <span className="truncate text-slate-500">{JSON.stringify(b.args)}</span>
                  <span className="ml-auto text-slate-400">{b.blocked ? '被 hook 拦截' : b.durationMs !== undefined ? `${b.durationMs.toFixed(0)}ms` : ''}</span>
                </div>
                {(b.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>).map((c, j) =>
                  c.type === 'text' ? (
                    <div key={j} className="whitespace-pre-wrap text-slate-300">
                      {c.text}
                    </div>
                  ) : (
                    <button key={j} onClick={() => useLightbox.setState({ src: `data:${c.mimeType};base64,${c.data}`, caption: b.tool })}>
                      <img className="mt-1 h-[90px] w-[120px] rounded border border-slate-600" style={{ imageRendering: 'pixelated' }} src={`data:${c.mimeType};base64,${c.data}`} alt={`${b.tool} 结果图`} />
                    </button>
                  ),
                )}
                {b.structured !== undefined && <pre className="num mt-1 max-h-32 overflow-auto rounded bg-slate-900 p-1.5 text-[10.5px] text-slate-400 scrollbar-thin">{JSON.stringify(b.structured, null, 1)}</pre>}
              </div>
            ))}
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
