// 地面站客户端（§5.10）：用 pi-mcp 的 StdioTransport 启动 MCP server，listTools() 后转换成 AgentTool。
// - toLlmContent 转换内容；MCP 的工具失败在结果里（isError），原样透传
// - tools/list_changed：重新拉取工具表，交给指挥官的动态工具（§5.3）
// - 子进程崩溃 / 关闭：移除地面站工具，频道提示「地面站失联」
import { fileURLToPath } from 'node:url';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { JsonValue } from '@earendil-works/pi-ai';
import { McpClient, StdioTransport, toLlmContent, type McpTransport, type Tool as McpTool } from '@earendil-works/pi-mcp';
import { Type } from 'typebox';

export const GROUND_STATION_SCRIPT = fileURLToPath(new URL('../../../../ground-station/src/server.ts', import.meta.url));

export interface GroundStationEvents {
  onTools(tools: AgentTool<any>[], added: string[], removed: string[]): void;
  onClosed(reason: string): void;
}

export function toAgentTool(client: McpClient, tool: McpTool): AgentTool<any> {
  return {
    // 提供方要求工具名只含 [A-Za-z0-9_-]，最长 64
    name: tool.name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64),
    label: tool.title ?? tool.name,
    description: `【地面站】${tool.description ?? tool.name}`,
    // 提供方要求对象 schema，且有的要求必须有 properties
    parameters: Type.Unsafe({ ...tool.inputSchema, type: 'object', properties: tool.inputSchema.properties ?? {} }),
    outputSchema: tool.outputSchema ? Type.Unsafe(tool.outputSchema) : undefined,
    executionMode: 'parallel',
    async execute(_id, params, signal) {
      const result = await client.callTool(tool.name, params as Record<string, unknown>, { signal });
      return {
        content: toLlmContent(result),
        details: { mcp: tool.name },
        structuredContent: result.structuredContent as JsonValue | undefined,
        isError: result.isError === true,
      };
    },
  };
}

export class GroundStation {
  readonly client = new McpClient({ name: 'zhinv7-station', version: '0.1.0' });
  tools: AgentTool<any>[] = [];
  transport?: McpTransport;
  private closed = false;
  private readonly events: GroundStationEvents;

  constructor(events: GroundStationEvents) {
    this.events = events;
  }

  static stdio(env: Record<string, string> = {}): McpTransport {
    return new StdioTransport({ command: process.execPath, args: [GROUND_STATION_SCRIPT], env, inheritEnv: true, stderr: 'pipe' });
  }

  async connect(transport: McpTransport = GroundStation.stdio()): Promise<void> {
    this.transport = transport;
    await this.client.connect(transport);
    this.client.onNotification('notifications/tools/list_changed', () => void this.refresh());
    this.client.onClose(() => {
      if (this.closed) return;
      this.closed = true;
      const removed = this.tools.map((t) => t.name);
      this.tools = [];
      this.events.onTools([], [], removed);
      this.events.onClosed('地面站连接中断');
    });
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const listed = (await this.client.listTools()).filter((t) => !t.name.startsWith('_'));
    const next = listed.map((t) => toAgentTool(this.client, t));
    const before = new Set(this.tools.map((t) => t.name));
    const after = new Set(next.map((t) => t.name));
    this.tools = next;
    this.events.onTools(
      next,
      [...after].filter((n) => !before.has(n)),
      [...before].filter((n) => !after.has(n)),
    );
  }

  /** 上行：推送当前 tick 与耀斑计划；satellite 控制天气卫星上线 / 下线 */
  async uplink(tick: number, nextFlare?: { sectors: string[]; startTick: number }, satellite?: 'online' | 'offline'): Promise<void> {
    if (this.closed) return;
    await this.client.callTool('_uplink', { tick, ...(nextFlare ? { nextFlare } : {}), ...(satellite ? { satellite } : {}) });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client.close();
  }
}
