// 休整期撤回（prepUndo）单测：快照恢复覆盖资金/商店/手牌/棋盘/池占用/DIY 库存/统计，
// 栈管理（深度上限/阶段清栈/失败不入栈/跨回合拒绝），规则开关（关闭时 g.undo 拒绝且不入栈）。
// 用法: node --test tools/prep-undo.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeMatch } from '../test/match/harness.js';
import { createRegistry } from '../server/match/effectsMeta.js';
import { canPlace, placeClass } from '../server/match/board.js';
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

  test('反 SL：商店刷新撤回后重刷，得到同一面（免费刷商店堵死）', () => {
    writeCfg({ prepUndo: { enabled: true, maxDepth: 4 } });
    const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', humans: 1, seed: 909, registry: REG, fake: true });
    h.start(); h.toPrep(1);
    const m = h.m;
    const a = [...m.players.values()].filter((p) => !p.isBot)[0];
    a.funds = 500;
    const face = () => a.shop.slots.map((s) => (s ? s.id : null)).join(',');
    const f0 = face();
    assert.ok(m.handle(a.playerId, { t: 'g.refresh' }).ok);
    const f1 = face();
    assert.notEqual(f1, f0, '刷新改变商店');
    assert.ok(m.handle(a.playerId, { t: 'g.undo' }).ok, '撤回');
    assert.equal(face(), f0, '旧面恢复');
    assert.ok(m.handle(a.playerId, { t: 'g.refresh' }).ok, '重刷');
    assert.equal(face(), f1, '重刷得到同一面——SL 刷商店被堵死');
  });

  test('反 SL：随机效果（拟态物质随机同盟约干员）撤回后重做结果一致', () => {
    writeCfg({ prepUndo: { enabled: true, maxDepth: 4 } });
    const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', humans: 1, seed: 888, registry: REG, fake: true });
    h.start(); h.toPrep(1);
    const m = h.m;
    const a = [...m.players.values()].filter((p) => !p.isBot)[0];
    a.funds = 99;
    const itemId = 'chess_item_5_05_e_a'; // 拟态物质（consume_on_equip，owned<2 → 随机同盟约干员）
    assert.ok(m.gd.item(itemId), '拟态物质在数据中');
    const ids = [...m.pool.entries.keys()].filter((id) => m.gd.chess(id));
    const anyChess = ids.find((id) => Array.isArray(m.gd.chess(id).bonds) && m.gd.chess(id).bonds.length);
    // 一个无同款副本的棋盘干员 → 装备走随机分支
    const target = a.newPiece('chess', anyChess, { poolCopies: 1 });
    const dmap = a.deployMap();
    let at = null;
    outer: for (let r = 9; r <= 12; r++) for (let c = 2; c <= 10; c++) { if (canPlace(dmap, placeClass(a, m.gd.chess(anyChess)), r, c)) { at = r + ',' + c; break outer; } }
    a.board.set(at, target);
    a.recompute();
    const gotOf = () => (a.hand.find((p) => p && p.kind === 'chess' && p.id !== anyChess) || {}).id || null;
    // 第一次装备
    const it1 = a.newPiece('item', itemId);
    a.hand[1] = it1;
    assert.ok(m.handle(a.playerId, { t: 'g.equip', itemUid: it1.uid, targetUid: target.uid }).ok);
    const got1 = gotOf();
    assert.ok(got1, '随机分支生效（获得 ' + got1 + '）');
    // 撤回 → 重做：结果必须一致（反 SL）
    assert.ok(m.handle(a.playerId, { t: 'g.undo' }).ok);
    const it2 = a.newPiece('item', itemId);
    a.hand[1] = it2;
    assert.ok(m.handle(a.playerId, { t: 'g.equip', itemUid: it2.uid, targetUid: target.uid }).ok);
    const got2 = gotOf();
    assert.equal(got2, got1, '重装备得到同一干员（' + got1 + '），SL 刷随机被堵死');
    h.invariants();
  });

  test('多人并发：A 买→B 买同一干员→A 撤回，只还 A 的份额（池恒等式闭合）', () => {
    writeCfg({ prepUndo: { enabled: true, maxDepth: 4 } });
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 304, registry: REG, fake: true });
    h.start(); h.toPrep(1);
    const m = h.m;
    const [a, b] = [...m.players.values()].filter((p) => !p.isBot);
    a.funds = 99; b.funds = 99;
    const base = m.pool.entries.keys().next().value; // 池里随便一个 base
    a.shop.slots[0] = { kind: 'chess', id: base, basePrice: 1, frozen: false, sold: false };
    b.shop.slots[0] = { kind: 'chess', id: base, basePrice: 1, frozen: false, sold: false };
    const left0 = m.pool.entries.get(base).left;
    const cap = m.pool.entries.get(base).cap;
    assert.ok(m.handle(a.playerId, { t: 'g.buy', slot: 0 }).ok);
    assert.ok(m.handle(b.playerId, { t: 'g.buy', slot: 0 }).ok);
    assert.equal(m.pool.entries.get(base).left, left0 - 2, '两买后池 -2');
    assert.ok(m.handle(a.playerId, { t: 'g.undo' }).ok, 'A 撤回');
    assert.equal(m.pool.entries.get(base).left, left0 - 1, '只还 A 的份额（B 的还在占用）');
    // B 的棋子不受影响
    const bHas = [...b.hand, ...b.temp].some((p) => p && p.kind === 'chess' && m.gd.baseIdOf(p.id) === base);
    assert.ok(bHas, 'B 买的棋子还在');
    h.invariants(); // left + held == cap 全场恒等式闭合
  });
});

// 还原配置
test.after?.(undefined);
process.on('exit', () => { fs.writeFileSync(CUSTOM_RULES_PATH, original); });

// ---- 消费计数器撤回（2026-10-15 用户实测漏洞）：绮良【通关奖励】每花 20 资金给随机干员，
// counters 不在快照里 ⇒ 买/刷→撤回→再买 无限累计 acc ⇒ 白刷干员。修复 = counters 入快照。
describe('休整期撤回 · 策略计数器（绮良/潘格尼尼/克劳妮/商业包装）', () => {
  /** solo 局指定策略推进到 PREP R1。 */
  function setupBand(bandId, seed = 141) {
    writeCfg({ prepUndo: { enabled: true, maxDepth: 32 } });
    const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', humans: 1, seed, registry: REG, fake: true });
    h.start();
    h.toPrep(1, { band: bandId });
    const m = h.m;
    const a = [...m.players.values()].find((p) => !p.isBot);
    a.funds = 99;
    return { m, a, h };
  }

  test('绮良：买→撤回后 acc 计数器回滚（撤回不能白刷干员）', () => {
    const { m, a } = setupBand('band_kirara', 141);
    assert.equal(a.counters['band:kirara:acc'] || 0, 0, '起始 acc=0');
    const slot = buyableChessSlot(a);
    assert.ok(Number.isInteger(slot));
    const price = a.shop.slots[slot].basePrice;
    assert.ok(m.handle(a.playerId, { t: 'g.buy', slot }).ok);
    assert.ok((a.counters['band:kirara:acc'] || 0) > 0, '绮良策略生效：买一次 acc 增长（价格 ' + price + '）');
    assert.ok(a.hand.filter(Boolean).length >= 1, '买入后手牌至少 1 个');
    assert.ok(m.handle(a.playerId, { t: 'g.undo' }).ok, '撤回成功');
    assert.equal(a.counters['band:kirara:acc'] || 0, 0, '撤回后 acc 回滚到 0（漏洞版：停在 ' + price + '，反复撤回=白刷）');
    assert.equal(a.hand.filter(Boolean).length, 0, '手牌回到买入前（空）');
  });

  test('绮良：acc=19 时买→撤回，acc 与触发奖励都精确回滚', () => {
    const { m, a } = setupBand('band_kirara', 142);
    a.counters['band:kirara:acc'] = 19;
    const slot = buyableChessSlot(a);
    const price = a.shop.slots[slot].basePrice;
    const hand0 = a.hand.filter(Boolean).length;
    assert.ok(m.handle(a.playerId, { t: 'g.buy', slot }).ok);
    // 19+price ≥ 20：触发发干员，acc 变为 19+price-20
    assert.ok(a.hand.filter(Boolean).length > hand0 - 1, '触发检查（发干员进手牌/临时区）');
    assert.ok(m.handle(a.playerId, { t: 'g.undo' }).ok);
    assert.equal(a.counters['band:kirara:acc'], 19, 'acc 回到 19（漏洞版：' + (19 + price - 20) + '，下次买 ' + (21 - price) + ' 就能再刷）');
    assert.equal(a.hand.filter(Boolean).length, hand0, '白送的干员随撤回收回');
  });

  test('通用：counters 全量随快照回滚（任意策略/效果计数器）', () => {
    const { m, a } = setupBand('band_kirara', 143);
    a.counters['t:manual'] = 7;
    assert.ok(m.handle(a.playerId, { t: 'g.refresh' }).ok);
    assert.ok(m.handle(a.playerId, { t: 'g.undo' }).ok);
    assert.equal(a.counters['t:manual'], 7, '手动计数器不受撤回影响地回滚到快照值');
  });
});

describe('休整期撤回 · 效果计数器（用户 2026-10-15 报：绮良【通关奖励】刷新再撤回白攒计数器）', () => {
  test('绮良：刷新→撤回循环不涨 band:kirara:acc，不白送干员', () => {
    const { m, a } = setup(777);
    a.bandId = 'band_kirara'; // 【通关奖励】每使用 20 资金获得 1 名随机干员（acc 计数器在 ps.counters）
    a.recompute();
    a.funds = 300; // 够 20+ 次刷新（refreshPrice 1）
    const hand0 = a.hand.filter(Boolean).length;
    const price = m.gd.refreshPrice || 1;
    const loops = Math.ceil(20 / price) + 5; // 阈值 20 资金 + 余量
    for (let i = 0; i < loops; i++) {
      const r = m.handle(a.playerId, { t: 'g.refresh' });
      assert.ok(r.ok, '第 ' + i + ' 次刷新成功');
      const u = m.handle(a.playerId, { t: 'g.undo' });
      assert.ok(u.ok, '第 ' + i + ' 次撤回成功');
    }
    assert.equal(a.counters['band:kirara:acc'] || 0, 0, 'acc 计数器随撤回回滚（漏洞表现：一路涨到 20 白送干员）');
    assert.equal(a.funds, 300, '资金没漏（撤回已覆盖）');
    assert.equal(a.hand.filter(Boolean).length, hand0, '没有白送的干员进手牌');
  });

  test('潘格尼尼：累计花费计数器同样回滚（55 阈值不靠 SL 凑）', () => {
    const { m, a } = setup(778);
    a.bandId = 'band_paganini'; // 【定制铳械】累计花费 55 后给 1 名 4 阶+ 拉特兰精锐
    a.recompute();
    a.funds = 300;
    const price = m.gd.refreshPrice || 1;
    const loops = Math.ceil(55 / price) + 3;
    for (let i = 0; i < loops; i++) {
      assert.ok(m.handle(a.playerId, { t: 'g.refresh' }).ok);
      assert.ok(m.handle(a.playerId, { t: 'g.undo' }).ok);
    }
    assert.equal(a.counters['band:paganini:spent'] || 0, 0, 'spent 计数器回滚');
    assert.equal(a.counters['band:paganini:done'] || 0, 0, 'done 标志未点亮');
  });
});

describe('休整期撤回 · 效果计数器（绮良漏洞，用户 2026-10-15 报告）', () => {
  test('绮良「每花 20 资金给随机干员」：刷新→撤回循环不得白嫖累加计数器', () => {
    const { m, a } = setup(207);
    a.bandId = 'band_kirara';
    const step = (m.gd.band('band_kirara').params || {}).coin_cnt || 20;
    const hand0 = a.hand.filter(Boolean).length;
    const accSeen = [];
    // 每次刷新花 1 元、撤回返还 1 元：钱一分没花。若 acc 不随撤回回滚，
    // 刷 step 轮就把 acc 白攒满 → 凭空多一个随机干员（无限刷干员）。
    for (let i = 0; i < step + 5; i++) {
      const r = m.handle(a.playerId, { t: 'g.refresh' });
      assert.ok(r.ok, 'refresh ' + i + ': ' + JSON.stringify(r));
      const u = m.handle(a.playerId, { t: 'g.undo' });
      assert.ok(u.ok, 'undo ' + i + ': ' + JSON.stringify(u));
      accSeen.push(a.counters['band:kirara:acc'] || 0);
    }
    assert.ok(accSeen.every((x) => x === 0), 'acc 必须恒 0（撤回回滚计数器），实际: ' + accSeen.join(','));
    assert.equal(a.hand.filter(Boolean).length, hand0, '一次干员都不该白给');
  });
});

describe('休整期撤回 · 效果可写持久字段（教鞭/机变/装置覆写，同一泄漏类）', () => {
  test('教鞭（chess_item_6_03_m）：用→选卡→撤回 g.art，bounty/personalChoice/round.arts 全回滚', () => {
    const { m, a } = setup(880);
    const ART = 'chess_item_6_03_m';
    assert.ok(m.gd.item(ART), '教鞭在数据里');
    a.funds = 99;
    const p = a.acquireItem(ART, { source: 'test' });
    assert.ok(p, '教鞭进手牌');
    const b0 = a.bounties.length;
    const arts0 = a.round.arts;
    const r = m.handle(a.playerId, { t: 'g.art', itemUid: p.uid, row: 10, col: 5 });
    assert.ok(r.ok, '教鞭使用成功: ' + (r.detail || r.error || ''));
    assert.ok(a.personalChoice, '开出三选一');
    const pc = a.personalChoice;
    const pick = m.handle(a.playerId, { t: 'g.choice', idx: 0, choiceId: pc.id });
    assert.ok(pick.ok, '选卡成功: ' + (pick.detail || pick.error || ''));
    assert.equal(a.bounties.length, b0 + 1, 'bounty +1');
    assert.equal(a.round.arts, arts0 + 1, 'arts 计数 +1');
    assert.ok(!a.hand.some((x) => x && x.uid === p.uid), '教鞭已消耗');
    const u = m.handle(a.playerId, { t: 'g.undo' });
    assert.ok(u.ok, '撤回 g.art 成功');
    assert.equal(a.bounties.length, b0, '漏洞版：bounty 留着 = 教鞭回手再选一次，白刷行动合约');
    assert.equal(a.personalChoice, null, 'personalChoice 清空');
    assert.equal(a.round.arts, arts0, 'arts 计数回滚');
    assert.ok(a.hand.some((x) => x && x.uid === p.uid), '教鞭回手');
  });

  test('通用：效果意图期间写入的 effects/counters/覆写随撤回回滚', () => {
    const { m, a } = setup(881);
    a.counters['t:probe'] = 3;
    a.deviceOverrides = { turret: true };
    a.deployCapMin = 5;
    const eff0 = a.effects.length;
    // 快照在 g.refresh 执行前拍（此刻 effects=eff0、overrides=turret、capMin=5）
    assert.ok(m.handle(a.playerId, { t: 'g.refresh' }).ok);
    // 模拟「意图执行期间的效果写入」（ctx.addEffect / setDeviceActive / setDeployCapAtLeast 的实际效果）
    a.effects.push({ id: 'probe:1', key: 'effect:none', name: '探针', desc: '', iconKind: 'choice', battle: false, params: {}, data: {} });
    a.counters['t:probe'] = 9;
    a.deviceOverrides = { turret: false, shield: true };
    a.deployCapMin = 8;
    assert.ok(m.handle(a.playerId, { t: 'g.undo' }).ok);
    assert.equal(a.effects.length, eff0, '探针效果被撤回（快照值 eff0）');
    assert.equal(a.counters['t:probe'], 3, 'counters 回到快照值');
    assert.deepEqual(a.deviceOverrides, { turret: true }, '装置覆写回到快照值');
    assert.equal(a.deployCapMin, 5, 'deployCapMin 回到快照值');
  });
});
