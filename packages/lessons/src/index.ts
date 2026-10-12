// 课程定义（§8）。前端只读元数据；faux 脚本由后端执行。课程脚本同时就是该能力的回归测试（§11）。
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxResponseStep,
  type Message,
} from '@earendil-works/pi-ai';
import type { LessonMeta } from '@rescue/protocol';

type MetaRow = [index: number, title: string, capability: string, scenario: string, milestone: string];

const ROWS: MetaRow[] = [
  [1, '事件流', 'prompt、subscribe、事件顺序', '指挥官回应一条态势', 'M1'],
  [2, '流式思考', 'thinking_* 事件、thinkingLevel、thinkingBudgets', '同一问题分别用 off / low / medium', 'M1'],
  [3, '工具基础', 'TypeBox 校验、参数错误回传、terminate', '模型传了非法星区', 'M2'],
  [4, '并行与串行', 'toolExecution、工具级 executionMode', '扫描 3 个星区，再混入一次 dispatch_drone', 'M2'],
  [5, '工具流式进度', 'onUpdate、tool_execution_update', '修复舱段', 'M2'],
  [6, '结构化结果', 'outputSchema、structuredContent、isError', '扫描时部分失败', 'M2'],
  [7, '拦截与审批', 'beforeToolCall 的 block / terminate', '无人机闯入耀斑区', 'M3'],
  [8, '结果改写', 'afterToolCall 改写 content / structuredContent', '地面站数据打码', 'M3'],
  [9, '回合控制', 'finishTurn、prepareNextTurnWithContext', '模型只说话不行动', 'M3'],
  [10, '请求前准备', 'prepareRequest 换上下文、模型、思考档位', '排队期间态势已变化；进入危机模式', 'M3'],
  [11, '插话与排队', 'steer、followUp、队列模式、peekQueuedMessages、abort', '主管连续插话', 'M3'],
  [12, '自定义消息', 'CustomAgentMessages、convertToLlm', '无线电、站务、UI 旁白', 'M4'],
  [13, '提示分段与动态工具', 'system sections、state.tools 差异', '机库损坏后修复', 'M4'],
  [14, '上下文管理', 'transformContext、运行间隙压缩、溢出恢复', '长班次', 'M4'],
  [15, 'Agent 即工具', '子 Agent、onUpdate 冒泡、中止级联', '三路并行委派', 'M5'],
  [16, '脚本编排', 'runToolCall、pi-codemode、nestedCalls', '一次脚本查询 10 个信号', 'M6'],
  [17, 'MCP', 'pi-mcp、toLlmContent、工具列表变化', '地面站上线新卫星', 'M6'],
  [18, '分类器', 'classify()、自定义 ProviderClassifier、模型类型', '采样 k=1 与 k=5 的对比', 'M6'],
  [19, '录制回放', 'faux provider、响应工厂', '回放一次真实班次', 'M7'],
  [20, '低层循环', 'agentLoop，与 Agent 的屏障语义对比', '班末评审', 'M6'],
  [21, '观测', 'onProviderStreamEvent、TTFT、durationMs、费用、telemetry', '读懂一次请求的耗时构成', 'M6'],
  [22, '多模态', 'ImageContent、model.input、工具结果图片、纯文本模型的自动降级', '指挥官看不见火点，委派工程师看监控', 'M5'],
];

const SUMMARIES: Record<number, string> = {
  1: '一次 prompt 会产生怎样的事件序列？agent_start → turn_start → message_start/end（态势）→ 流式 assistant 消息 → 工具执行 → 下一个 turn → agent_end。看 Inspector：每个 turn 是一个色块，请求条里的竖线是 TTFT，下方的甘特条是工具执行。stand_by 返回 terminate，所以运行在工具批次之后直接结束，不再发起请求。',
  2: 'thinkingLevel 决定 pi 向模型请求多少推理（GLM 使用 thinking: { type }）。同一个问题依次用 off / low / medium 各跑一次，比较请求条里的「思考」斜纹分段、频道中可折叠的思考内容，以及 AssistantMessage.thinkingLevel 字段。注意：glm-5.3-flash 实测会忽略 disabled，UI 按 usage.reasoning 如实显示。',
};

export type ThinkingLevelName = 'off' | 'minimal' | 'low' | 'medium' | 'high';

/** 一次触发：给指挥官送一条消息并跑完整个运行 */
export interface LessonStep {
  label: string;
  thinkingLevel?: ThinkingLevelName;
  trigger: { kind: 'situation'; reason: string } | { kind: 'operator'; text: string };
  /** faux 模式下本步要排入的响应 */
  responses: FauxResponseStep[];
}

export interface LessonScript {
  meta: LessonMeta;
  seed: number;
  /** 开课时预先生成的信号数 */
  spawnSignals: number;
  steps: LessonStep[];
  /** 回归断言：faux 模式下本课应依次调用的工具 */
  expectTools: string[];
}

const textOf = (m: Message | undefined): string =>
  !m ? '' : typeof m.content === 'string' ? m.content : m.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

/** 从上下文最新态势中找第一个尚未扫描的星区 */
const firstUnscanned = (messages: Message[]): string => {
  const situation = [...messages].reverse().map(textOf).find((t) => t.startsWith('【态势')) ?? '';
  return situation.match(/^- S-\d+｜([A-F]) 区.*尚未扫描/m)?.[1] ?? 'A';
};

const lesson1: LessonScript = {
  meta: meta(1, true, ''),
  seed: 1001,
  spawnSignals: 1,
  expectTools: ['scan_sector', 'stand_by'],
  steps: [
    {
      label: '送出一条态势',
      thinkingLevel: 'low',
      trigger: { kind: 'situation', reason: '新信号' },
      responses: [
        (context) => {
          const sector = firstUnscanned(context.messages);
          return fauxAssistantMessage(
            [
              fauxThinking(`新信号在 ${sector} 区，真伪未知。先扫描。`),
              fauxText(`收到。${sector} 区出现求救信号，先扫描核实。`),
              fauxToolCall('scan_sector', { sector }),
            ],
            { stopReason: 'toolUse' },
          );
        },
        fauxAssistantMessage(
          [
            fauxThinking('扫描结果已到，记录结论后待命。'),
            fauxText('扫描完成，线索已记录。M1 还没有无人机调度，先待命。'),
            fauxToolCall('stand_by', { reason: '已核实信号，等待调度能力（M2）' }),
          ],
          { stopReason: 'toolUse' },
        ),
      ],
    },
  ],
};

const QUESTION = '只看目前掌握的信息：S-01 值得立刻派无人机吗？给出一句结论。';

/** 思考长度随档位变化：同一个问题，off 没有思考块，medium 思考最长 */
const levelAware = (): FauxResponseStep => (_context, options) => {
  const level = options?.reasoning ?? 'off';
  const thoughts: Record<string, string[]> = {
    off: [],
    minimal: ['看报告人数。'],
    low: ['报告人数不少，但还没扫描，真伪未知。'],
    medium: [
      '报告人数不少，但还没扫描，真伪未知。',
      '约 15% 的信号是诱饵；无人机一来一回要消耗 8–20 燃料。',
      '倒计时还长，先花几秒扫描是更划算的选择。',
    ],
    high: ['（同 medium，更长）'],
  };
  const blocks = (thoughts[level] ?? []).map((t) => fauxThinking(t));
  return fauxAssistantMessage(
    [...blocks, fauxText(`【档位 ${level}】不建议立刻派出：先扫描核实真伪。`), fauxToolCall('stand_by', { reason: '先扫描再决定' })],
    { stopReason: 'toolUse' },
  );
};

const lesson2: LessonScript = {
  meta: meta(2, true, '把思考档位固定为 off，对比 Inspector 中请求条的「思考」分段是否消失'),
  seed: 1002,
  spawnSignals: 1,
  expectTools: ['stand_by', 'stand_by', 'stand_by'],
  steps: (['off', 'low', 'medium'] as const).map((level) => ({
    label: `思考档位 ${level}`,
    thinkingLevel: level,
    trigger: { kind: 'operator' as const, text: QUESTION },
    responses: [levelAware()],
  })),
};

const SCRIPTS: Record<string, LessonScript> = {
  [lesson1.meta.id]: lesson1,
  [lesson2.meta.id]: lesson2,
};

function meta(index: number, available: boolean, toggle: string): LessonMeta {
  const row = ROWS[index - 1];
  return {
    id: `L${String(index).padStart(2, '0')}`,
    index,
    title: row[1],
    capability: row[2],
    scenario: row[3],
    milestone: row[4],
    summary: SUMMARIES[index] ?? `本课在 ${row[4]} 实现。`,
    toggle: toggle || undefined,
    available,
  };
}


export function lessonList(): LessonMeta[] {
  return ROWS.map(([index]) => SCRIPTS[`L${String(index).padStart(2, '0')}`]?.meta ?? meta(index, false, ''));
}

export function getLesson(id: string): LessonScript | undefined {
  return SCRIPTS[id];
}
