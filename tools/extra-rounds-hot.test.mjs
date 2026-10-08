// 热改 BOSS 时间验证：对局进行中改 count → 后续回合立即采用新结构；已打过的回合不被重定义。
// 用法: node --test tools/extra-rounds-hot.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeMatch } from '../test/match/harness.js';
import { createRegistry } from '../server/match/effectsMeta.js';
import { getData } from '../server/data.js';
import { resetCustomRules, CUSTOM_RULES_PATH } from '../server/match/customRules.js';

const DATA = getData({ quiet: true });
const REG = createRegistry({ log: { warn() {}, error() {}, info() {} } });
const original = fs.readFileSync(CUSTOM_RULES_PATH, 'utf8');
const writeCfg = (o) => { fs.writeFileSync(CUSTOM_RULES_PATH, JSON.stringify(o, null, 2)); resetCustomRules(); };
const cfgOf = (count) => ({ extraRounds: { enabled: true, insertAfter: 13, count, templateRound: 13, curve: 'stretchShape' } });
const mk = (seed) => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed, registry: REG, fake: true });
  h.start();
  return h;
};

describe('回合编排 · 热改 BOSS 时间', () => {
  test('对局开始前改：新结构立即生效（count 2 → BOSS 16）', () => {
    writeCfg(cfgOf(2));
    const m = mk(11).m;
    assert.equal(m.gd.bossRound, 16, `bossRound=${m.gd.bossRound}`);
  });

  test('对局进行中「推后」：已打过的回合不变，BOSS 采用新值', () => {
    writeCfg(cfgOf(4));                       // 初始 BOSS 18
    const h = mk(12);
    const m = h.m;
    h.toPrep(5);                              // 打到第 5 回合
    assert.equal(m.gd.bossRound, 18, '第 5 回合时 BOSS 仍是 18');
    writeCfg(cfgOf(6));                       // 热改：BOSS → 20
    assert.equal(m.gd.bossRound, 20, `热改后 BOSS = 20（实际 ${m.gd.bossRound}）`);
    assert.equal(m.gd.isInsertedRound(5), false, '已打过的第 5 回合不受影响');
    assert.equal(m.gd.isInsertedRound(19), true, '新增的插入回合 19 生效');
  });

  test('对局进行中「改小」：BOSS 不落在已过去的回合（当前回合即可触发，对局仍能结束）', () => {
    writeCfg(cfgOf(6));                       // 初始 BOSS 20
    const h = mk(13);
    const m = h.m;
    h.toPrep(15);                             // 打到第 15 回合（floor=15）
    writeCfg(cfgOf(1));                       // 热改：BOSS 想回到 15（count 最小为 1）
    const br = m.gd.bossRound;
    assert.ok(br >= 15, `BOSS 不得落在已过去的回合（>= floor 15，实际 ${br}）`);
    assert.equal(br, 15, `当前回合即可触发（实际 ${br}）`);
  });

  test('BOSS 触发后锁定：后续回合不再把 bossRound 算成自己', () => {
    writeCfg(cfgOf(1));
    const h = mk(14);
    const m = h.m;
    h.toPrep(15);
    assert.equal(m.gd.bossRound, 15, 'BOSS 回合');
    m.gd.lockBossRound(15);                   // 模拟 endPrep 触发
    assert.equal(m.gd.bossRound, 15, '锁定后仍是 15');
    m.gd.raiseExtraRoundsFloor(16);
    assert.equal(m.gd.bossRound, 15, 'floor 抬高后锁定值优先（不会漂移）');
  });

  test('关闭规则：恢复官方 BOSS 14', () => {
    writeCfg(cfgOf(4));
    const h = mk(15);
    h.toPrep(3);
    writeCfg({});                             // 热关
    assert.equal(h.m.gd.bossRound, 14, `关闭后 BOSS 回到 14（实际 ${h.m.gd.bossRound}）`);
  });

  test('难度随新结构自动重算（改 count 后插入回合的难度曲线跟着变）', () => {
    writeCfg(cfgOf(4));
    const h = mk(16);
    const m = h.m;
    h.toPrep(2);
    const hp17Before = m.gd.enemyScale(17).hpMul;
    writeCfg(cfgOf(8));                       // 插入更多回合 → 曲线摊得更开
    const hp17After = m.gd.enemyScale(17).hpMul;
    assert.ok(hp17After < hp17Before, `更多回合 ⇒ 同一回合更缓（${hp17After.toFixed(4)} < ${hp17Before.toFixed(4)}）`);
  });
});

process.on('exit', () => { try { fs.writeFileSync(CUSTOM_RULES_PATH, original); } catch {} });
