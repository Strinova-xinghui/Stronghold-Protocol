// 「定向甄选」端到端验证（用项目正规 harness）：真实 Match → 晋升奖励三选一 → 断言候选按主/副盟约加权/筛选
// 用法: node --test tools/directed-pick.test.mjs
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
  const ps = h.ps('p_0');
  for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
  ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null); ps.offers.length = 0;
  ps.funds = 50; ps.layers = {}; ps.pendingFunds = 0; ps.shop.freeRefreshes = 0; ps.bandId = null;
  ps.shop.level = 5;
  ps.recompute();
  return { h, m, ps };
}

/** 把 n 个带 `bond` 的干员放到 BOARD（countMode 需要 board 才算激活）。 */
function stageBondBoard(ps, m, bond, n) {
  let placed = 0, col = 0;
  for (const c of Object.values(DATA.chess)) {
    if (placed >= n) break;
    if (!c.visible || c.isGolden || !Array.isArray(c.bonds) || !c.bonds.includes(bond)) continue;
    if (!m.pool.has(c.chessId) || m.pool.left(c.chessId) <= 0) continue;
    const piece = ps.acquireChess(c.chessId, { fromPool: true });
    if (!piece) continue;
    ps.board.set(`9,${col++}`, piece);
    placed++;
  }
  ps.recompute();
  return placed;
}

/** slot 0 命中该盟约的比例（n 次三选一）。 */
function hitRate(ps, bond, n = 800) {
  let hit = 0, total = 0;
  for (let i = 0; i < n; i++) {
    const offer = ps.pushRewardOffer('merge');
    ps.offers.length = 0;
    if (!offer?.slots?.[0] || offer.slots[0].kind !== 'chess') continue;
    total++;
    const rec = DATA.chess[offer.slots[0].id];
    if (rec && Array.isArray(rec.bonds) && rec.bonds.includes(bond)) hit++;
  }
  return { rate: hit / Math.max(1, total), total };
}

describe('定向甄选 · 三选一奖励', () => {
  test('配置关闭时：三选一候选与盟约无关（原版行为）', () => {
    writeCfg({ rewardOffer: { enabled: false, slots: [] } });
    const { m, ps } = setup(7);
    stageBondBoard(ps, m, 'yanShip', 3);
    const offer = ps.pushRewardOffer('merge');
    assert.ok(offer, 'offer 生成');
    assert.equal(offer.slots.length, 3, '3 张候选');
    assert.equal(ps._rewardOfferPlan(3), null, '规则关闭 ⇒ plan 为 null（纯随机）');
  });

  test('weight 模式（默认，2026-10-07 改）：主盟约候选命中率显著高于基线，但不强制命中', () => {
    writeCfg({ rewardOffer: { enabled: true, slots: [{ slot: 0, kind: 'mainCount', minCount: 3, mult: 2.6, mode: 'weight' }] } });
    const { m, ps } = setup(11);
    const n = stageBondBoard(ps, m, 'yanShip', 3);
    assert.ok(n >= 3, `摆上 ${n} 个炎国干员`);
    assert.ok(ps.bonds.yanShip?.active, '炎国已激活');
    const plan = ps._rewardOfferPlan(3);
    assert.equal(plan[0]?.mode, 'weight', 'slot 0 走 weight 模式');
    assert.equal(plan[0]?.bond, 'yanShip', '目标盟约 = 炎国');
    const { rate, total } = hitRate(ps, 'yanShip', 800);
    assert.ok(total > 700, `样本足够（${total}）`);
    // weight 不强制命中：既应显著高于基线（13~15%），也不该是 100%
    assert.ok(rate > 0.20, `命中率应显著提升（实测 ${(rate * 100).toFixed(1)}% > 20%）`);
    assert.ok(rate < 0.95, `weight 模式不强制命中（实测 ${(rate * 100).toFixed(1)}% < 95%）`);
  });

  test('weight 提高 mult 会进一步提高命中率（单调性）', () => {
    const rateAt = (mult) => {
      writeCfg({ rewardOffer: { enabled: true, slots: [{ slot: 0, kind: 'mainCount', minCount: 3, mult, mode: 'weight' }] } });
      const { m, ps } = setup(11);
      stageBondBoard(ps, m, 'yanShip', 3);
      return hitRate(ps, 'yanShip', 600).rate;
    };
    const low = rateAt(2);
    const high = rateAt(8);
    assert.ok(high > low, `mult 8 (${(high * 100).toFixed(1)}%) 应高于 mult 2 (${(low * 100).toFixed(1)}%)`);
  });

  test('filter 模式（可选）：第一张候选必属该盟约', () => {
    writeCfg({ rewardOffer: { enabled: true, slots: [{ slot: 0, kind: 'mainCount', minCount: 3, mult: 2, mode: 'filter' }] } });
    const { m, ps } = setup(12);
    stageBondBoard(ps, m, 'yanShip', 3);
    const { rate } = hitRate(ps, 'yanShip', 200);
    assert.equal(rate, 1, 'filter 模式 100% 命中（回退保证）');
  });

  test('副盟约（maxLayers）定向：层数最多的盟约被选中', () => {
    writeCfg({ rewardOffer: { enabled: true, slots: [{ slot: 0, kind: 'maxLayers', minCount: 2, mult: 2.6, mode: 'weight' }] } });
    const { m, ps } = setup(23);
    const addon = Object.values(DATA.bonds).find((b) => !b.isCore && Array.isArray(b.thresholds) && b.thresholds[0] === 2
      && !['visiShip', 'miraShip', 'investShip', 'soloShip'].includes(b.bondId));
    stageBondBoard(ps, m, addon.bondId, 2);
    ps.layers[addon.bondId] = 7;
    ps.recompute();
    const plan = ps._rewardOfferPlan(3);
    assert.equal(plan[0]?.bond, addon.bondId, `目标应为 ${addon.name}`);
  });

  test('排除规则：独行/经济盟约不会被选为副盟约目标', () => {
    writeCfg({ rewardOffer: { enabled: true, slots: [{ slot: 0, kind: 'maxLayers', minCount: 1, mult: 2 }] } });
    const { m, ps } = setup(31);
    stageBondBoard(ps, m, 'visiShip', 2);
    ps.layers.visiShip = 99;
    ps.recompute();
    const plan = ps._rewardOfferPlan(3);
    // plan 为 null（无可选目标）或 slot0 不是 visiShip 都算正确——远见被排除
    assert.ok(plan === null || plan[0]?.bond !== 'visiShip', `远见（经济类）应被排除，实际 plan=${JSON.stringify(plan)}`);
  });
});

process.on('exit', () => { try { fs.writeFileSync(CUSTOM_RULES_PATH, original); } catch {} });
