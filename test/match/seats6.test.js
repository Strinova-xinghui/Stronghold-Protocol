// 6-seat co-op (SP_MAX_SEATS=6): the seat capacity, the 牌库 (shared pool) scaling and the leader-pool scaling.
// The rule (DESIGN §23): the 6-player layout is THREE independent Final Assault fields (pairs (1,2), (3,4), (5,6)),
// the 牌库 scales with the number of players and the shared leader HP pool with the number of fields — and at 4
// players or fewer every factor is exactly 1, so nothing about the original game changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE, MAX_SEATS, MAX_SEATS_LIMIT, setMaxSeats } from '../../shared/constants.js';
import { validateC2S, RESULT_LIMITS, setSeatLimit } from '../../shared/protocol.js';
import { pairPlayers, bossPoolHp, SharedBossPool } from '../../server/match/finalAssault.js';
import { coopPairCount, poolCopyMulFor, bossPoolShareFor, coopBansFor, PAIR_SIZE, FULL_TEAM } from '../../server/match/scaling.js';
import { SharedPool } from '../../server/match/pool.js';
import { normalizeSeats, seatCapacity } from '../../public/js/screens/room.js';
import { FakeBattle } from './fakeBattle.js';
import { DATA, makeMatch } from './harness.js';

const bossFields = () => FakeBattle.instances.filter((b) => b.kind === 'boss' || b.kind === 'hidden');

// ---------------------------------------------------------------------------------------------------
// the capacity itself
// ---------------------------------------------------------------------------------------------------

test('seat capacity: 4 by default, 6 selectable, above the cap refused', () => {
  assert.equal(MAX_SEATS, 4, 'a seeded server stays the official 4');
  assert.equal(MAX_SEATS_LIMIT, 6);
  assert.equal(setMaxSeats(6), 6);
  assert.equal(setMaxSeats(4), 4, 'and back');
  for (const bad of [0, -1, 7, 1.5, NaN, '6']) assert.throws(() => setMaxSeats(bad), RangeError, String(bad));
});

test('the seat-derived protocol bounds follow the seat limit', () => {
  try {
    assert.equal(RESULT_LIMITS.players, 4);
    assert.notEqual(validateC2S({ t: 'room.removeBot', seat: 4 }), null, 'seat 4 is out of range at 4 seats');
    setSeatLimit(6);
    assert.equal(RESULT_LIMITS.players, 6, 'b.result accepts six per-player entries');
    assert.equal(validateC2S({ t: 'room.removeBot', seat: 5 }), null, 'seat 5 removable at 6 seats');
    assert.notEqual(validateC2S({ t: 'room.removeBot', seat: 6 }), null, 'and seat 6 still refused');
  } finally {
    setSeatLimit(4);
  }
});

test('the seat padding follows the capacity the server reports (solo stays 1)', () => {
  assert.equal(seatCapacity({ mode: 'coop', maxSeats: 6, seats: [] }), 6);
  assert.equal(normalizeSeats({ mode: 'coop', maxSeats: 6, seats: new Array(6).fill(null) }).length, 6);
  assert.equal(normalizeSeats({ mode: 'coop', seats: [null, null, null, null] }).length, 4, 'fallback: the array sent');
  assert.equal(normalizeSeats({ mode: 'coop' }).length, MAX_SEATS, 'fallback: MAX_SEATS');
  assert.equal(normalizeSeats({ mode: 'solo', maxSeats: 6, seats: [null] }).length, 1, 'a solo room is one seat');
});

// ---------------------------------------------------------------------------------------------------
// the two scaling rules
// ---------------------------------------------------------------------------------------------------

test('one Final Assault field per 2 alive players; the pair count drives the scaling', () => {
  const p = (seat) => ({ seat, playerId: `s${seat}` });
  const groups = (n) => pairPlayers(Array.from({ length: n }, (_, i) => p(i)));
  for (const [n, want] of [[1, 1], [2, 1], [3, 2], [4, 2], [5, 3], [6, 3]]) {
    assert.equal(groups(n).length, want, `${n} alive → ${want} field(s)`);
    assert.equal(coopPairCount(n), want);
  }
  assert.deepEqual(groups(6).map((g) => g.map((x) => x.seat)), [[0, 1], [2, 3], [4, 5]]);
  assert.deepEqual(groups(5).map((g) => g.map((x) => x.seat)), [[0, 1], [2, 3], [4]]);
  assert.equal(PAIR_SIZE, 2);
  assert.equal(FULL_TEAM, 4);
});

test('牌库 scaling: 1 at ≤4 players, players / 4 above', () => {
  for (const n of [0, 1, 2, 3, 4, undefined]) assert.equal(poolCopyMulFor(n), 1, `${n} players`);
  assert.equal(poolCopyMulFor(5), 1.25);
  assert.equal(poolCopyMulFor(6), 1.5);
  assert.equal(poolCopyMulFor(9), 2.25, 'the formula is flat, not capped (the seat cap is elsewhere)');
});

test('leader-pool scaling: 1 at ≤4 alive, fields / 2 above — eliminations never shrink it', () => {
  for (const n of [0, 1, 2, 3, 4, undefined]) assert.equal(bossPoolShareFor(n), 1, `${n} alive`);
  assert.equal(bossPoolShareFor(5), 1.5, '5 alive is 2+2+1 = 3 fields');
  assert.equal(bossPoolShareFor(6), 1.5);
});

test('盟约 bans: the official draw at ≤4 seats, the lighter 6-player draw above', () => {
  const h4 = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 4, seed: 5, fake: true });
  const h6 = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 6, seed: 5, fake: true });
  for (const n of [0, 1, 2, 3, 4]) assert.equal(coopBansFor(n), null, `${n} seats use the mode value`);
  assert.deepEqual(coopBansFor(5), { core: 2, addon: 3 });
  assert.deepEqual(coopBansFor(6), { core: 2, addon: 3 });

  // the mode's own (official) value is what ≤4 uses — 绝境 is { core: 3, addon: 4 } in the data
  assert.deepEqual(h4.m.gd.bans('HARD', 4), { core: 3, addon: 4 }, '4 seats: the official draw');
  assert.deepEqual(h4.m.gd.bans('HARD', 0), { core: 3, addon: 4 }, 'no count given: still the official draw');
  assert.deepEqual(h6.m.gd.bans('HARD', 6), { core: 2, addon: 3 }, '6 seats: core 2 + addon 3');

  // and the match really drew that many: count the disabled bonds it holds
  const drawn4 = h4.m.disabledBonds.length;
  const drawn6 = h6.m.disabledBonds.length;
  assert.equal(drawn4, 3 + 4, '4 seats drew 3 core + 4 addon');
  assert.equal(drawn6, 2 + 3, '6 seats drew 2 core + 3 addon');
  const coreOf = (m, ids) => ids.filter((b) => m.gd.bond(b)?.isCore).length;
  assert.equal(coreOf(h4.m, h4.m.disabledBonds), 3, '4 seats: 3 core bonds');
  assert.equal(coreOf(h6.m, h6.m.disabledBonds), 2, '6 seats: 2 core bonds');
});

test('the shared pool scales its copies with the seat count, but never a per-chess override', () => {
  // char_002_amiya is a normal pool chess; find one with a per-chess override for the other half of the rule
  const gd = makeMatch({ humans: 4, fake: true }).m.gd;
  const id = gd.visibleChess.find((c) => Number.isInteger(gd.economy.poolCopiesOverrides?.[c]));
  const base4 = new SharedPool(gd, { players: 4 });
  const base6 = new SharedPool(gd, { players: 6 });
  const tiers = new Map();
  for (const [cid, e] of base4.entries) tiers.set(e.tier, cid);
  for (const [tier, cid] of tiers) {
    const a = base4.cap(cid);
    const b = base6.cap(cid);
    if (id === cid) assert.equal(b, a, `override ${cid} (tier ${tier}) is content, not scaled`);
    else assert.equal(b, Math.round(a * 1.5), `tier ${tier} copy ${cid}: ${a} → ${b}`);
  }
  assert.ok(base6.totalLeft() > base4.totalLeft(), '6 players get a bigger 牌库');
  // not exactly 1.5×: every chess's copies are rounded on their own, so the sum drifts a little either way
  const ratio = base6.totalLeft() / base4.totalLeft();
  assert.ok(ratio > 1.4 && ratio < 1.6, `the 牌库 grows by about 1.5× (${base4.totalLeft()} → ${base6.totalLeft()})`);
});

// ---------------------------------------------------------------------------------------------------
// a real match at 6 seats
// ---------------------------------------------------------------------------------------------------

test('6 players: seatCount, a 1.5× pool, and three Final Assault fields on one shared leader pool', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 6, seed: 606, fake: true, script: (b) => (b.kind === 'boss' ? { bossDps: 1e9 } : {}) }).start();
  const m = h.m;
  assert.equal(m.seatCount, 6);
  assert.equal(m.players.size, 6);

  // ≤4 stays byte-for-byte the original: every chess the 4-seat match holds keeps the unscaled per-chess capacity.
  // The 6-seat match draws a DIFFERENT ban set (scaling.js coopBansFor), so its pool is compared against a fresh
  // pool built with that same ban set — otherwise the comparison would mix "scaled copies" with "different bans".
  const h4 = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 4, seed: 606, fake: true }).start();
  assert.equal(h4.m.seatCount, 4);
  const ids = [...h4.m.pool.entries.keys()];
  const plain4 = new SharedPool(h4.m.gd, { players: 4, banned: h4.m.bannedChess });
  const plain6 = new SharedPool(m.gd, { players: 6, banned: m.bannedChess });
  const capSum = (p, set = ids) => set.reduce((s, cid) => s + p.cap(cid), 0);
  assert.equal(capSum(h4.m.pool), capSum(plain4), '4 seats: nothing was scaled');
  for (const cid of ids) assert.equal(h4.m.pool.cap(cid), plain4.cap(cid), `4 seats: ${cid} keeps its official copies`);

  const ids6 = [...m.pool.entries.keys()];
  assert.equal(capSum(m.pool, ids6), capSum(plain6, ids6), '6 seats: every copy of that pool is scaled');
  for (const cid of ids6) {
    assert.equal(m.pool.cap(cid), plain6.cap(cid), `6 seats: ${cid} scaled`);
    if (!ids.includes(cid)) continue;
    const override = m.gd.economy.poolCopiesOverrides?.[cid];
    if (Number.isInteger(override) && override >= 0) {
      // a per-chess override is a content rule about that one operator and is never scaled
      assert.equal(m.pool.cap(cid), plain4.cap(cid), `6 seats: ${cid} keeps its override`);
      assert.equal(m.pool.cap(cid), override, `6 seats: ${cid} is the configured ${override}`);
    } else {
      assert.ok(m.pool.cap(cid) > plain4.cap(cid), `6 seats: ${cid} holds more copies than at 4`);
    }
  }
  // (whether a given draw leaves MORE chess in the pool is seed-dependent — the ban rule is covered by its own
  //  test above, which checks the counts, not one seed's outcome)

  h.drive(() => m.phase === PHASE.PREP && m.round === m.gd.bossRound);
  h.drive(() => m.phase === PHASE.FINAL_ASSAULT);

  const fields = bossFields();
  assert.equal(fields.length, 3, 'six players is three pair fields');
  assert.deepEqual(fields.map((f) => f.fieldId), ['b1', 'b2', 'b3']);
  const pool = fields[0].sharedBoss;
  assert.ok(fields.every((f) => f.sharedBoss === pool), 'every field damages the SAME leader pool');
  assert.equal(pool.maxHp, bossPoolHp(m.gd, m.bossId, 6, 6), 'the pool is scaled by the field count');
  assert.equal(pool.maxHp, Math.round(bossPoolHp(m.gd, m.bossId, 4) * 1.5), '= 1.5× the official 4-player pool');
  for (const f of fields) {
    assert.deepEqual(f.opts.players.map((p) => p.side), ['L', 'R'], 'each field keeps the L/R halves');
    assert.ok(f.opts.players.every((p) => p.lpForBoss === m.teamLp), 'one merged team LP');
  }
});

test('4 players (and fewer) are untouched by the 6-seat rules', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'FUNNY', humans: 4, seed: 44, fake: true, script: (b) => (b.kind === 'boss' ? { bossDps: 1e9 } : {}) }).start();
  const m = h.m;
  assert.equal(m.seatCount, 4);
  h.drive(() => m.phase === PHASE.FINAL_ASSAULT);
  const fields = bossFields();
  assert.equal(fields.length, 2, 'the original two fields');
  assert.deepEqual(fields.map((f) => f.fieldId), ['b1', 'b2']);
  assert.equal(fields[0].sharedBoss.maxHp, bossPoolHp(m.gd, m.bossId, 4), 'the official pool, unscaled');
  assert.equal(fields[0].sharedBoss.maxHp, new SharedBossPool(bossPoolHp(m.gd, m.bossId, 4)).maxHp);
});
