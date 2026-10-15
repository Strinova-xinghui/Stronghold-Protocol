// 音乐播放器客户端逻辑单测：builtinTracks（曲目推导）+ LRC 歌词（parseLrc/lrcIndex）。
// （外部音源 lx 沙箱与搜索点歌已随 2026-10-16「去掉外部源」移除。）
// 用法: node --test tools/music-player.test.mjs
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { builtinTracks, parseLrc, lrcIndex } from '../public/js/ui/player-core.js';

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

describe('歌词（parseLrc / lrcIndex）', () => {
  test('标准 LRC：排序、多标签、元数据行丢弃', () => {
    const lrc = ['[ti:歌]', '[ar:手]', '[00:12.50]第一句', '[00:05.00]前奏句', '[01:30.25]副歌', '[00:12.50]第一句重复标签'].join('\n');
    const lines = parseLrc(lrc);
    assert.deepEqual(lines.map((l) => l.t), [5, 12.5, 12.5, 90.25]);
    assert.equal(lines[1].line, '第一句');
  });
  test('毫秒 .xxx 与非法行', () => {
    const lines = parseLrc('[00:01.123]三点毫秒\n没有时间标签\n[abc]坏标签\n[02:59.9]尾句');
    assert.equal(lines.length, 2);
    assert.ok(Math.abs(lines[0].t - 1.123) < 1e-6);
    assert.equal(lines[1].t, 179.9);
  });
  test('空/坏输入安全', () => {
    assert.deepEqual(parseLrc(''), []);
    assert.deepEqual(parseLrc(null), []);
    assert.equal(lrcIndex([], 5), -1);
  });
  test('lrcIndex：二分定位当前行（含 0.25s 提前量）', () => {
    const lines = parseLrc('[00:10.00]A\n[00:20.00]B\n[00:30.00]C');
    assert.equal(lrcIndex(lines, 0), -1);
    assert.equal(lrcIndex(lines, 9.0), -1, '提前量 0.25s 之外不点亮');
    assert.equal(lrcIndex(lines, 9.9), 0, '提前 0.25s 点亮（歌词比声音先到半拍，读感更顺）');
    assert.equal(lrcIndex(lines, 10.2), 0);
    assert.equal(lrcIndex(lines, 25), 1);
    assert.equal(lrcIndex(lines, 999), 2);
  });
});
