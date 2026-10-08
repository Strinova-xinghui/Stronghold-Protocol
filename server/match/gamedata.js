// server/match/gamedata.js — typed, defaulted view of data/*.json for the match engine.
//
// Every lookup is an own-property lookup (ids come from client intents) that never throws and returns null for
// unknown ids. Tunables come from data/config.json with the documented defaults (research 00-INDEX §2–§8) when a
// key is missing, so a partial data set (tests, data being regenerated) still yields a working match.
//
// No custom balance (DESIGN §14 corrections, research 08 §6): enemy numbers are the official ones — the PRTS
// per-round enemyScale table of data/config.json, the leader pool = bloodPoint. data/tuning.json only overrides result
// titles:
//   titles[titleId]                                                { stat?, rule? } merged over config.titles
// (the former enemyHpMul / enemyAtkMul / enemySpeedMul / bossHpMul / flyPlaceholders knobs were removed; a tuning file
// that still carries them is ignored).

import { getConfig, getMode } from '../data.js';
import { getCustomRules } from './customRules.js';
import { isShopItem } from '../sim/simdata.js';
import { poolCopyMulFor, bossPoolShareFor, coopBansFor } from './scaling.js';

const own = (map, id) => (map && typeof map === 'object' && typeof id === 'string' && Object.hasOwn(map, id) && map[id] && typeof map[id] === 'object' ? map[id] : null);
const numOr = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const posIntOr = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);

export const DEFAULTS = Object.freeze({
  income: [0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 12, 12, 12, 12, 12],
  incomeCap: 12,
  chessPrice: { 1: 2, 2: 3, 3: 3, 4: 3, 5: 4, 6: 4 },
  sellPrice: 1,
  refreshPrice: 1,
  poolCopies: { 1: 12, 2: 14, 3: 18, 4: 16, 5: 8, 6: 5 },
  mergeCount: 3,
  goldenCopies: 3,
  itemMergeCount: 2,
  benchSize: 10,
  tempSize: 5,
  deployCap: 8,
  equipPerChess: 2,
  maxArtsPerRound: 2,
  rewardOffer: { count: 3, tierOffset: 1, maxTier: 6, price: 0 },
  upgradePrices: [5, 8, 11, 12, 13],
  maxShopLevel: 6,
  shopSlots: { 1: { chess: 3, item: 1 }, 2: { chess: 4, item: 1 }, 3: { chess: 4, item: 1 }, 4: { chess: 5, item: 1 }, 5: { chess: 5, item: 1 }, 6: { chess: 5, item: 1 } },
  defaultBandId: 'band_bldsk',
  defaultStartLp: 28,
  lpCapPerRound: 10,
  bossOvertimeAfter: 150,
  bossOvertimeDrainPerSec: 1,
  hiddenCore: { single: 350, multi: 1200, minTeamLpExclusive: 1, difficulties: ['NORMAL', 'HARD', 'ABYSS'] },
  dp: { init: 10, perSec: 1, max: 99 },
  unite: { maxHelpers: 2, templates: { 1: 'act1autochess_escaped_single', 2: 'act1autochess_escaped_multi' } },
  timers: { infoCheck: 25, bandDraft: 50, bandTurn: 30, battleCheck: 3, spFirst: 30, spTurn: 16 },
  bans: { FUNNY: { core: 0, addon: 1 }, NORMAL: { core: 3, addon: 4 }, HARD: { core: 3, addon: 4 }, ABYSS: { core: 3, addon: 4 } },
  bandDraft: { skipsPerPlayer: 1, timeoutBandId: 'band_bldsk' },
  leftoverFundsKeptByBands: ['band_cannot'],
});

/** Game seconds per real second of a battle (forced 2×): combat limits in data are real seconds (combatTimeLimit). */
export const COMBAT_TIME_SCALE = 2;

/** Strip the _a/_b suffix of an item id (the registry key of an item family). */
export const itemKey = (id) => (typeof id === 'string' ? id.replace(/_[ab]$/, '') : '');

export class GameData {
  /**
   * @param {Readonly<Record<string, any>>} data server/data.js getData() (may be partial)
   * @param {string} modeId e.g. 'mode_multi_hard'
   */
  constructor(data, modeId) {
    this.raw = data && typeof data === 'object' ? data : {};
    this.config = getConfig(this.raw) || {};
    this.modeId = modeId;
    this.mode = getMode(modeId, this.raw) || {};
    // 自研「回合编排」：热读（见 extraRounds getter）；_erFloor 由 Match 抬高以防热改重定义已打过的回合
    this._erFloor = 0;
    this._mixedTemplates = null;
    this.economy = this.config.economy && typeof this.config.economy === 'object' ? this.config.economy : {};
    const chess = this.raw.chess && typeof this.raw.chess === 'object' ? this.raw.chess : {};
    this._chess = chess;
    this._items = this.raw.items && typeof this.raw.items === 'object' ? this.raw.items : {};
    this._bonds = this.raw.bonds && typeof this.raw.bonds === 'object' ? this.raw.bonds : {};
    /** visible, shop-eligible base (normal) chess ids */
    this.visibleChess = Object.keys(chess).filter((id) => {
      const c = chess[id];
      return c && c.visible && !c.isGolden && !c.isDiy && !c.isHidden && Number.isInteger(c.tier);
    }).sort();
    /**
     * Shop item ids by tier (sim/simdata.js isShopItem: normal EQUIP, not hidden, not effect-only — the special
     * 维式重锤 and 突变细胞 are never sold). Every "shop item" draw uses it: the shop item slot (pool.js), the 道具补给 /
     * 机密商店 cards (choices.js) and the shop-eligible item pools (Match.rollItemId).
     */
    this.shopItemsByTier = {};
    for (const [id, it] of Object.entries(this._items)) {
      if (!isShopItem(it)) continue;
      (this.shopItemsByTier[it.tier] ||= []).push(id);
    }
    for (const k of Object.keys(this.shopItemsByTier)) this.shopItemsByTier[k].sort();
    this.bondIds = Object.keys(this._bonds).sort((a, b) => (numOr(this._bonds[a].identifier, 99) - numOr(this._bonds[b].identifier, 99)) || (a < b ? -1 : 1));
    this.modeInactiveBonds = new Set(Array.isArray(this.mode.inactiveBondIds) ? this.mode.inactiveBondIds : []);
    /** bandBondIds memo */
    this._bandBonds = new Map();
    this.inactiveEnemies = new Set(Array.isArray(this.mode.inactiveEnemyKeys) ? this.mode.inactiveEnemyKeys : []);
    /** data/tuning.json (titles only, see the header) */
    this.tuning = this.raw.tuning && typeof this.raw.tuning === 'object' ? this.raw.tuning : {};
  }

  /**
   * Leader HP pool multiplier — always 1 (no custom balance). Kept for callers written against the old tuning layer
   * (finalAssault.bossPoolHp); use `bossPoolHp` / `bossPoolShare` for the official pool.
   * @deprecated
   */
  bossHpMul(bossId) { // eslint-disable-line no-unused-vars
    return 1;
  }

  /**
   * Official shared leader HP pool (DESIGN §20.10): ONE pool for every boss field of the match (official tip "最终攻势中，
   * 所有人将一起对敌方领袖造成伤害"; the mirrored copies of a pair field share it — notice 5114 "两侧的敌方领袖共享生命值
   * （敌方领袖的总生命值不变）", which is about those copies, not about the number of players). Co-op = bloodPoint
   * [difficulty]; with config bossHpScale.aliveScaling (default false) × alive / aliveFull (4) — 巴哈姆特 12294 "聯機隊友
   * (撤退/死掉)變少，最後boss血條也會變少" is one community note without a proportion, kept off until confirmed (it would
   * shorten fights after eliminations, the opposite of the playtest report); `aliveCount` omitted ⇒ a full team. Solo = bloodPoint ×
   * bossHpScale.solo (0.25 = one player of four, [ASSUMED]). Leaders are never scaled by enemyScale ("领袖单位于服务器的
   * 生命值加成不受上述加成影响").
   * @param {string} bossId
   * @param {number} [aliveCount] alive players at the Final Assault / Hidden Core start (co-op)
   * @returns {number}
   */
  bossPoolHp(bossId, aliveCount, players = 0) {
    const boss = this.boss(bossId);
    const diff = this.difficulty;
    let base = boss && boss.bloodPoint && Number.isFinite(boss.bloodPoint[diff]) ? boss.bloodPoint[diff] : null;
    if (base == null && boss && boss.bloodPoint) base = Object.values(boss.bloodPoint).find((v) => Number.isFinite(v)) ?? null;
    if (base == null) base = 500000;
    return Math.max(1, Math.round(base * this.bossPoolShare(aliveCount) * bossPoolShareFor(players)));
  }

  /**
   * Multiplier of bloodPoint for the leader pool (see bossPoolHp): solo = bossHpScale.solo (0.25); co-op = coop (1) ×
   * min(alive, aliveFull) / aliveFull when bossHpScale.aliveScaling (mode entry first, then the global one).
   * @param {number} [aliveCount]
   */
  bossPoolShare(aliveCount) {
    const ms = this.mode.bossHpScale && typeof this.mode.bossHpScale === 'object' ? this.mode.bossHpScale : {};
    const cs = this.config.bossHpScale && typeof this.config.bossHpScale === 'object' ? this.config.bossHpScale : {};
    const pick = (k, d) => (Number.isFinite(ms[k]) && ms[k] > 0 ? ms[k] : Number.isFinite(cs[k]) && cs[k] > 0 ? cs[k] : d);
    if (this.isSolo) return pick('solo', 0.25);
    const scaling = typeof ms.aliveScaling === 'boolean' ? ms.aliveScaling : cs.aliveScaling === true;
    const full = Math.max(1, Math.floor(pick('aliveFull', 4)));
    const n = Number(aliveCount);
    const alive = scaling && Number.isFinite(n) && n >= 1 ? Math.min(full, Math.floor(n)) : full;
    return pick('coop', 1) * (alive / full);
  }

  /** config.titles with the tuning overrides (stat / rule per title id) merged in. */
  get titles() {
    const list = Array.isArray(this.config.titles) ? this.config.titles : [];
    const ov = this.tuning.titles && typeof this.tuning.titles === 'object' ? this.tuning.titles : {};
    return list.map((t) => {
      if (!t || typeof t.id !== 'string' || !Object.hasOwn(ov, t.id) || !ov[t.id] || typeof ov[t.id] !== 'object') return t;
      const o = ov[t.id];
      const out = { ...t };
      if (typeof o.stat === 'string') out.stat = o.stat;
      if (o.rule === 'max' || o.rule === 'min') out.rule = o.rule;
      return out;
    });
  }

  // ---- ids ------------------------------------------------------------------------------------------

  chess(id) { return own(this._chess, id); }
  item(id) { return own(this._items, id); }
  bond(id) { return own(this._bonds, id); }
  band(id) { return own(this.raw.bands, id); }
  garrison(id) { return own(this.raw.garrisons, id); }
  effect(id) { return own(this.raw.effects, id); }
  enemy(key) { return own(this.raw.enemies, key); }
  wave(id) { return own(this.raw.waves, id); }
  stage(id) { return own(this.raw.stages, id); }
  boss(id) { return own(this.raw.bosses, id); }
  token(id) { return own(this.raw.tokens, id); }
  get choices() { return this.raw.choices && typeof this.raw.choices === 'object' ? this.raw.choices : {}; }
  get factions() { return this.raw.factions && typeof this.raw.factions === 'object' ? this.raw.factions : {}; }

  /** Normal (base) chess id of a chess id (golden → base). */
  baseIdOf(id) {
    const c = this.chess(id);
    if (!c) return typeof id === 'string' ? id.replace(/_b$/, '_a') : null;
    return c.baseId || (c.isGolden ? id.replace(/_b$/, '_a') : id);
  }

  goldenIdOf(id) {
    const c = this.chess(this.baseIdOf(id));
    if (c && c.goldenId && this.chess(c.goldenId)) return c.goldenId;
    const alt = typeof id === 'string' ? id.replace(/_a$/, '_b') : null;
    return alt && this.chess(alt) ? alt : null;
  }

  isGolden(id) { const c = this.chess(id) || this.item(id); return !!(c && c.isGolden); }

  tierOf(id) {
    const c = this.chess(id) || this.item(id);
    return c && Number.isInteger(c.tier) ? c.tier : 1;
  }

  // ---- economy --------------------------------------------------------------------------------------

  income(round) {
    const arr = Array.isArray(this.economy.income) ? this.economy.income : DEFAULTS.income;
    const cap = numOr(this.economy.incomeCap, DEFAULTS.incomeCap);
    const v = arr[round];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    return Math.max(0, Math.min(cap, 3 + round));
  }

  chessPrice(id) {
    const c = this.chess(id);
    if (c && Number.isFinite(c.price) && c.price >= 0) return c.price;
    const tier = this.tierOf(id);
    const row = this.economy.chessPrice && this.economy.chessPrice[tier];
    const golden = c && c.isGolden;
    if (row && typeof row === 'object') return numOr(golden ? row.golden : row.normal, DEFAULTS.chessPrice[tier] ?? 3);
    return DEFAULTS.chessPrice[tier] ?? 3;
  }

  sellPrice(id) {
    const c = this.chess(id);
    if (c && Number.isFinite(c.sellPrice) && c.sellPrice >= 0) return c.sellPrice;
    const tier = this.tierOf(id);
    const row = this.economy.chessSell && this.economy.chessSell[tier];
    if (row && typeof row === 'object') return numOr(c && c.isGolden ? row.golden : row.normal, DEFAULTS.sellPrice);
    return DEFAULTS.sellPrice;
  }

  itemPrice(id) {
    const it = this.item(id);
    return it && Number.isFinite(it.price) && it.price >= 0 ? it.price : 2;
  }

  get refreshPrice() { return Math.max(0, numOr(this.economy.refreshPrice, DEFAULTS.refreshPrice)); }
  get benchSize() { return posIntOr(this.economy.benchSize, DEFAULTS.benchSize); }
  get tempSize() { return posIntOr(this.economy.tempSize, DEFAULTS.tempSize); }
  get deployCap() { return posIntOr(this.economy.deployCap, DEFAULTS.deployCap); }
  get equipPerChess() { return posIntOr(this.economy.equipPerChess, DEFAULTS.equipPerChess); }
  get maxArtsPerRound() { return posIntOr(this.economy.maxArtsPerRound, DEFAULTS.maxArtsPerRound); }
  get goldenCopies() { return posIntOr(this.economy.goldenCopies, DEFAULTS.goldenCopies); }
  get itemMergeCount() { return posIntOr(this.economy.itemMergeCount, DEFAULTS.itemMergeCount); }
  get leftoverKeptBands() { return Array.isArray(this.economy.leftoverFundsKeptByBands) ? this.economy.leftoverFundsKeptByBands : DEFAULTS.leftoverFundsKeptByBands; }
  get defaultBandId() { return typeof this.economy.defaultBandId === 'string' ? this.economy.defaultBandId : DEFAULTS.defaultBandId; }
  get defaultStartLp() { return posIntOr(this.economy.defaultStartLp, DEFAULTS.defaultStartLp); }

  rewardOffer() {
    const r = this.economy.rewardOffer && typeof this.economy.rewardOffer === 'object' ? this.economy.rewardOffer : {};
    return {
      count: posIntOr(r.count, DEFAULTS.rewardOffer.count),
      tierOffset: Number.isInteger(r.tierOffset) ? r.tierOffset : DEFAULTS.rewardOffer.tierOffset,
      maxTier: posIntOr(r.maxTier, DEFAULTS.rewardOffer.maxTier),
      price: Math.max(0, numOr(r.price, 0)),
    };
  }

  /**
   * Copies of a base chess in the shared pool. `players` (>4 only, server/match/scaling.js poolCopyMulFor) scales the
   * per-tier value for a bigger room; per-chess overrides are content rules and are never scaled.
   * @param {string} baseId
   * @param {number} [players] seated players (≤4 ⇒ the original value)
   */
  poolCopies(baseId, players = 0) {
    const ov = this.economy.poolCopiesOverrides;
    if (ov && typeof ov === 'object' && Number.isInteger(ov[baseId]) && ov[baseId] >= 0) return ov[baseId];
    const tier = this.tierOf(baseId);
    const pc = this.economy.poolCopies;
    const v = pc && typeof pc === 'object' ? pc[tier] : undefined;
    const base = Number.isInteger(v) && v >= 0 ? v : (DEFAULTS.poolCopies[tier] ?? 10);
    return Math.round(base * poolCopyMulFor(players));
  }

  /** Copies needed to merge (0 = never merges: golden chess). */
  mergeCount(id) {
    const c = this.chess(id);
    if (!c || c.isGolden) return 0;
    if (Number.isInteger(c.upgradeNum) && c.upgradeNum > 0) return c.upgradeNum;
    const ov = this.economy.mergeCountOverrides;
    if (ov && Number.isInteger(ov[id])) return ov[id];
    return posIntOr(this.economy.mergeCount, DEFAULTS.mergeCount);
  }

  // ---- mode -----------------------------------------------------------------------------------------

  /**
   * 自研「回合编排」（custom-rules.json extraRounds）：延后 BOSS 给玩家更多发育回合。
   * **热读**（getter，每次从 customRules 取 + mtime 缓存）——用户 2026-10-08 要求「改 BOSS 轮时间后自动重算难度
   * 以实现热改」。但**回合结构不能在局中回退**：Match 侧用 `_erFloor` 记录「本局已用过的最大 insertAfter+count」，
   * 只接受不小于它的新结构（见 Match._erSync），避免玩家已打过的回合被重新定义。
   * 语义：insertAfter 之后的 `count` 个回合为插入的发育回合，复用 `templateRound` 的波次，难度按 `curve` 策略；
   * 原 bossRound / hiddenRound / lastRound 全部顺延 `count`。
   */
  get extraRounds() {
    if (this._erCacheStamp === undefined) this._erCacheStamp = -1;
    // customRules 自带 mtime 缓存，这里只做一层「同一 tick 内复用」避免热路径反复解析
    let er = null;
    try { er = getCustomRules({}).extraRounds || null; } catch { er = null; }
    return er;
  }

  /** 本局回合结构的下界（Match 在推进回合时抬高它，防止热改把已打过的回合重新定义）。 */
  get extraRoundsFloor() { return this._erFloor || 0; }
  raiseExtraRoundsFloor(n) { if (Number.isFinite(n) && n > (this._erFloor || 0)) this._erFloor = n; }
  /** BOSS 触发时锁定回合号（防止后续回合把 bossRound 算成自己）。 */
  lockBossRound(r) { if (Number.isFinite(r) && this._erBossAt == null) this._erBossAt = r; }

  /** 该回合是否为插入的发育回合（复用模板回合的波次与难度）。 */
  isInsertedRound(r) {
    const er = this.extraRounds;
    return !!er && r > er.insertAfter && r <= er.insertAfter + er.count;
  }

  /** 插入回合 → 其模板回合号（非插入回合返回自身）。 */
  templateRoundFor(r) {
    const er = this.extraRounds;
    return er && this.isInsertedRound(r) ? er.templateRound : r;
  }

  get isSolo() { return this.mode.type === 'SINGLE' || /^mode_single_/.test(this.modeId || ''); }
  get difficulty() { return this.mode.difficulty || (this.modeId ? String(this.modeId).split('_').pop().toUpperCase() : 'NORMAL'); }
  get lastRound() { return this.bossRound; }
  /**
   * 主 BOSS 回合（热读 + 两道保护，用户 2026-10-08 要求「改 BOSS 轮时间后自动重算难度」）：
   *   ① `_erFloor` = 本局已开始的回合：BOSS 不能落在过去（`computed > floor ? computed : floor + 1`）——
   *      改小到已过去的回合时，顺延到**下一个回合**立即触发，对局仍能正常结束。
   *   ② `_erBossAt` = BOSS 实际触发的回合：一旦触发就**锁定**，避免后续回合把 bossRound 算成自己
   *      （否则 r === bossRound 会在每回合成立）。
   */
  get bossRound() {
    if (this._erBossAt != null) return this._erBossAt;               // ② 已触发 → 锁定
    const er = this.extraRounds;
    const base = Number.isInteger(this.mode.bossRound) && this.mode.bossRound > 0 ? this.mode.bossRound : 14;
    const computed = base + (er ? er.count : 0);
    const floor = this._erFloor || 0;
    // ① 不落在**已经过去**的回合（floor 是当前正在进行的回合，它本身还可以成为 BOSS）。
    //    即 computed >= floor 就用 computed；只有 computed < floor（落在过去）才顺延到 floor。
    return computed >= floor ? computed : floor;
  }
  /** 隐藏 BOSS = 主 BOSS + 官方两者的差值（保持「紧跟主 BOSS」的相对关系）。 */
  get hiddenRound() {
    const base = Number.isInteger(this.mode.hiddenRound) && this.mode.hiddenRound > 0 ? this.mode.hiddenRound : null;
    if (base == null) return null;
    const baseBoss = Number.isInteger(this.mode.bossRound) && this.mode.bossRound > 0 ? this.mode.bossRound : 14;
    return this.bossRound + (base - baseBoss);
  }
  get maxShopLevel() { return posIntOr(this.mode.maxShopLevel, DEFAULTS.maxShopLevel); }

  roundCfg(r) {
    const rounds = this.mode.rounds;
    const er = this.extraRounds;
    // 插入的发育回合：复用模板回合（默认 13）的**时长/时长上限**，但
    //   ① 清掉 bossTemplates/isBoss（它们不是 BOSS 回合）；
    //   ② 波次模板从 poolTemplates 里**随机挑一个**（怪组多样性；强度不变，靠 enemyScale 控制难度）。
    if (er && this.isInsertedRound(r)) {
      const tpl = rounds && typeof rounds === 'object' && rounds[String(er.templateRound)] && typeof rounds[String(er.templateRound)] === 'object' ? rounds[String(er.templateRound)] : null;
      if (tpl) {
        const mixed = this._mixTemplateFor(r, tpl);
        return { ...tpl, template: mixed, isBoss: false, isHidden: false, bossTemplates: null, bossOvertimeAfter: null };
      }
    }
    return rounds && typeof rounds === 'object' && rounds[String(r)] && typeof rounds[String(r)] === 'object' ? rounds[String(r)] : null;
  }

  /**
   * 插入回合的波次模板：从 `poolTemplates` 里随机挑（同一回合多次调用返回同一个，保证「本回合内一致」）。
   * 池空 / 未开 mixPerRound → 用模板回合自己的模板。
   */
  _mixTemplateFor(r, tpl) {
    const er = this.extraRounds;
    const fallback = tpl && typeof tpl.template === 'string' ? tpl.template : null;
    if (!er || !er.mixPerRound || !er.poolTemplates.length) return fallback;
    if (!this._mixedTemplates) this._mixedTemplates = new Map();
    if (this._mixedTemplates.has(r)) return this._mixedTemplates.get(r);
    // 用 rngMeta 之外的一次性随机：模板选择只需「每回合固定一次」，不必可复现到战斗序列
    const pool = er.poolTemplates.filter((id) => !!this.wave(id));
    const pick = pool.length ? pool[Math.floor(Math.random() * pool.length)] : fallback;
    this._mixedTemplates.set(r, pick);
    return pick;
  }

  spRounds() { return Array.isArray(this.mode.spRounds) ? this.mode.spRounds.filter((n) => Number.isInteger(n)) : []; }

  upgradePrices() {
    const arr = Array.isArray(this.mode.upgradePrices) ? this.mode.upgradePrices : DEFAULTS.upgradePrices;
    return arr.map((v) => Math.max(0, numOr(v, 99)));
  }

  /** Base price to go from `level` to level+1 (null at max). */
  upgradeBase(level) {
    if (level >= this.maxShopLevel) return null;
    const arr = this.upgradePrices();
    return arr[level - 1] ?? 99;
  }

  shopSlots(level) {
    const s = this.mode.shopSlots && this.mode.shopSlots[String(level)];
    const d = DEFAULTS.shopSlots[level] || DEFAULTS.shopSlots[6];
    if (!s || typeof s !== 'object') return { ...d };
    const chess = Number.isInteger(s.chess) && s.chess >= 0 ? s.chess : d.chess;
    const item = Number.isInteger(s.item) && s.item >= 0 ? s.item : d.item;
    return { chess: Math.min(chess, 8), item: Math.min(item, 4) };
  }

  /** Real-second prep timer for round r (null = untimed). */
  prepTime(r) {
    const rc = this.roundCfg(r);
    if (!rc) return this.isSolo ? null : 90;
    const v = rc.prepTime;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  }

  /** The round level's `maxPlayTime` (config rounds[r].combatTimeLimit) as data gives it — REAL seconds. */
  combatTimeLimitReal(r) {
    const rc = this.roundCfg(r);
    const v = rc ? rc.combatTimeLimit : undefined;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    const m = this.mode.combatTimeLimit && this.mode.combatTimeLimit[String(r)];
    return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : 60;
  }

  /**
   * Combat time limit of round r in GAME seconds (what the Battle and 联防 use): maxPlayTime × the forced battle speed
   * (config.combatTimeScale, default COMBAT_TIME_SCALE 2). `maxPlayTime` counts real seconds of the 2× battle: read
   * as game seconds, the rounds' own spawn schedules would not fit (R2 spawns its last flyer at 43 s of a 45 s limit,
   * R3 at 62 s of 55 s — enemies that can never be killed, or never spawn), while × 2 every limit is ≈ the last spawn +
   * one flyer crossing (R2 43 + 44 ≈ 90, R3 62 + 44 ≈ 110, R5 38 + 67 ≈ 110). docs/BALANCE.md §2.1.
   */
  combatTimeLimit(r) {
    return this.combatTimeLimitReal(r) * this.combatTimeScale;
  }

  /** Game seconds per real second of a battle (config.combatTimeScale, default COMBAT_TIME_SCALE 2). */
  get combatTimeScale() {
    const k = numOr(this.config.combatTimeScale, COMBAT_TIME_SCALE);
    return k > 0 ? k : COMBAT_TIME_SCALE;
  }

  /**
   * The boss round level's `maxPlayTime` (config rounds[r].levelMaxPlayTime, 120) in REAL seconds — the countdown of
   * the Final Assault / Hidden Core. It is not a hard stop there ("计时结束后战斗仍然会继续", research 01 §10); null
   * when the data has none.
   */
  bossLevelTime(r) {
    const rc = this.roundCfg(r);
    const v = rc ? rc.levelMaxPlayTime : undefined;
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  }

  /** Official enemy multipliers of round r (config enemyScale: the PRTS table + 终极 speed ×1.15 from R3). */
  baseEnemyScale(r) {
    const e = this.mode.enemyScale && this.mode.enemyScale[String(r)];
    if (!e || typeof e !== 'object') return { hpMul: 1, atkMul: 1, speedMul: 1 };
    return {
      hpMul: Math.max(0.01, numOr(e.hp, 1)),
      atkMul: Math.max(0, numOr(e.atk, 1)),
      speedMul: Math.max(0.01, numOr(e.speed, 1)),
    };
  }

  /**
   * Enemy multipliers of round r = the official table (baseEnemyScale; no custom multiplier).
   * 自研「回合编排」插入的发育回合按 `curve` 策略取难度（用户 2026-10-08 定稿：**stretch = 整条曲线重排**）：
   *   stretch：把官方的 k 值曲线**等比拉伸**到新的最后普通回合，端点不变——插入回合取重排后的 k，
   *            故第 13 回合的 k 会比原来小（前期整体变缓），曲线在更长回合数内走完同样的 0→K。
   *   append ：插入回合接着模板回合的 k 递增（k+1, k+2…，每回合 ×1.2）。
   *   smooth ：插入回合共同完成「一级」的成长（总量 ×1.2，平摊到各回合）。
   *   flat   ：完全沿用模板回合难度（不涨）。
   * 官方公式（已验证）：hp = 0.8 × 1.2^k，atk = 0.8 × 1.1^k（k = enemyScale 表里的 kHp/kAtk）。
   * 递推常数与基准值全部可外置（extraRounds.curveBase / curveRate / curveRateAtk）。
   */
  enemyScale(r) {
    const er = this.extraRounds;
    if (!er) return this.baseEnemyScale(r);
    const K = this._kOfRound(er.insertAfter);        // 官方终点 k（第 insertAfter 回合，如 13 → 7）
    if (K == null) return this.baseEnemyScale(r);
    const at = (k, speedMul) => ({
      hpMul: Math.max(0.01, er.curveBase * Math.pow(er.curveRate, k)),
      atkMul: Math.max(0, er.curveBaseAtk * Math.pow(er.curveRateAtk, k)),
      speedMul,
    });
    const officialSpeed = this.baseEnemyScale(r).speedMul;
    // stretch（线性重排，用户 2026-10-08 定稿）：官方 k 从 0 到 K 的那条直线，摊到**新的最后普通回合**
    // （insertAfter + count）。端点不变（第 17 回合 = 官方第 13 回合的 k=7）→ 后期明显变缓，但**前中期会比官方略陡**
    // （官方前期是平台式缓涨，拉直后反而抬高）。
    if (er.curve === 'stretch') {
      const newLast = er.insertAfter + er.count;
      const k = Math.min(K, (K / newLast) * r);
      return at(k, officialSpeed);
    }
    // stretchShape（形状保持的横向拉伸）：把官方的 k 曲线整体横向拉长到新的回合数——第 r 回合取官方
    // 第 r×(insertAfter/newLast) 回合的 k（线性插值）。**全程 ≤ 官方**（最柔和的「拉伸」读法）。
    if (er.curve === 'stretchShape') {
      const k = this._kStretched(r);
      return k == null ? this.baseEnemyScale(r) : at(k, officialSpeed);
    }
    // 以下三种只作用于插入回合，非插入回合保持官方原值
    if (!this.isInsertedRound(r)) return this.baseEnemyScale(r);
    const tpl = this.baseEnemyScale(er.templateRound);
    const kTpl = this._kOfRound(er.templateRound) ?? K;
    let k = kTpl;
    if (er.curve === 'append') k = kTpl + (r - er.templateRound);                 // 接着涨：k+1, k+2…
    else if (er.curve === 'smooth') k = kTpl + (r - er.templateRound) / er.count; // 平摊一级：总量 ×1.2
    return at(k, tpl.speedMul);                                                   // flat：k = kTpl（不涨）
  }

  /** stretchShape 用：第 r 回合取官方「横向拉长后」对应的 k（线性插值）。 */
  _kStretched(r) {
    const er = this.extraRounds;
    const newLast = er.insertAfter + er.count;
    const x = (r * er.insertAfter) / newLast;
    const lo = Math.floor(x), hi = Math.ceil(x);
    const kLo = this._kOfRound(lo), kHi = this._kOfRound(hi);
    if (kLo == null && kHi == null) return null;
    if (kLo == null) return kHi;
    if (kHi == null || lo === hi) return kLo;
    return kLo + (kHi - kLo) * (x - lo);
  }

  /** 某回合在官方 enemyScale 表里的等级序号 k（kHp）。表里没有 → null。 */
  _kOfRound(r) {
    const es = this.mode && this.mode.enemyScale;
    const e = es && typeof es === 'object' ? es[String(r)] : null;
    if (!e || typeof e !== 'object') return null;
    const k = Number(e.kHp);
    return Number.isFinite(k) ? k : null;
  }

  timer(key) {
    const t = this.config.timers && this.config.timers[key];
    return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : DEFAULTS.timers[key] ?? 10;
  }

  get lpCapPerRound() { return posIntOr(this.config.lpCapPerRound, DEFAULTS.lpCapPerRound); }
  /**
   * Boss overtime (`bossTurnHpReduceTime` 150 / 1 LP per second): a server turn timer of turnInfoDataDict like
   * prepPhaseTime, so REAL seconds on the same clock as the boss level's 120 s maxPlayTime (combat limits are real
   * seconds, docs/BALANCE.md §2.1) — the level countdown runs out first, the battle continues, and the merged team LP
   * drains 1 per real second from the 150 s mark (research 01 §10, 06 §11.7). Read as game seconds the drain would
   * start at 75 real s (45 s before the countdown ends) at 2 LP per real second.
   */
  get bossOvertimeAfterReal() { return Math.max(0, numOr(this.config.bossOvertimeAfter, DEFAULTS.bossOvertimeAfter)); }
  /** Team LP drained per REAL second of overtime. */
  get bossOvertimeDrainReal() { return Math.max(0, numOr(this.config.bossOvertimeDrainPerSec, DEFAULTS.bossOvertimeDrainPerSec)); }
  /** Overtime start in GAME seconds of a boss field clock (150 real s × the forced 2× = 300). */
  get bossOvertimeAfter() { return this.bossOvertimeAfterReal * this.combatTimeScale; }
  /** Team LP drained per GAME second of overtime (1 per real second = 0.5 per game second). */
  get bossOvertimeDrain() { return this.bossOvertimeDrainReal / this.combatTimeScale; }
  /**
   * Team LP the overtime drain has taken when a boss field clock reads `gt` game seconds: bossOvertimeDrainReal per
   * whole REAL second past bossOvertimeAfterReal (the first point at 151 real s).
   */
  bossOvertimeDue(gt) {
    const over = (Number(gt) || 0) / this.combatTimeScale - this.bossOvertimeAfterReal;
    return over >= 1 ? Math.floor(over) * this.bossOvertimeDrainReal : 0;
  }
  get dp() {
    const d = this.config.dp && typeof this.config.dp === 'object' ? this.config.dp : {};
    return { dpInit: numOr(d.init, 10), dpPerSec: numOr(d.perSec, 1), dpMax: numOr(d.max, 99) };
  }
  get unite() {
    const u = this.config.unite && typeof this.config.unite === 'object' ? this.config.unite : {};
    return {
      maxHelpers: posIntOr(u.maxHelpers, DEFAULTS.unite.maxHelpers),
      templates: u.templates && typeof u.templates === 'object' ? u.templates : DEFAULTS.unite.templates,
    };
  }
  get hiddenCore() {
    const h = this.config.hiddenCore && typeof this.config.hiddenCore === 'object' ? this.config.hiddenCore : {};
    return {
      single: numOr(h.single, DEFAULTS.hiddenCore.single),
      multi: numOr(h.multi, DEFAULTS.hiddenCore.multi),
      minTeamLpExclusive: numOr(h.minTeamLpExclusive, DEFAULTS.hiddenCore.minTeamLpExclusive),
      difficulties: Array.isArray(h.difficulties) ? h.difficulties : DEFAULTS.hiddenCore.difficulties,
    };
  }
  bans(difficulty, players = 0) {
    const six = coopBansFor(players);
    if (six) return six;
    const b = this.config.bans && this.config.bans[difficulty];
    const d = DEFAULTS.bans[difficulty] || { core: 0, addon: 0 };
    if (!b || typeof b !== 'object') return { ...d };
    return { core: Number.isInteger(b.core) && b.core >= 0 ? b.core : d.core, addon: Number.isInteger(b.addon) && b.addon >= 0 ? b.addon : d.addon };
  }
  get bandDraft() {
    const b = this.config.bandDraft && typeof this.config.bandDraft === 'object' ? this.config.bandDraft : {};
    return {
      skipsPerPlayer: Number.isInteger(b.skipsPerPlayer) && b.skipsPerPlayer >= 0 ? b.skipsPerPlayer : DEFAULTS.bandDraft.skipsPerPlayer,
      timeoutBandId: typeof b.timeoutBandId === 'string' && this.band(b.timeoutBandId) ? b.timeoutBandId : this.defaultBandId,
    };
  }

  /** Bosses weights for the boss round / hidden round. */
  bossWeights(hidden = false) {
    const w = hidden ? this.mode.hiddenBossWeights : this.mode.bossWeights;
    return w && typeof w === 'object' ? Object.entries(w).filter(([id, v]) => this.boss(id) && Number(v) > 0) : [];
  }

  /** Band usable in this mode type. */
  bandAllowed(bandId) {
    const b = this.band(bandId);
    if (!b) return false;
    const list = Array.isArray(b.modeTypeList) ? b.modeTypeList : null;
    if (!list) return true;
    return list.includes(this.isSolo ? 'SINGLE' : 'MULTI');
  }

  bandIds() {
    const bands = this.raw.bands && typeof this.raw.bands === 'object' ? this.raw.bands : {};
    return Object.keys(bands).filter((id) => this.bandAllowed(id)).sort((a, b) => numOr(bands[a].sortId, 99) - numOr(bands[b].sortId, 99) || (a < b ? -1 : 1));
  }

  startLp(bandId) {
    const b = this.band(bandId);
    return b && Number.isInteger(b.totalHp) && b.totalHp > 0 ? b.totalHp : this.defaultStartLp;
  }

  /**
   * The bonds a strategy's mechanic is built around (DESIGN §21.26): bands.json `bondIds`, written at build time by
   * shared/bandBonds.js from the band's own text and blackboards (潘格尼尼 → 拉特兰, 克莱门莎 → 阿戈尔, 玛恩纳 → 卡西米尔 …) —
   * the field the strategy draft's 本局禁用 mark reads too. Known bond ids in data order; [] for an unknown band, one tied to
   * no bond (华法琳, 阿米娅 …) or data without the field. The bot never picks a strategy tied to a bond the mode switches
   * off (bot.js botPickBand).
   * @param {string} bandId
   * @returns {string[]}
   */
  bandBondIds(bandId) {
    if (this._bandBonds.has(bandId)) return this._bandBonds.get(bandId);
    const listed = this.band(bandId)?.bondIds;
    const set = new Set(Array.isArray(listed) ? listed : []);
    const out = Object.freeze(this.bondIds.filter((id) => set.has(id)));
    this._bandBonds.set(bandId, out);
    return out;
  }

  /**
   * Placeable (hand) tokens a chess sends to the hand when placed on the board: [{ tokenId, count }] — its manually
   * deployable summons (tokens.json `placeable`: 医疗探机, 诅咒娃娃, 海嗣, 狼群, 流形, 爬行号·防护单元; user playtest #6)
   * that the chess makes under `loadout` ({ skillIndex } from shared/protocol.js resolveLoadout; absent ⇒ its default
   * skill): the owner variant's `sources` (`bySkill[skillIndex]` for a non-default skill) name a talent or a skill —
   * 赫默 / 巫恋 on S1 make no drone / doll. `count` = the summon's deploy limit (PRTS 卫戍协议/帮助 "根据召唤物部署数量
   * 上限（非初始持有量），发送等量召唤物至手牌区": 凯瑟琳 2 of her 3 devices).
   */
  placeableTokens(chessId, loadout = null) {
    const c = this.chess(chessId);
    if (!c || !Array.isArray(c.tokens)) return [];
    const out = [];
    for (const tid of c.tokens) {
      const t = this.token(tid);
      if (!t || t.kind !== 'summon' || t.placeable !== true) continue;
      const vs = t.variants && typeof t.variants === 'object' ? t.variants : {};
      const v = vs[chessId] ?? vs[String(chessId).replace(/_b$/, '_a')] ?? null;
      if (v) {
        const alt = loadout && Number.isInteger(loadout.skillIndex) && v.bySkill ? v.bySkill[loadout.skillIndex] : null;
        const src = Array.isArray(alt?.sources) ? alt.sources : Array.isArray(v.sources) ? v.sources : [];
        if (!src.includes('talent') && !src.includes('skill')) continue;
      }
      const count = posIntOr(v?.stats?.deployLimit, posIntOr(t.deployLimit, 1));
      out.push({ tokenId: tid, count: Math.min(count, 9) });
    }
    return out;
  }
}
