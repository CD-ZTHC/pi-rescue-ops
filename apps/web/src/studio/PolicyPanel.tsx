// 策略开关：每个 hook 策略都可以单独关掉（§5.1），对应课程里的「关掉它会怎样」。
import { AnimatePresence, motion } from 'motion/react';
import { POLICY_FLAGS, type PolicyKey } from '@rescue/protocol';
import { send } from '../net/client.ts';
import { useUi } from '../store/index.ts';

const GROUPS = ['beforeToolCall', 'afterToolCall', 'finishTurn', 'prepareRequest', 'transformContext', 'agent_end', 'tools'];

export function PolicyPanel() {
  const { policyOpen, policy } = useUi();
  return (
    <AnimatePresence>
      {policyOpen && (
        <motion.div
          className="panel fixed bottom-16 right-3 z-30 w-80 p-3 text-[12.5px]"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.18 }}
        >
          <div className="mb-2 flex items-center">
            <h3 className="font-semibold text-slate-100">策略开关</h3>
            <span className="ml-2 text-[11px] text-slate-500">全员共享，立即生效</span>
            <button className="ml-auto text-slate-400 hover:text-white" onClick={() => useUi.setState({ policyOpen: false })} aria-label="关闭">
              ✕
            </button>
          </div>
          <div className="max-h-[60vh] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
            {GROUPS.map((g) => {
              const keys = (Object.keys(POLICY_FLAGS) as PolicyKey[]).filter((k) => POLICY_FLAGS[k].hook === g);
              if (!keys.length) return null;
              return (
                <div key={g}>
                  <div className="num mb-1 text-[11px] text-violet-300">{g}</div>
                  {keys.map((k) => (
                    <label key={k} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-slate-800/60">
                      <input type="checkbox" className="accent-cyan-400" checked={policy[k]} onChange={(e) => send({ t: 'policy.set', key: k, value: e.target.checked })} />
                      <span className={policy[k] ? 'text-slate-200' : 'text-slate-500'}>{POLICY_FLAGS[k].label}</span>
                      <span className="num ml-auto text-[10.5px] text-slate-600">{k}</span>
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
