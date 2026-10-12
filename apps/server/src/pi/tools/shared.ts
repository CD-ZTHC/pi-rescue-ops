// 工具共用：参数归一化（prepareArguments）、图片内容、等待世界事件。
import { createHash } from 'node:crypto';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { Type } from 'typebox';
import { MODULE_IDS, SECTOR_IDS, type ModuleId, type WorldEvent } from '@rescue/protocol';
import type { Raster } from '../../world/render/raster.ts';
import type { World } from '../../world/sim.ts';

export interface ToolDeps {
  world: World;
}

export const text = (t: string): TextContent => ({ type: 'text', text: t });

export function image(r: Raster): { content: ImageContent; hash: string } {
  const png = r.toPng();
  return {
    content: { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    hash: createHash('sha1').update(png).digest('hex').slice(0, 12),
  };
}

export const SectorParam = Type.Union(SECTOR_IDS.map((id) => Type.Literal(id)), { description: '星区编号 A–F' });
export const SignalParam = Type.String({ pattern: '^S-\\d{2,}$', description: '信号编号，如 S-03' });
export const DroneParam = Type.String({ pattern: '^D-\\d$', description: '无人机编号，如 D-1' });
export const ModuleParam = Type.Union(MODULE_IDS.map((id) => Type.Literal(id)), { description: '舱段：sensors 传感器 / hangar 机库 / medbay 医疗舱 / comms 通讯' });

const halfWidth = (s: string) => s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

/** 把「a区」「Ｂ」「sector c」之类的写法归一化为 A–F；无法识别时原样返回，交给 TypeBox 校验报错 */
export function normalizeSector(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const m = halfWidth(raw).trim().toUpperCase().match(/^(?:SECTOR\s*)?([A-F])\s*区?$/);
  return m ? m[1] : raw;
}

/** 「s3」「S-3」「信号3」→ S-03 */
export function normalizeSignal(raw: unknown): unknown {
  if (typeof raw !== 'string' && typeof raw !== 'number') return raw;
  const m = halfWidth(String(raw)).match(/(\d+)/);
  return m ? `S-${m[1].padStart(2, '0')}` : raw;
}

export function normalizeDrone(raw: unknown): unknown {
  if (typeof raw !== 'string' && typeof raw !== 'number') return raw;
  const m = halfWidth(String(raw)).match(/(\d)/);
  return m ? `D-${m[1]}` : raw;
}

const MODULE_ALIASES: Record<string, ModuleId> = { 传感器: 'sensors', 机库: 'hangar', 医疗舱: 'medbay', 医疗: 'medbay', 通讯: 'comms', 通信: 'comms' };

export function normalizeModule(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const lower = raw.trim().toLowerCase();
  if ((MODULE_IDS as readonly string[]).includes(lower)) return lower;
  for (const [alias, id] of Object.entries(MODULE_ALIASES)) if (raw.includes(alias)) return id;
  return raw;
}

export function normalizeCell(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const m = halfWidth(raw).toUpperCase().match(/([A-D])\s*-?\s*([1-3])/);
  return m ? `${m[1]}${m[2]}` : raw;
}

/** prepareArguments 的小工具：按字段套用归一化函数 */
export function prepare<T>(fields: Record<string, (v: unknown) => unknown>) {
  return (args: unknown): T => {
    const a = { ...((args ?? {}) as Record<string, unknown>) };
    for (const [k, f] of Object.entries(fields)) if (k in a) a[k] = f(a[k]);
    return a as T;
  };
}

export function waitForWorldEvent<T extends WorldEvent>(
  world: World,
  match: (ev: WorldEvent) => ev is T,
  signal?: AbortSignal,
  onTick?: (tick: number) => string | void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const off = world.subscribe(({ events, tick }) => {
      const hit = events.find(match);
      if (hit) {
        cleanup();
        resolve(hit);
        return;
      }
      const abortReason = onTick?.(tick);
      if (abortReason) {
        cleanup();
        reject(new Error(abortReason));
      }
    });
    const onAbort = () => {
      cleanup();
      reject(new Error('已中止'));
    };
    const cleanup = () => {
      off();
      signal?.removeEventListener('abort', onAbort);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 业务失败：isError + 供 UI 渲染的 details / structuredContent（§5.4 失败约定） */
export function failure(message: string, details: Record<string, unknown> = {}) {
  return { content: [text(message)], details: { ...details, reason: message }, isError: true as const };
}
