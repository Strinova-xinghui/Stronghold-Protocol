// 线上/测试服 抽奖端到端验证：真实 WS 推进到第 3 回合，断言「军备抽奖」offer 发放
// 用法: node tools/verify-lottery.mjs [port]
import fs from 'node:fs';
import { TestClient } from '../test/helpers/wsClient.js';

const port = process.argv[2] || '24599';
const url = `ws://127.0.0.1:${port}/ws`;
const bandsRaw = JSON.parse(fs.readFileSync(new URL('../data/bands.json', import.meta.url), 'utf8'));
const bands = Array.isArray(bandsRaw) ? bandsRaw : (bandsRaw.bands || Object.values(bandsRaw));

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };
const pubOf = (c) => c.log.filter((x) => x.t === 'm.public').pop() || null;

// ① 两人 coop 开局
const a = await TestClient.connect(url);
await a.hello('抽奖A');
const created = await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
const state = await a.waitFor('room.state');
const code = state.code || created.code;
const b = await TestClient.connect(url);
await b.hello('抽奖B');
await b.request({ t: 'room.join', code });
await b.waitFor('room.state');
check('建房开局', !!code, `房间 ${code}`);
await a.request({ t: 'room.ready', ready: true });
await b.request({ t: 'room.ready', ready: true });
await a.request({ t: 'room.start' });
const pA = await a.waitFor('m.private', () => true, 15000).catch(() => null);
const A = pA?.playerId;
const pB = await b.waitFor('m.private', () => true, 15000).catch(() => null);
const B = pB?.playerId;

// ② 推进到第 1 回合 PREP（infoReady + 策略轮选）
for (const c of [a, b]) await c.request({ t: 'g.infoReady' }, 3000).catch(() => {});
let phase = null;
for (let i = 0; i < 40; i++) {
  const pub = await a.waitFor('m.public', () => true, 20000).catch(() => null);
  if (!pub) break;
  phase = pub.phase;
  if (phase === 'PREP') break;
  if (phase === 'BAND_DRAFT') {
    const turn = pub.draft?.turn;
    if (turn === A || turn === B) {
      const who = turn === A ? a : b;
      const taken = Object.values(pub.draft.picks || {});
      const pick = bands.find((x) => !taken.includes(x.bandId))?.bandId;
      if (pick) await who.request({ t: 'g.band', bandId: pick }, 3000).catch(() => {});
    }
  }
}
check('进入第 1 回合休整期', phase === 'PREP', `phase=${phase} round=${pubOf(a)?.round}`);

// ③ 逐回合就绪，直到第 3 回合 PREP；检查 rewardOffer 的 label
const readyUp = async (c) => {
  for (let i = 0; i < 14; i++) {
    const priv = await c.waitFor('m.private', () => true, 3000).catch(() => null);
    if (!priv || priv.canReady) break;
    const temps = (priv.temp || []).filter(Boolean);
    if (!temps.length) break;
    for (const p of temps) {
      const r = await c.request({ t: 'g.sell', uid: p.uid }, 3000).catch(() => ({ t: 'error' }));
      if (r.t === 'error') await c.request({ t: 'g.destroy', uid: p.uid }, 3000).catch(() => {});
    }
  }
  return c.request({ t: 'g.ready', ready: true }, 3000);
};

let found = null;
for (let round = 1; round <= 3; round++) {
  const cur = pubOf(a)?.round;
  if (cur === 3) {
    // 第 3 回合：读 rewardOffer
    const priv = await a.waitFor('m.private', () => true, 6000).catch(() => null) || a.log.filter((x) => x.t === 'm.private').pop();
    const ro = priv?.shop?.rewardOffer;
    found = ro || null;
    if (ro && String(ro.label || '').includes('军备抽奖')) break;
  }
  await readyUp(a); await readyUp(b);
  // 等回合推进（战斗在服务器/客户端模拟，一回合可能 30–90 秒，给足时间）
  for (let i = 0; i < 120; i++) {
    const pub = await a.waitFor('m.public', () => true, 10000).catch(() => null);
    if (!pub) break;
    if (pub.phase === 'PREP' && pub.round === round + 1) break;
  }
}
const label = found?.label;
check('第 3 回合收到「军备抽奖」offer', !!found && String(label || '').includes('军备抽奖'),
  found ? `label=${label} slots=${found.slots?.length} queued=${found.queued}` : '未收到 offer');
if (found) {
  check('抽奖槽位数 = 5（配置 choices）', found.slots?.length === 5, `slots=${found.slots?.length}`);
  check('抽奖为装备（kind=item）', (found.slots || []).every((s) => s.kind === 'item'));
  check('队列还有第 2 轮（queued=1）', found.queued === 1, `queued=${found.queued}`);
}

await a.close(); await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
