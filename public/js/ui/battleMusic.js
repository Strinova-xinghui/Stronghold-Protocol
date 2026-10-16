// public/js/ui/battleMusic.js — 自研（2026-10-16）**战斗音乐替换**的独立 UI（内部功能，与点歌台解耦）。
//
// 与点歌台（ui/player.js，公开功能，随撤回/等待一起发布）的关系：
//   * 零 import：本文件不 import player.js，player.js 也不 import 本文件；唯一交点是 audio.js 的选曲顺序。
//   * 独立入口 / 独立浮层 / 独立样式（bm-* 前缀）/ 独立文件 —— 可以单独决定发布与演进节奏。
//   * 语义边界：点歌台 = 玩家主动听歌；本面板 = 改「默认战斗音乐」（不点歌时自动放什么）。
//     玩家一点歌就以点歌为准（audio.js installAudio 的 manualBgm 提前 return，回归锁见 tools/custom-bgm.test.mjs）。
//
// 面板只做一件事：给「常规战斗轮 / BOSS 轮 / 所有作战期」各配一个**曲目池**（可多选 = 随机），
// 存进本地偏好（battleMusicStore.js）；服务器侧的全局池在 /console 控制台配。

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Button, Modal } from './components.js';
import { createStore, useStore } from '../store.js';
import { t } from '../../../shared/i18n.js';
import { readPersonalBgm, writePersonalBgm, fetchCustomBgmList } from '../battleMusicStore.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

// ---- 全局开关（main.js 挂 BattleMusicHost；各屏的入口按钮都调 openBattleMusic()）------------------------
const bmStore = createStore({ open: false });
/** 打开「战斗音乐替换」面板。 */
export function openBattleMusic() { bmStore.set({ open: true }); }
/** 关闭面板。 */
export const closeBattleMusic = () => bmStore.set({ open: false });

// ---- 轮次类型（与服务器规则、audio.js 的 scope 同口径）------------------------------------------------
// BOSS 回合号会随「开不开加时赛」变（官方 14/15，开了加时赛顺延 18/19），所以按**类型**配，不按回合号。
const ROWS = [
  { key: 'combat', label: '常规战斗轮', hint: '每个非 BOSS 的战斗回合' },
  { key: 'boss', label: 'BOSS 轮（最终攻势 / 隐秘核心）', hint: 'BOSS 战' },
  { key: '*', label: '所有作战期', hint: '以上两种都覆盖' },
];

/** 战斗音乐替换面板。 */
export function BattleMusicPanel({ open, onClose }) {
  const [map, setMap] = useState(() => readPersonalBgm());
  const [items, setItems] = useState(null);
  const [err, setErr] = useState('');
  const [openKey, setOpenKey] = useState('boss'); // 默认展开 BOSS 轮
  useEffect(() => {
    if (!open) return undefined;
    const ac = new AbortController();
    fetchCustomBgmList(ac.signal).then(setItems);
    return () => ac.abort();
  }, [open]);
  const save = (next) => { setMap(next); if (!writePersonalBgm(next)) setErr(t('保存失败（浏览器存储不可用）')); else setErr(''); };
  /** 勾选/取消一首（池多选）：空池 = 删除该轮次条目（交还全局/官方）。 */
  const toggle = (key, stem) => {
    const cur = Array.isArray(map[key]) ? map[key].slice() : [];
    const i = cur.indexOf(stem);
    if (i >= 0) cur.splice(i, 1); else cur.push(stem);
    const next = { ...map };
    if (cur.length) next[key] = cur; else delete next[key];
    save(next);
  };
  const nameOf = (stem) => { const it = (items || []).find((x) => x.stem === stem); return (it && it.name) || stem; };
  const list = items || [];
  const cur = Array.isArray(map[openKey]) ? map[openKey] : [];
  return html`<${Modal} open=${open} onClose=${onClose} title=${t('战斗音乐替换')} wide=${true}>
    <div class="bm">
      <p class="phint">${t('改的是「默认战斗音乐」：不点歌时，作战期自动放什么。你自己点歌播放时一切以点歌为准，不会被这里覆盖。只影响你这台设备。')}</p>
      <p class="phint">${t('按轮次类型配：勾选多首 = 随机池（每次都从里面随机一首）。留空 = 用控制台的全局设置或官方日程。')}</p>
      ${err ? html`<p class="perr">${err}</p>` : null}
      ${items === null ? html`<p class="phint">${t('加载中…')}</p>` : null}
      ${items !== null && !list.length ? html`<p class="phint">${t('服务器上还没有自定义曲目。请管理员在 /console 的「BOSS音乐」页上传音乐文件后，这里就能选。')}</p>` : null}
      ${list.length ? html`<div class="bm-list">
        ${ROWS.map((row) => {
          const pool = Array.isArray(map[row.key]) ? map[row.key] : [];
          return html`<div key=${row.key} class=${cx('bm-row', openKey === row.key && 'is-open')}>
            <button type="button" class="bm-head" onClick=${() => setOpenKey(openKey === row.key ? '' : row.key)}>
              <span class="bm-title">${t(row.label)}<small>${t(row.hint)}</small></span>
              <small class="bm-pool">${pool.length ? pool.map(nameOf).join(' / ') : t('（不替换）')}</small>
            </button>
            ${openKey === row.key ? html`<div class="bm-picks">
              ${list.map((it) => html`<button key=${it.stem} type="button" class=${cx('bm-chip', cur.includes(it.stem) && 'is-on')}
                onClick=${() => toggle(row.key, it.stem)} aria-pressed=${String(cur.includes(it.stem))}>${it.name || it.stem}</button>`)}
            </div>` : null}
          </div>`;
        })}
      </div>` : null}
      ${Object.keys(map).length ? html`<div class="bm-foot"><${Button} size="sm" variant="ghost" onClick=${() => save({})}>${t('全部清除（交还全局/官方）')}<//></div>` : null}
    </div>
  <//>`;
}

/** 全局宿主 —— main.js 挂一次；未打开时不渲染任何内容、不发请求。 */
export function BattleMusicHost() {
  const { open } = useStore((s) => s, Object.is, bmStore);
  if (!open) return null;
  return html`<${BattleMusicPanel} open=${true} onClose=${closeBattleMusic} />`;
}
