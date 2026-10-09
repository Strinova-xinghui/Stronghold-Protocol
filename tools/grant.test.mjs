// 控制台实时发放（2026-10-09）端到端验证：server/match/grant.js applyGrants → 真实 Match 的 PlayerState。
// 断言下钻到「真的拿到了什么」：hand/temp 里的棋子 id、精锐形态、数量、自动合成、整备区满失败。
// 用法: node --test tools/grant.test.mjs（不碰 custom-rules.json，可与其他测试并行）
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeMatch } from '../test/match/harness.js';
import { getData } from '../server/data.js';
import { applyGrants } from '../server/match/grant.js';

const DATA = getData({ quiet: true });

/** 建一个 prep 中的 solo 对局，清空棋盘/手牌/暂存，返回 { h, m, ps }。 */
function setup(seed = 41) {
  const h = makeMatch({ mode: 'solo', humans: 1, seed, fake: true }).start();
  h.toPrep(1);
  const m = h.m;
  const ps = h.ps('p_0');
  for (const p of [...ps.board.values(), ...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)]) if (p.kind === 'chess') ps.returnCopies(p);
  ps.board.clear(); ps.hand.fill(null); ps.temp.fill(null); ps.offers.length = 0;
  ps.recompute();
  return { h, m, ps };
}

/** 数据里的普通（非精锐）干员 id，按 tier 从低到高。 */
function normalChessIds(n) {
  return Object.values(DATA.chess)
    .filter((c) => c.visible && !c.isGolden && c.goldenId)
    .sort((a, b) => a.tier - b.tier)
    .slice(0, n)
    .map((c) => c.chessId);
}
function ownedIds(ps) {
  return [...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean), ...[...ps.board.values()].filter(Boolean)]
    .map((p) => p.id);
}

describe('applyGrants：棋子', () => {
  test('发普通棋子 → 进手牌，flush 后 onGain 广播', () => {
    const { h, m, ps } = setup();
    const [id] = normalChessIds(1);
    const sentBefore = h.sent.length;
    const res = applyGrants(m, ps, [{ kind: 'chess', id }]);
    assert.equal(res.length, 1);
    assert.equal(res[0].ok, true, res[0].error || '');
    assert.equal(res[0].granted.length, 1);
    assert.ok(ownedIds(ps).includes(res[0].granted[0]), `发放的棋子 ${res[0].granted[0]} 不在 hand/temp/board 里`);
    m.flush(); // 与生产一致：consoleApiGrant 在 applyGrants 后调 flush（发放不是客户端动作，没人替它 flush）
    assert.ok(h.sent.length > sentBefore, 'flush 后没有向客户端发任何帧（m.private 未广播）');
    h.invariants();
  });

  test('elite:true 发普通 id → 直接拿精锐（_b，isGolden）', () => {
    const { h, m, ps } = setup();
    const [id] = normalChessIds(1);
    const res = applyGrants(m, ps, [{ kind: 'chess', id, elite: true }]);
    assert.equal(res[0].ok, true, res[0].error || '');
    const piece = [...ps.hand.filter(Boolean), ...ps.temp.filter(Boolean)][0];
    assert.ok(piece, '没有拿到棋子');
    assert.equal(piece.id, DATA.chess[id].goldenId, `期望精锐 ${DATA.chess[id].goldenId}，实际 ${piece.id}`);
    assert.equal(DATA.chess[piece.id].isGolden, true);
    h.invariants();
  });

  test('直接发 _b id → 同样是精锐', () => {
    const { h, m, ps } = setup();
    const [id] = normalChessIds(1);
    const res = applyGrants(m, ps, [{ kind: 'chess', id: DATA.chess[id].goldenId }]);
    assert.equal(res[0].ok, true, res[0].error || '');
    assert.ok(ownedIds(ps).includes(res[0].granted[0]));
    assert.equal(DATA.chess[res[0].granted[0]].isGolden, true);
    h.invariants();
  });

  test('count=3 → 拿到 3 张', () => {
    const { h, m, ps } = setup();
    const [id, id2] = normalChessIds(2);
    const res = applyGrants(m, ps, [{ kind: 'chess', id, count: 2 }, { kind: 'chess', id: id2, count: 1 }]);
    assert.equal(res[0].granted.length, 2, `count=2 实际 ${res[0].granted.length}`);
    assert.equal(res[1].granted.length, 1);
    assert.equal(ownedIds(ps).length, 3);
    h.invariants();
  });

  test('已有 2 张同干员时发第 3 张 → 按游戏规则自动合成精锐', () => {
    const { h, m, ps } = setup();
    const [id] = normalChessIds(1);
    const need = m.gd.mergeCount(id);
    assert.ok(need > 1, `该干员不可合成`);
    for (let i = 0; i < need - 1; i++) applyGrants(m, ps, [{ kind: 'chess', id }]);
    const owned = ownedIds(ps).filter((x) => x === id).length;
    assert.equal(owned, need - 1);
    const res = applyGrants(m, ps, [{ kind: 'chess', id }]);
    assert.equal(res[0].ok, true, res[0].error || '');
    assert.equal(DATA.chess[res[0].granted[0]].isGolden, true, `发第 ${need} 张后应合成精锐，实际 ${res[0].granted[0]}`);
    h.invariants();
  });

  test('无效 id → ok:false + 明确错误', () => {
    const { h, m, ps } = setup();
    const res = applyGrants(m, ps, [{ kind: 'chess', id: 'chess_char_nonexistent_a' }]);
    assert.equal(res[0].ok, false);
    assert.match(res[0].error, /没有这个棋子/);
  });
});

describe('applyGrants：装备', () => {
  test('发普通装备 → 进手牌', () => {
    const { h, m, ps } = setup();
    const item = Object.values(DATA.items).find((r) => r.itemType === 'EQUIP' && !r.isGolden && r.goldenId);
    assert.ok(item, '数据里没有可发装备');
    const res = applyGrants(m, ps, [{ kind: 'item', id: item.itemId || item.id }]);
    assert.equal(res[0].ok, true, res[0].error || '');
    assert.ok(ownedIds(ps).includes(res[0].granted[0]), `装备 ${res[0].granted[0]} 不在 hand/temp 里`);
    h.invariants();
  });

  test('elite:true 发装备 → 直接拿进阶形态（goldenId）', () => {
    const { h, m, ps } = setup();
    const item = Object.values(DATA.items).find((r) => r.itemType === 'EQUIP' && !r.isGolden && r.goldenId);
    const res = applyGrants(m, ps, [{ kind: 'item', id: item.itemId || item.id, elite: true }]);
    assert.equal(res[0].ok, true, res[0].error || '');
    assert.equal(res[0].id, item.goldenId);
    assert.ok(ownedIds(ps).includes(item.goldenId), `进阶装备 ${item.goldenId} 不在 hand/temp 里`);
    h.invariants();
  });

  test('装备按游戏规则自动合成（已拥有足够数量时）', () => {
    const { h, m, ps } = setup();
    const item = Object.values(DATA.items).find((r) => r.itemType === 'EQUIP' && !r.isGolden && r.goldenId && (r.upgradeNum ?? 2) === 2);
    assert.ok(item, '数据里没有 upgradeNum=2 的装备');
    applyGrants(m, ps, [{ kind: 'item', id: item.itemId || item.id }]);
    const res = applyGrants(m, ps, [{ kind: 'item', id: item.itemId || item.id }]);
    assert.equal(res[0].ok, true, res[0].error || '');
    assert.equal(res[0].granted[0], item.goldenId, `第 2 件同类装备应自动合成进阶，实际 ${res[0].granted[0]}`);
    h.invariants();
  });
});

describe('applyGrants：边界', () => {
  test('整备区（手牌10+暂存5）满 → 发放失败且不静默', () => {
    const { h, m, ps } = setup();
    const ids = normalChessIds(16);
    assert.ok(ids.length >= 16, `数据里普通干员不足 16 个`);
    // 前 15 个不同干员填满手牌 + 暂存（不同 id 不触发合成）
    const res15 = applyGrants(m, ps, ids.slice(0, 15).map((id) => ({ kind: 'chess', id })));
    assert.ok(res15.every((r) => r.ok), '填满 15 格失败');
    assert.equal(ownedIds(ps).length, 15);
    const res = applyGrants(m, ps, [{ kind: 'chess', id: ids[15] }]);
    assert.equal(res[0].ok, false);
    assert.match(res[0].error, /整备区已满/);
    assert.equal(ownedIds(ps).length, 15, '失败发放不应改变所有权');
    h.invariants();
  });

  test('缺 kind/id → ok:false；超出 20 条截断', () => {
    const { h, m, ps } = setup();
    const res = applyGrants(m, ps, [{ id: 'x' }, { kind: 'chess' }]);
    assert.equal(res.length, 2);
    assert.ok(res.every((r) => !r.ok));
    const many = applyGrants(m, ps, Array.from({ length: 30 }, (_, i) => ({ kind: 'chess', id: `x_${i}` })));
    assert.ok(many.length <= 20, `30 条应截断到 ≤20，实际 ${many.length}`);
  });
});
