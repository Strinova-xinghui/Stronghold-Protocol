// BOSS 血量倍率（bossHp）单测：最终系数 = mul × 层数折算；热改对未开打的 BOSS 生效；audit/Match 同口径。
// 用法: node --test tools/boss-hp.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeMatch } from '../test/match/harness.js';
import { createRegistry } from '../server/match/effectsMeta.js';
import { getData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';
import { bossPoolHp } from '../server/match/finalAssault.js';
import { resetCustomRules, CUSTOM_RULES_PATH } from '../server/match/customRules.js';

const DATA = getData({ quiet: true });
const REG = createRegistry({ log: { warn() {}, error() {}, info() {} } });
const original = fs.readFileSync(CUSTOM_RULES_PATH, 'utf8');
const writeCfg = (o) => { fs.writeFileSync(CUSTOM_RULES_PATH, JSON.stringify(o, null, 2)); resetCustomRules(); };
const gdOf = () => new GameData(DATA, 'mode_multi_normal');
const bossHp = (o) => ({ bossHp: { enabled: true, mul: 1, layerK: 0.0005, layerFloor: 0, layerCap: 5, ...o } });

describe('BOSS 血量 · 配置解析', () => {
  test('关闭（默认）：bossHpMul 返回 1（官方）', () => {
    writeCfg({});
    assert.ok(gdOf().bossHpMul('boss_1', 9999) === 1, '官方原值');
  });

  test('数值钳制：mul ≤100、layerK ≤1、layerCap ≥1', () => {
    writeCfg({ bossHp: { enabled: true, mul: 999, layerK: 9, layerFloor: -5, layerCap: 0 } });
    const gd = gdOf();
    const mul = gd.bossHpMul('boss_1', 100000);
    // mul 钳到 100；layerCap 钳到 ≥1 且 layerMul=min(1, …)=1 ⇒ 最终 = 100
    assert.ok(mul <= 100, `钳制后不爆炸（${mul}）`);
  });
});

describe('BOSS 血量 · 最终系数 = mul × 层数折算', () => {
  test('只有手动系数：layerSum=0 时 = mul', () => {
    writeCfg(bossHp({ mul: 2 }));
    assert.ok(Math.abs(gdOf().bossHpMul('boss_1', 0) - 2) < 1e-9);
  });

  test('层数折算：layerK=0.0005、1000 层 → ×1.5', () => {
    writeCfg(bossHp({ mul: 1, layerK: 0.0005, layerFloor: 0 }));
    assert.ok(Math.abs(gdOf().bossHpMul('boss_1', 1000) - 1.5) < 1e-9);
  });

  test('相乘：mul=2 且 1000 层 → ×3', () => {
    writeCfg(bossHp({ mul: 2, layerK: 0.0005 }));
    assert.ok(Math.abs(gdOf().bossHpMul('boss_1', 1000) - 3) < 1e-9);
  });

  test('layerFloor 免计官方水位以内：floor=500 时 1000 层只按 500 折算', () => {
    writeCfg(bossHp({ layerK: 0.0005, layerFloor: 500 }));
    assert.ok(Math.abs(gdOf().bossHpMul('boss_1', 1000) - 1.25) < 1e-9, '1 + 0.0005×500 = 1.25');
  });

  test('layerCap 封顶：层数爆炸也不会超过 cap', () => {
    writeCfg(bossHp({ layerK: 0.0005, layerCap: 5 }));
    assert.ok(Math.abs(gdOf().bossHpMul('boss_1', 999999) - 5) < 1e-9, '封顶 ×5');
  });

  test('bossPoolHp 端到端：血池按最终系数放大', () => {
    writeCfg({});                                   // 先取官方基准
    const gd = gdOf();
    const base = bossPoolHp(gd, 'boss_1', 4, 0, 0);
    writeCfg(bossHp({ mul: 2, layerK: 0.0005 }));
    const boosted = bossPoolHp(gd, 'boss_1', 4, 0, 1000);
    assert.ok(Math.abs(boosted - base * 3) < 2, `血池 ×3（${base} → ${boosted}）`);
  });
});

describe('BOSS 血量 · 热改', () => {
  test('对局中改 mul → 未开打的 BOSS 立即用新值', () => {
    writeCfg(bossHp({ mul: 1 }));
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 21, registry: REG, fake: true });
    h.start();
    const m = h.m;
    assert.ok(m.gd.bossHpMul('boss_1', 0) === 1, '初始 ×1');
    writeCfg(bossHp({ mul: 1.5 }));
    assert.ok(Math.abs(m.gd.bossHpMul('boss_1', 0) - 1.5) < 1e-9, '热改后 ×1.5');
  });

  test('startFinalAssault 真实对局：血池按「mul × 层数」生成', () => {
    const baseCfg = JSON.parse(original);                    // 保留 extraRounds（否则 R14=官方 BOSS，对局提前结束）
    writeCfg({ ...baseCfg, bossHp: { enabled: true, mul: 2, layerK: 0.0005, layerFloor: 0, layerCap: 5 } });
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 22, registry: REG, fake: true });
    h.start();
    const m = h.m;
    h.toPrep(18);                                   // BOSS 回合 PREP（hiddenLayerSum 已在 endPrep 设置？——endPrep 在其后，先直接看血池）
    // 直接触发 startFinalAssault：先造一个足够大的 layerSum
    m.hiddenLayerSum = 1000;
    // 官方基准必须在规则关闭时取（否则 mul 已含在 base 里，会乘两次）
    writeCfg({});
    const official = bossPoolHp(m.gd, m.bossId, m.alivePlayers().length, m.seatCount, 0);
    writeCfg({ ...baseCfg, bossHp: { enabled: true, mul: 2, layerK: 0.0005, layerFloor: 0, layerCap: 5 } });
    m.startFinalAssault(false);
    const want = official * 2 * 1.5;                // mul=2 × (1+0.0005×1000)=1.5 → ×3
    assert.ok(Math.abs(m.bossPool.maxHp - Math.round(want)) <= 1, `血池 ${m.bossPool.maxHp} ≈ ${Math.round(want)}`);
  });
});

process.on('exit', () => { try { fs.writeFileSync(CUSTOM_RULES_PATH, original); } catch {} });
