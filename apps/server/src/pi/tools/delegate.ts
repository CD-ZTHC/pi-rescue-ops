// Agent 即工具（§5.7）：指挥官把任务委派给子 Agent。
// - 子 Agent 的事件经 onUpdate 冒泡成 tool_execution_update（Inspector 据此展开嵌套子泳道）
// - 中止级联：父工具的 signal 中止时，子 Agent 一并中止
// - 子 Agent 正忙：把新任务 steer 进它当前的运行，等它这次运行结束
import type { AgentEvent, AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import type { CrewId } from '@rescue/protocol';
import type { CrewMember } from '../crew.ts';
import { worldEventMessage } from '../messages.ts';
import { text } from './shared.ts';

const NAMES: Record<string, string> = { navigator: '星梭（领航员，看雷达）', engineer: '铆钉（工程师，看监控）', medic: '白鸽（医疗官，看体征）' };

const Params = Type.Object({
  crew: Type.Union([Type.Literal('navigator'), Type.Literal('engineer'), Type.Literal('medic')], { description: 'navigator 领航员 / engineer 工程师 / medic 医疗官' }),
  task: Type.String({ description: '交代清楚的任务，例如「扫描 C 区，判断 S-03 真伪」' }),
});
const Output = Type.Object({ crew: Type.String(), summary: Type.String(), findings: Type.Array(Type.String()), confidence: Type.String() });

/** 把子 Agent 事件压缩成一条进度（不转发流式增量，避免刷屏） */
function progressOf(ev: AgentEvent): string | undefined {
  switch (ev.type) {
    case 'turn_start':
      return '思考中';
    case 'tool_execution_start':
      return `调用 ${ev.toolName}`;
    case 'tool_execution_end':
      return `${ev.toolName} ${ev.isError ? '失败' : '完成'}`;
    default:
      return undefined;
  }
}

export function delegateTool(crew: (id: CrewId) => CrewMember | undefined): AgentTool<typeof Params> {
  return {
    name: 'delegate',
    label: '委派专家',
    description: '把需要看图或专业处置的任务委派给专家，返回专家的报告。可以在同一个回复里并行委派多名专家。',
    parameters: Params,
    outputSchema: Output,
    executionMode: 'parallel',
    async execute(toolCallId, { crew: id, task }, signal, onUpdate) {
      const child = crew(id);
      if (!child) return { content: [text(`${id} 不在岗`)], details: { crew: id }, isError: true };
      const forward = (ev: AgentEvent) => {
        const p = progressOf(ev);
        if (p) onUpdate?.({ content: [text(`${NAMES[id]}：${p}`)], details: { crew: id, childEvent: ev.type, tool: 'toolName' in ev ? ev.toolName : undefined } });
      };
      const off = child.agent.subscribe(forward);
      const onAbort = () => child.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      child.setParent(toolCallId);
      try {
        const message = worldEventMessage('task', `【指挥官委派】${task}`);
        if (child.isRunning) {
          // 子 Agent 正忙：把新任务插进它当前的运行
          child.deliver(message, 'steer');
          await child.agent.waitForIdle();
        } else {
          await child.run(message);
        }
        if (signal?.aborted) throw new Error('委派已中止');
        const report = child.lastReport() as { summary: string; findings: string[]; confidence: string } | undefined;
        if (!report) return { content: [text(`${NAMES[id]}未交付报告`)], details: { crew: id }, isError: true };
        const result = { crew: id, summary: report.summary, findings: report.findings ?? [], confidence: report.confidence ?? 'medium' };
        const lines = [`${NAMES[id]}报告：${report.summary}`, ...result.findings.map((f) => `- ${f}`)];
        return { content: [text(lines.join('\n'))], details: { crew: id, report: result }, structuredContent: result };
      } finally {
        off();
        signal?.removeEventListener('abort', onAbort);
        child.setParent(undefined);
      }
    },
  };
}
