// server/match/scaling.js — how the match scales when a room holds more than the seeded 4 players (SP_MAX_SEATS).
//
// The whole 6-player feature is additive: at 4 alive players or fewer every factor below is exactly 1, so the pool
// copies and the shared leader pool are byte-for-byte the original game (the `MAX_SEATS` default). Only 5–6 players
// scale, and both rules are linear in the number of Final-Assault pairs.
//
//   * ONE Final Assault pair per 2 alive players (finalAssault.pairPlayers), so 4 players = 2 fields, 6 = 3 fields.
//   * 牌库 (the shared chess pool): each player needs a comparable slice of the shop pool, so the per-tier copies
//     (gamedata.DEFAULTS.poolCopies, configurable via economy.poolCopies) are multiplied by players / 4. Per-chess
//     overrides (economy.poolCopiesOverrides, e.g. 缪尔赛思 4) are *content* rules about that one operator and are
//     never scaled. The invariant `left + Σ held == cap` in invariants.js keeps holding, because it compares against
//     the pool's own `cap`, which is what gets scaled.
//   * The shared leader HP pool: its difficulty value is measured for a 4-player team. One pool serves every field
//     and every field holds a mirrored leader of its own, so a third field is a third leader to burn down: the pool
//     is multiplied by pairs / 2 (= ×1.5 at 6 players). 5 players is `2 + 2 + 1`, i.e. 3 fields, so also ×1.5.
//   * The scaling is off at ≤4 *alive* players even when the room seats 6 (eliminations must not shrink the leader
//     pool — official 5114's "敌方领袖的总生命值不变", and the reason bossHpScale.aliveScaling is off by default).

/** Final Assault / 联防 group size (finalAssault.pairPlayers). */
export const PAIR_SIZE = 2;
/** Alive-player count the seeded mode's pool copies and leader HP are measured for. */
export const FULL_TEAM = 4;

/** Final Assault fields for `alive` players: alive / 2 rounded up (an odd player holds a field alone). */
export function coopPairCount(alive) {
  const n = Math.max(1, Math.floor(Number(alive)) || 1);
  return Math.ceil(n / PAIR_SIZE);
}

/**
 * Multiplier of the per-tier chess pool copies (gamedata.poolCopies): players / 4, and exactly 1 at ≤4 players.
 * 4 ⇒ 1, 5 ⇒ 1.25, 6 ⇒ 1.5.
 */
export function poolCopyMulFor(players) {
  const n = Math.floor(Number(players)) || 0;
  if (n <= FULL_TEAM) return 1;
  return n / FULL_TEAM;
}

/**
 * How many 盟约 to disable in a room bigger than the seeded 4 (`config.bans`: core = faction bonds, addon = the rest).
 *
 * The official co-op value (绝境/终极 `{ core: 3, addon: 4 }`, 标准 `{ core: 0, addon: 1 }`) is measured for a
 * 4-player team and is exactly what ≤4 players keeps. A 6-player team is a different shape, so its draw is lighter
 * on the *core* bonds — the faction identities, each of which drags 2.6 of the 112 chess out of the pool on average
 * against an addon bond's 1.6 — and lighter on the addons too: `{ core: 2, addon: 3 }`. Measured over every
 * combination that disables 13.8 chess on average where the 4-player baseline disables 22.0, i.e. a six-player room
 * is deliberately more permissive than four (user decision).
 *
 * @param {number} players seated players
 * @returns {{ core: number, addon: number } | null} null ⇒ the mode's own value applies
 */
export function coopBansFor(players) {
  const n = Math.floor(Number(players)) || 0;
  if (n <= FULL_TEAM) return null;
  return { core: 2, addon: 3 };
}

/**
 * Multiplier of the shared leader HP pool over the data's `bloodPoint[difficulty]`: Final-Assault pairs / 2, and
 * exactly 1 at ≤4 alive players (so an elimination never shortens the bar). 4 alive ⇒ 1, 5–6 alive ⇒ 1.5.
 */
export function bossPoolShareFor(alive) {
  const n = Math.floor(Number(alive)) || 0;
  if (n <= FULL_TEAM) return 1;
  return coopPairCount(n) / coopPairCount(FULL_TEAM);
}
