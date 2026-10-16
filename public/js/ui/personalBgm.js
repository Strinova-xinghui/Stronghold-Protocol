// public/js/ui/personalBgm.js — 自研（2026-10-16）**个人 BOSS 战 BGM 替换**（客户端本地，最高优先级）。
//
// 用户需求原文：「我追求控制台可全局替换，但个人优先级更高，若同时在客户端启用指定替换则优先个人」。
// 三层优先级（audio.js installAudio 的选曲）：
//   ① 个人替换（本文件，localStorage，只影响本机） > ② 全局替换（控制台 bossBgm，服务器下发，全房同曲）
//   > ③ 官方日程（1–7 无畏者 / 8+ 骑士之日 / BOSS 领袖曲）。
//
// 本文件只做两件事：
//   * 读写 localStorage 的 { '<round>': '<stem>' | '*': '<stem>' } 映射（'*' = 所有作战期都用这首）；
//   * 渲染「我的 BOSS 战音乐」面板：列出服务器上已有的自定义曲目（/console/api/bgm 的只读子集？——不，
//     控制台要密码，客户端读的是公开的 /music/bgm-list），让用户挑一首 + 选回合，存进 localStorage。
//
// 为什么个人替换不走服务器：换自己的 BGM 是纯粹的本地偏好，写服务器会牵连全房玩家（且控制台已有全局通道）。
// 个人曲目 = 管理员上传到 public/custom-bgm 的同一批文件（/media/cbgm/<stem>），所以「客户端指定」也需要
// 服务器上先有该文件——这样音频来源始终是可信的同源静态文件，客户端不引入任意外链。

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Icon, Button } from './components.js';
import { t } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

const LS_KEY = 'sp_personal_bgm';
/** 'cbgm:<stem>' 的 stem 合法性（与 audio.js / server 侧一致）。 */
const STEM_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 键合法性：'*'（所有作战期）或回合号 1–200。 */
const KEY_RE = /^([0-9]{1,3}|\*)$/;

/** 一个值的合法曲目池：字符串或字符串数组，逐项过 STEM_RE，去重，最多 16 首。 */
function cleanPool(v) {
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  for (const x of arr) {
    if (typeof x !== 'string' || !STEM_RE.test(x)) continue;
    if (!out.includes(x)) out.push(x);
    if (out.length >= 16) break;
  }
  return out;
}

/** 读映射（坏数据 ⇒ {}）。值是**曲目池**（数组，长度 1 = 单曲）。 */
export function readPersonalBgm() {
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!KEY_RE.test(k)) continue;
      const pool = cleanPool(v);
      if (pool.length) out[k] = pool;
    }
    return out;
  } catch { return {}; }
}

/** 写映射（空映射 = 删除键，回落全局/官方）。 */
export function writePersonalBgm(map) {
  try {
    const clean = {};
    for (const [k, v] of Object.entries(map || {})) {
      if (!KEY_RE.test(k)) continue;
      const pool = cleanPool(v);
      if (pool.length) clean[k] = pool;
    }
    if (Object.keys(clean).length) localStorage.setItem(LS_KEY, JSON.stringify(clean));
    else localStorage.removeItem(LS_KEY);
    return true;
  } catch { return false; }
}

/**
 * 本回合该用个人池里的哪一首（**客户端本地确定性随机**）。
 * 个人替换本来就只影响本机，所以这里不需要服务器参与；但同一回合内必须稳定
 * （视图/阶段变化会多次调用），故用「对局标识 + 回合 + 池内容」派生一个确定性索引：
 * 同一局同一回合恒定 ⇒ 不会一边打一边换歌；不同局/不同回合会变 ⇒ 保留随机感。
 * @param {string[]} pool 个人池（≥1 首）
 * @param {number|null|undefined} round
 * @param {string} [matchKey] 对局标识（客户端拿不到 match.seed，用 session/房间码/开赛时间戳等任一稳定串）
 * @returns {string|null} 选中的 stem
 */
export function pickFromPool(pool, round, matchKey = '') {
  if (!Array.isArray(pool) || !pool.length) return null;
  if (pool.length === 1) return pool[0];
  const s = `${matchKey}:${Number(round) || 0}:${pool.join(',')}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h = (h ^ s.charCodeAt(i)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; }
  return pool[h % pool.length];
}

/** 拉取服务器上可用的自定义曲目（公开只读接口；失败返回 []）。 */
export async function fetchCustomBgmList(signal) {
  try {
    const r = await fetch('/music/bgm-list', { signal });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.items) ? j.items.filter((x) => x && STEM_RE.test(String(x.stem))) : [];
  } catch { return []; }
}

/** 个人 BGM 面板（挂在播放器面板的一个 tab 里）。 */
export function PersonalBgmTab() {
  const [map, setMap] = useState(() => readPersonalBgm());
  const [items, setItems] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const ac = new AbortController();
    fetchCustomBgmList(ac.signal).then(setItems);
    return () => ac.abort();
  }, []);
  const [openKey, setOpenKey] = useState('18'); // 当前展开编辑的回合（默认 BOSS 回合）
  const save = (next) => { setMap(next); if (!writePersonalBgm(next)) setErr(t('保存失败（浏览器存储不可用）')); else setErr(''); };
  /** 勾选/取消一首（池多选）：空池 = 删除该回合条目（回落全局/官方）。 */
  const toggle = (round, stem) => {
    const cur = Array.isArray(map[round]) ? map[round].slice() : [];
    const i = cur.indexOf(stem);
    if (i >= 0) cur.splice(i, 1); else cur.push(stem);
    const next = { ...map };
    if (cur.length) next[round] = cur; else delete next[round];
    save(next);
  };
  if (items === null) return html`<div class="ptab"><p class="phint">${t('加载中…')}</p></div>`;
  if (!items.length) {
    return html`<div class="ptab">
      <p class="phint">${t('服务器上还没有自定义曲目。请管理员在 /console 的「BOSS音乐」页上传音乐文件后，这里就能选。')}</p>
    </div>`;
  }
  const nameOf = (stem) => { const it = items.find((x) => x.stem === stem); return (it && it.name) || stem; };
  const rows = [
    { key: '*', label: t('所有作战期') },
    ...[1, 5, 8, 13, 18, 19].map((n) => ({ key: String(n), label: t('第 {n} 回合', { n }) })),
  ];
  const cur = Array.isArray(map[openKey]) ? map[openKey] : [];
  return html`<div class="ptab">
    <p class="phint">${t('个人替换：只影响你这台设备，优先于控制台的全局替换。勾选多首 = 随机池（本回合作战期从中随机一首）。全不勾 = 用全局/官方日程。')}</p>
    ${err ? html`<p class="perr">${err}</p>` : null}
    <div class="pbgm-list">
      ${rows.map((row) => {
        const pool = Array.isArray(map[row.key]) ? map[row.key] : [];
        return html`<div key=${row.key} class=${cx('pbgm-row', openKey === row.key && 'is-open')}>
          <button type="button" class="pbgm-round" onClick=${() => setOpenKey(openKey === row.key ? '' : row.key)}>
            <span>${row.label}</span>
            <small>${pool.length ? pool.map(nameOf).join(' / ') : t('（不替换）')}</small>
          </button>
          ${openKey === row.key ? html`<div class="pbgm-picks">
            ${items.map((it) => html`<button key=${it.stem} type="button" class=${cx('pchip', cur.includes(it.stem) && 'is-on')}
              onClick=${() => toggle(row.key, it.stem)} aria-pressed=${String(cur.includes(it.stem))}>${it.name || it.stem}</button>`)}
          </div>` : null}
        </div>`;
      })}
    </div>
    ${Object.keys(map).length ? html`<div class="prow"><${Button} size="sm" variant="ghost" onClick=${() => save({})}>${t('全部清除')}<//></div>` : null}
  </div>`;
}
