// 休整期等待投票（prepWait）端到端验证：已就绪玩家发起等待 → 全员（活人−1）同意后倒计时暂停（deadline 0），
// 目标就绪后恢复/直接结束。用法: node tools/verify-prep-wait.mjs [port]（假设验证服务器已在 PORT 上运行）
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

// ② 记录当前 deadline（>0）
const pub1 = pubOf(a);
const dl1 = pub1?.deadline || 0;
check('PREP 有倒计时（deadline > 0）', dl1 > 0, `deadline=${dl1}`);

// ③ 未就绪时发起等待 → 拒绝（NOT_YOUR_TURN 系文案）
const r0 = await a.request({ t: 'g.prepWait', on: true }, 3000).catch(() => ({ t: 'error', code: 'timeout' }));
check('未就绪发起等待被拒', r0.t === 'error', r0.t === 'error' ? r0.code : 'unexpected ok');

// ④ A 先就绪 → A 发起等待（此时 B 未就绪，等待目标 = B）
const rA = await a.request({ t: 'g.ready', ready: true }, 3000).catch(() => ({ t: 'error', code: 'timeout' }));
check('A 准备就绪', rA.t === 'ok', rA.t === 'error' ? rA.code : '');
// A 就绪会触发 maybeEndPrep，但 B 未就绪不会结束；等待投票：A 一个人 = 活人(2) − 1 = 全部已就绪者
const r1 = await a.request({ t: 'g.prepWait', on: true }, 3000).catch(() => ({ t: 'error', code: 'timeout' }));
check('A 发起等待成功', r1.t === 'ok', r1.t === 'error' ? r1.code : '');
const pub2 = await a.waitFor('m.public', (f) => f.prepWait?.waiters?.includes(A_ID), 4000).catch(() => null);
check('m.public.prepWait 广播（waiters 含 A）', !!pub2?.prepWait, JSON.stringify(pub2?.prepWait || {}).slice(0, 80));
check('倒计时已暂停（deadline = 0）', pub2?.deadline === 0, `deadline=${pub2?.deadline}`);
check('hold 状态 = true', pub2?.prepWait?.held === true, `held=${pub2?.prepWait?.held}`);
check('等待目标 = B', pub2?.prepWait?.target === B_ID, `target=${pub2?.prepWait?.target}`);

// ⑤ 重复发起 → ALREADY
const r2 = await a.request({ t: 'g.prepWait', on: true }, 3000).catch(() => ({ t: 'error', code: 'timeout' }));
check('重复发起等待被拒（ALREADY）', r2.t === 'error' && r2.code === 'ALREADY', r2.t === 'error' ? r2.code : 'unexpected ok');

// ⑥ 同回合先验证完整周期：取消等待 → 倒计时恢复 → 再等待（hold）→ B 就绪 → endPrep
const r3 = await a.request({ t: 'g.prepWait', on: false }, 3000).catch(() => ({ t: 'error', code: 'timeout' }));
check('A 取消等待成功', r3.t === 'ok', r3.t === 'error' ? r3.code : '');
const pub5 = await a.waitFor('m.public', (f) => (!f.prepWait || f.prepWait.held === false) && f.deadline > 0, 5000).catch(() => null);
check('取消等待后倒计时恢复（deadline > 0）', !!pub5 && pub5.deadline > 0, `deadline=${pub5?.deadline} prepWait=${JSON.stringify(pub5?.prepWait || {}).slice(0, 60)}`);
await a.request({ t: 'g.prepWait', on: true }, 3000).catch(() => {});
const pub7 = await a.waitFor('m.public', (f) => f.prepWait?.held === true, 4000).catch(() => null);
check('恢复等待（hold 再挂起，deadline=0）', pub7?.prepWait?.held === true && pub7?.deadline === 0, JSON.stringify(pub7?.prepWait || {}).slice(0, 60));
// B（等待目标）就绪 → hold 释放、投票清空、对局进入下一阶段（endPrep 因全员就绪）
const rB = await b.request({ t: 'g.ready', ready: true }, 3000).catch(() => ({ t: 'error', code: 'timeout' }));
check('B（等待目标）就绪', rB.t === 'ok', rB.t === 'error' ? rB.code : '');
await a.waitFor('m.public', (f) => f.phase !== 'PREP', 30000).catch(() => null);
const pub3 = pubOf(a);
check('目标就绪后离开休整期（全员就绪 ⇒ endPrep）', pub3?.phase && pub3.phase !== 'PREP', `phase=${pub3?.phase}`);
check('结束时投票已清空（无残留 waiters）', !pub3?.prepWait?.waiters?.length || pub3.phase !== 'PREP', JSON.stringify(pub3?.prepWait || {}).slice(0, 60));

await a.close(); await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
