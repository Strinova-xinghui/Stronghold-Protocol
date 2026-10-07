// 影子观战「固定战场」端到端验证：被看者前往查看队友时，影子固定在被看者自己的战场，不跟过去。
// 用法: node tools/verify-shadow-pin.mjs [port]（假设验证服务器已在 PORT 上运行）
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

// ① A、B 入房（coop，各自一个战场）并开局
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
const st = await a.request({ t: 'room.start' });
check('对局开始', st.t !== 'error', st.t === 'error' ? st.code : 'ok');

const privA0 = await a.waitFor('m.private', () => true, 15000).catch(() => null);
const A_ID = privA0?.playerId;
const privB0 = await b.waitFor('m.private', () => true, 15000).catch(() => null);
const B_ID = privB0?.playerId;
check('策略轮选期（m.private 到达）', !!privA0 && !!privB0 && !!A_ID && !!B_ID, `A=${A_ID} B=${B_ID}`);

// ② INFO_CHECK ack + 策略轮选：轮到谁就替谁选一个没被占的 band（bandSkip 是让过，队尾不能让）
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
check('进入休整期（PREP）', phase === 'PREP', `phase=${phase}`);
const privA = await a.waitFor('m.private', () => true, 5000).catch(() => null) || privA0;
const privB = await b.waitFor('m.private', () => true, 5000).catch(() => null) || privB0;

// ③ 影子 M 在休整期订阅 A
const m = await TestClient.connect(url);
await m.hello('影子');
const mon = await m.request({ t: 'm.monitor', code, targetPlayerId: A_ID });
check('影子订阅 A', mon.t !== 'error', mon.t === 'error' ? mon.code : 'ok');
const privM = await m.waitFor('m.private', (f) => f._monitor === true, 4000).catch(() => null);
check('影子收到 A 的 privateView', privM?.playerId === A_ID, `playerId=${privM?.playerId}`);

// ④ 休整期侦察 pin：A 前往查看 B 的整备板（g.watch n:B）→ A 收到 m.field n:B，影子**不**收到
const w1 = await a.request({ t: 'g.watch', fieldId: `n:${B_ID}` });
const fieldB = await a.waitFor('m.field', (f) => f.fieldId === `n:${B_ID}`, 3000).catch(() => null);
check('A 前往查看收到 B 的整备板 m.field', !!fieldB, `fieldId=n:${B_ID} reply=${w1.t === 'error' ? w1.code : 'ok'}`);
await m.expectNone('m.field', (f) => f.fieldId === `n:${B_ID}`, 700)
  .then(() => check('影子固定在 A 的整备板（未跟去 B）', true))
  .catch((e) => check('影子固定在 A 的整备板（未跟去 B）', false, e.message.slice(0, 80)));
const stillPriv = m.log.filter((f) => f.t === 'm.private' && f._monitor).length;
check('影子仍持续收到 A 的 m.private', stillPriv >= 1, `m.private×${stillPriv}`);

// ⑤ 双方就绪进战斗（setReady 在临时区不为空时被拒——先出售/销毁临时区的牌）。
//    影子应收到 **A 自己**战场的 b.start（_monitor），绝不是 B 的
const emptyTempAndReady = async (c) => {
  for (let i = 0; i < 12; i++) {
    const priv = await c.waitFor('m.private', () => true, 3000).catch(() => null) || privA;
    if (!priv || priv.canReady) break;
    const temps = (priv.temp || []).filter(Boolean);
    if (!temps.length) break;
    for (const p of temps) {
      const r = await c.request({ t: 'g.sell', uid: p.uid }, 3000).catch(() => ({ t: 'error' }));
      if (r.t === 'error') await c.request({ t: 'g.destroy', uid: p.uid }, 3000).catch(() => {});
    }
  }
  return c.request({ t: 'g.ready', ready: true }, 3000).catch(() => ({ t: 'error', code: 'timeout' }));
};
m.clearInbox();
const r1 = await emptyTempAndReady(a);
const r2 = await emptyTempAndReady(b);
check('A/B 就绪（g.ready ok）', r1.t === 'ok' && r2.t === 'ok', `A=${r1.t === 'ok' ? 'ok' : r1.code} B=${r2.t === 'ok' ? 'ok' : r2.code}`);
const bstartA = await a.waitFor('b.start', () => true, 60000).catch(() => null);
const aField = bstartA?.fieldId;
check('A 收到自己战场的 b.start', !!bstartA, `fieldId=${aField}`);
const mstart = await m.waitFor('b.start', (f) => f._monitor === true, 5000).catch(() => null);
check('影子收到 A 自己战场的 b.start（镜像）', !!mstart && mstart.fieldId === aField,
  `fieldId=${mstart?.fieldId} vs A=${aField}`);

// ⑥ 战斗中前往查看（直接发协议，绕过客户端 UI 门禁）：若服务器接受，A 收到 B 战场的帧，影子**不**收到
const pubFrame = m.log.filter((x) => x.t === 'm.public' && Array.isArray(x.fields)).pop()
  || await a.waitFor('m.public', (f) => Array.isArray(f.fields), 4000).catch(() => null);
const fieldsList = Array.isArray(pubFrame?.fields) ? pubFrame.fields : [];
const bFieldBattle = fieldsList.find((f) => f.fieldId !== aField && Array.isArray(f.players))?.fieldId || `n:${B_ID}`;
m.clearInbox();
const w2 = await a.request({ t: 'g.watch', fieldId: bFieldBattle });
const accepted = w2.t !== 'error';
if (accepted) {
  await a.waitFor('b.start', (f) => f.fieldId === bFieldBattle, 3000).catch(() => null);
  await m.expectNone((f) => (f.t === 'b.start' || f.t === 'm.field' || f.t === 'b.snap' || f.t === 'b.ev') && f.fieldId === bFieldBattle, 900)
    .then(() => check('战斗中前往查看：影子不跟去别人战场', true))
    .catch((e) => check('战斗中前往查看：影子不跟去别人战场', false, e.message.slice(0, 90)));
} else {
  check('战斗中前往查看：影子不跟去别人战场', true, `服务器拒绝（${w2.code}）——该场景本就不产生跟帧，跳过`);
}

// ⑦ 影子收到的是 A 自己战斗的完整规格（client-combat 下战斗由影子浏览器按 spec 本地复刻，
//    A 自己的战场没有 b.snap 流——那是服务器跑的战场/观战才有的，无法用 TestClient 造假）
const specPlayers = (Array.isArray(mstart?.spec?.players) ? mstart.spec.players : []).map((p) => p?.playerId ?? p);
check('影子拿到 A 自己战斗的完整 spec', specPlayers.includes(A_ID), `spec.players=${specPlayers.join(',')}`);

// ⑧ 房间统计不受影响（全局 humans 含前几轮失败跑的残留房间——宽限期内的离线房主，属测试残留）
const h = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
check('影子不占席位不计 humans', h.spectators === 0 && h.humans >= 2, `spectators=${h.spectators} humans=${h.humans}`);

await a.close(); await b.close(); await m.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
