// public/js/ui/player-core.js — 自研音乐播放器的纯逻辑层（无 DOM/Preact 依赖，Node 可单测）。
// UI 层在 player.js（面板组件），本文件提供：内置 BGM 曲目推导、塞壬唱片官方 OST 的 API 客户端
// （专辑列表 / 详情 / 站内检索 / 单曲换链）、LRC 歌词解析。播放动作（audio.playTrack）在 UI 层。
// 设计约束（用户定）：零服务器带宽——塞壬 JSON API 由服务器代理并缓存（元数据几十 KB），音频/封面
// CORS=* 由客户端直连 hypergryph CDN；播放复用 audio.js 的流式管道，不新建解码机制。
// 外部音源（lx-music 自定义源脚本沙箱 + 网易云/酷狗搜索点歌）已于 2026-10-16 移除（用户决定：
// 去掉外部源，保留全功能播放器——队列/控制条/歌词/收藏都在）。历史实现见提交 e6d4e585。

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
  const r = await fetch(SIREN_API + '/album/' + encodeURIComponent(cid) + '/detail', { signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  const a = d.data || {};
  return {
    cid: a.cid, name: a.name, intro: a.intro || '', coverUrl: a.coverUrl || null,
    songs: (a.songs || []).map((s) => ({ cid: s.cid, name: s.name, artistes: s.artistes || [] })),
  };
}

/** 塞壬站内搜索（服务器代理 + 短缓存）：返回命中的专辑列表。 */
export async function sirenSearch(kw, signal) {
  const q = String(kw || '').trim();
  if (!q) return [];
  const r = await fetch(SIREN_API + '/search?kw=' + encodeURIComponent(q.slice(0, 64)), { signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  const list = ((d.data || {}).albums || {}).list || [];
  return list.map((a) => ({ cid: a.cid, name: a.name, coverUrl: a.coverUrl, artistes: a.artistes || [] }));
}

/** 单曲音频地址（服务器代理换 sourceUrl，客户端直连 CDN 播放）。 */
export async function sirenSongUrl(cid, signal) {
  const r = await fetch(SIREN_API + '/song/' + encodeURIComponent(cid), { signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const d = await r.json();
  return { url: (d.data || {}).sourceUrl || null, lyricUrl: (d.data || {}).lyricUrl || null };
}

// ---- 歌词（全功能播放器 2026-10-16）：LRC 解析 + 三条取词路径 ------------------------------------------
/**
 * LRC 文本 → [{t, line}]（按时间排序；一行多时间标签各成一条；元数据行 [ar:..] 丢弃）。
 * 支持毫秒 .xx / .xxx；无时间标签的行忽略。
 */
export function parseLrc(text) {
  const out = [];
  const TAG = /\[([0-9]{1,3}):([0-9]{1,2})(?:[.:]([0-9]{1,3}))?\]/g;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const times = [];
    let m;
    TAG.lastIndex = 0;
    // 行首区连续的时间标签（[00:12.34][01:02]词）
    let at = 0;
    while ((m = TAG.exec(raw)) && m.index === at) {
      times.push(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number('0.' + m[3]) : 0));
      at = TAG.lastIndex;
    }
    if (!times.length) continue;
    const line = raw.slice(at).trim();
    if (!line) continue; // 纯时间标签的过渡空行忽略
    for (const t of times) out.push({ t, line });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** 当前播放时刻 → 活跃行下标（二分；无词行 -1）。 */
export function lrcIndex(lines, sec) {
  if (!lines || !lines.length) return -1;
  let lo = 0, hi = lines.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t <= sec + 0.25) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

