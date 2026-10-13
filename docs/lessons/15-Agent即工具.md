# 第 15 课 · Agent 即工具

> 能力：子 Agent、onUpdate 冒泡、中止级联　｜　场景：三路并行委派　｜　里程碑：M5

## 讲解

子 Agent 就是一个工具：delegate 的 execute 里 await child.prompt()，返回专家用 report_back 交付的结构化报告。子 Agent 的事件通过 onUpdate 冒泡成父工具的 tool_execution_update，Inspector 据此把 delegate 工具条展开成嵌套子泳道。指挥官在一个回复里并行委派三名专家；父工具被中止时，signal 级联中止子 Agent；子 Agent 正忙时，新任务以 steer 插进它当前的运行。

## 课程脚本

faux 模式下按以下步骤运行（同时是回归测试）：

1. 多线告急：一个回复里并行委派三名专家

## 关掉它会怎样

关掉委派：指挥官看不见监控与体征，只能让调度器把值班任务直接派给专家，失去统筹

讲义面板里有一键开关：策略 `delegation`（指挥官委派专家（关闭则调度器直接派活），作用于 `tools`）。改完点「↻ faux 运行」再跑一次对比。

## 源码

- [`apps/server/src/pi/tools/delegate.ts`](../../apps/server/src/pi/tools/delegate.ts)
- [`apps/web/src/inspector/Inspector.tsx`](../../apps/web/src/inspector/Inspector.tsx)

## 怎么运行

- 界面：底栏「课程」点 **15**；讲义面板里可切换 faux / 真实模型。
- 测试：`node --test --test-name-pattern='第 15 课' apps/server/src/test/`
