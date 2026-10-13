// 皮肤资产持久化单测（0.2.5 事故回归网）：
//   根因 1 —— 数据重建后忘了重跑 tools/inject-skins-assets.mjs，174 条皮肤条目从 data/assets.json 丢失；
//   根因 2 —— tools/package.mjs artPlan() 在清单未注入时把磁盘皮肤全判成 orphans，部署包永远缺皮肤。
// 用法: node --test tools/skins-pack.test.mjs
// 只读 data/ 与 public/，绝不写；不执行 injectSkins（那会重写 data/assets.json）。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artPlan, skinArtFiles, manifestFiles } from './package.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AVATAR_DIR = 'public/assets/char/skin_avatar/';
const SKIN_PREFIX = 'public/assets/spine/op/';
/** public/assets/spine/op/<charId>/<stem>/<front|back>/<file> —— 皮肤 spine 的目录层级（干员原皮只有 op/<charId>/<side>/）。 */
const isSkinSpine = (f) => {
  if (!f.startsWith(SKIN_PREFIX)) return false;
  const parts = f.split('/');
  return parts.length >= 7 && (parts[6] === 'front' || parts[6] === 'back');
};

// —— 现文件基线（已注入：115 名干员 / 174 套皮肤 / 172 带 spine）——
const assets = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'assets.json'), 'utf8'));
const skinChars = Object.values(assets.chars).filter((c) => c.skins && Object.keys(c.skins).length).length;
const skinEntries = Object.values(assets.chars).flatMap((c) => Object.values(c.skins ?? {}));
const avatarUrls = skinEntries.filter((s) => typeof s.avatar === 'string' && s.avatar.includes('skin_avatar')).length;
const spineSkins = skinEntries.filter((s) => s.spine).length;

// —— artPlan 是纯函数（root 参数），跑一次全模块共享 ——
const plan = artPlan(ROOT);

describe('注入后的 data/assets.json 皮肤条目', () => {
  test('chars with skins > 100', () => {
    assert.ok(skinChars > 100, '带皮肤的干员数应 > 100，实际 ' + skinChars);
  });

  test('皮肤条目与 stats 一致', () => {
    assert.equal(skinEntries.length, assets.stats.skins, 'stats.skins 与实际皮肤条目数一致');
    assert.equal(skinChars, assets.stats.charsWithSkins, 'stats.charsWithSkins 与实际一致');
    assert.ok(skinEntries.length >= 174, '皮肤条目应 >= 174，实际 ' + skinEntries.length);
  });

  test('皮肤 avatar 与 spine URL 齐全', () => {
    assert.equal(avatarUrls, skinEntries.length, '每套皮肤都有 skin_avatar 头像 URL');
    assert.ok(spineSkins > 150, '带 spine 的皮肤应 > 150（基线 172），实际 ' + spineSkins);
  });
});

describe('artPlan · 皮肤素材进包', () => {
  test('files 包含全部 skin_avatar（>= 100）', () => {
    const av = plan.files.filter((f) => f.startsWith(AVATAR_DIR));
    assert.ok(av.length >= 100, 'skin_avatar 文件应 >= 100，实际 ' + av.length);
    assert.equal(av.length, 174, '基线：174 张皮肤头像全收');
  });

  test('files 包含皮肤 spine 文件（skel/atlas/png）', () => {
    const sp = plan.files.filter(isSkinSpine);
    assert.ok(sp.length > 100, '皮肤 spine 文件应 > 100，实际 ' + sp.length);
    assert.ok(sp.some((f) => f.endsWith('.skel')), '含 .skel');
    assert.ok(sp.some((f) => f.endsWith('.atlas')), '含 .atlas');
    assert.ok(sp.some((f) => f.endsWith('.png')), '含 .png');
  });

  test('磁盘上的皮肤文件一个都不缺（missing 不含皮肤）', () => {
    assert.equal(plan.missing.filter((f) => f.startsWith(AVATAR_DIR)).length, 0, 'missing 不应有 skin_avatar');
    assert.equal(plan.missing.filter(isSkinSpine).length, 0, 'missing 不应有皮肤 spine');
  });

  test('orphans 不含任何皮肤文件', () => {
    assert.equal(plan.orphans.filter((f) => f.startsWith(AVATAR_DIR)).length, 0, 'orphans 无 skin_avatar');
    assert.equal(plan.orphans.filter(isSkinSpine).length, 0, 'orphans 无皮肤 spine');
  });
});

describe('skinArtFiles · 独立于清单的兜底（根因 2 回归网）', () => {
  // 内存里剥掉 skins（模拟「重建后未注入」），skin_avatar 整目录收集仍应成立。
  const bare = JSON.parse(JSON.stringify(assets));
  for (const c of Object.values(bare.chars)) delete c.skins;

  test('manifestFiles 不认剥皮后的清单（这正是旧 artPlan 判 orphans 的原因）', () => {
    const listed = manifestFiles(bare);
    assert.equal([...listed].some((f) => f.startsWith(AVATAR_DIR)), false, '剥掉 skins 后清单里没有任何皮肤 URL');
  });

  test('skinArtFiles 整目录收集：剥掉 skins 后仍收 174 张头像', () => {
    const got = skinArtFiles(ROOT, bare);
    const av = [...got].filter((f) => f.startsWith(AVATAR_DIR));
    assert.equal(av.length, 174, '剥掉 skins 后仍应收 174 张头像，实际 ' + av.length);
  });

  test('skinArtFiles 在有 skins 清单时收齐 spine（1023 个 skel+atlas+png）', () => {
    const full = skinArtFiles(ROOT, assets);
    const sp = [...full].filter(isSkinSpine);
    assert.ok(sp.length > 100, '完整清单收皮肤 spine，实际 ' + sp.length);
    assert.equal(sp.length, 1023, '基线：172 前 + 169 后 x (skel+atlas+png) = 1023');
    assert.equal(full.size, 1197, '基线：174 头像 + 1023 spine = 1197');
  });

  test('skinArtFiles 宽容缺失：磁盘上不存在的皮肤文件跳过', () => {
    const fake = { chars: { char_nope: { skins: { s1: { spine: { front: { skel: '/assets/spine/op/char_nope/s1/front/s1.skel' } } } } } } };
    const got = skinArtFiles(ROOT, fake);
    assert.equal([...got].some((f) => f.includes('char_nope')), false, '不存在的皮肤文件被跳过');
    assert.ok([...got].some((f) => f.startsWith(AVATAR_DIR)), '整目录收集不受假条目影响');
  });
});

describe('数据重建链挂载（根因 1 回归网，源码静态断言，不执行注入）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'fetch-assets.mjs'), 'utf8');

  test('fetch-assets.mjs 写完 assets.json 后挂载 injectSkins', () => {
    assert.ok(src.includes('if (guard.write) injectSkins(log);'), '写盘点之后调用 injectSkins');
    assert.ok(src.includes('spawnSync(process.execPath, [INJECT_SKINS_TOOL]'), '以子进程执行 inject-skins-assets.mjs');
  });

  test('08-skins.json 缺失时容错跳过，不让重建失败', () => {
    assert.ok(src.includes('if (!existsSync(SKINS_RESEARCH))'), '先查 docs/research/08-skins.json');
    const fn = src.slice(src.indexOf('export function injectSkins'), src.indexOf('/**', src.indexOf('export function injectSkins') + 10));
    assert.equal(/throw|process\.exit/.test(fn), false, 'injectSkins 不 throw、不 exit（重建永不因此失败）');
    assert.ok(fn.includes('return false'), '失败分支只打日志并 return false');
  });

  test('注入的皮肤文件计入引用，防 orphans / --prune 误删', () => {
    assert.ok(src.includes('manifestSkinFiles(effective)'), '按注入后的清单扩展引用集合');
    assert.ok(src.includes('listFiles(join(ASSETS, SKIN_AVATAR_REL)'), 'skin_avatar 整目录计入引用');
  });

  test('shrink 守卫对皮肤免疫：重建不会因未注入的皮肤条目被拒', () => {
    assert.ok(src.includes('shrinkGuard(guardPrevWithoutImminentSkins(current), manifest, opts)'), '守卫比较前剥离即将注入的皮肤条目');
    // 免疫只在注入可执行时生效：注入脚本或研究表缺失时守卫照常报告皮肤丢失（那时是真丢）
    assert.ok(src.includes('if (!existsSync(INJECT_SKINS_TOOL) || !existsSync(SKINS_RESEARCH)) return prev;'), '注入不可运行时不免疫');
  });

  test('package.mjs artPlan 在 orphans 计算之前收集皮肤', () => {
    const pkgSrc = fs.readFileSync(path.join(ROOT, 'tools', 'package.mjs'), 'utf8');
    const iSkin = pkgSrc.indexOf('for (const f of skinArtFiles(root, assetsJson)) files.add(f);');
    const iOrphans = pkgSrc.indexOf("const orphans = listTree(root, 'public/assets')");
    assert.ok(iSkin > 0 && iOrphans > 0 && iSkin < iOrphans, '皮肤收集在 orphans 计算之前');
  });
});
