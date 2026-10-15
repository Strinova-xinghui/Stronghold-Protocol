// server/http/musicRoutes.js — 自研音乐播放器的服务器代理（2026-10-15）。
// 职责边界（用户约束：不给服务器带来过分的性能/带宽开销）：
//   * 只代理塞壬唱片的 JSON API（/api/albums、/api/album/:cid/detail、/api/song/:cid）——元数据合计几十 KB；
//   * 音频（res*.hycdn.cn）与封面（web.hycdn.cn）CORS=* 且支持 Range ⇒ 客户端直连 CDN，服务器零带宽；
//   * 外置音源（lx-music 脚本）的第三方请求默认在浏览器直发；CORS 失败时由 /music/proxy 兜底转发（仅 JSON/小体）。
// 缓存：磁盘 .cache/music/{albums|album:<cid>|song:<cid>}.json，TTL 24 h；命中零外网、零解码。
// 路由由 server/http/routes.js 在静态服务前调用（自研钩子，与 customRoutes 同模式）。
// (i18n-ignore-file: developer logs / error strings in English are fine here)

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sendJson } from './common.js';

const SIREN = 'https://monster-siren.hypergryph.com/api';
const CACHE_DIR = path.resolve('.cache', 'music');
const TTL_MS = 24 * 3600 * 1000;
const FETCH_TIMEOUT_MS = 12000;
const PROXY_MAX_BODY = 512 * 1024;

/** 允许代理的白名单路径（严格匹配，绝不开放任意 URL）。 */
const ALLOWED = [
  { re: /^\/albums$/, key: 'albums' },
  { re: /^\/album\/([A-Za-z0-9_-]{1,32})\/detail$/, key: (m) => 'album:' + m[1] },
  { re: /^\/song\/([A-Za-z0-9_-]{1,32})$/, key: (m) => 'song:' + m[1] },
];

async function readCache(key) {
  try {
    const st = await fsp.stat(path.join(CACHE_DIR, key + '.json'));
    if (Date.now() - st.mtimeMs > TTL_MS) return null;
    const raw = await fsp.readFile(path.join(CACHE_DIR, key + '.json'), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function writeCache(key, data) {
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    const tmp = path.join(CACHE_DIR, key + '.json.tmp');
    await fsp.writeFile(tmp, JSON.stringify(data));
    await fsp.rename(tmp, path.join(CACHE_DIR, key + '.json'));
  } catch { /* cache is best-effort */ }
}

/** 取一个塞壬 API 的 JSON（缓存优先；失败只回错误帧，绝不抛）。 */
async function sirenFetch(sub, log) {
  for (const a of ALLOWED) {
    const m = a.re.exec(sub);
    if (!m) continue;
    const key = typeof a.key === 'function' ? a.key(m) : a.key;
    const hit = await readCache(key);
    if (hit) return { ok: true, data: hit, cached: true };
    try {
      const r = await fetch(SIREN + sub, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': 'stronghold-protocol-music/1.0' } });
      if (!r.ok) return { ok: false, status: r.status };
      const data = await r.json();
      await writeCache(key, data);
      return { ok: true, data, cached: false };
    } catch (e) {
      log?.warn?.('[music] siren fetch failed ' + sub + ': ' + (e && e.message));
      return { ok: false, status: 502 };
    }
  }
  return { ok: false, status: 404 };
}

/**
 * 自研音乐路由。true = 已处理。
 * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
 * @param {{ rawPath: string, query: string }} parts @param {{ warn?: Function }} log
 * @param {boolean} musicEnabled config/custom-rules.json music.enabled（关掉 = 404，原版行为）
 */
export async function handleMusicRoutes(req, res, parts, log, musicEnabled) {
  const p = parts.rawPath;
  if (!musicEnabled) return false;
  if (p === '/music/siren' || p.startsWith('/music/siren/')) {
    const sub = p.slice('/music/siren'.length) || '/';
    const r = await sirenFetch(sub, log);
    if (!r.ok) { sendJson(req, res, r.status || 502, { code: -1, msg: 'music api unavailable' }); return true; }
    sendJson(req, res, 200, r.data, { 'Cache-Control': 'public, max-age=3600' });
    return true;
  }
  if (p === '/music/proxy') {
    // lx 脚本 CORS 兜底：只允许 http(s) URL，且仅转发 JSON/文本（音频一律拒绝——CDN 直连即可）
    const u = new URL('http://x' + (parts.query || ''));
    const target = u.searchParams.get('url') || '';
    if (!/^https?:\/\//.test(target)) { sendJson(req, res, 400, { error: 'bad url' }); return true; }
    try {
      const rr = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const ct = rr.headers.get('content-type') || '';
      if (!/json|text|xml|javascript|urlencoded/i.test(ct)) { sendJson(req, res, 415, { error: 'only json/text' }); return true; }
      const buf = await rr.arrayBuffer();
      if (buf.byteLength > PROXY_MAX_BODY) { sendJson(req, res, 413, { error: 'too large' }); return true; }
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(Buffer.from(buf));
    } catch (e) {
      log?.warn?.('[music] proxy failed: ' + (e && e.message));
      sendJson(req, res, 502, { error: 'proxy failed' });
    }
    return true;
  }
  return false;
}