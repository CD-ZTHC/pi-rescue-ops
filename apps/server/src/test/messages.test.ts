import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { World } from '../world/sim.ts';
import { convertToLlm, operatorMessage, situationMessage, worldEventMessage } from '../pi/messages.ts';

test('只有最新的 situation 被完整渲染，旧的折叠成一行', () => {
  const w = new World({ seed: 5, autoSpawn: false });
  w.spawnNow();
  const old = situationMessage(w.snapshot(), ['新信号 S-01']);
  for (let i = 0; i < 30; i++) w.step();
  w.spawnNow();
  const latest = situationMessage(w.snapshot(), ['新信号 S-02']);
  const out = convertToLlm([old, worldEventMessage('x', '无人机 D-2 已抵达'), latest]);
  assert.equal(out.length, 3);
  assert.equal(out[0].content, '【旧态势 T+00:00，原因：新信号 S-01】');
  assert.equal(out[1].content, '【站务】无人机 D-2 已抵达');
  const full = out[2].content as string;
  assert.match(full, /^【态势 T\+00:30】（触发：新信号 S-02）/);
  assert.match(full, /S-01｜/);
  assert.match(full, /S-02｜/);
});

test('ui_note 被过滤；operator 带插话 / 待办前缀；标准消息原样通过', () => {
  const user = { role: 'user', content: 'hi', timestamp: 1 } as const;
  const msgs: AgentMessage[] = [
    { role: 'ui_note', text: '只给 UI', timestamp: 1 },
    operatorMessage('先救 C 区', 'steer'),
    operatorMessage('之后汇报', 'followUp'),
    user,
  ];
  const out = convertToLlm(msgs);
  assert.equal(out.length, 3);
  assert.equal(out[0].content, '【主管 · 插话】先救 C 区');
  assert.equal(out[1].content, '【主管 · 待办】之后汇报');
  assert.equal(out[2], user);
});
