// 音乐播放器 UI e2e（无头浏览器）：title 路由直接挂 PlayerPanel（UI 自包含，只依赖 audio + assets 清单）。
// 验证：三 tab 渲染、内置曲目列表、点播上 manualBgm 锁、回到自动解锁、塞壬代理请求、外部音源输入框。
// 2026-10-15 补：专辑展开（点专辑→曲目列表，detail 请求 200）、点歌（song 换链 200 + playTrack 收到 CDN 地址）、
// 搜索框（本地过滤 + 服务器兜底）、远程流式播放（_startBgmStream 走 <audio>，不进 _buffer 解码管道）。
// 用法: SP_E2E=1 CHROME_PATH=<edge|chrome> node --test test/ui/player.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Client, ROOT, hasChrome, startRealServer } from '../e2e/client.mjs';

const enabled = process.env.SP_E2E === '1' && hasChrome() && existsSync(ROOT + '/public/assets');

async function mountPanel(c) {
  await c.open();
  await c.page.evaluate(async () => {
    const [{ PlayerPanel }, preact] = await Promise.all([
      import('/js/ui/player.js'),
      import('/vendor/preact.module.js'),
    ]);
    const root = document.createElement('div');
    root.id = 'player-root';
    document.body.appendChild(root);
    const Comp = () => PlayerPanel({ open: true, onClose: () => {} });
    preact.render(preact.h(Comp), root);
  });
  await c.page.waitForSelector('.player', { timeout: 10000 });
}

test('音乐播放器：三 tab + 内置点播锁 + 回到自动 + 塞壬代理 + 外部音源输入框', { skip: !enabled, timeout: 120000 }, async () => {
  const P = (await import('puppeteer-core')).default;
  const srv = await startRealServer({ fast: { timerScale: 0.1, kit: 0 } });
  const c = new Client(P, srv.base, 'player', { prefix: 'player' });
  try {
    await c.open();
    await c.page.evaluate(async () => {
      const [{ PlayerPanel }, preact, htmMod] = await Promise.all([
        import('/js/ui/player.js'),
        import('/vendor/preact.module.js'),
        import('/vendor/htm.module.js'),
      ]);
      const root = document.createElement('div');
      document.body.appendChild(root);
      const Comp = () => PlayerPanel({ open: true, onClose: () => {} });
      preact.render(preact.h(Comp), root);
    });
    await c.page.waitForSelector('.player', { timeout: 10000 });
    const tabs = await c.page.$$eval('.ptab-btn', (els) => els.map((e) => e.textContent.trim()));
    assert.equal(tabs.length, 4, '四个 tab（含收藏）: ' + tabs.join('/'));
    const n = await c.page.$$eval('.ptab .ptrack', (els) => els.length);
    assert.ok(n > 0, '内置曲目 ' + n + ' 首');
    await c.page.evaluate(() => {
      const { audio } = globalThis.__SP__;
      window.__manual = null;
      const pt = audio.playTrack.bind(audio);
      audio.playTrack = (t, l) => { window.__manual = { t, l }; return pt(t, l); };
    });
    await c.page.click('.ptab .ptrack');
    await c.page.waitForFunction(() => window.__manual && window.__manual.l, { timeout: 8000 });
    const lock = await c.page.evaluate(() => ({
      manual: !!globalThis.__SP__.audio.manualBgm,
      label: globalThis.__SP__.audio.manualBgm && globalThis.__SP__.audio.manualBgm.label,
      url: (window.__manual.t || {}).url,
    }));
    assert.ok(lock.manual, 'manualBgm 上锁');
    assert.ok(String(lock.label).startsWith('builtin:'), 'label=' + lock.label);
    assert.ok(String(lock.url).includes('/audio/bgm/'), 'url=' + lock.url);
    const btns = await c.page.$$('.player__tabs .btn');
    await btns[btns.length - 1].click();
    const unlocked = await c.page.evaluate(() => !!globalThis.__SP__.audio.manualBgm);
    assert.equal(unlocked, false, '回到自动解锁');
    const sirenHits = [];
    c.page.on('response', (r) => { if (new URL(r.url()).pathname.startsWith('/music/siren')) sirenHits.push(r.status()); });
    await c.page.$$eval('.ptab-btn', (els) => els[1].click());
    await c.page.waitForFunction(() => document.querySelectorAll('.ptab .ptrack').length > 0, { timeout: 15000 });
    assert.ok(sirenHits.length > 0, '塞壬代理请求: ' + sirenHits.join(','));
    await c.page.$$eval('.ptab-btn', (els) => els[2].click());
    await c.page.waitForSelector('.pcode', { timeout: 5000 });
    assert.ok(await c.page.$('.pcode'), '外部音源脚本输入框在');
    assert.ok(await c.page.$('.prow .purl'), 'URL 导入输入框在');
    assert.ok(await c.page.$eval('.prow .purl', (el) => el.type === 'url'), 'URL 框是 type=url');
    // —— 搜索点歌全流程：加载最小音源 → 搜索（拦截 /music/proxy 给出确定性结果）→ 点行取链播放 ——
    await c.page.setRequestInterception(true);
    c.page.on('request', (req) => {
      const u = req.url();
      if (u.includes('/music/proxy')) {
        const wy = { result: { songs: [{ id: 123, name: '测试歌', duration: 200000, artists: [{ name: '某人' }], album: { id: 9, name: '某专' } }] } };
        req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(wy) });
        return;
      }
      req.continue();
    });
    const SCRIPT = [
      "const { EVENT_NAMES, on, send } = globalThis.lx;",
      "on(EVENT_NAMES.request, ({ action, info }) => {",
      "  if (action !== 'musicUrl') return Promise.reject(new Error('bad action'));",
      "  return Promise.resolve('https://example.com/e2e/' + info.musicInfo.songmid + '.mp3');",
      "});",
      "send(EVENT_NAMES.inited, { sources: { kw: { name: 'E2E源' } } });",
    ].join('\n');
    await c.page.evaluate(async (code) => {
      const ta = document.querySelector('.pcode');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, code);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, SCRIPT);
    await c.page.evaluate(() => { [...document.querySelectorAll('.prow .btn')].find((b) => b.textContent.includes('加载音源')).click(); });
    await c.page.waitForSelector('.plist, .prow .psearch', { timeout: 8000 });
    assert.ok(await c.page.$('.prow .psearch input'), '搜索框在（音源加载后）');
    await c.page.type('.prow .psearch input', '测试歌');
    await c.page.evaluate(() => { [...document.querySelectorAll('.prow .btn')].find((b) => b.textContent.trim() === '搜索').click(); });
    await c.page.waitForSelector('.plist .ptrack--lx', { timeout: 8000 });
    const rowText = await c.page.$eval('.plist .ptrack--lx .ptrack__name', (e) => e.textContent);
    assert.equal(rowText, '测试歌', '搜索结果行渲染');
    // 捕获 onPlayUrl（playTrack 桩）后点行
    await c.page.evaluate(() => {
      const { audio } = globalThis.__SP__;
      window.__ext = [];
      audio.playTrack = (t, l) => { window.__ext.push({ url: t && t.url, label: l }); };
    });
    // 面板 max-height 裁切（ff539eb3）+ 本次新增 B 站行：坐标 click 会被裁掉/遮挡，先滚进行业界面再 JS click（与手工验证一致）
    await c.page.evaluate(() => { const el = document.querySelector('.plist .ptrack--lx'); if (el) el.scrollIntoView({ block: 'center' }); });
    await new Promise((r) => setTimeout(r, 300));
    await c.page.evaluate(() => { document.querySelector('.plist .ptrack--lx').click(); });
    await c.page.waitForFunction(() => window.__ext.length > 0, { timeout: 8000 });
    const ext = await c.page.evaluate(() => window.__ext[0]);
    assert.equal(ext.url, 'https://example.com/e2e/123.mp3', '点行 → 脚本 musicUrl 取链（songmid 来自搜索结果）');
    assert.ok(String(ext.label).startsWith('ext:wy:'), 'label(队列 key)=' + ext.label);
    // 控制条出现并显示当前曲名 + 进度条 + 播放/暂停钮
    await c.page.waitForSelector('.pctrl', { timeout: 8000 });
    assert.equal(await c.page.$eval('.pctrl__title', (e) => e.textContent), '测试歌', '控制条显示当前曲名');
    assert.ok(await c.page.$('.pctrl__seek'), '进度条在');
    const nBtn = await c.page.evaluate(() => document.querySelectorAll('.pctrl__btns .pbtn').length);
    assert.ok(nBtn >= 5, '控制按钮 ≥5，实际 ' + nBtn);
    assert.ok(await c.page.$('.plist .ptrack--lx.is-on'), '当前播放行高亮');
    await c.page.setRequestInterception(false);
  } finally {
    await c.close().catch(() => {});
    await srv.stop().catch(() => {});
  }
});

test('塞壬 tab：专辑展开 + 点歌换链 + 搜索过滤 + 远程流式播放', { skip: !enabled, timeout: 180000 }, async () => {
  const P = (await import('puppeteer-core')).default;
  const srv = await startRealServer({ fast: { timerScale: 0.1, kit: 0 } });
  const c = new Client(P, srv.base, 'player2', { prefix: 'player2' });
  try {
    await mountPanel(c);
    // 记录所有 /music/siren/* 响应（状态码），并捕获 playTrack 的入参（不真下载 56MB WAV）
    const hits = [];
    c.page.on('response', (r) => {
      const p = new URL(r.url()).pathname;
      if (p.startsWith('/music/siren')) hits.push(p + ':' + r.status());
    });
    await c.page.evaluate(() => {
      const { audio } = globalThis.__SP__;
      window.__pt = [];
      window.__origPT = audio.playTrack.bind(audio);
      audio.playTrack = (t, l) => { window.__pt.push({ url: t && t.url, label: l }); };
    });
    await c.page.$$eval('.ptab-btn', (els) => els[1].click());
    await c.page.waitForFunction(() => document.querySelectorAll('.ptab .ptrack').length > 0, { timeout: 20000 });
    // —— 搜索：输入关键词，专辑列表即时过滤
    assert.ok(await c.page.$('.psearch input'), '塞壬 tab 有搜索框');
    await c.page.type('.psearch input', '海');
    await c.page.waitForFunction(() => {
      const rows = [...document.querySelectorAll('.ptab .ptrack .ptrack__name')];
      return rows.length > 0 && rows.length < 298 && rows.some((r) => r.textContent.includes('海'));
    }, { timeout: 8000 });
    const filtered = await c.page.$$eval('.ptab .ptrack .ptrack__name', (els) => els.map((e) => e.textContent));
    assert.ok(filtered.length > 0 && filtered.length < 298, '本地过滤命中 ' + filtered.length + ' 张');
    assert.ok(filtered.some((x) => x.includes('海')), '过滤结果含关键词');
    // —— 展开：点第一张专辑 → 曲目列表出现（detail 请求 200）
    await c.page.click('.ptab .ptrack');
    await c.page.waitForSelector('.palbum-head', { timeout: 15000 });
    assert.ok(hits.some((h) => /\/album\/.+:200/.test(h)), '专辑 detail 200: ' + hits.join(', '));
    const songRows = await c.page.$$eval('.ptab .ptrack .ptrack__name', (els) => els.map((e) => e.textContent));
    assert.ok(songRows.length > 0, '曲目列表展开 ' + songRows.length + ' 首');
    // —— 点歌：换链请求 song/:cid 200，playTrack 收到 CDN 绝对地址
    await c.page.click('.ptab .ptrack');
    await c.page.waitForFunction(() => window.__pt.length > 0, { timeout: 15000 });
    assert.ok(hits.some((h) => /\/song\/.+:200/.test(h)), '单曲换链 200: ' + hits.join(', '));
    const pt = await c.page.evaluate(() => window.__pt[0]);
    assert.ok(/^https:\/\/res\d+\.hycdn\.cn\//.test(pt.url), 'CDN 直连地址: ' + pt.url);
    assert.ok(String(pt.label).startsWith('siren:'), 'label(队列 key)=' + pt.label);
    // —— 返回专辑列表按钮存在且能退回
    assert.ok(await c.page.$('.palbum-head .btn'), '返回按钮在');
    // —— 远程流式播放（真实 playTrack，不经过面板）：<audio> + MediaElementSource，不进 _buffer
    const stream = await c.page.evaluate(async () => {
      const { audio } = globalThis.__SP__;
      audio.playTrack = window.__origPT; // 还原真实 playTrack（上一段用的是捕获桩）
      if (!audio.ctx) { try { audio._unlock && audio._unlock({ type: 'test' }); } catch { /* ignore */ } }
      await new Promise((r) => setTimeout(r, 100));
      if (!audio.ctx) return { skipped: 'no ctx (headless 无手势)' };
      const calls = { buffer: 0, stream: 0 };
      const ob = audio._buffer.bind(audio); const os = audio._startBgmStream.bind(audio);
      audio._buffer = (...a) => { calls.buffer++; return ob(...a); };
      audio._startBgmStream = (...a) => { calls.stream++; window.__ss = a; return os(...a); };
      audio.playTrack({ url: 'https://res01.hycdn.cn/x/y/siren/audio/z.wav' }, 'siren:test:stream');
      await new Promise((r) => setTimeout(r, 200));
      const ss = window.__ss || [];
      audio.clearManualBgm(); audio._fadeOutBgm();
      return { calls, ssKey: String(ss[0] || ''), ssUrl: String(ss[1] || ''), remote: audio._remoteUrl('https://res01.hycdn.cn/a.wav') && !audio._remoteUrl('/assets/audio/bgm/x.mp3') };
    });
    if (!stream.skipped) {
      assert.equal(stream.calls.stream, 1, '远程地址走流式分支');
      assert.equal(stream.calls.buffer, 0, '远程地址不进 _buffer 解码管道（56MB WAV 不占内存）');
      assert.equal(stream.ssUrl, 'https://res01.hycdn.cn/x/y/siren/audio/z.wav', '流式分支收到 CDN 地址');
      assert.ok(stream.ssKey.startsWith('manual:siren:'), 'key=' + stream.ssKey);
      assert.equal(stream.remote, true, '_remoteUrl 判定：跨域 true / 同源 false');
    }
  } finally {
    await c.close().catch(() => {});
    await srv.stop().catch(() => {});
  }
});

// ---- 全局点歌台（2026-10-15）：标题屏入口 → main.js 的 <PlayerHost/> 拉起面板，Esc 关闭 ----------------
test('全局点歌台：标题屏入口能开面板、能关闭', { skip: !enabled, timeout: 120000 }, async () => {
  const P = (await import('puppeteer-core')).default;
  const srv = await startRealServer({ fast: { timerScale: 0.1, kit: 0 } });
  const c = new Client(P, srv.base, 'global', { prefix: 'global' });
  try {
    await c.open(); // 未登录 ⇒ 标题屏
    await c.page.waitForSelector('.title-player', { timeout: 15000 });
    await c.page.click('.title-player');
    await c.page.waitForSelector('.player', { timeout: 10000 });
    // 面板挂在 .app-root 下（全局 Host），不是某个 screen 内部
    const mounted = await c.page.evaluate(() => {
      const p = document.querySelector('.player');
      return !!(p && p.closest('.app-root') && !p.closest('.screen'));
    });
    assert.ok(mounted, '面板由全局 PlayerHost 挂载（screen 之外）');
    assert.ok(await c.page.$('.psearch input'), '面板带搜索框');
    const tabs = await c.page.$$eval('.ptab-btn', (els) => els.length);
    assert.equal(tabs, 4, '四 tab 齐全（内置/塞壬/外部/收藏）');
    await c.page.keyboard.press('Escape');
    await c.page.waitForFunction(() => !document.querySelector('.player'), { timeout: 8000 });
    // 重开（store 开关可重复）
    await c.page.click('.title-player');
    await c.page.waitForSelector('.player', { timeout: 8000 });
    await c.page.keyboard.press('Escape');
    // 收藏持久化（favStore 初值须来自 favLoad，否则刷新即丢）：收藏塞壬一首 → 刷新 → 收藏 tab 仍在
    await c.page.click('.title-player');
    await c.page.waitForSelector('.player', { timeout: 8000 });
    await c.page.$$eval('.ptab-btn', (els) => els[1].click()); // 塞壬
    await c.page.waitForFunction(() => document.querySelectorAll('.ptab .ptrack').length > 50, { timeout: 25000 });
    await c.page.click('.ptab .ptrack');
    await c.page.waitForSelector('.pfav-row .pfav', { timeout: 20000 });
    await c.page.click('.pfav-row .pfav');
    await c.page.waitForFunction(() => JSON.parse(localStorage.getItem('sp_player_favs') || '[]').length === 1, { timeout: 5000 });
    await c.page.reload({ waitUntil: 'domcontentloaded' });
    await c.page.evaluate(async () => {
      const [{ PlayerPanel }, preact] = await Promise.all([import('/js/ui/player.js'), import('/vendor/preact.module.js')]);
      const root = document.createElement('div'); document.body.appendChild(root);
      preact.render(preact.h(() => PlayerPanel({ open: true, onClose: () => {} })), root);
    });
    await c.page.waitForSelector('.player', { timeout: 10000 });
    await c.page.$$eval('.ptab-btn', (els) => els[3].click()); // 收藏（外部分支四 tab：内置0/塞壬1/外部2/收藏3）
    await c.page.waitForFunction(() => document.querySelectorAll('.plist .ptrack').length === 1, { timeout: 5000 });
    assert.ok(await c.page.$('.plist .ptrack__name'), '刷新后收藏仍在（favStore 初始化）');
  } finally {
    await c.close().catch(() => {});
    await srv.stop().catch(() => {});
  }
});
