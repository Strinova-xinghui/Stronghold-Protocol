// 回合编排（extraRounds）单测：BOSS 顺延 / 插入回合复用波次 / 曲线拉伸 / 怪组混排 / 官方基线不受影响。
// 用法: node --test tools/extra-rounds.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { getData } from '../server/data.js';
import { GameData } from '../server/match/gamedata.js';
import { buildNormalWave, buildBossWave } from '../server/match/waves.js';
import { resetCustomRules, CUSTOM_RULES_PATH } from '../server/match/customRules.js';

const DATA = getData({ quiet: true });
const original = fs.readFileSync(CUSTOM_RULES_PATH, 'utf8');
const writeCfg = (o) => { fs.writeFileSync(CUSTOM_RULES_PATH, JSON.stringify(o, null, 2)); resetCustomRules(); };
/** 官方 k=7 的第 13 回合难度（hp 0.8×1.2^7 = 2.866545）。 */
const K13_HP = 0.8 * Math.pow(1.2, 7);
const gdOf = (modeId = 'mode_multi_normal') => new GameData(DATA, modeId);

const BASE = { extraRounds: { enabled: true, insertAfter: 13, count: 4, templateRound: 13, curve: 'stretch' } };

describe('回合编排 · 回合数与 BOSS 时机', () => {
  test('开启后：BOSS 14→18、隐藏 BOSS 15→19、最后回合 14→18', () => {
    writeCfg(BASE);
    const gd = gdOf();
    assert.equal(gd.bossRound, 18, `bossRound=${gd.bossRound}`);
    assert.equal(gd.hiddenRound, 19, `hiddenRound=${gd.hiddenRound}`);
    assert.equal(gd.lastRound, 18, `lastRound=${gd.lastRound}`);
  });

  test('关闭时：与官方一致（BOSS 14 / 隐藏 15）', () => {
    writeCfg({});
    const gd = gdOf();
    assert.equal(gd.bossRound, 14);
    assert.equal(gd.hiddenRound, 15);
    assert.equal(gd.lastRound, 14);
  });

  test('isInsertedRound 正确标记 14–17（18 是 BOSS，不算插入）', () => {
    writeCfg(BASE);
    const gd = gdOf();
    for (const r of [1, 13]) assert.equal(gd.isInsertedRound(r), false, `第 ${r} 回合不该是插入回合`);
    for (const r of [14, 15, 16, 17]) assert.equal(gd.isInsertedRound(r), true, `第 ${r} 回合应是插入回合`);
    for (const r of [18, 19]) assert.equal(gd.isInsertedRound(r), false, `第 ${r} 回合（BOSS）不该是插入回合`);
  });
});

describe('回合编排 · 插入回合复用波次', () => {
  test('插入回合复用第 13 回合的波次模板与时长，且不是 BOSS 回合', () => {
    writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, mixPerRound: false } });
    const gd = gdOf();
    const r13 = gd.roundCfg(13);
    for (const r of [14, 15, 16, 17]) {
      const rc = gd.roundCfg(r);
      assert.ok(rc, `第 ${r} 回合有配置`);
      assert.equal(rc.template, r13.template, `第 ${r} 回合复用 ${r13.template}`);
      assert.equal(rc.prepTime, r13.prepTime, '休整期时长一致');
      assert.equal(rc.isBoss, false, `第 ${r} 回合不是 BOSS`);
      assert.equal(rc.bossTemplates, null, '不带 BOSS 模板');
    }
  });

  test('mixPerRound：插入回合从池里挑模板（且同回合内稳定）', () => {
    writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, mixPerRound: true, poolTemplates: ['act1autochess_h04', 'act1autochess_h05', 'act1autochess_h06'] } });
    const gd = gdOf();
    for (const r of [14, 15, 16, 17]) {
      const t1 = gd.roundCfg(r).template;
      const t2 = gd.roundCfg(r).template;
      assert.equal(t1, t2, `第 ${r} 回合模板稳定（两次调用一致）`);
      assert.ok(['act1autochess_h04', 'act1autochess_h05', 'act1autochess_h06'].includes(t1), `第 ${r} 回合模板来自池（实际 ${t1}）`);
    }
  });
});

describe('回合编排 · 难度曲线', () => {
  test('stretch：整条曲线重排——插入回合仍递增，且不超过官方终点', () => {
    writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, curve: 'stretch' } });
    const gd = gdOf();
    const hps = [14, 15, 16, 17].map((r) => gd.enemyScale(r).hpMul);
    for (let i = 1; i < hps.length; i++) assert.ok(hps[i] > hps[i - 1], `插入回合难度递增（${hps.map((x) => x.toFixed(3)).join(' < ')}）`);
    assert.ok(hps[hps.length - 1] <= K13_HP + 1e-9, `不超过官方终点 ${K13_HP.toFixed(4)}（实际 ${hps[hps.length - 1].toFixed(4)}）`);
  });

  test('stretch：端点不变——第 17 回合 = 官方第 13 回合难度', () => {
    writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, curve: 'stretch' } });
    const gd = gdOf();
    const hp17 = gd.enemyScale(17).hpMul;
    assert.ok(Math.abs(hp17 - K13_HP) < 0.02, `第 17 回合 ≈ ${K13_HP.toFixed(4)}（实际 ${hp17.toFixed(4)}）`);
  });

  test('stretch：线性重排——后期（14–17）比官方原曲线缓，但前中期略陡（官方前期是平台式缓涨）', () => {
    writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, curve: 'stretch' } });
    const gd = gdOf();
    // 第 14 回合官方无普通波次（是 BOSS），对比「官方 13 回合 + 若继续线性」——重点是第 14–17 斜率 < 官方 12→13 的斜率
    const slopeStretched = gd.enemyScale(17).hpMul - gd.enemyScale(14).hpMul;
    const slopeOfficial = (0.8 * Math.pow(1.2, 7)) - (0.8 * Math.pow(1.2, 6));
    assert.ok(slopeStretched / 3 < slopeOfficial, `插入回合每回合增幅 < 官方单级增幅（${(slopeStretched / 3).toFixed(4)} < ${slopeOfficial.toFixed(4)}）`);
    // 线性重排会让第 6 回合比官方略陡（1.152 → 1.4418）：这是「拉直」的必然代价
    assert.ok(gd.enemyScale(6).hpMul > 0.8 * Math.pow(1.2, 2), '前中期被拉直抬高（线性重排的固有特征）');
  });

  test('stretchShape：形状保持的横向拉伸——全程 ≤ 官方（最柔和的「拉伸」）', () => {
    writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, curve: 'stretchShape' } });
    const gd = gdOf();
    for (const r of [3, 6, 10, 13, 14, 15, 16, 17]) {
      const k = gd._kOfRound(r);
      const official = k == null ? null : 0.8 * Math.pow(1.2, k);
      if (official != null) assert.ok(gd.enemyScale(r).hpMul <= official + 1e-9, `第 ${r} 回合 ≤ 官方（${gd.enemyScale(r).hpMul.toFixed(4)} ≤ ${official.toFixed(4)}）`);
    }
    assert.ok(Math.abs(gd.enemyScale(17).hpMul - K13_HP) < 0.02, `第 17 回合仍 ≈ 官方终点（${gd.enemyScale(17).hpMul.toFixed(4)}）`);
  });

  test('append：接着模板回合递增（每回合 ×1.2）', () => {
    writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, curve: 'append' } });
    const gd = gdOf();
    const hp14 = gd.enemyScale(14).hpMul;
    const hp15 = gd.enemyScale(15).hpMul;
    assert.ok(Math.abs(hp14 - K13_HP * 1.2) < 0.02, `第 14 回合 ≈ ${(K13_HP * 1.2).toFixed(4)}（实际 ${hp14.toFixed(4)}）`);
    assert.ok(hp15 > hp14, '继续递增');
  });

  test('flat：完全沿用模板回合难度', () => {
    writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, curve: 'flat' } });
    const gd = gdOf();
    for (const r of [14, 15, 16, 17]) {
      assert.ok(Math.abs(gd.enemyScale(r).hpMul - K13_HP) < 1e-6, `第 ${r} 回合 = 官方 13 回合难度`);
    }
  });

  test('曲线常数可外置（curveRate 改 1.05 后难度明显变缓）', () => {
    writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, curve: 'append', curveRate: 1.05 } });
    const gd = gdOf();
    const hp14 = gd.enemyScale(14).hpMul;
    assert.ok(Math.abs(hp14 - 0.8 * Math.pow(1.05, 8)) < 0.02, `第 14 回合 ≈ ${(0.8 * Math.pow(1.05, 8)).toFixed(4)}（实际 ${hp14.toFixed(4)}）`);
  });
});

describe('回合编排 · 不影响非插入回合', () => {
  test('stretch 会重排全曲线（第 6 回合被拉直抬高，属线性重排的固有特征）', () => {
    writeCfg(BASE);
    const gd = gdOf();
    const hp6 = gd.enemyScale(6).hpMul;
    const official6 = 0.8 * Math.pow(1.2, 2);
    assert.ok(hp6 > official6, `第 6 回合被拉直抬高（${hp6.toFixed(4)} > ${official6.toFixed(4)}）`);
  });

  test('append/smooth/flat 不改非插入回合（第 1–13 回合保持官方值）', () => {
    for (const curve of ['append', 'smooth', 'flat']) {
      writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, curve } });
      const gd = gdOf();
      for (const r of [1, 6, 10, 13]) {
        const k = gd._kOfRound(r);
        assert.ok(Math.abs(gd.enemyScale(r).hpMul - 0.8 * Math.pow(1.2, k)) < 1e-6, `${curve} 下第 ${r} 回合 = 官方值`);
      }
    }
  });

  test('关闭规则时所有回合都是官方值', () => {
    writeCfg({});
    const gd = gdOf();
    for (const r of [1, 6, 10, 13]) {
      const k = gd._kOfRound(r);
      assert.ok(Math.abs(gd.enemyScale(r).hpMul - 0.8 * Math.pow(1.2, k)) < 1e-6, `第 ${r} 回合 = 官方值`);
    }
    assert.equal(gd.bossRound, 14, 'BOSS 仍是 14');
  });
});

describe('回合编排 · 绝不允许空波次（2026-10-08 线上事故回归）', () => {
  // 事故：顺延后的 BOSS 回合（18）直接查 rounds 表得 null → buildBossWave 拿不到 bossTemplates
  // → 空波次（完全没怪，BOSS 不出现）。第 17 回合正常、18 回合无怪，与线上回报一致。
  const WAVES = { buildNormalWave, buildBossWave };

  test('第 13–19 回合每回合都有怪（普通波次或 BOSS 波次）', async () => {
    writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, curve: 'stretchShape' } });
    const gd = gdOf();
    const rng = () => 0.5;
    const factions = [{}, {}, {}];
    for (let r = 13; r <= 19; r++) {
      const isBoss = r === gd.bossRound || r === gd.hiddenRound;
      let n = 0;
      if (isBoss) {
        const w = WAVES.buildBossWave(gd, rng, factions, r, { bossId: 'boss_1', solo: false });
        n = (w.spawns || []).length;
      } else {
        const w = WAVES.buildNormalWave(gd, rng, factions, r);
        n = (w.spawns || []).length;
      }
      assert.ok(n > 0, `第 ${r} 回合必须有怪（实际 ${n}；isBoss=${isBoss}，template=${gd.roundCfg(r)?.template}，bossTemplates=${!!gd.roundCfg(r)?.bossTemplates}）`);
    }
  });

  test('顺延后的 BOSS 回合带 bossTemplates（第 18 回合）', () => {
    writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, curve: 'stretchShape' } });
    const gd = gdOf();
    assert.equal(gd.bossRound, 18);
    const rc = gd.roundCfg(18);
    assert.ok(rc, 'roundCfg(18) 不能为 null');
    assert.ok(rc.bossTemplates && Object.keys(rc.bossTemplates).length > 0, 'BOSS 模板必须存在');
    assert.equal(rc.isBoss, true);
  });

  test('顺延后的隐藏 BOSS 回合带 bossTemplates（第 19 回合）', () => {
    writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, curve: 'stretchShape' } });
    const gd = gdOf();
    assert.equal(gd.hiddenRound, 19);
    const rc = gd.roundCfg(19);
    assert.ok(rc, 'roundCfg(19) 不能为 null');
    assert.ok(rc.bossTemplates && Object.keys(rc.bossTemplates).length > 0, '隐藏 BOSS 模板必须存在');
  });

  test('隐秘核心（19 回合）：模板里含真实 hiddenBossId，且能生成怪', () => {
    writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, curve: 'stretchShape' } });
    const gd = gdOf();
    const rc = gd.roundCfg(19);
    assert.equal(rc.isHidden, true, '标记为隐藏 BOSS 回合');
    // 官方隐藏 BOSS 的模板键（boss_8/9/10 → act1autochess_h08_*）：必须真的在模板表里
    const keys = Object.keys(rc.bossTemplates);
    assert.ok(keys.length > 0, '有隐藏 BOSS 模板键');
    let total = 0;
    for (const k of keys) {
      const w = buildBossWave(gd, () => 0.5, [{}, {}, {}], 19, { bossId: k, solo: false });
      const n = (w.spawns || []).length;
      assert.ok(n > 0, `hiddenBossId=${k} 必须能生成怪（实际 ${n}）`);
      assert.ok(/h08/.test(w.templateId || ''), `第 19 回合应使用 h08 隐藏 BOSS 模板（实际 ${w.templateId}）`);
      total += n;
    }
    assert.ok(total > 0, '所有隐藏 BOSS 模板合计有怪');
  });

  test('隐秘核心：官方第 15 回合的模板与第 19 回合一致（顺延不改内容）', () => {
    writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, curve: 'stretchShape' } });
    const gd = gdOf();
    const official = gd.mode.rounds['15'];
    const shifted = gd.roundCfg(19);
    assert.deepEqual(shifted.bossTemplates, official.bossTemplates, '隐藏 BOSS 模板逐一相同');
    assert.equal(shifted.levelMaxPlayTime, official.levelMaxPlayTime, '时长相同');
  });

  test('count 变化时 BOSS/隐藏回合始终有怪（1..6 全试）', () => {
    const rng = () => 0.5;
    const factions = [{}, {}, {}];
    for (const count of [1, 2, 3, 4, 5, 6]) {
      writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, count, curve: 'stretchShape' } });
      const gd = gdOf();
      for (const r of [gd.bossRound, gd.hiddenRound].filter((x) => x != null)) {
        const w = WAVES.buildBossWave(gd, rng, factions, r, { bossId: 'boss_1', solo: false });
        assert.ok((w.spawns || []).length > 0, `count=${count} 第 ${r} 回合必须有怪（实际 ${(w.spawns || []).length}）`);
      }
    }
  });

  test('每个插入回合也都有怪（14–17）', () => {
    writeCfg({ ...BASE, extraRounds: { ...BASE.extraRounds, curve: 'stretchShape' } });
    const gd = gdOf();
    const rng = () => 0.5;
    for (const r of [14, 15, 16, 17]) {
      const w = WAVES.buildNormalWave(gd, rng, [{}, {}, {}], r);
      assert.ok((w.spawns || []).length > 0, `第 ${r} 回合必须有怪（实际 ${(w.spawns || []).length}）`);
    }
  });
});

process.on('exit', () => { try { fs.writeFileSync(CUSTOM_RULES_PATH, original); } catch {} });
