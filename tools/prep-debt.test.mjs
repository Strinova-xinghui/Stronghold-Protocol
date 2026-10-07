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
const originalConfig = original;

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

describe('休整期负债规则 · 倍率曲线（v3 净负债）', () => {
  test('规则关闭：倍率恒 1，敌人波次不带负债注入', () => {
    writeCfg({ rewardOffer: { enabled: false, slots: [] } });
    const { m, a } = setupCoop(11);
    a.lp = -100;
    assert.equal(m._debtEnemyMul(), 1, '关闭时倍率 1（波次自带的 hpMul 与此无关）');
  });

  test('满血 26：×1（无人负债无存款）', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, cap: 1.05, floor: 0.85 } });
    const { m, a, b } = setupCoop(12);
    const avg = m._debtAvgHp;
    assert.ok(avg > 0, `Ā=${avg} 已计算`);
    a.lp = avg; b.lp = avg;
    assert.equal(m._debtEnemyMul(), 1, 'net=0 ⇒ ×1');
  });

  test('三人 lp = 1/3/3（无负血无存款）：×1 —— 用户截图场景，v2 会误判为深负债惩罚', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, cap: 1.05, floor: 0.85 } });
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 3, seed: 12, registry: REG, fake: true });
    h.start(); h.toPrep(1);
    const m = h.m;
    const humans = [...m.players.values()].filter((p) => !p.isBot);
    assert.equal(humans.length, 3, '3 名人类玩家');
    humans[0].lp = 1; humans[1].lp = 3; humans[2].lp = 3;
    // v3：都 > 0 ⇒ 无负债；都 < Ā ⇒ 无存款 ⇒ net=0 ⇒ ×1（v2 的压力公式在此会算出超额 ⇒ 误判为负债惩罚）
    assert.equal(m._debtEnemyMul(), 1, '血量低于平均但未负血 ⇒ 不惩罚（v3 核心语义）');
  });

    test('一人 −20 队友满血：net=20 超过 cap 触发点 ⇒ ×1.05（钳制生效）', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, cap: 1.05, floor: 0.85 } });
    const { m, a, b } = setupCoop(13);
    const avg = m._debtAvgHp;
    a.lp = -20; b.lp = avg;
    const uncapped = 1 + 0.3 * 20 / avg;
    assert.ok(uncapped > 1.05, `未钳倍率 ${uncapped.toFixed(4)} > cap（net=20 ⇒ 触发点 net ≥ Ā×(1.05−1)/0.3 ≈ 4.33）`);
    assert.equal(m._debtEnemyMul(), 1.05, 'cap 钳制生效');
  });

  test('一人 −20 + 歌利亚 45 满血：savings=19, net=1 ⇒ ×1.0115（存款对冲负债）', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, cap: 1.05, floor: 0.85 } });
    const { m, a, b } = setupCoop(14);
    const avg = m._debtAvgHp;
    a.lp = -20; b.lp = 45;   // 歌利亚满血：savings = 45 − 26 = 19
    const net = 20 - (45 - avg);
    assert.equal(net, 1, `net = 20 − ${45 - avg} = 1`);
    const expected = 1 + 0.3 * net / avg;
    assert.ok(Math.abs(m._debtEnemyMul() - expected) < 1e-9, `net=1 ⇒ ${expected.toFixed(4)}（实际 ${m._debtEnemyMul().toFixed(4)}）`);
  });

  test('歌利亚满血 + 队友满血：net=−19 ⇒ ×0.8904（存款减弱敌人）', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, cap: 1.05, floor: 0.85 } });
    const { m, a, b } = setupCoop(15);
    const avg = m._debtAvgHp;
    const geliya = Object.values(m.gd.raw.bands).find((x) => x.totalHp === 45);
    assert.ok(geliya, '歌利亚（45 血策略）存在');
    a.lp = geliya.totalHp;   // 45：savings = 45 − 26 = 19
    b.lp = avg;
    const expected = 1 - 0.15 * 19 / avg;
    assert.ok(Math.abs(m._debtEnemyMul() - expected) < 1e-9, `net=−19 ⇒ ${expected.toFixed(4)}（实际 ${m._debtEnemyMul().toFixed(4)}）`);
  });

  test('深负债：倍率线性上升并封顶 cap=1.05', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, cap: 1.05, floor: 0.85 } });
    const { m, a, b } = setupCoop(14);
    const avg = m._debtAvgHp;
    a.lp = avg; b.lp = -Math.ceil(avg * 2);   // B 深负债：net = 2Ā ⇒ ×1.6 → cap
    assert.equal(m._debtEnemyMul(), 1.05, `深负债封顶 cap（${m._debtEnemyMul()}）`);
  });

  test('极端盈余：下限 floor=0.85', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, cap: 1.05, floor: 0.85 } });
    const { m, a, b } = setupCoop(15);
    a.lp = 1000;                     // 极端盈余 → floor 封顶
    assert.equal(m._debtEnemyMul(), 0.85, '极端盈余钳制 floor');
  });
});

describe('休整期负债规则 · 清算逻辑', () => {
  test('负债存活：lp ≤ 0 不淘汰（原版此处立即淘汰）', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, cap: 1.05, floor: 0.85 } });
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
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, cap: 1.05, floor: 0.85 } });
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
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, cap: 1.05, floor: 0.85 } });
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

    // 开启：同 seed、同状态 → 每个 spawn 的 hpMul = 基线 × cap 1.05
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, cap: 1.05, floor: 0.85 } });
    const on = setupCoop(19);
    on.a.lp = -Math.ceil(on.m._debtAvgHp * 2);
    assert.equal(on.m._debtEnemyMul(), 1.05, '深负债 ⇒ 倍率顶到 cap');
    const onSpawns = on.m._normalOpts(on.a).spawns;
    assert.equal(onSpawns.length, baseSpawns.length, '同 seed ⇒ spawns 数量一致');
    for (let i = 0; i < onSpawns.length; i++) {
      const bm = baseSpawns[i].mods?.hpMul ?? 1;
      const om = onSpawns[i].mods?.hpMul ?? 1;
      assert.ok(Math.abs(om - bm * 1.05) < 1e-9, `spawn[${i}] hpMul ${om} ≈ 基线 ${bm} × 1.05`);
    }
  });
});

describe('休整期负债规则 · settle 结算接线', () => {
  const LEAK60 = () => ({ leaked: Array.from({ length: 60 }, () => ({ counted: true })), perfect: false, coins: 0, layerGains: {}, killed: 0, damageDealt: 0 });

  test('扣血后负债存活：settle 使 lp ≤ 0 的玩家保持 alive（旧逻辑此处立即淘汰）', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, cap: 1.05, floor: 0.85 } });
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
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, cap: 1.05, floor: 0.85 } });
    const { m, a, b } = setupCoop(21);
    m.phase = 'COMBAT';
    a.lp = 5; b.lp = 26;
    m.lastResults.set(a.playerId, LEAK60());
    m.settle(null, null);
    const mul = m._debtEnemyMul();
    assert.ok(mul > 1 && mul <= 1.05, `负债后倍率 ${mul.toFixed(3)} ∈ (1, 1.05]`);
  });

  test('总和 < 0 ⇒ 逐个清算最深负债者（B 先于 A），全灭时对局结束', () => {
    writeCfg({ prepDebt: { enabled: true, k: 0.3, k2: 0.15, cap: 1.05, floor: 0.85 } });
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

// 恢复用户真实配置（测试 writeCfg 会覆盖 config/custom-rules.json，不恢复会污染线上热参数）
process.on('exit', () => { try { fs.writeFileSync(CUSTOM_RULES_PATH, originalConfig); } catch { /* ignore */ } });
