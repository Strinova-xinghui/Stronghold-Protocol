// public/js/ui/player.js — 自研音乐播放器 UI 层（2026-10-15）。纯逻辑在 player-core.js（Node 可单测）。

import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon, Button, Modal } from './components.js';
import { audio } from '../audio.js';
import { data, useData } from '../data.js';
import { createStore, useStore } from '../store.js';
import { t } from '../../../shared/i18n.js';
import { builtinTracks, sirenAlbums, sirenAlbum, sirenSearch, sirenSongUrl, loadLxScript, fetchLxScript, lxMusicUrl, lxSearch, lxLyric, wyLyric, LX_SEARCH_SOURCES, biliInfo, biliSearch, biliAudioUrl, fmtDur, parseLrc, lrcIndex } from './player-core.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

// ---- 全局开关（main.js 挂 <${PlayerHost}/>，任何界面都能开点歌台；
// 局内的角落按钮、标题/大厅/房间入口都调 openPlayer()。播放本身在 audio.js，本来就跨界面持续。）
const playerStore = createStore({ open: false });
export function openPlayer() { data.load('assets'); playerStore.set({ open: true }); }
export const closePlayer = () => playerStore.set({ open: false });

// ---- 播放队列（模块级 store：面板关了播放继续，重开原样恢复）----------------------------------------
// 全功能播放器（2026-10-16）：三个 tab 的播放统一走队列——点一首 = 播它并把当前可见列表排进队列，
// 播完自动下一首；控制条（进度/暂停/上下曲/循环）与滚动歌词常驻面板底部。
const qStore = createStore({ items: [], index: -1, loop: 'off', lyric: null, err: '' });
const qGet = () => qStore.get();
const sirenMeta = {}; // cid → { url, lyricUrl }（服务端 1h 缓存，二次换链零成本）
/** 当前队列项（UI 高亮用）。 */
const qCur = () => { const { items, index } = qGet(); return items[index] || null; };

// ---- 收藏（localStorage；条目 = 元数据 + kind，重播时按 kind 现取链接）--------------------------------
const FAV_KEY = 'sp_player_favs';
function favLoad() { try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]').slice(0, 200); } catch { return []; } }
// 初值必须来自 favLoad()（且 favLoad 在 FAV_KEY 之后）：否则刷新后 store 空，下一次 favToggle 会覆盖 localStorage（收藏全丢）
const favStore = createStore({ list: favLoad() });
function favSave(list) { favStore.set({ list }); try { localStorage.setItem(FAV_KEY, JSON.stringify(list.slice(0, 200))); } catch { /* full */ } }
function favToggle(f) {
  const list = favStore.get().list;
  const i = list.findIndex((x) => x.key === f.key);
  if (i >= 0) favSave(list.filter((x) => x.key !== f.key));
  else favSave([f, ...list]);
}
/** 收藏条目 → 队列项：按 kind 现场重建 url()/lyric()（塞壬/lx 都重新换链，网易云走内置）。 */
function favItem(f) {
  if (f.kind === 'siren') return sirenItem({ cid: f.mid, name: f.title, artistes: f.artist ? [f.artist] : [] }, { name: f.album, coverUrl: f.cover });
  if (f.kind === 'builtin') return builtinItem({ key: f.key, name: f.title, url: f.url, scene: f.album });
  if (f.kind === 'bili') return biliItem({ bvid: f.mid, title: f.album || f.title, up: f.artist }, { page: f.page || 1, part: f.title });
  const mi = { source: f.source, songmid: f.mid, songName: f.title, singerName: f.artist, albumName: f.album };
  return { ...mi, ...lxItemLazy(mi, f.source) };
}
// 收藏重播外部曲目：打开收藏 tab 时若脚本已加载用其 listeners；未加载则报错提示
let lxLive = { listeners: null, source: '' }; // CustomSourceTab 挂载时更新
function lxItemLazy(mi, source) {
  return {
    key: 'ext:' + (mi.source || source) + ':' + mi.songmid, title: mi.songName || mi.songmid, artist: mi.singerName || '', album: mi.albumName || '', cover: null,
    url: async () => {
      if (!lxLive.listeners) throw new Error(t('先在「外部音源」加载脚本后再播收藏'));
      return lxMusicUrl(lxLive.listeners, lxLive.source || source, mi, null);
    },
    lyric: async () => (lxLive.listeners ? await lxLyric(lxLive.listeners, lxLive.source || source, mi) : null) || (mi.source === 'wy' ? await wyLyric(mi.songmid) : null),
  };
}

/** 播队列第 i 首：取 URL → 流式 playTrack → 异步取歌词。 */
async function qPlayAt(i) {
  const { items } = qGet();
  const it = items[i];
  if (!it) return;
  qStore.set({ index: i, lyric: null, err: '' });
  let url;
  try { url = await it.url(); } catch (e) { if (qGet().index === i) qStore.set({ err: String((e && e.message) || e) }); return; }
  if (qGet().index !== i) return; // 取链期间又切了歌：丢弃过期结果
  audio.playTrack({ url }, it.key, { stream: true, loop: qGet().loop === 'one' || it.loop === true });
  if (typeof it.lyric === 'function') {
    Promise.resolve(it.lyric()).then((lrc) => {
      if (qGet().index === i) qStore.set({ lyric: lrc ? parseLrc(lrc) : null });
    }).catch(() => { /* 无词可播 */ });
  }
}
function qPlayList(items, i) { qStore.set({ items }); qPlayAt(i); }
function qNext(auto = false) {
  const { items, index, loop } = qGet();
  if (!items.length) return;
  if (loop === 'one' && auto) { qPlayAt(index); return; }
  let n = index + 1;
  if (n >= items.length) {
    if (loop === 'all') n = 0;
    else if (auto) return; // 列表尽头：自然停
    else n = items.length - 1;
  }
  qPlayAt(n);
}
function qPrev() {
  const { items, index } = qGet();
  if (!items.length) return;
  qPlayAt(Math.max(0, index - 1));
}
function qStop() { qStore.set({ items: [], index: -1, lyric: null, err: '' }); }
// 流式曲目播完 → 队列自动前进（loop 曲目不会触发 ended）
audio.onBgmEnded = () => qNext(true);

/** 内置曲目 → 队列项（循环播放，无歌词）。 */
function builtinItem(tr) {
  return { key: tr.key, title: tr.name, artist: '塞壬唱片-MSR', album: tr.scene, cover: null, loop: true, url: async () => tr.url };
}
/** 塞壬曲目 → 队列项（换链 + 官方 .lrc 直连取词）。 */
function sirenItem(s, album) {
  return {
    key: 'siren:' + s.cid, title: s.name, artist: (s.artistes || []).join(' / '), album: album && album.name, cover: album && album.coverUrl,
    url: async () => { const d = await sirenSongUrl(s.cid); if (!d.url) throw new Error('no audio url'); sirenMeta[s.cid] = d; return d.url; },
    lyric: async () => { const d = sirenMeta[s.cid] || await sirenSongUrl(s.cid); sirenMeta[s.cid] = d; return d.lyricUrl ? (await fetch(d.lyricUrl)).text() : null; },
  };
}
/** lx 搜索结果 → 队列项（取链/歌词都走用户脚本；wy 结果脚本没实现 lyric 时退回网易云官方词）。 */
function lxItem(mi, listeners, source) {
  return {
    key: 'ext:' + (mi.source || source) + ':' + mi.songmid, title: mi.songName || mi.songmid, artist: mi.singerName || '', album: mi.albumName || '', cover: null,
    url: () => lxMusicUrl(listeners, source, mi, null),
    lyric: async () => (await lxLyric(listeners, source, mi)) || (mi.source === 'wy' ? await wyLyric(mi.songmid) : null),
  };
}

/** 兼容旧导出：单点播放（e2e 与外部调用）。 */
export function playBuiltin(track) {
  if (!track) return;
  qPlayList([builtinItem(track)], 0);
}
export async function playSirenSong(cid, name, signal) {
  const info = await sirenSongUrl(cid, signal);
  if (!info.url) throw new Error('no audio url');
  audio.playTrack({ url: info.url }, 'siren:' + cid + ':' + name);
}

/** B 站条目 → 队列项（本地中转同源直链；歌词需 wbi+字幕接口，本期跳过）。 */
function biliItem(meta, pg) {
  const page = pg && pg.page ? pg.page : 1;
  return {
    key: 'bili:' + meta.bvid + (page > 1 ? '_p' + page : ''), title: (pg && pg.part) || meta.title || meta.bvid,
    artist: meta.up || 'UP主', album: 'Bilibili · ' + meta.bvid, cover: null,
    url: async () => biliAudioUrl(meta.bvid, page),
  };
}

// ---- 播放器面板 ----------------------------------------------------------------------------------------
const TABS = [
  { key: 'builtin', label: '内置 BGM' },
  { key: 'siren', label: '塞壬唱片 OST' },
  { key: 'custom', label: '外部音源' },
  { key: 'fav', label: '收藏' },
];

function TrackRow({ track, playing, onPlay, cover, hint }) {
  return html`<button type="button" class=${cx('ptrack', playing && 'is-on')} onClick=${onPlay}
    aria-pressed=${String(!!playing)}>
    <span class="ptrack__art">
      ${cover ? html`<img src=${cover} alt="" loading="lazy" />` : html`<${Icon} name="signal" />`}
    </span>
    <span class="ptrack__meta">
      <b class="ptrack__name">${track.name}</b>
      <small class="ptrack__sub">${[track.artist, track.album, hint].filter(Boolean).join(' · ') || track.scene || ''}</small>
    </span>
    <span class="ptrack__play"><${Icon} name=${playing ? 'close' : 'play'} /></span>
  </button>`;
}

/** 搜索框（受控；type=search 原生带清除按钮，这里再补一个显式的）。 */
function SearchBox({ value, onChange, placeholder, onEnter }) {
  return html`<div class="psearch">
    <span class="psearch__ico"><${Icon} name="search" /></span>
    <input type="search" value=${value} onInput=${(e) => onChange(e.target.value)} placeholder=${placeholder} aria-label=${placeholder}
      onKeyDown=${onEnter ? (e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } } : undefined} />
    ${value ? html`<button type="button" class="psearch__x" onClick=${() => onChange('')} aria-label=${t('清除')}><${Icon} name="close" /></button>` : null}
  </div>`;
}

/** 专辑是否命中的关键词（名称 / 艺术家，大小写不敏感）。 */
function matchAlbum(a, q) {
  if (!q) return true;
  return String(a.name || '').toLowerCase().includes(q) || (a.artistes || []).some((x) => String(x).toLowerCase().includes(q));
}

/** 外部音源 tab：粘贴 lx 脚本 → 加载 → 输入歌曲信息点播。 */
function CustomSourceTab({ favAdd, favHas }) {
  useStore((s) => s, Object.is, qStore);
  useStore((s) => s, Object.is, favStore); // 队列变化时重渲染（当前行高亮）
  const [code, setCode] = useState(() => { try { return localStorage.getItem('sp_player_lx_script') || ''; } catch { return ''; } });
  const [sources, setSources] = useState(null);
  const [listeners, setListeners] = useState(null);
  const [err, setErr] = useState('');
  const [source, setSource] = useState('');
  const [url, setUrl] = useState(() => { try { return localStorage.getItem('sp_player_lx_url') || ''; } catch { return ''; } });
  const [songmid, setSongmid] = useState('');
  const [songname, setSongname] = useState('');
  const [busy, setBusy] = useState(false);
  // —— Bilibili（本地中转）：粘 BV/av/b23/播放页链接 → 元数据 → 分 P 队列播；搜索源下拉含 bili ——
  const [biliInput, setBiliInput] = useState('');
  const [biliMeta, setBiliMeta] = useState(null);
  const [biliBusy, setBiliBusy] = useState(false);
  const apply = async (text) => {
    const res = await loadLxScript(text);
    if (!res.ok) { setErr(res.error || t('加载失败')); setSources(null); setListeners(null); return; }
    setSources(res.sources); setListeners(res.listeners);
    const keys = Object.keys(res.sources || {});
    setSource(keys[0] || '');
    lxLive = { listeners: res.listeners, source: keys[0] || '' }; // 收藏重播外部曲目用
    try { localStorage.setItem('sp_player_lx_script', text); } catch { /* ignore */ }
  };
  const load = async () => {
    setErr(''); setBusy(true);
    try { await apply(code); } catch (e) { setErr(String(e && e.message ? e.message : e)); }
    setBusy(false);
  };
  // 通过 URL 添加：拉取脚本 → 填进文本框（可再手改）→ 立即加载
  const loadUrl = async () => {
    setErr(''); setBusy(true);
    try {
      const got = await fetchLxScript(url);
      if (!got.ok) { setErr(t('拉取失败：') + (got.error || '')); setBusy(false); return; }
      setCode(got.code);
      try { localStorage.setItem('sp_player_lx_url', url.trim()); } catch { /* ignore */ }
      await apply(got.code);
    } catch (e) { setErr(String(e && e.message ? e.message : e)); }
    setBusy(false);
  };
  // —— 搜索点歌：输入关键词 → 内置源（网易云/酷狗）出结果 → 点一行 = 用当前脚本取链播放 ——
  const [sk, setSk] = useState(() => { try { return localStorage.getItem('sp_player_lx_sk') || 'wy'; } catch { return 'wy'; } });
  const [sq, setSq] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const doSearch = async () => {
    const kw = sq.trim();
    if (!kw) { setResults(null); return; }
    setErr(''); setSearching(true);
    try {
      if (sk === 'bili') { const list = await biliSearch(kw); setResults(list.map((r) => ({ source: 'bili', songmid: r.bvid, songName: r.title, singerName: r.author, albumName: 'Bilibili', interval: r.duration, bili: r }))); }
      else setResults(await lxSearch(sk, kw));
    }
    catch (e) { setResults(null); setErr(t('搜索失败：') + String(e && e.message ? e.message : e)); }
    setSearching(false);
  };
  useEffect(() => { try { localStorage.setItem('sp_player_lx_sk', sk); } catch { /* ignore */ } }, [sk]);
  // 点一行 = 整页结果排进队列播这行（播完自动连播）；取链/歌词都在 qPlayAt 里异步做
  const playInfo = (musicInfo, list) => {
    setErr('');
    qPlayList((list || [musicInfo]).map((mi) => lxItem(mi, listeners, source)), list ? list.indexOf(musicInfo) : 0);
  };
  const play = () => playInfo({ source: sk, songmid: songmid.trim(), songName: songname || songmid, singerName: '' });
  // —— bili：链接 → biliInfo（服务端中转元数据）→ 分 P 展开成队列 ——
  const biliAddUrl = async () => {
    const v = biliInput.trim();
    if (!v) return;
    setErr(''); setBiliBusy(true); setBiliMeta(null);
    try { setBiliMeta(await biliInfo(v)); }
    catch (e) { setErr(t('B 站解析失败：') + String(e && e.message ? e.message : e)); }
    setBiliBusy(false);
  };
  const biliPlayAll = (m, startPage) => {
    setErr('');
    const items = (m.pages || []).map((pg) => biliItem(m, pg));
    if (!items.length) { setErr(t('该稿件没有可播放的分 P')); return; }
    const targetKey = 'bili:' + m.bvid + (startPage > 1 ? '_p' + startPage : '');
    const i = startPage ? Math.max(0, items.findIndex((x) => x.key === targetKey)) : 0;
    qPlayList(items, startPage ? i : 0);
  };
  const playBili = (mi) => {
    setErr('');
    if (mi.bvid && biliMeta && mi.bvid === biliMeta.bvid) { biliPlayAll(biliMeta, mi.page || 1); return; }
    biliInfo(mi.bvid).then((m) => biliPlayAll(m, mi.page || 1)).catch((e) => setErr(t('B 站取链失败：') + String(e && e.message ? e.message : e)));
  };
  const meta = sources ? Object.entries(sources) : [];
  return html`<div class="ptab">
    <p class="phint">${t('粘贴 lx-music 自定义源脚本（规范：lxmusic.toside.cn/desktop/custom-source），或通过 URL 导入。脚本在浏览器本地执行，请求直连第三方，不经过游戏服务器。')}</p>
    <div class="prow">
      <input class="purl" type="url" value=${url} onInput=${(e) => setUrl(e.target.value)}
        placeholder=${t('脚本直链 URL（raw / jsDelivr 等，需 CORS 或纯文本）')} spellcheck=${false} />
      <${Button} size="sm" disabled=${busy || !/^https?:\/\//i.test(url.trim())} onClick=${loadUrl}>${t('URL 导入')}<//>
    </div>
    <div class="prow">
      <input class="purl" type="text" value=${biliInput} onInput=${(e) => setBiliInput(e.target.value)}
        placeholder=${t('B 站链接：BV号 / av号 / b23.tv / 播放页（服务器中转播放）')} spellcheck=${false} />
      <${Button} size="sm" disabled=${biliBusy || !biliInput.trim()} onClick=${biliAddUrl}>${biliBusy ? t('解析中…') : t('B 站解析')}<//>
    </div>
    ${biliMeta ? html`<div class="plist">
      <div class="pfav-row">
        <button type="button" class=${cx('ptrack', 'ptrack--lx', (qCur() || {}).key === ('bili:' + biliMeta.bvid) && 'is-on')} onClick=${() => biliPlayAll(biliMeta, 0)}>
          <span class="ptrack__meta">
            <b class="ptrack__name">${biliMeta.title}</b>
            <small class="ptrack__sub">UP: ${biliMeta.up} · ${biliMeta.bvid} · ${biliMeta.pages.length > 1 ? biliMeta.pages.length + ' 个分 P' : fmtDur(biliMeta.duration)}</small>
          </span>
          <span class="ptrack__play"><${Icon} name="play" /></span>
        </button>
        <button type="button" class=${cx('pfav', favHas('bili:' + biliMeta.bvid) && 'is-on')} title=${t('收藏')} aria-label=${t('收藏')}
          onClick=${() => favAdd({ key: 'bili:' + biliMeta.bvid, title: biliMeta.title, artist: biliMeta.up, album: 'Bilibili', kind: 'bili', mid: biliMeta.bvid, page: 1 })}><${Icon} name=${favHas('bili:' + biliMeta.bvid) ? 'heartFill' : 'heart'} /><//>
      </div>
      ${biliMeta.pages.length > 1 ? biliMeta.pages.map((pg) => html`<div key=${'bili:' + biliMeta.bvid + '_p' + pg.page} class="pfav-row">
        <button type="button" class=${cx('ptrack', 'ptrack--lx', (qCur() || {}).key === 'bili:' + biliMeta.bvid + '_p' + pg.page && 'is-on')} onClick=${() => biliPlayAll(biliMeta, pg.page)}>
          <span class="ptrack__meta"><b class="ptrack__name">P${pg.page} ${pg.part || biliMeta.title}</b><small class="ptrack__sub">${fmtDur(pg.duration)}</small></span>
          <span class="ptrack__play"><${Icon} name="play" /></span>
        </button>
      </div>`) : null}
    </div>` : null}
    <textarea class="pcode" value=${code} onInput=${(e) => setCode(e.target.value)} spellcheck=${false}
      placeholder=${t('/**\n * @name 我的音源\n * @version 1.0.0\n */\nconst { EVENT_NAMES, request, on, send } = globalThis.lx\n…')}></textarea>
    <div class="prow">
      <${Button} size="sm" variant="primary" disabled=${busy || !code.trim()} onClick=${load}>${t('加载音源')}<//>
      ${err ? html`<span class="perr">${err}</span>` : null}
    </div>
    ${meta.length ? html`<div class="prow">
      <span class="plabel">${t('取链音源')}<//>
      <select value=${source} onChange=${(e) => { setSource(e.target.value); lxLive = { listeners, source: e.target.value }; }}>
        ${meta.map(([k, s]) => html`<option key=${k} value=${k}>${(s && s.name) || k}</option>`)}
      </select>
    </div>` : null}
    <div class="prow">
      <span class="plabel">${t('搜索源')}<//>
      <select class="psk" value=${sk} onChange=${(e) => setSk(e.target.value)}>
        ${LX_SEARCH_SOURCES.map((s) => html`<option key=${s.key} value=${s.key}>${t(s.name)}</option>`)}
        <option value="bili">Bilibili</option>
      </select>
      <${SearchBox} value=${sq} onChange=${setSq} onEnter=${doSearch} placeholder=${t('输入歌名 / 歌手，回车搜索…')} />
      <${Button} size="sm" variant="primary" disabled=${searching || !sq.trim()} onClick=${doSearch}>${searching ? t('搜索中…') : sk === 'bili' ? t('B 站搜索') : t('搜索')}<//>
    </div>
    ${results ? html`<div class="plist">
      ${results.length ? results.map((s) => { if (s.bili) { const key = 'bili:' + s.bili.bvid; return html`<div key=${key} class="pfav-row">
        <button type="button" class=${cx('ptrack', 'ptrack--lx', (qCur() || {}).key === key && 'is-on')} onClick=${() => playBili(s.bili)}>
          <span class="ptrack__meta">
            <b class="ptrack__name">${s.songName}</b>
            <small class="ptrack__sub">UP: ${s.singerName || '-'} · ${s.bili.bvid}</small>
          </span>
          ${s.interval ? html`<span class="ptrack__dur">${fmtDur(s.interval)}</span>` : null}
          <span class="ptrack__play"><${Icon} name="play" /></span>
        </button>
        <button type="button" class=${cx('pfav', favHas(key) && 'is-on')} title=${t('收藏')} aria-label=${t('收藏')}
          onClick=${() => favAdd({ key, title: s.songName, artist: s.singerName, album: 'Bilibili', kind: 'bili', mid: s.bili.bvid, page: 1 })}><${Icon} name=${favHas(key) ? 'heartFill' : 'heart'} /><//>
      </div>`; } const key = 'ext:' + (s.source || source) + ':' + s.songmid; return html`<div key=${key} class="pfav-row">
        <button type="button" class=${cx('ptrack', 'ptrack--lx', (qCur() || {}).key === key && 'is-on')} onClick=${() => playInfo(s, results)}>
          <span class="ptrack__meta">
            <b class="ptrack__name">${s.songName}</b>
            <small class="ptrack__sub">${[s.singerName, s.albumName].filter(Boolean).join(' · ')}</small>
          </span>
          ${s.interval ? html`<span class="ptrack__dur">${fmtDur(s.interval)}</span>` : null}
          <span class="ptrack__play"><${Icon} name="play" /></span>
        </button>
        <button type="button" class=${cx('pfav', favHas(key) && 'is-on')} title=${t('收藏')} aria-label=${t('收藏')}
          onClick=${() => favAdd({ key, title: s.songName, artist: s.singerName, album: s.albumName, kind: s.source || 'ext', mid: s.songmid, source: s.source || source })}><${Icon} name=${favHas(key) ? 'heartFill' : 'heart'} /><//>
      </div>`}) : html`<p class="phint">${t('没有搜索结果。')}</p>`}
    </div>` : null}
    ${meta.length ? html`<details class="plx-adv">
      <summary>${t('高级：直接输入 songmid / ID 点播')}<//>
      <div class="prow">
        <input placeholder="songmid / ID" value=${songmid} onInput=${(e) => setSongmid(e.target.value)} />
        <input placeholder=${t('歌名（可选）')} value=${songname} onInput=${(e) => setSongname(e.target.value)} />
        <${Button} size="sm" disabled=${busy || !songmid.trim()} onClick=${play}>${t('点播')}<//>
      </div>
    </details>` : null}
  </div>`;
}
// ---- 播放控制条（进度/暂停/上下曲/循环/滚动歌词）+ 停止（全功能播放器 2026-10-16）----
const fmtMM = (sec) => { const s = Math.max(0, Math.floor(sec || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

/** 停止队列播放并交还阶段自动 BGM。 */
function stopAll() {
  qStop();
  audio.clearManualBgm();
  audio.playBgm(null); // install 的 sync 在下次状态变化时重新选曲
}

function ControlBar() {
  const q = useStore((s) => s, Object.is, qStore);
  const cur = q.items[q.index] || null;
  const [pos, setPos] = useState({ t: 0, d: 0, paused: false });
  const [showLyric, setShowLyric] = useState(() => { try { return localStorage.getItem('sp_player_lyric') === '1'; } catch { return false; } });
  const lyricRef = useRef(null);
  // rAF 轮询 <audio> 元素（面板开着才跑；关了播放继续，重开自动恢复）
  useEffect(() => {
    let raf = 0; let alive = true;
    const tick = () => {
      if (!alive) return;
      const el = audio.mediaEl;
      if (el) setPos({ t: el.currentTime || 0, d: el.duration || 0, paused: !!el.paused });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [cur && cur.key]);
  const idx = q.lyric && q.lyric.length ? lrcIndex(q.lyric, pos.t) : -1;
  useEffect(() => {
    if (!showLyric || !lyricRef.current) return;
    const el = lyricRef.current.querySelector('.plyric__line.is-on');
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [idx, showLyric]);
  if (!cur) return null;
  const seek = (v) => {
    const el = audio.mediaEl;
    if (el && Number.isFinite(el.duration)) { try { el.currentTime = v * el.duration; } catch { /* ignore */ } }
  };
  const toggle = () => {
    const el = audio.mediaEl;
    if (!el) return;
    if (el.paused) { el.play().catch(() => {}); } else el.pause();
    setPos({ t: el.currentTime || 0, d: el.duration || 0, paused: !!el.paused });
  };
  const cycleLoop = () => {
    const next = q.loop === 'off' ? 'all' : q.loop === 'all' ? 'one' : 'off';
    qStore.set({ loop: next });
    const el = audio.mediaEl;
    if (el) el.loop = next === 'one' || !!cur.loop; // 内置曲目本身的循环语义保留
  };
  const lineSeek = (l) => { const el = audio.mediaEl; if (!el) return; try { el.currentTime = l.t; } catch { /* ignore */ } };
  const btn = (title, iconName, onClick, on) => html`<button type="button" class=${cx('pbtn', on && 'is-on')} title=${title} aria-label=${title} onClick=${onClick}><${Icon} name=${iconName} /></button>`;
  return html`<div class="pctrl">
    ${showLyric && q.lyric && q.lyric.length ? html`<div class="plyric" ref=${lyricRef}>
      ${q.lyric.map((l, i) => html`<p key=${i} class=${cx('plyric__line', i === idx && 'is-on')} onClick=${() => lineSeek(l)}>${l.line}</p>`)}
    </div>` : null}
    ${showLyric && !(q.lyric && q.lyric.length) ? html`<p class="plyric plyric--empty">${t('暂无歌词')}</p>` : null}
    <div class="pctrl__row">
      <span class="pctrl__art">${cur.cover ? html`<img src=${cur.cover} alt="" />` : html`<${Icon} name="signal" />`}</span>
      <span class="pctrl__meta">
        <b class="pctrl__title">${cur.title}</b>
        <small class="pctrl__sub">${[cur.artist, cur.album].filter(Boolean).join(' · ')}</small>
      </span>
      <span class="pctrl__btns">
        ${btn(q.loop === 'one' ? t('单曲循环') : q.loop === 'all' ? t('列表循环') : t('不循环'), q.loop === 'one' ? 'repeatOne' : 'repeat', cycleLoop, q.loop !== 'off')}
        ${btn(t('上一曲'), 'skipPrev', qPrev)}
        ${btn(pos.paused ? t('播放') : t('暂停'), pos.paused ? 'play' : 'pause', toggle)}
        ${btn(t('下一曲'), 'skipNext', () => qNext(false))}
        ${btn(t('歌词'), 'lyric', () => { const nv = !showLyric; setShowLyric(nv); try { localStorage.setItem('sp_player_lyric', nv ? '1' : '0'); } catch { /* ignore */ } }, showLyric)}
        ${btn(t('停止并交还自动 BGM'), 'close', stopAll)}
      </span>
      <span class="pctrl__time">${fmtMM(pos.t)} / ${fmtMM(pos.d)}</span>
    </div>
    <input class="pctrl__seek" type="range" min="0" max="1000" step="1" value=${pos.d ? Math.round((pos.t / pos.d) * 1000) : 0}
      onInput=${(e) => seek(Number(e.target.value) / 1000)} aria-label=${t('播放进度')} />
    ${q.err ? html`<p class="perr">${t('取链失败：')}${q.err}</p>` : null}
  </div>`;
}

/** 收藏 tab（心形列表；点一行 = 整个收藏排队列播这行）。 */
function FavTab() {
  const { list } = useStore((s) => s, Object.is, favStore);
  const cur = qCur();
  if (!list.length) return html`<div class="ptab"><p class="phint">${t('还没有收藏。在搜索结果或曲目行右侧点 ♥ 收藏。')}</p></div>`;
  const items = list.map(favItem);
  return html`<div class="ptab">
    <p class="phint">${t('收藏（本机保存，最多 200 首）。外部音源的收藏需要先在「外部音源」加载脚本后才能取链。')}</p>
    <div class="plist">
      ${list.map((f, i) => html`<div key=${f.key} class="pfav-row">
        <button type="button" class=${cx('ptrack', 'ptrack--lx', cur && cur.key === f.key && 'is-on')} onClick=${() => qPlayList(items, i)}>
          <span class="ptrack__art">${f.cover ? html`<img src=${f.cover} alt="" loading="lazy" />` : html`<${Icon} name="signal" />`}</span>
          <span class="ptrack__meta">
            <b class="ptrack__name">${f.title}</b>
            <small class="ptrack__sub">${[f.artist, f.album].filter(Boolean).join(' · ')}</small>
          </span>
          <span class="ptrack__play"><${Icon} name="play" /></span>
        </button>
        <button type="button" class="pfav is-on" title=${t('取消收藏')} aria-label=${t('取消收藏')} onClick=${() => favToggle(f)}><${Icon} name="heartFill" /><//>
      </div>`)}
    </div>
  </div>`;
}

/** 播放器主面板。 */
export function PlayerPanel({ open, onClose }) {
  const [tab, setTab] = useState('builtin');
  const qState = useStore((s) => s, Object.is, qStore); // 队列态（当前曲 key 高亮 / 控制条共享同一 store）
  const curKey = (qState.items[qState.index] || {}).key || '';
  const [albums, setAlbums] = useState(null);
  const [album, setAlbum] = useState(null);
  const [albumBusy, setAlbumBusy] = useState('');
  const [sirenBusy, setSirenBusy] = useState(false);
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState(null);
  const [sirenErr, setSirenErr] = useState('');
  const assetsReady = useData('assets'); // 局外首次打开时清单可能还没到（openPlayer 触发加载）
  const tracks = useMemo(() => builtinTracks(data.get('assets')), [assetsReady]);
  useEffect(() => {
    if (!open || tab !== 'siren' || albums) return;
    const ac = new AbortController();
    setSirenBusy(true); setSirenErr('');
    sirenAlbums(ac.signal).then((list) => { setAlbums(list); setSirenBusy(false); })
      .catch((e) => { if (e.name !== 'AbortError') { setSirenErr(String(e && e.message ? e.message : e)); setSirenBusy(false); } });
    return () => ac.abort();
  }, [open, tab, albums]);
  // 搜索：本地即时过滤（专辑名/艺术家）；本地 0 命中时防抖 350 ms 走服务器搜索（塞壬站内检索）
  const qq = q.trim().toLowerCase();
  useEffect(() => {
    if (tab !== 'siren' || album || !qq) { setRemote(null); return; }
    if (albums && albums.some((a) => matchAlbum(a, qq))) { setRemote(null); return; }
    const ac = new AbortController();
    const timer = setTimeout(() => { sirenSearch(qq, ac.signal).then(setRemote).catch(() => setRemote(null)); }, 350);
    return () => { clearTimeout(timer); ac.abort(); };
  }, [tab, album, qq, albums]);
  const openAlbum = (a) => {
    setSirenErr(''); setAlbumBusy(a.cid); setAlbum(null);
    sirenAlbum(a.cid).then((d) => { setAlbum(d); setAlbumBusy(''); })
      .catch((e) => { setSirenErr(String(e && e.message ? e.message : e)); setAlbumBusy(''); });
  };
  if (!open) return null;
  const shownAlbums = albums ? (qq ? albums.filter((a) => matchAlbum(a, qq)) : albums) : null;
  const shownBuiltin = qq ? tracks.filter((x) => String(x.name).toLowerCase().includes(qq) || x.key.includes(qq)) : tracks;
  return html`<${Modal} open=${open} onClose=${onClose} title=${t('音乐播放器')} wide=${true}>
    <div class="player">
      <div class="player__tabs">
        ${TABS.map((x) => html`<button key=${x.key} type="button" class=${cx('ptab-btn', tab === x.key && 'is-on')}
          onClick=${() => { setTab(x.key); setQ(''); setAlbum(null); }}>${t(x.label)}<//>`)}
        <span class="grow"></span>
        <${Button} size="sm" variant="ghost" onClick=${stopAll}>${t('回到自动 BGM')}<//>
      </div>
      ${tab === 'builtin' ? html`<div class="ptab">
        <p class="phint">${t('游戏内置配乐（随客户端已下载，零额外流量）。播放中不受阶段切换影响，点「回到自动 BGM」恢复。')}</p>
        <${SearchBox} value=${q} onChange=${setQ} placeholder=${t('搜索曲目…')} />
        ${shownBuiltin.length ? shownBuiltin.map((tr) => html`<${TrackRow} key=${tr.key} track=${tr} cover=${null}
          playing=${curKey === tr.key}
          onPlay=${() => qPlayList(shownBuiltin.map(builtinItem), shownBuiltin.indexOf(tr))} />`) : html`<p class="phint">${t('没有匹配的曲目。')}</p>`}
      </div>` : null}
      ${tab === 'siren' ? html`<div class="ptab">
        <p class="phint">${t('塞壬唱片官方 OST（monster-siren.hypergryph.com）。曲目元数据经服务器缓存，音频由浏览器直连官方 CDN。')}</p>
        ${!album ? html`<${SearchBox} value=${q} onChange=${setQ} placeholder=${t('搜索专辑 / 艺术家…')} />` : null}
        ${sirenErr ? html`<p class="perr">${t('加载失败：')}${sirenErr}</p>` : null}
        ${sirenBusy && !albums ? html`<p class="phint">${t('加载中…')}</p>` : null}
        ${album ? html`<div class="prow palbum-head">
            <${Button} size="sm" variant="ghost" onClick=${() => setAlbum(null)}><${Icon} name="chevronLeft" />${t('专辑列表')}<//>
            <b class="palbum-title">${album.name}</b></div>
          ${album.intro ? html`<p class="phint palbum-intro">${album.intro}</p>` : null}
          ${(album.songs || []).length ? (album.songs || []).map((s) => { const it = sirenItem(s, album); return html`<div key=${s.cid} class="pfav-row">
            <${TrackRow} track=${{ name: s.name, artist: (s.artistes || []).join(' / '), album: album.name }}
              cover=${album.coverUrl} playing=${curKey === it.key}
              onPlay=${() => qPlayList((album.songs || []).map((x) => sirenItem(x, album)), (album.songs || []).indexOf(s))} />
            <button type="button" class=${cx('pfav', favStore.get().list.some((x) => x.key === it.key) && 'is-on')} title=${t('收藏')} aria-label=${t('收藏')}
              onClick=${() => favToggle({ key: it.key, title: s.name, artist: (s.artistes || []).join(' / '), album: album.name, cover: album.coverUrl, kind: 'siren', mid: s.cid })}><${Icon} name=${favStore.get().list.some((x) => x.key === it.key) ? 'heartFill' : 'heart'} /><//>
          </div>`}) : html`<p class="phint">${t('这张专辑没有曲目。')}</p>`}
        ` : null}
        ${!album && shownAlbums ? (shownAlbums.length ? shownAlbums.map((a) => html`<${TrackRow} key=${a.cid} track=${{ name: a.name, artist: (a.artistes || []).join(' / ') }}
          cover=${a.coverUrl} playing=${false} hint=${albumBusy === a.cid ? t('加载中…') : t('点击查看曲目')}
          onPlay=${() => openAlbum(a)} />`) : html`<p class="phint">${t('列表里没有匹配的专辑。')}</p>`) : null}
        ${!album && shownAlbums && qq && !shownAlbums.length && remote && remote.length ? html`<p class="phint">${t('服务器搜索到 {n} 张相关专辑：', { n: remote.length })}</p>
          ${remote.map((a) => html`<${TrackRow} key=${a.cid} track=${{ name: a.name, artist: (a.artistes || []).join(' / ') }}
            cover=${a.coverUrl} playing=${false} hint=${albumBusy === a.cid ? t('加载中…') : t('点击查看曲目')}
            onPlay=${() => openAlbum(a)} />`)}` : null}
      </div>` : null}
      ${tab === 'custom' ? html`<${CustomSourceTab} favAdd=${favToggle} favHas=${(k) => favStore.get().list.some((x) => x.key === k)} />` : null}
      ${tab === 'fav' ? html`<${FavTab} />` : null}
      <${ControlBar} />
    </div>
  <//>`;
}

/** 全局点歌台宿主 —— main.js 挂一次；未打开时渲染为空（不加载任何数据）。 */
export function PlayerHost() {
  const { open } = useStore((s) => s, Object.is, playerStore);
  if (!open) return null;
  return html`<${PlayerPanel} open=${true} onClose=${closePlayer} />`;
}