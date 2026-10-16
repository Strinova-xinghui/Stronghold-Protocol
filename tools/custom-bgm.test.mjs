// 自定义 BOSS 战 BGM（自研 2026-10-16）单测：文件仓库（存/列/删/上限/路径安全）+ bossBgm 规则的
// 内置 stem 与自定义 `x:<name>` 两种来源校验 + 个人替换优先级（audio.js 的 personalBgmKey 语义）。
// 用法: node --test tools/custom-bgm.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { listCustomBgm, saveCustomBgm, removeCustomBgm, customBgmCapacity, CUSTOM_BGM_DIR, MAX_BGM_BYTES } from '../server/match/customBgm.js';

/** 一个隔离的假 public 目录（不动真实仓库的 public/）。 */
let ROOT = '';
before(async () => { ROOT = await fsp.mkdtemp(path.join(os.tmpdir(), 'cbgm-')); });
after(async () => { try { await fsp.rm(ROOT, { recursive: true, force: true }); } catch { /* ignore */ } });

const bytes = (n, fill = 1) => Buffer.alloc(n, fill);

describe('自定义 BGM 文件仓库', () => {
  test('保存 → 列出 → 删除（含展示名与索引）', async () => {
    const r = await saveCustomBgm(ROOT, { stem: 'my_boss', ext: '.mp3', name: '我的 BOSS 战曲', buf: bytes(2048) });
    assert.ok(r.ok, r.error);
    assert.equal(r.item.stem, 'my_boss');
    assert.equal(r.item.name, '我的 BOSS 战曲');
    assert.equal(r.item.ext, '.mp3');
    assert.equal(r.item.size, 2048);
    const list = await listCustomBgm(ROOT);
    assert.equal(list.length, 1);
    assert.equal(list[0].stem, 'my_boss');
    // 磁盘上确实有文件，且索引存在
    assert.ok(fs.existsSync(path.join(ROOT, CUSTOM_BGM_DIR, 'my_boss.mp3')));
    assert.ok(fs.existsSync(path.join(ROOT, CUSTOM_BGM_DIR, 'index.json')));
    const del = await removeCustomBgm(ROOT, 'my_boss');
    assert.ok(del.ok);
    assert.deepEqual(await listCustomBgm(ROOT), []);
  });

  test('换扩展名时旧文件被清掉（/media/cbgm/<stem> 不会命中旧字节）', async () => {
    await saveCustomBgm(ROOT, { stem: 'swap', ext: '.mp3', buf: bytes(100) });
    assert.ok(fs.existsSync(path.join(ROOT, CUSTOM_BGM_DIR, 'swap.mp3')));
    await saveCustomBgm(ROOT, { stem: 'swap', ext: '.m4a', buf: bytes(200) });
    assert.ok(!fs.existsSync(path.join(ROOT, CUSTOM_BGM_DIR, 'swap.mp3')), '旧 mp3 已删');
    assert.ok(fs.existsSync(path.join(ROOT, CUSTOM_BGM_DIR, 'swap.m4a')), '新 m4a 在');
    await removeCustomBgm(ROOT, 'swap');
  });

  test('路径安全：非法 stem 一律拒绝（无穿越、无隐藏文件）', async () => {
    for (const bad of ['../evil', 'a/b', 'a.b', '.hidden', '', 'x'.repeat(65), 'a b', 'a\\b']) {
      const r = await saveCustomBgm(ROOT, { stem: bad, ext: '.mp3', buf: bytes(10) });
      assert.equal(r.ok, false, '应拒绝 stem=' + JSON.stringify(bad));
    }
    // 目录里不应出现任何越界文件
    const entries = await fsp.readdir(path.join(ROOT, CUSTOM_BGM_DIR));
    assert.deepEqual(entries.filter((n) => !n.startsWith('index.json')), []);
  });

  test('扩展名白名单 + 体积上限 + 空文件', async () => {
    assert.equal((await saveCustomBgm(ROOT, { stem: 'x1', ext: '.exe', buf: bytes(10) })).ok, false, '拒绝非音频');
    assert.equal((await saveCustomBgm(ROOT, { stem: 'x2', ext: '.mp3', buf: Buffer.alloc(0) })).ok, false, '拒绝空文件');
    const big = await saveCustomBgm(ROOT, { stem: 'x3', ext: '.mp3', buf: bytes(MAX_BGM_BYTES + 1) });
    assert.equal(big.ok, false);
    assert.match(big.error, /过大/);
  });

  test('容量闸：新曲目超上限拒绝，覆盖已有允许', async () => {
    const many = path.join(ROOT, 'many');
    await fsp.mkdir(many, { recursive: true });
    for (let i = 0; i < 40; i++) await saveCustomBgm(many, { stem: 's' + i, ext: '.mp3', buf: bytes(16) });
    assert.equal((await customBgmCapacity(many, 'brand_new')).ok, false, '第 41 首应被拒');
    assert.equal((await customBgmCapacity(many, 's0')).ok, true, '覆盖已有曲目不受限');
  });

  test('手工 scp 的文件也会出现在列表里（无索引条目也能列）', async () => {
    const dir = path.join(ROOT, CUSTOM_BGM_DIR);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'scp_dropped.mp3'), bytes(64));
    const list = await listCustomBgm(ROOT);
    const hit = list.find((x) => x.stem === 'scp_dropped');
    assert.ok(hit, '手工放入的文件被列出');
    assert.equal(hit.name, 'scp_dropped', '无索引时展示名回落到 stem');
    await removeCustomBgm(ROOT, 'scp_dropped');
  });
});

describe('自定义 BGM 客户端解析（cbgm: 通道 + 个人优先级）', () => {
  test('resolveBgm：cbgm:<stem> 解析为 /media/cbgm/<stem>；非法 stem ⇒ null', async () => {
    const { resolveBgm } = await import('../public/js/audio.js');
    const t = resolveBgm({ audio: {} }, 'cbgm:my_boss');
    assert.deepEqual(t, { intro: null, loop: '/media/cbgm/my_boss' });
    assert.equal(resolveBgm({ audio: {} }, 'cbgm:../etc/passwd'), null, '路径穿越拒');
    assert.equal(resolveBgm({ audio: {} }, 'cbgm:has.dot'), null, '点号拒');
    assert.equal(resolveBgm({ audio: {} }, 'cbgm:'), null, '空拒');
  });

  test('stemBgmKey：服务器 x:<name> → cbgm:<name>；内置 stem 仍走 stem:', async () => {
    const { stemBgmKey } = await import('../public/js/audio.js');
    const manifest = { audio: { bgm: { combat: { loop: '/assets/audio/bgm/m_bat_act1autochess_loop.mp3' } } } };
    assert.equal(stemBgmKey(manifest, { bgmTrack: 'x:custom_one' }), 'cbgm:custom_one', '自定义前缀');
    assert.equal(stemBgmKey(manifest, { bgmTrack: 'm_bat_act1autochess' }), 'stem:m_bat_act1autochess', '内置 stem');
    assert.equal(stemBgmKey(manifest, { bgmTrack: 'x:../bad' }), null, '非法自定义 ⇒ null（回落官方）');
    assert.equal(stemBgmKey(manifest, {}), null, '无字段 ⇒ null');
  });

  test('个人替换映射：读写/校验/清除（localStorage 语义）', async () => {
    const mod = await import('../public/js/ui/personalBgm.js');
    // Node 环境无 localStorage：注入一个最小实现
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    try {
      assert.deepEqual(mod.readPersonalBgm(), {}, '空 ⇒ {}');
      assert.ok(mod.writePersonalBgm({ 18: 'my_boss', '*': 'all_boss' }));
      assert.deepEqual(mod.readPersonalBgm(), { 18: 'my_boss', '*': 'all_boss' });
      // 非法条目被过滤
      assert.ok(mod.writePersonalBgm({ 19: 'ok_stem', 20: '../bad', bad: 'x', 21: 'has.dot' }));
      assert.deepEqual(mod.readPersonalBgm(), { 19: 'ok_stem' }, '只留合法项');
      mod.writePersonalBgm({});
      assert.equal(store.get('sp_personal_bgm'), undefined, '空映射 = 删除键');
    } finally { delete globalThis.localStorage; }
  });

  test('优先级：个人 > 全局 > 官方（bgmKeyFor 的 stemKey 取值语义）', async () => {
    const { bgmKeyFor, personalBgmKey, stemBgmKey } = await import('../public/js/audio.js');
    const pmod = await import('../public/js/ui/personalBgm.js');
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    try {
      const manifest = { audio: { bgm: { combat: { loop: '/assets/audio/bgm/m_bat_act1autochess_loop.mp3' } } } };
      const pub = { phase: 'COMBAT', round: 18, bgmTrack: 'm_bat_act1autochess' }; // 全局命中内置曲
      // 无个人设置：全局生效
      const globalKey = personalBgmKey(pub.round) || stemBgmKey(manifest, pub);
      assert.equal(globalKey, 'stem:m_bat_act1autochess');
      assert.equal(bgmKeyFor('game', pub, 0, globalKey), 'stem:m_bat_act1autochess');
      // 个人指定第 18 回合 ⇒ 压过全局
      pmod.writePersonalBgm({ 18: 'mine_here' });
      const personalKey = personalBgmKey(pub.round) || stemBgmKey(manifest, pub);
      assert.equal(personalKey, 'cbgm:mine_here', '个人优先');
      assert.equal(bgmKeyFor('game', pub, 0, personalKey), 'cbgm:mine_here');
      // 个人指定别的回合 ⇒ 第 18 回合仍用个人该条？不：映射里没有 18 就走全局
      pmod.writePersonalBgm({ 7: 'other' });
      assert.equal(personalBgmKey(18) || stemBgmKey(manifest, pub), 'stem:m_bat_act1autochess', '非本回合回落全局');
      // '*' 通配
      pmod.writePersonalBgm({ '*': 'wild' });
      assert.equal(personalBgmKey(5), 'cbgm:wild', '通配命中任意回合');
      // 清空 ⇒ 回落全局
      pmod.writePersonalBgm({});
      assert.equal(personalBgmKey(18) || stemBgmKey(manifest, pub), 'stem:m_bat_act1autochess');
      // 个人指定的曲目名非法（服务器上没有）时仍解析（客户端不校验存在性——由文件 404 兜底静默）
      pmod.writePersonalBgm({ 3: 'not_uploaded_yet' });
      assert.equal(personalBgmKey(3), 'cbgm:not_uploaded_yet', '客户端不校验存在性（上传前后都能设）');
    } finally { delete globalThis.localStorage; }
  });
});

describe('/media/cbgm 路由（自定义曲目的无扩展名音频通道）', () => {
  let srv = null, base = '';
  const PUB = path.resolve('.cache', 'cbgm-route-test');
  before(async () => {
    fs.rmSync(PUB, { recursive: true, force: true });
    fs.mkdirSync(path.join(PUB, CUSTOM_BGM_DIR), { recursive: true });
    fs.writeFileSync(path.join(PUB, CUSTOM_BGM_DIR, 'route_test.mp3'), Buffer.alloc(512, 7));
    const http = await import('node:http');
    const { serveMedia } = await import('../server/http/media.js');
    const { MEDIA_PREFIX } = await import('../shared/media.js');
    srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname.startsWith(MEDIA_PREFIX)) {
        serveMedia(req, res, u.pathname.slice(MEDIA_PREFIX.length), u.search.slice(1), PUB, null, { warn() {}, error() {}, info() {} }, {}).catch(() => { try { res.writeHead(500); res.end(); } catch { /* ignore */ } });
        return;
      }
      res.writeHead(404); res.end('nf');
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + srv.address().port;
  });
  after(async () => {
    try { await new Promise((r) => srv.close(r)); } catch { /* ignore */ }
    try { fs.rmSync(PUB, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('GET /media/cbgm/<stem> ⇒ 200 + audio/mpeg + 正确字节数 + no-cache', async () => {
    const r = await fetch(base + '/media/cbgm/route_test');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') || '', /audio\/mpeg/);
    assert.match(r.headers.get('cache-control') || '', /no-cache/, '自定义曲目 no-cache（换文件即生效）');
    const b = new Uint8Array(await r.arrayBuffer());
    assert.equal(b.length, 512);
    assert.equal(b[0], 7);
  });

  test('带扩展名也可；不存在/穿越/隐藏 ⇒ 4xx', async () => {
    assert.equal((await fetch(base + '/media/cbgm/route_test.mp3')).status, 200);
    assert.equal((await fetch(base + '/media/cbgm/nope')).status, 404);
    assert.ok((await fetch(base + '/media/cbgm/..%2F..%2Fetc%2Fpasswd')).status >= 400, '穿越拒');
    assert.equal((await fetch(base + '/media/cbgm/.hidden')).status, 404);
  });
});

describe('控制台上传 API（/console/api/bgm）', () => {
  let srv = null, base = '';
  const PUB = path.resolve('.cache', 'cbgm-api-test');
  before(async () => {
    fs.rmSync(PUB, { recursive: true, force: true });
    fs.mkdirSync(path.join(PUB, 'console.html'.replace('.html', '')), { recursive: true });
    fs.writeFileSync(path.join(PUB, 'console.html'), '<html>console</html>');
    const http = await import('node:http');
    const { createRequestHandler } = await import('../server/http/routes.js');
    const handler = createRequestHandler({
      serveStatic: async (req, res) => { res.writeHead(404); res.end('nf'); },
      health: { startedAt: Date.now(), customRules: () => ({ music: { enabled: true } }) }, // 音乐总开关开：/music/bgm-list 才可达
      log: { warn() {}, error() {}, info() {} },
      custom: { publicDir: PUB },
    });
    srv = http.createServer(handler);
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    base = 'http://127.0.0.1:' + srv.address().port;
  });
  after(async () => {
    try { await new Promise((r) => srv.close(r)); } catch { /* ignore */ }
    try { fs.rmSync(PUB, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('上传 → 列表 → 删除（原始字节 body，非 multipart）', async () => {
    const up = await fetch(base + '/console/api/bgm?stem=api_test&name=' + encodeURIComponent('接口测试曲') + '&ext=.mp3', {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(1024, 9),
    });
    assert.equal(up.status, 200, 'HTTP ' + up.status);
    const j = await up.json();
    assert.ok(j.ok, j.error);
    assert.equal(j.item.stem, 'api_test');
    assert.equal(j.item.name, '接口测试曲');
    assert.ok(fs.existsSync(path.join(PUB, CUSTOM_BGM_DIR, 'api_test.mp3')), '文件已落盘');
    // 列表
    const list = await (await fetch(base + '/console/api/bgm')).json();
    assert.ok(list.items.some((x) => x.stem === 'api_test'));
    assert.equal(list.maxBytes, 24 * 1024 * 1024);
    // 删除
    const del = await fetch(base + '/console/api/bgm?stem=api_test', { method: 'DELETE' });
    assert.equal(del.status, 200);
    assert.ok(!fs.existsSync(path.join(PUB, CUSTOM_BGM_DIR, 'api_test.mp3')), '文件已删');
    assert.equal((await fetch(base + '/console/api/bgm?stem=api_test', { method: 'DELETE' })).status, 404, '重复删 404');
  });

  test('非法输入被拒：坏 stem / 坏扩展名 / 空 body', async () => {
    const bad = await fetch(base + '/console/api/bgm?stem=../evil&ext=.mp3', { method: 'POST', body: Buffer.alloc(16) });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).ok, false);
    const badExt = await fetch(base + '/console/api/bgm?stem=ok_name&ext=.exe', { method: 'POST', body: Buffer.alloc(16) });
    assert.equal(badExt.status, 400);
    const empty = await fetch(base + '/console/api/bgm?stem=ok_name&ext=.mp3', { method: 'POST', body: Buffer.alloc(0) });
    assert.equal(empty.status, 400);
    // 目录里不应有越界文件
    const dir = path.join(PUB, CUSTOM_BGM_DIR);
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !n.startsWith('index.json')) : [];
    assert.deepEqual(names, [], '非法上传未落盘');
  });

  test('GET 之外的方法与公开列表 /music/bgm-list', async () => {
    const r = await fetch(base + '/music/bgm-list');
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(Array.isArray(j.items), '公开只读列表可用（客户端个人替换面板用）');
  });
});
