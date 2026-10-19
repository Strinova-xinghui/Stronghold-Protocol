// server/match/match/custom.js — 自研功能方法模块（第 18 个 part，2026-10-13 上游 0.2.5 同步时从旧单体重建）。
// 上游 0.2.5 把 Match 拆成 server/match/match/* 子模块；本文件承载我们的全部纯自研方法，
// Match.js 在 parts 数组末尾挂载本模块（同名方法两次定义会 throw，故自研方法不与上游重名）。
// 修改上游方法行为的钩子（sendTo 镜像、settle 负债清算等）直改对应上游子模块并以「自研」注释标记。
// 涵盖：monitor 监看 / 负债规则 prepDebt / 对局节奏 pacing / 回合抽奖 roundLottery /
//       休整期等待投票 prepWait（协议见 shared/protocol.js）。

import { PHASE, ERR } from '../../../shared/constants.js';
import { OK, fail } from './common.js';
import { getCustomRules } from '../customRules.js';
import { t } from '../../../shared/i18n.js';

export class MatchCustom {
  // ---- monitor 监看者（自研，2026-10-06） --------------------------------------------

  /**
   * 注册/切换一个 monitor 监看者：watcherId 将收到 targetPlayerId 的完整 m.private 数据流。
   * 不占观战席位、不入 seats/spectators、不计入任何统计，对被看者零影响。
   * @param {string} watcherId 监看者 id（由 /monitor 侧生成，带前缀区分）
   * @param {string} targetPlayerId 被监看的玩家 id
   * @returns {boolean} 目标是否有效
   */
  addMonitorWatcher(watcherId, targetPlayerId) {
    if (this.disposed || this.ended) { this.log?.warn?.(`[monitor] rejected: disposed=${this.disposed} ended=${this.ended}`); return false; }
    const ps = this.players.get(targetPlayerId);
    if (!ps) { this.log?.warn?.(`[monitor] no such player ${targetPlayerId}; have=${[...this.players.keys()].join(',')}`); return false; }
    this.monitorWatchers.set(watcherId, targetPlayerId);
    // 立即补发一份当前状态（不必等下一次 dirty）：private + public + 战场帧，等价于被看者的完整接收状态。
    try {
      const view = ps.privateView();
      const sent = this.sendTo(watcherId, { ...view, playerId: ps.playerId, _monitor: true });
      this.sendTo(watcherId, this.publicView());
      // 战场帧：影子监看者需要与被看者相同的战场（含 b.start 规格）才能渲染战斗画面。
      // 固定战场（用户反馈 2026-10-07）：优先取被看者**自己的**战场——被看者正在前往查看队友时
      // this.watchers 里记的是别人的 field，影子不该从别人的战场开局（被淘汰者无自己的战场才退回 watch 的）。
      if (this.clientCombat) {
        const own = this.fields.find((x) => x.players.includes(ps.playerId));
        const fid = (own || {}).fieldId || this.watchers.get(ps.playerId);
        const f = fid ? this.fields.find((x) => x.fieldId === fid) : null;
        if (f) this.sendTo(watcherId, this._startMsg(f, ps.playerId, { watch: true }));
      }
      this.log?.info?.(`[monitor] ${watcherId} shadowing ${targetPlayerId}, initial send=${sent}`);
    } catch (e) { this.reportError('monitorWatcher resend', e); }
    return true;
  }

  /** 监看者离开（断开/换目标/对局结束）。 */
  removeMonitorWatcher(watcherId) {
    return this.monitorWatchers.delete(watcherId);
  }

  /** 影子监看者 id 列表（自研）。 */
  _monitorIds() {
    return this.monitorWatchers && this.monitorWatchers.size ? [...this.monitorWatchers.keys()] : [];
  }

  /**
   * Whether a frame about to be mirrored to a shadow watcher is an excursion of the被看者 into ANOTHER player's
   * field (固定战场, user feedback 2026-10-07): the被看者 taps 前往查看 (g.watch) and the server sends them the
   * scouted board (m.field `n:<pid>`) or the watched battle (b.start + its b.ev / b.snap ticks) — frames of a field
   * the被看者 is not a player of. The shadow stays pinned on the被看者's own battlefield, so those are not mirrored.
   * A field in `this.fields` decides by its players list (the被看者's own battle / boss field mirrors as usual); with
   * no fields yet (休整期) every m.field is a scouted prep board — `n:<targetId>` itself never goes to the被看者
   * (their own board is the m.private), so anything else is an excursion. An eliminated被看者 has no own field —
   * the auto-observed field IS their whole view, so nothing is skipped.
   * @param {{ t?: string, fieldId?: string, spec?: { fieldId?: string } }} msg the frame on its way to the shadow
   * @param {string} targetId被看者
   * @returns {boolean} true = skip this frame for this watcher
   */
  _monitorPinnedSkip(msg, targetId) {
    const t = msg && typeof msg.t === 'string' ? msg.t : null;
    if (t !== 'm.field' && t !== 'b.start' && t !== 'b.ev' && t !== 'b.snap') return false;
    const ps = this.players.get(targetId);
    if (!ps || !ps.alive) return false;
    const fid = typeof msg.fieldId === 'string' && msg.fieldId ? msg.fieldId
      : (msg.spec && typeof msg.spec.fieldId === 'string' && msg.spec.fieldId ? msg.spec.fieldId : null);
    if (typeof fid !== 'string' || !fid) return false;
    const fields = Array.isArray(this.fields) ? this.fields : [];
    if (fields.length) {
      const f = fields.find((x) => x && x.fieldId === fid);
      return !f || !Array.isArray(f.players) || !f.players.includes(targetId);
    }
    return fid !== `n:${targetId}`;
  }

  /** 该玩家（含 AI 座位）是否正被任何监看者看着（自研）。 */
  _isWatched(playerId) {
    if (!this.monitorWatchers || !this.monitorWatchers.size) return false;
    for (const t of this.monitorWatchers.values()) if (t === playerId) return true;
    return false;
  }

  /** 当前监看某玩家的监看者数量（诊断用）。 */
  monitorWatcherCount(targetPlayerId = null) {
    if (!this.monitorWatchers || !this.monitorWatchers.size) return 0;
    if (targetPlayerId == null) return this.monitorWatchers.size;
    let n = 0;
    for (const t of this.monitorWatchers.values()) if (t === targetPlayerId) n++;
    return n;
  }

  // ---- 休整期负债规则（自研 2026-10-07） ----------------------------------------------

  /**
   * 当前生效的负债规则（custom-rules.json prepDebt，mtime 热更）。未开启 ⇒ null（原版：lp ≤ 0 立即淘汰）。
   */
  get _debtRule() {
    try { return getCustomRules({ log: this.log }).prepDebt || null; } catch { return null; }
  }

  /**
   * 对局节奏（custom-rules.json pacing，热读）：bandDraftMul（策略轮选加时）/ prepMul（休整期加时）实时生效；
   * combatSpeed（对局速度）只在构造时读一次（见构造器——战斗中变速会让时间轴错位）。
   */
  get _pacing() {
    try { return getCustomRules({ log: this.log }).pacing || null; } catch { return null; }
  }

  /**
   * 敌人波次强度倍率（自研负债惩罚 v3，作用于普通/联防波次的敌人 HP，**不作用于领袖/Boss**）：
   * 只有**真正负血（lp < 0）**才算负债（用户 v3 定稿：没人负血就不加）：
   *   负债 debt = Σ max(0, −lp)；存款 savings = Σ max(0, lp − Ā)（歌利亚满血 45 → +19 存款）。
   * 净负债 net = debt − savings：> 0 ⇒ 敌人 HP ×(1 + k·net/Ā)（惩罚负债），封顶 cap；
   * < 0 ⇒ ×(1 + k2·net/Ā)（高血存款减弱敌人，floor）；= 0 ⇒ ×1。
   * 等待投票/准备状态与倍率无关——纯看血量（用户需求：等待与准备完全独立）。
   * @returns {number} 增强或减弱乘数（原版规则恒 1）
   */
  _debtEnemyMul() {
    const rule = this._debtRule;
    if (!rule || !(this._debtAvgHp > 0)) return 1;
    const alive = this.alivePlayers();
    if (!alive.length) return 1;
    let debt = 0, savings = 0;
    for (const p of alive) {
      if (p.lp < 0) debt += -p.lp;
      else if (p.lp > this._debtAvgHp) savings += p.lp - this._debtAvgHp;
    }
    const net = debt - savings;
    let mul = 1;
    if (net > 0) mul = 1 + rule.k * net / this._debtAvgHp;
    else if (net < 0) mul = 1 + rule.k2 * net / this._debtAvgHp;
    return Math.min(rule.cap, Math.max(rule.floor, mul));
  }

  // ---- 回合抽奖（roundLottery，自研 2026-10-08） --------------------------------------

  /**
   * 回合抽奖：本回合在配置表里时，给每个活人玩家推 `rolls` 轮独立装备抽奖（各 `choices` 选 1）。
   * 装备池 = `minTier`~`maxTier` 阶的全部可出装备（默认 maxTier=6 全阶，抽奖是奖励不该被个人商店等级卡住）。
   * 复用凯瑟琳「定向投放」的 pick-one 面板（pushItemOffer），多轮靠 offers 队列排队——**零改动** pickReward 与客户端。
   * `includeBots`（配置项，默认 false）：**默认不给 AI 发**（用户 2026-10-08 定：AI 不需要，省得替它做选择逻辑）。
   * 未领取的 offer 由 `PlayerState.endPrep()` 清空，不会卡住队列。
   * @param {any[]} alive 本回合活人玩家
   */
  _grantRoundLottery(alive) {
    const rl = this._lotteryRule;
    if (!rl) return;
    const entry = rl.rounds.find((r) => r.round === this.round);
    if (!entry) return;
    for (const ps of alive) {
      if (!rl.includeBots && ps.isBot) continue;   // 默认跳过 AI
      for (let i = 0; i < rl.rolls; i++) {
        const ids = this._rollLotteryItems(rl.choices, entry.minTier, ps, entry.maxTier);
        if (ids.length) ps.pushItemOffer(ids, { source: 'lottery', label: rl.label });
      }
    }
  }

  /** 当前生效的回合抽奖规则（custom-rules.json roundLottery，mtime 热更）。 */
  get _lotteryRule() {
    try { return getCustomRules({ log: this.log }).roundLottery || null; } catch { return null; }
  }

  /**
   * 抽 `choices` 件不重复的装备：池 = `minTier` 到 `maxTier` 阶的全部可出装备（shopItemsByTier）。
   * 注意 `maxTier` **默认 6（全部阶）而非玩家商店等级**——抽奖是奖励，不该被「玩家还没升级商店」卡住；
   * 想按个人等级限制就在配置里给该回合设 maxTier。
   * @param {number} choices 抽几件（面板槽数）
   * @param {number} minTier 最低阶（含）
   * @param {any} ps 目标玩家（读 maxTier='shopLevel' 时用其商店等级）
   * @param {number|string} maxTier 最高阶（含）；'shopLevel' = 该玩家当前商店等级
   * @returns {string[]} 装备 id 列表（可能少于 choices，池太小时）
   */
  _rollLotteryItems(choices, minTier, ps, maxTier = 6) {
    const hi = maxTier === 'shopLevel'
      ? Math.max(1, Math.min(6, Number.isInteger(ps?.shop?.level) ? ps.shop.level : 6))
      : Math.max(1, Math.min(6, Math.trunc(Number(maxTier)) || 6));
    const lo = Math.max(1, Math.min(hi, Math.trunc(Number(minTier)) || 1));
    const pool = [];
    for (let t = lo; t <= hi; t++) for (const id of this.gd.shopItemsByTier[t] || []) pool.push(id);
    const out = [];
    const seen = new Set();
    const rng = this.rngMeta;
    for (let guard = 0; out.length < choices && guard < choices * 20 && pool.length; guard++) {
      const id = pool[Math.floor(rng() * pool.length)];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }

  // ---- 休整期等待投票（自研，2026-10-07） ----------------------------------------------

  /**
   * Whether the prep clock is currently HELD by the wait vote (m.public.prepWait.held, m.public.deadline 0):
   * **every alive player is waiting**（全员等待，2026-10-07 v2 user request — 等待与准备完全独立）. Waiting needs
   * no readiness and never locks operations: two players can both run 电表倒转 on their boards while the clock is
   * held; anyone releasing the wait resumes the clock with the remaining seconds.
   */
  get prepWaitHeld() {
    const alive = this.alivePlayers();
    return !!this._prepWaiters?.size && alive.length > 0 && alive.every((p) => this._prepWaiters.has(p.playerId));
  }

  /** The one alive player still unready (the vote waits for THEM); null when none/ambiguous (0 or ≥2 unready). */
  _waitTargetId() {
    const unready = this.alivePlayers().filter((p) => !p.ready);
    return unready.length === 1 ? unready[0].playerId : null;
  }

  /**
   * Join (on) / leave (off) the prep wait — **independent of readiness**（v2）: an unready player waits to keep
   * operating, a ready one waits to signal patience. ALL alive players waiting holds the clock (`prepWaitHeld`);
   * any single release resumes it. Solo has no clock to hold. The wait never changes what a player may do — only
   * readiness does (user request: 和准备状态完全独立).
   * @param {any} ps caller's PlayerState
   * @param {boolean} on
   */
  prepWait(ps, on) {
    if (this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);
    if (this.soloUntimed) return fail(ERR.WRONG_PHASE, 'solo has no clock to hold');
    if (!this._prepWaiters) this._prepWaiters = new Set();
    if (on) {
      if (this._prepWaiters.has(ps.playerId)) return fail(ERR.ALREADY, t('已在等待中'));
      this._prepWaiters.add(ps.playerId);
    } else {
      if (!this._prepWaiters.delete(ps.playerId)) return fail(ERR.ALREADY, t('未在等待中'));
    }
    this._prepWaitRefresh();
    return OK;
  }

  /** Re-apply the hold after any vote/ready change: pause or resume the phase clock to match the vote state. */
  _prepWaitRefresh() {
    if (this.phase !== PHASE.PREP) return;
    const held = this.prepWaitHeld;
    if (held === this._prepWaitHeldApplied) { this.markPublic(); return; }
    this._prepWaitHeldApplied = held;
    if (held) {
      // pause: keep the remaining seconds for the resume (the phase timer is cancelled like any deadline change)
      this._prepWaitRemainSecs = this._phaseTimer ? Math.max(1, Math.ceil((this.deadline - this.sched.now()) / 1000)) : null;
      this.cancel(this._phaseTimer);
      this._phaseTimer = null;
      this.deadline = 0;
    } else {
      // release: the wait concluded (target readied / no unique target) — the votes are spent either way
      this._prepWaiters.clear();
      const secs = this._prepWaitRemainSecs ?? 1;
      this._prepWaitRemainSecs = null;
      this.setDeadline(secs, () => this.prepDeadline());
    }
    this.markPublic();
  }
}
