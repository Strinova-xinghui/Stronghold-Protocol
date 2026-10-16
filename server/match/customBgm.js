// server/match/customBgm.js — 自研（2026-10-16）BOSS 战替换曲目的**文件仓库**（管理员上传的音乐）。
//
// 用户需求：把「自己的音乐文件」变成 BOSS 战/指定回合的替换曲，且**全局（控制台）替换 + 个人（客户端）替换，
// 个人优先**。本模块只管磁盘上的文件与元数据（谁都能读；写入只经控制台认证的路由）：
//
//   public/custom-bgm/<stem>.<ext>     ← 音频本体（ext ∈ shared/media.js AUDIO_EXTS）
//   public/custom-bgm/index.json       ← [{ stem, name, ext, size, mtimeMs, addedAt }]（展示名/上传时间）
//
// 为什么放 public/custom-bgm 而不是 public/assets：
//   * 素材目录由 tools/setup.mjs 维护、进内容哈希索引（assetIndex）——管理员随时增删的文件放进去会让索引
//     反复失效重建；独立目录 + no-cache（server/http/media.js serveCustomBgm）最简单也最稳。
//   * 服务器内存/流量零新增：音频是磁盘静态文件，客户端按需拉取（与官方 BGM 同一套 /media 无扩展名通道 +
//     audio.js 的 _buffer/LRU），服务器不预载、不解码、不转码。
//
// 安全边界（这是唯一接受「用户内容」落盘的入口）：
//   * stem 白名单正则（无点/斜杠/空格 ⇒ 无路径穿越、无隐藏文件）；
//   * 扩展名白名单（AUDIO_EXTS）；
//   * 单文件体积上限（默认 24 MB，可由调用方覆盖）；
//   * 只写 public/custom-bgm 目录内，且写入用临时文件 + rename（原子，半截文件不会被读到）。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AUDIO_EXTS } from '../../shared/media.js';

/** 上传目录名（相对 public/）：与 server/http/media.js 的 CUSTOM_BGM_DIR 必须一致。
 *  URL 前缀 /media/cbgm/<stem> 同名，避免「URL 段 ≠ 目录名」的分支判断错误。 */
export const CUSTOM_BGM_DIR = 'cbgm';
/** 单文件默认上限：24 MB（一首 320k 的 5 分钟曲 ≈ 12 MB，留一倍余量）。 */
export const MAX_BGM_BYTES = 24 * 1024 * 1024;
/** 曲目总数上限：防止把磁盘塞满（每首 ≤24MB ⇒ 最多约 480MB）。 */
export const MAX_BGM_COUNT = 40;
/** 合法 stem：字母数字下划线连字符，1–64。与 media.js 的 CBGM_STEM 保持一致。 */
const STEM_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** 索引文件名（不是音频；列目录时跳过）。 */
const INDEX_FILE = 'index.json';

/** @param {string} publicDir @returns {string} public/custom-bgm 绝对路径 */
export function customBgmDir(publicDir) {
  return path.join(path.resolve(publicDir), CUSTOM_BGM_DIR);
}

/** 展示名清理：去掉控制字符与路径分隔符，限长 60；空则回落到 stem。 */
function cleanName(name, stem) {
  const s = String(name == null ? '' : name).replace(/[\u0000-\u001f\u007f/\\]/g, ' ').trim().slice(0, 60);
  return s || stem;
}

/** 读索引（坏文件/缺失 ⇒ {}）；返回 Map<stem, meta>。 */
function readIndex(dir) {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(dir, INDEX_FILE), 'utf8'));
    const map = new Map();
    for (const e of Array.isArray(arr) ? arr : []) {
      if (e && typeof e.stem === 'string' && STEM_RE.test(e.stem)) map.set(e.stem, e);
    }
    return map;
  } catch { return new Map(); }
}

/** 写索引（原子；失败静默——索引只是展示元数据，丢了不影响播放）。 */
async function writeIndex(dir, map) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, INDEX_FILE + '.tmp');
    await fsp.writeFile(tmp, JSON.stringify([...map.values()], null, 1));
    await fsp.rename(tmp, path.join(dir, INDEX_FILE));
  } catch { /* best-effort */ }
}

/**
 * 列出目录里真实存在的自定义曲目（**以磁盘为准**，索引只补展示名/上传时间）。
 * 这样手工 scp 上去的文件也会出现在控制台里（用户「我放本地你代传」的路径同样可用）。
 * @param {string} publicDir
 * @returns {Promise<{ stem: string, name: string, ext: string, size: number, mtimeMs: number, addedAt: number }[]>}
 */
export async function listCustomBgm(publicDir) {
  const dir = customBgmDir(publicDir);
  const idx = readIndex(dir);
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out = [];
  for (const fn of names) {
    if (fn === INDEX_FILE || fn.endsWith('.tmp') || fn.startsWith('.')) continue;
    const ext = path.extname(fn).toLowerCase();
    if (!AUDIO_EXTS.includes(ext)) continue;
    const stem = fn.slice(0, -ext.length);
    if (!STEM_RE.test(stem)) continue;
    let st;
    try { st = await fsp.stat(path.join(dir, fn)); } catch { continue; } // eslint-disable-line no-await-in-loop
    if (!st.isFile()) continue;
    const meta = idx.get(stem) || {};
    out.push({ stem, name: cleanName(meta.name, stem), ext, size: st.size, mtimeMs: st.mtimeMs, addedAt: Number(meta.addedAt) || Math.round(st.mtimeMs) });
  }
  out.sort((a, b) => a.stem.localeCompare(b.stem));
  return out;
}

/** 一个 stem 是否已存在（任一扩展名）。 */
export async function customBgmExists(publicDir, stem) {
  if (!STEM_RE.test(String(stem || ''))) return false;
  const dir = customBgmDir(publicDir);
  for (const ext of AUDIO_EXTS) {
    try { if ((await fsp.stat(path.join(dir, stem + ext))).isFile()) return true; } catch { /* next */ } // eslint-disable-line no-await-in-loop
  }
  return false;
}

/**
 * 保存一个上传的曲目（原子写 + 索引）。
 * @param {string} publicDir
 * @param {{ stem: string, ext: string, name?: string, buf: Buffer }} p
 * @returns {Promise<{ ok: true, item: object } | { ok: false, error: string }>}
 */
export async function saveCustomBgm(publicDir, { stem, ext, name, buf }) {
  const s = String(stem || '').trim();
  const e = String(ext || '').toLowerCase();
  if (!STEM_RE.test(s)) return { ok: false, error: '文件名只能是字母/数字/下划线/连字符（1–64 字）' };
  if (!AUDIO_EXTS.includes(e)) return { ok: false, error: '只支持 ' + AUDIO_EXTS.join(' / ') };
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, error: '空文件' };
  if (buf.length > MAX_BGM_BYTES) return { ok: false, error: '文件过大（>' + Math.round(MAX_BGM_BYTES / 1024 / 1024) + 'MB）' };
  const dir = customBgmDir(publicDir);
  try {
    await fsp.mkdir(dir, { recursive: true });
    // 同名换扩展名（mp3 → m4a）时把旧文件清掉，避免 /media/cbgm/<stem> 命中旧字节。
    for (const other of AUDIO_EXTS) {
      if (other === e) continue;
      try { await fsp.unlink(path.join(dir, s + other)); } catch { /* absent */ } // eslint-disable-line no-await-in-loop
    }
    const tmp = path.join(dir, s + e + '.tmp');
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, path.join(dir, s + e));
    const idx = readIndex(dir);
    const prev = idx.get(s) || {};
    idx.set(s, { stem: s, name: cleanName(name, s), ext: e, size: buf.length, addedAt: Number(prev.addedAt) || Date.now() });
    await writeIndex(dir, idx);
    const list = await listCustomBgm(publicDir);
    return { ok: true, item: list.find((x) => x.stem === s) || { stem: s, name: cleanName(name, s), ext: e, size: buf.length, mtimeMs: Date.now(), addedAt: Date.now() } };
  } catch (err) {
    return { ok: false, error: '写入失败：' + (err && err.message ? err.message : err) };
  }
}

/**
 * 删除一个曲目（全部扩展名 + 索引项）。
 * @param {string} publicDir @param {string} stem
 * @returns {Promise<{ ok: boolean, removed: string[] }>}
 */
export async function removeCustomBgm(publicDir, stem) {
  const s = String(stem || '');
  if (!STEM_RE.test(s)) return { ok: false, removed: [] };
  const dir = customBgmDir(publicDir);
  const removed = [];
  for (const ext of AUDIO_EXTS) {
    try { await fsp.unlink(path.join(dir, s + ext)); removed.push(s + ext); } catch { /* absent */ } // eslint-disable-line no-await-in-loop
  }
  const idx = readIndex(dir);
  if (idx.delete(s)) await writeIndex(dir, idx);
  return { ok: removed.length > 0, removed };
}

/** 上传前的总数闸：已达上限且是新 stem ⇒ 拒绝（覆盖已有允许）。 */
export async function customBgmCapacity(publicDir, stem) {
  const list = await listCustomBgm(publicDir);
  if (list.length < MAX_BGM_COUNT) return { ok: true };
  if (list.some((x) => x.stem === stem)) return { ok: true };
  return { ok: false, error: '自定义曲目已达上限 ' + MAX_BGM_COUNT + ' 首，请先删除一些' };
}
