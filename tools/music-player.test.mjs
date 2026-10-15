// 音乐播放器客户端逻辑单测：builtinTracks（曲目推导）+ lx 脚本沙箱（loadLxScript/parseLxHeader/lxMusicUrl）。
// 浏览器模块在 Node 下直接 import（无 DOM 依赖的部分）。
// 用法: node --test tools/music-player.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { builtinTracks, loadLxScript, lxMusicUrl, parseLxHeader, fetchLxScript } from '../public/js/ui/player-core.js';

describe('内置 BGM 曲目推导', () => {
  test('从 assets 清单推导 16 首（intro+loop 去重，loop 为准）', () => {
    const manifest = { audio: { bgm: {
      lobby: { loop: '/assets/audio/bgm/m_sys_act1autochess_loop.mp3', intro: '/assets/audio/bgm/m_sys_act1autochess_intro.mp3' },
      prep: { loop: '/assets/audio/bgm/m_bat_act1autochess_loop.mp3' },
      boss: { loop: '/assets/audio/bgm/m_bat_rglk1phantomcastle_loop.mp3', intro: '/assets/audio/bgm/m_bat_rglk1phantomcastle_intro.mp3' },
    } } };
    const tracks = builtinTracks(manifest);
    assert.equal(tracks.length, 3, '3 个场景 = 3 首（loop 唯一）');
    const lobby = tracks.find((t) => t.scene === 'lobby');
    assert.equal(lobby.name, '协议启动', '官方曲名映射');
    assert.ok(lobby.introUrl, 'intro 衔接');
    assert.equal(lobby.key, 'builtin:m_sys_act1autochess_loop');
    const prep = tracks.find((t) => t.scene === 'prep');
    assert.equal(prep.introUrl, null, '无 intro 的场景');
  });

  test('空清单安全', () => {
    assert.deepEqual(builtinTracks(null), []);
    assert.deepEqual(builtinTracks({ audio: {} }), []);
  });
});

describe('lx-music 自定义源脚本兼容层', () => {
  const SAMPLE = [
    '/**',
    ' * @name 测试音源',
    ' * @description 单测用',
    ' * @version 1.0.0',
    ' * @author tester',
    ' */',
    'const { EVENT_NAMES, request, on, send } = globalThis.lx;',
    'on(EVENT_NAMES.request, ({ source, action, info }) => {',
    '  if (action !== \'musicUrl\') return Promise.reject(new Error(\'bad action\'));',
    '  if (source !== \'kw\') return Promise.reject(new Error(\'bad source\'));',
    '  return Promise.resolve(\'https://example.com/song/\' + info.musicInfo.songmid + \'.mp3\');',
    '});',
    'send(EVENT_NAMES.inited, { openDevTools: false, sources: { kw: { name: \'酷我\', type: \'music\', actions: [\'musicUrl\'], qualitys: [\'128k\'] } } });',
  ].join(String.fromCharCode(10));

  test('头注释解析', () => {
    const h = parseLxHeader(SAMPLE);
    assert.equal(h.name, '测试音源');
    assert.equal(h.version, '1.0.0');
    assert.equal(h.author, 'tester');
  });

  test('加载脚本：inited 的 sources 透传，musicUrl 回调返回 URL', async () => {
    const res = await loadLxScript(SAMPLE);
    assert.ok(res.ok, '脚本初始化成功: ' + res.error);
    assert.deepEqual(Object.keys(res.sources), ['kw']);
    assert.equal(res.sources.kw.name, '酷我');
    const url = await lxMusicUrl(res.listeners, 'kw', { songmid: 'abc123', name: '测试' }, '128k');
    assert.equal(url, 'https://example.com/song/abc123.mp3');
  });

  test('全局 lx 执行后清理（不泄漏）', async () => {
    await loadLxScript(SAMPLE);
    assert.equal(globalThis.lx, undefined, '执行后 globalThis.lx 已摘除');
  });

  test('坏脚本：语法错误 / 不发 inited 均安全失败', async () => {
    const bad = await loadLxScript('this is not (valid js');
    assert.equal(bad.ok, false);
    assert.ok(bad.error);
    const noInit = await loadLxScript('const x = 1;', { timeoutMs: 200 });
    assert.equal(noInit.ok, false, '不发 inited = 超时失败');
    assert.equal(globalThis.lx, undefined);
  });

  test('空源请求报错', async () => {
    await assert.rejects(() => lxMusicUrl(null, 'kw', {}, null));
  });
});
describe('fetchLxScript（URL 导入）', () => {
  const orig = globalThis.fetch;
  const SCRIPT = '/** @name X */ send';
  after(() => { globalThis.fetch = orig; });

  test('非 http(s) 直接拒绝（不打网络）', async () => {
    globalThis.fetch = () => { throw new Error('should not be called'); };
    const r = await fetchLxScript('ftp://x/y.js');
    assert.equal(r.ok, false);
    assert.match(r.error, /http\(s\)/);
    const r2 = await fetchLxScript('javascript:alert(1)');
    assert.equal(r2.ok, false);
  });

  test('直连成功：返回脚本文本', async () => {
    globalThis.fetch = async (u) => { assert.ok(String(u).includes('good.js')); return { ok: true, status: 200, text: async () => SCRIPT }; };
    const r = await fetchLxScript('https://cdn.example.com/good.js');
    assert.equal(r.ok, true);
    assert.equal(r.code, SCRIPT);
  });

  test('直连失败（CORS）→ 走 /music/proxy 兜底', async () => {
    const seen = [];
    globalThis.fetch = async (u) => {
      seen.push(String(u));
      if (String(u).startsWith('https://')) throw new TypeError('Failed to fetch'); // 浏览器 CORS 失败的形态
      return { ok: true, status: 200, text: async () => SCRIPT };
    };
    const r = await fetchLxScript('https://blocked.example.com/src.js');
    assert.equal(r.ok, true, 'proxy 兜底成功');
    assert.ok(seen[1].startsWith('/music/proxy?url='), '第二发是同源 proxy：' + seen[1]);
    assert.ok(seen[1].includes(encodeURIComponent('https://blocked.example.com/src.js')));
  });

  test('HTML 页面（误贴仓库网页）拒收，不进沙箱', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<!DOCTYPE html><html><body>repo</body></html>' });
    const r = await fetchLxScript('https://github.com/some/repo/blob/main/src.js');
    assert.equal(r.ok, false);
    assert.match(r.error, /HTML/);
  });

  test('HTTP 错误 + proxy 也失败 → 报错', async () => {
    globalThis.fetch = async () => { throw new TypeError('net fail'); };
    const r = await fetchLxScript('https://x.example.com/a.js');
    assert.equal(r.ok, false);
  });

  test('超大响应拒绝（>512KB）', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'a'.repeat(513 * 1024) });
    const r = await fetchLxScript('https://x.example.com/big.js');
    assert.equal(r.ok, false);
    assert.match(r.error, /too large/);
  });
});
