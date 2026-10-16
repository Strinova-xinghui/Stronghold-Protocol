// 自定义 BOSS 战 BGM（自研 2026-10-16）单测：文件仓库（存/列/删/上限/路径安全）+ bossBgm 规则的
// 内置 stem 与自定义 `x:<name>` 两种来源校验 + 个人替换优先级（audio.js 的 personalBgmKey 语义）。
// 用法: node --test tools/custom-bgm.test.mjs
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { listCustomBgm, saveCustomBgm, removeCustomBgm, customBgmCapacity, CUSTOM_BGM_DIR, MAX_BGM_BYTES } from '../server/match/customBgm.js';
import { CUSTOM_RULES_PATH, resetCustomRules } from '../server/match/customRules.js';

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
    const mod = await import('../public/js/battleMusicStore.js');
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
      assert.deepEqual(mod.readPersonalBgm(), { 18: ['my_boss'], '*': ['all_boss'] }, '值是池（单曲 = 1 元池）');
      // 非法条目被过滤
      assert.ok(mod.writePersonalBgm({ 19: 'ok_stem', 20: '../bad', bad: 'x', 21: 'has.dot' }));
      assert.deepEqual(mod.readPersonalBgm(), { 19: ['ok_stem'] }, '只留合法项');
      mod.writePersonalBgm({});
      assert.equal(store.get('sp_personal_bgm'), undefined, '空映射 = 删除键');
    } finally { delete globalThis.localStorage; }
  });

  test('优先级：个人 > 全局 > 官方（按轮次类型）', async () => {
    const { bgmKeyFor, personalBgmKey, stemBgmKey } = await import('../public/js/audio.js');
    const pmod = await import('../public/js/battleMusicStore.js');
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
      const globalKey = personalBgmKey('combat', pub.round) || stemBgmKey(manifest, pub);
      assert.equal(globalKey, 'stem:m_bat_act1autochess');
      assert.equal(bgmKeyFor('game', pub, 0, globalKey), 'stem:m_bat_act1autochess');
      // 个人配「常规战斗轮」⇒ 压过全局
      pmod.writePersonalBgm({ combat: 'mine_here' });
      const personalKey = personalBgmKey('combat', pub.round) || stemBgmKey(manifest, pub);
      assert.equal(personalKey, 'cbgm:mine_here', '个人优先');
      assert.equal(bgmKeyFor('game', pub, 0, personalKey), 'cbgm:mine_here');
      // 只配了 BOSS 轮 ⇒ 常规轮回落全局
      pmod.writePersonalBgm({ boss: 'boss_only' });
      assert.equal(personalBgmKey('combat', 18) || stemBgmKey(manifest, pub), 'stem:m_bat_act1autochess', '未配本轮次 ⇒ 回落全局');
      assert.equal(personalBgmKey('boss', 18), 'cbgm:boss_only', 'BOSS 轮用个人池');
      // '*' 通配
      pmod.writePersonalBgm({ '*': 'wild' });
      assert.equal(personalBgmKey('combat', 5), 'cbgm:wild', '通配命中任意轮次');
      // 清空 ⇒ 回落全局
      pmod.writePersonalBgm({});
      assert.equal(personalBgmKey('combat', 18) || stemBgmKey(manifest, pub), 'stem:m_bat_act1autochess');
      // 个人指定的曲目名非法（服务器上没有）时仍解析（客户端不校验存在性——由文件 404 兜底静默）
      pmod.writePersonalBgm({ boss: 'not_uploaded_yet' });
      assert.equal(personalBgmKey('boss', 19), 'cbgm:not_uploaded_yet', '客户端不校验存在性（上传前后都能设）');
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

describe('个人 BGM 随机池（客户端，2026-10-16）', () => {
  const store = new Map();
  const origLS = globalThis.localStorage;
  before(() => { globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }; });
  after(() => { store.clear(); if (origLS === undefined) delete globalThis.localStorage; else globalThis.localStorage = origLS; });

  test('读写池：单曲/多首/去重/非法过滤/清除', async () => {
    const m = await import('../public/js/battleMusicStore.js');
    store.clear();
    assert.ok(m.writePersonalBgm({ 18: ['yuai', 'aizo'], '*': 'xinsiyanhuo' }), '单字符串也接受（归一为池）');
    assert.deepEqual(m.readPersonalBgm(), { 18: ['yuai', 'aizo'], '*': ['xinsiyanhuo'] }, '字符串归一为 1 元池');
    m.writePersonalBgm({ 18: ['ok', 'ok', '../bad', 'has.dot', 'ok2'] });
    assert.deepEqual(m.readPersonalBgm(), { 18: ['ok', 'ok2'] }, '去重 + 非法过滤');
    m.writePersonalBgm({ 18: [] });
    assert.equal(store.get('sp_personal_bgm'), undefined, '空池 = 删键');
  });

  test('pickFromPool：确定性（同 matchKey+回合+池恒定），不同输入有变化', async () => {
    const m = await import('../public/js/battleMusicStore.js');
    const pool = ['yuai', 'aizo', 'xinsiyanhuo'];
    const a = m.pickFromPool(pool, 18, 'roomA');
    for (let i = 0; i < 20; i++) assert.equal(m.pickFromPool(pool, 18, 'roomA'), a, '同局同回合恒定');
    assert.ok(pool.includes(a));
    assert.equal(m.pickFromPool(['only'], 18, 'roomA'), 'only', '单首直接返回');
    const seen = new Set();
    for (let i = 1; i <= 200; i++) seen.add(m.pickFromPool(pool, 18, 'room' + i));
    assert.ok(seen.size >= 2, '不同对局有变化，实际 ' + seen.size + ' 种');
    assert.equal(m.pickFromPool([], 18, 'x'), null, '空池 null');
  });

  test('personalBgmKey：按轮次类型取池 + 确定性选曲（audio.js 集成）', async () => {
    const { personalBgmKey } = await import('../public/js/audio.js');
    const m = await import('../public/js/battleMusicStore.js');
    store.clear();
    m.writePersonalBgm({ boss: ['yuai', 'aizo'] });
    const k1 = personalBgmKey('boss', 18, 'match1');
    for (let i = 0; i < 10; i++) assert.equal(personalBgmKey('boss', 18, 'match1'), k1, '同局同轮次恒定');
    assert.ok(k1 === 'cbgm:yuai' || k1 === 'cbgm:aizo', '来自个人池：' + k1);
    assert.equal(personalBgmKey('combat', 18, 'match1'), null, '未配置的轮次 ⇒ null（回落全局/官方）');
    // 通配
    m.writePersonalBgm({ '*': ['xinsiyanhuo'] });
    assert.equal(personalBgmKey('combat', 7, 'match1'), 'cbgm:xinsiyanhuo', '通配生效');
    // 轮次类型优先于通配
    m.writePersonalBgm({ boss: ['yuai'], '*': ['xinsiyanhuo'] });
    assert.equal(personalBgmKey('boss', 18, 'match1'), 'cbgm:yuai', '轮次类型优先于通配');
    assert.equal(personalBgmKey('combat', 5, 'match1'), 'cbgm:xinsiyanhuo', '未配该轮次 ⇒ 落通配');
    // 与回合号无关：BOSS 落在 14/15 还是 18/19 都命中同一条
    assert.equal(personalBgmKey('boss', 14, 'match1'), 'cbgm:yuai', 'BOSS 在第 14 回合也命中');
    assert.equal(personalBgmKey('boss', 19, 'match1'), 'cbgm:yuai', 'BOSS 在第 19 回合也命中');
    // 旧版按回合号的键仍兼容
    m.writePersonalBgm({ 18: ['daoguanmeng'] });
    assert.equal(personalBgmKey('boss', 18, 'match1'), 'cbgm:daoguanmeng', '旧版回合号键仍生效');
    m.writePersonalBgm({});
    assert.equal(personalBgmKey('boss', 18, 'match1'), null, '清空 ⇒ 回落');
  });
});

describe('点歌台优先于自动替换（含 bossBgm）—— 2026-10-16 用户约束', () => {
  // 真实链路：替换曲由**服务器**选好、经 m.public.bgmTrack 下发；客户端只负责「自动模式下采纳它」。
  // 本组断言的核心不变量：**玩家点歌（manualBgm）优先**，自动替换不得覆盖手动播放。
  test('手动点歌期间：轮次变化不覆盖（bossBgm 只作用于「默认/自动」战斗音乐）', async () => {
    const { installAudio, audio } = await import('../public/js/audio.js');
    const calls = [];
    const origPlay = audio.playBgm;
    audio.playBgm = (k) => { calls.push(k); };
    const origManual = audio.manualBgm;
    try {
      const pub = (o) => ({ phase: 'COMBAT', round: 5, bgmTrack: 'x:yuai', ...o }); // 服务器下发的替换曲
      const state = { route: 'game', match: { public: pub({}) } };
      let fire = null;
      installAudio({
        getManifest: () => ({ audio: {} }), getState: () => state, selectRoute: (s) => s.route,
        subscribe: (fn) => { fire = fn; return () => {}; },
      });
      // ① 自动模式：采纳服务器下发的替换曲（cbgm:<stem>）
      assert.equal(calls.at(-1), 'cbgm:yuai', '自动模式采纳替换曲');
      // ② 玩家点歌 → 进入 BOSS 轮（服务器给 x:xinsiyanhuo），自动选曲必须让位
      audio.manualBgm = { url: '/media/cbgm/yuai', label: 'manual:test' };
      const before = calls.length;
      state.match.public = pub({ phase: 'FINAL_ASSAULT', round: 18, bgmTrack: 'x:xinsiyanhuo' });
      fire(state, {});
      assert.equal(calls.length, before, '手动播放期间不得调用 playBgm（点歌优先，替换让位）');
      // ③ 同轮次内反复触发也不覆盖
      fire(state, {});
      assert.equal(calls.length, before, '反复触发仍不覆盖');
      // ④ 玩家点「回到自动」→ 自动链重新接管，且按**当前**轮次取曲
      audio.clearManualBgm();
      fire(state, {});
      assert.ok(calls.length > before, '解除手动锁后自动选曲恢复');
      assert.equal(calls.at(-1), 'cbgm:xinsiyanhuo', '恢复后按当前轮次（BOSS 轮下发的那首）');
      // ⑤ 再次上锁依然不覆盖
      audio.manualBgm = { url: '/media/cbgm/yuai', label: 'manual:test2' };
      const before2 = calls.length;
      fire(state, {});
      assert.equal(calls.length, before2, '再次上锁后依然不覆盖');
      // ⑥ 未点歌时替换照常（确认不是「被点歌永久禁用」）
      audio.clearManualBgm();
      state.match.public = pub({ phase: 'COMBAT', round: 6, bgmTrack: 'x:aizo' });
      fire(state, {});
      assert.equal(calls.at(-1), 'cbgm:aizo', '未点歌时替换生效');
    } finally {
      audio.playBgm = origPlay;
      audio.manualBgm = origManual;
    }
  });

  test('个人替换（localStorage）同样让位于手动点歌', async () => {
    const { installAudio, audio } = await import('../public/js/audio.js');
    const pmod = await import('../public/js/battleMusicStore.js');
    const store = new Map();
    const origLS = globalThis.localStorage;
    globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
    const calls = [];
    const origPlay = audio.playBgm;
    audio.playBgm = (k) => { calls.push(k); };
    const origManual = audio.manualBgm;
    try {
      pmod.writePersonalBgm({ combat: ['daoguanmeng'] });   // 个人池（本机）
      const pub = (o) => ({ phase: 'COMBAT', round: 4, bgmTrack: 'x:yuai', ...o }); // 服务器全局规则
      const state = { route: 'game', match: { public: pub({}) } };
      let fire = null;
      installAudio({
        getManifest: () => ({ audio: {} }), getState: () => state, selectRoute: (s) => s.route,
        subscribe: (fn) => { fire = fn; return () => {}; },
      });
      // 个人替换优先于全局（未点歌时）
      assert.equal(calls.at(-1), 'cbgm:daoguanmeng', '个人替换优先于全局');
      // 点歌后一律让位
      audio.manualBgm = { url: '/media/cbgm/daoguanmeng', label: 'manual:mine' };
      const before = calls.length;
      state.match.public = pub({ phase: 'FINAL_ASSAULT', round: 19, bgmTrack: 'x:xinsiyanhuo' });
      fire(state, {});
      assert.equal(calls.length, before, '点歌期间个人替换也不覆盖');
      // 回到自动 → 恢复个人替换（BOSS 轮未配个人池 ⇒ 回落服务器下发）
      audio.clearManualBgm();
      fire(state, {});
      assert.equal(calls.at(-1), 'cbgm:xinsiyanhuo', '回到自动后 BOSS 轮用服务器下发（个人只配了常规轮）');
      pmod.writePersonalBgm({});
    } finally {
      audio.playBgm = origPlay;
      audio.manualBgm = origManual;
      if (origLS === undefined) delete globalThis.localStorage; else globalThis.localStorage = origLS;
    }
  });
});

describe('战斗音乐替换与点歌台解耦（2026-10-16 用户要求：发布节奏不同）', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  test('点歌台不 import 战斗音乐模块（反之亦然）：零耦合，可各自发布', () => {
    const player = read('public/js/ui/player.js');
    const battle = read('public/js/ui/battleMusic.js');
    // 真正的耦合只算 import / 代码引用；注释里提到对方不算（解耦说明本身要写清关系）
    const codeLines = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/battleMusicStore|ui\/battleMusic|BattleMusicHost|openBattleMusic/.test(codeLines(player)), '点歌台不得引用战斗音乐模块');
    assert.ok(!/ui\/player|openPlayer|PlayerHost|PersonalBgmTab/.test(codeLines(battle)), '战斗音乐模块不得引用点歌台');
  });

  test('点歌台面板回到三个 tab（战斗音乐不再是它的 tab）', () => {
    const player = read('public/js/ui/player.js');
    const m = /const TABS = \[([\s\S]*?)\];/.exec(player);
    assert.ok(m, '找得到 TABS');
    const keys = [...m[1].matchAll(/key: '([^']+)'/g)].map((x) => x[1]);
    assert.deepEqual(keys, ['builtin', 'siren', 'fav'], '只有点歌台的三个 tab');
    assert.ok(!/mybgm|PersonalBgmTab/.test(player), '战斗音乐 tab 已移除');
  });

  test('独立入口在四个界面都有，且各自走 openBattleMusic', () => {
    for (const f of ['public/js/screens/game.js', 'public/js/screens/lobby.js', 'public/js/screens/title.js', 'public/js/screens/room.js']) {
      const src = read(f);
      assert.ok(/import \{ openBattleMusic \}/.test(src), f + ' 有 import');
      assert.ok(/openBattleMusic[\s}>]/.test(src), f + ' 有按钮');
    }
    // 宿主由 main.js 全局挂载（与 PlayerHost 平级）
    const main = read('public/js/main.js');
    assert.ok(/<\$\{BattleMusicHost\} \/>/.test(main), 'main.js 挂了 BattleMusicHost');
    assert.ok(/<\$\{PlayerHost\} \/>/.test(main), 'main.js 仍挂着 PlayerHost（点歌台不受影响）');
  });

  test('存储层可被两边共用且不依赖 UI：battleMusicStore 不 import preact/components', () => {
    const store = read('public/js/battleMusicStore.js');
    // 只查 import 行——注释里提到 UI 模块名是解耦说明，不算依赖
    const imports = store.split('\n').filter((l) => /^\s*import\b/.test(l)).join('\n');
    assert.ok(!/preact|hooks\.module|components\.js|store\.js|ui\//.test(imports), '存储层的 import 里没有 UI：' + imports);
    // audio.js 通过存储层取个人池（单一来源）
    const audio = read('public/js/audio.js');
    assert.ok(/from '\.\/battleMusicStore\.js'/.test(audio), 'audio.js 走存储层');
  });
});
