// 课程定义（§8）。前端只读元数据；faux 脚本由后端执行。课程脚本同时就是该能力的回归测试（§11）。
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type FauxResponseStep,
  type Message,
} from '@earendil-works/pi-ai';
import type { CrewId, IncidentKind, LessonMeta, ModuleId, ModuleStatus, PolicyKey } from '@rescue/protocol';

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
  3: '工具参数先经过 prepareArguments（把「c区」归一化为「C」），再由 TypeBox 按 schema 校验。校验失败不会抛到你的代码里：pi 把错误作为 isError 的工具结果回传给模型，模型下一轮自行更正。stand_by 返回 terminate: true，整批工具都 terminate 时运行直接结束，不再发起请求。',
  4: '同一条 assistant 消息里的多个工具调用，默认（toolExecution: "parallel"）并发执行：Inspector 中三条扫描纵向叠放。只要批次里有一个工具声明 executionMode: "sequential"（dispatch_drone），整批改为串行，工具条首尾相接。tool_execution_end 按完成顺序发出，而 toolResult 消息仍按调用顺序写入。',
  5: '长任务通过 execute 的第四个参数 onUpdate 流式汇报进度，每次调用都会产生一个 tool_execution_update 事件。工程师修复机库要 8 秒：Inspector 的工具条上每秒一道刻度，频道卡片里显示百分比。onUpdate 只在 execute 运行期间有效，结束后的调用会被忽略。',
  6: 'pi 1.1 的工具结果有两份：content 给模型看，structuredContent 给程序和 UI（必须符合 outputSchema）。业务失败返回 isError: true，而不是抛错——这样 details 与 structuredContent 都能保留下来。传感器受损时扫描只拿到半个扇区：模型看到错误，UI 仍能画出部分结果。注意：核心不会把 structuredContent 写进 transcript，只能从 tool_execution_end 事件获取。',
  7: 'beforeToolCall 在参数校验之后、执行之前运行，可以返回 { block: true, reason } 拦截。这里的策略链是 stepGate → staleGuard → budgetGuard → dangerApproval：无人机航线经过耀斑区时，dangerApproval 发出审批请求并 await 主管的决定（30 秒超时视为否决）。被拦截的调用以 isError 的工具结果回到模型，模型换了绕行航线再申请。拦截时还可以附带 terminate，让运行在本批工具之后结束。',
  9: 'finishTurn 在一个 turn 的全部工具结果写入之后、turn_end 之前运行。模型只说话不调用工具时，返回 { action: "continue" } 再要一轮；配合 prepareNextTurnWithContext 在下一轮之前追加一条提醒。注意：无条件返回 continue 会造成死循环，所以这里同时用请求预算兜底（指挥官每次运行最多 6 次请求）。',
  10: 'prepareRequest 在每次请求之前运行（包括第一次），此时排队的消息已经写入。这里做两件事：把最新那条态势刷新成请求时刻的世界（排队期间又来了 S-03）；存在 ≥2 个危急信号时把思考档位升到 medium。返回的 context / model / thinkingLevel 会替换本次及后续请求的运行时值。',
  11: 'steer() 的消息在当前 turn 的工具全部执行完之后注入；followUp() 的消息要等运行本来就要结束时才注入，并自动开始下一轮。队列模式默认 "all"：一次注入全部排队消息；改成 "one-at-a-time" 每次只注入一条。peekQueuedMessages() 能预览下一次将被注入的消息，显示在泳道末尾的队列徽章里。',
  12: 'AgentMessage = LLM 消息 + 你声明合并的自定义消息（CustomAgentMessages）。本项目有 situation、radio、world_event、operator、compaction、ui_note 六种。convertToLlm 在每次请求前把它们转成模型能懂的 user 文本：只有最新一条态势完整渲染，旧的折叠成一行；ui_note 直接过滤。打开「模型看到的上下文」抽屉，左边是 agent.state.messages，右边是转换之后的结果。',
  13: '首条 system 消息声明了 mission / rules / tools_guide / station_status / watch_phase 五个 section（稳定在前，易变在后，利于前缀缓存）。机库受损时：station_status 用一条只含 sections 的 system 消息打补丁；dispatch_drone 从 agent.state.tools 移除，pi 在下一次请求前自动写入工具差异。网关不支持中途声明工具（§2.3），所以完整工具表走 tools 参数。',
  14: '三层上下文管理：transformContext 每次请求前做视图裁剪（不改原始消息，永远保留 system 消息，旧图片折叠，超预算时从完整的边界开始裁）；运行间隙（agent 空闲、队列为空）由书记员把最老的一段写成摘要，替换为一条 compaction 消息——这会直接修改 agent.state.messages；遇到上下文溢出时强制压缩再 continue()。本课把预算压到 1800 token，五个信号之后就会看到压缩。',
  15: '子 Agent 就是一个工具：delegate 的 execute 里 await child.prompt()，返回专家用 report_back 交付的结构化报告。子 Agent 的事件通过 onUpdate 冒泡成父工具的 tool_execution_update，Inspector 据此把 delegate 工具条展开成嵌套子泳道。指挥官在一个回复里并行委派三名专家；父工具被中止时，signal 级联中止子 Agent；子 Agent 正忙时，新任务以 steer 插进它当前的运行。',
  22: '图片是 ImageContent。model.input 决定 pi-ai 如何处理：glm-5.3 只收文本，图片被 transformMessages 替换为占位文本；glm-5.3-flash 能看图，工具结果里的图片被拆成紧随其后的一条 user 消息。指挥官看不见图，有两种办法：委派给能看图的专家（第二步），或在 prepareRequest 里检测到未分析的图片时临时换成 flash 发这一次请求（第三步，「换眼睛」）。图片也占上下文：每个船员只保留最近 2 张。',
  2: 'thinkingLevel 决定 pi 向模型请求多少推理（GLM 使用 thinking: { type }）。同一个问题依次用 off / low / medium 各跑一次，比较请求条里的「思考」斜纹分段、频道中可折叠的思考内容，以及 AssistantMessage.thinkingLevel 字段。注意：glm-5.3-flash 实测会忽略 disabled，UI 按 usage.reasoning 如实显示。',
};

export type ThinkingLevelName = 'off' | 'minimal' | 'low' | 'medium' | 'high';

/** 一次触发：给某个船员（默认指挥官）送一条消息并跑完整个运行 */
export interface LessonStep {
  label: string;
  target?: CrewId;
  thinkingLevel?: ThinkingLevelName;
  trigger:
    | { kind: 'situation'; reason: string }
    | { kind: 'operator'; text: string }
    | { kind: 'duty'; text: string }
    | { kind: 'custom'; messages: Array<{ role: 'radio' | 'world_event' | 'ui_note' | 'situation'; text: string }> };
  /** 本步的策略开关（与 setup.policy 一样，课程结束后恢复） */
  policy?: Partial<Record<PolicyKey, boolean>>;
  /** 本步开始前世界先发生的事 */
  before?: { repair?: ModuleId; spawn?: number };
  /** faux 模式下本步要排入的响应 */
  responses: FauxResponseStep[];
  /** 课程自动驾驶：依次代替主管处理审批（主管抢先点了就以主管为准） */
  approvals?: Array<'approve' | 'deny'>;
  /** 某个工具开始执行时，以主管身份插话 */
  inject?: Array<{ onTool: string; mode: 'steer' | 'followUp'; text: string }>;
  /** 生成触发消息之后、开始运行之前，世界先发生变化（演示 prepareRequest 刷新态势） */
  changeBeforeRun?: 'spawn';
}

export interface LessonScript {
  meta: LessonMeta;
  seed: number;
  /** 开课时预先生成的信号数 */
  spawnSignals: number;
  setup?: {
    damage?: Array<{ module: ModuleId; status: ModuleStatus; incident?: { kind: IncidentKind; cell: string } }>;
    /** 在 S-01 所在星区安排一次耀斑，startIn 秒后爆发 */
    flareOnFirstSignal?: number;
    /** 额外生成 n 个「真实且危急」的信号，并预先研判（线索里出现「生命维持遥测断续」） */
    criticalSignals?: number;
    /** 生成一个真实信号并直接接回幸存者，建立伤员组（有待评估成员） */
    patient?: boolean;
    /** 上下文预算（估算 token），课程结束后恢复 */
    contextBudget?: number;
    /** 本课的策略开关（结束后恢复默认） */
    policy?: Partial<Record<PolicyKey, boolean>>;
  };
  steps: LessonStep[];
  /** 回归断言：faux 模式下本课应依次调用的工具 */
  expectTools: string[];
  /** 多个 Agent 并发时调用顺序不确定：只比较集合 */
  expectUnordered?: boolean;
}

const textOf = (m: Message | undefined): string =>
  !m ? '' : typeof m.content === 'string' ? m.content : m.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

/** 从上下文最新态势中找第一个信号所在的星区 */
const firstUnscanned = (messages: Message[]): string => {
  const situation = [...messages].reverse().map(textOf).find((t) => t.startsWith('【态势')) ?? '';
  return situation.match(/^- S-\d+｜([A-F]) 区/m)?.[1] ?? 'A';
};

const lastToolText = (messages: Message[]): string => textOf([...messages].reverse().find((m) => m.role === 'toolResult'));
const lastUserText = (messages: Message[]): string => textOf([...messages].reverse().find((m) => m.role === 'user'));

const lesson1: LessonScript = {
  meta: meta(1, true, ''),
  seed: 1001,
  spawnSignals: 1,
  setup: { policy: { delegation: false } },
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


const toolUse = (blocks: Parameters<typeof fauxAssistantMessage>[0]) => fauxAssistantMessage(blocks, { stopReason: 'toolUse' });

const lesson3: LessonScript = {
  meta: meta(3, true, '去掉 prepareArguments：「c区」也会被 TypeBox 拒绝，模型要多走一轮'),
  seed: 1003,
  spawnSignals: 1,
  setup: { policy: { delegation: false } },
  expectTools: ['scan_sector', 'scan_sector', 'stand_by'],
  steps: [
    {
      label: '模型传了非法星区',
      thinkingLevel: 'low',
      trigger: { kind: 'situation', reason: '新信号' },
      responses: [
        toolUse([fauxThinking('信号在……G 区？先扫描。'), fauxText('扫描信号所在星区。'), fauxToolCall('scan_sector', { sector: 'G区' })]),
        (context) => {
          const sector = firstUnscanned(context.messages);
          return toolUse([
            fauxThinking(`参数校验失败：星区只有 A–F。信号在 ${sector} 区。`),
            fauxText(`更正：扫描 ${sector} 区。`),
            // 小写 +「区」：由 prepareArguments 归一化为大写字母
            fauxToolCall('scan_sector', { sector: `${sector.toLowerCase()}区` }),
          ]);
        },
        toolUse([fauxText('扫描完成，图像已归档。'), fauxToolCall('stand_by', { reason: '已取得雷达成像，等待研判' })]),
      ],
    },
  ],
};

const lesson4: LessonScript = {
  meta: meta(4, true, '把全局 toolExecution 改成 sequential：第一批三次扫描会首尾相接，总耗时变成三倍'),
  seed: 1004,
  spawnSignals: 2,
  setup: { policy: { delegation: false } },
  expectTools: ['scan_sector', 'scan_sector', 'scan_sector', 'inspect_signal', 'dispatch_drone', 'stand_by'],
  steps: [
    {
      label: '并行扫描三个星区，再混入一次串行的 dispatch_drone',
      thinkingLevel: 'low',
      trigger: { kind: 'situation', reason: '新信号' },
      responses: [
        toolUse([
          fauxThinking('三个星区互不相干，同一个回复里并行扫描。'),
          fauxText('并行扫描 A、C、E 区。'),
          fauxToolCall('scan_sector', { sector: 'A' }),
          fauxToolCall('scan_sector', { sector: 'C' }),
          fauxToolCall('scan_sector', { sector: 'E' }),
        ]),
        toolUse([
          fauxThinking('研判 S-01，同时派 D-1 出发。dispatch_drone 声明为 sequential，整批会串行执行。'),
          fauxText('研判 S-01，并派 D-1 前往。'),
          fauxToolCall('inspect_signal', { signalId: 'S-01' }),
          fauxToolCall('dispatch_drone', { droneId: 'D-1', signalId: 'S-01' }),
        ]),
        toolUse([fauxText('D-1 已出发。'), fauxToolCall('stand_by', { reason: '等待 D-1 回报' })]),
      ],
    },
  ],
};

const lesson5: LessonScript = {
  meta: meta(5, true, '去掉 onUpdate：修复期间 Inspector 的工具条上不再有进度刻度，频道里也看不到百分比'),
  seed: 1005,
  spawnSignals: 0,
  setup: { damage: [{ module: 'hangar', status: 'damaged' }] },
  expectTools: ['diagnose_module', 'repair_module', 'report_back'],
  steps: [
    {
      label: '工程师修复机库',
      target: 'engineer',
      trigger: { kind: 'duty', text: '机库受损，请诊断并修复。' },
      responses: [
        toolUse([fauxText('先看读数。'), fauxToolCall('diagnose_module', { module: '机库' })]),
        toolUse([fauxText('没有明火，直接修复。'), fauxToolCall('repair_module', { module: 'hangar' })]),
        (context) => toolUse([fauxToolCall('report_back', { summary: lastToolText(context.messages), findings: ['修复期间每秒回报一次进度'] })]),
      ],
    },
  ],
};

const lesson6: LessonScript = {
  meta: meta(6, true, '不返回 structuredContent：UI 只能显示一行文字，部分扫描结果的卡片消失'),
  seed: 1006,
  spawnSignals: 2,
  setup: { damage: [{ module: 'sensors', status: 'damaged' }], policy: { delegation: false } },
  expectTools: ['scan_sector', 'inspect_signal', 'stand_by'],
  steps: [
    {
      label: '传感器受损时扫描：部分失败',
      thinkingLevel: 'low',
      trigger: { kind: 'situation', reason: '新信号' },
      responses: [
        (context) => toolUse([fauxText('扫描信号所在星区。'), fauxToolCall('scan_sector', { sector: firstUnscanned(context.messages) })]),
        toolUse([
          fauxThinking('扫描返回 isError，但 structuredContent 里仍有已探测到的信号。改用文字研判补足。'),
          fauxText('扫描不完整，改用研判。'),
          fauxToolCall('inspect_signal', { signalId: 'S-01' }),
        ]),
        toolUse([fauxText('已取得文字线索。'), fauxToolCall('stand_by', { reason: '传感器受损，等待工程师修复后再扫' })]),
      ],
    },
  ],
};

const lesson7: LessonScript = {
  meta: meta(7, true, '关掉「危险操作审批」：无人机直接闯进耀斑区，燃料翻倍、机体受损', 'dangerApproval'),
  seed: 1007,
  spawnSignals: 1,
  setup: { flareOnFirstSignal: 1 },
  expectTools: ['dispatch_drone', 'plot_course', 'dispatch_drone', 'stand_by'],
  steps: [
    {
      label: '无人机闯入耀斑区：先被否决，换航线后批准',
      thinkingLevel: 'low',
      trigger: { kind: 'situation', reason: '新信号' },
      approvals: ['deny', 'approve'],
      responses: [
        toolUse([fauxText('S-01 时间紧，直飞。'), fauxToolCall('dispatch_drone', { droneId: 'D-1', signalId: 'S-01', route: 'direct' })]),
        (context) =>
          toolUse([
            fauxThinking(`被拦截：${lastToolText(context.messages).slice(0, 40)}。看看绕行能少暴露多少。`),
            fauxToolCall('plot_course', { signalId: 'S-01' }),
          ]),
        toolUse([fauxText('改走绕行，再申请一次。'), fauxToolCall('dispatch_drone', { droneId: 'D-1', signalId: 'S-01', route: 'safe' })]),
        toolUse([fauxText('D-1 已出发。'), fauxToolCall('stand_by', { reason: '等待 D-1 回报' })]),
      ],
    },
  ],
};

const lesson9: LessonScript = {
  meta: meta(9, true, '关掉「修正轮」：模型只说一句话，运行就结束了，什么也没做', 'nudge'),
  seed: 1009,
  spawnSignals: 1,
  expectTools: ['stand_by'],
  steps: [
    {
      label: '模型只说话不行动',
      thinkingLevel: 'low',
      trigger: { kind: 'situation', reason: '新信号' },
      responses: [
        fauxAssistantMessage([fauxText('我认为应该先观察一下 S-01 的动向。')]),
        (context) =>
          toolUse([
            fauxThinking(`收到提醒：${lastUserText(context.messages)}`),
            fauxText('明白，按规定用工具表态。'),
            fauxToolCall('stand_by', { reason: '继续观察 S-01，倒计时还很长' }),
          ]),
      ],
    },
  ],
};

const lesson10: LessonScript = {
  meta: meta(10, true, '关掉「请求前刷新态势」：模型看到的是排队时的旧态势，漏掉刚出现的信号', 'situationRefresh'),
  seed: 1010,
  spawnSignals: 0,
  setup: { criticalSignals: 2 },
  expectTools: ['stand_by'],
  steps: [
    {
      label: '排队期间来了新信号；两个危急信号触发危机模式',
      thinkingLevel: 'low',
      trigger: { kind: 'situation', reason: '例行' },
      changeBeforeRun: 'spawn',
      responses: [
        (context, options) => {
          const situation = [...context.messages].reverse().map(textOf).find((t) => t.startsWith('【态势')) ?? '';
          const ids = [...situation.matchAll(/^- (S-\d+)/gm)].map((m) => m[1]);
          return toolUse([
            fauxThinking(`思考档位 ${options?.reasoning ?? 'off'}：两个信号生命维持遥测断续，属于危机。`),
            fauxText(`我看到 ${ids.length} 个活跃信号：${ids.join('、')}。`),
            fauxToolCall('stand_by', { reason: `态势中共有 ${ids.length} 个信号` }),
          ]);
        },
      ],
    },
  ],
};

const lesson11: LessonScript = {
  meta: meta(11, true, '把队列模式改成 one-at-a-time：连续两条插话要分两轮注入'),
  seed: 1011,
  spawnSignals: 2,
  setup: { policy: { delegation: false } },
  expectTools: ['scan_sector', 'inspect_signal', 'stand_by', 'stand_by'],
  steps: [
    {
      label: '扫描进行中，主管先插话（steer）再留一条待办（followUp）',
      thinkingLevel: 'low',
      trigger: { kind: 'situation', reason: '新信号' },
      inject: [
        { onTool: 'scan_sector', mode: 'steer', text: '先别等扫描，立刻研判 S-01 的真伪。' },
        { onTool: 'scan_sector', mode: 'followUp', text: '这一轮做完后，汇报剩余燃料。' },
      ],
      responses: [
        (context) => toolUse([fauxText('扫描 S-01 所在星区。'), fauxToolCall('scan_sector', { sector: firstUnscanned(context.messages) })]),
        (context) =>
          toolUse([
            fauxThinking(`扫描结果回来了，主管插话：${lastUserText(context.messages)}`),
            fauxText('收到插话，研判 S-01。'),
            fauxToolCall('inspect_signal', { signalId: 'S-01' }),
          ]),
        toolUse([fauxText('研判完成。'), fauxToolCall('stand_by', { reason: '已按主管要求研判 S-01' })]),
        (context) =>
          toolUse([
            fauxText(`收到待办「${lastUserText(context.messages)}」：剩余燃料见态势。`),
            fauxToolCall('stand_by', { reason: '已汇报' }),
          ]),
      ],
    },
  ],
};

const userTexts = (messages: Message[]) => messages.filter((m) => m.role === 'user').map(textOf);

const lesson12: LessonScript = {
  meta: meta(12, true, '在 convertToLlm 里不过滤 ui_note：旁白会被当成用户消息发给模型'),
  seed: 1012,
  spawnSignals: 1,
  expectTools: ['stand_by'],
  steps: [
    {
      label: '一批自定义消息：无线电、站务、UI 旁白、态势',
      thinkingLevel: 'low',
      trigger: {
        kind: 'custom',
        messages: [
          { role: 'radio', text: '这里是客船「曙光号」，主引擎失效，舱内 8 人，请求救援。' },
          { role: 'world_event', text: 'D-2 已完成例行检修，回到机库。' },
          { role: 'ui_note', text: '（旁白：这条只给界面看，模型永远看不到）' },
          { role: 'situation', text: '新信号' },
        ],
      },
      responses: [
        (context) => {
          const seen = userTexts(context.messages);
          const kinds = seen.map((t) => t.match(/^【([^】·\s]+)/)?.[1] ?? '?');
          return toolUse([
            fauxThinking(`我收到 ${seen.length} 条消息：${kinds.join('、')}。${seen.some((t) => t.includes('旁白')) ? '看到了旁白！' : '没有看到旁白。'}`),
            fauxText(`收到无线电、站务和态势（共 ${seen.length} 条）。`),
            fauxToolCall('stand_by', { reason: `已收到 ${kinds.join('、')}` }),
          ]);
        },
      ],
    },
  ],
};

const toolList = (messages: Message[]) => getCurrentTools(messages).map((t) => t.name);

const lesson13: LessonScript = {
  meta: meta(13, true, '去掉动态工具：机库受损时 dispatch_drone 仍在工具表里，模型调用后只会得到一个错误'),
  seed: 1013,
  spawnSignals: 1,
  setup: { damage: [{ module: 'hangar', status: 'damaged' }] },
  expectTools: ['stand_by', 'dispatch_drone', 'stand_by'],
  steps: [
    {
      label: '机库受损：dispatch_drone 从工具表消失，提示词里的舱段状态随之更新',
      thinkingLevel: 'low',
      trigger: { kind: 'situation', reason: '新信号' },
      responses: [
        (context) => {
          const tools = toolList(context.messages);
          const status = getCurrentSystemPrompt(context.messages)?.match(/机库：(\S+)/)?.[1] ?? '?';
          return toolUse([
            fauxText(`机库${status}；可用工具 ${tools.length} 个${tools.includes('dispatch_drone') ? '' : '，没有 dispatch_drone'}。`),
            fauxToolCall('stand_by', { reason: '机库受损，暂时无法出动' }),
          ]);
        },
      ],
    },
    {
      label: '机库修复：工具回来了',
      thinkingLevel: 'low',
      before: { repair: 'hangar' },
      trigger: { kind: 'situation', reason: '机库已修复' },
      responses: [
        (context) => {
          const status = getCurrentSystemPrompt(context.messages)?.match(/机库：(\S+)/)?.[1] ?? '?';
          return toolUse([
            fauxText(`机库${status}，dispatch_drone 回到了工具表，派 D-1 出发。`),
            fauxToolCall('dispatch_drone', { droneId: 'D-1', signalId: 'S-01' }),
          ]);
        },
        toolUse([fauxText('已出发。'), fauxToolCall('stand_by', { reason: '等待 D-1 回报' })]),
      ],
    },
  ],
};

const lesson14: LessonScript = {
  meta: meta(14, true, '关掉运行间隙压缩：上下文只增不减，只能靠视图裁剪每次临时丢掉最旧的消息', 'compaction'),
  seed: 1014,
  spawnSignals: 1,
  setup: { contextBudget: 1800 },
  expectTools: Array.from({ length: 5 }, () => ['inspect_signal', 'stand_by']).flat(),
  steps: Array.from({ length: 5 }, (_, k) => ({
    label: `第 ${k + 1} 个信号`,
    thinkingLevel: 'low' as const,
    before: k ? { spawn: 1 } : undefined,
    trigger: { kind: 'situation' as const, reason: '新信号' },
    responses: [
      (context: { messages: Message[] }) => {
        const id = [...[...context.messages].reverse().map(textOf).find((t) => t.startsWith('【态势'))!.matchAll(/^- (S-\d+)/gm)].at(-1)![1];
        const summary = context.messages.some((m) => textOf(m).startsWith('【此前经过摘要】'));
        return toolUse([
          fauxText(`研判新信号 ${id}。${summary ? '（我看到了书记员的摘要）' : ''}`),
          fauxToolCall('inspect_signal', { signalId: id }),
        ]);
      },
      (context: { messages: Message[] }) =>
        toolUse([fauxText(`${lastToolText(context.messages).slice(0, 30)}……已记录。`), fauxToolCall('stand_by', { reason: '已研判，等待下一条态势' })]),
    ],
  })),
};

const ROLE_KEY: Record<string, CrewId> = { 值班指挥官: 'commander', 领航员: 'navigator', 工程师: 'engineer', 医疗官: 'medic' };

/**
 * 多个 Agent 共用一个 faux 队列、又会并发请求时，响应的消费顺序不确定。
 * 这里把每一步都做成同一个工厂：按 system prompt 认出是谁在请求，再从该角色的脚本里取下一步。
 */
function roleScript(script: Partial<Record<CrewId, FauxResponseStep[]>>): FauxResponseStep[] {
  const cursor: Partial<Record<CrewId, number>> = {};
  const total = Object.values(script).reduce((n, l) => n + (l?.length ?? 0), 0);
  const step: FauxResponseStep = (context, options, state, model) => {
    const role = ROLE_KEY[getCurrentSystemPrompt(context.messages)?.match(/救援站的(\S+?)「/)?.[1] ?? ''];
    const list = role ? script[role] : undefined;
    const i = role ? (cursor[role] = (cursor[role] ?? -1) + 1) : 0;
    const next = list?.[i];
    if (!next) return fauxAssistantMessage(`（课程脚本里没有 ${role ?? '?'} 的第 ${i + 1} 步）`, { stopReason: 'error', errorMessage: '课程脚本耗尽' });
    return typeof next === 'function' ? next(context, options, state, model) : next;
  };
  return Array.from({ length: total }, () => step);
}

const lesson15: LessonScript = {
  meta: meta(15, true, '关掉委派：指挥官看不见监控与体征，只能让调度器把值班任务直接派给专家，失去统筹', 'delegation'),
  seed: 1015,
  spawnSignals: 1,
  setup: { damage: [{ module: 'hangar', status: 'damaged', incident: { kind: 'fire', cell: 'C2' } }], patient: true },
  expectUnordered: true,
  expectTools: ['delegate', 'delegate', 'delegate', 'inspect_signal', 'report_back', 'inspect_camera', 'vent_section', 'repair_module', 'report_back', 'assess_survivors', 'read_vitals', 'prepare_medbay', 'report_back', 'stand_by'],
  steps: [
    {
      label: '多线告急：一个回复里并行委派三名专家',
      thinkingLevel: 'low',
      approvals: ['approve'],
      trigger: { kind: 'custom', messages: [{ role: 'world_event', text: '多线告急：S-01 待研判；机库高温告警；伤员组 P-01 已接回。请统筹。' }] },
      responses: roleScript({
        commander: [
          toolUse([
            fauxThinking('三件事互不依赖，而且都需要看图：并行委派。'),
            fauxText('三线并行：星梭研判 S-01，铆钉处置机库，白鸽评估 P-01。'),
            fauxToolCall('delegate', { crew: 'navigator', task: '研判 S-01 的真伪' }),
            fauxToolCall('delegate', { crew: 'engineer', task: '机库高温告警，诊断并处置' }),
            fauxToolCall('delegate', { crew: 'medic', task: '评估伤员组 P-01，只收治危急成员' }),
          ]),
          (context) =>
            toolUse([
              fauxText(`三份报告已到：${context.messages.filter((m) => m.role === 'toolResult').slice(-3).map((m) => textOf(m).split('\n')[0].replace(/^[^：]*：/, '')).join(' / ')}`),
              fauxToolCall('stand_by', { reason: '三线均已处置' }),
            ]),
        ],
        navigator: [
          toolUse([fauxToolCall('inspect_signal', { signalId: 'S-01' })]),
          (context) => toolUse([fauxToolCall('report_back', { summary: `S-01：${lastToolText(context.messages).split('：').at(-1)?.slice(0, 30)}`, findings: [lastToolText(context.messages)] })]),
        ],
        engineer: [
          toolUse([fauxText('先看监控。'), fauxToolCall('inspect_camera', { module: 'hangar' })]),
          toolUse([fauxText('C2 网格有火光，排空。'), fauxToolCall('vent_section', { module: 'hangar', cell: 'C2' })]),
          toolUse([fauxToolCall('repair_module', { module: 'hangar' })]),
          toolUse([fauxToolCall('report_back', { summary: '机库 C2 火情已排空，舱段修复完毕', findings: ['火点在 C2', '修复用时 8 秒'] })]),
        ],
        medic: [
          toolUse([fauxToolCall('assess_survivors', { patientId: 'P-01' })]),
          toolUse([fauxToolCall('read_vitals', { patientId: 'P-01' })]),
          (context) => {
            const members = (lastToolText(context.messages).match(/成员 ([\d、]+)/)?.[1] ?? '1').split('、').map(Number);
            return toolUse([fauxToolCall('prepare_medbay', { patientId: 'P-01', members: members.slice(0, 1) })]);
          },
          (context) => toolUse([fauxToolCall('report_back', { summary: lastToolText(context.messages), findings: [] })]),
        ],
      }),
    },
  ],
};

const sawImage = (context: { messages: Message[] }, model: { input: string[] }) =>
  model.input.includes('image') && context.messages.some((m) => typeof m.content !== 'string' && m.content.some((c) => c.type === 'image'));

const lesson22: LessonScript = {
  meta: meta(22, true, '打开「有图时换眼睛」：指挥官遇到图片时临时换成 flash 看图，不必委派', 'visionSwitch'),
  seed: 1022,
  spawnSignals: 1,
  expectTools: ['scan_sector', 'stand_by', 'delegate', 'scan_sector', 'report_back', 'stand_by', 'scan_sector', 'stand_by'],
  steps: [
    {
      label: '一、指挥官（纯文本模型）自己扫描：图片被降级为占位文本',
      thinkingLevel: 'low',
      policy: { delegation: false, visionSwitch: false },
      trigger: { kind: 'situation', reason: '新信号' },
      responses: roleScript({
        commander: [
          (context) => toolUse([fauxText('我先自己扫描看看。'), fauxToolCall('scan_sector', { sector: firstUnscanned(context.messages) })]),
          (context, _o, _s, model) =>
            toolUse([
              fauxText(sawImage(context, model) ? '我看到了雷达图。' : `我看不见雷达图（${model.id} 只接受文本）。`),
              fauxToolCall('stand_by', { reason: '需要能看图的船员' }),
            ]),
        ],
      }),
    },
    {
      label: '二、委派：领航员（flash）替指挥官看图',
      thinkingLevel: 'low',
      policy: { delegation: true, visionSwitch: false },
      trigger: { kind: 'situation', reason: '需要研判' },
      responses: roleScript({
        commander: [
          (context) => toolUse([fauxText('委派星梭看雷达。'), fauxToolCall('delegate', { crew: 'navigator', task: `扫描 ${firstUnscanned(context.messages)} 区，判断 S-01 真伪` })]),
          (context) => toolUse([fauxText(lastToolText(context.messages).split('\n')[0]), fauxToolCall('stand_by', { reason: '已取得专家判读' })]),
        ],
        navigator: [
          (context) => toolUse([fauxToolCall('scan_sector', { sector: lastUserText(context.messages).match(/([A-F]) 区/)?.[1] ?? 'A' })]),
          (context, _o, _s, model) =>
            toolUse([fauxToolCall('report_back', { summary: sawImage(context, model) ? `我（${model.id}）看到了雷达成像，可以判读 S-01` : '我也看不见图', findings: [] })]),
        ],
      }),
    },
    {
      label: '三、换眼睛：prepareRequest 发现上下文里有未分析的图片，这一次请求临时换成 flash',
      thinkingLevel: 'low',
      policy: { delegation: false, visionSwitch: true },
      trigger: { kind: 'situation', reason: '再看一次' },
      responses: roleScript({
        commander: [
          (context) => toolUse([fauxToolCall('scan_sector', { sector: firstUnscanned(context.messages) })]),
          (context, _o, _s, model) =>
            toolUse([
              fauxText(sawImage(context, model) ? `这一次由 ${model.id} 发出请求，我看到了雷达图。` : '还是看不见。'),
              fauxToolCall('stand_by', { reason: '已看图' }),
            ]),
        ],
      }),
    },
  ],
};

const SCRIPTS: Record<string, LessonScript> = Object.fromEntries([lesson1, lesson2, lesson3, lesson4, lesson5, lesson6, lesson7, lesson9, lesson10, lesson11, lesson12, lesson13, lesson14, lesson15, lesson22].map((l) => [l.meta.id, l]));

function meta(index: number, available: boolean, toggle: string, toggleKey?: PolicyKey): LessonMeta {
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
    toggleKey,
    available,
  };
}


export function lessonList(): LessonMeta[] {
  return ROWS.map(([index]) => SCRIPTS[`L${String(index).padStart(2, '0')}`]?.meta ?? meta(index, false, ''));
}

export function getLesson(id: string): LessonScript | undefined {
  return SCRIPTS[id];
}
