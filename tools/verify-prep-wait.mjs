// 休整期等待投票 v2 端到端验证：等待与准备完全独立——不就绪也能等待、等待不锁操作；
// **全员等待**时倒计时暂停（deadline 0），任一人取消即恢复。
// 用法: node tools/verify-prep-wait.mjs [port]（假设验证服务器已在 PORT 上运行）
import fs from 'node:fs';
import { TestClient } from '../test/helpers/wsClient.js';

const port = process.argv[2] || '24599';
const url = `ws://127.0.0.1:${port}/ws`;

const bandsRaw = JSON.parse(fs.readFileSync(new URL('../data/bands.json', import.meta.url), 'utf8'));
const bands = Array.isArray(bandsRaw) ? bandsRaw : (bandsRaw.bands || Object.values(bandsRaw));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};
const pubOf = (c) => c.log.filter((x) => x.t === 'm.public').pop() || null;

// ① A、B 入房开局（coop → 有计时；各选 band 进 PREP）
const a = await TestClient.connect(url);
await a.hello('玩家A');
const created = await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
const state = await a.waitFor('room.state');
const code = state.code || created.code;
const b = await TestClient.connect(url);
await b.hello('玩家B');
const joined = await b.request({ t: 'room.join', code });
await b.waitFor('room.state');
check('A 建房、B 加入', !joined.code, `房间 ${code}`);
await a.request({ t: 'room.ready', ready: true });
await b.request({ t: 'room.ready', ready: true });
await a.request({ t: 'room.start' });
const privA0 = await a.waitFor('m.private', () => true, 15000).catch(() => null);
const A_ID = privA0?.playerId;
const privB0 = await b.waitFor('m.private', () => true, 15000).catch(() => null);
const B_ID = privB0?.playerId;
for (const c of [a, b]) await c.request({ t: 'g.infoReady' }, 3000).catch(() => {});
let phase = null;
for (let i = 0; i < 40; i++) {
  const pub = await a.waitFor('m.public', () => true, 20000).catch(() => null);
  if (!pub) break;
  phase = pub.phase;
  if (phase === 'PREP') break;
  if (phase === 'BAND_DRAFT') {
    const turn = pub.draft?.turn;
    if (turn === A_ID || turn === B_ID) {
      const who = turn === A_ID ? a : b;
      const taken = Object.values(pub.draft.picks || {});
      const pick = bands.find((x) => !taken.includes(x.bandId))?.bandId;
      if (pick) await who.request({ t: 'g.band', bandId: pick }, 3000).catch(() => {});
    }
  }
}
check('进入休整期（PREP，计时模式）', phase === 'PREP', `phase=${phase}`);
const pub1 = pubOf(a);
check('PREP 有倒计时（deadline > 0）', (pub1?.deadline || 0) > 0, `deadline=${pub1?.deadline}`);

// ② 未就绪也可以等待（v2 核心变化——v1 这里被拒）
const r1 = await a.request({ t: 'g.prepWait', on: true }, 3000).catch(() => ({ t: 'error', code: 'timeout' }));
check('未就绪发起等待成功（与准备独立）', r1.t === 'ok', r1.t === 'error' ? r1.code : '');
const pub2 = await a.waitFor('m.public', (f) => f.prepWait?.waiters?.includes(A_ID), 4000).catch(() => null);
check('m.public.prepWait 广播（waiters 含 A）', !!pub2?.prepWait, JSON.stringify(pub2?.prepWait || {}).slice(0, 80));
check('仅一人等待：hold 不成立、倒计时不暂停', pub2?.prepWait?.held === false && (pub2?.deadline || 0) > 0,
  `held=${pub2?.prepWait?.held} deadline=${pub2?.deadline}`);

// ③ B 也等待 → 全员等待 ⇒ hold 成立（deadline 0）
const r2 = await b.request({ t: 'g.prepWait', on: true }, 3000).catch(() => ({ t: 'error', code: 'timeout' }));
check('B 发起等待成功', r2.t === 'ok', r2.t === 'error' ? r2.code : '');
const pub3 = await a.waitFor('m.public', (f) => f.prepWait?.held === true, 4000).catch(() => null);
check('全员等待 ⇒ hold 成立（deadline=0）', pub3?.prepWait?.held === true && pub3?.deadline === 0,
  `held=${pub3?.prepWait?.held} deadline=${pub3?.deadline}`);
check('waiters = A+B', pub3?.prepWait?.waiters?.length === 2, JSON.stringify(pub3?.prepWait || {}).slice(0, 80));

// ④ hold 期间仍可操作（v2 核心：等待不锁操作、不算准备状态）——A 刷新商店成功
const actR = await a.request({ t: 'g.refresh' }, 3000).catch(() => ({ t: 'error', code: 'timeout' }));
check('hold 期间玩家操作不被拒绝（等待≠准备）', actR.t === 'ok', actR.t === 'error' ? actR.code : 'act=g.refresh');

// ⑤ A 取消等待 → hold 释放、倒计时恢复（剩余秒数）
const r3 = await a.request({ t: 'g.prepWait', on: false }, 3000).catch(() => ({ t: 'error', code: 'timeout' }));
check('A 取消等待成功', r3.t === 'ok', r3.t === 'error' ? r3.code : '');
const pub5 = await a.waitFor('m.public', (f) => (!f.prepWait || f.prepWait.held === false) && f.deadline > 0, 5000).catch(() => null);
check('取消等待后倒计时恢复（deadline > 0）', !!pub5 && pub5.deadline > 0, `deadline=${pub5?.deadline} prepWait=${JSON.stringify(pub5?.prepWait || {}).slice(0, 60)}`);

// ⑥ 未加入时取消被拒
const r4 = await a.request({ t: 'g.prepWait', on: false }, 3000).catch(() => ({ t: 'error', code: 'timeout' }));
check('未加入时取消被拒（ALREADY）', r4.t === 'error' && r4.code === 'ALREADY', r4.t === 'error' ? r4.code : 'unexpected ok');

// ⑦ 两人重新等待 → hold；B 就绪（就绪不影响等待状态）→ hold 仍成立（等待与准备独立）
await a.request({ t: 'g.prepWait', on: true }, 3000).catch(() => {});
await b.request({ t: 'g.prepWait', on: true }, 3000).catch(() => {});
const pub7 = await a.waitFor('m.public', (f) => f.prepWait?.held === true, 4000).catch(() => null);
check('再次全员等待 ⇒ hold', pub7?.prepWait?.held === true, JSON.stringify(pub7?.prepWait || {}).slice(0, 80));
const rReadyB = await b.request({ t: 'g.ready', ready: true }, 3000).catch(() => ({ t: 'error', code: 'timeout' }));
check('B 就绪成功（等待中也可准备）', rReadyB.t === 'ok', rReadyB.t === 'error' ? rReadyB.code : '');
await new Promise((r) => setTimeout(r, 800));
const pub8 = pubOf(a);
check('B 就绪后 hold 仍成立（等待独立于准备）', pub8?.prepWait?.held === true && pub8?.deadline === 0,
  `held=${pub8?.prepWait?.held} deadline=${pub8?.deadline} phase=${pub8?.phase}`);

// ⑧ B 取消等待 → hold 释放（A 还在等待但不构成全员）→ A 也取消 → 双方就绪推进
const r5 = await b.request({ t: 'g.prepWait', on: false }, 3000).catch(() => ({ t: 'error', code: 'timeout' }));
check('B 取消等待 → hold 释放', r5.t === 'ok', r5.t === 'error' ? r5.code : '');
const pub9 = await a.waitFor('m.public', (f) => (!f.prepWait || f.prepWait.held === false) && f.deadline > 0, 5000).catch(() => null);
check('hold 释放后倒计时恢复', !!pub9 && pub9.deadline > 0, `deadline=${pub9?.deadline}`);
await a.request({ t: 'g.prepWait', on: false }, 3000).catch(() => {});
const rReadyA = await a.request({ t: 'g.ready', ready: true }, 3000).catch(() => ({ t: 'error', code: 'timeout' }));
check('A 就绪', rReadyA.t === 'ok', rReadyA.t === 'error' ? rReadyA.code : '');
await a.waitFor('m.public', (f) => f.phase !== 'PREP', 30000).catch(() => null);
const pub10 = pubOf(a);
check('全员就绪 ⇒ 离开休整期', pub10?.phase && pub10.phase !== 'PREP', `phase=${pub10?.phase}`);

await a.close(); await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
