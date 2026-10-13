// 生成精选录制（§9）：node --env-file-if-exists=.env apps/server/src/scripts/record.ts --out recordings/xxx.jsonl [--live] [--ticks 300] [--seed 4242]
// 离线：逐 tick 推进、等船员做完再走（确定性、几秒完成）；真实模型：世界按墙钟 2× 推进（与玩家体验一致）。
import { copyFile, rm, readdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.ts';
import { Station } from '../runtime/station.ts';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'recordings/offline-demo.jsonl' },
    live: { type: 'boolean', default: false },
    ticks: { type: 'string', default: '300' },
    seed: { type: 'string', default: '4242' },
  },
});
const ticks = Number(values.ticks);
const env = { ...process.env, WORLD_SEED: values.seed, ...(values.live ? {} : { RESCUE_OFFLINE: '1', FAUX_TPS: '2000' }) };
const config = loadConfig(env);
if (values.live && config.mode !== 'live') throw new Error('--live 需要 GLM_API_KEY');
const dir = await mkdtemp(join(tmpdir(), 'rescue-record-'));
const station = new Station({ ...config, missionsDir: dir }, { clock: values.live, journal: false, recordDir: dir, groundStation: true });
station.startFreePlay();
station.setPolicy('autoApprove', true); // 无人值守录制：危险操作自动批准（会被录进去，回放时同样生效）
const t0 = Date.now();
if (values.live) {
  station.world.setSpeed(2);
  while (station.world.tick < ticks) {
    await new Promise((r) => setTimeout(r, 1000));
    process.stdout.write(`\rT+${station.world.tick}s 得分 ${station.world.snapshot().score.total}   `);
  }
  // 世界继续走，直到船员手头的事做完（工具可能在等下一个 tick），再停
  while (station.crew().some((c) => c.isRunning)) await new Promise((r) => setTimeout(r, 500));
  station.world.setSpeed(0);
} else {
  for (let i = 0; i < ticks; i++) {
    station.world.step();
    await new Promise((r) => setTimeout(r, 1));
    for (let k = 0; k < 100 && station.crew().some((c) => c.isRunning); k++) await new Promise((r) => setTimeout(r, 2));
  }
  await Promise.all(station.crew().map((c) => c.agent.waitForIdle()));
}
await station.shutdown();
const file = (await readdir(dir)).find((f) => f.endsWith('.local.jsonl'))!;
await copyFile(join(dir, file), values.out); // 临时目录与仓库可能不在同一个卷，不能 rename
await rm(dir, { recursive: true, force: true });
const snap = station.world.snapshot();
console.log(`\n已录制 ${values.out}：${ticks} 秒，得分 ${snap.score.total}（获救 ${snap.score.rescued}），用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
