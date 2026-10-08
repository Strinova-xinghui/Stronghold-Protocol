// 对局节奏（pacing）单测：策略轮选/机变/休整期加时、对局速度实现但不默认启用、热改生效。
// 用法: node --test tools/pacing.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeMatch } from '../test/match/harness.js';
import { createRegistry } from '../server/match/effectsMeta.js';
import { resetCustomRules, CUSTOM_RULES_PATH, getCustomRules } from '../server/match/customRules.js';

const REG = createRegistry({ log: { warn() {}, error() {}, info() {} } });
const original = fs.readFileSync(CUSTOM_RULES_PATH, 'utf8');
const writeCfg = (o) => { fs.writeFileSync(CUSTOM_RULES_PATH, JSON.stringify(o, null, 2)); resetCustomRules(); };
const mk = (seed = 7) => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed, registry: REG, fake: true });
  h.start();
  return h.m;
};
const pace = (o) => ({ pacing: { enabled: true, ...o } });

describe('对局节奏 · 配置解析', () => {
  test('默认（关闭）：无 pacing，时长保持官方', () => {
    writeCfg({});
    assert.equal(getCustomRules({}).pacing, null, 'pacing 为 null');
    const m = mk(1);
    assert.equal(m.bandTurnMs(), 30000, '策略轮选 30 秒');
    assert.equal(m.gameSpeed, 2, '对局速度官方 2×');
  });

  test('bandDraftMul/spDraftMul/prepMul 解析并钳制到 [0.1, 10]', () => {
    writeCfg(pace({ bandDraftMul: 1.5, spDraftMul: 1.5, prepMul: 1 }));
    const p = getCustomRules({}).pacing;
    assert.equal(p.bandDraftMul, 1.5);
    assert.equal(p.spDraftMul, 1.5);
    assert.equal(p.prepMul, 1);
    writeCfg(pace({ bandDraftMul: 999, spDraftMul: 0.001 }));
    const p2 = getCustomRules({}).pacing;
    assert.equal(p2.bandDraftMul, 10, '上限 10');
    assert.equal(p2.spDraftMul, 0.1, '下限 0.1');
  });

  test('combatSpeed 缺省/非法 → null（不启用，用官方 2×）', () => {
    writeCfg(pace({ combatSpeed: null }));
    assert.equal(getCustomRules({}).pacing.combatSpeed, null);
    writeCfg(pace({ combatSpeed: 0 }));
    assert.equal(getCustomRules({}).pacing.combatSpeed, null, '0 视为不启用');
    writeCfg(pace({ combatSpeed: -3 }));
    assert.equal(getCustomRules({}).pacing.combatSpeed, null, '负数视为不启用');
    writeCfg(pace({ combatSpeed: 3 }));
    assert.equal(getCustomRules({}).pacing.combatSpeed, 3, '正数启用');
  });
});

describe('对局节奏 · 时长生效', () => {
  test('策略轮选加时：1.5 倍 → 30 秒变 45 秒', () => {
    writeCfg(pace({ bandDraftMul: 1.5 }));
    assert.equal(mk(2).bandTurnMs(), 45000);
  });

  test('策略轮选减时：0.5 倍 → 15 秒', () => {
    writeCfg(pace({ bandDraftMul: 0.5 }));
    assert.equal(mk(3).bandTurnMs(), 15000);
  });

  test('机变加时：spFirst/spTurn 都 ×1.5', () => {
    writeCfg(pace({ spDraftMul: 1.5 }));
    const m = mk(4);
    const mul = m._pacing.spDraftMul;
    assert.equal(m.gd.timer('spFirst') * mul, 45, '首轮 30 → 45 秒');
    assert.equal(m.gd.timer('spTurn') * mul, 24, '后续 16 → 24 秒');
  });

  test('休整期加时：prepMul 影响 prepTime', () => {
    writeCfg(pace({ prepMul: 2 }));
    const m = mk(5);
    assert.equal(m._pacing.prepMul, 2, 'prepMul=2 已解析');
    const base = m.gd.prepTime(1);
    assert.ok(base > 0, `官方 prepTime(1)=${base}`);
    // 实际值在 enterPrep 里用 `prepTime × prepMul`，这里验证乘数关系
    assert.equal(base * m._pacing.prepMul, base * 2);
  });

  test('多项同时生效（策略+机变+休整期）', () => {
    writeCfg(pace({ bandDraftMul: 1.5, spDraftMul: 2, prepMul: 1.5 }));
    const m = mk(6);
    assert.equal(m.bandTurnMs(), 45000);
    assert.equal(m._pacing.spDraftMul, 2);
    assert.equal(m._pacing.prepMul, 1.5);
  });
});

describe('对局节奏 · 对局速度（实现但不默认启用）', () => {
  test('未配置时 gameSpeed = 2（官方强制 2×）', () => {
    writeCfg(pace({ combatSpeed: null }));
    assert.equal(mk(8).gameSpeed, 2);
  });

  test('配置 combatSpeed=3 时 gameSpeed = 3（功能可用）', () => {
    writeCfg(pace({ combatSpeed: 3 }));
    assert.equal(mk(9).gameSpeed, 3);
  });

  test('combatSpeed 上限 200', () => {
    writeCfg(pace({ combatSpeed: 9999 }));
    assert.equal(mk(10).gameSpeed, 200);
  });

  test('opts.combatSpeed 优先于配置（测试注入用）', () => {
    writeCfg(pace({ combatSpeed: 3 }));
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 11, registry: REG, fake: true, combatSpeed: 5 });
    h.start();
    assert.equal(h.m.gameSpeed, 5, 'opts 覆盖配置');
  });
});

describe('对局节奏 · 热改', () => {
  test('对局中改 bandDraftMul → 立即生效（下一次调用）', () => {
    writeCfg(pace({ bandDraftMul: 1 }));
    const m = mk(12);
    assert.equal(m.bandTurnMs(), 30000, '初始 30 秒');
    writeCfg(pace({ bandDraftMul: 2 }));           // 热改
    assert.equal(m.bandTurnMs(), 60000, '热改后立即 60 秒');
  });

  test('对局中改 spDraftMul → 立即生效', () => {
    writeCfg(pace({ spDraftMul: 1 }));
    const m = mk(13);
    assert.equal(m._pacing.spDraftMul, 1);
    writeCfg(pace({ spDraftMul: 2.5 }));
    assert.equal(m._pacing.spDraftMul, 2.5, '热改后立即生效');
  });

  test('combatSpeed 不热改：已开局的对局保持开局速度', () => {
    writeCfg(pace({ combatSpeed: null }));
    const m = mk(14);
    assert.equal(m.gameSpeed, 2, '开局 2×');
    writeCfg(pace({ combatSpeed: 6 }));            // 热改
    assert.equal(m.gameSpeed, 2, '已开对局不受影响（防时间轴错位）');
    assert.equal(mk(15).gameSpeed, 6, '新开对局用新值');
  });
});

process.on('exit', () => { try { fs.writeFileSync(CUSTOM_RULES_PATH, original); } catch {} });
