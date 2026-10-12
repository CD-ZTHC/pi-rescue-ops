// WebSocket 服务：连接时发 hello 全量快照；带 ?since=seq 重连时只补发缺失的消息。
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '@rescue/protocol';
import type { Station } from './station.ts';
import { handleOperator } from './operator.ts';

export function attachWebSocket(server: Server, station: Station): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (socket, req) => {
    const url = new URL(req.url ?? '/ws', 'http://localhost');
    const since = Number(url.searchParams.get('since'));
    const send = (msg: ServerMsg) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    // 先订阅再取补发，避免两步之间漏消息；用 seq 去重
    let sentUpTo = -1;
    const forward = (msg: ServerMsg) => {
      if (msg.seq <= sentUpTo) return;
      sentUpTo = msg.seq;
      send(msg);
    };
    const off = station.bus.subscribe(forward);

    const missed = Number.isFinite(since) && since > 0 ? station.bus.since(since) : undefined;
    if (missed) {
      for (const m of missed) forward(m);
    } else {
      const hello = station.hello();
      sentUpTo = hello.seq;
      send(hello);
    }

    socket.on('message', (raw) => onClientMessage(station, socket, raw.toString()));
    socket.on('close', off);
  });
  return wss;
}

function onClientMessage(station: Station, socket: WebSocket, raw: string): void {
  let msg: ClientMsg;
  try {
    msg = JSON.parse(raw) as ClientMsg;
  } catch {
    socket.close(1003, 'invalid json');
    return;
  }
  handleOperator(station, msg).catch((err) => {
    station.bus.app({ kind: 'notice', level: 'error', text: `处理 ${msg.t} 失败：${String(err)}` });
  });
}
