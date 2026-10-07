// 4 players on a 6-seat server (SP_MAX_SEATS=6) must be the OFFICIAL game, not merely similar.
//
// The whole 6-player feature hangs off one value: `Match.seatCount = players.size` (server/match/Match.js). A room's
// capacity (`Lobby.maxSeats`) only decides how many seat slots the room has and how wide the protocol bounds are — it
// is never threaded into the match. So a room that seats 6 but starts with 4 players must draw the official ban set,
// the official 牌库 copies, the official leader pool and the official two Final Assault fields.
//
// This is the property the user asked about ("用 6 人服玩 4 人会有影响吗?"), measured rather than asserted.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../../server/index.js';
import { Match as RealMatch } from '../../server/match/Match.js';
import { SharedPool } from '../../server/match/pool.js';
import { bossPoolHp, pairPlayers } from '../../server/match/finalAssault.js';
import { bossPoolShareFor, poolCopyMulFor } from '../../server/match/scaling.js';
import { MAX_SEATS } from '../../shared/constants.js';
import { RESULT_LIMITS, setSeatLimit } from '../../shared/protocol.js';
import { TestClient } from '../helpers/wsClient.js';

const SEED = 4242;

/** Boot a server whose rooms seat `maxSeats`, fill a coop room with `players` humans, and start the match. */
async function startMatchWith({ maxSeats, players, difficulty = 'HARD' }) {
  const errors = [];
  const log = { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) };
  const srv = await startServer({ port: 0, host: '127.0.0.1', log, MatchClass: RealMatch, seedFn: () => SEED, maxSeats });
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const clients = [];
  try {
    for (let i = 0; i < players; i++) {
      const c = await TestClient.connect(url);
      const w = await c.hello(`P${i}`);
      c.id = w.playerId;
      c.welcome = w;
      clients.push(c);
    }
    const host = clients[0];
    await host.request({ t: 'room.create', mode: 'coop', difficulty });
    const created = await host.waitFor('room.state');
    const code = created.code;
    for (let i = 1; i < clients.length; i++) {
      await clients[i].request({ t: 'room.join', code });
      await clients[i].waitFor('room.state');
      await clients[i].request({ t: 'room.ready', ready: true });
    }
    // the room frame with everyone seated (the one `created` carries is the host alone)
    const room = await host.waitFor('room.state', (s) => s.seats.filter(Boolean).length === players);
    await host.request({ t: 'room.start' });
    await host.waitFor('room.state', (s) => s.inMatch, 15000);
    const match = srv.lobby.getRoom(code).match;
    assert.ok(match, 'the match started');
    assert.deepEqual(errors, [], 'no server errors logged');
    return { srv, clients, room, match, capSum: (pool) => [...pool.entries.values()].reduce((s, e) => s + e.cap, 0) };
  } catch (e) {
    await Promise.all(clients.map((c) => c.terminate().catch(() => {})));
    await srv.close();
    throw e;
  }
}

test('4 players on a 6-seat server: the same room capacity, but the match is the official 4-player one', async (t) => {
  const four = await startMatchWith({ maxSeats: MAX_SEATS, players: 4 });
  const six = await startMatchWith({ maxSeats: 6, players: 4 });
  // read the seat-derived protocol bound while the 6-seat server is the live one, then put the process state back
  const boundsWithSix = RESULT_LIMITS.players;
  setSeatLimit(MAX_SEATS);
  t.after(async () => {
    await Promise.all(four.clients.map((c) => c.terminate().catch(() => {})));
    await Promise.all(six.clients.map((c) => c.terminate().catch(() => {})));
    await four.srv.close();
    await six.srv.close();
  });

  // --- the room really is bigger on the 6-seat server -------------------------------
  assert.equal(four.room.maxSeats, 4);
  assert.equal(four.room.seats.length, 4, 'a 4-seat room has four slots');
  assert.equal(six.room.maxSeats, 6);
  assert.equal(six.room.seats.length, 6, 'a 6-seat room has six slots (two stay empty)');
  assert.equal(six.room.seats.filter(Boolean).length, 4, 'only four of them are taken');

  // --- but the match sees four players, not six ------------------------------------
  assert.equal(four.match.seatCount, 4);
  assert.equal(six.match.seatCount, 4, 'seatCount follows the players who joined, NOT the room capacity');
  assert.equal(six.match.players.size, 4);
  assert.equal(six.match.order.length, 4);

  // --- every scaling factor is exactly 1 -------------------------------------------
  assert.equal(poolCopyMulFor(six.match.seatCount), 1, '牌库 ×1');
  assert.equal(bossPoolShareFor(six.match.seatCount), 1, 'leader pool ×1');
  assert.equal(pairPlayers([...six.match.players.values()]).length, 2, 'two Final Assault fields, as official');

  // --- the drawn bans are identical (the mode's own value at HARD = 3 core + 4 addon)
  assert.deepEqual(six.match.disabledBonds, four.match.disabledBonds, 'same disabled bonds');
  assert.deepEqual(six.match.bannedChess, four.match.bannedChess, 'same banned chess');
  assert.equal(six.match.disabledBonds.length, 7, 'HARD: the official 3 core + 4 addon');

  // --- the shared 牌库 is copy-for-copy the same -----------------------------------
  assert.equal(six.capSum(six.match.pool), four.capSum(four.match.pool), 'the same total copies');
  for (const [id, e] of four.match.pool.entries) {
    assert.equal(six.match.pool.cap(id), e.cap, `pool copy of ${id} is unchanged by the room's capacity`);
  }
  assert.deepEqual([...six.match.pool.entries.keys()].sort(), [...four.match.pool.entries.keys()].sort(), 'the same chess');

  // and it equals a pool built by hand from the data at the official 4-player factor
  const plain = new SharedPool(four.match.gd, { players: 4, banned: four.match.bannedChess });
  assert.equal(six.capSum(six.match.pool), [...plain.entries.values()].reduce((s, e) => s + e.cap, 0));

  // --- the shared leader pool is the official value --------------------------------
  const official = bossPoolHp(four.match.gd, four.match.bossId, 4, 0); // no seat count = the seeded 4-player value
  assert.equal(bossPoolHp(six.match.gd, six.match.bossId, 4, six.match.seatCount), official, 'the official leader pool');

  // --- and the client is only told the room is bigger, not the match ----------------
  assert.equal(six.clients[0].welcome.maxSeats, 6, 'the client knows the ROOM seats six');
  assert.equal(boundsWithSix, 6, 'and its protocol bounds follow that room');
});

test('the ported files define every symbol they use (no bare MAX_SEATS-style reference)', async () => {
  // The 6-player port removed MAX_SEATS from shared/protocol.js's import while room.kick still used it, which made every
  // room.kick throw ReferenceError. This guards the whole class: each ported file must import or define what it uses.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const SYMBOLS = ['MAX_SEATS', 'MAX_SEATS_LIMIT', 'setMaxSeats', 'setSeatLimit', 'RESULT_LIMITS',
    'poolCopyMulFor', 'bossPoolShareFor', 'coopBansFor', 'PAIR_SIZE', 'FULL_TEAM'];
  const files = [
    'shared/constants.js', 'shared/protocol.js', 'server/index.js', 'server/lobby.js', 'server/net.js',
    'server/match/Match.js', 'server/match/pool.js', 'server/match/gamedata.js', 'server/match/audit.js',
    'server/match/finalAssault.js', 'server/match/scaling.js',
    'public/js/net.js', 'public/js/battle/runner.js', 'public/js/screens/room.js', 'public/js/screens/lobby.js',
    'public/js/ui/gameComponents.js',
  ];
  const missing = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    for (const sym of SYMBOLS) {
      const used = new RegExp(`(?<![.\\w$])${sym}(?![\\w$])`).test(code);
      if (!used) continue;
      const imported = new RegExp(`import\\s*\\{[^}]*\\b${sym}\\b[^}]*\\}`).test(code)
        || new RegExp(`\\b(export\\s+)?(const|let|var|function|class)\\s+${sym}\\b`).test(code);
      if (!imported) missing.push(`${rel} uses ${sym} without importing or defining it`);
    }
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});