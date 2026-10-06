// 「定向甄选」端到端验证（用项目正规 harness）：真实 Match → 晋升奖励三选一 → 断言候选按主/副盟约筛选
// 用法: node --test tools/directed-pick.test.mjs   （或 node tools/directed-pick.test.mjs 直接跑）
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

function writeCfg(obj) { fs.writeFileSync(CUSTOM_RULES_PATH, JSON.stringify(obj, null, 2)); resetCustomRules(); }

/** 建一个 prep 中的 solo 对局，清空棋盘/手牌，返回 { m, ps }。 */
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

/** 找一个带盟约 `bond` 的普通干员（池内有余量）。 */
const chessWithBond = (m, bond, pred = () => true) => Object.values(DATA.chess)
  .find((c) => c.visible && !c.isGolden && Array.isArray(c.bonds) && c.bonds.includes(bond) && m.pool.has(c.chessId) && m.pool.left(c.chessId) > 0 && pred(c));

/** 造局面：给 ps 场上放 n 个带某盟约的干员（用 acquireChess + 直接进 board 计数）。 */
function stageBond(ps, m, bond, n) {
  let placed = 0;
  for (const c of Object.values(DATA.chess)) {
    if (placed >= n) break;
    if (!c.visible || c.isGolden || !Array.isArray(c.bonds) || !c.bonds.includes(bond)) continue;
    if (!m.pool.has(c.chessId) || m.pool.left(c.chessId) <= 0) continue;
    const piece = ps.acquireChess(c.chessId, { fromPool: true });
    if (!piece) continue;
    ps.hand[placed] = piece; // 放整备区即计入 BOARD 计数（countMode BOARD 只算 board？——两者都算 membership）
    placed++;
  }
  ps.recompute();
  return placed;
}

describe('定向甄选 · 三选一奖励', () => {
  test('配置关闭时：三选一候选与盟约无关（原版行为）', () => {
    writeCfg({ rewardOffer: { enabled: false, slots: [] } });
    const { m, ps } = setup(7);
    const offer = ps.pushRewardOffer('merge');
    assert.ok(offer, 'offer 生成');
    assert.equal(offer.slots.length, 3, '3 张候选');
    // 关闭时不保证任何盟约 → 只验证能正常生成、无异常
  });

  test('主盟约（count≥3）筛选：第一张候选必属该盟约', () => {
    writeCfg({ rewardOffer: { enabled: true, slots: [{ slot: 0, kind: 'mainCount', minCount: 3, mult: 2 }] } });
    const { m, ps } = setup(11);
    // 找一个人数能到 3 的盟约（核心盟约阈值 3）
    const core = Object.values(DATA.bonds).find((b) => b.isCore && Array.isArray(b.thresholds) && b.thresholds[0] === 3);
    const n = stageBond(ps, m, core.bondId, 3);
    assert.ok(n >= 1, `摆上 ${core.name} 干员（实际 ${n} 个）`);
    // 保证该盟约 active（若 membership 需 board 才算，则直接放 board）
    if (!ps.bonds[core.bondId]?.active) {
      let i = 0;
      for (const [key, piece] of [...ps.hand.entries()]) {
        if (piece && i < 4) { ps.board.set(`9,${i}`, piece); ps.hand[key] = null; i++; }
      }
      ps.recompute();
    }
    const b = ps.bonds[core.bondId];
    assert.ok(b && b.active, `${core.name} 已激活 (count=${b && b.count})`);
    const offer = ps.pushRewardOffer('merge');
    assert.ok(offer, 'offer 生成');
    const first = DATA.chess[offer.slots[0].id];
    assert.ok(first.bonds.includes(core.bondId), `第一张 ${first.name} 应属 ${core.name}，实际 bonds=${JSON.stringify(first.bonds)}`);
  });

  test('副盟约（层数最多，排除独行/经济）筛选：第二张候选必属该盟约', () => {
    writeCfg({ rewardOffer: { enabled: true, slots: [{ slot: 1, kind: 'maxLayers', minCount: 2, mult: 2 }] } });
    const { m, ps } = setup(23);
    // 找一个 addon 盟约（阈值 2），摆 2 人并给层数
    const addon = Object.values(DATA.bonds).find((b) => !b.isCore && Array.isArray(b.thresholds) && b.thresholds[0] === 2
      && !['visiShip', 'miraShip', 'investShip', 'soloShip'].includes(b.bondId));
    stageBond(ps, m, addon.bondId, 2);
    if (!ps.bonds[addon.bondId]?.active) {
      let i = 0;
      for (const [key, piece] of [...ps.hand.entries()]) {
        if (piece && i < 2) { ps.board.set(`9,${i}`, piece); ps.hand[key] = null; i++; }
      }
      ps.recompute();
    }
    ps.layers[addon.bondId] = 7; // 人为给层数
    ps.recompute();
    const offer = ps.pushRewardOffer('merge');
    assert.ok(offer, 'offer 生成');
    const second = DATA.chess[offer.slots[1].id];
    assert.ok(second.bonds.includes(addon.bondId), `第二张 ${second.name} 应属 ${addon.name}，实际 bonds=${JSON.stringify(second.bonds)}`);
  });

  test('排除规则：独行/经济盟约不会被选为副盟约目标', () => {
    writeCfg({ rewardOffer: { enabled: true, slots: [{ slot: 0, kind: 'maxLayers', minCount: 1, mult: 2 }] } });
    const { m, ps } = setup(31);
    // 只给「远见」（经济类）激活 + 高层数
    stageBond(ps, m, 'visiShip', 2);
    if (!ps.bonds.visiShip?.active) {
      let i = 0;
      for (const [key, piece] of [...ps.hand.entries()]) {
        if (piece && i < 2) { ps.board.set(`9,${i}`, piece); ps.hand[key] = null; i++; }
      }
      ps.recompute();
    }
    ps.layers.visiShip = 99;
    ps.recompute();
    const offer = ps.pushRewardOffer('merge');
    assert.ok(offer, 'offer 生成');
    const first = DATA.chess[offer.slots[0].id];
    assert.ok(!first.bonds.includes('visiShip'), `远见应被排除，但第一张是 ${first.name}`);
  });
});

// 收尾：恢复原始配置
process.on('exit', () => { try { fs.writeFileSync(CUSTOM_RULES_PATH, original); } catch {} });
