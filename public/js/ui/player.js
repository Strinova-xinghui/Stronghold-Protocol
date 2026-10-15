// public/js/ui/player.js — 自研音乐播放器 UI 层（2026-10-15）。纯逻辑在 player-core.js（Node 可单测）。

import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Icon, Button, Modal } from './components.js';
import { audio } from '../audio.js';
import { data, useData } from '../data.js';
import { createStore, useStore } from '../store.js';
import { t } from '../../../shared/i18n.js';
import { builtinTracks, sirenAlbums, sirenAlbum, sirenSearch, sirenSongUrl, loadLxScript, lxMusicUrl, parseLxHeader } from './player-core.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

// ---- 全局开关（main.js 挂 <${PlayerHost}/>，任何界面都能开点歌台；
// 局内的角落按钮、标题/大厅/房间入口都调 openPlayer()。播放本身在 audio.js，本来就跨界面持续。）
const playerStore = createStore({ open: false });
export function openPlayer() { data.load('assets'); playerStore.set({ open: true }); }
export const closePlayer = () => playerStore.set({ open: false });

/** 播放一首内置曲目（audio.playTrack：intro → loop 循环，走 LRU 管道）。 */
export function playBuiltin(track) {
  if (!track) return;
  audio.playTrack({ url: track.url, introUrl: track.introUrl }, track.key);
}

/** 播放一首塞壬曲目（先经服务器代理取 CDN URL，再 playTrack 流式解码）。 */
export async function playSirenSong(cid, name, signal) {
  const info = await sirenSongUrl(cid, signal);
  if (!info.url) throw new Error('no audio url');
  audio.playTrack({ url: info.url }, 'siren:' + cid + ':' + name);
}

// ---- 播放器面板 ----------------------------------------------------------------------------------------
const TABS = [
  { key: 'builtin', label: '内置 BGM' },
  { key: 'siren', label: '塞壬唱片 OST' },
  { key: 'custom', label: '外部音源' },
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
function SearchBox({ value, onChange, placeholder }) {
  return html`<div class="psearch">
    <span class="psearch__ico"><${Icon} name="search" /></span>
    <input type="search" value=${value} onInput=${(e) => onChange(e.target.value)} placeholder=${placeholder} aria-label=${placeholder} />
    ${value ? html`<button type="button" class="psearch__x" onClick=${() => onChange('')} aria-label=${t('清除')}><${Icon} name="close" /></button>` : null}
  </div>`;
}

/** 专辑是否命中的关键词（名称 / 艺术家，大小写不敏感）。 */
function matchAlbum(a, q) {
  if (!q) return true;
  return String(a.name || '').toLowerCase().includes(q) || (a.artistes || []).some((x) => String(x).toLowerCase().includes(q));
}

/** 外部音源 tab：粘贴 lx 脚本 → 加载 → 输入歌曲信息点播。 */
function CustomSourceTab({ onPlayUrl }) {
  const [code, setCode] = useState(() => { try { return localStorage.getItem('sp_player_lx_script') || ''; } catch { return ''; } });
  const [sources, setSources] = useState(null);
  const [listeners, setListeners] = useState(null);
  const [err, setErr] = useState('');
  const [source, setSource] = useState('');
  const [songmid, setSongmid] = useState('');
  const [songname, setSongname] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setErr(''); setBusy(true);
    try {
      const res = await loadLxScript(code);
      if (!res.ok) { setErr(res.error || t('加载失败')); setSources(null); setListeners(null); return; }
      setSources(res.sources); setListeners(res.listeners);
      const keys = Object.keys(res.sources || {});
      setSource(keys[0] || '');
      try { localStorage.setItem('sp_player_lx_script', code); } catch { /* ignore */ }
    } catch (e) { setErr(String(e && e.message ? e.message : e)); }
    setBusy(false);
  };
  const play = async () => {
    setErr(''); setBusy(true);
    try {
      const url = await lxMusicUrl(listeners, source, { songmid, name: songname || songmid }, null);
      onPlayUrl(url, (songname || songmid || 'external').slice(0, 60));
    } catch (e) { setErr(t('取链失败：') + String(e && e.message ? e.message : e)); }
    setBusy(false);
  };
  const meta = sources ? Object.entries(sources) : [];
  return html`<div class="ptab">
    <p class="phint">${t('粘贴 lx-music 自定义源脚本（规范：lxmusic.toside.cn/desktop/custom-source）。脚本在浏览器本地执行，请求直连第三方，不经过游戏服务器。')}</p>
    <textarea class="pcode" value=${code} onInput=${(e) => setCode(e.target.value)} spellcheck=${false}
      placeholder=${t('/**\n * @name 我的音源\n * @version 1.0.0\n */\nconst { EVENT_NAMES, request, on, send } = globalThis.lx\n…')}></textarea>
    <div class="prow">
      <${Button} size="sm" variant="primary" disabled=${busy || !code.trim()} onClick=${load}>${t('加载音源')}<//>
      ${err ? html`<span class="perr">${err}</span>` : null}
    </div>
    ${meta.length ? html`<div class="prow">
      <select value=${source} onChange=${(e) => setSource(e.target.value)}>
        ${meta.map(([k, s]) => html`<option key=${k} value=${k}>${(s && s.name) || k}</option>`)}
      </select>
      <input placeholder="songmid / ID" value=${songmid} onInput=${(e) => setSongmid(e.target.value)} />
      <input placeholder=${t('歌名（可选）')} value=${songname} onInput=${(e) => setSongname(e.target.value)} />
      <${Button} size="sm" disabled=${busy || !songmid.trim()} onClick=${play}>${t('点播')}<//>
    </div>` : null}
  </div>`;
}
/** 播放器主面板。 */
export function PlayerPanel({ open, onClose }) {
  const [tab, setTab] = useState('builtin');
  const [playing, setPlaying] = useState('');
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
  const playUrl = (url, label) => {
    audio.playTrack({ url }, 'ext:' + label);
    setPlaying('ext:' + label);
  };
  const stopAndAuto = () => {
    audio.clearManualBgm();
    audio.playBgm(null); // 交还阶段自动（install 的 sync 在下次状态变化时重新选曲）
    setPlaying('');
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
        <${Button} size="sm" variant="ghost" onClick=${stopAndAuto}>${t('回到自动 BGM')}<//>
      </div>
      ${tab === 'builtin' ? html`<div class="ptab">
        <p class="phint">${t('游戏内置配乐（随客户端已下载，零额外流量）。播放中不受阶段切换影响，点「回到自动 BGM」恢复。')}</p>
        <${SearchBox} value=${q} onChange=${setQ} placeholder=${t('搜索曲目…')} />
        ${shownBuiltin.length ? shownBuiltin.map((tr) => html`<${TrackRow} key=${tr.key} track=${tr} cover=${null}
          playing=${playing === tr.key || (audio.manualBgm && audio.manualBgm.label === tr.key)}
          onPlay=${() => { setPlaying(tr.key); playBuiltin(tr); }} />`) : html`<p class="phint">${t('没有匹配的曲目。')}</p>`}
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
          ${(album.songs || []).length ? (album.songs || []).map((s) => html`<${TrackRow} key=${s.cid} track=${{ name: s.name, artist: (s.artistes || []).join(' / '), album: album.name }}
            cover=${album.coverUrl}
            playing=${!!(audio.manualBgm && String(audio.manualBgm.label || '').startsWith('siren:' + s.cid))}
            onPlay=${() => { setSirenErr(''); playSirenSong(s.cid, s.name).then(() => setPlaying('siren:' + s.cid)).catch((e) => setSirenErr(String(e && e.message ? e.message : e))); }} />`) : html`<p class="phint">${t('这张专辑没有曲目。')}</p>`}
        ` : null}
        ${!album && shownAlbums ? (shownAlbums.length ? shownAlbums.map((a) => html`<${TrackRow} key=${a.cid} track=${{ name: a.name, artist: (a.artistes || []).join(' / ') }}
          cover=${a.coverUrl} playing=${false} hint=${albumBusy === a.cid ? t('加载中…') : t('点击查看曲目')}
          onPlay=${() => openAlbum(a)} />`) : html`<p class="phint">${t('列表里没有匹配的专辑。')}</p>`) : null}
        ${!album && shownAlbums && qq && !shownAlbums.length && remote && remote.length ? html`<p class="phint">${t('服务器搜索到 {n} 张相关专辑：', { n: remote.length })}</p>
          ${remote.map((a) => html`<${TrackRow} key=${a.cid} track=${{ name: a.name, artist: (a.artistes || []).join(' / ') }}
            cover=${a.coverUrl} playing=${false} hint=${albumBusy === a.cid ? t('加载中…') : t('点击查看曲目')}
            onPlay=${() => openAlbum(a)} />`)}` : null}
      </div>` : null}
      ${tab === 'custom' ? html`<${CustomSourceTab} onPlayUrl=${playUrl} />` : null}
    </div>
  <//>`;
}

/** 全局点歌台宿主 —— main.js 挂一次；未打开时渲染为空（不加载任何数据）。 */
export function PlayerHost() {
  const { open } = useStore((s) => s, Object.is, playerStore);
  if (!open) return null;
  return html`<${PlayerPanel} open=${true} onClose=${closePlayer} />`;
}