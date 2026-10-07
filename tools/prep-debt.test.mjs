// 休整期负债规则（prepDebt）单测：倍率曲线（免赔/超额/盈余/钳制）+ 清算逻辑（负血存活/总和<0 逐个清算）。
// 用法: node --test tools/prep-debt.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeMatch } from '../test/match/harness.js';
import { createRegistry } from '../server/match/effectsMeta.js';
import { resetCustomRules, CUSTOM_RULES_PATH } from '../server/match/customRules.js';

const QUIET = { warn() {}, error() {}, info() {} };
const REG = createRegistry({ log: QUIET });
const original = fs.readFileSync(CUSTOM_RULES_PATH, 'utf8');

function writeCfg(obj) { fs.writeFileSync(CUSTOM_RULES_PATH, JSON.stringify(obj, null, 2)); resetCustomRules(); }

/** coop 2 人局（A=p_0 B=p_1），推进到 PREP round 1，返回 { m, a, b }。 */
function setupCoop(seed = 41) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed, registry: REG, fake: true });
  h.start();
  h.toPrep(1);
  const m = h.m;
  const [a, b] = [...m.players.values()].filter((p) => !p.isBot);
  return { m, a, b };
}

describe('休整期负债规则 · 倍率曲线', () => {
  test('规则关闭：倍率恒 1，敌人波次不带负债注入', () => {
    writeCfg({ rewardOffer: { enabled: false, slots: [] } });
    const { m, a } = setupCoop(11);
    a.lp = -100;
    assert.equal(m._debtEnemyMul(), 1, '关闭时倍率 1（波次自带的 hpMul 与此无关）');
  });

  test('满血队伍：倍率 1（无人负债无盈余）', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, graceMul: 1, cap: 1.3, floor: 0.85 } });
    const { m, a, b } = setupCoop(12);
    const avg = m._debtAvgHp;
    assert.ok(avg > 0, `Ā=${avg} 已计算`);
    a.lp = avg; b.lp = avg;
    assert.equal(m._debtEnemyMul(), 1, 'P=0 ⇒ ×1');
  });

  test('免赔额度：第一份平均血的压力免费（3 个帮 1 个）', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, graceMul: 1, cap: 1.3, floor: 0.85 } });
    const { m, a, b } = setupCoop(13);
    const avg = m._debtAvgHp;
    a.lp = avg; b.lp = avg - avg;   // A 满血、B 归零：总压力恰好 = Ā（在免赔额度内）
    assert.equal(m._debtEnemyMul(), 1, `P=Ā ≤ 免赔额 ⇒ ×1（P=${avg}）`);
    b.lp = -Math.ceil(avg * 0.5);   // B 负债半份：P = 1.5Ā，超额 0.5 份
    const mul = m._debtEnemyMul();
    assert.ok(Math.abs(mul - 1.15) < 1e-9, `超额半份 ⇒ ×1.15（实际 ${mul.toFixed(3)}）`);
  });

  test('负债加深：倍率线性上升并封顶 cap=1.3', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, graceMul: 1, cap: 1.3, floor: 0.85 } });
    const { m, a, b } = setupCoop(14);
    const avg = m._debtAvgHp;
    a.lp = avg; b.lp = avg;
    b.lp = -Math.ceil(avg * 2);   // B 深负债：P = 2Ā + 2Ā = 远超免赔
    const mul = m._debtEnemyMul();
    assert.equal(mul, 1.3, `深负债封顶 cap（${mul}）`);
  });

  test('盈余：高血量策略（歌利亚 45）满血 → 敌人减弱，下限 floor=0.85', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, graceMul: 1, cap: 1.3, floor: 0.85 } });
    const { m, a, b } = setupCoop(15);
    const geliya = Object.values(m.gd.raw.bands).find((x) => x.totalHp === 45);
    assert.ok(geliya, '歌利亚（45 血策略）存在');
    a.lp = geliya.totalHp;          // 45：+19 盈余
    b.lp = Math.ceil(m._debtAvgHp); // 26：基准
    const mul = m._debtEnemyMul();
    assert.ok(mul < 1 && mul >= 0.85, `盈余 ⇒ ${mul.toFixed(3)}（0.85 ≤ mul < 1）`);
    a.lp = 1000;                     // 极端盈余 → floor 封顶
    assert.equal(m._debtEnemyMul(), 0.85, '极端盈余钳制 floor');
  });
});

describe('休整期负债规则 · 清算逻辑', () => {
  test('负债存活：lp ≤ 0 不淘汰（原版此处立即淘汰）', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, graceMul: 1, cap: 1.3, floor: 0.85 } });
    const { m, a, b } = setupCoop(16);
    a.lp = -30; b.lp = 40;
    // 模拟 afterBattle 的清算段（与 Match.afterBattle 相同的循环）
    let guard = m.alivePlayers().length + 1;
    while (m.alivePlayers().reduce((s, p) => s + p.lp, 0) < 0 && guard-- > 0) {
      const debtors = m.alivePlayers().filter((p) => p.lp < 0).sort((x, y) => x.lp - y.lp);
      const ps = debtors[0];
      if (!ps) break;
      ps.lp = 0; ps.eliminate(m.round);
    }
    assert.equal(a.alive, true, '总和 ≥ 0 ⇒ 负债的 A 存活');
    assert.equal(a.lp, -30, '清算未触发（A 保持负债 −30，由 B 的盈余兜住）');
  });

  test('总和 < 0：从最深负债者逐个清算至总和 ≥ 0，死后队友压力减轻', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, graceMul: 1, cap: 1.3, floor: 0.85 } });
    const { m, a, b } = setupCoop(17);
    a.lp = -50; b.lp = 20;
    let guard = m.alivePlayers().length + 1;
    const deaths = [];
    while (m.alivePlayers().reduce((s, p) => s + p.lp, 0) < 0 && guard-- > 0) {
      const debtors = m.alivePlayers().filter((p) => p.lp < 0).sort((x, y) => x.lp - y.lp);
      const ps = debtors[0];
      if (!ps) break;
      deaths.push(ps.playerId);
      ps.lp = 0; ps.eliminate(m.round);
    }
    const sum = m.alivePlayers().reduce((s, p) => s + p.lp, 0);
    assert.ok(sum >= 0, `清算后总和 ≥ 0（${sum}）`);
    assert.equal(m.alivePlayers().length, 1, '只剩 1 人（B 兜住了 A 的部分负债后 A 被清算）');
    assert.equal(deaths[0], 'p_0', '最深的负债者（A）先被清算');
    assert.ok(b.alive, 'B 存活');
  });

  test('全负血队：全员被清算 → 对局结束（eliminated）', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, graceMul: 1, cap: 1.3, floor: 0.85 } });
    const { m, a, b } = setupCoop(18);
    a.lp = -30; b.lp = -30;
    let guard = m.alivePlayers().length + 1;
    while (m.alivePlayers().reduce((s, p) => s + p.lp, 0) < 0 && guard-- > 0) {
      const debtors = m.alivePlayers().filter((p) => p.lp < 0).sort((x, y) => x.lp - y.lp);
      const ps = debtors[0];
      if (!ps) break;
      ps.lp = 0; ps.eliminate(m.round);
    }
    assert.equal(m.alivePlayers().length, 0, '全负血队清算即全灭');
  });
});

describe('休整期负债规则 · 敌人波次注入', () => {
  test('开启后普通波次 spec 的 spawns hpMul = 波次基线 × 负债倍率（同 seed 对比）', () => {
    // 基线：规则关闭、同 seed、同样的深负债状态 → 波次自带的 mods.hpMul（如 0.8）
    writeCfg({ rewardOffer: { enabled: false, slots: [] } });
    const base = setupCoop(19);
    base.a.lp = -Math.ceil(base.m._debtAvgHp * 2);
    const baseSpawns = base.m._normalOpts(base.a).spawns;
    assert.ok(baseSpawns.length > 0, 'spawns 非空');

    // 开启：同 seed、同状态 → 每个 spawn 的 hpMul = 基线 × cap 1.3
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, graceMul: 1, cap: 1.3, floor: 0.85 } });
    const on = setupCoop(19);
    on.a.lp = -Math.ceil(on.m._debtAvgHp * 2);
    assert.equal(on.m._debtEnemyMul(), 1.3, '深负债 ⇒ 倍率顶到 cap');
    const onSpawns = on.m._normalOpts(on.a).spawns;
    assert.equal(onSpawns.length, baseSpawns.length, '同 seed ⇒ spawns 数量一致');
    for (let i = 0; i < onSpawns.length; i++) {
      const bm = baseSpawns[i].mods?.hpMul ?? 1;
      const om = onSpawns[i].mods?.hpMul ?? 1;
      assert.ok(Math.abs(om - bm * 1.3) < 1e-9, `spawn[${i}] hpMul ${om} ≈ 基线 ${bm} × 1.3`);
    }
  });
});

describe('休整期负债规则 · settle 结算接线', () => {
  const LEAK60 = () => ({ leaked: Array.from({ length: 60 }, () => ({ counted: true })), perfect: false, coins: 0, layerGains: {}, killed: 0, damageDealt: 0 });

  test('扣血后负债存活：settle 使 lp ≤ 0 的玩家保持 alive（旧逻辑此处立即淘汰）', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, graceMul: 1, cap: 1.3, floor: 0.85 } });
    const { m, a, b } = setupCoop(20);
    m.phase = 'COMBAT';
    a.lp = 5; b.lp = 26;
    m.lastResults.set(a.playerId, LEAK60());       // 漏 60 ⇒ loss = min(cap 10, 60) = 10
    m.settle(null, null);
    assert.equal(a.lp, -5, `A 扣血进入负债（lp=${a.lp}）`);
    assert.equal(a.alive, true, '负债的 A 存活（旧逻辑此处已被淘汰）');
    assert.ok(b.alive && b.lp > 0, 'B 满血不受影响');
  });

  test('负债后倍率 > 1（敌人波次增强）', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, graceMul: 1, cap: 1.3, floor: 0.85 } });
    const { m, a, b } = setupCoop(21);
    m.phase = 'COMBAT';
    a.lp = 5; b.lp = 26;
    m.lastResults.set(a.playerId, LEAK60());
    m.settle(null, null);
    const mul = m._debtEnemyMul();
    assert.ok(mul > 1 && mul <= 1.3, `负债后倍率 ${mul.toFixed(3)} ∈ (1, 1.3]`);
  });

  test('总和 < 0 ⇒ 逐个清算最深负债者（B 先于 A），全灭时对局结束', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, graceMul: 1, cap: 1.3, floor: 0.85 } });
    const { m, a, b } = setupCoop(22);
    m.phase = 'COMBAT';
    a.lp = 5; b.lp = 3;
    m.lastResults.set(a.playerId, LEAK60());   // A → −5
    m.lastResults.set(b.playerId, LEAK60());   // B → 3−10 = −7（最深）
    m.settle(null, null);
    // 总和 −12 < 0 ⇒ 清算：B(−7) 先死 → 总和 −5 仍 < 0 ⇒ A(−5) 死 → 全灭
    assert.equal(a.alive, false, 'A 被清算');
    assert.equal(b.alive, false, 'B（最深负债）先被清算');
    assert.equal(m.alivePlayers().length, 0, '全灭');
    m.afterSettle();   // 原流程：结算定时器后检查全灭 ⇒ finish
    assert.equal(m.ended, true, '全灭 ⇒ 对局结束（eliminated）');
  });
});
