// server/http/customRoutes.js — 自研 HTTP 路由（monitor 监控台 / console 规则控制台 / lan-room 房间探测）。
// 上游 0.2.5 重构把 HTTP 服务拆进 server/http/*（routes.js 只留 /healthz + 静态）；本文件承载我们的全部自研路由，
// routes.js 在 /healthz 之后、静态服务之前调用 handleCustomRoutes()。未来同步上游时只需保住 routes.js 的一行钩子
// 与本文件（自研文件，上游没有）。/monitor 为只读快照；/console 系列与 /lan/room 仅内网来源可访问。
// (i18n-ignore-file: the /monitor dashboard is a self-contained Chinese page served as-is — not a UI string)


import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { PHASE_NAMES } from '../../shared/constants.js';
import { sendError, sendJson } from './common.js';
import { getCustomRules, saveCustomRules, CUSTOM_RULES_PATH } from '../match/customRules.js';
import { applyGrants } from '../match/grant.js';
import { t } from '../../shared/i18n.js';
function isPrivateAddress(addr) {
  if (!addr) return false;
  const a = String(addr).toLowerCase().replace(/^::ffff:/, '');
  if (a === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const o1 = +v4[1];
    const o2 = +v4[2];
    return o1 === 10 || o1 === 127 || (o1 === 192 && o2 === 168) || (o1 === 172 && o2 >= 16 && o2 <= 31)
      || (o1 === 100 && o2 >= 64 && o2 <= 127) // RFC 6598 CGNAT (Tailscale, ZeroTier, UU 等虚拟专网)
      || (o1 === 169 && o2 === 254);
  }
  return /^f[cd][0-9a-f]{1,2}:/.test(a); // IPv6 unique-local (fc00::/7)
}

/**
 * Snapshot of every room for the /monitor API (read-only, no game-state mutation).
 * Rooms in lobby: seats with ready/connected; running matches: phase, round, LP, shop levels…
 * PHASE_NAMES (shared/constants.js) is client-shared code, safe to import here (plain object).
 */
function monitorSnapshot(lobby, sockets = 0) {
  const rooms = [];
  for (const r of lobby.rooms.values()) {
    const room = {
      code: r.code, mode: r.mode, difficulty: r.difficulty, inMatch: !!r.match,
      host: null, seats: [], spectators: r.spectators.map((s) => ({ name: s.name, connected: s.connected })),
      match: null,
    };
    for (const s of r.seats) {
      if (!s) { room.seats.push(null); continue; }
      if (s.playerId === r.hostId) room.host = s.name;
      room.seats.push({ name: s.name, isBot: s.isBot, ready: s.ready, connected: s.connected && !s.left, left: !!s.left });
    }
    if (r.match && !r.match.disposed && !r.match.ended) {
      const m = r.match;
      const players = (m.order || []).map((ps) => ({
        playerId: ps.playerId,
        name: ps.name, isBot: ps.isBot, connected: ps.isBot || (ps.connected && !ps.left),
        alive: ps.alive, lp: Math.max(0, Math.round(ps.lp) || 0), shopLevel: ps.shop ? ps.shop.level : null,
        boardCount: ps.deployCount ?? null, ready: !!(ps.infoReady ?? ps.ready),
      }));
      room.match = {
        phase: m.phase, phaseName: PHASE_NAMES[m.phase] || m.phase,
        round: m.round, lastRound: m.gd ? m.gd.lastRound : null,
        teamLp: m.teamLp == null ? null : Math.max(0, Math.round(m.teamLp)),
        paused: !!m.paused,
        players,
      };
    }
    rooms.push(room);
  }
  return { time: new Date().toISOString(), stats: { ...lobby.stats(), sockets }, rooms };
}

/** /monitor dashboard: self-contained HTML, polls /monitor?json every 5 s. No game assets, no build step. */
const MONITOR_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%237ecbff'/%3E%3Cpath d='M9 22V10h3l4 7 4-7h3v12h-3v-7l-4 6-4-6v7z' fill='%2310151c'/%3E%3C/svg%3E">
<title>卫戍协议 · 服务器监控</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; background: #10151c; color: #d8e0ea; font: 14px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; color: #7ecbff; }
  .sub { color: #7a8698; font-size: 12px; margin-bottom: 16px; }
  .stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
  .stat { background: #182130; border: 1px solid #26344a; border-radius: 8px; padding: 10px 16px; min-width: 90px; }
  .stat b { display: block; font-size: 22px; color: #fff; }
  .stat span { font-size: 12px; color: #7a8698; }
  .room { background: #182130; border: 1px solid #26344a; border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; }
  .room-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .code { font-size: 20px; font-weight: 700; letter-spacing: 2px; color: #ffd479; }
  .tag { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #223047; color: #9db4d0; }
  .tag.match { background: #1d3a2a; color: #7fe0a2; }
  .tag.paused { background: #4a3a1d; color: #ffce7a; }
  .phase { font-size: 13px; color: #7ecbff; }
  .round { font-size: 13px; color: #9db4d0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #223047; }
  th { color: #7a8698; font-weight: 500; font-size: 12px; }
  .on { color: #7fe0a2; } .off { color: #e07a7a; } .bot { color: #b48ce0; } .dead { color: #e07a7a; }
  .lp { font-variant-numeric: tabular-nums; color: #ffd479; }
  .spec { margin-top: 8px; font-size: 12px; color: #7a8698; }
  .empty { color: #7a8698; text-align: center; padding: 40px 0; }
  /* 观战/数据（自研） */
  .nav { display: flex; gap: 8px; margin: 0 0 16px; }
  .nav-btn { background: #182130; color: #9db4d0; border: 1px solid #26344a; border-radius: 8px; padding: 7px 16px; cursor: pointer; font: inherit; font-size: 13px; }
  .nav-btn:hover { border-color: #3d6fa8; }
  .nav-btn.active { background: #1d3350; color: #fff; border-color: #3d6fa8; }
  .viewpage { display: flex; flex-direction: column; height: calc(100vh - 130px); }
  .viewpage.hidden { display: none; }
  .viewpage iframe { flex: 1; width: 100%; border: 1px solid #26344a; border-radius: 10px; background: #0f1116; }
  .watchbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  .watchbar input { flex: 1; min-width: 240px; background: #0f1116; color: #d8e0ea; border: 1px solid #26344a; border-radius: 7px; padding: 6px 10px; font: inherit; font-size: 13px; }
  .watchbar button { background: #223047; color: #d8e0ea; border: 1px solid #2f4057; border-radius: 7px; padding: 6px 14px; cursor: pointer; font: inherit; font-size: 13px; }
  .watchbar .hint { color: #7a8698; font-size: 12px; }
  .watch-exit { background: #3a1d22; color: #ff9a9a; border: 1px solid #5a2f35; }
  .watch-exit:hover { background: #4a2228; color: #fff; border-color: #8a444c; }
  .mon-btn { display: inline-block; background: #223047; color: #9db4d0; border: 1px solid #2f4057; border-radius: 6px; padding: 2px 10px; cursor: pointer; font-size: 12px; margin-right: 6px; text-decoration: none; line-height: 1.6; }
  .mon-btn:hover { background: #2b3d59; color: #fff; }
  .mon-btn.ghost { background: transparent; color: #7a8698; }
  .watch { position: fixed; right: 16px; top: 16px; width: 420px; max-height: 88vh; overflow: auto; background: #131a25; border: 1px solid #2f4057; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.5); z-index: 20; }
  .watch.hidden { display: none; }
  .watch-head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #223047; position: sticky; top: 0; background: #131a25; }
  .watch-head b { color: #ffd479; flex: 1; }
  .watch-head button { background: #223047; color: #9db4d0; border: none; border-radius: 6px; padding: 3px 10px; cursor: pointer; }
  .watch-body { padding: 12px 14px; }
  .ws-on { color: #7fe0a2; font-size: 12px; } .ws-off { color: #e07a7a; font-size: 12px; }
  .kv { display: flex; gap: 14px; flex-wrap: wrap; font-size: 13px; margin-bottom: 10px; }
  .kv span { color: #7a8698; } .kv b { color: #fff; margin-left: 4px; }
  .sec { margin-bottom: 10px; } .sec h4 { margin: 0 0 5px; font-size: 12px; color: #7a8698; font-weight: 500; }
  .chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .chip { font-size: 12px; padding: 2px 7px; border-radius: 5px; background: #1d2735; color: #c6d4e6; }
  .chip.empty { color: #3a4658; background: transparent; } .chip.shop { background: #2a3550; color: #ffd479; }
  .chip.bond { background: #223047; color: #9db4d0; } .chip.bond.on { background: #1d3a2a; color: #7fe0a2; }
  .muted { color: #3a4658; font-size: 12px; }
  .ts { color: #3a4658; font-size: 11px; margin-top: 8px; }
</style>
</head>
<body>
<h1>卫戍协议 · 服务器监控</h1>
<div class="sub" id="updated">加载中…</div>
<nav class="nav">
  <button class="nav-btn active" data-view="monitor">监控</button>
  <button class="nav-btn" data-view="console">规则控制台</button>
  <button class="nav-btn" data-view="watch">观战</button>
</nav>
<div id="view-monitor">
<div class="stats" id="stats"></div>
<div id="rooms"></div>
</div>
<div id="view-console" class="viewpage hidden">
  <iframe id="console-frame" title="规则控制台" src="about:blank"></iframe>
</div>
<div id="view-watch" class="viewpage hidden">
  <div class="watchbar">
    <input id="watch-url" type="text" placeholder="观战地址（从监控页点某位玩家的「观战」自动填入）">
    <button id="watch-go">载入</button>
    <button id="watch-exit" class="watch-exit">退出观战</button>
    <span class="hint">页内嵌观战，不占席位、不影响玩家</span>
  </div>
  <iframe id="watch-frame" title="观战" src="about:blank" allow="autoplay"></iframe>
</div>
<div id="watch" class="watch hidden">
  <div class="watch-head">
    <b id="watch-title">监看</b>
    <span id="watch-status" class="ws-off">未连接</span>
    <button id="watch-close">关闭</button>
  </div>
  <div id="watch-body" class="watch-body"><div class="empty">选择一名玩家后开始接收数据…</div></div>
</div>
<script>
const PHASE_NAMES = __PHASE_NAMES__;
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
// ---- 顶部视图切换（自研：监控 / 控制台 / 观战 合一）----
function showView(name) {
  for (const b of document.querySelectorAll('.nav-btn')) b.classList.toggle('active', b.dataset.view === name);
  document.getElementById('view-monitor').classList.toggle('hidden', name !== 'monitor');
  document.getElementById('view-console').classList.toggle('hidden', name !== 'console');
  document.getElementById('view-watch').classList.toggle('hidden', name !== 'watch');
  if (name === 'console') {
    const f = document.getElementById('console-frame');
    if (f.src === 'about:blank' || !f.src) f.src = '/console';
  }
  // 观战 iframe 只在可见时保留，切走时清空以释放 WS（影子客户端会占一条连接）
  if (name !== 'watch') {
    const w = document.getElementById('watch-frame');
    if (w && w.src !== 'about:blank') w.src = 'about:blank';
  }
}
/** 退出观战：断开影子客户端（清空 iframe）+ 停止数据监看 + 回到监控视图。 */
function exitWatch() {
  document.getElementById('watch-frame').src = 'about:blank';
  document.getElementById('watch-url').value = '';
  // 数据面板（监看 WS）也一并停掉——它跟观战是两条独立连接
  monClose();
  showView('monitor');
}
/** 在页内 iframe 打开观战（替代原来的新标签页）。 */
function watchInPage(url) {
  document.getElementById('watch-url').value = url;
  document.getElementById('watch-frame').src = url;
  showView('watch');
}
document.addEventListener('click', (ev) => {
  const nb = ev.target.closest('.nav-btn');
  if (nb) { showView(nb.dataset.view); return; }
  const wb = ev.target.closest('[data-watch-url]');
  if (wb) { ev.preventDefault(); watchInPage(wb.dataset.watchUrl); return; }
});
function seatRow(s, matchLive) {
  if (!s) return '<tr><td colspan="5" style="color:#3a4658">— 空位 —</td></tr>';
  const conn = s.connected ? '<span class="on">在线</span>' : '<span class="off">离线</span>';
  const tag = s.isBot ? ' <span class="bot">AI</span>' : '';
  const ready = matchLive ? '' : (s.ready ? ' · 已准备' : '');
  return '<tr><td>' + esc(s.name) + tag + ready + '</td><td>' + conn + '</td></tr>';
}
function render(d) {
  const st = d.stats;
  document.getElementById('updated').textContent = '更新于 ' + new Date(d.time).toLocaleTimeString('zh-CN') + ' · 每 5 秒自动刷新';
  document.getElementById('stats').innerHTML =
    '<div class="stat"><b>' + st.rooms + '</b><span>房间</span></div>' +
    '<div class="stat"><b>' + st.matches + '</b><span>进行中对局</span></div>' +
    '<div class="stat"><b>' + st.humans + '</b><span>在线玩家</span></div>' +
    '<div class="stat"><b>' + st.bots + '</b><span>AI</span></div>' +
    '<div class="stat"><b>' + st.spectators + '</b><span>观战</span></div>' +
    '<div class="stat"><b>' + st.sockets + '</b><span>WS 连接</span></div>';
  const el = document.getElementById('rooms');
  if (!d.rooms.length) { el.innerHTML = '<div class="empty">当前没有房间 —— 等待第一位博士登录</div>'; return; }
  el.innerHTML = d.rooms.map((r) => {
    let h = '<div class="room"><div class="room-head">' +
      '<span class="code">' + esc(r.code) + '</span>' +
      '<span class="tag">' + (r.mode === 'coop' ? '同盟模拟' : '独立模拟') + ' · ' + esc(r.difficulty) + '</span>' +
      (r.inMatch ? '<span class="tag match">对局中</span>' : '<span class="tag">大厅</span>') +
      (r.host ? '<span style="color:#7a8698;font-size:12px">房主: ' + esc(r.host) + '</span>' : '');
    if (r.match) {
      const m = r.match;
      h += '<span class="phase">' + esc(m.phaseName) + '</span>' +
           '<span class="round">回合 ' + m.round + '/' + (m.lastRound ?? '?') + '</span>' +
           (m.paused ? '<span class="tag paused">已暂停</span>' : '') +
           (m.teamLp != null ? '<span class="lp">团队生命 ' + m.teamLp + '</span>' : '');
    }
    h += '</div><table><tr><th>玩家</th><th>状态</th><th colspan="2">操作</th></tr>';
    if (r.match) {
      for (const p of r.match.players) {
        const conn = p.connected ? '<span class="on">在线</span>' : '<span class="off">离线</span>';
        const tag = p.isBot ? ' <span class="bot">AI</span>' : '';
        const alive = p.alive ? '' : ' <span class="dead">淘汰</span>';
        // 观战入口（自研）: 「观战」= 影子客户端（全功能视角，不占席位、不影响玩家）；「数据」= 侧栏数据面板。
        // 观战默认在**页内 iframe**打开（顶部「观战」标签页），不再强制新标签；按 Ctrl/中键仍可新标签打开。
        // 任何座位都可看（含 AI）——方便观察 bot 的商店/装备/摆阵来调甄选数值。
        const watchable = !!p.playerId;
        const shadowUrl = '/?shadow=' + esc(r.code) + '&as=' + esc(p.playerId);
        const btns = watchable
          ? '<a class="mon-btn" href="' + shadowUrl + '" data-watch-url="' + shadowUrl + '">观战</a>' +
            '<a class="mon-btn ghost" href="' + shadowUrl + '" target="_blank" rel="noopener" title="在新标签页打开">新标签</a>' +
            '<button class="mon-btn ghost" data-code="' + esc(r.code) + '" data-pid="' + esc(p.playerId) + '" data-name="' + esc(p.name) + '">数据</button>'
          : '';
        h += '<tr><td>' + esc(p.name) + tag + alive + '</td><td>' + conn +
             '</td><td class="lp">LP ' + p.lp + '</td><td>商店 Lv' + (p.shopLevel ?? '?') + '</td><td>场上 ' + (p.boardCount ?? '?') + '</td>' +
             '<td>' + btns + '</td></tr>';
      }
    } else {
      for (const s of r.seats) h += seatRow(s, false);
    }
    h += '</table>';
    if (r.spectators.length) h += '<div class="spec">观战: ' + r.spectators.map((s) => esc(s.name) + (s.connected ? '' : '(离线)')).join('、') + '</div>';
    return h + '</div>';
  }).join('');
}
async function tick() {
  try {
    const r = await fetch('/monitor?json', { cache: 'no-store' });
    render(await r.json());
  } catch (e) {
    document.getElementById('updated').textContent = '刷新失败: ' + e.message;
  }
}
render(__INITIAL__);
setInterval(tick, 5000);

// ---- 监看（自研）: 通过 m.monitor 订阅某玩家的完整 m.private（装备/整备区/商店），独立于观战席位 ----
let monWs = null, monRid = 0, monTarget = null;
const monPending = new Map();
function monSetStatus(text, cls) {
  const el = document.getElementById('watch-status');
  el.textContent = text;
  el.className = cls;
}
function monConnect() {
  if (monWs && monWs.readyState <= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    monWs = new WebSocket(proto + '//' + location.host + '/ws');
    monWs.onopen = () => { monSetStatus('已连接', 'ws-on'); resolve(); };
    monWs.onerror = () => { monSetStatus('连接失败', 'ws-off'); reject(new Error('ws error')); };
    monWs.onclose = () => { monSetStatus('已断开', 'ws-off'); monWs = null; };
    monWs.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.rid && monPending.has(m.rid)) { monPending.get(m.rid)(m); monPending.delete(m.rid); return; }
      if (m.t === 'm.private' && m._monitor) monRenderPrivate(m);
    };
  });
}
function monRequest(msg) {
  return new Promise((resolve) => {
    const rid = ++monRid;
    monPending.set(rid, resolve);
    monWs.send(JSON.stringify({ ...msg, rid }));
    setTimeout(() => { if (monPending.has(rid)) { monPending.delete(rid); resolve({ t: 'error', code: 'TIMEOUT' }); } }, 4000);
  });
}
async function monWatch(code, playerId, name) {
  document.getElementById('watch').classList.remove('hidden');
  document.getElementById('watch-title').textContent = '监看: ' + name;
  document.getElementById('watch-body').innerHTML = '<div class="empty">正在订阅…</div>';
  try {
    await monConnect();
    if (!monTarget) { await monRequest({ t: 'hello', name: '监控台' }); }
    if (monTarget && monTarget.playerId !== playerId) await monRequest({ t: 'm.monitor', code: monTarget.code, targetPlayerId: null });
    const r = await monRequest({ t: 'm.monitor', code, targetPlayerId: playerId });
    if (r.t === 'error') { document.getElementById('watch-body').innerHTML = '<div class="empty">订阅失败: ' + esc(r.code) + '</div>'; return; }
    monTarget = { code, playerId, name };
  } catch (e) {
    document.getElementById('watch-body').innerHTML = '<div class="empty">连接失败: ' + esc(e.message) + '</div>';
  }
}
function monClose() {
  if (monTarget && monWs && monWs.readyState === 1) monRequest({ t: 'm.monitor', code: monTarget.code, targetPlayerId: null });
  monTarget = null;
  document.getElementById('watch').classList.add('hidden');
}
// privateView 渲染：手牌/整备区、棋盘（含装备）、商店、资金/生命/盟约
function monRenderPrivate(v) {
  const chips = (arr) => arr.map((p) => p
    ? '<span class="chip" title="' + esc(p.id) + '">' + esc((p.id || '').replace(/^chess_/, '')) + (p.items && p.items.length ? ' <b>+' + p.items.length + '</b>' : '') + '</span>'
    : '<span class="chip empty">·</span>').join('');
  const shopSlots = (v.shop && v.shop.slots || []).map((s) => s
    ? '<span class="chip shop">' + esc((s.id || '').replace(/^(chess|item)_/, '')) + ' <b>' + s.price + '</b></span>'
    : '<span class="chip empty">·</span>').join('');
  const bonds = (v.bonds || []).filter((b) => b.active || b.layers).slice(0, 12)
    .map((b) => '<span class="chip bond' + (b.active ? ' on' : '') + '">' + esc(b.bondId) + ' ' + b.count + (b.layers ? '/' + b.layers : '') + '</span>').join('');
  const hand = (v.hand || []).filter(Boolean);
  const temp = (v.temp || []).filter(Boolean);
  document.getElementById('watch-body').innerHTML =
    '<div class="kv"><span>资金</span><b>' + v.funds + '</b><span>生命</span><b>' + v.lp + '</b>' +
    '<span>商店Lv</span><b>' + (v.shop ? v.shop.level : '?') + '</b><span>场上</span><b>' + (v.deployCount ?? '?') + '/' + (v.deployCap ?? '?') + '</b></div>' +
    '<div class="sec"><h4>商店' + (v.shop && v.shop.rewardOffer ? '（有奖励选卡）' : '') + '</h4><div class="chips">' + (shopSlots || '<span class="muted">空</span>') + '</div></div>' +
    '<div class="sec"><h4>棋盘 ' + (v.board || []).length + ' 个（含装备）</h4><div class="chips">' + (chips(v.board) || '<span class="muted">空</span>') + '</div></div>' +
    '<div class="sec"><h4>整备区 ' + hand.length + '</h4><div class="chips">' + (chips(v.hand) || '<span class="muted">空</span>') + '</div></div>' +
    (temp.length ? '<div class="sec"><h4>临时区 ' + temp.length + '</h4><div class="chips">' + chips(v.temp) + '</div></div>' : '') +
    '<div class="sec"><h4>盟约</h4><div class="chips">' + (bonds || '<span class="muted">无</span>') + '</div></div>' +
    '<div class="ts">最后更新 ' + new Date().toLocaleTimeString('zh-CN') + '</div>';
}
// 事件委托：卡片上的「数据」按钮（只处理 data-code 的 button；观战链接由 data-watch-url 委托处理）
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button.mon-btn[data-code]');
  if (btn) { monWatch(btn.dataset.code, btn.dataset.pid, btn.dataset.name); return; }
  if (ev.target.closest('#watch-close')) monClose();
});
// 「载入」按钮：把地址栏里的观战 URL 载入 iframe
document.getElementById('watch-go').addEventListener('click', () => {
  const u = document.getElementById('watch-url').value.trim();
  if (u) document.getElementById('watch-frame').src = u;
});
// 「退出观战」：断影子 WS + 停数据监看 + 回监控视图
document.getElementById('watch-exit').addEventListener('click', exitWatch);
</script>
</body>
</html>`;

/** 读取原始配置文件（控制台用；保留注释键，不做 normalize，让表单看到真实内容）。 */
function consoleApiRead() {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(CUSTOM_RULES_PATH, 'utf8')); } catch { config = {}; }
  const rules = getCustomRules({});
  const on = [];
  if (rules.rewardOffer) on.push(t('三选一'));
  if (rules.itemOffer) on.push(t('装备甄选'));
  if (rules.prepDebt) on.push(t('负债'));
  if (rules.roundLottery) on.push(t('抽奖'));

  if (rules.extraRounds) on.push(t('回合编排'));

  if (rules.pacing) on.push(t('对局节奏'));

  if (rules.bossHp) on.push(t('BOSS 血量'));
  if (rules.bossBgm) on.push(t('BOSS音乐'));
  return { ok: true, path: 'config/custom-rules.json', config, rules, summary: on.length ? t('生效中：{0}', { 0: on.join(' / ') }) : t('全部关闭（原版行为）') };
}

/** 发放页的状态（控制台自研 2026-10-09）：进行中的对局与其玩家（房间/玩家选择器用）。仅内网。 */
function consoleApiState(lobby) {
  const rooms = [];
  for (const r of lobby.rooms.values()) {
    const m = r.match;
    if (!m || m.disposed || m.ended) continue;
    rooms.push({
      code: r.code, mode: r.mode, difficulty: r.difficulty,
      phaseName: PHASE_NAMES[m.phase] || m.phase, round: m.round,
      players: (m.order || []).map((ps) => ({
        playerId: ps.playerId, name: ps.name, isBot: !!ps.isBot,
        connected: ps.isBot || (ps.connected && !ps.left), alive: ps.alive,
        lp: Math.max(0, Math.round(ps.lp) || 0),
      })),
    });
  }
  return { ok: true, rooms };
}

/** 读取一个 JSON 请求体（发放接口用；>64KB 拒绝）。 */
async function readGrantBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) { req.destroy(); throw new Error('请求过大（>64KB）'); }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw);
}

/** 实时发放（控制台自研 2026-10-09）：为指定玩家的进行中对局添加棋子（可选精锐）/装备（可选进阶）。仅内网。
 *  核心授予在 server/match/grant.js applyGrants（可单测）；这里做 HTTP 管道 + roomCode/playerId 查找。 */
async function consoleApiGrant(req, res, log, lobby) {
  // 总开关（自研 2026-10-12）：grant.enabled=false 时一律 403——原版没有 GM 发放能力，全关=原汁原味。
  const grantRules = getCustomRules({ log });
  if (!grantRules.grant) { sendJson(req, res, 403, { ok: false, error: t('GM 实时发放已禁用（控制台 grant 开关已关闭）') }); return; }
  let body = null;
  try { body = await readGrantBody(req); } catch (e) { sendJson(req, res, 400, { ok: false, error: t('请求体无效：') + e.message }); return; }
  const roomCode = typeof body?.roomCode === 'string' ? body.roomCode : '';
  // playerId 是字符串（lobby.js typedef；harness 用 p_0 之类）——数字也接受，统一按字符串比较
  const playerId = (typeof body?.playerId === 'string' || typeof body?.playerId === 'number') && body.playerId !== '' ? String(body.playerId) : null;
  if (!roomCode || !playerId || !Array.isArray(body?.grants) || !body.grants.length) {
    sendJson(req, res, 400, { ok: false, error: t('缺少 roomCode / playerId / grants') }); return;
  }
  const room = lobby.rooms.get(roomCode);
  const m = room && room.match;
  if (!room || !m || m.disposed || m.ended) { sendJson(req, res, 404, { ok: false, error: t('对局不存在或已结束') }); return; }
  const ps = (m.order || []).find((p) => p.playerId === playerId);
  if (!ps) { sendJson(req, res, 404, { ok: false, error: t('该玩家不在此对局中') }); return; }
  try {
    const results = applyGrants(m, ps, body.grants);
    // 发放不是客户端动作，没人替它 flush——立即把新 m.private/m.public 推给客户端（acquireChess/acquireItem
    // 已 markPrivate，flush 负责真正发送；掉线玩家下次 _resync 也会拿到）
    try { m.flush(); } catch { /* disposed */ }
    sendJson(req, res, 200, { ok: results.some((r) => r.ok), results });
  } catch (e) {
    log.error?.('[console] 发放失败', e);
    sendJson(req, res, 500, { ok: false, error: t('发放失败：') + e.message });
  }
}

/** 写入配置（控制台用）。非法内容拒绝落盘；成功即热更（清 mtime 缓存，无需重启）。 */
async function consoleApiWrite(req, res, log) {
  let raw = '';
  try {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 256 * 1024) { sendJson(req, res, 413, { ok: false, error: t('配置过大（>256KB）') }); req.destroy(); return; }
      chunks.push(c);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } catch (e) { sendJson(req, res, 400, { ok: false, error: t('读取请求体失败：') + e.message }); return; }
  let obj = null;
  try { obj = JSON.parse(raw); } catch (e) { sendJson(req, res, 400, { ok: false, error: t('JSON 语法错误：') + e.message }); return; }
  try {
    const saved = saveCustomRules(obj);
    const rules = getCustomRules({});
    const on = [];
    if (rules.rewardOffer) on.push(t('三选一'));
    if (rules.itemOffer) on.push(t('装备甄选'));
    if (rules.prepDebt) on.push(t('负债'));
    if (rules.roundLottery) on.push(t('抽奖'));

    if (rules.extraRounds) on.push(t('回合编排'));

    if (rules.pacing) on.push(t('对局节奏'));

    if (rules.bossHp) on.push(t('BOSS 血量'));
    if (rules.grant) on.push(t('GM 发放'));
    if (rules.prepUndo) on.push(t('撤回'));
    if (rules.music) on.push(t('播放器'));
    if (rules.bossBgm) on.push(t('BOSS音乐'));
    log.info(`[console] 规则配置已更新（${on.join(' / ') || '全部关闭'}）`);
    sendJson(req, res, 200, { ok: true, config: obj, rules: saved.rules, summary: on.length ? t('生效中：{0}', { 0: on.join(' / ') }) : t('全部关闭（原版行为）') });
  } catch (e) {
    sendJson(req, res, 400, { ok: false, error: t('配置被拒绝：') + e.message });
  }
}

// ---- 自研路由入口 -----------------------------------------------------------------------------------------------

const CONSOLE_PATHS = new Set(['/console', '/console/api', '/console/api/state', '/console/api/grant']);

/**
 * The real client IP for our private-only routes. Strict(er than net.js 'auto'):
 * a non-loopback socket is judged by its own address — forwarding headers are never
 * trusted (a direct public peer could spoof X-Forwarded-For: 10.x); a loopback socket
 * is a local reverse proxy (Caddy) — take the RIGHTMOST X-Forwarded-For entry only
 * (the proxy appends the real client IP last, so client-forged entries sit left), and
 * ignore cf-connecting-ip / x-real-ip entirely (Caddy forwards client-forged headers).
 * @param {import('node:http').IncomingMessage} req @returns {string}
 */
function realClientIp(req) {
  const peer = String(req.socket?.remoteAddress || '').toLowerCase().replace(/^::ffff:/, '');
  if (peer !== '::1' && peer !== '127.0.0.1') return peer;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') {
    const parts = xff.split(',');
    const ip = parts[parts.length - 1].trim();
    if (ip) return ip;
  }
  return peer;
}

/**
 * Handle our custom routes; `true` = handled (the response was written), `false` = not ours (the caller falls
 * through to the static handler). /monitor is a read-only snapshot; /console* and /lan/room answer private
 * (loopback / RFC1918 / CGNAT / ULA) peers only — 404 to everyone else, never a room list or a rule write.
 * @param {{ req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *           parts: { rawPath: string, query: string },
 *           deps: { lobby: import('../lobby.js').Lobby, network: import('../net.js').Network,
 *                   registry: import('../net.js').SessionRegistry, publicDir: string, log: object }}} args
 * @returns {Promise<boolean>}
 */
export async function handleCustomRoutes({ req, res, parts, deps }) {
  const p = parts.rawPath;
  if (p !== '/monitor' && !CONSOLE_PATHS.has(p) && p !== '/lan/room') return false;
  // 外层门：只看 socket 传输层（回环/内网/公网直连），不看任何转发头——伪造也无传输层地位。
  // monitor 例外：房主日常经域名看监看台（只读快照，泄露面小），不设门（2026-10-13 恢复原行为——
  // 此前补的 realClientIp 内层门把经域名的房主也 404 了，误伤）。realClientIp 仅 console 登录制使用。
  if (p !== '/monitor' && !isPrivateAddress(req.socket?.remoteAddress)) { sendError(req, res, 404, t('未找到 · Not found')); return true; }
  const { lobby, network, publicDir, log } = deps;
  if (p === '/monitor') {
    if (parts.query === 'json' || parts.query.startsWith('json&') || new URLSearchParams(parts.query).has('json')) {
      sendJson(req, res, 200, monitorSnapshot(lobby, network.connectionCount)); return true;
    }
    const snap = JSON.stringify(monitorSnapshot(lobby, network.connectionCount)).replace(/</g, '\u003c');
    const html = MONITOR_HTML
      .replace('__INITIAL__', snap)
      .replace('__PHASE_NAMES__', JSON.stringify(PHASE_NAMES));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : html);
    return true;
  }
  if (CONSOLE_PATHS.has(p)) {
    // 登录制（2026-10-11 旧服 server/index.js 实现，2026-10-13 移植 0.2.5 新架构并补洞）：内网免密；
    // 公网走 HTTP Basic（用户名 strinova，密码 SP_CONSOLE_PASSWORD）；未配置密码时公网一律 404，不暴露入口。
    // 来源判定分两层：外层门只看 socket（上文）；此处内层门用 realClientIp 还原真实来源——
    // Caddy 反代下 socket 全是 127.0.0.1，取 XFF 最右（代理追加的真源）；直连 :24500 时 socket 即
    // 真源、任何转发头都不看。旧写法信任全局 TRUST_PROXY/任意转发头——直连伪造 X-Forwarded-For: 10.x、
    // 经域名伪造 cf-connecting-ip 都能冒充内网绕过密码（旧实现自 10-11 起就存在的洞，本次一并关掉）。
    {
      const isLocal = isPrivateAddress(realClientIp(req));
      const pass = process.env.SP_CONSOLE_PASSWORD || '';
      if (!isLocal && !pass) { sendError(req, res, 404, t('未找到 · Not found')); return true; }
      if (!isLocal) {
        const hdr = req.headers.authorization || '';
        const ok = (() => { const m = /^Basic (.+)$/i.exec(hdr); if (!m) return false;
          try { const [u, pw] = Buffer.from(m[1], 'base64').toString('utf8').split(':'); return u === 'strinova' && pw === pass; } catch { return false; } })();
        if (!ok) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="strinova console", charset="UTF-8"' }); res.end('401 · 需要登录'); return true; }
      }
    }
    if (p === '/console/api') {
      if (req.method === 'POST') { await consoleApiWrite(req, res, log); return true; }
      if (req.method === 'GET' || req.method === 'HEAD') { sendJson(req, res, 200, consoleApiRead()); return true; }
      res.setHeader('Allow', 'GET, HEAD, POST');
      sendError(req, res, 405, t('不支持的请求方法 · Method not allowed'));
      return true;
    }
    if (p === '/console/api/state') {
      if (req.method === 'GET' || req.method === 'HEAD') { sendJson(req, res, 200, consoleApiState(lobby)); return true; }
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, t('不支持的请求方法 · Method not allowed'));
      return true;
    }
    if (p === '/console/api/grant') {
      if (req.method === 'POST') { await consoleApiGrant(req, res, log, lobby); return true; }
      res.setHeader('Allow', 'POST');
      sendError(req, res, 405, t('不支持的请求方法 · Method not allowed'));
      return true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, t('不支持的请求方法 · Method not allowed'));
      return true;
    }
    let html = '';
    try { html = await fsp.readFile(path.join(publicDir, 'console.html'), 'utf8'); } catch { html = null; }
    if (html == null) { sendError(req, res, 500, t('控制台页面缺失 · console.html not found')); return true; }
    const body = Buffer.from(html);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
  // /lan/room — a guest sweeps its own /24 with the 4-letter key; answers yes/no + seat counts to private peers only.
  const code = String(new URLSearchParams(parts.query).get('code') || '').toUpperCase();
  const room = /^[A-Z0-9]{4}$/.test(code) ? lobby.getRoom(code) : null;
  if (!room || room.mode !== 'coop') { sendError(req, res, 404, t('未找到 · Not found')); return true; }
  sendJson(req, res, 200, {
    ok: true, code: room.code, mode: room.mode, difficulty: room.difficulty,
    seats: room.seats.length, humans: room.seats.filter((s) => s && !s.isBot).length, inMatch: !!room.match,
  });
  return true;
}
