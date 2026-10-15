// public/js/ui/player-core.js — 自研音乐播放器的纯逻辑层（无 DOM/Preact 依赖，Node 可单测）。
// UI 层在 player.js（面板组件），本文件提供：内置 BGM 曲目推导、塞壬 OST API 客户端、
// lx-music 自定义源脚本沙箱（loadLxScript/lxMusicUrl）。播放动作（audio.playTrack）在 UI 层 player.js。2026-10-15。

// public/js/ui/player.js — 自研音乐播放器（music player, 2026-10-15）：内置音源（游戏 BGM 16 首 + 塞壬唱片
// 官方 OST 专辑列表）+ 外部音源（lx-music 自定义源脚本兼容层，globalThis.lx API 沙箱执行）。
// 设计约束（用户 2026-10-15 定）：
//   ① 零服务器带宽：塞壬的 JSON API 由服务器代理并缓存（元数据，几十 KB），音频/封面文件 CORS=* 且支持 Range
//      → 客户端直连 hypergryph CDN，服务器出站 ≈ 0（只发缓存的 JSON）；
//   ② 外置音源的脚本与请求全部在浏览器内执行（第三方流量从玩家机器直出，服务器零成本）；
//   ③ 零新增内存：所有播放复用 audio.js 的 _buffer → 64MB LRU 管道（playTrack），不新建解码机制。
// lx-music 自定义源脚本规范（Apache-2.0，https://lxmusic.toside.cn/desktop/custom-source）：
//   脚本经 globalThis.lx = { EVENT_NAMES, on, send, request, utils, version, env, currentScriptInfo } 与宿主交互，
//   inited 事件声明 sources；request 事件的 action: musicUrl / lyric / pic。我们实现 request 的浏览器版
//   （fetch + 无跨域限制由服务器代理兜底，见 ui/player.js proxyFetch）。





import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/** 内置 BGM 曲名表（assets.json 只有文件名；塞壬唱片 MSR 公开曲名，非商业同人内展示）。 */
const BUILTIN_TRACK_NAMES = {
  m_sys_act1autochess_intro: '协议启动（前奏）',
  m_sys_act1autochess_loop: '协议启动',
  m_bat_act1autochess_loop: '卫戍协议·作战',
  m_bat_rglk1phantomcastle_intro: '幻影城堡（前奏）',
  m_bat_rglk1phantomcastle_loop: '幻影城堡',
  m_bat_corrosion_intro: '蚀刻章（前奏）',
  m_bat_corrosion_loop: '蚀刻章',
  m_bat_ancestor_loop: '先祖',
  m_bat_abyssalhunters_intro: '深渊猎手（前奏）',
  m_bat_abyssalhunters_loop: '深渊猎手',
  m_bat_vtlionk_intro: '狮心王（前奏）',
  m_bat_vtlionk_loop: '狮心王',
  m_bat_rouge3boss1_intro: '红票（前奏）',
  m_bat_rouge3boss1_loop: '红票',
  m_bat_prtsstage1_intro: 'PRTS（前奏）',
  m_bat_prtsstage1_loop: 'PRTS',
};

/** 内置 BGM 曲目（从 assets 清单推导；intro+loop 成对，播放 = intro 淡入到 loop 循环）。 */
export function builtinTracks(manifest) {
  const bgm = (manifest && manifest.audio && manifest.audio.bgm) || {};
  const out = [];
  const seen = new Set();
  for (const [scene, tracks] of Object.entries(bgm)) {
    const loop = tracks && typeof tracks.loop === 'string' ? tracks.loop : null;
    const intro = tracks && typeof tracks.intro === 'string' ? tracks.intro : null;
    if (!loop) continue;
    const stem = loop.split('/').pop().replace(/\.[^.]+$/, '');
    if (seen.has(stem)) continue;
    seen.add(stem);
    out.push({
      key: 'builtin:' + stem,
      name: BUILTIN_TRACK_NAMES[stem] || stem,
      scene,
      url: loop,
      introUrl: intro || null,
      coverUrl: null,
      artist: '塞壬唱片-MSR',
    });
  }
  // 同一 loop 的 intro 与 loop 是成对曲目，只列 loop 那一条（intro 由播放器自动衔接）
  return out;
}

// ---- 塞壬唱片官方 OST（monster-siren.hypergryph.com）------------------------------------------------
// API 无 CORS（浏览器不能直连）→ 由服务器代理（server/http/musicRoutes.js，内存+磁盘缓存，
// 元数据几十 KB/次，命中缓存后服务器只吐 JSON）；音频（res*.hycdn.cn）与封面（web.hycdn.cn）
// CORS=* + Range → 客户端直连 CDN，服务器出站 ≈ 0。
const SIREN_API = '/music/siren';

/** 专辑列表（服务器代理 + 缓存）。 */
export async function sirenAlbums(signal) {
  const r = await fetch(SIREN_API + '/albums', { signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  return (d.data || []).map((a) => ({ cid: a.cid, name: a.name, coverUrl: a.coverUrl, artistes: a.artistes || [] }));
}

/** 专辑详情（曲目列表 + 封面）。 */
export async function sirenAlbum(cid, signal) {
  const r = await fetch(SIREN_API + '/album/' + encodeURIComponent(cid), { signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  const a = d.data || {};
  return {
    cid: a.cid, name: a.name, intro: a.intro || '', coverUrl: a.coverUrl || null,
    songs: (a.songs || []).map((s) => ({ cid: s.cid, name: s.name, artistes: s.artistes || [] })),
  };
}

/** 单曲音频地址（服务器代理换 sourceUrl，客户端直连 CDN 播放）。 */
export async function sirenSongUrl(cid, signal) {
  const r = await fetch(SIREN_API + '/song/' + encodeURIComponent(cid), { signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  return { url: (d.data || {}).sourceUrl || null, lyricUrl: (d.data || {}).lyricUrl || null };
}

// ---- 外部音源：lx-music 自定义源脚本兼容层（Apache-2.0 规范的子集）-----------------------------------
// 规范：https://lxmusic.toside.cn/desktop/custom-source（文档 MIT；我们实现同名 API 契约，
// 不含其源码）。用户粘贴脚本 → 本地沙箱执行 → 请求全部从玩家浏览器直发第三方（服务器零成本、零带宽）。
const LX_EVENT_NAMES = Object.freeze({
  request: 'request',
  inited: 'inited',
  updateAlert: 'updateAlert',
});

/**
 * 在浏览器端跑一个 lx 自定义源脚本。
 * @param {string} code 脚本全文
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, sources?: Record<string, any>, listeners?: Map<string, Set<Function>>, error?: string }>}
 */
export async function loadLxScript(code, { timeoutMs = 15000 } = {}) {
  if (typeof code !== 'string' || !code.trim()) return { ok: false, error: 'empty script' };
  if (code.length > 512 * 1024) return { ok: false, error: 'script too large' };
  const listeners = new Map(); // event → Set<handler>
  let initedResolve;
  const inited = new Promise((res) => { initedResolve = res; });
  let timer = null;
  const fail = (msg) => { if (timer) clearTimeout(timer); initedResolve({ ok: false, error: msg }); };
  timer = setTimeout(() => fail('script init timeout'), timeoutMs);
  // 浏览器版 request：fetch（CORS 失败由 /music/proxy 兜底，调用方负责重试）
  const httpRequest = (url, options = {}, cb) => {
    (async () => {
      try {
        const method = options.method || 'GET';
        const headers = { ...(options.headers || {}) };
        let body = options.body;
        if (options.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(options.form).toString(); }
        const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(options.timeout || 15000) });
        const buf = await r.arrayBuffer();
        cb(null, { statusCode: r.status, headers: r.headers, body: buf });
      } catch (e) { cb(e, null); }
    })();
    return () => {};
  };
  const lx = {
    version: 1,
    env: 'desktop',
    currentScriptInfo: parseLxHeader(code),
    EVENT_NAMES: LX_EVENT_NAMES,
    on: (ev, handler) => {
      if (typeof handler !== 'function') return;
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(handler);
    },
    send: (ev, data) => {
      if (ev === LX_EVENT_NAMES.inited) {
        if (timer) clearTimeout(timer);
        initedResolve({ ok: true, sources: (data && data.sources) || {} });
      }
      // updateAlert 等其余事件：播放器用不到，忽略
    },
    request: httpRequest,
    utils: {
      buffer: { from: (x) => {
        if (x instanceof Uint8Array) return x;
        if (typeof x === 'string') return new TextEncoder().encode(x);
        return new Uint8Array(0);
      }, bufToString: (b, f) => new TextDecoder(f || 'utf-8').decode(b instanceof Uint8Array ? b : new Uint8Array(b || [])) },
      crypto: {
        aesEncrypt: async () => { throw new Error('aesEncrypt unsupported in browser lx shim'); },
        md5: async (str) => fnvHex(str),
        randomBytes: (n) => fnvHex(String(Math.random()) + String(performance.now())).slice(0, Math.max(1, n | 0) * 2).slice(0, Math.max(1, n | 0)),
        rsaEncrypt: async () => { throw new Error('rsaEncrypt unsupported in browser lx shim'); },
      },
      zlib: { inflate: async () => { throw new Error('zlib.inflate unsupported in browser lx shim'); }, deflate: async () => { throw new Error('zlib.deflate unsupported in browser lx shim'); } },
    },
  };
  // 沙箱执行：临时挂 globalThis.lx，同步跑完摘掉（脚本同步执行，inited 完成初始化）
  try {
    const prev = globalThis.lx;
    globalThis.lx = lx;
    try {
      // eslint-disable-next-line no-new-func
      new Function(code)();
    } finally {
      if (prev === undefined) delete globalThis.lx; else globalThis.lx = prev;
    }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
  const res = await inited;
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, sources: res.sources, listeners };
}

/** 解析脚本头注释（@name/@description/@version/@author/@homepage）。 */
export function parseLxHeader(code) {
  const head = String(code || '').slice(0, 2000);
  const get = (k) => { const m = new RegExp('@' + k + '\\s+([^\\n\\r*]+)').exec(head); return m ? m[1].trim() : ''; };
  return { name: get('name'), description: get('description'), version: get('version'), author: get('author'), homepage: get('homepage'), rawScript: code };
}

/** 调一个源的 musicUrl：返回播放 URL。 */
export async function lxMusicUrl(listeners, source, musicInfo, type) {
  const hs = listeners && listeners.get(LX_EVENT_NAMES.request);
  if (!hs || !hs.size) throw new Error('source has no request handler');
  let lastErr = null;
  for (const h of hs) {
    try {
      const url = await h({ source, action: 'musicUrl', info: { type: type || null, musicInfo } });
      if (typeof url === 'string' && url) return url;
      if (url && typeof url.url === 'string' && url.url) return url.url;
      lastErr = new Error('empty url');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('no handler');
}

/** FNV-1a 64bit hex（lx.utils.crypto.md5 / randomBytes 的非安全替身）。 */
function fnvHex(str) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h1 = (h1 ^ s.charCodeAt(i)) >>> 0;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + s.charCodeAt(i) * (i + 1)) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}