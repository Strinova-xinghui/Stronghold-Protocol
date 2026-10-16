// public/js/battleMusicStore.js — 自研（2026-10-16）**战斗音乐替换**的本地存储层（与 UI 解耦）。
//
// 这是「内部功能」：只在默认/自动战斗音乐上做替换，**与点歌台（公开功能，随撤回/等待一起发布）完全解耦**——
// 本文件不 import 任何 UI/preact，点歌台也不 import 本文件；两边唯一的交点只是 audio.js 的选曲顺序
// （点歌优先：audio.installAudio 的 sync 里 `if (audio.manualBgm) return;` 在一切自动选曲之前）。
//
// 职责：读写浏览器本地偏好 + 确定性选曲。**不做**任何网络请求之外的副作用（拉曲目列表除外，那是只读 GET）。
//
// 数据形态：localStorage['sp_personal_bgm'] = { 'combat'|'boss'|'*': [stem…] }
//   - 键 = **轮次类型**（2026-10-16 晚改：BOSS 回合号会随开不开加时赛变，16/15 ↔ 18/19，不能按号匹配）
//   - 值 = **曲目池**（数组；单首也是 1 元池）。旧版按回合号的数字键与单字符串值仍兼容读取。
//   - 优先级（audio.js 的选曲链）：点歌台 > 个人池（本文件） > 全局池（服务器 bossBgm） > 官方日程。

/** localStorage 键（保持历史键名：换名字会让老用户的既有设置失效）。 */
export const LS_KEY = 'sp_personal_bgm';
/** stem 合法性（与 audio.js / server/match/customBgm.js 一致）。 */
const STEM_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 键合法性：轮次类型 'combat' | 'boss'、通配 '*'，或旧版的回合号 1–200。 */
const KEY_RE = /^(combat|boss|\*|[0-9]{1,3})$/;
/** 单个池的曲目上限（防 localStorage 被写爆）。 */
const MAX_POOL = 16;

/** 一个值的合法曲目池：字符串或字符串数组，逐项校验，去重，截断到 MAX_POOL。 */
function cleanPool(v) {
  const arr = Array.isArray(v) ? v : [v];
  const out = [];
  for (const x of arr) {
    if (typeof x !== 'string' || !STEM_RE.test(x)) continue;
    if (!out.includes(x)) out.push(x);
    if (out.length >= MAX_POOL) break;
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

/** 写映射（空映射 = 删除键，交还全局/官方）。@returns {boolean} 是否写入成功 */
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
 * 个人池只影响本机 ⇒ 无需服务器参与；但同一局同一轮次必须稳定（视图/阶段变化会多次调用，
 * 不稳定会一边打一边换歌），所以用 `matchKey:scope:池内容` 派生确定性索引：
 * 同局同轮次恒定、不同局有变化。单首池直接返回该首。
 * @param {string[]} pool
 * @param {string} scope 'combat' | 'boss'（进哈希，使两种轮次互不干扰）
 * @param {string} [matchKey] 对局标识（同局恒定即可；客户端拿不到 match.seed，用开赛时间/房间码）
 * @returns {string|null}
 */
export function pickFromPool(pool, scope, matchKey = '') {
  if (!Array.isArray(pool) || !pool.length) return null;
  if (pool.length === 1) return pool[0];
  const s = `${matchKey}:${scope || ''}:${pool.join(',')}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h = (h ^ s.charCodeAt(i)) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; }
  return pool[h % pool.length];
}

/**
 * 从本地偏好里选出本局本轮次的曲目 stem（audio.js 的选曲用）。
 * 优先级：轮次类型键 → 旧版回合号键 → 通配 '*'。
 * @param {'combat'|'boss'|null} scope
 * @param {number|null|undefined} round 只给旧版回合号键用
 * @param {string} [matchKey]
 * @returns {string|null} 曲目 stem（不含 cbgm:/x: 前缀）或 null
 */
export function pickPersonalPool(scope, round, matchKey = '') {
  const map = readPersonalBgm();
  const r = Number(round);
  let pool = (scope === 'boss' || scope === 'combat') ? (map[scope] || []) : [];
  if (!pool.length && scope != null && Number.isFinite(r)) pool = map[String(r)] || [];
  if (!pool.length) pool = map['*'] || [];
  if (!pool.length) return null;
  return pickFromPool(pool, scope || 'r' + (Number.isFinite(r) ? r : ''), matchKey);
}

/** 是否有任何个人偏好（UI 用来决定是否显示「已启用」标记）。 */
export function hasPersonalBgm() {
  return Object.keys(readPersonalBgm()).length > 0;
}

/**
 * 拉取服务器上可用的自定义曲目（公开只读接口 /music/bgm-list；失败 ⇒ []）。
 * 注意：这是本模块唯一的网络行为，且是 GET；audio.js 不调用它（选曲不需要列表）。
 * @param {AbortSignal} [signal]
 * @returns {Promise<{stem: string, name: string, ext: string, size: number}[]>}
 */
export async function fetchCustomBgmList(signal) {
  try {
    const r = await fetch('/music/bgm-list', { signal });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.items) ? j.items.filter((x) => x && STEM_RE.test(String(x.stem))) : [];
  } catch { return []; }
}
