// server/index.js — process entry & boot (DESIGN §1, §2).
//
//   * node:http static server:  /        → public/      (index.html for directories)
//                                /data/   → data/        (generated game data)
//                                /shared/ → shared/      (ESM shared with the browser)
//                                /sim/    → server/sim/  (the battle simulation, read-only, `.js` only — client-side
//                                                         combat, DESIGN §14; the Node-only loader nodeData.js is not served)
//                                /data.js → a generated browser stand-in of server/data.js (the sim's content modules
//                                           import `../../../data.js`; in the browser it serves the data injected with
//                                           /sim/simdata.js setSimData). No other server file is ever served.
//                                /media/bgm/act1 → public/assets/audio/bgm/act1.mp3 — the same audio files, addressed
//                                           **without** an extension so download managers (IDM / 迅雷 …) stop popping a
//                                           "下载文件信息" dialog for every BGM track (shared/media.js, public/js/media.js)
//     MIME types incl. .mjs/.js text/javascript, .skel application/octet-stream, .atlas text/plain;
//     gzip for text-like types, .skel and uncompressed fonts when the client accepts it (small files are
//     compressed once and cached in memory); strong ETag + Last-Modified with 304s; Cache-Control
//     (html & code/data: no-cache + revalidate; public/assets|fonts|vendor: 1 day; any `?v=` URL: immutable);
//     single byte-range requests (206/416, used by <audio>); traversal & dotfile protection; 404 page.
//   * GET /healthz → JSON status (protocol `version`, release `app`, rooms, matches, sessions, sockets).
//   * WebSocket (ws) at /ws, maxPayload 64 KB → server/net.js Network → server/lobby.js Lobby.
//   * Env: PORT (default 3000), HOST (default 0.0.0.0), TRUST_PROXY ('auto' default: honour CF-Connecting-IP /
//     X-Real-IP / X-Forwarded-For only from loopback/private peers such as a local cloudflared; '1' always; '0' never).
//     Prints LAN URLs on boot.
//   * Per-network limits for internet clients (see net.js clientAddress; local/LAN peers are exempt): open sockets
//     (maxConnectionsPerAddr, refused at upgrade with 429), rooms and running matches (lobby.js).
//   * Graceful shutdown on SIGINT/SIGTERM (rooms get room.closed{reason:'shutdown'}, sockets close 1001).
//
// Programmatic use (tests): `const srv = await startServer({ port: 0, quiet: true }); … await srv.close();`
// The server only auto-listens when this file is the process entry point.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Network, SessionRegistry, NET_DEFAULTS } from './net.js';
import { Lobby } from './lobby.js';
import { getData, loadData } from './data.js';
import { PROTOCOL_VERSION, APP_VERSION, PHASE, PHASE_NAMES, MAX_SEATS_LIMIT } from '../shared/constants.js';
import { MEDIA_PREFIX, AUDIO_EXTS } from '../shared/media.js';

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

/** Repository root. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Inbound WebSocket frame limit (DESIGN §8). */
export const WS_MAX_PAYLOAD = 64 * 1024;

/** /monitor dashboard: self-contained HTML, polls /monitor?json every 5 s. No game assets, no build step. */
const MONITOR_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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
<div class="stats" id="stats"></div>
<div id="rooms"></div>
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
        // 任何座位都可看（含 AI）——方便观察 bot 的商店/装备/摆阵来调甄选数值。
        const watchable = !!p.playerId;
        const btns = watchable
          ? '<a class="mon-btn" href="/?shadow=' + esc(r.code) + '&as=' + esc(p.playerId) + '" target="_blank" rel="noopener">观战</a>' +
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
// 事件委托：卡片上的「监看」按钮
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('.mon-btn');
  if (btn) { monWatch(btn.dataset.code, btn.dataset.pid, btn.dataset.name); return; }
  if (ev.target.closest('#watch-close')) monClose();
});
</script>
</body>
</html>`;

/** Browser stand-in of server/data.js, served at /data.js (see the header). */
export const DATA_SHIM_JS = `// Generated by server/index.js — browser stand-in for server/data.js (DESIGN §14 client-side combat).
// The simulation's content modules (/sim/content/support/index.js) import getData() from here; it returns the game data
// the page injected with /sim/simdata.js setSimData(data).
import { getSimData } from './sim/simdata.js';
export function getData() { return getSimData() || {}; }
export function resetData() {}
`;
/** Files under server/sim that are never served (Node-only). */
const SIM_PRIVATE = new Set(['nodedata.js']); // lower-case (compared case-insensitively)

/** Extension → Content-Type. */
export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.atlas': 'text/plain; charset=utf-8',
  '.skel': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
});

/** Extensions worth gzipping (text-like, .skel, uncompressed fonts). */
export const COMPRESSIBLE = new Set([
  '.html', '.htm', '.js', '.mjs', '.css', '.json', '.map', '.webmanifest', '.txt', '.md', '.csv', '.xml',
  '.atlas', '.skel', '.bin', '.wasm', '.svg', '.ico', '.otf', '.ttf', '.wav',
]);

const GZIP_MIN_BYTES = 512;
const GZIP_CACHE_MAX_FILE = 8 << 20;      // larger files are gzip-streamed on the fly
const GZIP_CACHE_MAX_TOTAL = 96 << 20;
// Asset URLs carry no content hash yet, and tools/fetch-assets.mjs / tools/vendor.mjs can rewrite files in
// place (atlas + png + skel must stay consistent), so "long" is one day; revalidation after that is a cheap 304.
const LONG_CACHE = 'public, max-age=86400';          // 1 day
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const LONG_CACHE_DIRS = ['assets', 'fonts', 'vendor']; // first path segment under public/
const MAX_URL_LENGTH = 4096;

// ---------------------------------------------------------------------------------------------------
// build tag — the "your page is stale" signal (public/js/ui/buildGuard.js)
// ---------------------------------------------------------------------------------------------------

/**
 * The files that make up the runtime the BROWSER loads. A change in any of them is a new build: an already-open page
 * keeps the modules it imported at load time (ES modules live in the page's module map for its whole lifetime), so
 * without this signal a deployed fix could never reach a player who does not reload — a client-only battle fix
 * shipped exactly that way and stayed invisible on a page that had been opened before the deploy.
 *
 * `server/`, `data/` and `shared/` are deliberately NOT in here: this process read them once at startup, so when they
 * change without a restart the server still runs the old simulation and data — a page that reloaded into the new files
 * would be out of step with the server that validates its battles (and DEPLOY.md restarts the server for every update).
 */
export const BUILD_INPUTS = Object.freeze(['public/index.html', 'public/js', 'public/css']);

/** Names the static server never serves: dot files (`.DS_Store`, `.main.js.swp`) and editor backups (`main.js~`). */
const isIgnoredBuildName = (name) => name.startsWith('.') || name.endsWith('~');

/** @type {{ tag: string|null }|null} */
let buildCache = null;

/** Every file under `abs` (or `abs` itself), as `[relative path, size, mtimeMs]`, sorted by path. Missing → []. */
function buildEntries(abs, rel, out) {
  let stat;
  try { stat = fs.statSync(abs); } catch { return; }
  if (stat.isFile()) { out.push([rel, stat.size, stat.mtimeMs]); return; }
  if (!stat.isDirectory()) return;
  let names;
  try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const d of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (isIgnoredBuildName(d.name)) continue;
    const child = path.join(abs, d.name);
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) buildEntries(child, childRel, out);
    else if (d.isFile()) { try { const s = fs.statSync(child); out.push([childRel, s.size, s.mtimeMs]); } catch { /* ignore */ } }
  }
}

/** Short hash of the served browser runtime (size + mtime of every BUILD_INPUTS file); null when nothing is readable. */
export function computeBuildTag(root = ROOT) {
  const out = [];
  for (const rel of BUILD_INPUTS) buildEntries(path.join(root, rel), rel, out);
  if (!out.length) return null;
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = createHash('sha1');
  for (const [rel, size, mtime] of out) h.update(`${rel}\0${size}\0${Math.floor(mtime)}\n`);
  return h.digest('hex').slice(0, 12);
}

/**
 * The build tag of THIS process. Computed once (`startServer` warms it at startup): the tag describes the files the
 * process is actually serving, every update restarts the server (DEPLOY.md), and re-reading the tree on a timer would
 * let a half-finished deploy — or a file that changed while the process kept running — move the tag under a page.
 * @param {string} [root] used by the first call only (tests)
 */
export function buildTag(root = ROOT) {
  if (buildCache === null) buildCache = { tag: computeBuildTag(root) };
  return buildCache.tag;
}

/** Drop the cache: the next `buildTag()` re-reads the tree (tests, and `startServer`). */
export function resetBuildTag() { buildCache = null; }

const gzipAsync = promisify(zlib.gzip);
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

// ---------------------------------------------------------------------------------------------------
// gzip cache (LRU by bytes)
// ---------------------------------------------------------------------------------------------------

class GzipCache {
  constructor(maxTotal = GZIP_CACHE_MAX_TOTAL) {
    this.maxTotal = maxTotal;
    this.total = 0;
    /** @type {Map<string, Buffer>} */ this.map = new Map();
    /** @type {Map<string, Promise<Buffer>>} */ this.inflight = new Map();
  }

  /** @returns {Promise<Buffer>} gzip of the file identified by (path, size, mtime) */
  get(absPath, stat) {
    const key = `${absPath}\0${stat.size}\0${stat.mtimeMs}`;
    const hit = this.map.get(key);
    if (hit) { this.map.delete(key); this.map.set(key, hit); return Promise.resolve(hit); }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      const raw = await fsp.readFile(absPath);
      const gz = await gzipAsync(raw, { level: 6 });
      this.store(key, gz);
      return gz;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  store(key, buf) {
    if (buf.length > this.maxTotal) return;
    this.map.set(key, buf);
    this.total += buf.length;
    for (const [k, v] of this.map) {
      if (this.total <= this.maxTotal) break;
      this.map.delete(k);
      this.total -= v.length;
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------------

/** Does the Accept-Encoding header allow gzip (q > 0)? @param {string | undefined} header */
export function acceptsGzip(header) {
  if (!header || typeof header !== 'string') return false;
  let gzipQ = null;
  let starQ = null;
  for (const part of header.split(',')) {
    const [token, ...params] = part.trim().toLowerCase().split(';');
    let q = 1;
    for (const p of params) {
      const m = /^\s*q=([0-9.]+)\s*$/.exec(p);
      if (m) q = Number(m[1]);
    }
    if (!Number.isFinite(q)) q = 0;
    if (token === 'gzip' || token === 'x-gzip') gzipQ = q;
    else if (token === '*') starQ = q;
  }
  if (gzipQ != null) return gzipQ > 0;
  return starQ != null && starQ > 0;
}

/**
 * Parse a single `bytes=` range against a file size.
 * @returns {{ start: number, end: number } | 'unsatisfiable' | null} null = ignore header (serve 200)
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header);
  if (!m) return null; // multi-range or malformed → ignore (RFC 9110 permits serving the full body)
  const [, a, b] = m;
  if (a === '' && b === '') return null;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(a);
  const end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  if (b !== '' && Number(b) < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end };
}

const stripWeak = (tag) => tag.trim().replace(/^W\//, '');

/** Conditional GET check (If-None-Match wins over If-Modified-Since). */
function isNotModified(req, etag, mtime) {
  const inm = req.headers['if-none-match'];
  if (typeof inm === 'string') {
    if (inm.trim() === '*') return true;
    return inm.split(',').some((t) => stripWeak(t) === etag);
  }
  const ims = req.headers['if-modified-since'];
  if (typeof ims === 'string') {
    const t = Date.parse(ims);
    if (Number.isFinite(t)) return Math.floor(mtime.getTime() / 1000) * 1000 <= t;
  }
  return false;
}

/** If-Range: serve the range only when the validator still matches. */
function ifRangeMatches(req, etag, lastModified) {
  const v = req.headers['if-range'];
  if (typeof v !== 'string') return true;
  const s = v.trim();
  if (s.startsWith('"') || s.startsWith('W/')) return s === etag; // strong comparison
  return s === lastModified;
}

function cacheControlFor(ext, mountName, segments, query) {
  if (ext === '.html' || ext === '.htm') return 'no-cache';
  if (/(^|&)v=/.test(query)) return IMMUTABLE_CACHE;
  if (mountName === 'public' && segments.length > 1 && LONG_CACHE_DIRS.includes(segments[0])) return LONG_CACHE;
  return 'no-cache';
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function errorPage(status, title, detail = '') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${status} · 卫戍协议：盟约</title><style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111614;color:#d8e3de;font:16px/1.6 "Noto Sans SC",system-ui,sans-serif}
main{border:1px solid #2c3a35;padding:32px 40px;max-width:520px;text-align:center}h1{margin:0;color:#4ed8af;font-size:56px;letter-spacing:4px}
p{margin:8px 0}a{color:#4ed8af}</style></head><body><main><h1>${status}</h1><p>${escapeHtml(title)}</p>
${detail ? `<p style="opacity:.6">${escapeHtml(detail)}</p>` : ''}<p><a href="/">返回首页 · Back to home</a></p></main></body></html>`;
}

/**
 * Whether a socket peer is this machine or a private network. `/lan/room` answers only to these, so a client
 * reaching the server through a tunnel or a public interface cannot probe which room codes exist.
 */
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

function sendError(req, res, status, title, detail) {
  if (res.headersSent) { res.destroy(); return; }
  const body = Buffer.from(errorPage(status, title, detail));
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendJson(req, res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

/** Split an absolute request URL into raw path + query (also accepts absolute-form URLs). */
function splitUrl(url) {
  let u = url || '/';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try { const parsed = new URL(u); u = parsed.pathname + parsed.search; } catch { return null; }
  }
  const q = u.indexOf('?');
  const hashless = (s) => { const h = s.indexOf('#'); return h >= 0 ? s.slice(0, h) : s; };
  return q >= 0 ? { rawPath: hashless(u.slice(0, q)), query: hashless(u.slice(q + 1)) } : { rawPath: hashless(u), query: '' };
}

// ---------------------------------------------------------------------------------------------------
// Static file handler
// ---------------------------------------------------------------------------------------------------

/**
 * Create the static request handler.
 * @param {{ publicDir: string, dataDir: string, sharedDir: string, simDir?: string, log?: object }} dirs
 * @returns {(req: http.IncomingMessage, res: http.ServerResponse, rawPath: string, query: string) => Promise<void>}
 */
/** Optional per-machine art manifest (tools/local-extract) and the empty stand-in served when it is absent. */
const LOCAL_ART_MANIFEST = 'local-assets.json';
const EMPTY_LOCAL_ART = Buffer.from(JSON.stringify({ version: 1, source: 'none', count: 0, groups: {} }));

export function createStaticHandler({ publicDir, dataDir, sharedDir, simDir = path.join(ROOT, 'server', 'sim'), log = noopLog }) {
  const mounts = [
    { prefix: '/data/', name: 'data', dir: path.resolve(dataDir) },
    { prefix: '/shared/', name: 'shared', dir: path.resolve(sharedDir) },
    // the simulation: ES modules only (no directory listings, no other file types, no Node-only loader)
    { prefix: '/sim/', name: 'sim', dir: path.resolve(simDir), only: new Set(['.js']), deny: SIM_PRIVATE },
    { prefix: '/', name: 'public', dir: path.resolve(publicDir) },
  ];
  const shimBody = Buffer.from(DATA_SHIM_JS);
  const shimTag = `"shim-${shimBody.length.toString(16)}"`;
  const gzipCache = new GzipCache();

  return async function serveStatic(req, res, rawPath, query) {
    let decoded;
    try { decoded = decodeURIComponent(rawPath); } catch { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) {
      sendError(req, res, 400, '请求地址无效 · Bad request');
      return;
    }
    if (decoded === '/data.js') {
      const headers = { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache', ETag: shimTag, 'Content-Length': shimBody.length };
      if (isNotModified(req, shimTag, new Date(0))) { delete headers['Content-Length']; res.writeHead(304, headers); res.end(); return; }
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : shimBody);
      return;
    }
    if (decoded === '/sim/simdata.js') {
      try {
        const rawCode = await fsp.readFile(path.join(simDir, 'simdata.js'), 'utf8');
        // Strip Node-only top-level await block so Chrome < 89 (e.g. Chrome 80-88 WebView) parses cleanly without 'Unexpected reserved word'
        const browserCode = rawCode.replace(/if\s*\(\s*IS_NODE\s*\)\s*\{[\s\S]*?\n\}/, '/* browser: nodeLoader omitted (setSimData injects data) */');
        const bBody = Buffer.from(browserCode);
        const bTag = `"simdata-${bBody.length.toString(16)}"`;
        const headers = { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache', ETag: bTag, 'Content-Length': bBody.length };
        if (isNotModified(req, bTag, new Date(0))) { delete headers['Content-Length']; res.writeHead(304, headers); res.end(); return; }
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : bBody);
        return;
      } catch (err) {
        log.warn?.('[static] failed to serve browser simdata', err);
      }
    }
    // Extension-less audio (download-manager avoidance): /media/bgm/act1 → /assets/audio/bgm/act1.mp3
    if (decoded.startsWith(MEDIA_PREFIX)) {
      await serveMedia(req, res, decoded.slice(MEDIA_PREFIX.length), query, publicDir, gzipCache, log);
      return;
    }
    // Bare mount paths (e.g. "/data") → treat as the mount directory.
    const mount = mounts.find((m) => decoded.startsWith(m.prefix) || decoded === m.prefix.slice(0, -1)) || mounts[mounts.length - 1];
    const rest = decoded.length > mount.prefix.length ? decoded.slice(mount.prefix.length) : '';
    const segments = rest.split('/').filter((s) => s.length > 0);
    if (segments.some((s) => s === '..' || s === '.')) { sendError(req, res, 403, '禁止访问 · Forbidden'); return; }
    if (segments.some((s) => s.startsWith('.'))) { sendError(req, res, 404, '页面不存在 · Not found'); return; }
    if (mount.only && (!segments.length || !mount.only.has(path.extname(segments[segments.length - 1]).toLowerCase())
      // (case-insensitive: the host may be Windows / macOS, where NODEDATA.JS opens nodeData.js)
      || (mount.deny && mount.deny.has(segments[segments.length - 1].toLowerCase())))) {
      sendError(req, res, 404, '页面不存在 · Not found');
      return;
    }
    let absPath = path.join(mount.dir, ...segments);
    if (absPath !== mount.dir && !absPath.startsWith(mount.dir + path.sep)) { sendError(req, res, 403, '禁止访问 · Forbidden'); return; }

    let stat;
    let viaDirectory = false;
    try {
      stat = await fsp.stat(absPath);
      if (stat.isDirectory()) {
        if (!decoded.endsWith('/')) {
          // Built from normalized segments (never from the raw path) so "//host" can't become an open redirect.
          const loc = (mount.prefix + segments.map(encodeURIComponent).join('/') + '/').replace(/\/{2,}/g, '/');
          res.writeHead(301, { Location: loc + (query ? `?${query}` : ''), 'Cache-Control': 'no-cache', 'Content-Length': 0 });
          res.end();
          return;
        }
        absPath = path.join(absPath, 'index.html');
        segments.push('index.html');
        viaDirectory = true;
        stat = await fsp.stat(absPath);
      }
      // Not a regular file, or a file addressed like a directory ("/app.js/") → 404.
      if (!stat.isFile() || (decoded.endsWith('/') && !viaDirectory)) {
        throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
      }
      if (mount.deny) {
        // the on-disk name decides (case-insensitive file systems, Windows 8.3 short names like NODEDA~1.JS)
        const real = await fsp.realpath(absPath);
        if (mount.deny.has(path.basename(real).toLowerCase())) throw Object.assign(new Error('private'), { code: 'ENOENT' });
      }
    } catch (e) {
      if (e && e.code === 'ENOENT' && mount.name === 'data' && segments.length === 1 && segments[0] === LOCAL_ART_MANIFEST) {
        // Optional local-client art (DESIGN §13): an install without it gets an empty manifest instead of a 404,
        // so browsers don't log an error on every page load. Clients treat empty groups as "no local art".
        res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-cache', 'Content-Length': EMPTY_LOCAL_ART.length });
        res.end(req.method === 'HEAD' ? undefined : EMPTY_LOCAL_ART);
      } else if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR' || e.code === 'EISDIR' || e.code === 'ENAMETOOLONG')) {
        sendError(req, res, 404, '页面不存在 · Not found', decoded.length <= 200 ? decoded : '');
      } else if (e && (e.code === 'EACCES' || e.code === 'EPERM')) {
        sendError(req, res, 403, '禁止访问 · Forbidden');
      } else {
        log.error('[http] stat failed', e);
        sendError(req, res, 500, '服务器内部错误 · Internal error');
      }
      return;
    }
    await serveFile(req, res, absPath, stat, mount.name, segments, query, gzipCache, log);
  };
}

/**
 * Extension-less audio route: `/media/bgm/act1` → `public/assets/audio/bgm/act1.mp3`.
 *
 * Clients ask for audio through this path because download managers (IDM, 迅雷, FDM …) hijack XHR/fetch whose
 * URL ends in a media extension and pop a "下载文件信息" dialog for every BGM track — see `public/js/media.js`.
 * Requests for the direct `/assets/audio/…` URLs keep working (they are the fallback for plain static hosts).
 * `MEDIA_PREFIX` / `AUDIO_EXTS` live in `shared/media.js`: the browser decides which URLs to rewrite with the
 * same two values, and they must not drift apart.
 */
async function serveMedia(req, res, rest, query, publicDir, gzipCache, log) {
  const root = path.join(path.resolve(publicDir), 'assets', 'audio');
  const segments = String(rest || '').split('/').filter((s) => s.length > 0);
  if (!segments.length || rest.endsWith('/')) { sendError(req, res, 404, '页面不存在 · Not found'); return; }
  if (segments.some((s) => s === '..' || s === '.')) { sendError(req, res, 403, '禁止访问 · Forbidden'); return; }
  // A leading or trailing dot would address something else (dotfiles, "x..mp3") — and the client never asks for it.
  if (segments.some((s) => s.startsWith('.') || s.endsWith('.'))) { sendError(req, res, 404, '页面不存在 · Not found'); return; }

  const last = segments[segments.length - 1];
  const given = path.extname(last).toLowerCase();
  const wanted = AUDIO_EXTS.includes(given) ? given : '';
  const stem = wanted ? last.slice(0, -wanted.length) : last;
  if (!stem || stem.startsWith('.')) { sendError(req, res, 404, '页面不存在 · Not found'); return; }
  const dir = path.join(root, ...segments.slice(0, -1));
  if (dir !== root && !dir.startsWith(root + path.sep)) { sendError(req, res, 403, '禁止访问 · Forbidden'); return; }

  // An explicit extension wins (`/media/bgm.ogg` → bgm.ogg), otherwise the usual order decides.
  const order = wanted ? [wanted, ...AUDIO_EXTS.filter((e) => e !== wanted)] : AUDIO_EXTS;
  for (const ext of order) {
    const absPath = path.join(dir, stem + ext);
    if (!absPath.startsWith(root + path.sep)) continue;
    let stat;
    try {
      // eslint-disable-next-line no-await-in-loop
      stat = await fsp.stat(absPath);
    } catch { continue; }
    if (!stat.isFile()) continue;
    // serveFile decides Content-Type from the resolved name (`.mp3` → audio/mpeg) — Range/ETag handling is shared.
    // Cache policy is that of the public path the client would otherwise have asked for (`/assets/audio/…`, 1 day).
    // eslint-disable-next-line no-await-in-loop
    await serveFile(req, res, absPath, stat, 'public', ['assets', 'audio', ...segments], query, gzipCache, log);
    return;
  }
  sendError(req, res, 404, '页面不存在 · Not found');
}

async function serveFile(req, res, absPath, stat, mountName, segments, query, gzipCache, log) {
  const ext = path.extname(absPath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const compressible = COMPRESSIBLE.has(ext);
  const rangeHeader = req.headers.range;
  const useGzip = compressible && stat.size >= GZIP_MIN_BYTES && !rangeHeader && acceptsGzip(req.headers['accept-encoding']);
  const baseTag = `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}`;
  const etag = `"${baseTag}${useGzip ? '-gz' : ''}"`;
  const lastModified = stat.mtime.toUTCString();
  const isHead = req.method === 'HEAD';

  const headers = {
    'Content-Type': type,
    'Cache-Control': cacheControlFor(ext, mountName, segments, query),
    ETag: etag,
    'Last-Modified': lastModified,
  };
  if (compressible) headers.Vary = 'Accept-Encoding';

  if (isNotModified(req, etag, stat.mtime)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  if (useGzip) {
    headers['Content-Encoding'] = 'gzip';
    if (stat.size <= GZIP_CACHE_MAX_FILE) {
      const gz = await gzipCache.get(absPath, stat);
      headers['Content-Length'] = gz.length;
      res.writeHead(200, headers);
      res.end(isHead ? undefined : gz);
      return;
    }
    res.writeHead(200, headers);
    if (isHead) { res.end(); return; }
    await streamTo(fs.createReadStream(absPath), res, log, zlib.createGzip());
    return;
  }

  headers['Accept-Ranges'] = 'bytes';
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (rangeHeader && ifRangeMatches(req, etag, lastModified)) {
    const r = parseRange(rangeHeader, stat.size);
    if (r === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}`, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 0 });
      res.end();
      return;
    }
    if (r) {
      ({ start, end } = r);
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
  }
  headers['Content-Length'] = stat.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (isHead || stat.size === 0) { res.end(); return; }
  await streamTo(fs.createReadStream(absPath, { start, end }), res, log);
}

async function streamTo(src, res, log, transform) {
  try {
    if (transform) await pipeline(src, transform, res);
    else await pipeline(src, res);
  } catch (e) {
    if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') log.debug?.('[http] stream aborted', e.code || e.message);
    res.destroy();
  }
}

// ---------------------------------------------------------------------------------------------------
// Server assembly
// ---------------------------------------------------------------------------------------------------

/** Non-internal IPv4 addresses as http URLs. @param {number} port */
export function lanUrls(port) {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(`http://${a.address}:${port}`);
    }
  }
  return out;
}

/** TRUST_PROXY env → net.js trustProxy ('auto' unless explicitly on/off). @param {string | undefined} v */
export function parseTrustProxy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'always'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'never'].includes(s)) return false;
  return 'auto';
}

function makeLogger(quiet) {
  if (quiet) return noopLog;
  return {
    info: (...a) => console.log(...a),
    warn: (...a) => console.warn(...a),
    error: (...a) => console.error(...a),
    debug: process.env.DEBUG ? (...a) => console.debug(...a) : () => {},
  };
}

/**
 * Build and start the HTTP + WebSocket server.
 * @param {{
 *   port?: number, host?: string, quiet?: boolean, log?: object,
 *   publicDir?: string, dataDir?: string, sharedDir?: string,
 *   MatchClass?: Function, seedFn?: () => number,
 *   lobbyGraceMs?: number, reconnectWindowMs?: number, heartbeatMs?: number, helloTimeoutMs?: number,
 *   ratePerSec?: number, rateBurst?: number, maxConnections?: number, maxRooms?: number,
 *   maxConnectionsPerAddr?: number, maxRoomsPerAddr?: number, maxMatchesPerAddr?: number, resyncMinGapMs?: number,
 *   heavyPerSec?: number, heavyBurst?: number, trustProxy?: 'auto' | boolean, soloReconnectWindowMs?: number,
 * }} [opts]
 * @returns {Promise<{ port: number, host: string, url: string, server: http.Server, wss: WebSocketServer,
 *                     lobby: Lobby, network: Network, registry: SessionRegistry, close: () => Promise<void> }>}
 */
export async function startServer(opts = {}) {
  const port = opts.port ?? (process.env.PORT != null && process.env.PORT !== '' ? Number(process.env.PORT) : 3000);
  const host = opts.host ?? process.env.HOST ?? '0.0.0.0';
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError(`invalid PORT ${port}`);
  const log = opts.log || makeLogger(!!opts.quiet);
  const publicDir = opts.publicDir || path.join(ROOT, 'public');
  const dataDir = opts.dataDir || path.join(ROOT, 'data');
  const sharedDir = opts.sharedDir || path.join(ROOT, 'shared');

  // The process-wide singleton serves the default data dir; a custom dir (tests) gets its own copy.
  const data = opts.dataDir ? loadData(dataDir, { log }) : getData({ dir: dataDir, log });
  const netOptions = {};
  for (const k of ['reconnectWindowMs', 'heartbeatMs', 'helloTimeoutMs', 'ratePerSec', 'rateBurst', 'maxConnections', 'abuseDropsPerSec',
    'maxConnectionsPerAddr', 'heavyPerSec', 'heavyBurst', 'trustProxy']) {
    if (opts[k] != null) netOptions[k] = opts[k];
  }
  if (netOptions.trustProxy == null) netOptions.trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
  const registry = new SessionRegistry({ reconnectWindowMs: netOptions.reconnectWindowMs ?? NET_DEFAULTS.reconnectWindowMs });
  const lobbyOptions = {};
  for (const k of ['lobbyGraceMs', 'maxRooms', 'maxRoomsPerAddr', 'maxMatchesPerAddr', 'resyncMinGapMs', 'soloReconnectWindowMs']) {
    if (opts[k] != null) lobbyOptions[k] = opts[k];
  }
  // Co-op seats (SP_MAX_SEATS=6): the seat-derived protocol bounds (setSeatLimit) and the client's seat grid
  // (room.state.maxSeats) follow this same value, so ≤4 stays exactly the original game.
  if (opts.maxSeats != null) lobbyOptions.maxSeats = opts.maxSeats;
  else if (process.env.SP_MAX_SEATS != null && process.env.SP_MAX_SEATS !== '') {
    const n = Number(process.env.SP_MAX_SEATS);
    if (!Number.isInteger(n) || n < 2 || n > MAX_SEATS_LIMIT) {
      throw new RangeError(`invalid SP_MAX_SEATS ${process.env.SP_MAX_SEATS} (an integer 2..${MAX_SEATS_LIMIT}; leave unset for 4)`);
    }
    lobbyOptions.maxSeats = n;
  }
  const lobby = new Lobby({ registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, options: lobbyOptions });
  const network = new Network({ registry, handler: lobby, log, options: netOptions });
  const serveStatic = createStaticHandler({ publicDir, dataDir, sharedDir, log });
  const startedAt = Date.now();
  // The tag is per process (see buildTag): read the browser runtime once, here, not on every /healthz.
  resetBuildTag();
  buildTag();

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  });

  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === '/healthz') {
      sendJson(req, res, 200, {
        ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
        // older than this reloads itself, so a deploy reaches clients that never reload
        build: buildTag(),
        sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
      });
      return;
    }
    if (parts.rawPath === '/monitor') {
      if (parts.query === 'json' || parts.query.startsWith('json&') || new URLSearchParams(parts.query).has('json')) {
        sendJson(req, res, 200, monitorSnapshot(lobby, network.connectionCount)); return;
      }
      const snap = JSON.stringify(monitorSnapshot(lobby, network.connectionCount)).replace(/</g, '\\u003c');
      const html = MONITOR_HTML
        .replace('__INITIAL__', snap)
        .replace('__PHASE_NAMES__', JSON.stringify(PHASE_NAMES));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    // LAN room probe, so a guest can join with only the 4-letter key: the phone sweeps its own /24 and asks each
    // server it finds whether that room is open. It answers with a yes/no plus seat counts — never a room list, and
    // nothing at all to a peer outside the private ranges, so a public or tunnelled client cannot enumerate codes.
    if (parts.rawPath === '/lan/room') {
      if (!isPrivateAddress(req.socket?.remoteAddress)) { sendError(req, res, 404, '未找到 · Not found'); return; }
      const code = String(new URLSearchParams(parts.query).get('code') || '').toUpperCase();
      const room = /^[A-Z0-9]{4}$/.test(code) ? lobby.getRoom(code) : null;
      if (!room || room.mode !== 'coop') { sendError(req, res, 404, '未找到 · Not found'); return; }
      sendJson(req, res, 200, {
        ok: true, code: room.code, mode: room.mode, difficulty: room.difficulty,
        seats: room.seats.length, humans: room.seats.filter((s) => s && !s.isBot).length, inMatch: !!room.match,
      });
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  server.on('clientError', (err, socket) => {
    if (err && err.code === 'ECONNRESET') { socket.destroy(); return; }
    try {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      else socket.destroy();
    } catch { /* ignore */ }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_PAYLOAD, perMessageDeflate: false, clientTracking: false });
  wss.on('connection', (ws, req) => network.handleConnection(ws, req));
  wss.on('error', (e) => log.error('[ws] server error', e));

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const parts = splitUrl(req.url || '/');
    const reject = (status, text) => {
      try { socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { socket.destroy(); }
    };
    if (!parts || parts.rawPath !== '/ws') { reject(404, 'Not Found'); return; }
    const refused = network.admission(req);
    if (refused === 'per-address') { reject(429, 'Too Many Requests'); return; }
    if (refused) { reject(503, 'Service Unavailable'); return; }
    try {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } catch (e) {
      log.error('[ws] upgrade failed', e);
      socket.destroy();
    }
  });

  try {
    await new Promise((resolve, reject) => {
      const onError = (e) => { server.off('listening', onListening); reject(e); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  } catch (e) {
    network.close(); // stop heartbeat/sweep timers of the half-built server
    throw e;
  }
  server.on('error', (e) => log.error('[http] server error', e));

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host === '0.0.0.0' || host === '::' ? 'localhost' : host}:${actualPort}`;

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      try { lobby.shutdown('shutdown'); } catch (e) { log.error('[shutdown] lobby', e); }
      network.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections?.();
        setTimeout(() => { server.closeAllConnections?.(); }, 500).unref();
      });
      try { wss.close(); } catch { /* ignore */ }
    })();
    return closing;
  }

  return { port: actualPort, host, url, server, wss, lobby, network, registry, close };
}

// ---------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main() {
  process.on('unhandledRejection', (e) => console.error('[process] unhandled rejection', e));
  process.on('uncaughtException', (e) => console.error('[process] uncaught exception', e));
  let srv;
  try {
    srv = await startServer();
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') console.error(`端口已被占用 / port in use: ${e.port ?? process.env.PORT ?? 3000}. Try PORT=3001 npm start`);
    else console.error('[boot] failed to start', e);
    process.exit(1);
  }
  console.log(`\n  卫戍协议：盟约 · Stronghold Protocol: Alliance v${APP_VERSION}`);
  console.log(`  Local:   ${srv.url}`);
  if (srv.host === '0.0.0.0' || srv.host === '::') {
    for (const u of lanUrls(srv.port)) console.log(`  LAN:     ${u}`);
  }
  console.log('  Internet: cloudflared tunnel --url ' + `http://localhost:${srv.port}` + '\n');

  let stopping = false;
  const stop = (signal) => {
    if (stopping) { console.log('forced exit'); process.exit(1); }
    stopping = true;
    console.log(`\n[${signal}] shutting down…`);
    setTimeout(() => process.exit(0), 5000).unref();
    srv.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

if (isMain()) main();
