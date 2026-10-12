// WS 客户端：断线后带 ?since=<最后的 seq> 重连，服务端只补发缺失的消息（§4.5）。
import type { ClientMsg, ServerMsg } from '@rescue/protocol';
import { ingest, useUi } from '../store/index.ts';

let socket: WebSocket | undefined;
let lastSeq = 0;
let retry = 0;
const outbox: ClientMsg[] = [];

export function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws${lastSeq ? `?since=${lastSeq}` : ''}`;
  useUi.setState({ connection: 'connecting' });
  const ws = new WebSocket(url);
  socket = ws;
  ws.onopen = () => {
    retry = 0;
    useUi.setState({ connection: 'open' });
    for (const m of outbox.splice(0)) ws.send(JSON.stringify(m));
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data as string) as ServerMsg;
    if (msg.t !== 'hello' && msg.seq <= lastSeq) return; // 去重
    lastSeq = msg.seq;
    ingest(msg);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    useUi.setState({ connection: 'closed' });
    const delay = Math.min(5000, 300 * 2 ** retry++);
    setTimeout(connect, delay);
  };
}

export function send(msg: ClientMsg): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
  else outbox.push(msg);
}
