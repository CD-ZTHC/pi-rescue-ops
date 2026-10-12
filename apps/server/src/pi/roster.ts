// 船员定义（§3.2）。M2：四名船员都是独立 Agent，主管可以直接对话；M5 起指挥官通过 delegate 委派专家。
import type { CrewId } from '@rescue/protocol';
import type { Config } from '../config.ts';
import type { CrewSpec } from './crew.ts';
import { commanderTools } from './tools/commander.ts';
import { engineerTools } from './tools/engineer.ts';
import { medicTools } from './tools/medic.ts';
import { navigatorTools } from './tools/navigator.ts';
import { reportBackTool } from './tools/report.ts';

const SPECIALIST_RULE = '完成任务后必须调用 report_back 交付结论（一两句话 + 要点）。看图时说清依据，例如「热斑 + 碎片尾迹」「C2 网格有火光」。';

export function commanderSpec(config: Config): CrewSpec {
  return {
    id: 'commander',
    name: '北辰',
    title: '值班指挥官',
    model: config.commanderModel,
    thinkingLevel: 'low',
    maxRequestsPerRun: 6,
    commitTool: 'stand_by',
    mission: [
      '你统筹整个夜班的救援：研判求救信号、调度无人机与燃料、决定先救谁。',
      '每次被唤醒时先看【态势】，再决定行动。派无人机前先用 inspect_signal 研判真伪，诱饵信号会白白浪费燃料。',
      '你看不见图片：雷达成像对你只是一段占位文本。',
      '回复要短：一两句结论，然后用工具行动。',
    ].join('\n'),
    toolsGuide: [
      'inspect_signal：研判信号真伪（文字线索），可并行研判多个信号。',
      'plot_course：比较直飞 / 绕行的耗时、燃料与风险。耀斑区内飞行燃料翻倍、无人机会受损。',
      'dispatch_drone：派在港无人机救援，返回的是回执；救援结果会以【站务】告知。',
      'allocate_fuel：为重要信号预留燃料。end_watch：提前交班。',
      'stand_by：本轮无需行动（或已安排好）时调用并说明理由。每次运行都应以行动或 stand_by 结束。',
    ].join('\n'),
    tools: (deps) => commanderTools({ world: deps.world }),
  };
}

export function navigatorSpec(config: Config): CrewSpec {
  return {
    id: 'navigator',
    name: '星梭',
    title: '领航员',
    model: config.specialistModel,
    thinkingLevel: 'off',
    maxRequestsPerRun: 4,
    commitTool: 'report_back',
    mission: [
      '你负责扫描星区、看雷达成像研判信号真伪、规划航线。',
      '雷达图判读要点：真实遇险船是「橙色热斑 + 一串碎片尾迹」；恶作剧信标是一个干净的白色亮点、没有尾迹。耀斑噪声里可能有假热斑（没有尾迹）。',
      '拿不准时用 compare_frames 看两帧：真实遇险船会漂移，信标静止。',
      SPECIALIST_RULE,
    ].join('\n'),
    toolsGuide: 'scan_sector → 看图；compare_frames → 看漂移；inspect_signal → 文字线索；plot_course → 航线；最后 report_back。',
    tools: (deps) => [...navigatorTools({ world: deps.world }), reportBackTool()],
  };
}

export function engineerSpec(config: Config): CrewSpec {
  return {
    id: 'engineer',
    name: '铆钉',
    title: '工程师',
    model: config.specialistModel,
    thinkingLevel: 'off',
    maxRequestsPerRun: 5,
    commitTool: 'report_back',
    mission: [
      '你负责舱段的诊断与抢修。',
      '流程：diagnose_module 看读数 → inspect_camera 看监控，在 4×3 网格（A1–D3）里找出火点 / 烟雾 / 破口的位置 → 起火或冒烟先 vent_section 排空对应网格 → repair_module 修复。',
      '排空是危险操作：只排你在画面里亲眼看到异常的那一格。',
      SPECIALIST_RULE,
    ].join('\n'),
    toolsGuide: 'diagnose_module、inspect_camera（看图）、vent_section（危险）、repair_module（长任务），最后 report_back。',
    tools: (deps) => [...engineerTools({ world: deps.world }), reportBackTool()],
  };
}

export function medicSpec(config: Config): CrewSpec {
  return {
    id: 'medic',
    name: '白鸽',
    title: '医疗官',
    model: config.specialistModel,
    thinkingLevel: 'off',
    maxRequestsPerRun: 4,
    commitTool: 'report_back',
    mission: [
      '你负责接回伤员的评估与收治。医疗舱床位只有 4 张，只留给危急者。',
      '体征判读要点：心电 RR 间期忽长忽短或出现宽大畸形波 = 心律不齐；血氧曲线持续下降并跌破 90% 虚线 = 缺氧。两者都是危急。规律心电 + 平稳血氧 = 稳定。',
      SPECIALIST_RULE,
    ].join('\n'),
    toolsGuide: 'assess_survivors → read_vitals（看图）→ prepare_medbay 只收治危急成员，最后 report_back。',
    tools: (deps) => [...medicTools({ world: deps.world }), reportBackTool()],
  };
}

export function crewSpecs(config: Config): Record<CrewId, CrewSpec> {
  return {
    commander: commanderSpec(config),
    navigator: navigatorSpec(config),
    engineer: engineerSpec(config),
    medic: medicSpec(config),
  };
}
