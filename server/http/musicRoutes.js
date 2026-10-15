// server/http/musicRoutes.js — 自研音乐播放器的服务器代理（2026-10-15）。
// 职责边界（用户约束：不给服务器带来过分的性能/带宽开销）：
//   * 只代理塞壬唱片的 JSON API（/api/albums、/api/album/:cid/detail、/api/song/:cid、/api/search）——元数据合计几十 KB；
//   * 音频（res*.hycdn.cn）与封面（web.hycdn.cn）CORS=* 且支持 Range ⇒ 客户端直连 CDN，服务器零带宽；
//   * 外部音源（lx-music 脚本）与 /music/proxy 已于 2026-10-16 移除（用户决定），本路由只剩塞壬元数据代理。
// 缓存：磁盘 .cache/music/{key}.json。albums/album 24 h；song 1 h（sourceUrl 是官方 CDN 的限时签名地址，
// 路径第二段 hex 即签发后约 3 h 的到期时刻，缓存过久会让浏览器直连音频时 403/404）；search 10 min。
// 路由由 server/http/routes.js 在静态服务前调用（自研钩子，与 customRoutes 同模式）。
// (i18n-ignore-file: developer logs / error strings in English are fine here)

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sendJson } from './common.js';

const SIREN = 'https://monster-siren.hypergryph.com/api';
const CACHE_DIR = path.resolve('.cache', 'music');
const TTL_META = 24 * 3600 * 1000;   // 专辑列表 / 专辑详情：几乎不变
const TTL_SONG = 3600 * 1000;        // 单曲：内含限时签名音频地址
const TTL_SEARCH = 10 * 60 * 1000;   // 搜索：临时结果，别把用户输入堆满磁盘
const FETCH_TIMEOUT_MS = 12000;


/** 允许代理的白名单路径（严格匹配，绝不开放任意 URL；query 单独走 search）。 */
const ALLOWED = [
  { re: /^\/albums$/, key: () => 'albums', ttl: TTL_META },
  // 上游只有 /album/:cid/detail；早期客户端写过 /album/:cid ⇒ 两种形态都收（同一份缓存），互不打架
  { re: /^\/album\/([A-Za-z0-9_-]{1,32})(?:\/detail)?$/, key: (m) => 'album:' + m[1], ttl: TTL_META },
  { re: /^\/song\/([A-Za-z0-9_-]{1,32})$/, key: (m) => 'song:' + m[1], ttl: TTL_SONG },
  { re: /^\/search$/, key: (m, q) => 'search:' + crypto.createHash('sha1').update(q).digest('hex').slice(0, 16), ttl: TTL_SEARCH },
];

function cacheFile(key) {
  // key 由白名单生成；再剥一次非安全字符（绝不拼出目录穿越）。冒号必须换掉：
  // Windows 上 "album:8913.json" 会被解释成文件 "album" 的交替数据流，缓存静默失效。
  const safe = String(key).replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(CACHE_DIR, safe + '.json');
}

async function readCache(key, ttl) {
  try {
    const f = cacheFile(key);
    const st = await fsp.stat(f);
    if (Date.now() - st.mtimeMs > ttl) return null;
    return JSON.parse(await fsp.readFile(f, 'utf8'));
  } catch { return null; }
}

async function writeCache(key, data) {
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    const f = cacheFile(key);
    const tmp = f + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data));
    await fsp.rename(tmp, f);
  } catch { /* cache is best-effort */ }
}

/** 取一个塞壬 API 的 JSON（缓存优先；失败只回错误帧，绝不抛）。 */
async function sirenFetch(sub, query, log) {
  for (const a of ALLOWED) {
    const m = a.re.exec(sub);
    if (!m) continue;
    const key = a.key(m, query || '');
    const hit = await readCache(key, a.ttl);
    if (hit) return { ok: true, data: hit, cached: true };
    // search：关键字必须来自 query（keyword=），只取白名单参数，绝不透传任意串
    let url = SIREN + sub;
    if (sub === '/search') {
      const u = new URL('http://x/?' + (query || ''));
      const kw = String(u.searchParams.get('kw') || '').trim().slice(0, 64);
      if (!kw) return { ok: false, status: 400 };
      url = SIREN + '/search?keyword=' + encodeURIComponent(kw);
    }
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { 'User-Agent': 'stronghold-protocol-music/1.0' } });
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
    const r = await sirenFetch(sub, parts.query, log);
    if (!r.ok) { sendJson(req, res, r.status || 502, { code: -1, msg: 'music api unavailable' }); return true; }
    sendJson(req, res, 200, r.data, { 'Cache-Control': sub === '/search' ? 'no-store' : 'public, max-age=3600' });
    return true;
  }
  return false;
}
