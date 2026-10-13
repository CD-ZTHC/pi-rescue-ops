# 第 17 课 · MCP

> 能力：pi-mcp、toLlmContent、工具列表变化　｜　场景：地面站上线新卫星　｜　里程碑：M6

## 讲解

地面站是一个独立的 stdio MCP server（官方 SDK 实现）。救援站用 pi-mcp 的 StdioTransport 启动它，listTools() 后把每个工具包成 AgentTool：内容用 toLlmContent 转换，isError 原样透传。天气卫星上线时地面站注册新工具并发出 tools/list_changed，救援站重新拉取工具表，交给指挥官的动态工具机制——下一次请求前 pi 写入工具差异。

## 课程脚本

faux 模式下按以下步骤运行（同时是回归测试）：

1. 地面站（MCP）工具：查站务手册
2. 天气卫星上线：tools/list_changed → 指挥官的工具表新增预报工具

## 关掉它会怎样

地面站子进程崩溃：transport 关闭，地面站工具全部从工具表移除，频道提示「地面站失联」

## 源码

- [`apps/server/src/pi/tools/ground-station.ts`](../../apps/server/src/pi/tools/ground-station.ts)
- [`apps/ground-station/src/server.ts`](../../apps/ground-station/src/server.ts)

## 怎么运行

- 界面：底栏「课程」点 **17**；讲义面板里可切换 faux / 真实模型。
- 测试：`node --test --test-name-pattern='第 17 课' apps/server/src/test/`
