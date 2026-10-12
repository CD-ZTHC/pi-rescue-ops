// 子 Agent 统一的交付工具（⏹）。M5 起由 delegate 读取它的 structuredContent 作为委派结果。
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';
import { text } from './shared.ts';

const Params = Type.Object({
  summary: Type.String({ description: '一两句话的结论' }),
  findings: Type.Optional(Type.Array(Type.String(), { description: '要点，每条一句' })),
  confidence: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium'), Type.Literal('high')])),
});
const Output = Type.Object({ summary: Type.String(), findings: Type.Array(Type.String()), confidence: Type.String() });

export function reportBackTool(): AgentTool<typeof Params> {
  return {
    name: 'report_back',
    label: '交付报告',
    description: '任务完成时调用，提交结论并结束本次任务。',
    parameters: Params,
    outputSchema: Output,
    executionMode: 'sequential',
    async execute(_id, { summary, findings = [], confidence = 'medium' }) {
      const report = { summary, findings, confidence };
      return { content: [text(`已交付：${summary}`)], details: report, structuredContent: report, terminate: true };
    },
  };
}
