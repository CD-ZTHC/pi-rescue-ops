# Pi Rescue Ops · 深空救援指挥舱

以学习 **pi-agent-core 1.1 / pi-ai 1.1** 为目的的项目：一支 AI 船员团队在轨道救援站值夜班，每一项框架能力都对应一个真实的玩法、一节课、一组测试。设计见 [docs/design.md](docs/design.md)，22 课讲义见 [docs/lessons/](docs/lessons/)。

里程碑 M1–M7 全部完成。

## 运行

环境由 mise 管理（Node 26.11）。

```sh
mise install          # 安装 Node
mise run install      # npm install
cp .env.example .env  # 填 GLM_API_KEY；不填则进入离线演示（faux 离线大脑）
mise run dev          # 后端 ws://localhost:8787/ws + 前端 http://localhost:5173
```

| 任务 | 说明 |
|---|---|
| `mise run ci` | 类型检查 + 后端单测 + 前端单测 + 构建 |
| `mise run test` / `mise run test:web` | 后端（node:test + faux，离线）/ 前端（vitest） |
| `mise run smoke:live` | 真实 GLM 网关冒烟（手动执行，消耗 token） |
| `mise run record -- --out recordings/x.jsonl [--live]` | 录制一段班次（离线几秒完成；`--live` 用真实模型） |
| `mise run docs` | 重新生成讲义与下方能力索引 |

- 有 key 时，自由模式下四名船员会持续调用真实模型；只想看界面时设 `RESCUE_OFFLINE=1`。
- 自由模式自动录制到 `recordings/*.local.jsonl`（不入库），底栏「📼 录制」可回放或从 `missions/` 日志恢复班次。
- 价格默认 0（网关未公开价格），填 `GLM_PRICE_*` 后费用由 pi-ai 按 `model.cost` 计算。

## 界面

| 区域 | 内容 |
|---|---|
| ① 星区态势图（PixiJS） | 信号脉冲与终态、扫描扫掠、无人机插值飞行与拖尾、耀斑区动画；点信号看详情与分诊概率，点无人机联动到下达出动的工具调用 |
| ② Loop Inspector | 每名船员一条泳道：run / turn、请求分段（思考 / 文本 / 工具调用）、TTFT 竖线、工具甘特条与进度刻度、hook 菱形、队列徽章、上下文水位、委派的嵌套子泳道；点请求条看耗时构成与原始 chunk |
| ③ 通讯频道 | 流式消息与可折叠思考、雷达 / 监控 / 体征缩略图、结构化工具卡片、审批卡片（30 秒倒计时）、分诊卡、压缩折叠、评审卡；插话 / 待办 / 附上态势图 |
| ④ 底栏 | 单步调试、调速、课程 1–22、策略开关、工具试验台、Span 树、录制与日志、「模型看到的上下文」 |

## 结构

```
packages/protocol   前后端共享类型：世界快照、WS 消息、CustomAgentMessages、策略开关
packages/lessons    22 课元数据与 faux 脚本（脚本即回归测试）
apps/server         世界（单写者，seed 确定性）· pi 能力层（一个能力一个文件）· 运行时（总线、调度、录制回放）
apps/ground-station 独立的 stdio MCP server（地面站）
apps/web            Vite + React 19 + PixiJS 8 + Tailwind 4 + Motion + Zustand
recordings          精选录制（入库）
```

## 实测结论

### M1（2026-10-12）

- glm-5.3 与 glm-5.3-flash 都能完成工具调用；flash 能从工具返回的 320×240 图片中正确说出「橙色、右下」；glm-5.3 收到同一张图时不报错，pi 自动把图片降级为占位文本。
- 信号量上限设为 3 时，同时发出 6 个 flash 请求全部成功，峰值并发 3，没有出现 429。
- `zaiToolStream: true` 可以用，但网关只发出 1 个 `toolcall_delta`，参数是一次性给出的，没有流式效果，因此**保持关闭**（§14）。
- glm-5.3-flash 在 `thinking: off` 时仍然产生 reasoning（`usage.reasoning=19`），与 §2.1 一致，UI 按 usage 如实显示。
- 新发现：faux 中预先构造的响应，其 `timestamp` 早于流的创建时间，所以 pi **不会**为它填写 `durationMs`。`request.meta` 此时改用墙钟补算，并标注 `durationSource: 'wall'`；真实模型的值始终来自 pi（`'pi'`）。
- 网关没有公开价格，`.env.example` 中的价格默认是 0，因此费用显示为 0。填上 `GLM_PRICE_*` 后，费用由 pi-ai 按 `model.cost` 计算。

### M2（2026-10-12）

- glm-5.3-flash 三种图都能看懂：雷达图正确区分真实与诱饵（会主动调用 `compare_frames` 看两帧），监控画面找到 C2 火点并只排空这一格，体征波形只收治了危急成员。
- 第 1 课用真实指挥官跑：它自己走完了 `inspect_signal → scan_sector → plot_course → dispatch_drone → stand_by`。
- 这一轮 flash 的 `thinking: off` 返回 `usage.reasoning=0`，上一轮是 19：网关对 disabled 的处理并不稳定。

### M3–M7（2026-10-13，`mise run smoke:live` 14/14 通过）

- **委派**：真实指挥官（glm-5.3）会主动把看图交给领航员（flash）：`delegate → scan_sector → compare_frames → report_back`，拿到报告后再规划航线、派出无人机。
- **分诊台**：自定义分类器在网关上可用（k=3 次工具采样）；5 分钟真实班次里 11 个信号都完成了分诊。
- **脚本编排**：真实指挥官会写 `run_script` 一次查询多个信号。
- **审批**：无人值守时，危险操作会在 30 秒后按超时否决；模型被否决后会反复重试同一个操作，所以冒烟测试与录制脚本都打开了 `autoApprove`。
- **录制回放**：一段 5 分钟的真实 GLM 班次（`recordings/glm-shift-01.jsonl`，含并行委派、地面站查询、脚本编排）可完全离线回放，**81/81 次工具调用与录制一致**（第 19 课）。
- **flash 的 thinking off**：三轮实测 `usage.reasoning` 分别为 19、0、4，网关对 disabled 的处理不稳定。
- **踩过的坑**：
  - `journal?.write({ ...log[i++] })` 在没有 journal 时，可选链会跳过整个参数求值，导致死循环。
  - pi 的循环结束、但 `run()` 还没返回的这段时间里送达的 followUp 会留在队列里。
  - 子 Agent 正忙时再调用 `prompt()` 会抛错。

## 与设计的差异

- **燃料规则**：「进入耀斑区翻倍」改为「基础量 ×（1 + 危险区航程占比）」——直飞是径向的，原规则下绕行没有意义。
- **指挥官保留文字研判工具**：委派模式下指挥官仍有 `inspect_signal` / `plot_course`，只有看图的 `scan_sector` / `compare_frames` 归领航员独有；「看不见图必须委派」不变。关闭策略 `delegation` 即回到 M2 的做法（调度器直接给专家派值班任务）。
- **分类器不能强制工具**：pi-ai 的 `toolChoice` 只有 auto / none，分诊台靠提示，模型不调用工具时解析文本里的 JSON，仍失败的样本丢弃。
- **地面站测试**：没有用内存 transport，直接启动真实的 stdio 子进程（约 150 ms）。
- **运行中的低优先级站务**不走 `followUp`（会多发请求），而是运行结束后追加到上下文。
- **一次性调用**（书记员 / 分诊 / 评审）使用独立的 faux provider，不占课程脚本的响应队列；并发 Agent 的课程脚本按 system prompt 分角色分发。

## 能力索引（22 课）

<!-- capability-index:start -->
| # | 课程 | 能力 | 讲义 | 源码 |
|---|---|---|---|---|
| 1 | 事件流 | prompt、subscribe、事件顺序 | [讲义](docs/lessons/01-事件流.md) | `pi/crew.ts`<br>`pi/observe.ts`<br>`runtime/bus.ts` |
| 2 | 流式思考 | thinking_* 事件、thinkingLevel、thinkingBudgets | [讲义](docs/lessons/02-流式思考.md) | `pi/models.ts`<br>`pi/turn-policy.ts` |
| 3 | 工具基础 | TypeBox 校验、参数错误回传、terminate | [讲义](docs/lessons/03-工具基础.md) | `pi/tools/shared.ts`<br>`pi/tools/navigator.ts`<br>`pi/hooks/after.ts` |
| 4 | 并行与串行 | toolExecution、工具级 executionMode | [讲义](docs/lessons/04-并行与串行.md) | `pi/tools/commander.ts`<br>`pi/tools/navigator.ts` |
| 5 | 工具流式进度 | onUpdate、tool_execution_update | [讲义](docs/lessons/05-工具流式进度.md) | `pi/tools/engineer.ts` |
| 6 | 结构化结果 | outputSchema、structuredContent、isError | [讲义](docs/lessons/06-结构化结果.md) | `pi/tools/navigator.ts`<br>`apps/web/src/comms/ToolCard.tsx` |
| 7 | 拦截与审批 | beforeToolCall 的 block / terminate | [讲义](docs/lessons/07-拦截与审批.md) | `pi/hooks/compose.ts`<br>`pi/hooks/approval.ts`<br>`pi/hooks/guards.ts`<br>`pi/hooks/step-gate.ts` |
| 8 | 结果改写 | afterToolCall 改写 content / structuredContent | [讲义](docs/lessons/08-结果改写.md) | `pi/hooks/after.ts`<br>`apps/ground-station/src/server.ts` |
| 9 | 回合控制 | finishTurn、prepareNextTurnWithContext | [讲义](docs/lessons/09-回合控制.md) | `pi/turn-policy.ts` |
| 10 | 请求前准备 | prepareRequest 换上下文、模型、思考档位 | [讲义](docs/lessons/10-请求前准备.md) | `pi/turn-policy.ts` |
| 11 | 插话与排队 | steer、followUp、队列模式、peekQueuedMessages、abort | [讲义](docs/lessons/11-插话与排队.md) | `pi/crew.ts`<br>`runtime/dispatcher.ts`<br>`runtime/operator.ts` |
| 12 | 自定义消息 | CustomAgentMessages、convertToLlm | [讲义](docs/lessons/12-自定义消息.md) | `packages/protocol/src/messages.ts`<br>`pi/messages.ts` |
| 13 | 提示分段与动态工具 | system sections、state.tools 差异 | [讲义](docs/lessons/13-提示分段与动态工具.md) | `pi/prompts.ts`<br>`pi/roster.ts`<br>`runtime/station.ts` |
| 14 | 上下文管理 | transformContext、运行间隙压缩、溢出恢复 | [讲义](docs/lessons/14-上下文管理.md) | `pi/context.ts`<br>`pi/compaction.ts` |
| 15 | Agent 即工具 | 子 Agent、onUpdate 冒泡、中止级联 | [讲义](docs/lessons/15-Agent即工具.md) | `pi/tools/delegate.ts`<br>`apps/web/src/inspector/Inspector.tsx` |
| 16 | 脚本编排 | runToolCall、pi-codemode、nestedCalls | [讲义](docs/lessons/16-脚本编排.md) | `pi/tools/codemode.ts`<br>`pi/tools/readonly.ts` |
| 17 | MCP | pi-mcp、toLlmContent、工具列表变化 | [讲义](docs/lessons/17-MCP.md) | `pi/tools/ground-station.ts`<br>`apps/ground-station/src/server.ts` |
| 18 | 分类器 | classify()、自定义 ProviderClassifier、模型类型 | [讲义](docs/lessons/18-分类器.md) | `pi/classifier-glm.ts`<br>`pi/triage.ts`<br>`pi/models.ts` |
| 19 | 录制回放 | faux provider、响应工厂 | [讲义](docs/lessons/19-录制回放.md) | `runtime/recorder.ts`<br>`runtime/replayer.ts`<br>`scripts/record.ts` |
| 20 | 低层循环 | agentLoop，与 Agent 的屏障语义对比 | [讲义](docs/lessons/20-低层循环.md) | `pi/stateless-judge.ts` |
| 21 | 观测 | onProviderStreamEvent、TTFT、durationMs、费用、telemetry | [讲义](docs/lessons/21-观测.md) | `pi/observe.ts`<br>`pi/telemetry.ts`<br>`apps/web/src/inspector/RequestDetail.tsx` |
| 22 | 多模态 | ImageContent、model.input、工具结果图片、纯文本模型的自动降级 | [讲义](docs/lessons/22-多模态.md) | `world/render/`<br>`pi/turn-policy.ts`<br>`pi/context.ts` |
<!-- capability-index:end -->
