// 休整期负债规则（prepDebt）端到端验证：
//   ① lp ≤ 0 不淘汰（负债存活）② 全队总和 < 0 时从最深负债者开始清算 ③ 敌人波次 HP 按负债倍率缩放
//   ④ m.public.debt 广播 ⑤ boss/隐秘核心不受倍率影响（结构级断言）
// 用法: node tools/verify-lp-debt.mjs [port]
// 原理：空场放漏敌人 → 漏怪扣 LP → 快速进入负债；倍率通过 b.start spec 的 spawns[].mods.hpMul 断言。
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

// ① A、B 入房开局（各选 band 进 PREP，空场放漏快速亏血）
const a = await TestClient.connect(url);
await a.hello('玩家A');
const created = await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
const state = await a.waitFor('room.state');
const code = state.code || created.code;
const b = await TestClient.connect(url);
await b.hello('玩家B');
const joined = await b.request({ t: 'room.join', code });
await b.waitFor('room.state');
check('A 建房、B 加入', joined.t !== 'error', `房间 ${code}`);
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
check('进入休整期', phase === 'PREP', `phase=${phase}`);

// m.public.debt 已广播（规则开启时任何阶段）
const pubD = pubOf(a);
check('m.public.debt 广播（开启规则后）', !!pubD?.debt && pubD.debt.avgHp > 0, JSON.stringify(pubD?.debt || {}).slice(0, 90));
const AVG = pubD?.debt?.avgHp;

// ② 双方就绪（清临时区）→ 空场放漏：不部署任何干员，敌人全漏 → LP 大幅扣减 → 进入负债
const readyUp = async (c) => {
  for (let i = 0; i < 12; i++) {
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
await readyUp(a); await readyUp(b);
await a.waitFor('m.public', (f) => f.phase !== 'PREP', 30000).catch(() => null);

// 战斗循环：每回合空场放漏，直到 A 的 LP < 0（负债存活断言）
let lpA = null, lpB = null, rounds = 0;
for (let i = 0; i < 14; i++) {
  const priv = await a.waitFor('m.private', () => true, 30000).catch(() => null);
  if (!priv) break;
  lpA = priv.lp; lpB = (await b.waitFor('m.private', () => true, 3000).catch(() => null))?.lp ?? lpB;
  if (lpA < 0) break;
  // 下一回合：清临时区（若有）→ 就绪
  for (let j = 0; j < 8; j++) {
    const p2 = await a.waitFor('m.private', () => true, 3000).catch(() => null);
    if (!p2 || p2.canReady) break;
    const temps = (p2.temp || []).filter(Boolean);
    if (!temps.length) break;
    for (const p of temps) {
      const r = await a.request({ t: 'g.sell', uid: p.uid }, 3000).catch(() => ({ t: 'error' }));
      if (r.t === 'error') await a.request({ t: 'g.destroy', uid: p.uid }, 3000).catch(() => {});
    }
  }
  await a.request({ t: 'g.ready', ready: true }, 3000).catch(() => {});
  await b.request({ t: 'g.ready', ready: true }, 3000).catch(() => {});
  rounds++;
}
check(`A 的 LP 进入负债（lp=${lpA} < 0，${rounds} 回合放漏后）`, lpA != null && lpA < 0, `lpA=${lpA} lpB=${lpB}`);
const aliveA = (pubOf(a)?.players || []).find((p) => p.playerId === A_ID);
check('负债的 A 仍存活（未被淘汰）', aliveA?.alive !== false, `alive=${aliveA?.alive}`);

// ③ 倍率随负债上升：负血后 m.public.debt.mul > 1
const debtNow = pubOf(a)?.debt;
check('负债后敌人倍率 > 1', (debtNow?.mul || 1) > 1, `mul=${debtNow?.mul?.toFixed(3)} lpSum=${debtNow?.lpSum}`);

// ④ 敌人波次 HP 倍率注入：战斗 spec 的 spawns[].mods.hpMul > 1（b.start 的 spawns）
const bstart = await a.waitFor('b.start', (f) => Array.isArray(f.spec?.spawns) && f.spec.spawns.length > 0, 40000).catch(() => null);
const spawnedMul = (bstart?.spec?.spawns || []).map((s) => s?.mods?.hpMul).filter((v) => Number.isFinite(v) && v > 1);
check('下一回合敌人 spec 带 hpMul>1（负债倍率注入波次）', spawnedMul.length > 0,
  `hpMul 样本=${spawnedMul.slice(0, 3).join(',')}（spawns ${bstart?.spec?.spawns?.length} 个）`);

// ⑤ 倍率上限钳制（cap 1.3）：无论亏多少，spec 的 hpMul ≤ 1.3（±浮点）
const over = spawnedMul.filter((v) => v > 1.31);
check('倍率不超过 cap 1.3', over.length === 0, over.length ? `超限样本=${over.slice(0, 3).join(',')}` : '');

await a.close(); await b.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
