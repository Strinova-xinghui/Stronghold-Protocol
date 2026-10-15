// 休整期撤回（prepUndo）单测：快照恢复覆盖资金/商店/手牌/棋盘/池占用/DIY 库存/统计，
// 栈管理（深度上限/阶段清栈/失败不入栈/跨回合拒绝），规则开关（关闭时 g.undo 拒绝且不入栈）。
// 用法: node --test tools/prep-undo.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeMatch } from '../test/match/harness.js';
import { createRegistry } from '../server/match/effectsMeta.js';
import { resetCustomRules, CUSTOM_RULES_PATH } from '../server/match/customRules.js';

const QUIET = { warn() {}, error() {}, info() {}, debug() {} };
const REG = createRegistry({ log: QUIET });
const original = fs.readFileSync(CUSTOM_RULES_PATH, 'utf8');

function writeCfg(obj) { fs.writeFileSync(CUSTOM_RULES_PATH, JSON.stringify(obj, null, 2)); resetCustomRules(); }

/** solo 1 人局推进到 PREP round 1，直接把玩家弄成「有钱有地方」状态。 */
function setup(seed = 71) {
  writeCfg({ prepUndo: { enabled: true, maxDepth: 4 } });
  const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', humans: 1, seed, registry: REG, fake: true });
  h.start();
  h.toPrep(1);
  const m = h.m;
  const a = [...m.players.values()].find((p) => !p.isBot);
  a.funds = 50; // 给足钱随便花
  return { m, a, h };
}

/** 找一个棋子槽位买（返回 slot 索引），找不到返回 null。 */
function buyableChessSlot(ps) {
  for (let i = 0; i < ps.shop.slots.length; i++) {
    const s = ps.shop.slots[i];
    if (s && !s.sold && s.kind === 'chess') return i;
  }
  return null;
}

describe('休整期撤回 · 核心恢复', () => {
  test('撤销一次购买：资金/手牌/池占用/统计全部回滚', () => {
    const { m, a } = setup(101);
    const funds0 = a.funds;
    const hand0 = a.hand.map((p) => (p ? p.uid : null));
    const pool0 = m.pool.snapshot();
    const slot = buyableChessSlot(a);
    assert.ok(Number.isInteger(slot), '店里有一个可买的棋子');
    const slotId = a.shop.slots[slot].id;
    const r = m.handle(a.playerId, { t: 'g.buy', slot });
    assert.ok(r.ok, '购买成功');
    assert.equal(a._undoStack.length, 1, '快照入栈');
    const u = m.handle(a.playerId, { t: 'g.undo' });
    assert.ok(u.ok, '撤回成功');
    assert.equal(a.funds, funds0, '资金恢复');
    assert.deepEqual(a.hand.map((p) => (p ? p.uid : null)), hand0, '手牌恢复（含 uid 一致——快照恢复原对象克隆）');
    assert.equal(a.shop.slots[slot].sold, false, '商店槽位恢复可买');
    assert.equal(a.shop.slots[slot].id, slotId, '槽位还是那张卡');
    assert.deepEqual(m.pool.snapshot(), pool0, '共享池占用恢复');
    assert.equal(a.stats.buys, 0, '统计回滚');
    assert.equal(a.round.buys, 0, '每回合计数回滚');
    assert.equal(a._undoStack.length, 0, '栈已弹空');
  });

  test('撤销一次刷新：恢复旧商店面（含 rng 之后的槽位 id）与资金', () => {
    const { m, a } = setup(102);
    const funds0 = a.funds;
    const slots0 = a.shop.slots.map((s) => (s ? s.id : null));
    const r = m.handle(a.playerId, { t: 'g.refresh' });
    assert.ok(r.ok);
    assert.notDeepEqual(a.shop.slots.map((s) => (s ? s.id : null)), slots0, '刷新改变了商店');
    const u = m.handle(a.playerId, { t: 'g.undo' });
    assert.ok(u.ok);
    assert.deepEqual(a.shop.slots.map((s) => (s ? s.id : null)), slots0, '商店面恢复');
    assert.equal(a.funds, funds0, '资金恢复');
    assert.equal(a.round.refreshes, 0, '刷新计数回滚');
  });

  test('连环撤：买→刷→卖 三步全部退回', () => {
    const { m, a } = setup(103);
    const funds0 = a.funds;
    const hand0 = a.hand.map((p) => (p ? p.uid : null));
    const pool0 = m.pool.snapshot();
    const slot = buyableChessSlot(a);
    assert.ok(m.handle(a.playerId, { t: 'g.buy', slot }).ok);
    assert.ok(m.handle(a.playerId, { t: 'g.refresh' }).ok);
    // 卖掉手里随便一个棋子（刚买的那个或原本有的）
    const sellable = a.hand.find((p) => p && p.kind === 'chess');
    if (sellable) assert.ok(m.handle(a.playerId, { t: 'g.sell', uid: sellable.uid }).ok);
    assert.equal(a._undoStack.length, 3, '三步都在栈里');
    for (let i = 0; i < 3; i++) assert.ok(m.handle(a.playerId, { t: 'g.undo' }).ok, '第 ' + (i + 1) + ' 次撤回');
    assert.equal(a.funds, funds0, '资金全恢复');
    assert.deepEqual(a.hand.map((p) => (p ? p.uid : null)), hand0, '手牌全恢复');
    assert.deepEqual(m.pool.snapshot(), pool0, '池占用全恢复');
    assert.equal(a._undoStack.length, 0, '栈空');
    const u4 = m.handle(a.playerId, { t: 'g.undo' });
    assert.ok(!u4.ok, '栈空后再撤 = 报错');
  });

  test('撤回后重做：恢复的槽位可以再买（uid 不冲突）', () => {
    const { m, a } = setup(104);
    const slot = buyableChessSlot(a);
    assert.ok(m.handle(a.playerId, { t: 'g.buy', slot }).ok);
    assert.ok(m.handle(a.playerId, { t: 'g.undo' }).ok);
    const r = m.handle(a.playerId, { t: 'g.buy', slot });
    assert.ok(r.ok, '重买成功');
    assert.equal(a._undoStack.length, 1, '重买重新入栈');
  });

  test('升级商店也可撤：等级/价格/资金回滚', () => {
    const { m, a } = setup(105);
    if (a.shop.level >= (a.gd.maxShopLevel ?? 6)) { a.shop.level = 1; }
    const lv0 = a.shop.level;
    const price0 = a.shop.upgradePrice;
    const funds0 = a.funds;
    const r = m.handle(a.playerId, { t: 'g.levelUp' });
    if (!r.ok) return; // 钱不够（setup 已给 50，一般够）
    assert.ok(a.shop.level > lv0, '升级生效');
    assert.ok(m.handle(a.playerId, { t: 'g.undo' }).ok);
    assert.equal(a.shop.level, lv0, '等级回滚');
    assert.equal(a.shop.upgradePrice, price0, '价格回滚');
    assert.equal(a.funds, funds0, '资金回滚');
  });
});

describe('休整期撤回 · 栈管理', () => {
  test('深度上限：maxDepth=2 时第 3 步挤掉第 1 步', () => {
    writeCfg({ prepUndo: { enabled: true, maxDepth: 2 } });
    const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', humans: 1, seed: 201, registry: REG, fake: true });
    h.start(); h.toPrep(1);
    const m = h.m;
    const a = [...m.players.values()].find((p) => !p.isBot);
    a.funds = 500; // 刷新价 1，够刷几十次
    for (let i = 0; i < 3; i++) {
      const r = m.handle(a.playerId, { t: 'g.refresh' });
      assert.ok(r.ok, '第 ' + (i + 1) + ' 次刷新成功');
    }
    assert.equal(a._undoStack.length, 2, '上限 2（第 3 步挤掉最旧的）');
  });

  test('失败的操作不入栈', () => {
    const { m, a } = setup(202);
    const before = a._undoStack.length;
    const r = m.handle(a.playerId, { t: 'g.buy', slot: 99 }); // 无效槽位 → 失败
    assert.ok(!r.ok, '购买失败');
    assert.equal(a._undoStack.length, before, '失败不入栈');
  });

  test('撤回后 canUndo 归零，m.private 有该字段', () => {
    const { m, a } = setup(203);
    const slot = buyableChessSlot(a);
    m.handle(a.playerId, { t: 'g.buy', slot });
    assert.ok(a.privateView().canUndo >= 1, '有操作可撤');
    m.handle(a.playerId, { t: 'g.undo' });
    assert.equal(a.privateView().canUndo, 0, '撤完归零');
  });
});

describe('休整期撤回 · 开关与边界', () => {
  test('规则关闭：g.undo 拒绝，操作不入栈（原版行为）', () => {
    writeCfg({});
    const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', humans: 1, seed: 301, registry: REG, fake: true });
    h.start(); h.toPrep(1);
    const m = h.m;
    const a = [...m.players.values()].find((p) => !p.isBot);
    const slot = buyableChessSlot(a);
    assert.ok(m.handle(a.playerId, { t: 'g.buy', slot }).ok);
    assert.equal(a._undoStack.length, 0, '关闭时不入栈');
    const u = m.handle(a.playerId, { t: 'g.undo' });
    assert.ok(!u.ok, '拒绝撤回');
  });

  test('跨阶段拒绝：出 PREP 后撤回报错', () => {
    const { m, a, h } = setup(302);
    const slot = buyableChessSlot(a);
    assert.ok(m.handle(a.playerId, { t: 'g.buy', slot }).ok);
    // 推进到下一阶段（结算后再回到 PREP round 2）
    h.drive(() => m.phase === 'PREP' && m.round === 2, { ready: true });
    const u = m.handle(a.playerId, { t: 'g.undo' });
    assert.ok(!u.ok, '跨回合拒绝（栈已清）');
  });

  test('引擎不变量在撤回后仍成立', () => {
    const { m, a, h } = setup(303);
    const slot = buyableChessSlot(a);
    m.handle(a.playerId, { t: 'g.buy', slot });
    m.handle(a.playerId, { t: 'g.refresh' });
    assert.ok(m.handle(a.playerId, { t: 'g.undo' }).ok);
    h.invariants();
  });
});

// 还原配置
test.after?.(undefined);
process.on('exit', () => { fs.writeFileSync(CUSTOM_RULES_PATH, original); });
