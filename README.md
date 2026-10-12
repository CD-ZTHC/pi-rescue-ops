# Pi Rescue Ops · 深空救援指挥舱

以学习 pi-agent-core 1.1 / pi-ai 1.1 为目的的项目。设计见 [docs/design.md](docs/design.md)。当前进度：**M1 骨架**。

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
| `mise run test` | 后端单测（node:test + faux，离线） |
| `mise run test:web` | 前端单测（vitest） |
| `mise run smoke:live` | 真实 GLM 网关冒烟（手动执行，会消耗 token） |

有 key 时，自由模式下指挥官每收到一个新信号就会调用一次真实模型。只想看界面时可以设 `RESCUE_OFFLINE=1`。

## M1 已完成

| # | 内容 | 位置 |
|---|---|---|
| 1 | workspaces、`tsconfig.base.json`、`mise.toml`、`.env.example` | 根目录 |
| 2 | 前后端共享协议，包括 `CustomAgentMessages` 声明合并 | `packages/protocol` |
| 3 | 配置（`GLM_*`，兼容 `STRATEGIC_*`；没有 key 时进入离线模式） | `apps/server/src/config.ts` |
| 4 | GLM provider + compat、全局信号量、faux 切换、TTFT 探针 | `apps/server/src/pi/models.ts` |
| 5 | 单写者世界：seed、tick、信号生成、`preview` / `enqueue` | `apps/server/src/world/` |
| 6 | `situation` / `world_event` / `operator` 消息与 `convertToLlm` | `apps/server/src/pi/messages.ts` |
| 7 | 指挥官（`scan_sector` + `stand_by`），`agent_end` 时 await 落盘 | `pi/crew.ts`、`pi/observe.ts` |
| 8 | 有序总线（seq）、50ms 合批、断线补发 | `runtime/bus.ts`、`runtime/ws.ts` |
| 9 | 唤醒策略：空闲时 `prompt`，运行中 `followUp` | `runtime/dispatcher.ts` |
| 10–13 | 三栏布局、Pixi 星区图、Loop Inspector v0、通讯频道 v0、上下文抽屉 | `apps/web/src/` |
| 14 | 第 1、2 课的 faux 脚本（同时是回归测试） | `packages/lessons` |

另外还有零依赖 PNG 编码器（`world/render/png.ts`、`raster.ts`），冒烟测试的看图检查要用到它，M2 的三种图也将基于它实现。

## M1 实测结论（2026-10-12，`mise run smoke:live` 8/8 通过）

- glm-5.3 与 glm-5.3-flash 都能完成工具调用；flash 能从工具返回的 320×240 图片中正确说出「橙色、右下」；glm-5.3 收到同一张图时不报错，pi 自动把图片降级为占位文本。
- 信号量上限设为 3 时，同时发出 6 个 flash 请求全部成功，峰值并发 3，没有出现 429。
- `zaiToolStream: true` 可以用，但网关只发出 1 个 `toolcall_delta`，参数是一次性给出的，没有流式效果，因此**保持关闭**（§14）。
- glm-5.3-flash 在 `thinking: off` 时仍然产生 reasoning（`usage.reasoning=19`），与 §2.1 一致，UI 按 usage 如实显示。
- 新发现：faux 中预先构造的响应，其 `timestamp` 早于流的创建时间，所以 pi **不会**为它填写 `durationMs`。`request.meta` 此时改用墙钟补算，并标注 `durationSource: 'wall'`；真实模型的值始终来自 pi（`'pi'`）。
- 网关没有公开价格，`.env.example` 中的价格默认是 0，因此费用显示为 0。填上 `GLM_PRICE_*` 后，费用由 pi-ai 按 `model.cost` 计算。
