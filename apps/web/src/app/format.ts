import type { ServerInfo } from '@rescue/protocol';

export function formatCost(usd: number, info?: ServerInfo): string {
  if (!info || info.currency === 'USD') return `$${usd.toFixed(4)}`;
  return `¥${(usd * info.usdRate).toFixed(4)}`;
}

export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export function seconds(ms: number | undefined): string {
  return ms === undefined ? '—' : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}
