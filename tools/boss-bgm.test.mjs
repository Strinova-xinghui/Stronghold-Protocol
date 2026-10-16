// BOSS 战 / 指定回合 BGM 替换（bossBgm，自研 2026-10-16）单测。
// 覆盖：normalize 边界（非法 round/track 丢弃、开关关=null、64 条上限）、bossBgmTrackFor 命中语义、
// 客户端选曲纯函数（stemBgmKey / bgmKeyFor / resolveBgm 与真实 data/assets.json 交叉）、
// 端到端 m.public.bgmTrack（COMBAT 命中 / FINAL_ASSAULT 18 / HIDDEN_CORE 19 / 联防不替换）、
// 全关 = 官方行为逐字节不变、mtime 热更局中生效。
// ⚠️ 本文件会写 config/custom-rules.json：与其它写配置的 tools/*.test.mjs 一起跑必须
//    --test-concurrency=1（并行互踩配置文件，项目老坑）；退出钩子恢复原 config。
// 用法: node --test tools/boss-bgm.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeMatch } from '../test/match/harness.js';
import { resetCustomRules, getCustomRules, bossBgmTrackFor, CUSTOM_RULES_PATH } from '../server/match/customRules.js';
import { bgmKeyFor, resolveBgm, combatTrackFor, stemBgmKey } from '../public/js/audio.js';
import { PHASE } from '../shared/constants.js';

const original = fs.readFileSync(CUSTOM_RULES_PATH, 'utf8');
process.on('exit', () => { try { fs.writeFileSync(CUSTOM_RULES_PATH, original); } catch { /* ignore */ } });

/** 整份覆盖配置（其余段留空 = OFF），写完立即失效 mtime 缓存。 */
function writeCfg(o) { fs.writeFileSync(CUSTOM_RULES_PATH, JSON.stringify(o, null, 2)); resetCustomRules(); }

const REAL_MANIFEST = JSON.parse(fs.readFileSync(new URL('../data/assets.json', import.meta.url), 'utf8'));
const BOSS_TRACK = 'm_bat_abyssalhunters';   // boss_4 的 loop stem（真实清单）
const OTHER_TRACK = 'm_bat_vtlionk';          // boss_6 的 loop stem
const KNIGHT = 'm_bat_kazimierz2_1';          // combatAlts[0] 骑士之日
const endsWithLoop = (u, stem) => typeof u === 'string' && u.endsWith(stem + '_loop.mp3');

// ---- normalize 边界 --------------------------------------------------------------------------------------------

describe('bossBgm · normalize', () => {
  test('开关关 / 段缺失 / 非法形状 ⇒ null（全关 = 官方行为）', () => {
    writeCfg({ bossBgm: { enabled: false, rules: [{ round: 18, track: BOSS_TRACK }] } });
    assert.equal(getCustomRules({}).bossBgm, null);
    writeCfg({});
    assert.equal(getCustomRules({}).bossBgm, null);
    writeCfg({ bossBgm: 'nope' });
    assert.equal(getCustomRules({}).bossBgm, null);
    writeCfg({ bossBgm: { enabled: true } });
    assert.equal(getCustomRules({}).bossBgm, null, 'rules 缺失');
    writeCfg({ bossBgm: { enabled: true, rules: 'nope' } });
    assert.equal(getCustomRules({}).bossBgm, null, 'rules 非数组');
    assert.equal(bossBgmTrackFor(getCustomRules({}), 18), null, 'null 规则 ⇒ 命中函数恒 null');
  });

  test('合法条目保留；非法 round / 非法 track 条目丢弃；数字字符串 round 宽容', () => {
    writeCfg({ bossBgm: { enabled: true, rules: [
      { round: 18, kind: 'boss', track: BOSS_TRACK },
      { round: '19', track: OTHER_TRACK },
      { round: 0, track: BOSS_TRACK },
      { round: -3, track: BOSS_TRACK },
      { round: 201, track: BOSS_TRACK },
      { round: 5.5, track: BOSS_TRACK },
      { round: 7, track: 'Bad-Track!' },
      { round: 8, track: 'has space' },
      { round: 9 },
      { round: 10, track: 123 },
      null,
      'nope',
    ] } });
    const bb = getCustomRules({}).bossBgm;
    assert.ok(bb, '存在合法条目时整段启用');
    assert.deepEqual(bb.rules.map((r) => [r.round, r.track, r.kind]), [
      [18, BOSS_TRACK, 'boss'], [19, OTHER_TRACK, 'round'], [5, BOSS_TRACK, 'round'],
    ], '只剩合法条目；kind 白名单外归 round；5.5 截断为 5');
    assert.ok(Object.isFrozen(bb) && Object.isFrozen(bb.rules) && Object.isFrozen(bb.rules[0]), '冻结防篡改');
  });

  test('64 条硬上限截断', () => {
    const many = []; for (let i = 1; i <= 80; i++) many.push({ round: i, track: 't_' + i });
    writeCfg({ bossBgm: { enabled: true, rules: many } });
    assert.equal(getCustomRules({}).bossBgm.rules.length, 64);
  });

  test('bossBgm 单独开启时其余规则仍为 null', () => {
    writeCfg({ bossBgm: { enabled: true, rules: [{ round: 18, track: BOSS_TRACK }] } });
    const r = getCustomRules({});
    assert.ok(r.bossBgm);
    for (const k of ['rewardOffer', 'itemOffer', 'prepDebt', 'roundLottery', 'extraRounds', 'pacing', 'bossHp', 'grant', 'prepUndo', 'music']) {
      assert.equal(r[k], null, k + ' 不该被点亮');
    }
  });
});

// ---- bossBgmTrackFor 命中语义 ---------------------------------------------------------------------------------

describe('bossBgm · bossBgmTrackFor', () => {
  const rules = (list) => ({ bossBgm: { enabled: true, rules: Object.freeze(list.map(Object.freeze)) } });
  test('同回合多条 = 列表序先命中生效', () => {
    assert.equal(bossBgmTrackFor(rules([{ round: 6, track: 'a' }, { round: 6, track: 'b' }]), 6), 'a');
  });
  test('未命中 / 关闭 / 坏输入 ⇒ null', () => {
    const r = rules([{ round: 18, track: BOSS_TRACK }]);
    assert.equal(bossBgmTrackFor(r, 17), null);
    assert.equal(bossBgmTrackFor(r, '18'), BOSS_TRACK, '入参 Number() 归一（views 传 this.round 恒整数，宽容无害）');
    assert.equal(bossBgmTrackFor(null, 18), null);
    assert.equal(bossBgmTrackFor({ bossBgm: null }, 18), null);
    assert.equal(bossBgmTrackFor({ bossBgm: { enabled: false, rules: [{ round: 18, track: 'x' }] } }, 18), null);
    assert.equal(bossBgmTrackFor(r, NaN), null);
    assert.equal(bossBgmTrackFor(r, null), null);
  });
});

// ---- 客户端选曲纯函数 ------------------------------------------------------------------------------------------

describe('bossBgm · 客户端 bgmKeyFor / stemBgmKey / resolveBgm', () => {
  test('stemBgmKey：真实清单可解析 ⇒ stem:<x>；不可解析 / 缺字段 ⇒ null（回落官方日程）', () => {
    assert.equal(stemBgmKey(REAL_MANIFEST, { bgmTrack: BOSS_TRACK }), 'stem:' + BOSS_TRACK);
    assert.equal(stemBgmKey(REAL_MANIFEST, { bgmTrack: 'm_bat_notexist' }), null);
    assert.equal(stemBgmKey(REAL_MANIFEST, { bgmTrack: '' }), null);
    assert.equal(stemBgmKey(REAL_MANIFEST, {}), null);
    assert.equal(stemBgmKey(REAL_MANIFEST, null), null);
    assert.equal(stemBgmKey(null, { bgmTrack: BOSS_TRACK }), null, '清单未就绪 ⇒ null，绝不 throw');
  });

  test('bgmKeyFor：命中覆盖三个作战期阶段；联防 UNITE 与其他阶段不受影响', () => {
    const stem = 'stem:' + BOSS_TRACK;
    assert.equal(bgmKeyFor('game', { phase: PHASE.COMBAT, round: 5 }, combatTrackFor(5), stem), stem);
    assert.equal(bgmKeyFor('game', { phase: PHASE.FINAL_ASSAULT, round: 18, bossId: 'boss_4' }, 0, stem), stem);
    assert.equal(bgmKeyFor('game', { phase: PHASE.HIDDEN_CORE, round: 19, bossId: 'boss_4', hiddenBossId: 'boss_9' }, 0, stem), stem);
    assert.equal(bgmKeyFor('game', { phase: PHASE.UNITE, round: 18 }, 0, stem), 'unite', '联防不替换');
    assert.equal(bgmKeyFor('game', { phase: PHASE.PREP }, 0, stem), 'prep', '休整期不替换');
    assert.equal(bgmKeyFor('lobby', null, null, stem), 'lobby', '非 game 路由不替换');
  });

  test('resolveBgm：stem:<x> 命中 loop+intro（bgm / bossBgm / combatAlts / hash URL 全可查）；未知 stem ⇒ null', () => {
    const t = resolveBgm(REAL_MANIFEST, 'stem:' + BOSS_TRACK);
    assert.ok(t && endsWithLoop(t.loop, BOSS_TRACK), 'loop 命中：' + (t && t.loop));
    assert.ok(t.intro && t.intro.endsWith(BOSS_TRACK + '_intro.mp3'), 'intro 成对衔接');
    const k = resolveBgm(REAL_MANIFEST, 'stem:' + KNIGHT);
    assert.ok(k && endsWithLoop(k.loop, KNIGHT), 'combatAlts 里的曲目也可按 stem 命中');
    const hashed = resolveBgm({ audio: { bgm: { boss: { loop: '/assets/~ab12cd34/audio/bgm/m_bat_rglk1phantomcastle_loop.mp3' } } } }, 'stem:m_bat_rglk1phantomcastle');
    assert.ok(hashed && hashed.loop.includes('/~ab12cd34/'), '服务器改写后的 hash URL 也按 stem 命中');
    assert.equal(resolveBgm(REAL_MANIFEST, 'stem:m_bat_notexist'), null);
    assert.equal(resolveBgm(REAL_MANIFEST, 'stem:Bad Track'), null, '非法字符 stem 拒绝');
    assert.equal(resolveBgm(null, 'stem:' + BOSS_TRACK), null, '清单缺失安全');
  });

  test('全关（无 bgmTrack 字段）时选曲与官方日程逐字节一致', () => {
    for (let round = 1; round <= 13; round++) {
      const pub = { phase: PHASE.COMBAT, round };
      const official = bgmKeyFor('game', pub, combatTrackFor(round));
      const ours = bgmKeyFor('game', pub, combatTrackFor(round), stemBgmKey(REAL_MANIFEST, pub));
      assert.equal(ours, official, 'R' + round + ' 官方日程不变');
      assert.equal(ours, round <= 7 ? 'combat:1' : 'combat:0', '官方日程：1-7 无畏者 / 8+ 骑士之日');
    }
    const fa = { phase: PHASE.FINAL_ASSAULT, round: 18, bossId: 'boss_4' };
    assert.equal(bgmKeyFor('game', fa, 0, stemBgmKey(REAL_MANIFEST, fa)), bgmKeyFor('game', fa, 0), 'FA 无字段 ⇒ boss:boss_4');
    const hc = { phase: PHASE.HIDDEN_CORE, round: 19, bossId: 'boss_4', hiddenBossId: 'boss_9' };
    assert.equal(bgmKeyFor('game', hc, 0, stemBgmKey(REAL_MANIFEST, hc)), bgmKeyFor('game', hc, 0), 'HC 无字段 ⇒ boss:boss_9');
    assert.equal(bgmKeyFor('game', hc, 0), 'boss:boss_9');
  });
});

// ---- 端到端：m.public.bgmTrack 服务器下发 ---------------------------------------------------------------------

describe('bossBgm · 端到端 m.public（对局引擎广播）', () => {
  const lastPub = (h, phase, round) => h.bc.filter((m) => m.t === 'm.public' && m.phase === phase && m.round === round).at(-1) || null;

  test('COMBAT 命中 round 规则 ⇒ bgmTrack 下发；未命中回合 ⇒ 字段完全不存在', () => {
    writeCfg({ bossBgm: { enabled: true, rules: [{ round: 5, kind: 'round', track: OTHER_TRACK }] } });
    const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 4242, fake: true }).start();
    try {
      h.drive(() => lastPub(h, 'COMBAT', 5) != null);
      const p5 = lastPub(h, 'COMBAT', 5);
      assert.equal(p5.bgmTrack, OTHER_TRACK, 'R5 命中替换');
      h.toPrep(6);
      h.drive(() => lastPub(h, 'COMBAT', 6) != null);
      const p6 = lastPub(h, 'COMBAT', 6);
      assert.equal(p6.bgmTrack, undefined, 'R6 未命中 = 字段不存在（逐字节官方）');
      assert.ok(!JSON.stringify(p6).includes('bgmTrack'), '未命中帧序列化里没有 bgmTrack');
    } finally { h.m.dispose(); }
  });

  test('加时赛 BOSS：FINAL_ASSAULT R18 / HIDDEN_CORE R19 各命中自己的规则', () => {
    writeCfg({
      bossBgm: { enabled: true, rules: [{ round: 18, kind: 'boss', track: BOSS_TRACK }, { round: 19, kind: 'boss', track: OTHER_TRACK }] },
      extraRounds: { enabled: true, insertAfter: 13, count: 4, templateRound: 13, curve: 'stretch' },
    });
    // 全员撑过普通回合（不漏怪 ⇒ 无人进 UNITE），boss/hidden 一波秒杀进隐秘核心
    const script = (b) => ((b.kind === 'boss' || b.kind === 'hidden') ? { bossDps: 1e9 } : {});
    const h = makeMatch({ mode: 'coop', humans: 2, bots: 1, seed: 1819, fake: true, script }).start();
    try {
      const m = h.m;
      assert.equal(m.gd.bossRound, 18, '加时赛 BOSS = 18');
      assert.equal(m.gd.hiddenRound, 19, '加时赛隐藏 = 19');
      h.drive(() => m.phase === PHASE.PREP && m.round === 18);
      for (const ps of m.players.values()) { ps.bondCountBonus.yanShip = 3; ps.layers.yanShip = 700; ps.recompute(); }
      h.drive(() => lastPub(h, 'FINAL_ASSAULT', 18) != null);
      const fa = lastPub(h, 'FINAL_ASSAULT', 18);
      assert.ok(fa, '有 R18 FINAL_ASSAULT 帧');
      assert.equal(fa.bgmTrack, BOSS_TRACK, 'R18 命中 boss 规则');
      h.drive(() => lastPub(h, 'HIDDEN_CORE', 19) != null || h.ended != null);
      const hc = lastPub(h, 'HIDDEN_CORE', 19);
      if (!hc && h.ended) assert.fail('未进隐秘核心（资格/时序异常）ended=' + JSON.stringify({ v: h.ended.victory, hr: h.ended.hiddenReached }));
      assert.ok(hc, '有 R19 HIDDEN_CORE 帧');
      assert.equal(hc.bgmTrack, OTHER_TRACK, 'R19 命中第二条规则');
    } finally { h.m.dispose(); }
  });

  test('联防 UNITE 帧不替换（官方独立曲目语义保持）', () => {
    writeCfg({ bossBgm: { enabled: true, rules: [{ round: 3, track: OTHER_TRACK }] } });
    let uniteSeen = 0;
    const script = (b) => {
      if (b.kind === 'unite') return {};
      if (b.players.length === 1 && b.round === 3) { const p0 = b.players[0]; return { leaks: { [p0]: 1 } }; }
      return {};
    };
    const h = makeMatch({ mode: 'coop', humans: 2, seed: 333, fake: true, script }).start();
    try { uniteSeen = h.bc.filter((m) => m.t === 'm.public' && m.phase === 'UNITE').length; } finally {
      h.m.dispose();
    }
    const uniteWithTrack = h.bc.filter((m) => m.t === 'm.public' && m.phase === 'UNITE' && m.bgmTrack != null).length;
    assert.equal(uniteWithTrack, 0, '联防帧（共 ' + uniteSeen + ' 条）一律不带 bgmTrack');
  });

  test('局中热更：改 track 后 COMBAT 首帧即新曲；publicView 现读——热关/热换下一视图即回落', () => {
    writeCfg({ bossBgm: { enabled: true, rules: [{ round: 5, track: OTHER_TRACK }] } });
    const h = makeMatch({ mode: 'coop', humans: 1, bots: 1, seed: 777, fake: true }).start();
    try {
      const m = h.m;
      // 停在 R5 PREP：热更改 track，再进 COMBAT —— 第一帧就该是新曲
      h.toPrep(5);
      writeCfg({ bossBgm: { enabled: true, rules: [{ round: 5, track: BOSS_TRACK }] } });
      h.drive(() => lastPub(h, 'COMBAT', 5) != null);
      assert.equal(lastPub(h, 'COMBAT', 5).bgmTrack, BOSS_TRACK, '改配置后第一帧即新 track（mtime 热更）');
      // 热关/热换：直接重建视图（广播节流不影响视图构建器——publicView 每次现读 customRules）
      assert.equal(m.publicView().bgmTrack, BOSS_TRACK, '热更后视图仍命中新 track');
      writeCfg({ bossBgm: { enabled: false, rules: [] } });
      const off = m.publicView();
      assert.equal(off.bgmTrack, undefined, '热关后视图回落官方（无字段）');
      assert.ok(!JSON.stringify(off).includes('bgmTrack'), '序列化里也没有');
      writeCfg({ bossBgm: { enabled: true, rules: [{ round: 5, track: OTHER_TRACK }] } });
      assert.equal(m.publicView().bgmTrack, OTHER_TRACK, '再热换另一首立即生效');
    } finally { h.m.dispose(); }
  });

  test('SP_OFFICIAL_RULES=1（golden 基线）⇒ 配置开启也全关', () => {
    writeCfg({ bossBgm: { enabled: true, rules: [{ round: 18, track: BOSS_TRACK }] } });
    process.env.SP_OFFICIAL_RULES = '1';
    try {
      assert.equal(getCustomRules({}).bossBgm, null, 'golden 屏蔽全部自研规则');
      assert.equal(bossBgmTrackFor(getCustomRules({}), 18), null);
    } finally { delete process.env.SP_OFFICIAL_RULES; resetCustomRules(); }
  });
});

describe('bossBgm 规则的两种曲目来源（内置 stem / 自定义 x:）', () => {
  const orig = process.env.SP_OFFICIAL_RULES;
  after(() => { if (orig === undefined) delete process.env.SP_OFFICIAL_RULES; else process.env.SP_OFFICIAL_RULES = orig; });

  const cfgPath = CUSTOM_RULES_PATH;
  const backup = fs.readFileSync(cfgPath, 'utf8');
  after(() => { fs.writeFileSync(cfgPath, backup); resetCustomRules(); });

  const load = (bossBgm) => {
    fs.writeFileSync(cfgPath, JSON.stringify({ bossBgm }, null, 2));
    resetCustomRules();
    return getCustomRules({});
  };

  test('内置 stem 照旧通过；自定义 x:<name> 也通过并保留前缀', () => {
    const rules = load({ enabled: true, rules: [
      { round: 18, track: 'm_bat_abyssalhunters' },
      { round: 19, track: 'x:my_boss_theme' },
    ] });
    assert.ok(rules.bossBgm, '规则生效');
    assert.equal(rules.bossBgm.rules.length, 2);
    assert.equal(rules.bossBgm.rules[0].track, 'm_bat_abyssalhunters');
    assert.equal(rules.bossBgm.rules[1].track, 'x:my_boss_theme', '自定义曲保留 x: 前缀');
    assert.equal(bossBgmTrackFor(rules, 19), 'x:my_boss_theme');
    assert.equal(bossBgmTrackFor(rules, 18), 'm_bat_abyssalhunters');
  });

  test('非法曲目丢弃：x: 后含点/斜杠/空；大写与连字符合法', () => {
    const rules = load({ enabled: true, rules: [
      { round: 1, track: 'x:../etc/passwd' },
      { round: 2, track: 'x:has.dot' },
      { round: 3, track: 'x:' },
      { round: 4, track: 'x:My-Theme_01' },
    ] });
    assert.equal(rules.bossBgm.rules.length, 1, '只留合法那条');
    assert.equal(rules.bossBgm.rules[0].track, 'x:My-Theme_01');
    assert.equal(rules.bossBgm.rules[0].round, 4);
  });

  test('全关（enabled:false）= 无 bossBgm 规则（原版行为）', () => {
    const rules = load({ enabled: false, rules: [{ round: 18, track: 'x:any' }] });
    assert.equal(rules.bossBgm, null);
  });
});
