// 服务端入口：node --env-file-if-exists=.env apps/server/src/main.ts
import { createServer } from 'node:http';
import { loadConfig } from './config.ts';
import { Station } from './runtime/station.ts';
import { attachWebSocket } from './runtime/ws.ts';

const config = loadConfig();
const station = new Station(config, { groundStation: true, recordDir: 'recordings' });
station.startFreePlay();

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, mode: config.mode, seq: station.bus.lastSeq, tick: station.world.tick }));
    return;
  }
  res.writeHead(404).end();
});
attachWebSocket(server, station);

server.listen(config.port, () => {
  const where = config.mode === 'live' ? `GLM 网关 ${config.baseUrl}` : '离线演示（faux）';
  console.log(`[rescue] 织女-7 指挥舱已上线 ws://localhost:${config.port}/ws · ${where} · journal ${station.journal?.file ?? '-'}`);
});

const shutdown = async () => {
  server.close();
  await station.shutdown();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
