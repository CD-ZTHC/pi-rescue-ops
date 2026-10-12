# Pi Rescue Ops · 深空救援指挥舱 — 设计文档

> 版本：v0.1（设计稿，尚未编码） · 日期：2026-10-12
> 定位：一个**以学习 pi-agent-core 1.1 / pi-ai 1.1 为目的**的全新项目。每一项框架能力都必须服务于一个真实的玩法，并有一节课、一个测试与之对应；同时保证画面耐看、交互流畅。
> 技术选型（已确认）：新仓库 · Vite + React + PixiJS · 全中文界面 · GLM 系列模型（`glm-5.3` / `glm-5.3-flash`，OpenAI 兼容网关）。

---

## 目录

1. 目标与非目标
2. 实测约束：GLM 网关能力探测
3. 产品设计
4. 系统架构
5. Agent 设计
6. 世界模拟规则
7. 前端设计
8. 课程模式
9. 持久化、录制与回放
10. 错误处理与降级
11. 测试策略
12. 能力覆盖矩阵
13. 里程碑与 M1 任务拆解
14. 风险与待验证项

---

## 1. 目标与非目标

### 1.1 目标

| # | 目标 | 衡量方式 |
|---|---|---|
| G1 | 覆盖 pi-agent-core 1.1 的全部公开能力，以及 pi-ai 1.1 中与本场景相关的能力 | §12 覆盖矩阵中每一行都有「玩法 · 源文件 · 课程 · 测试」四项 |
| G2 | 把 Agent 循环本身**画出来**：Loop Inspector 是主角而非调试附件 | 学习者不看源码，也能从时间线上指出 `prepareRequest`、`beforeToolCall`、`finishTurn` 发生的位置 |
| G3 | 没有 API key 也能完整体验 | faux 离线大脑 + 录制回放，全部课程可离线运行 |
| G4 | 有 key 时使用真实 GLM 模型，并如实展示其延迟、成本与限制 | UI 中的耗时、TTFT、token、费用均来自 pi 的真实字段，不伪造 |
| G5 | 代码可读：一个能力一个文件，hook 可插拔、可单独开关 | 能力层每个文件 ≤ 200 行；hook 以策略链组合 |

### 1.2 非目标

- 不做复杂的游戏引擎、物理或寻路。世界规则刻意保持简单（§6），精力放在 Agent 与可视化上。
- 不做多人联机、账号或部署。只在本机运行，界面上有一个操作员即可。
- 不追求模型「打得好」。模型犯错本身就是教学素材：被 hook 拦截、`isError` 回传、修正轮。
- 不使用 1.1 已移除的 harness 能力（会话存储、内置 compaction 等），由本项目自行实现，这本身也是教学内容。

---

## 2. 实测约束：GLM 网关能力探测

2026-10-12 对 `.env` 中的网关（`STRATEGIC_BASE_URL`）做了两轮探测：一轮直接调用 HTTP，一轮经过 pi-ai 1.1 + pi-agent-core 1.1 的真实 `Agent` 循环。**本节结论是后续设计的硬约束。**

### 2.1 能力表

| 能力 | glm-5.3 | glm-5.3-flash | 对设计的影响 |
|---|---|---|---|
| 工具调用 | ✅ | ✅ | — |
| 单次响应内并行多工具 | ✅（3 个并行调用） | ✅ | 并行工具、并行委派都可以用真实模型演示 |
| 流式 `reasoning_content` | ✅ | ✅ | pi 能正确产出 `thinking_start/delta/end` 事件 |
| `thinking: {type:"disabled"}` | ✅ 生效 | ⚠️ 原始 HTTP 探测中被忽略，仍产生 reasoning | flash 的「关闭思考」不可靠；UI 按 `usage.reasoning` 如实显示 |
| `system` 角色 | ✅ | ✅ | — |
| `developer` 角色 | ✅ | ❌ 400「角色信息不正确」 | **必须 `supportsDeveloperRole: false`** |
| 对话中途的 system 消息 | ✅ 被遵循 | ✅ | 可以开启 `supportsMidConvoSystemMessages: true`，sections 补丁原样发送 |
| 中途通过 system 消息新增工具（`supportsMidConvoToolAdditions`） | ❌ 新工具不进入 `tools` 参数，模型看不到 | ❌ | **必须为 `false`**；关闭后 pi 会把完整工具表放进 `tools` 参数，实测动态新增的工具可以被调用 |
| 图片输入 | ❌ 400「type 参数非法，取值范围 ['text']」 | ✅ base64 data URL，≥10px（8×8 返回 1210「图片输入格式/解析错误」）；外链 http URL ❌ | **视觉研判全部交给 flash 专家**；指挥官保持纯文本，pi 自动把图片降级为占位文本（§2.5、§5.14） |
| 工具结果里的图片 | —（自动降级为占位文本） | ✅ pi 把图片拆成紧随其后的一条 user 消息发送 | 扫描、监控、体征工具可以直接返回图片（§5.4） |
| 多图对比 | — | ✅ 两帧雷达图能正确说出移动方向 | 雷达前后两帧对比判断信号漂移 |
| `logprobs` | ❌ 不返回 | ❌ | 无法基于 logprob 做分类器 → 分诊台采用**自定义 ProviderClassifier**（§5.9） |
| `usage` / `cached_tokens` | ✅ | ✅ | `usage.cacheRead` 可见，可以展示前缀缓存命中 |
| `onProviderStreamEvent` | ✅ | ✅ | 可以测 TTFT |
| `durationMs` / `usage.cost` | ✅ | ✅ | 成本由 pi-ai 按 `model.cost` 计算 |
| 并发上限 | 账户级 | 账户级 | 7 个请求同时发出时 3 个返回 429（code 1302「速率限制」），4 个并发未触发 → 全局信号量默认 **3**，M1 就要有（§2.6） |

### 2.2 实测延迟（单次请求，小上下文）

| 模型 / 思考档位 | 首 token（TTFT） | 单次响应总耗时 |
|---|---|---|
| glm-5.3 · `low` | ~12.5 s | 7–13 s |
| glm-5.3 · `off` | ~4.8 s | 5–10 s |
| glm-5.3-flash | — | 2–6 s |

**结论**：一次 Agent 运行（2–4 个请求）通常要 15–40 秒。世界节奏必须容得下这个量级（§6.1）：信号存活以分钟计，不做秒级实时对抗。

### 2.3 统一的模型声明（已验证可用的 compat 配置）

```ts
compat: {
  thinkingFormat: 'zai',               // 发送 thinking: { type: 'enabled' | 'disabled' }
  maxTokensField: 'max_tokens',
  supportsDeveloperRole: false,        // flash 不接受 developer 角色
  supportsMidConvoSystemMessages: true,
  supportsMidConvoToolAdditions: false, // 网关不支持中途工具声明
  // zaiToolStream: M1 再单独验证；未验证前保持关闭
}
```

两个模型的 `input` 声明不同，这直接决定 pi-ai 怎样处理图片：

```ts
{ id: 'glm-5.3',       input: ['text'] }           // 图片被 transformMessages 替换为「(image omitted: model does not support images)」
{ id: 'glm-5.3-flash', input: ['text', 'image'] }  // 图片以 data:image/png;base64 形式发送
```

### 2.4 关于 pi 核心行为的两点实测发现（影响实现）

1. 核心的 `createToolResultMessage` **不会**把 `structuredContent` 写进 transcript 中的 toolResult 消息，`nestedCalls` 字段也不会被填充。因此：
   - 结构化结果**只能从 `tool_execution_end` 事件的 `result.structuredContent` 获取**，由运行时事件总线保存；
   - 嵌套调用记录由应用自行收集，按 pi-ai 的 `NestedToolCalls` 类型放进 `details.nestedCalls`。
2. 模型请求失败（429/5xx）时 `agent.prompt()` **正常 resolve**，错误只体现在最后一条 assistant 消息的 `stopReason: 'error'` 与 `agent.state.errorMessage` 上。所有调用方都必须检查这两个字段，不能依赖 try/catch。

### 2.5 多模态实测（glm-5.3-flash）

先前「两个模型都不支持图片」的结论是错的：那次探测用的是 8×8 的 PNG，被网关以「图片输入格式/解析错误」拒绝。换用正常尺寸后重测（原始 HTTP + pi `Agent` 端到端各一轮）：

| 测试 | 结果 |
|---|---|
| 用户消息带图（320×240，暗底右下角一个橙色圆斑） | ✅ 回答「橙色发光圆形物体，位于右下角（约 75% 宽、70% 高）」；真实位置是 (75%, 71%) |
| 工具返回 `{ type: 'image' }`（同一张图） | ✅ pi 发出的消息序列为 `system, user, assistant, tool, user[text, image_url]`，模型正确描述了异常和位置 |
| glm-5.3 调用同一个返回图片的工具 | ✅ 不报错；pi 自动降级为占位文本，模型回答「无法查看图像内容」 |
| 两帧雷达图对比（白点从左上到右下） | ✅「沿对角线向右下方移动」 |
| 尺寸下限 | 8px ❌，10/12/16/28/64/256/1024px ✅ |
| 图片 token 开销 | 小图约 30 token；320×240 约 105 token/张；1024×1024 约 1350 token |
| 延迟 | 单图 4–12 s，与纯文本相当 |
| 外链 http URL | ❌ 1210（pi 只发 data URL，不受影响） |

**结论**：
- 视觉是 flash 专家独有的能力，正好和「指挥官用强推理模型、专家用快速多模态模型」的分工吻合，形成一个必须委派的真实理由：**指挥官看不见图，只能请专家看**。
- 图片统一由服务端渲染成 320×240 的 PNG（每张约 100 token），既够看清，又不会把上下文撑爆。
- pi-ai 的 `downgradeUnsupportedImages` 让同一段历史可以安全地在两种模型之间切换，这本身就是一节课的内容（§8 第 22 课）。
- 视频：flash 号称支持，但 pi-ai 的内容类型只有 text / image / thinking / toolCall，没有视频块，**不纳入**。

### 2.6 并发与限流实测

同一账户同时发出 7 个 flash 请求，3 个立刻返回 HTTP 429 `{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}`；改为串行后全部成功。此前 4 个并发的探测从未触发 429。因此：

- `pi/models.ts` 在 `streamFn` 外包一层**全局信号量**（默认 3，可配置），所有船员、分诊台、书记员共用；
- 排队中的请求在 Inspector 中显示为灰色的「等待配额」分段，计入 TTFT 之外；
- 429 仍可能出现（例如外部还有别的程序在用同一个 key），由 §10 的重试逻辑兜底。

---

## 3. 产品设计

### 3.1 故事

> 2187 年，「织女-7」轨道救援站。太阳风暴季，求救信号接连涌入。
> 你是夜班值守主管。手下是一支 AI 船员团队：他们会思考、会争论、会犯错，也会在你插话时调整计划。
> 燃料有限、无人机有限、医疗舱床位有限。这一班结束前，你们能把多少人带回家？

### 3.2 角色

| 角色 | 实现方式 | 默认模型 / 思考档位 | 职责 | 代表色 |
|---|---|---|---|---|
| 主管（你） | 人类操作员 | — | 插话、审批危险操作、中止、调速、单步 | 白 |
| 指挥官「北辰」 | 长期存活的 `Agent` | glm-5.3 · `low`，危机模式升到 `medium` | 统筹：分派任务、调度无人机、分配燃料，班末写报告。**看不见图片**，视觉研判必须委派 | 青 `#22d3ee` |
| 领航员「星梭」 | 子 `Agent`（作为工具被委派） | glm-5.3-flash | 扫描星区、**看雷达成像**研判信号真伪、规划航线 | 紫 `#a78bfa` |
| 工程师「铆钉」 | 子 `Agent` | glm-5.3-flash | **看舱段监控画面**诊断故障、修复舱段，处理高危电力操作 | 琥珀 `#fbbf24` |
| 医疗官「白鸽」 | 子 `Agent` | glm-5.3-flash | **读生命体征波形图**评估伤员、准备医疗舱床位 | 绿 `#34d399` |
| 分诊台 | pi-ai `classify()`（自定义 ProviderClassifier） | glm-5.3-flash | 新信号到达时自动给出严重度、紧急度、恶作剧概率 | 粉 `#f472b6` |
| 书记员 | 无工具的一次性 `Agent` | glm-5.3-flash | 上下文压缩时撰写摘要 | 灰 |
| 地面站 | 外部 MCP server（stdio 子进程） | — | 提供太空天气预报、船舶登记查询 | 蓝 `#60a5fa` |

### 3.3 核心循环

```
新信号出现 ──► 分诊台分类（概率条）──► 指挥官被唤醒（followUp / steer）
     ▲                                          │
     │                    委派（并行）领航员扫描 / 医疗官评估 / 工程师修复
     │                                          │
世界推进（无人机飞行、信号衰减、太阳耀斑）◄── 指挥官调度无人机（危险操作需主管审批）
     │
     └──► 救援结果写入通讯频道，作为 engine 反馈消息回到指挥官的上下文
```

一班默认 12 分钟（世界时间）。时间到或指挥官调用 `end_watch` 后结算：获救人数、浪费在恶作剧信号上的燃料、错失的信号，以及成本与 token 统计。

### 3.4 主管的交互手段

| 操作 | 对应的 pi 能力 | 表现 |
|---|---|---|
| 在频道里对某个船员说话 | 目标空闲时 `prompt`；运行中选择「立即插话」→ `steer()`，选择「做完再说」→ `followUp()` | 消息气泡带「插队 / 排队」标记，Inspector 中可以看到注入点 |
| 审批危险操作 | `beforeToolCall` 挂起等待决定 | 审批卡片，30 秒倒计时，超时自动否决 |
| 紧急中止 | `agent.abort()`（级联到子 Agent） | 所有泳道截断，显示 aborted |
| 单步调试 | hook 内 `await stepGate()` | 世界自动暂停，Inspector 高亮当前停住的 hook |
| 截图提问 | 把 Pixi 画面导出为 PNG，作为 `ImageContent` 随消息发给某个专家 | 输入框旁的「📷 附上态势图」；发给指挥官时 UI 提示「北辰看不到图片，将以占位文本送达」 |
| 手动执行工具 | `runToolCall()` | 工具试验台：表单由 TypeBox schema 生成，执行结果和模型调用时完全一致 |
| 调速 / 暂停 | 世界时钟 | 0.5× / 1× / 2× / 暂停 |
| 切换课程 | 加载 faux 场景 | 底部课程栏 |

### 3.5 页面布局

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ 顶栏：织女-7 · 班次 03:42/12:00 · 燃料 ▮▮▮▮▯ · 无人机 2/3 · 床位 3/4 · 获救 7 · ¥0.023 │
├──────────────────────────┬───────────────────────────────────┬──────────────────────┤
│ ① 星区态势图 (PixiJS)      │ ② Loop Inspector                   │ ③ 通讯频道            │
│  站点、6 个星区环、信号脉冲  │  每个 Agent 一组泳道；turn 为色块    │  船员消息（流式）        │
│  无人机航迹与拖尾          │  请求：思考▒ 文本█ 工具调用▓        │  思考内容可折叠          │
│  扫描波纹、耀斑危险区       │  工具：甘特条 + 进度 + 嵌套子泳道    │  审批卡片 / 分诊卡片      │
│  点击信号 → 详情卡          │  hook 菱形节点（可点开看决定）       │  主管输入框（目标 + 模式） │
│                          │  上下文水位条 + 压缩事件             │                      │
├──────────────────────────┴───────────────────────────────────┴──────────────────────┤
│ ④ 底栏：事件时间轴（可拖动回放） · 单步 ⏯ · 调速 · 课程 1–22 · 「模型看到的上下文」抽屉     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

- 三栏宽度可拖动；窄屏（< 1280px）时 ② 和 ③ 合并成标签页。
- **联动**：点击地图上的无人机 → Inspector 定位到下达该指令的工具调用 → 频道滚动到对应消息。这三处共享同一个 `toolCallId` / `correlationId`。

### 3.6 视觉语言

| 项 | 规范 |
|---|---|
| 基调 | 深空舰桥：深蓝黑底 `#060b18`，面板为半透明玻璃 `rgba(15,23,42,.72)` + 1px 青色描边，背景有轻微星尘视差 |
| 强调色 | 每个船员一个固定色（§3.2），在地图、泳道、频道三处保持一致 |
| 语义色 | 危险 `#f43f5e`、警告 `#f59e0b`、成功 `#10b981`、被阻断 `#64748b`（斜纹） |
| 字体 | 中文 `Noto Sans SC` / `HarmonyOS Sans SC`；数字与代码 `JetBrains Mono`（等宽数字，计时器不抖动） |
| 动效（Motion） | 消息入场 180ms ease-out；审批卡片入场带弹簧效果，倒计时用环形进度；中止时泳道 120ms 内收束并闪红一次 |
| 动效（Pixi） | 信号用同心脉冲，频率随紧急度变化；无人机沿贝塞尔曲线飞行并带粒子拖尾；扫描时扇形波纹；耀斑区为噪声纹理缓慢流动 |
| 无障碍 | 遵守 `prefers-reduced-motion`（关闭粒子与脉冲）；不只用颜色区分状态，同时配图标和文字 |

---

## 4. 系统架构

### 4.1 仓库结构（npm workspaces）

```
pi-rescue-ops/
├─ package.json                  workspaces: apps/*, packages/*
├─ tsconfig.base.json
├─ .env / .env.example
├─ docs/
│  ├─ design.md                  本文档
│  └─ lessons/                   每课一页讲义（M7）
├─ packages/
│  ├─ protocol/                  前后端共享类型：世界快照、WS 消息、序列化后的 AgentEvent
│  └─ lessons/                   课程定义 + faux 脚本（后端执行，前端读元数据）
├─ apps/
│  ├─ server/                    Node 26，直接运行 .ts
│  │  └─ src/
│  │     ├─ main.ts
│  │     ├─ config.ts
│  │     ├─ world/               单写者世界：sim.ts · rules.ts · spawner.ts · rng.ts
│  │     │  └─ render/           零依赖光栅化 + PNG 编码：png.ts · raster.ts · radar.ts · camera.ts · vitals.ts（§5.14）
│  │     ├─ pi/                  ★ pi 能力层（一个能力一个文件）
│  │     │  ├─ models.ts         GLM provider + compat + 模型类型注册 + faux 切换
│  │     │  ├─ classifier-glm.ts 自定义 ProviderClassifier（§5.9）
│  │     │  ├─ messages.ts       CustomAgentMessages 声明合并 + convertToLlm
│  │     │  ├─ prompts.ts        system sections 构造
│  │     │  ├─ context.ts        transformContext（视图裁剪）
│  │     │  ├─ compaction.ts     运行间隙压缩 + 溢出恢复
│  │     │  ├─ hooks/            compose.ts · step-gate.ts · approval.ts · budget.ts · stale.ts · audit.ts · redact.ts · terminate.ts
│  │     │  ├─ turn-policy.ts    finishTurn + prepareNextTurnWithContext + prepareRequest
│  │     │  ├─ tools/            commander.ts · navigator.ts · engineer.ts · medic.ts · delegate.ts · codemode.ts · ground-station.ts
│  │     │  ├─ crew.ts           CrewMember：组装 Agent 与全部 hook
│  │     │  ├─ triage.ts         classify() 调用与结果映射
│  │     │  ├─ stateless-judge.ts  agentLoop 低层 API 示例
│  │     │  ├─ observe.ts        subscribe → 运行记录；onProviderStreamEvent → TTFT
│  │     │  └─ telemetry.ts      pi-telemetry schema + streamFn 包装
│  │     ├─ runtime/
│  │     │  ├─ bus.ts            有序事件总线（单调 seq）
│  │     │  ├─ dispatcher.ts     世界事件 → prompt / steer / followUp（§4.4）
│  │     │  ├─ operator.ts       插话、审批、中止、单步、工具试验台
│  │     │  ├─ journal.ts        JSONL 落盘
│  │     │  ├─ recorder.ts       录制模型响应
│  │     │  ├─ replayer.ts       faux 回放
│  │     │  └─ ws.ts             WebSocket 服务
│  │     └─ test/
│  ├─ ground-station/            MCP server（@modelcontextprotocol/sdk，stdio）
│  └─ web/                       Vite + React 19 + PixiJS 8 + Tailwind 4 + Motion + Zustand
│     └─ src/
│        ├─ app/                 布局、顶栏、底栏
│        ├─ scene/               Pixi 场景（@pixi/react）
│        ├─ inspector/           Loop Inspector（SVG 泳道）
│        ├─ comms/               通讯频道、审批卡片、分诊卡片
│        ├─ studio/              工具试验台、上下文抽屉
│        ├─ lessons/             课程栏与讲义面板
│        ├─ store/               Zustand：world / runs / comms / ui
│        └─ net/                 WS 客户端，断线重连后按 seq 补发
└─ recordings/                   精选录制（入库）；*.local.jsonl 不入库
```

### 4.2 依赖（版本精确锁定）

| 包 | 版本 | 用于 |
|---|---|---|
| `@earendil-works/pi-agent-core` | 1.1.0 | 核心 |
| `@earendil-works/pi-ai` | 1.1.0 | 模型、分类器、faux |
| `@earendil-works/pi-codemode` | 1.1.0 | 指挥官的脚本工具 |
| `@earendil-works/pi-mcp` | 1.1.0 | 地面站客户端 |
| `@earendil-works/pi-telemetry` | 1.1.0 | span 视图 |
| `typebox` | 1.3.27 | 与 pi 保持同版本 |
| `ws` | 8.22.0 | WebSocket |
| `@modelcontextprotocol/sdk` | 1.32.1 | 只用于 ground-station 服务端 |
| `react` / `react-dom` | 19.3.0 | — |
| `pixi.js` / `@pixi/react` | 8.22.0 / 8.0.5 | — |
| `vite` | 8.3.4 | — |
| `tailwindcss` | 4.3.3 | — |
| `motion` | 14.1.0 | — |
| `zustand` | 5.0.15 | — |

Node 运行时为 26.11.x（mise 锁定），后端用 Node 原生的 TS 类型剥离直接运行，不需要构建步骤。

### 4.3 运行时数据流

```
             ┌──────────── World（单写者，1 Hz tick）────────────┐
             │ 信号 · 无人机 · 舱段 · 资源 · 危险区                 │
             └──▲───────────────────────┬───────────────────────┘
     enqueue(cmd)│  只有工具 execute 能入队   │ world.events
                 │                        ▼
┌────────────────┴──────┐   wake/steer/followUp   ┌───────────────────────┐
│ Crew（pi Agent × 4）    │◄────────────────────────│ Dispatcher             │
│ hooks · tools · 子 Agent│                         │ 世界事件 → 唤醒策略       │
└───────┬────────────────┘                         └───────────────────────┘
        │ AgentEvent（subscribe）
        ▼
┌────────────────────────┐   seq 有序   ┌──────────┐   WS   ┌──────────┐
│ Bus（事件总线）          │────────────►│ Journal  │        │  Web UI  │
│ AgentEvent + 应用事件     │─────────────────────────────────►│          │
└────────────────────────┘             └──────────┘        └────┬─────┘
        ▲                                                       │
        └──────────── operator 指令（插话 / 审批 / 中止 / 单步 / 试验台）◄──┘
```

**单写者原则**：只有 World 能修改世界状态。工具的 `execute` 先调用 `world.preview(cmd)`（纯函数校验），通过后再 `world.enqueue(cmd)`，在下一个 tick 生效。工具返回的 `structuredContent` 是「已受理」回执，而不是「已发生」的事实；真正发生的事以世界事件形式写入频道。

### 4.4 唤醒策略：直接使用 pi 的队列，不另写调度器

指挥官是一个长期存活的 `Agent`。世界事件到达时：

| 指挥官状态 | 事件紧急度 | 动作 |
|---|---|---|
| 空闲 | 任意 | `agent.prompt([situation 消息])` |
| 运行中 | 紧急（分诊为「危急」、耀斑来袭、主管选择「立即插话」） | `agent.steer(msg)`：本 turn 的工具全部执行完后注入 |
| 运行中 | 普通 | `agent.followUp(msg)`：运行即将结束时注入，自动开始下一轮 |

`steeringMode` 和 `followUpMode` 默认都是 `"all"`（事件合批）；第 11 课会切换成 `"one-at-a-time"` 来对比两者差异。`peekQueuedMessages()` 的结果显示在泳道末尾的「队列」徽章里。

这样，「项目没有自己的调度器，调度完全依靠 pi 的 steer / followUp 语义」本身就成了一个学习点。

### 4.5 WebSocket 协议（`packages/protocol`）

```ts
// 服务端 → 浏览器。所有消息共享一个单调递增的 seq；断线后用 ?since=seq 补发
type ServerMsg =
  | { t: 'hello'; seq: number; world: WorldSnapshot; crew: CrewView[]; lesson?: LessonMeta }
  | { t: 'world'; seq: number; tick: number; patch: WorldPatch }
  | { t: 'agent'; seq: number; agentId: CrewId; runId: string; parentToolCallId?: string; at: number; ev: WireAgentEvent }
  | { t: 'app'; seq: number; at: number; ev: AppEvent };

// pi 的 AgentEvent 原样转发，只做两处处理：
// 1) message_update 按 50ms 合批成 { type: 'message_update_batch', deltas: [...] }
// 2) 剥离不可序列化字段（AbortSignal 等）
type WireAgentEvent = AgentEvent | { type: 'message_update_batch'; deltas: AssistantMessageEvent[] };

type AppEvent =
  | { kind: 'hook'; agentId; runId; hook: 'prepareRequest' | 'beforeToolCall' | 'afterToolCall' | 'finishTurn' | 'prepareNextTurn' | 'transformContext'; decision: unknown; durationMs: number }
  | { kind: 'approval.requested'; approvalId; agentId; toolCallId; tool; args; risk; expiresAt }
  | { kind: 'approval.resolved'; approvalId; decision: 'approve' | 'deny' | 'timeout' }
  | { kind: 'step.paused'; agentId; at: HookName; detail }
  | { kind: 'triage'; signalId; result: ClassifierResult; samples: number }
  | { kind: 'compaction'; agentId; beforeTokens; afterTokens; summary }
  | { kind: 'request.meta'; agentId; runId; ttftMs; providerEvents; model; thinkingLevel }
  | { kind: 'queue'; agentId; queued: number; mode: 'steer' | 'followUp' }
  | { kind: 'context.view'; agentId; systemPrompt: string; tools: string[]; messages: unknown[] } // 按需请求
  | { kind: 'world.event'; ... };

// 浏览器 → 服务端
type ClientMsg =
  | { t: 'operator.say'; target: CrewId; text: string; mode: 'auto' | 'steer' | 'followUp' }
  | { t: 'approval.decide'; approvalId: string; decision: 'approve' | 'deny'; note?: string }
  | { t: 'run.abort'; target: CrewId | 'all' }
  | { t: 'step.set'; enabled: boolean } | { t: 'step.next' }
  | { t: 'world.speed'; speed: 0 | 0.5 | 1 | 2 }
  | { t: 'tool.invoke'; agentId: CrewId; tool: string; args: unknown }   // runToolCall
  | { t: 'context.request'; agentId: CrewId }
  | { t: 'lesson.load'; lessonId: string; mode: 'faux' | 'live' }
  | { t: 'replay.load'; file: string };
```

---

## 5. Agent 设计

### 5.1 CrewMember：一个船员的完整组装

```ts
// apps/server/src/pi/crew.ts（示意）
export function createCrewMember(spec: CrewSpec, deps: CrewDeps): CrewMember {
  const agent = new Agent({
    initialState: {
      systemPrompt: renderBaseSections(spec),       // mission / rules / tools_guide
      model: deps.models.chat(spec.model),
      thinkingLevel: spec.thinkingLevel,
      tools: spec.tools(deps),
    },
    streamFn: withTelemetry(deps.models.streamSimple, deps.telemetry, spec.id),
    convertToLlm,                                    // messages.ts
    transformContext: viewTrim(spec.contextBudget), // context.ts
    sessionId: `${deps.missionId}:${spec.id}`,
    toolExecution: 'parallel',
    steeringMode: 'all', followUpMode: 'all',
    beforeToolCall: composeBefore(stepGate, staleGuard, budgetGuard, dangerApproval),
    afterToolCall: composeAfter(audit, redact, terminateOnCommit),
    prepareRequest: situationRefresher(spec, deps),  // 刷新态势 + 危机模式切换
    finishTurn: turnBudget(spec.maxRequestsPerRun),
    prepareNextTurnWithContext: nudgeIfNoAction,
    onProviderStreamEvent: ttftProbe,                // 必须同步、轻量
    maxRetryDelayMs: 8_000,
  });
  agent.subscribe(observe(spec.id, deps.bus));       // agent_end 时 await 落盘
  return { spec, agent, ... };
}
```

**原则**：hooks 都是独立的纯策略，通过 `compose*` 组合起来。每个课程只启用自己要讲的那一个 hook，其余替换成 no-op，从而做到能力隔离。

### 5.2 自定义消息（`CustomAgentMessages` 声明合并）

```ts
declare module '@earendil-works/pi-agent-core' {
  interface CustomAgentMessages {
    situation:   { role: 'situation'; tick: number; brief: SituationBrief; reasons: string[]; timestamp: number };
    radio:       { role: 'radio'; signalId: string; transcript: string; timestamp: number };
    world_event: { role: 'world_event'; kind: string; text: string; correlationId?: string; timestamp: number };
    operator:    { role: 'operator'; text: string; urgency: 'steer' | 'followUp' | 'prompt'; timestamp: number };
    compaction:  { role: 'compaction'; summary: string; replacedCount: number; timestamp: number };
    ui_note:     { role: 'ui_note'; text: string; timestamp: number };  // 只给 UI，永远不发给模型
  }
}
```

`convertToLlm` 的映射规则：

| 消息 | 发给模型的形式 |
|---|---|
| `situation` | **只有最新一条**完整渲染为 user 文本「【态势 T+03:42】…」；旧的只保留一行「【旧态势 T+02:10，原因：新信号】」 |
| `radio` | user 文本「【无线电 · 信号 S-07】…」 |
| `world_event` | user 文本「【站务】无人机 D-2 已抵达 S-07，救出 3 人」 |
| `operator` | user 文本「【主管 · 插话】…」 |
| `compaction` | user 文本「【此前经过摘要】…」 |
| `ui_note` | 过滤掉 |

前端「模型看到的上下文」抽屉会并排显示 `agent.state.messages` 和 `convertToLlm` 之后的结果，让学习者直观看到转换前后的差别。

### 5.3 System prompt 分段（sections）与动态工具

首条 system 消息声明这些 section，顺序为「稳定在前，易变在后」，以利于前缀缓存：

| section | 内容 | 何时替换 |
|---|---|---|
| `mission` | 角色使命、口吻（全中文） | 不变 |
| `rules` | 资源规则、危险操作定义 | 不变 |
| `tools_guide` | 工具使用建议 | 不变 |
| `station_status` | 舱段状态（传感器 / 机库 / 医疗舱 / 通讯） | 舱段损坏或修复时 |
| `watch_phase` | 班次阶段（平稳 / 风暴 / 危机 / 交班） | 阶段变化时 |

替换方式：在下一次 `prompt`、`steer` 或 `followUp` 的消息批次前面插入一条 `{ role: 'system', content: '', sections: { station_status: '…' } }`。

**动态工具**：舱段状态变化时修改 `agent.state.tools`。例如机库损坏时移除 `dispatch_drone`，传感器修复后领航员重新获得 `scan_sector`。pi 会在下一次请求前自动检测工具差异并写入一条 system 消息；按 §2.3 的配置，完整工具表会通过 `tools` 参数发送，实测有效。

### 5.4 工具清单

记号说明：**P** = parallel，**S** = sequential；**⚠** = 危险操作，需要审批；**⏹** = 成功后 `terminate`；**OS** = 声明了 `outputSchema`；**↻** = 通过 `onUpdate` 流式汇报进度；**IMG** = 结果中包含图片。

| 船员 | 工具 | 模式 | 标记 | 说明 |
|---|---|---|---|---|
| 指挥官 | `delegate`（`{ crew, task }`） | P | OS ↻ | 委派给子 Agent，子 Agent 的事件经 `onUpdate` 冒泡上来（§5.7） |
| 指挥官 | `dispatch_drone`（`{ droneId, signalId, route }`） | S | OS ⚠* | 进入耀斑区时（*）需要审批；燃料不足时被 `budgetGuard` 拦截 |
| 指挥官 | `allocate_fuel` | S | OS | 预留燃料 |
| 指挥官 | `run_script`（codemode） | S | OS | 用脚本组合只读工具（§5.8） |
| 指挥官 | `query_ground_station` | P | — | MCP 工具，从地面站动态导入（§5.10） |
| 指挥官 | `end_watch` | S | OS ⏹ | 交班并提交报告 |
| 指挥官 | `stand_by` | S | ⏹ | 本轮无需行动 |
| 领航员 | `scan_sector` | P | OS ↻ IMG | 每次扫描 3–6 秒，逐段回报进度；返回雷达成像。传感器损坏时该工具被移除 |
| 领航员 | `compare_frames` | P | IMG | 返回同一信号相隔 30 秒的两帧雷达图，用于判断漂移方向（恶作剧信标通常静止） |
| 领航员 | `inspect_signal` | P | OS | 返回真实度线索 |
| 领航员 | `plot_course` | P | OS | 返回航线与风险 |
| 领航员 | `report_back` | S | OS ⏹ | 子 Agent 统一的交付工具 |
| 工程师 | `diagnose_module` | P | OS | 只返回读数，不含画面 |
| 工程师 | `inspect_camera` | P | IMG | 舱段监控画面：火点、烟雾、破口的位置只能从图中看出 |
| 工程师 | `repair_module` | S | OS ↻ | 长任务，按秒回报进度 |
| 工程师 | `vent_section` | S | ⚠ | 排空舱段以灭火，有人员风险 |
| 工程师 | `report_back` | S | OS ⏹ | — |
| 医疗官 | `assess_survivors` | P | OS | 伤员人数与分级（文本） |
| 医疗官 | `read_vitals` | P | OS IMG | 生命体征波形图（心电、血氧）；危急伤员只能从波形异常看出 |
| 医疗官 | `prepare_medbay` | S | OS | 医疗舱修复后才出现 |
| 医疗官 | `report_back` | S | OS ⏹ | — |

**失败约定**：业务失败（目标已失效、资源不足等）一律返回 `isError: true`，并附带 `details` 和 `structuredContent` 供 UI 渲染，例如部分扫描结果；只有程序缺陷才 `throw`。

**视觉工具约定**：`content` = 一行不泄露真相的文字说明 + 一张 `image`；`structuredContent` 只放 UI 需要的元数据（图片哈希、帧时间），**不放真相**，否则 UI 就替模型作弊了。

**两份结果**：`content` 是给模型看的简短中文文本，`structuredContent` 是给 UI 渲染富卡片的数据（扫描雷达图、生命体征条等）。

### 5.5 Hook 策略链

```
beforeToolCall: stepGate → staleGuard → budgetGuard → dangerApproval
afterToolCall:  audit → redact → terminateOnCommit
```

| 策略 | 行为 | 返回值 |
|---|---|---|
| `stepGate` | 单步模式下暂停世界，发出 `step.paused`，`await` 主管点击「下一步」；同时监听 `signal`，中止时立即返回 | `undefined` |
| `staleGuard` | 目标信号已失效、已获救或已被锁定时拦截 | `{ block: true, reason: '信号 S-07 已失联' }` |
| `budgetGuard` | 燃料或无人机不足时拦截；本轮请求数达到上限时附带 `terminate` | `{ block, reason, terminate? }` |
| `dangerApproval` | 遇到 ⚠ 工具时发出 `approval.requested`，`await` 主管决定，30 秒超时视为否决 | 否决时返回 `{ block: true, reason: '主管否决：…' }` |
| `audit` | 为结果附上 `correlationId`、规则版本和执行耗时 | `{ details }` |
| `redact` | 把地面站返回结果中的「船员个人信息」字段打码，模型只看到打码后的版本；UI 中可切换查看原文 | `{ content, structuredContent }`（两者一起返回，避免 `structuredContent` 被丢弃） |
| `terminateOnCommit` | 提交型工具成功时统一补上 `terminate: true` | `{ terminate: true }` |

每个策略执行后都向总线发出 `hook` 应用事件（包含决定与耗时），Inspector 据此画出菱形节点。

### 5.6 回合策略：`finishTurn` / `prepareNextTurnWithContext` / `prepareRequest`

- **`finishTurn`**：
  1. 如果最后一条 assistant 消息的 `stopReason` 是 `error` 或 `aborted`，返回 `undefined`（错误由运行时统一处理）；
  2. 本轮请求数达到 `maxRequestsPerRun`（指挥官 6，子 Agent 4）时返回 `{ action: 'end' }`；
  3. 模型只输出了文字、没有调用任何工具，且仍有预算时，返回 `{ action: 'continue' }`。
- **`prepareNextTurnWithContext`**：配合上面第 3 条，追加一条 `world_event`：「请用工具行动；如果无需行动，请调用 stand_by」。
- **`prepareRequest`**：
  1. 把最新那条 `situation` 消息的 `brief` 刷新为**请求时刻**的世界快照（排队期间世界已经变化）；
  2. 存在 2 个以上危急信号时进入**危机模式**，返回 `{ thinkingLevel: 'medium' }`；危机解除后恢复 `low`；
  3. 在第 10 课中，还演示通过 `{ model }` 临时切换成 glm-5.3-flash 以降低延迟。

### 5.7 子 Agent 委派（Agent 作为工具）

```ts
// tools/delegate.ts（示意）
execute: async (toolCallId, { crew, task }, signal, onUpdate) => {
  const child = deps.crew.get(crew);
  if (child.agent.state.isStreaming) {        // 子 Agent 正忙：把新任务插进它当前的运行
    child.agent.steer(operatorMsg(task));
    return await child.nextReport(signal);
  }
  const off = child.agent.subscribe((ev) => onUpdate?.({ content: [], details: { childEvent: wire(ev), crew } }));
  const onAbort = () => child.agent.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await child.agent.prompt(taskMessage(task));
    const report = child.lastReport();        // 来自 report_back 的 structuredContent
    if (!report) return { content: [text(`${crewName} 未交付报告`)], details: {}, isError: true };
    return { content: [text(report.summary)], details: { report }, structuredContent: report };
  } finally { off(); signal?.removeEventListener('abort', onAbort); }
}
```

- 指挥官可以**在同一个响应里并行委派**三名专家。Inspector 中，`delegate` 工具条会展开成三条嵌套的子泳道。
- 中止会级联：主管中止指挥官时，`signal` 传递到所有子 Agent。
- 主管也可以直接在频道里对专家说话，同样走 `prompt` / `steer` / `followUp`。

### 5.8 Codemode：`run_script`

- 沙箱里提供的工具：`list_signals`、`inspect_signal`、`sector_hazard`、`fuel_estimate`、`drone_eta`（全部只读）。
- **与 pi-codemode README 示例的关键区别**：沙箱工具不直接调用 `tool.execute()`，而是通过 **`runToolCall()`** 执行，并传入指挥官自己的 `beforeToolCall` / `afterToolCall`。这样嵌套调用同样受单步、过期检查、审计等策略约束。
- 每个嵌套调用都按 pi-ai 的 `NestedToolCallRecord` 结构收集到 `details.nestedCalls`。核心不会填充这个字段（§2.4），这是应用层必须自己完成的工作，也会在课程中讲到。
- UI 展示带语法高亮的脚本、嵌套调用树、`text()` 输出，以及返回值。
- 沙箱限制：`timeoutMs: 15_000`，`memoryLimitBytes: 32 MiB`；脚本可以用 `store` / `load` 在一个班次内保存跨次运行的笔记。

### 5.9 分诊台：自定义 ProviderClassifier

网关不返回 logprobs，pi-ai 内置的 `llama-cpp-classify` 等实现都用不了。因此在 GLM provider 上注册一个自定义分类器 API：

```ts
createProvider({
  id: 'glm', ...,
  models: [chatModels..., { type: 'classifier', id: 'glm-5.3-flash-triage', api: 'glm-tool-classify', ... }],
  api: openAICompletionsApi(),
  classifiers: { 'glm-tool-classify': glmToolClassifier({ samples: 3 }) },
});
```

`glmToolClassifier` 的实现思路：

1. 把 `ClassifierContext.questions` 编译成一个工具 schema：choice 问题对应枚举，score 问题对应 0..n-1 的整数，bool 问题对应布尔值；
2. 用 glm-5.3-flash **并行采样 k 次**（默认 3 次，可配置），强制模型调用这个工具；
3. 用 k 次结果的**经验分布**作为概率；`confidence` 取最高票的占比；
4. 汇总 k 次的 `usage`；错误时返回 `stopReason: 'error'`，绝不 reject，与 pi-ai 的约定一致。

UI 上的概率条会明确标注「采样估计（k=3）」，与基于 logprob 的分类器区分开。第 18 课会对比 k=1 和 k=5 时概率的稳定性。

问题集合：

```ts
questions: {
  severity: { type: 'choice', instructions: '判断事故严重度', criteria: { minor: '轻微', serious: '严重', critical: '危急' } },
  urgency:  { type: 'score',  instructions: '多久内必须赶到', criteria: ['十分钟以上', '五到十分钟', '五分钟内', '立即'] },
  hoax:     { type: 'bool',   instructions: '这是否为恶作剧或诱饵信号', criteria: { true: '可疑', false: '可信' } },
}
```

### 5.10 地面站：MCP

- `apps/ground-station` 是一个独立的 stdio MCP server，提供 `space_weather_forecast`（耀斑预报）、`ship_registry_lookup`（船舶登记，包含需要打码的个人信息字段）、`station_manual_search` 三个工具。
- 服务端通过 `pi-mcp` 的 `StdioTransport` 启动它，`listTools()` 后转换成 `AgentTool`（`toLlmContent`，`isError` 透传），并挂到指挥官身上。
- 地面站支持 `tools/list_changed` 通知：例如「天气卫星上线」时会新增工具，指挥官的工具栏随之动态变化，再配合 §5.3 的动态工具机制。
- 测试使用 `pi-mcp/testing` 的 `createInMemoryTransportPair()`。

### 5.11 上下文管理

| 层次 | 时机 | 做法 |
|---|---|---|
| 视图裁剪（`transformContext`） | 每次请求前 | 不修改原始消息：**永远保留全部 system 消息**；旧的 `situation` 折叠成一行；裁剪时从完整的 toolCall/toolResult 对边界开始。返回的是一个新数组 |
| 持久压缩（`compaction.ts`） | `agent_end` 的 awaited 监听器中（运行间隙） | 估算的 token 数超过预算（默认 24k）时，请书记员把最老的一段对话写成摘要，替换为一条 `compaction` 消息，直接修改 `agent.state.messages` |
| 溢出恢复 | 运行结束时检测到 `isContextOverflow(lastAssistant)` | 强制执行压缩，然后 `agent.continue()` |

图片额外一条规则：`transformContext` 只保留每个船员**最近 2 张**图片，更早的替换为文本「[图像已折叠：〈当时那条回复的首句结论〉]」（§5.14）。

UI 中的上下文水位条显示「估算 token / 上下文预算」以及最近一次请求的 `usage.input` 和 `usage.cacheRead`。压缩时播放一段「信息被折叠」的动画。

### 5.12 低层 API：`agentLoop`

`stateless-judge.ts` 用 `agentLoop()` 实现一个**无状态**的「班末评审」：输入整班的事件摘要，输出一份评分。它与基于 `Agent` 的书记员形成对照，在第 20 课中演示：

- 低层事件流是「观察性」的，不会等待监听器处理完成；
- `Agent` 则会在 `message_end` 处形成屏障，所以 `beforeToolCall` 看到的状态里已经包含了发起调用的那条 assistant 消息。

### 5.13 观测

| 数据 | 来源 |
|---|---|
| TTFT | `onProviderStreamEvent` 收到首个 provider 事件的时间减去请求开始时间（回调里只记一个时间戳） |
| provider 原始事件计数 | 同上；在第 21 课中可以展开查看原始 chunk |
| 单次请求耗时 | `AssistantMessage.durationMs` |
| 实际思考档位 | `AssistantMessage.thinkingLevel` |
| 工具耗时 | `tool_execution_end.durationMs` |
| token 与费用 | `usage.input / output / reasoning / cacheRead`，`usage.cost.total` |
| span 树（可选视图） | pi-telemetry：`defineTelemetrySchema` 定义 `rescue.run → rescue.request → rescue.tool → rescue.world_apply`。用包装后的 `streamFn` 把 `telemetryContext` 传给 pi-ai，由 `InMemoryTelemetryContext` 收集 |

### 5.14 视觉链路

```
world 快照 ──► render/*.ts（确定性光栅化，seed + tick → 同一张图）──► PNG base64
     ──► 工具结果 content: [text, image] ──► pi-ai openai-completions
           ├─ flash（input 含 image）：拆成「Attached image(s) from tool result:」user 消息
           └─ glm-5.3（纯文本）：transformMessages 替换为占位文本
```

- **服务端渲染**：`render/png.ts` 自己实现 PNG 编码（`zlib.deflateSync` + CRC32，约 40 行），`raster.ts` 提供圆、线、矩形、噪声等基本图元。不依赖 canvas 原生模块，Node 26 直接运行，图片随 seed 完全可复现，faux 回放和测试可以对图片做哈希断言。
- **三种图**：
  - 雷达成像 `radar.ts`：极坐标网格；真实遇险船有「热斑 + 碎片尾迹」，恶作剧信标只有一个干净的亮点；耀斑区叠加噪声带，增加误判可能；
  - 舱段监控 `camera.ts`：俯视舱段平面图，火点（橙）、烟雾（灰色团块）、破口（黑色缺口）画在真实位置；
  - 体征波形 `vitals.ts`：心电与血氧曲线，危急伤员表现为心律不齐或血氧持续下降。
- **图里有、文字里没有**：每种图都携带一条文本中刻意不给出的真相，让「委派给能看图的专家」成为必要，而不是摆设。
- **主管截图**：前端用 Pixi 的 `renderer.extract.base64()` 导出当前态势图，经 WS 发给后端，作为 `ImageContent` 附在 operator 消息上。
- **动态换模型（第 22 课的对比开关）**：在 `prepareRequest` 中检测本轮上下文是否有未被分析的图片；若当前模型是纯文本，就临时切到 flash 发这一次请求。默认关闭，用来对比「委派」和「换眼睛」两种做法。
- **成本可见**：Inspector 的请求分段上标出图片张数和估算 token。

---

## 6. 世界模拟规则

### 6.1 时间

- 1 tick = 1 秒世界时间，默认速率 1×，可调为 0.5× / 2× / 暂停；单步模式下自动暂停。
- 一班 12 分钟（720 tick）。
- 信号的存活倒计时为 180–420 秒。参照 §2.2 的实测延迟，指挥官通常有 4–10 次决策机会。

### 6.2 实体

| 实体 | 关键字段 |
|---|---|
| 站点 | 4 个舱段：传感器、机库、医疗舱、通讯。每个舱段状态为 `ok` / `damaged` / `offline`，耀斑可能造成损坏 |
| 星区 | A–F 共 6 个，环绕站点排布；危险度会随耀斑变化 |
| 信号 | `id`、星区、类型（客船 / 矿船 / 科考船 / 信标）、幸存者人数、倒计时，以及**隐藏真相**（是否恶作剧、真实严重度）。真相只能通过 `inspect_signal` 或扫描逐步揭示；其中「热信号特征」**只画在雷达成像里** |
| 无人机 | 3 架；状态为 `docked` / `outbound` / `returning`；有位置、航线和载员 |
| 资源 | 燃料 100（出动一次消耗 8–20，进入耀斑区翻倍）；医疗舱床位 4 |

### 6.3 规则

- 信号每 40–90 秒生成一个（使用带种子的随机数，可复现），约 15% 是恶作剧。
- 无人机抵达真实信号时救出幸存者；危急伤员需要医疗舱有床位，否则损失一部分。
- 耀斑每 3–5 分钟出现一次：提前 60 秒发出预警（地面站可以更早预报），可能损坏舱段，耀斑区内的无人机会受损。
- **结算**：获救人数 ×10，恶作剧消耗的燃料 −1/点，错失的真实信号 −15。

### 6.4 确定性

世界只依赖 `seed` 和输入的命令序列。录制时保存命令序列与模型响应，回放时世界可以逐 tick 精确复现（§9）。

---

## 7. 前端设计

### 7.1 状态管理（Zustand，按 slice 划分）

| slice | 内容 | 更新来源 |
|---|---|---|
| `world` | 快照 + 补丁 | `t: 'world'` |
| `runs` | 按 `agentId → runId → turns[]` 组织的运行模型（§7.2） | `t: 'agent'`、`hook`、`request.meta` |
| `comms` | 频道消息、审批卡、分诊卡 | 由 `agent` 和 `app` 事件派生 |
| `ui` | 选中项、联动焦点、面板宽度、课程、单步状态 | 本地 |

高频的 `message_update_batch` 先写入一个可变缓冲区，再按 `requestAnimationFrame` 刷新到 store，避免每个 token 都触发一次 React 渲染。

### 7.2 Loop Inspector 数据模型与渲染

```ts
interface RunView {
  agentId; runId; startedAt; endedAt?; outcome?: 'ok' | 'error' | 'aborted';
  turns: TurnView[]; queue: { steer: number; followUp: number };
}
interface TurnView {
  index; hooks: HookMark[];  // prepareRequest / finishTurn / prepareNextTurn
  request: { start; ttftMs?; end?; durationMs?; model; thinkingLevel; segments: Array<{ kind: 'thinking' | 'text' | 'toolcall'; start; end }>; usage? };
  tools: ToolView[];
}
interface ToolView {
  toolCallId; name; start; end?; durationMs?; isError?; blocked?: { by: string; reason: string };
  updates: Array<{ at; progress? }>; children?: RunView[]; nested?: NestedToolCalls;
  hooks: HookMark[];         // beforeToolCall / afterToolCall
}
```

渲染规则（SVG，横轴为墙钟时间，可缩放和平移）：

- 每个船员一条泳道；运行（run）画成圆角容器，turn 画成其中的分段。
- 请求条内部按 `segments` 着色：思考用斜纹浅色，文本用实色，工具调用参数用点阵。TTFT 处画一条竖线。
- 工具条画在请求条下方。并行的工具纵向叠放；串行批次画成首尾相接，并标注「串行：因 xxx」。被阻断的工具画成灰色斜纹，并附上拦截原因。
- hook 用菱形节点表示：绿色 = 放行，红色 = 拦截，蓝色 = 修改了结果或参数，紫色 = continue/end 决定。悬停显示详情，点击打开侧栏。
- `delegate` 工具可以展开，内部是子 Agent 的泳道（递归渲染）。
- 运行的尾部显示队列徽章：「⤵ 插话 1」「⏭ 待办 2」。

### 7.3 Pixi 场景

- **图层**：星空背景（视差）→ 星区环与危险区（噪声着色器）→ 航线 → 信号（脉冲）→ 无人机（精灵 + 粒子拖尾）→ 选中高亮与标签。
- 使用 `@pixi/react` 声明式渲染静态结构；动画直接在 Pixi ticker 里驱动，不经过 React。
- 世界补丁到达后对位置做插值（世界 1 Hz，画面 60 fps）。

### 7.4 中文排版与文案

- 所有文案集中放在 `web/src/i18n/zh.ts`。暂时只有中文，但文案不散落在组件里。
- 时间显示为「T+03:42」，费用显示为「¥0.0231」（按 `.env` 中的汇率换算，默认按美元显示，可配置）。
- 模型输出要求全中文，在 `mission` section 中约束。

---

## 8. 课程模式

每节课的组成：

1. **faux 脚本**：确定性、零成本、可离线；
2. **讲义**：100–300 字，附源码链接；
3. 「**关掉它会怎样**」对比开关；
4. 可选「**用真实模型再跑一次**」。

课程脚本同时就是该能力的回归测试（§11）。

| # | 课程 | 能力 | 场景 |
|---|---|---|---|
| 1 | 事件流 | `prompt`、`subscribe`、事件顺序 | 指挥官回应一条态势 |
| 2 | 流式思考 | `thinking_*` 事件、`thinkingLevel`、`thinkingBudgets` | 同一问题分别用 off / low / medium |
| 3 | 工具基础 | TypeBox 校验、参数错误回传、`terminate` | 模型传了非法星区 |
| 4 | 并行与串行 | `toolExecution`、工具级 `executionMode` | 扫描 3 个星区，再混入一次 `dispatch_drone` |
| 5 | 工具流式进度 | `onUpdate`、`tool_execution_update` | 修复舱段 |
| 6 | 结构化结果 | `outputSchema`、`structuredContent`、`isError` | 扫描时部分失败 |
| 7 | 拦截与审批 | `beforeToolCall` 的 block / terminate | 无人机闯入耀斑区 |
| 8 | 结果改写 | `afterToolCall` 改写 content / structuredContent | 地面站数据打码 |
| 9 | 回合控制 | `finishTurn`、`prepareNextTurnWithContext` | 模型只说话不行动 |
| 10 | 请求前准备 | `prepareRequest` 换上下文、模型、思考档位 | 排队期间态势已变化；进入危机模式 |
| 11 | 插话与排队 | `steer`、`followUp`、队列模式、`peekQueuedMessages`、`abort` | 主管连续插话 |
| 12 | 自定义消息 | `CustomAgentMessages`、`convertToLlm` | 无线电、站务、UI 旁白 |
| 13 | 提示分段与动态工具 | system `sections`、`state.tools` 差异 | 机库损坏后修复 |
| 14 | 上下文管理 | `transformContext`、运行间隙压缩、溢出恢复 | 长班次 |
| 15 | Agent 即工具 | 子 Agent、`onUpdate` 冒泡、中止级联 | 三路并行委派 |
| 16 | 脚本编排 | `runToolCall`、pi-codemode、`nestedCalls` | 一次脚本查询 10 个信号 |
| 17 | MCP | pi-mcp、`toLlmContent`、工具列表变化 | 地面站上线新卫星 |
| 18 | 分类器 | `classify()`、自定义 ProviderClassifier、模型类型 | 采样 k=1 与 k=5 的对比 |
| 19 | 录制回放 | faux provider、响应工厂 | 回放一次真实班次 |
| 20 | 低层循环 | `agentLoop`，与 `Agent` 的屏障语义对比 | 班末评审 |
| 21 | 观测 | `onProviderStreamEvent`、TTFT、`durationMs`、费用、telemetry | 读懂一次请求的耗时构成 |
| 22 | 多模态 | `ImageContent`、`model.input`、工具结果图片、纯文本模型的自动降级、图片的上下文清理 | 指挥官看不见火点，委派工程师看监控 |

---

## 9. 持久化、录制与回放

- **Journal**：每个班次一个 `missions/<missionId>.jsonl`，按 seq 依次写入所有总线消息、世界命令和模型的完整 `AssistantMessage`。
- **会话恢复**：重启服务时可以选择加载某个班次，用 journal 中的消息重建 `agent.state.messages`。1.1 不再提供 harness 会话存储，这里自行实现，也是一个学习点。
- **录制回放**：
  - 回放器把 journal 中每个 Agent 的 `AssistantMessage` 按顺序装进 `fauxProvider().setResponses([...])`；
  - 世界使用相同的 seed，并按记录的 tick 注入主管操作；
  - 校验：回放产生的工具调用序列必须与录制时一致，不一致则报告首个分歧点。
- **精选录制**：`recordings/*.jsonl` 入库，作为离线演示与课程素材。

---

## 10. 错误处理与降级

| 情况 | 检测方式 | 处理 |
|---|---|---|
| 429（code 1302）、5xx、网络错误 | 运行结束后检查最后一条 assistant 的 `stopReason === 'error'`（不能靠 try/catch，见 §2.4） | 用 `isRetryableAssistantError` 判断可重试时，指数退避一次后 `agent.continue()`；否则把船员标为「失联」，UI 显示错误原文 |
| 上下文溢出 | `isContextOverflow` | 压缩后 `continue()` |
| 模型乱调或不调工具 | `finishTurn` 计数 | 修正轮，然后 `end` |
| 工具业务失败 | `isError` | 回传给模型，UI 显示红卡 |
| 主管中止 | `abort()` | 级联中止；世界中已受理的命令照常生效（这是事实，不回滚） |
| 子 Agent 失败 | `delegate` 返回 `isError` | 由指挥官决定是否换人或重试 |
| MCP 子进程崩溃 | transport 关闭事件 | 移除地面站工具（动态工具），通讯频道提示「地面站失联」 |
| 分类器失败 | `ClassifierResult.stopReason === 'error'` | 信号标为「未分诊」，指挥官照常被唤醒 |
| 图片被拒（1210「图片输入格式/解析错误」） | 同上，`errorMessage` 含 1210 | 不重试（重试也会失败）；记一条 bug 日志。渲染器保证图片 ≥64px，单测覆盖 |
| 没有 API key | 配置检查 | 自动进入离线模式（faux + 精选录制），顶栏显示「离线演示」 |

---

## 11. 测试策略

| 层 | 工具 | 内容 |
|---|---|---|
| 世界 | `node:test` | 规则的单元测试；同一 seed 与同一命令序列必须产生相同结果 |
| pi 能力层 | `node:test` + faux | 每个 hook、工具、消息转换都有独立测试。响应工厂可以拿到 `TranscriptContext`，用 `getCurrentSystemPrompt` / `getCurrentTools` 断言「模型此刻看到的内容」 |
| 课程 | 课程脚本即测试 | 每课断言关键事件序列；以快照方式比较 Inspector 的 `RunView` 结构 |
| 回放 | 精选录制 | 回放后工具调用序列与录制一致 |
| 协议 | 类型 + 运行时校验 | 服务端消息用 TypeBox schema 校验（只在开发模式开启） |
| 前端 | Vitest + Testing Library | store 的 reducer、`RunView` 的构建；Inspector 布局做快照测试 |
| 真实模型冒烟 | `npm run smoke:live`（手动执行） | 对 GLM 网关跑一次第 1、4、15 课；不进入 CI |

---

## 12. 能力覆盖矩阵

| 能力 | 包 | 玩法 | 文件 | 课 |
|---|---|---|---|---|
| `Agent` / `prompt` / `subscribe` | core | 全体船员 | `pi/crew.ts`、`pi/observe.ts` | 1 |
| `thinkingLevel` / `thinkingBudgets` | core | 危机模式升档 | `pi/turn-policy.ts` | 2、10 |
| TypeBox 参数校验 / `prepareArguments` | core | 星区参数容错（`"a区"` 归一化为 `"A"`） | `pi/tools/navigator.ts` | 3 |
| `toolExecution` / `executionMode` | core | 并行扫描与串行调度 | `pi/tools/*` | 4 |
| `onUpdate` / `tool_execution_update` | core | 修复与扫描进度、子 Agent 冒泡 | `pi/tools/engineer.ts`、`pi/tools/delegate.ts` | 5、15 |
| `outputSchema` / `structuredContent` / `isError` | core 1.1 | 富卡片、部分失败 | `pi/tools/*` | 6 |
| `beforeToolCall` | core | 单步、过期、预算、审批 | `pi/hooks/*` | 7 |
| `afterToolCall`（含 `structuredContent` 覆盖） | core 1.1 | 审计、打码、统一 terminate | `pi/hooks/*` | 8 |
| `terminate` | core | 提交型工具 | `pi/hooks/terminate.ts` | 3 |
| `finishTurn` / `prepareNextTurnWithContext` | core | 回合预算与修正轮 | `pi/turn-policy.ts` | 9 |
| `prepareRequest` | core | 态势刷新、切换模型和档位 | `pi/turn-policy.ts` | 10 |
| `steer` / `followUp` / 队列模式 / `peekQueuedMessages` / `clear*Queue` | core | 主管插话、事件唤醒 | `runtime/operator.ts`、`runtime/dispatcher.ts` | 11 |
| `abort` / `signal` / `waitForIdle` | core | 紧急中止与级联 | `runtime/operator.ts` | 11、15 |
| `continue()` | core | 错误重试、溢出恢复 | `pi/compaction.ts` | 14 |
| `CustomAgentMessages` / `convertToLlm` | core | 无线电、站务、UI 旁白 | `pi/messages.ts` | 12 |
| system `sections` / 动态 `state.tools` | core + ai | 舱段状态、工具增删 | `pi/prompts.ts` | 13 |
| `transformContext` | core | 视图裁剪 | `pi/context.ts` | 14 |
| `sessionId` | core | 前缀缓存（展示 `cacheRead`） | `pi/crew.ts` | 21 |
| `runToolCall` | core 1.1 | 工具试验台、codemode 嵌套调用 | `runtime/operator.ts`、`pi/tools/codemode.ts` | 16 |
| `durationMs`（工具 / 消息） | core 1.1 / ai 1.1 | Inspector 耗时 | `pi/observe.ts` | 21 |
| `onProviderStreamEvent` | core 1.1 / ai 1.1 | TTFT、原始 chunk | `pi/observe.ts` | 21 |
| `agentLoop` | core | 无状态班末评审 | `pi/stateless-judge.ts` | 20 |
| `maxRetryDelayMs` / `isRetryableAssistantError` / `isContextOverflow` | core / ai | 降级处理 | `pi/crew.ts`、`pi/compaction.ts` | 14 |
| `createProvider` / `createModels` / compat | ai | GLM 接入 | `pi/models.ts` | — |
| 模型类型 / `getModelOfType` / `isModelType` | ai 1.1 | 聊天与分类器模型分开管理 | `pi/models.ts` | 18 |
| `classify()` / 自定义 `classifiers` | ai 1.1 | 分诊台 | `pi/classifier-glm.ts`、`pi/triage.ts` | 18 |
| `AssistantMessage.thinkingLevel` / `usage.cost` | ai 1.1 | 档位与费用显示 | `pi/observe.ts` | 2、21 |
| `fauxProvider` / 响应工厂 | ai | 离线、课程、回放、测试 | `runtime/replayer.ts`、`packages/lessons` | 19 |
| `getCurrentSystemPrompt` / `getCurrentTools` | ai | 上下文抽屉、测试断言 | `runtime/operator.ts` | 13 |
| `ImageContent`（用户消息与工具结果） / `model.input` | ai | 雷达、监控、体征图，主管截图 | `world/render/*`、`pi/tools/*` | 22 |
| 纯文本模型的图片降级（`transformMessages`） | ai | 指挥官看到占位文本 | `pi/models.ts` | 22 |
| pi-codemode | 1.1 新包 | `run_script` | `pi/tools/codemode.ts` | 16 |
| pi-mcp | 1.1 新包 | 地面站 | `pi/tools/ground-station.ts` | 17 |
| pi-telemetry | 1.1 | span 视图 | `pi/telemetry.ts` | 21 |

不纳入的能力：视频输入（pi-ai 没有视频内容块）、图片生成（网关未提供图片生成模型）、`streamProxy`（单机运行，没有浏览器直连模型的需求）。

---

## 13. 里程碑与 M1 任务拆解

| 里程碑 | 产出 | 可以体验到什么 | 对应课程 |
|---|---|---|---|
| **M1 骨架** | workspace、protocol、世界最小版、单个指挥官、事件总线、WS、Inspector 雏形、离线 faux | 指挥官在说话，泳道在动 | 1、2 |
| **M2 工具** | 全部工具、并行与串行、`onUpdate`、结构化结果、`render/` 三种图与视觉工具、地图动画 | 扫描波纹、无人机飞行、频道里出现雷达图 | 3–6 |
| **M3 控制** | hook 策略链、审批卡、回合策略、`prepareRequest`、插话与排队、中止、单步 | 可以「指挥」了 | 7–11 |
| **M4 上下文** | 自定义消息、sections、动态工具、压缩、上下文抽屉 | 长班次稳定运行 | 12–14 |
| **M5 团队** | 子 Agent 委派、嵌套泳道、中止级联、主管截图提问 | 完整船员团队；指挥官必须靠专家「看」 | 15、22 |
| **M6 扩展** | codemode、MCP 地面站、分类器分诊、`agentLoop` 评审、telemetry、视觉链路收尾 | 1.x 新能力全部到位 | 16–18、20–22 |
| **M7 课程** | 22 节课、讲义、录制回放、精选录制、README 能力索引 | 学习项目成形 | 19 + 全部 |

### 13.1 M1 详细任务

| # | 任务 | 验收 |
|---|---|---|
| 1 | 根 `package.json`（workspaces）、`tsconfig.base.json`、`mise.toml`（node 26.11）、`.env.example` | `npm install` 成功；`npm run typecheck` 通过 |
| 2 | `packages/protocol`：WorldSnapshot、ServerMsg、ClientMsg、WireAgentEvent | 前后端都能引用 |
| 3 | `apps/server/src/config.ts`：读取 `GLM_BASE_URL` / `GLM_API_KEY`（兼容旧的 `STRATEGIC_*`）以及各角色的模型名 | 缺少 key 时进入离线模式 |
| 4 | `pi/models.ts`：GLM provider，使用 §2.3 的 compat；同时注册 glm-5.3 和 glm-5.3-flash；提供 faux 切换 | 冒烟测试：两个模型各完成一次工具调用；flash 识别一张工具返回的图片；信号量下 6 个并发请求无 429 |
| 5 | `world/`：站点、星区、信号生成、tick、seed，以及 `preview` / `enqueue` | 同一 seed 两次运行快照一致 |
| 6 | `pi/messages.ts`：先实现 `situation` 与 `world_event` 两种消息，以及 `convertToLlm` | 单测：只有最新的 `situation` 被完整渲染 |
| 7 | `pi/crew.ts` + `observe.ts`：指挥官（只有 `stand_by` 和 `scan_sector` 的简版），以及 `agent_end` 时的 await 落盘 | faux 测试中能看到完整事件序列 |
| 8 | `runtime/bus.ts` + `ws.ts`：seq 有序、断线补发、`message_update` 合批 | 断线后重连补发无缺失 |
| 9 | `runtime/dispatcher.ts`：新信号 → 指挥官空闲时 `prompt`、运行中 `followUp` | 单测：运行中到达的信号被 followUp 吸收 |
| 10 | `apps/web`：Vite 脚手架、主题 token、三栏布局、顶栏 | 截图符合 §3.5 |
| 11 | Pixi 场景：星空、站点、星区环、信号脉冲 | 60fps；遵守 `prefers-reduced-motion` |
| 12 | Inspector v0：泳道、run 和 turn 容器、请求分段、TTFT 竖线 | 用真实 GLM 跑一次，耗时显示与 `durationMs` 一致 |
| 13 | 通讯频道 v0：流式文本、可折叠的思考内容 | 中文流式显示不卡顿 |
| 14 | 第 1、2 课的 faux 脚本 | 离线即可运行 |

---

## 14. 风险与待验证项

| 风险或待验证项 | 影响 | 应对 | 何时验证 |
|---|---|---|---|
| `zaiToolStream` 在该网关上是否可用 | 工具参数能否流式显示 | 默认关闭；M1 冒烟测试时验证 | M1 |
| glm-5.3-flash 不遵守 `thinking: disabled` | 延迟和成本偏高 | UI 如实显示 `usage.reasoning`；必要时让专家改用 glm-5.3 · `off` | M1 |
| 网关限流（实测约 4 并发，§2.6） | 并行委派 + 分诊台同时发请求时触发 429 | 全局信号量默认 3，UI 展示排队；429 走重试 | M1 |
| flash 看图误判（例如把耀斑噪声当热斑） | 救错目标 | 这是玩法的一部分：`compare_frames` 提供第二证据，结算时公布真相，Inspector 可以回看当时那张图 | M2 |
| 图片累积撑大上下文 | 成本与延迟上升 | 每船员只保留最近 2 张图（§5.11）；图片固定 320×240 | M4 |
| `steer` / `followUp` 的注入时机与直觉不符 | 学习者困惑 | 第 11 课专门讲解，Inspector 标出注入点 | M3 |
| pi-codemode 的 QuickJS WASM 在 Node 26 下的 worker 加载 | `run_script` 不可用 | M6 先做独立验证；失败时降级为「顺序执行多个只读工具」 | M6 |
| 自定义分类器的「概率」只是采样估计 | 可能被误读为真实置信度 | UI 明确标注为采样估计，并在第 18 课讲清楚 | M6 |
| `agent_end` 中的压缩会修改 `state.messages`，与 steer/followUp 存在竞态 | 消息丢失 | 压缩只在 `isStreaming === false` 且队列为空时进行；否则推迟到下一次 `agent_end` | M4 |
| 动态工具变化会导致前缀缓存失效 | 成本上升 | 工具变化只在舱段状态改变时发生，频率低；`cacheRead` 指标会如实体现 | M4 |
| 真实模型表现不稳定，导致课程无法复现 | 学习体验受影响 | 课程默认使用 faux；「真实模型」只作为可选对比 | M7 |
