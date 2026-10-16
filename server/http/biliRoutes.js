// server/http/biliRoutes.js — 本地分支专用：Bilibili 音频经服务器中转（player/external-sources，2026-10-16）。
// 背景（见 docs/BILI-SOURCE-RESEARCH.md §3）：B 站 CDN 对音频直链做全域 Referer 锁
//   （无 Referer/错域 = 403，仅 bilibili.com 域 = 206），浏览器媒体元素伪造不出该头 ⇒ 网页直连结构性不可行。
// 本路由只在本地分支跑（家宽免费流量；分支永不部署云端，云端带宽红线不适用）。
// 端点（全部 GET，同源，走 music.enabled 总开关）：
//   /music/bili/info?url=<BV/av/b23/播放页链接>  → 元数据 JSON（view 接口，缓存 1h）
//   /music/bili/search?kw=&page=               → 视频搜索列表 JSON（缓存 5min；实测免 wbi 免 cookie 可用）
//   /music/bili/audio?bvid=&p=                 → playurl(fnval=0) 取 durl mp4 → 服务器带 Referer 拉流转发（≤50MB）
// API 知识来源：SocialSisterYi/bilibili-API-collect（文档事实）+ lx-music-desktop-enhanced（Apache-2.0）的
//   UA/Referer/档位常量；本文件为独立实现。禁止注入用户任意头；仅白名单两个 B 站公开端点 + 一条 CDN 转发。
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sendJson } from './common.js';

const BILI_API = 'https://api.bilibili.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';
const CACHE_DIR = path.resolve('.cache', 'music', 'bili');
const TTL_META = 3600 * 1000;    // view 元数据 1h（cid 稳定）
const TTL_SEARCH = 5 * 60 * 1000; // 搜索 5min
const API_TIMEOUT = 12 * 1000;
const DL_TIMEOUT = 60 * 1000;     // 音频下载整体（含首字节等待）
const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // 50MB 硬上限（用户批准的中转范围）
const BV_RE = /^(BV[0-9A-Za-z]{5,15}|av\d{1,17})$/;

const safeKey = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 20);
async function cacheGet(key, ttl) {
  try {
    const f = path.join(CACHE_DIR, key + '.json');
    const st = await fsp.stat(f);
    if (Date.now() - st.mtimeMs > ttl) return null;
    return JSON.parse(await fsp.readFile(f, 'utf8'));
  } catch { return null; }
}
async function cachePut(key, data) {
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    const f = path.join(CACHE_DIR, key + '.json');
    await fsp.writeFile(f + '.tmp', JSON.stringify(data));
    await fsp.rename(f + '.tmp', f);
  } catch { /* best-effort */ }
}
function stripHtml(s) { return String(s || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<'); }

/** 从任意输入提取 BV/av id；b23.tv 短链跟一次 302（只信任最终 bilibili.com/video/ 路径）。 */
async function resolveId(raw) {
  const text = String(raw || '').trim();
  if (BV_RE.test(text)) return text;
  let u; try { u = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : 'https://' + text); } catch { return null; }
  const m = u.hostname.toLowerCase().endsWith('bilibili.com') && u.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
  if (m) return m[1];
  if (/(^|\.)b23\.tv$/i.test(u.hostname)) {
    try {
      const r = await fetch('https://' + u.host + u.pathname + u.search, { redirect: 'manual', signal: AbortSignal.timeout(API_TIMEOUT), headers: { 'User-Agent': UA, Referer: REFERER } });
      const loc = r.headers.get('location') || '';
      const mm = loc.match(/\/(video|audio)\/(BV[0-9A-Za-z]+|av\d+)/i);
      if (mm) return mm[2];
    } catch { /* fallthrough */ }
  }
  return null;
}

// 访客 buvid（b_3/b_4）：搜索接口按 B 站文档需 buvid3，否则间歇 -412 风控（finger/spi 公开免登录）。缓存 24h。
let visitorCookie = '';
let visitorLoadedAt = 0;
async function getVisitorCookie() {
  if (visitorCookie && Date.now() - visitorLoadedAt < 24 * 3600 * 1000) return visitorCookie;
  try {
    const r = await fetch(BILI_API + '/x/frontend/finger/spi', { signal: AbortSignal.timeout(API_TIMEOUT), headers: { 'User-Agent': UA, Referer: REFERER } });
    const j = await r.json();
    const b3 = j && j.data && j.data.b_3; const b4 = j && j.data && j.data.b_4;
    visitorCookie = [b3 ? 'buvid3=' + b3 : '', b4 ? 'buvid4=' + b4 : ''].filter(Boolean).join('; ');
    visitorLoadedAt = Date.now();
  } catch { /* 空 cookie 继续，多数接口仍可用 */ }
  return visitorCookie;
}

async function biliJson(url, query) {
  const full = url + (query ? '?' + query : '');
  const cookie = await getVisitorCookie();
  const r = await fetch(full, { signal: AbortSignal.timeout(API_TIMEOUT), headers: { 'User-Agent': UA, Referer: REFERER, ...(cookie ? { Cookie: cookie } : {}) } });
  if (r.status !== 200) return { __http: r.status };
  const j = await r.json();
  if (j.code !== 0) return { __code: j.code, __message: j.message };
  return j;
}

/** view 元数据（含分 P 列表）。 */
async function getView(id) {
  const key = 'view_' + safeKey(id.toLowerCase()); // 键不带冒号：Windows 把 a:b.json 当 ADS，缓存静默失效（musicRoutes 同款坑）
  const hit = await cacheGet(key, TTL_META);
  if (hit) return hit;
  const params = /^av/i.test(id) ? { aid: id.slice(2) } : { bvid: id };
  const j = await biliJson(BILI_API + '/x/web-interface/view', new URLSearchParams(params).toString());
  if (!j.data) return null;
  const d = j.data;
  const meta = {
    bvid: d.bvid, aid: d.aid, title: d.title, up: (d.owner && d.owner.name) || '',
    pic: d.pic, duration: d.duration, pages: (d.pages || []).map((p) => ({ page: p.page, part: p.part, cid: p.cid, duration: p.duration })),
  };
  await cachePut(key, meta);
  return meta;
}

/**
 * 自研 B 站路由。true = 已处理。挂在 handleMusicRoutes 之后（同 music.enabled 开关）。
 * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
 */
export async function handleBiliRoutes(req, res, parts, log, enabled) {
  const p = parts.rawPath;
  if (!enabled || !p.startsWith('/music/bili/')) return false;
  const q = new URLSearchParams(parts.query || '');
  try {
    if (p === '/music/bili/info') {
      const id = await resolveId(q.get('url') || q.get('bvid') || '');
      if (!id) { sendJson(req, res, 400, { ok: false, error: 'bad id: expect BV/av/b23/link' }); return true; }
      const meta = await getView(id);
      if (!meta) { sendJson(req, res, 502, { ok: false, error: 'bilibili view unavailable' }); return true; }
      sendJson(req, res, 200, { ok: true, ...meta });
      return true;
    }
    if (p === '/music/bili/search') {
      const kw = String(q.get('kw') || '').trim().slice(0, 64);
      const page = Math.max(1, parseInt(q.get('page') || '1', 10) || 1);
      if (!kw) { sendJson(req, res, 400, { ok: false, error: 'kw required' }); return true; }
      const ckey = 'search_' + safeKey(kw + '|' + page);
      const hit = await cacheGet(ckey, TTL_SEARCH);
      if (hit) { sendJson(req, res, 200, hit); return true; }
      const params = new URLSearchParams({ search_type: 'video', keyword: kw, page: String(page), page_size: '30' });
      const j = await biliJson(BILI_API + '/x/web-interface/search/type', params.toString());
      if (!j.data) {
        log?.warn?.('[bili] search failed code=' + (j.__code ?? j.__http));
        sendJson(req, res, 502, { ok: false, error: 'bilibili search unavailable' }); return true;
      }
      const out = {
        ok: true,
        list: (j.data.result || []).filter((r) => r.bvid).map((r) => ({
          bvid: r.bvid, title: stripHtml(r.title), author: stripHtml(r.author),
          duration: parseInt(String(r.duration).split(':')[0], 10) * 60 + parseInt(String(r.duration).split(':')[1] || '0', 10) || null,
          pic: r.pic ? 'https:' + String(r.pic).split('@')[0] : null,
        })),
      };
      await cachePut(ckey, out);
      sendJson(req, res, 200, out);
      return true;
    }
    if (p === '/music/bili/audio') {
      const id = await resolveId(q.get('bvid') || q.get('url') || '');
      if (!id || !BV_RE.test(id)) { sendJson(req, res, 400, { ok: false, error: 'bad bvid' }); return true; }
      const pageNum = Math.max(1, parseInt(q.get('p') || '1', 10) || 1);
      const meta = await getView(id);
      if (!meta) { sendJson(req, res, 502, { ok: false, error: 'view unavailable' }); return true; }
      const pg = meta.pages.find((x) => x.page === pageNum) || meta.pages[0];
      if (!pg) { sendJson(req, res, 404, { ok: false, error: 'no pages' }); return true; }
      // fnval=0 → 老式 durl mp4 整段（Lead 指定，比 dash 简单）；qn=64 免登录可得的最高视频档，音频随 mp4
      const params = new URLSearchParams({ bvid: meta.bvid, cid: String(pg.cid), fnval: '0', qn: '64' });
      const j = await biliJson(BILI_API + '/x/player/playurl', params.toString());
      const durl = j.data && j.data.durl && j.data.durl[0];
      if (!durl || !/^https:\/\/[^/?#]*\.(bilivideo\.cn|bilivideo\.com|mountaintoys\.cn)(:\d+)?(?=\/|\?)/i.test(durl.url || '')) {
        log?.warn?.('[bili] playurl unavailable code=' + (j.__code ?? j.__http));
        sendJson(req, res, 502, { ok: false, error: 'playurl unavailable' }); return true;
      }
      const upstream = await fetch(durl.url, { signal: AbortSignal.timeout(DL_TIMEOUT), headers: { 'User-Agent': UA, Referer: REFERER } });
      if (upstream.status !== 200 && upstream.status !== 206) { sendJson(req, res, 502, { ok: false, error: 'cdn ' + upstream.status }); return true; }
      const len = parseInt(upstream.headers.get('content-length') || String(durl.size || '0'), 10) || 0;
      if (len > MAX_AUDIO_BYTES) { sendJson(req, res, 413, { ok: false, error: 'audio too large (>50MB)' }); return true; }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        ...(len ? { 'Content-Length': String(len) } : {}),
        'Cache-Control': 'no-store', // 直链 2h 时效，缓存无意义
        'X-Content-Type-Options': 'nosniff',
      });
      const body = upstream.body;
      let seen = 0;
      try {
        for await (const chunk of body) {
          seen += chunk.length;
          if (seen > MAX_AUDIO_BYTES) { res.destroy(); log?.warn?.('[bili] stream exceeded 50MB, aborted'); return true; }
          if (!res.write(chunk)) await new Promise((r) => res.once('drain', r)); // 标准背压：等 res 排空，不碰 body 事件
        }
      } finally { if (typeof body.destroy === 'function' && !body.destroyed) body.destroy(); }
      res.end();
      return true;
    }
    sendJson(req, res, 404, { ok: false, error: 'unknown bili route' });
    return true;
  } catch (e) {
    log?.warn?.('[bili] route error: ' + (e && e.message));
    if (!res.headersSent) sendJson(req, res, 502, { ok: false, error: 'bili upstream error' });
    else res.destroy();
    return true;
  }
}
