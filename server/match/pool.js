// server/match/pool.js — the SHARED chess pool (copies per base chess, across all players), per-match bans,
// copy-weighted shop rolls (research 00-INDEX §3, §6; DESIGN §6.2).
//
// Model:
//   * Every visible (non-hidden, non-DIY) base chess that is not banned this match has `cap` copies
//     (config.economy.poolCopies[tier], overrides e.g. 缪尔赛思 4). `left[baseId]` = copies not owned by anyone.
//   * Owning a piece takes copies: a normal piece holds 1, an elite holds 3 (merge of 3 normals). Shop displays
//     do NOT reserve copies; buying fails (SOLD_OUT) when left = 0.
//   * Pieces remember how many copies they hold (`piece.poolCopies`), so selling / elimination / temp wipes return
//     exactly what was taken — chess granted by effects while the pool is empty (or hidden/banned chess) hold 0.
//   * Invariant (tests): 0 ≤ left ≤ cap and left + Σ held copies == cap for every base chess.
//
// Rolls: each chess slot draws ONE copy uniformly from all remaining copies of eligible chess with tier ≤ shop level
// ("copy-weighted"; duplicates within a roll allowed). The item slot picks a tier with the same tier shares, then a
// uniform shop-eligible item of that tier (falling back to lower tiers).

/**
 * Per-match disabled bond set D and banned chess (research 01 A2): D = uniform sample of `core` core bonds and `addon`
 * add-on bonds among weight > 0 bonds that are active in the mode. A visible chess is banned iff every one of its
 * bonds is in D ∪ mode.inactiveBondIds.
 * @param {import('./gamedata.js').GameData} gd
 * @param {Function} rng seeded rng (createRng)
 * @returns {{ drawn: string[], staticOff: string[], banned: string[] }}
 */
export function drawDisabledBonds(gd, rng, { players = 0 } = {}) {
  const { core: nCore, addon: nAddon } = gd.bans(gd.difficulty, players);
  const staticOff = [...gd.modeInactiveBonds].filter((b) => gd.bond(b)).sort();
  const eligible = gd.bondIds.filter((b) => {
    const bond = gd.bond(b);
    return bond && Number(bond.weight) > 0 && !gd.modeInactiveBonds.has(b);
  });
  const core = eligible.filter((b) => gd.bond(b).isCore);
  const addon = eligible.filter((b) => !gd.bond(b).isCore);
  const drawn = [...sample(core, nCore, rng), ...sample(addon, nAddon, rng)].sort();
  const off = new Set([...drawn, ...staticOff]);
  const banned = [];
  for (const id of gd.visibleChess) {
    const c = gd.chess(id);
    const bonds = Array.isArray(c.bonds) ? c.bonds : [];
    if (bonds.length > 0 && bonds.every((b) => off.has(b))) banned.push(id);
  }
  return { drawn, staticOff, banned };
}

function sample(arr, n, rng) {
  const a = arr.slice();
  rng.shuffle(a);
  return a.slice(0, Math.max(0, Math.min(n, a.length)));
}

export class SharedPool {
  /**
   * @param {import('./gamedata.js').GameData} gd
   * @param {{ banned?: Iterable<string> }} [opts]
   */
  constructor(gd, { banned = [], players = 0 } = {}) {
    this.gd = gd;
    const ban = new Set(banned);
    /** @type {Map<string, { cap: number, left: number, tier: number }>} */
    this.entries = new Map();
    for (const id of gd.visibleChess) {
      if (ban.has(id)) continue;
      const cap = gd.poolCopies(id, players);
      if (cap <= 0) continue;
      this.entries.set(id, { cap, left: cap, tier: gd.tierOf(id) });
    }
    this.banned = [...ban].sort();
  }

  /** Whether a base chess is part of this match's pool (visible, not banned). */
  has(baseId) { return this.entries.has(baseId); }
  cap(baseId) { return this.entries.get(baseId)?.cap ?? 0; }
  left(baseId) { return this.entries.get(baseId)?.left ?? 0; }

  /** Take up to n copies; returns the number actually taken (0 when not in the pool / empty). */
  take(baseId, n = 1) {
    const e = this.entries.get(baseId);
    if (!e || !(n > 0)) return 0;
    const k = Math.min(e.left, Math.floor(n));
    e.left -= k;
    return k;
  }

  /** Return n copies (clamped at the cap). Returns the number actually returned. */
  give(baseId, n = 1) {
    const e = this.entries.get(baseId);
    if (!e || !(n > 0)) return 0;
    const k = Math.min(e.cap - e.left, Math.floor(n));
    e.left += k;
    return k;
  }

  /** Remaining copies of eligible chess (tier ≤ maxTier, or exactly `tier`). */
  _eligible({ maxTier = 6, tier = null, filter = null } = {}) {
    const out = [];
    for (const [id, e] of this.entries) {
      if (e.left <= 0) continue;
      if (tier != null ? e.tier !== tier : e.tier > maxTier) continue;
      if (filter && !filter(id, e)) continue;
      out.push([id, e.left]);
    }
    return out;
  }

  /**
   * Copy-weighted roll: one copy uniformly among remaining copies of eligible chess. Returns a base id or null.
   * `bondBoost`: optional Map<bondId, multiplier> — a chess carrying a boosted bond rolls with weight left × mult
   * (custom house rule, upstream-neutral: only re-weights the draw, never the pool's copies or accounting).
   * @param {Function} rng
   * @param {{ maxTier?: number, tier?: number|null, filter?: (id: string, e: object) => boolean,
   *           bondBoost?: Map<string, number> | null, gd?: object }} [opts]
   */
  roll(rng, opts = {}) {
    const el = this._eligible(opts);
    const boost = opts.bondBoost;
    const gd = boost && boost.size ? (opts.gd || this.gd) : null;
    let total = 0;
    const weights = [];
    for (let i = 0; i < el.length; i++) {
      const [id, n] = el[i];
      let w = n;
      if (gd) {
        const c = gd.chess(id);
        const bonds = c && Array.isArray(c.bonds) ? c.bonds : null;
        if (bonds) for (const b of bonds) {
          const mult = boost.get(b);
          if (mult && mult > 1) { w = n * mult; break; }
        }
      }
      weights.push(w);
      total += w;
    }
    if (total <= 0) return null;
    let r = rng() * total;
    for (let i = 0; i < el.length; i++) { r -= weights[i]; if (r < 0) return el[i][0]; }
    return el[el.length - 1][0];
  }

  /** Tier shares of a copy-weighted roll at shop level `maxTier` (current remaining copies). */
  tierShares(maxTier) {
    const t = {};
    let total = 0;
    for (const [, e] of this.entries) {
      if (e.tier > maxTier || e.left <= 0) continue;
      t[e.tier] = (t[e.tier] || 0) + e.left;
      total += e.left;
    }
    const out = {};
    for (const k of Object.keys(t)) out[k] = total > 0 ? t[k] / total : 0;
    return out;
  }

  /**
   * Item roll for the shop's item slot: tier by the chess tier shares at this level, uniform item within the tier,
   * falling back to lower tiers when a tier has no item. Returns an item id or null.
   *
   * 自研「装备甄选」（opts.bondBoost / opts.onTierMiss）：把 `giveBondId === 目标盟约` 的装备（= 能与变形同构体
   * 配合转职的那一类，数据驱动判定，不硬编码清单）权重提高到 `left × mult`。`onTierMiss='fallback'` 时，当前 tier
   * 层没有该阵营装备就退到最近的有该装备的层（保证命中，代价是可能给出低阶装备）；'random' 则保持层级退回随机。
   * 只改抽中的概率分布，不碰任何其它路径。
   * @param {Function} rng
   * @param {number} maxTier
   * @param {{ bondBoost?: Map<string, number> | null, onTierMiss?: 'fallback' | 'random' }} [opts]
   */
  rollItem(rng, maxTier, opts = {}) {
    const boost = opts.bondBoost;
    const gd = boost && boost.size ? this.gd : null;
    const shares = this.tierShares(maxTier);
    const tiers = Object.keys(shares).map(Number).sort((a, b) => a - b);
    let tier = null;
    if (tiers.length) {
      let r = rng();
      for (const t of tiers) { r -= shares[t]; if (r < 0) { tier = t; break; } }
      if (tier == null) tier = tiers[tiers.length - 1];
    } else {
      tier = 1 + Math.floor(rng() * Math.max(1, maxTier));
    }
    const pickFrom = (list) => {
      if (!gd) return list[Math.floor(rng() * list.length)];
      // 目标阵营装备（giveBondId 命中 boost）
      const isTarget = (id) => {
        const rec = gd.item(id);
        const b = rec && typeof rec.giveBondId === 'string' ? rec.giveBondId : null;
        return !!(b && boost.has(b));
      };
      if (opts.mode === 'filter') {
        const only = list.filter(isTarget);
        if (only.length) return only[Math.floor(rng() * only.length)];
        // 该层没有目标装备：走加权（weight 语义）作为兜底
      }
      // 加权：命中目标盟约的装备权重 × mult
      let total = 0;
      const weights = [];
      for (const id of list) {
        let w = 1;
        if (isTarget(id)) {
          const rec = gd.item(id);
          const m = boost.get(rec.giveBondId);
          if (m && m > 1) w = m;
        }
        weights.push(w); total += w;
      }
      let r = rng() * total;
      for (let i = 0; i < list.length; i++) { r -= weights[i]; if (r < 0) return list[i]; }
      return list[list.length - 1];
    };
    // 有目标盟约时：优先找「含目标装备」的层（按 onTierMiss 决定是否降级/升阶搜索）
    if (gd) {
      const hasTarget = (t) => {
        const list = this.gd.shopItemsByTier[t];
        return !!(list && list.length && list.some((id) => {
          const rec = gd.item(id);
          return rec && typeof rec.giveBondId === 'string' && boost.has(rec.giveBondId);
        }));
      };
      if (!hasTarget(tier)) {
        if (opts.onTierMiss === 'fallback') {
          // 从当前层向下、再向上找最近的有目标装备的层
          let found = null;
          for (let t = tier; t >= 1 && found == null; t--) if (hasTarget(t)) found = t;
          if (found == null) for (let t = tier + 1; t <= 6 && found == null; t++) if (hasTarget(t)) found = t;
          if (found != null) tier = found;
        }
        // 'random'：保持 tier，走下面的普通路径（甄选落空但不改层级）
      }
    }
    for (let t = tier; t >= 1; t--) {
      const list = this.gd.shopItemsByTier[t];
      if (list && list.length) return pickFrom(list);
    }
    for (let t = tier + 1; t <= 6; t++) {
      const list = this.gd.shopItemsByTier[t];
      if (list && list.length) return pickFrom(list);
    }
    return null;
  }

  /** { baseId: left } snapshot (tests / diagnostics). */
  snapshot() {
    const o = {};
    for (const [id, e] of this.entries) o[id] = e.left;
    return o;
  }

  totalLeft() {
    let n = 0;
    for (const e of this.entries.values()) n += e.left;
    return n;
  }
}
