// 音乐播放器 UI e2e（无头浏览器）：title 路由直接挂 PlayerPanel（UI 自包含，只依赖 audio + assets 清单）。
// 验证：三 tab 渲染、内置曲目列表、点播上 manualBgm 锁、回到自动解锁、塞壬代理请求、外部音源输入框。
// 用法: SP_E2E=1 CHROME_PATH=<edge|chrome> node --test test/ui/player.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Client, ROOT, hasChrome, startRealServer } from '../e2e/client.mjs';

const enabled = process.env.SP_E2E === '1' && hasChrome() && existsSync(ROOT + '/public/assets');

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
    assert.equal(tabs.length, 3, '三个 tab: ' + tabs.join('/'));
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
  } finally {
    await c.close().catch(() => {});
    await srv.stop().catch(() => {});
  }
});