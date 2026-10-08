// 回合抽奖（roundLottery）单测：回合触发 / 轮数 / 槽数 / minTier 池过滤 / 不重复。
// 用法: node --test tools/round-lottery.test.mjs
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
const writeCfg = (o) => { fs.writeFileSync(CUSTOM_RULES_PATH, JSON.stringify(o, null, 2)); resetCustomRules(); };

/** 建 coop 2 人局，推进到指定回合的 PREP，返回 { m, players }。 */
function setup(round = 3, seed = 41) {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed, registry: REG, fake: true });
  h.start();
  h.toPrep(round);
  const m = h.m;
  const players = [...m.players.values()].filter((p) => !p.isBot);
  return { m, players };
}

/** 该装备的阶（tier）。 */
const tierOf = (m, id) => m.gd.item(id)?.tier;

describe('回合抽奖 · 发放', () => {
  test('命中配置回合：每个活人各得 rolls 个 offer，每 offer choices 个槽', () => {
    writeCfg({ roundLottery: { enabled: true, rolls: 2, choices: 5, label: '军备抽奖', rounds: [{ round: 3, minTier: 1 }] } });
    const { m, players } = setup(3);
    assert.ok(players.length >= 2, '两名玩家');
    for (const ps of players) {
      // 进入 PREP 时已发放（enterPrep → _grantRoundLottery）
      const mine = ps.offers.filter((o) => o.source === 'lottery');
      assert.equal(mine.length, 2, `${ps.playerId} 应有 2 轮抽奖（实际 ${mine.length}）`);
      for (const o of mine) {
        assert.equal(o.slots.length, 5, `每轮 5 选 1（实际 ${o.slots.length}）`);
        assert.ok(o.slots.every((s) => s.kind === 'item'), '全部是装备');
        assert.equal(o.label, '军备抽奖', 'label 正确');
      }
    }
  });

  test('未命中回合：不发抽奖（第 4 回合）', () => {
    writeCfg({ roundLottery: { enabled: true, rolls: 2, choices: 5, rounds: [{ round: 3, minTier: 1 }, { round: 6, minTier: 2 }] } });
    const { players } = setup(4);
    for (const ps of players) {
      assert.equal(ps.offers.filter((o) => o.source === 'lottery').length, 0, '第 4 回合不发');
    }
  });

  test('规则关闭：不发抽奖', () => {
    writeCfg({ roundLottery: { enabled: false } });
    const { players } = setup(3);
    for (const ps of players) {
      assert.equal(ps.offers.filter((o) => o.source === 'lottery').length, 0, '关闭时不发');
    }
  });

  test('单轮配置：rolls=1 只发 1 个 offer', () => {
    writeCfg({ roundLottery: { enabled: true, rolls: 1, choices: 5, rounds: [{ round: 3, minTier: 1 }] } });
    const { players } = setup(3, 42);
    for (const ps of players) {
      assert.equal(ps.offers.filter((o) => o.source === 'lottery').length, 1, 'rolls=1 ⇒ 1 轮');
    }
  });
});

describe('回合抽奖 · 池过滤（minTier）', () => {
  test('minTier=1（第 3 回合）：全阶混池，可出现 T1', () => {
    writeCfg({ roundLottery: { enabled: true, rolls: 1, choices: 5, rounds: [{ round: 3, minTier: 1 }] } });
    const { m, players } = setup(3, 51);
    const ps = players[0];
    const o = ps.offers.find((x) => x.source === 'lottery');
    assert.ok(o, '有抽奖');
    const tiers = o.slots.map((s) => tierOf(m, s.id));
    assert.ok(tiers.every((t) => t >= 1 && t <= 6), `全阶混池（tiers=${tiers.join(',')}）`);
  });

  test('maxTier=shopLevel 时按个人商店等级限制池上限', () => {
    writeCfg({ roundLottery: { enabled: true, rolls: 1, choices: 5, rounds: [{ round: 3, minTier: 1, maxTier: 'shopLevel' }] } });
    const { m, players } = setup(3, 56);
    const ps = players[0];
    const o = ps.offers.find((x) => x.source === 'lottery');
    assert.ok(o, '有抽奖');
    const tiers = o.slots.map((s) => tierOf(m, s.id));
    assert.ok(tiers.every((t) => t <= ps.shop.level), `不超过商店等级 ${ps.shop.level}（tiers=${tiers.join(',')}）`);
  });

  test('minTier=2（第 6 回合）：池中不含 T1', () => {
    writeCfg({ roundLottery: { enabled: true, rolls: 1, choices: 5, rounds: [{ round: 6, minTier: 2 }] } });
    const { m, players } = setup(6, 52);
    const ps = players[0];
    const o = ps.offers.find((x) => x.source === 'lottery');
    assert.ok(o, '有抽奖');
    const tiers = o.slots.map((s) => tierOf(m, s.id));
    assert.ok(tiers.every((t) => t >= 2), `无 T1（tiers=${tiers.join(',')}）`);
  });

  test('minTier=3（第 10 回合）：池中不含 T1/T2', () => {
    writeCfg({ roundLottery: { enabled: true, rolls: 1, choices: 5, rounds: [{ round: 10, minTier: 3 }] } });
    const { m, players } = setup(10, 53);
    const ps = players[0];
    const o = ps.offers.find((x) => x.source === 'lottery');
    assert.ok(o, '有抽奖');
    const tiers = o.slots.map((s) => tierOf(m, s.id));
    assert.ok(tiers.every((t) => t >= 3), `无 T1/T2（tiers=${tiers.join(',')}）`);
  });

  test('槽内不重复（同轮 5 件互不相同）', () => {
    writeCfg({ roundLottery: { enabled: true, rolls: 2, choices: 5, rounds: [{ round: 3, minTier: 1 }] } });
    const { players } = setup(3, 54);
    for (const ps of players) {
      for (const o of ps.offers.filter((x) => x.source === 'lottery')) {
        const ids = o.slots.map((s) => s.id);
        assert.equal(new Set(ids).size, ids.length, `同轮不重复（${ids.join(',')}）`);
      }
    }
  });
});

describe('回合抽奖 · 领取与排队', () => {
  test('领取一个 offer 后：该 offer 移除、下一个抽奖顶上来（两轮独立）', () => {
    writeCfg({ roundLottery: { enabled: true, rolls: 2, choices: 5, rounds: [{ round: 3, minTier: 1 }] } });
    const { players } = setup(3, 55);
    const ps = players[0];
    const before = ps.offers.filter((o) => o.source === 'lottery').length;
    assert.equal(before, 2, '领取前 2 轮');
    const r = ps.pickReward(0);
    assert.equal(r.ok, true, '领取成功');
    const after = ps.offers.filter((o) => o.source === 'lottery').length;
    assert.equal(after, 1, `领取后剩 1 轮（实际 ${after}）`);
    // 第二轮的 5 件仍可选
    const next = ps.offers.find((o) => o.source === 'lottery');
    assert.equal(next.slots.length, 5, '第二轮仍是 5 选 1');
    assert.ok(ps.hand.filter(Boolean).some((p) => p.kind === 'item'), '装备已入整备区');
  });
});

process.on('exit', () => { try { fs.writeFileSync(CUSTOM_RULES_PATH, original); } catch {} });
