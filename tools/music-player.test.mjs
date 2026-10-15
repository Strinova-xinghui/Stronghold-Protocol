// 音乐播放器客户端逻辑单测：builtinTracks（曲目推导）+ lx 脚本沙箱（loadLxScript/parseLxHeader/lxMusicUrl）。
// 浏览器模块在 Node 下直接 import（无 DOM 依赖的部分）。
// 用法: node --test tools/music-player.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { builtinTracks, loadLxScript, lxMusicUrl, parseLxHeader } from '../public/js/ui/player-core.js';

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