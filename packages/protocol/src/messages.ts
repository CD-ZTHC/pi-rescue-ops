// CustomAgentMessages 声明合并（§5.2）。放在协议包里，前后端看到同一套消息类型。
import type { ModuleStatus } from './world.ts';

export interface SituationBrief {
  tick: number;
  fuel: number;
  beds: number;
  dronesDocked: number;
  dronesTotal: number;
  modules: Array<{ name: string; status: ModuleStatus }>;
  signals: Array<{ id: string; sector: string; kind: string; survivors: number; remaining: number; clues: string[]; status: string; scanned: boolean; reservedFuel?: number }>;
  drones: Array<{ id: string; status: string; target?: string }>;
  flares: Array<{ sectors: string[]; startsIn: number; active: boolean }>;
  patientsPending: number;
  fuelReserved: number;
}

declare module '@earendil-works/pi-agent-core' {
  interface CustomAgentMessages {
    situation: { role: 'situation'; tick: number; brief: SituationBrief; reasons: string[]; timestamp: number };
    radio: { role: 'radio'; signalId: string; transcript: string; timestamp: number };
    world_event: { role: 'world_event'; kind: string; text: string; correlationId?: string; timestamp: number };
    /** images：主管截图（§3.4「截图提问」） */
    operator: { role: 'operator'; text: string; urgency: 'steer' | 'followUp' | 'prompt'; images?: Array<{ type: 'image'; data: string; mimeType: string }>; timestamp: number };
    compaction: { role: 'compaction'; summary: string; replacedCount: number; timestamp: number };
    /** 只给 UI，永远不发给模型 */
    ui_note: { role: 'ui_note'; text: string; timestamp: number };
  }
}
