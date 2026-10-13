// test/content/op_oblvns.test.js — the 自选 operator kit of 丰川祥子 (char_4182_oblvns, 6★ 领主/lord; kit
// server/sim/content/kits/ops/op-oblvns.js), fielded the production way (a DIY slot + its `diy` pick, simdata getDiy)
// in every form: tiers 5 / 6, normal (E2 Lv1, rank 4, no module) and elite (E2 Lv60, rank 7) with no module or LOR-Y
// “残响的余韵” at stage 1 (tier 5) / 3 (tier 6). Numbers read back from data/backups.json (built 2026-10-13, a2bd389d).
// Run: node --test test/content/op_oblvns.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeBattle, enemyRec, checkInvariants } from '../helpers/battleHarness.js';
import { KITTED_CHARS, OPERATOR_KITS, KITS } from '../../server/sim/content/kits/index.js';
import { diyPool, validateDiyPicks } from '../../shared/diy.js';

const load = (f) => JSON.parse(readFileSync(new URL(`../../data/${f}.json`, import.meta.url), 'utf8'));
const CHESS = load('chess');
const BACKUPS = load('backups');
const SAKIKO = 'char_4182_oblvns';
const LORY = 'uniequip_002_oblvns';
const S1 = 'skchr_oblvns_1', S2 = 'skchr_oblvns_2', S3 = 'skchr_oblvns_3';
const FORMS = BACKUPS.units[SAKIKO].forms;
const SLOT = { 5: 'chess_char_5_diy1_a', 6: 'chess_char_6_diy1_a' };
const statusKey = (tier, elite) => (elite ? (tier === 5 ? '2/60/7/1' : '2/60/7/3') : '2/1/4/0');
const formOf = (tier, elite) => FORMS[statusKey(tier, elite)];
const dummy = (key, o = {}) => enemyRec({ key, hp: 1e9, speed: 0, mass: 0, ...o });
const ENEMIES = {
  enemy_dummy: dummy('enemy_dummy'),
  enemy_tank: dummy('enemy_tank', { def: 400, magicResistance: 0 }),
  enemy_caster: dummy('enemy_caster', { def: 0, magicResistance: 60 }),
};
const label = ([tier, elite, mod]) => `T${tier} ${elite ? 'elite' : 'normal'} ${mod ?? 'none'}`;

/** 祥子 at (9, 2) facing RIGHT as uid 1, a DIY pick of the tier slot. */
function field({ tier = 5, elite = false, mod = null, skill = 0, others = [], seed = 5, dp = 99 } = {}) {
  const h = makeBattle({
    defs: { enemies: ENEMIES }, timeLimit: 900, autoFinish: false, seed,
    flags: { dpInit: dp, dpPerSec: 0, dpMax: 999 },
    hooks: ['damaged', 'attack', 'skillStart', 'skillEnd', 'death', 'deploy'], captureNoisy: true,
    units: [{ uid: 1, diy: { slot: SLOT[tier], charId: SAKIKO, skillIndex: skill, uniEquipId: mod }, elite, row: 9, col: 2 }, ...others],
  });
  h.step();
  return { h, u: h.unit(1) };
}
function done(h) {
  checkInvariants(h.b);
  assert.equal(h.b.errors.length, 0, JSON.stringify(h.b.errors[0]));
}
const atkHits = (h, u) => h.hooksOf('damaged').filter((c) => c.source === u && c.dmg?.isAttack);

test('丰川祥子 in every 自选 form: her operator kit (all three skills authored), the form\'s stats, 领主, no 特质', () => {
  assert.equal(OPERATOR_KITS[SAKIKO], KITS[SAKIKO]);
  assert.ok(KITTED_CHARS.includes(SAKIKO), 'she is kitted → offered');
  for (const tier of [5, 6]) {
    for (const elite of [false, true]) {
      for (const mod of elite ? [null, LORY] : [null]) {
        for (const skill of [0, 1, 2]) {
          const { h, u } = field({ tier, elite, mod, skill });
          const form = formOf(tier, elite);
          assert.deepEqual([u.def.charId, u.skill.id, !!u.kit.generic, u.kit.skillSource],
            [SAKIKO, form.skills[skill].skillId, false, 'skills'], label([tier, elite, mod]));
          assert.equal(u.profile.dmgType, 'phys', label([tier, elite, mod]) + ': 领主物理');
          assert.ok(u.profile.canHitFly, label([tier, elite, mod]) + ': 领主对空');
          assert.deepEqual(u.def.bonds, BACKUPS.diy.operators[SAKIKO].bonds, label([tier, elite, mod]) + ': bonds');
          done(h);
        }
      }
    }
  }
});

test('she is offered as a 自选 pick of both tiers, and validateDiyPicks accepts every authored skill + LOR-Y', () => {
  for (const tier of [5, 6]) {
    const data = { chess: CHESS, backups: BACKUPS };
    assert.ok(diyPool(tier, { data }).includes(SAKIKO), `tier-${tier} pool offers her`);
    for (const elite of [false, true]) {
      const form = formOf(tier, elite);
      const skills = form.skills.map((s) => s.index);
      const mods = elite ? [null, LORY] : [null];
      for (const skillIndex of skills) for (const uniEquipId of mods) {
        const r = validateDiyPicks({ [SLOT[tier]]: { charId: SAKIKO, skillIndex, uniEquipId } }, { data, kitted: KITTED_CHARS });
        assert.ok(r.ok, `tier-${tier} elite=${elite} skill=${skillIndex} mod=${uniEquipId}: ${r && r.error} ${r && r.detail || ''}`);
      }
    }
  }
});

test('S1 演奏·坠: the 8-note decay chain splashes the other enemies of her range (arts, falling scales)', () => {
  const { h, u } = field({ tier: 6, elite: true, mod: null, skill: 0 });
  const t = h.spawn('enemy_dummy', { pos: [9, 5] });
  const t2 = h.spawn('enemy_dummy', { pos: [9, 6] });
    assert.ok(h.runUntil(() => u.skill.active, 12), "S1 cast (attack-recovery fills the 2 charges)");
  h.run(6);
  const notes = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg?.tags?.includes('oblvns:note'));
  assert.ok(notes.length > 0, 'decay notes land');
  const arts = notes.filter((c) => c.dmg.type === 'arts');
  assert.equal(arts.length, notes.length, 'the falling chain is arts');
  const scales = [...new Set(notes.map((c) => +(c.dmg.amount / (u.base.atk || 1)).toFixed(2)))];
  assert.ok(scales.length >= 2, `more than one distinct scale among the notes (${scales.join(',')})`);
  done(h);
});

test('S2 满月的舞会: 钢琴 (default) attacks hit physically at +110% ATK; 风琴 swaps to arts (the kit reads the toggle)', () => {
  const piano = field({ tier: 6, elite: true, skill: 1 });
  // (no mute: S2 is attack-recovery too, and we want her beats flowing)
  const t = piano.h.spawn('enemy_dummy', { pos: [9, 5] });
  piano.h.run(4);
  const hits = atkHits(piano.h, piano.u);
  assert.ok(hits.length > 0, 'piano attacks land');
  assert.ok(hits.every((c) => c.dmg.type === 'phys'), 'piano notes are physical');
  done(piano.h);
  const organ = field({ tier: 6, elite: true, skill: 1 });
  organ.h.spawn('enemy_dummy', { pos: [9, 5] });
  assert.ok(organ.h.runUntil(() => organ.u.skill.active, 12), 'S2 cast (switches the voice)');
  organ.h.run(2); // after the switch her beats carry the new voice
  const ohits = atkHits(organ.h, organ.u);
  assert.ok(ohits.length > 0, 'organ attacks land');
  assert.ok(ohits.every((c) => c.dmg.type === 'arts'), 'organ notes are arts');
  done(organ.h);
});

test('S3 残月的余响 (25 s): the 双声部 notes track the highest-RES enemy with arts and the highest-DEF enemy with phys (PRTS 语序配对)', () => {
  const { h, u } = field({ tier: 6, elite: true, skill: 2 });
  const tank = h.spawn('enemy_tank', { pos: [9, 5] });   // highest DEF
  const caster = h.spawn('enemy_caster', { pos: [9, 6] }); // highest RES
  assert.ok(h.runUntil(() => u.skill.active, 14), 'S3 cast (attack-recovery)');
  h.run(6);
  const notes = h.hooksOf('damaged').filter((c) => c.source === u && c.dmg?.tags?.includes('oblvns:note'));
  const toTank = notes.filter((c) => c.target === tank);
  const toCaster = notes.filter((c) => c.target === caster);
  const physToCaster = toCaster.filter((c) => c.dmg.type === 'phys');
  const artsToTank = toTank.filter((c) => c.dmg.type === 'arts');
  // PRTS 语序: 物理音符 → 法术抗性最高 (caster), 法术音符 → 防御力最高 (tank)
  assert.ok(physToCaster.length > 0, 'phys notes track the highest-RES enemy');
  assert.ok(artsToTank.length > 0, 'arts notes track the highest-DEF enemy');
  done(h);
});
