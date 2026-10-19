// server/match/player/custom.js — PlayerState 自研方法模块（第 11 个 part，2026-10-13 上游 0.2.5 同步时从旧单体重建）。
// 上游 0.2.5 把 PlayerState 拆成 server/match/player/* 子模块；本文件承载自研方法，
// PlayerState.js 在 parts 数组末尾挂载本模块（同名方法两次定义会 throw，故不与上游重名）。
// 涵盖：定向甄选 rewardOffer 的盟约解析（_rewardOfferPlan 群）。
// 注意：干员皮肤 setSkins / skinFor 自 0.3.1 起由上游 player/basics.js 原生提供（checkSkinSelection 校验、
// 支持自选与补位、per-charId 键），本模块的同名实现已删除——同名方法会触发 PlayerState 的「defined twice」硬错。

import { getCustomRules } from '../customRules.js';

export class PlayerCustom {
  /** 某干员（base 或 golden id）是否带盟约 `bond`。（自研「定向甄选」辅助） */
  _chessHasBond(id, bond) {
    const c = this.gd.chess(id);
    return !!(c && Array.isArray(c.bonds) && c.bonds.includes(bond));
  }

  /**
   * 自研「定向甄选」：解析 config/custom-rules.json 的位置映射，返回 `[{ bond, mult, mode } | null, …]`（长度 = count）。
   * 规则关闭 / 未配置 → null（调用方走原版纯随机）。热更：每次调用都重新读文件（mtime 缓存）。
   */
  _rewardOfferPlan(count) {
    let rules = null;
    try { rules = getCustomRules({ log: this.m.log }); } catch { return null; }
    const slots = rules && rules.rewardOffer ? rules.rewardOffer.slots : null;
    if (!slots || !slots.length) return null;
    const plan = new Array(count).fill(null);
    for (const rule of slots) {
      if (rule.slot < 0 || rule.slot >= count) continue;
      const bond = rule.kind === 'mainCount' ? this._topBondByCount(rule) : this._topBondByLayers(rule);
      if (bond) plan[rule.slot] = { bond, mult: rule.mult, mode: rule.mode };
    }
    return plan.some(Boolean) ? plan : null;
  }

  /** 激活人数最多的盟约（默认要求 count ≥ 3 = 所有核心盟约的激活阈值）。 */
  _topBondByCount(rule) {
    let best = null, bestCount = 0;
    for (const [id, b] of Object.entries(this.bonds)) {
      if (!b || !b.active) continue;
      if (b.count < rule.minCount) continue;
      if (b.count > bestCount) { best = id; bestCount = b.count; }
    }
    return best;
  }

  /** 层数最多的盟约（排除 rule.exclude：独行 + 经济类；要求已激活且层数 ≥ minLayers）。 */
  _topBondByLayers(rule) {
    const ex = new Set(rule.exclude || []);
    let best = null, bestLayers = -1;
    for (const [id, b] of Object.entries(this.bonds)) {
      if (!b || !b.active) continue;
      if (ex.has(id)) continue;
      if (b.count < rule.minCount) continue;
      const layers = (this.layers && this.layers[id]) || 0;
      if (layers < rule.minLayers) continue;
      if (layers > bestLayers) { best = id; bestLayers = layers; }
    }
    return best;
  }
}
