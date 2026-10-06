// 「装备甄选」验证：真实 Match → 商店装备槽抽取是否按主盟约阵营提高出率
// 用法: node --test tools/item-pick.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeMatch } from '../test/match/harness.js';
import { createRegistry } from '../server/match/effectsMeta.js';
import { getData } from '../server/data.js';
import { resetCustomRules, CUSTOM_RULES_PATH } from '../server/match/customRules.js';

const DATA = getData({ quiet: true });
const QUIET = { warn() {}, error() {}, info() {} };
const REG = createRegistry({ log: QUIET });
const original = fs.readFileSync(CUSTOM_RULES_PATH, 'utf8');
const writeCfg = (obj) => { fs.writeFileSync(CUSTOM_RULES_PATH, JSON.stringify(obj, null, 2)); resetCustomRules(); };

function setup(seed = 41) {
  const h = makeMatch({ mode: 'solo', humans: 1, seed, registry: REG, fake: true }).start();
  h.toPrep(1);
  const m = h.m;
  for (const ps of m.players.values()) {
    for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
    ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null); ps.offers.length = 0;
    ps.funds = 50; ps.layers = {}; ps.pendingFunds = 0; ps.shop.freeRefreshes = 0; ps.bandId = null;
    ps.recompute();
  }
  return { h, m, ps: h.ps('p_0') };
}

/** 摆 n 个带某盟约的干员到场上，使其激活。 */
function stageBond(ps, m, bond, n) {
  let placed = 0;
  for (const c of Object.values(DATA.chess)) {
    if (placed >= n) break;
    if (!c.visible || c.isGolden || !Array.isArray(c.bonds) || !c.bonds.includes(bond)) continue;
    if (!m.pool.has(c.chessId) || m.pool.left(c.chessId) <= 0) continue;
    const piece = ps.acquireChess(c.chessId, { fromPool: true });
    if (!piece) continue;
    ps.board.set(`9,${placed}`, piece);
    placed++;
  }
  ps.recompute();
  return placed;
}

/** 采样装备槽 N 次，返回 { target, other }（target = 属于 `bond` 的装备）。 */
function sampleItems(ps, bond, n) {
  let target = 0, other = 0;
  for (let i = 0; i < n; i++) {
    const slot = ps._rollItemSlot();
    if (!slot) continue;
    const rec = DATA.items[slot.id];
    if (rec && rec.giveBondId === bond) target++; else other++;
  }
  return { target, other };
}

describe('装备甄选 · 商店装备槽', () => {
  test('关闭时：目标阵营装备出率 = 基线（原版行为）', () => {
    writeCfg({ itemOffer: { enabled: false } });
    const { m, ps } = setup(5);
    const n = stageBond(ps, m, 'yanShip', 3);
    assert.ok(n >= 1, `摆上炎国干员 (${n})`);
    ps.m.round = 10;
    const { target, other } = sampleItems(ps, 'yanShip', 3000);
    const rate = target / (target + other);
    // 基线：炎国短刀是 T3 层众多装备之一，出率应较低（<20%）
    assert.ok(rate < 0.2, `关闭时出率应低（实测 ${(rate * 100).toFixed(1)}%）`);
  });

  test('开启（weight ×2）：目标阵营装备出率显著提高', () => {
    const { m, ps } = setup(5);
    const n = stageBond(ps, m, 'yanShip', 3);
    assert.ok(n >= 1, `摆上炎国干员 (${n})`);
    // 先测基线
    writeCfg({ itemOffer: { enabled: false } });
    ps.m.round = 10;
    const base = sampleItems(ps, 'yanShip', 4000);
    const baseRate = base.target / (base.target + base.other);
    // 再开甄选
    writeCfg({ itemOffer: { enabled: true, minRound: 6, mult: 2, mode: 'weight', targetBond: 'mainCount', minCount: 3, onTierMiss: 'fallback' } });
    const boosted = sampleItems(ps, 'yanShip', 4000);
    const boostedRate = boosted.target / (boosted.target + boosted.other);
    console.log(`      基线 ${(baseRate * 100).toFixed(2)}% → 甄选后 ${(boostedRate * 100).toFixed(2)}%`);
    assert.ok(boostedRate > baseRate * 1.3, `出率应显著提高（${(baseRate * 100).toFixed(2)}% → ${(boostedRate * 100).toFixed(2)}%）`);
  });

  test('回合门槛：minRound 之前不生效', () => {
    writeCfg({ itemOffer: { enabled: true, minRound: 6, mult: 2, mode: 'weight', targetBond: 'mainCount', minCount: 3 } });
    const { m, ps } = setup(5);
    stageBond(ps, m, 'yanShip', 3);
    ps.m.round = 3; // 未到门槛
    const early = sampleItems(ps, 'yanShip', 3000);
    const earlyRate = early.target / (early.target + early.other);
    ps.m.round = 10; // 已过门槛
    const late = sampleItems(ps, 'yanShip', 3000);
    const lateRate = late.target / (late.target + late.other);
    console.log(`      门槛前 ${(earlyRate * 100).toFixed(2)}% → 门槛后 ${(lateRate * 100).toFixed(2)}%`);
    assert.ok(lateRate > earlyRate * 1.3, '门槛后应显著提高');
  });

  test('固定 targetBond（如 yanShip）也能工作', () => {
    writeCfg({ itemOffer: { enabled: true, minRound: 0, mult: 3, mode: 'weight', targetBond: 'yanShip', minCount: 3 } });
    const { m, ps } = setup(5);
    // 不摆炎国干员（mainCount 会是别的盟约），但固定指定 yanShip
    ps.m.round = 10;
    const { target, other } = sampleItems(ps, 'yanShip', 4000);
    const rate = target / (target + other);
    console.log(`      固定 yanShip ×3 → 出率 ${(rate * 100).toFixed(2)}%`);
    assert.ok(rate > 0.15, `固定盟约应生效（${(rate * 100).toFixed(2)}%）`);
  });

  test('filter 模式：装备槽必须给出该阵营装备（tier 落空时回退）', () => {
    writeCfg({ itemOffer: { enabled: true, minRound: 0, mult: 2, mode: 'filter', targetBond: 'kjeragShip', minCount: 3, onTierMiss: 'fallback' } });
    const { m, ps } = setup(5);
    ps.m.round = 12;
    ps.shop.level = 6; // 高级商店：tier 层大概率不含 T5 的谢拉格不融冰 → 触发 fallback
    let hit = 0, total = 0;
    for (let i = 0; i < 200; i++) {
      const slot = ps._rollItemSlot();
      if (!slot) continue;
      total++;
      const rec = DATA.items[slot.id];
      if (rec && rec.giveBondId === 'kjeragShip') hit++;
    }
    console.log(`      filter + fallback：${hit}/${total} 命中谢拉格装备`);
    assert.equal(hit, total, 'filter 模式应 100% 命中（回退保证）');
  });
});

process.on('exit', () => { try { fs.writeFileSync(CUSTOM_RULES_PATH, original); } catch {} });
