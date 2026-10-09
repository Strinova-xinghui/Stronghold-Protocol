// grant.js — 控制台实时发放（自研 2026-10-09）：为指定玩家的进行中对局添加任意棋子（可选精锐）与装备（可选进阶）。
// 核心在这里（无 HTTP 依赖，node --test 经 test/match/harness.js 直接单测）；server/index.js 的 /console/api/grant
// 只做 HTTP 管道（roomCode/playerId 查找）后调 applyGrants。
//
// 授予路径复用游戏自己的获得管线（商店/奖励/效果同一条）：PlayerState.acquireChess / acquireItem —— 精锐 = 直接给
// `_b` 棋子 id（isGolden 跳过合并分支，Lv7 属性直接生效）；进阶装备 = 直接给 items.json 的 goldenId。
// fromPool: false —— GM 发放不走共享卡池（不抽干卡池，盟友搜索不受影响）。玩家已拥有 2 张同干员时 GM 发第 3 张
// 仍会按游戏规则自动合成精锐（completesChessMerge → _mergeChess）——这是自然行为。
// 整备区（手牌+暂存）满 → acquireChess/acquireItem 返回 null 并给玩家发实时 toast（「整备区已满」）——结果里如实回报。
// 发钱（2026-10-09 追加；用户更正：快捷选项是「所有人」不是左右）：kind 'funds'，amount 1..10000 →
// PlayerState.addFunds（立即，dirty 标记；调用方 flush 后客户端数字立即变）；includeAll 同时给对局里所有玩家发
// 同样金额（m.order 全员，已出局跳过并标注）。
// onGain 实时广播：发放后玩家的客户端立即看到新棋子/装备（与商店购买同一条 dispatch 链）。

/**
 * Apply a batch of GM grants to one player's live PlayerState.
 * @param {any} m the live Match (m.gd the GameData, m.roomCode for logs)
 * @param {any} ps the target PlayerState
 * @param {Array<{kind?: string, id?: string, elite?: boolean, count?: number}>} grants
 * @returns {Array<{ok: boolean, kind: string|null, id: string, name: string, granted: string[], error: string|null}>}
 */
export function applyGrants(m, ps, grants) {
  const out = [];
  if (!m || !ps) return [{ ok: false, kind: null, id: '', name: '', granted: [], error: '对局或玩家不存在' }];
  const gd = m.gd;
  const list = (Array.isArray(grants) ? grants : []).slice(0, 20);
  for (const g of list) {
    const kind = g && (g.kind === 'chess' || g.kind === 'item' || g.kind === 'funds') ? g.kind : null;
    // 发钱（2026-10-09 追加；用户更正：快捷选项是「所有人」不是左右）：金额 = amount（1..10000），立即 addFunds
    // （dirty 标记 + 调用方 flush 后客户端数字立即变）。
    // includeAll: 同时给对局里**所有玩家**发同样金额（m.order 全员；已出局的跳过并如实标注）。
    if (kind === 'funds') {
      const rawAmount = Math.trunc(Number(g?.amount));
      if (!Number.isFinite(rawAmount) || rawAmount < 1) { out.push({ ok: false, kind, id: '', name: '', granted: [], error: '缺少金额（amount 1..10000）' }); continue; }
      const amount = Math.max(1, Math.min(10000, rawAmount));
      const recipients = [ps];
      if (g?.includeAll === true) {
        const order = Array.isArray(m.order) ? m.order : [];
        const seen = new Set([ps.playerId]);
        for (const x of order) {
          if (!x || seen.has(x.playerId)) continue;
          seen.add(x.playerId);
          if (x.alive === false) { out.push({ ok: false, kind, id: x.playerId, name: x.name || x.playerId, granted: [], error: '已出局，跳过' }); continue; }
          recipients.push(x);
        }
      }
      for (const r of recipients) {
        r.addFunds(amount, { reason: 'gm' });
        out.push({ ok: true, kind, id: r.playerId, name: r.name || r.playerId, granted: [`+${amount}`], error: null });
        m.log.info?.(`[console] 已为 ${r.name || r.playerId} 发放资金 ${amount}`);
      }
      continue;
    }
    const id = g && typeof g.id === 'string' ? g.id : '';
    const elite = g?.elite === true;
    const count = Math.max(1, Math.min(10, Math.trunc(Number(g?.count)) || 1));
    if (!kind || !id) { out.push({ ok: false, kind, id, name: id, granted: [], error: '缺少 kind/id' }); continue; }
    let target = id;
    if (kind === 'chess') {
      const rec = gd.chess(id);
      if (!rec) { out.push({ ok: false, kind, id, name: id, granted: [], error: '没有这个棋子' }); continue; }
      if (elite) {
        const golden = gd.goldenIdOf(id);
        if (!golden) { out.push({ ok: false, kind, id, name: rec.name || id, granted: [], error: '该干员没有精锐形态' }); continue; }
        target = golden;
      }
    } else {
      const rec = gd.item(id);
      if (!rec) { out.push({ ok: false, kind, id, name: id, granted: [], error: '没有这个装备' }); continue; }
      if (elite) {
        const golden = rec.goldenId && gd.item(rec.goldenId) ? rec.goldenId : null;
        if (!golden) { out.push({ ok: false, kind, id, name: rec.name || id, granted: [], error: '该装备没有进阶形态' }); continue; }
        target = golden;
      }
    }
    const grantedIds = [];
    let fail = null;
    for (let i = 0; i < count; i++) {
      const piece = kind === 'chess'
        ? ps.acquireChess(target, { source: 'gm', fromPool: false })
        : ps.acquireItem(target, { source: 'gm' });
      if (!piece) { fail = '整备区已满'; break; }
      grantedIds.push(piece.id);
    }
    out.push({
      ok: grantedIds.length > 0, kind, id: target,
      name: (gd.chess(target) || gd.item(target))?.name || target,
      granted: grantedIds,
      error: grantedIds.length ? (fail ? `部分发放：${fail}` : null) : (fail || '发放失败'),
    });
    if (grantedIds.length) m.log.info?.(`[console] 已为 ${ps.name || ps.playerId} 发放 ${kind === 'chess' ? '棋子' : '装备'} ${grantedIds.join(', ')}`);
  }
  return out;
}
