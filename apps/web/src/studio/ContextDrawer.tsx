// 「模型看到的上下文」抽屉：并排显示 agent.state.messages 与 convertToLlm 之后的结果（§5.2）。
import { AnimatePresence, motion } from 'motion/react';
import { zh } from '../i18n/zh.ts';
import { send } from '../net/client.ts';
import { useUi } from '../store/index.ts';

function preview(m: unknown): { role: string; body: string } {
  const msg = m as { role: string; content?: unknown; text?: string; reasons?: string[]; toolName?: string };
  let body = '';
  if (typeof msg.content === 'string') body = msg.content;
  else if (Array.isArray(msg.content))
    body = msg.content
      .map((c: { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown }) =>
        c.type === 'text' ? c.text : c.type === 'thinking' ? `〔思考〕${c.thinking}` : c.type === 'toolCall' ? `→ ${c.name}(${JSON.stringify(c.arguments)})` : `[${c.type}]`,
      )
      .join('\n');
  else if (msg.role === 'situation') body = `brief（${(msg as { brief?: { signals: unknown[] } }).brief?.signals.length ?? 0} 个信号）· 原因 ${msg.reasons?.join('、')}`;
  else body = msg.text ?? JSON.stringify(m).slice(0, 300);
  return { role: msg.toolName ? `${msg.role} · ${msg.toolName}` : msg.role, body };
}

function Column(props: { title: string; messages: unknown[] }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="mb-1 text-[12px] font-medium text-cyan-200">
        {props.title} <span className="num text-slate-500">({props.messages.length})</span>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1 scrollbar-thin">
        {props.messages.map((m, i) => {
          const p = preview(m);
          return (
            <div key={i} className="rounded border border-slate-700/70 bg-slate-950/60 p-2">
              <div className="num mb-0.5 text-[10.5px] text-violet-300">
                #{i} {p.role}
              </div>
              <div className="max-h-40 overflow-y-auto whitespace-pre-wrap text-[11.5px] leading-relaxed text-slate-300 scrollbar-thin">{p.body}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ContextDrawer() {
  const { contextOpen, contextView } = useUi();
  return (
    <AnimatePresence>
      {contextOpen && (
        <motion.div
          className="fixed inset-x-2 bottom-16 top-16 z-30 flex flex-col p-3 panel"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 24 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
        >
          <div className="mb-2 flex items-center gap-3">
            <h3 className="font-semibold text-slate-100">{zh.context.title}</h3>
            <span className="text-[12px] text-slate-400">北辰</span>
            <button className="ml-auto rounded px-2 py-0.5 text-[12px] text-cyan-200 hover:bg-cyan-500/10" onClick={() => send({ t: 'context.request', agentId: 'commander' })}>
              ↻ {zh.context.refresh}
            </button>
            <button className="text-slate-400 hover:text-white" onClick={() => useUi.setState({ contextOpen: false })} aria-label="关闭">
              ✕
            </button>
          </div>
          {contextView ? (
            <div className="flex min-h-0 flex-1 gap-3">
              <div className="flex w-72 shrink-0 flex-col gap-2">
                <div className="text-[12px] font-medium text-cyan-200">{zh.context.system}</div>
                <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded border border-slate-700/70 bg-slate-950/60 p-2 text-[11px] text-slate-300 scrollbar-thin">
                  {contextView.systemPrompt}
                </pre>
                <div className="text-[12px] font-medium text-cyan-200">{zh.context.tools}</div>
                <div className="flex flex-wrap gap-1">
                  {contextView.tools.map((t) => (
                    <span key={t} className="num rounded bg-slate-800 px-1.5 py-0.5 text-[11px] text-slate-200">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
              <Column title={zh.context.raw} messages={contextView.messages} />
              <Column title={zh.context.llm} messages={contextView.llmMessages} />
            </div>
          ) : (
            <div className="text-slate-500">加载中…</div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
