// server/match/match/messaging.js — Match methods: messaging — unicast, broadcast, toasts, the ticker lines
// (config.broadcasts by type; the remake's CUSTOM lines), the dirty marks and flush: m.private per player only when it
// changed (plus the prep scouts of that player's board), m.public throttled (DELAYS.PUBLIC_THROTTLE) and deduplicated.
// i18n (docs/I18N.md): a toast / CUSTOM line is a string (its own msgid) or a shared/i18n.js msg(msgid, params); the frame
// carries `text` (the Chinese rendering, what older clients show) plus `msgid` / `params`; a broadcast line carries its
// `args` so the client can fill the localized config.broadcasts template.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { DELAYS } from './common.js';
import { wireMessage } from '../../../shared/i18n.js';

export class MatchMessaging {
  sendTo(playerId, msg) {
    if (this.disposed) return false;
    // 统一镜像（自研）：发给任何玩家/AI 的帧都原样转发给监看者（影子观战支持 AI 座位）。
    // 放在最前：bot 不走 _sendPrivate、_resync 的 public 也走这里；镜像用 sendFn 直发，不经 sendTo，天然不递归。
    if (this.monitorWatchers && this.monitorWatchers.size) {
      for (const [watcherId, targetId] of this.monitorWatchers) {
        if (targetId === playerId) {
          // 固定战场（用户反馈 2026-10-07）：被看者「前往查看」队友的棋盘/战场（g.watch）时，服务器发给他的
          // m.field / b.start / b.ev / b.snap 是**别人的战场**的帧——影子固定在被看者自己的战场，这些帧不镜像。
          // 被看者被淘汰（无自己的战场）时，自动观战的 field 就是他的全部视角，照常镜像。
          if (this._monitorPinnedSkip(msg, targetId)) continue;
          try { this.sendFn(watcherId, { ...msg, _monitor: true }); } catch { /* ignore */ }
        }
      }
    }
    const ps = this.players.get(playerId) || this.spectators.get(playerId);
    // monitor 影子监看者（自研）: 不是玩家也不是观战席位，只是一个额外的收件人（不需要 PlayerState）
    const isMonitor = !ps && this.monitorWatchers && this.monitorWatchers.has(playerId);
    if (!ps && !isMonitor) return false;
    if (ps && ps.left) return false;
    try { return !!this.sendFn(playerId, msg); } catch (e) { this.reportError('send', e); return false; }
  }

  broadcast(msg) {
    if (this.disposed) return;
    try { this.broadcastFn(msg); } catch (e) { this.reportError('broadcast', e); }
  }

  /** @param {string|{ msgid: string, params?: object }} text a string or msg() (shared/i18n.js) */
  toast(ps, kind, text) {
    if (!ps || ps.isBot || ps.left || !ps.connected) return;
    this.sendTo(ps.playerId, { t: 'm.toast', kind, ...wireMessage(text) });
  }

  /** Broadcast ticker from config.broadcasts by type; `param` picks the variant (SHOP_LEVEL level, BOSS_HIT share…). */
  tickerFor(type, args = [], { playerId = null, to = null, param = null } = {}) {
    const list = Array.isArray(this.gd.config.broadcasts) ? this.gd.config.broadcasts.filter((b) => b && b.type === type) : [];
    let b = list[0];
    if (param != null) b = list.find((x) => Array.isArray(x.params) && x.params.includes(String(param))) || b;
    const tpl = b && typeof b.text === 'string' ? b.text : null;
    if (!tpl) return;
    const text = tpl.replace(/\{(\d)\}/g, (_, i) => (args[Number(i)] != null ? String(args[Number(i)]) : ''));
    const msg = { t: 'm.ticker', text, id: b.id, type, priority: Number(b.priority) || 0, playerId, args: args.map((a) => String(a ?? '')) };
    if (to) this.sendTo(to, msg);
    else this.broadcast(msg);
  }

  /**
   * A ticker line of the remake's own (type CUSTOM). `priority`: the match-flow notices (隐秘核心已解锁, 联防阶段, a player out
   * or gone) take FLOW_TICKER_PRIORITY so the strip does not hold them behind shop-level lines; other lines 0.
   */
  tickerText(text, priority = 0) {
    if (!text) return;
    const w = wireMessage(text);
    this.broadcast({ t: 'm.ticker', ...w, text: w.text.slice(0, 200), id: null, type: 'CUSTOM', priority: Number(priority) || 0, playerId: null });
  }

  markPublic() { this._pubDirty = true; }
  /**
   * A player's state changed: its m.private and (throttled, deduplicated) m.public (level, board, bonds…) — in a boss
   * round's prep also its pair partner's m.private, which shows this board on its other half (bossMate, item 51).
   */
  markPrivate(ps) {
    if (!ps) return;
    this._privDirty.add(ps);
    this._pubDirty = true;
    const m = this._bossMateOf(ps);
    if (m) this._privDirty.add(m.mate);
  }

  /** Send pending m.private (per player, only when changed) and m.public (throttled ≤ 10/s). */
  flush(forcePublic = false) {
    if (this.disposed) return;
    if (this._privDirty.size) {
      const list = [...this._privDirty];
      this._privDirty.clear();
      for (const ps of list) {
        if (!(ps.isBot || ps.left || !ps.connected)) this._sendPrivate(ps, false);
        // AI 座位被影子监看（自研）: bot 平时不发 private，被监看时也要持续推送，否则观战画面静止
        else if (ps.isBot && this._isWatched(ps.playerId)) this._sendPrivate(ps, false);
        this._notifyPrepScouts(ps);
      }
    }
    if (this._pubDirty || forcePublic) this._maybeSendPublic(forcePublic);
  }

  _sendPrivate(ps, force) {
    let view;
    try { view = ps.privateView(); } catch (e) { this.reportError('privateView', e); return; }
    const json = JSON.stringify(view);
    if (!force && json === ps._lastPriv) return;
    ps._lastPriv = json;
    this.sendTo(ps.playerId, view);
  }

  _maybeSendPublic(force) {
    const now = this.sched.now();
    if (!force && now - this._lastPubAt < DELAYS.PUBLIC_THROTTLE) {
      if (!this._pubTimer) {
        const wait = Math.max(1, DELAYS.PUBLIC_THROTTLE - (now - this._lastPubAt));
        this._pubTimer = this.sched.setTimeout(() => {
          this._pubTimer = null;
          if (this.disposed) return;
          try { this._maybeSendPublic(false); } catch (e) { this.reportError('public', e); }
        }, wait);
      }
      return;
    }
    this._pubDirty = false;
    let view;
    try { view = this.publicView(); } catch (e) { this.reportError('publicView', e); return; }
    const { serverNow, ...rest } = view;
    const json = JSON.stringify(rest);
    if (!force && json === this._lastPubJson) return;
    this._lastPubJson = json;
    this._lastPubAt = now;
    this.broadcast(view);
    // monitor 影子监看者（自研）: 也要收到 m.public（否则客户端不知道阶段/回合/玩家列表）
    for (const watcherId of this._monitorIds()) this.sendTo(watcherId, view);
  }
}
