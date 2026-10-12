// 视图裁剪（§5.11 transformContext）：每次请求前运行，不修改原始消息，返回一个新数组。
// 1. 永远保留全部 system 消息（它们承载提示词与工具声明）与书记员摘要（compaction）
// 2. 每个船员只保留最近 2 张图片，更早的替换为「[图像已折叠：当时那条回复的首句结论]」
// 3. 估算 token 超过预算时，从最旧的非 system 消息开始裁掉，并让保留部分从一个完整的边界开始
//    （不能以 toolResult 开头，否则模型会看到没有调用的结果）
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { worldEventMessage } from './messages.ts';

const IMAGE_TOKENS = 105; // 320×240 实测约 105 token（§2.5）

function textLength(m: AgentMessage): { cjk: number; other: number; images: number } {
  let s = '';
  let images = 0;
  const add = (c: unknown) => {
    if (typeof c === 'string') s += c;
    else if (Array.isArray(c))
      for (const b of c as Array<{ type: string; text?: string; thinking?: string; arguments?: unknown }>) {
        if (b.type === 'image') images++;
        else s += b.text ?? b.thinking ?? JSON.stringify(b.arguments ?? '');
      }
  };
  switch (m.role) {
    case 'system':
      add(m.content);
      s += Object.values(m.sections ?? {}).join('');
      s += JSON.stringify(m.toolsAdded ?? []);
      break;
    case 'user':
    case 'assistant':
    case 'toolResult':
      add(m.content);
      break;
    case 'situation':
      s += JSON.stringify(m.brief);
      break;
    case 'compaction':
      s += m.summary;
      break;
    case 'radio':
      s += m.transcript;
      break;
    case 'ui_note':
      break;
    default:
      s += 'text' in m ? m.text : '';
  }
  const cjk = (s.match(/[　-鿿＀-￯]/g) ?? []).length;
  return { cjk, other: s.length - cjk, images };
}

/** 粗略估算：中文约 1 字 1 token，其余约 4 字符 1 token，图片按实测 */
export function estimateTokens(messages: readonly AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    const t = textLength(m);
    total += t.cjk + Math.ceil(t.other / 4) + t.images * IMAGE_TOKENS + 4;
  }
  return total;
}

const firstSentence = (text: string) => (text.split(/[。！？\n]/)[0] || '无结论').slice(0, 40);

/** 第 2 步：折叠旧图片 */
export function foldImages(messages: AgentMessage[], keep = 2): AgentMessage[] {
  let seen = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if ((m.role !== 'toolResult' && m.role !== 'user') || typeof m.content === 'string') continue;
    const n = m.content.filter((c) => c.type === 'image').length;
    if (!n) continue;
    if (seen >= keep) {
      const reply = out.slice(i + 1).find((x) => x.role === 'assistant');
      const said = reply && reply.role === 'assistant' ? reply.content.map((c) => (c.type === 'text' ? c.text : '')).join('') : '';
      const content = m.content.map((c) => (c.type === 'image' ? { type: 'text' as const, text: `[图像已折叠：${firstSentence(said)}]` } : c));
      out[i] = { ...m, content } as AgentMessage;
    }
    seen += n;
  }
  return out;
}

const isBoundary = (m: AgentMessage) => m.role !== 'toolResult' && m.role !== 'assistant';

/** 第 3 步：按预算从前往后裁剪（system 消息原样保留在原位） */
export function trimToBudget(messages: AgentMessage[], budget: number): { messages: AgentMessage[]; dropped: number } {
  if (estimateTokens(messages) <= budget) return { messages, dropped: 0 };
  const keep = messages.map(() => true);
  const pinned = (m: AgentMessage) => m.role === 'system' || m.role === 'compaction';
  const body = messages.map((m, i) => ({ m, i })).filter(({ m }) => !pinned(m));
  let dropped = 0;
  for (const { i } of body.slice(0, -1)) {
    if (estimateTokens(messages.filter((_, j) => keep[j])) <= budget) break;
    keep[i] = false;
    dropped++;
  }
  // 让保留部分从完整的边界开始
  for (const { m, i } of body) {
    if (!keep[i]) continue;
    if (isBoundary(m) || i === body[body.length - 1].i) break;
    keep[i] = false;
    dropped++;
  }
  const out: AgentMessage[] = [];
  let noted = false;
  messages.forEach((m, i) => {
    if (!keep[i]) return;
    if (!noted && !pinned(m) && dropped) {
      out.push(worldEventMessage('view_trim', `【视图裁剪】更早的 ${dropped} 条消息本次未显示`));
      noted = true;
    }
    out.push(m);
  });
  return { messages: out, dropped };
}

export function viewTrim(budget: () => number, enabled: () => boolean) {
  return async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
    if (!enabled()) return messages;
    try {
      return trimToBudget(foldImages(messages), budget()).messages;
    } catch {
      return messages; // transformContext 不得抛错
    }
  };
}
