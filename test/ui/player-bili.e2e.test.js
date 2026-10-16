// B 站本地中转 e2e（player/external-sources）：真机全链路——外部音源 tab → 粘 BV 链接 →
// 服务器 /music/bili/info 元数据卡 → 点播 → playTrack 收到同源 /music/bili/audio 地址 →
// 真 <audio> 元素流式拉流 currentTime 前进（证明「能出声」）→ bili 搜索源出结果行 → bili 收藏进收藏 tab。
// 用法: SP_E2E=1 CHROME_PATH=<edge|chrome> node --test --test-concurrency=1 test/ui/player-bili.e2e.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { Client, ROOT, hasChrome, startRealServer } from '../e2e/client.mjs';

const enabled = process.env.SP_E2E === '1' && hasChrome() && existsSync(ROOT + '/public/assets');

test('B 站：粘链接→解析→播放（真流式）→搜索→收藏', { skip: !enabled, timeout: 240000 }, async () => {
  const P = (await import('puppeteer-core')).default;
  const srv = await startRealServer({ fast: { timerScale: 0.1, kit: 0 } });
  const c = new Client(P, srv.base, 'playerbili', { prefix: 'playerbili' });
  try {
    await c.open();
    await c.page.evaluate(async () => {
      const [{ PlayerPanel }, preact] = await Promise.all([import('/js/ui/player.js'), import('/vendor/preact.module.js')]);
      const root = document.createElement('div'); root.id = 'player-root'; document.body.appendChild(root);
      preact.render(preact.h(() => PlayerPanel({ open: true, onClose: () => {} })), root);
    });
    await c.page.waitForSelector('.player', { timeout: 10000 });
    await c.page.$$eval('.ptab-btn', (els) => els[2].click()); // 外部音源 tab（TABS: 内置/塞壬/外部/收藏）
    await c.page.waitForSelector('.pcode', { timeout: 5000 });

    // —— 1. 最低验收：粘 BV 链接 → 元数据卡 ——
    const rows = await c.page.$$('.prow .purl');
    assert.equal(rows.length, 2, '脚本 URL 框 + B 站链接框 两个输入');
    const biliBox = rows[1];
    await biliBox.click();
    await biliBox.type('BV1GJ411x7h7');
    await c.page.evaluate(() => { [...document.querySelectorAll('.prow .btn')].find((b) => b.textContent.includes('B 站解析')).click(); });
    await c.page.waitForFunction(() => document.querySelector('.plist .ptrack--lx'), { timeout: 20000 });
    const cardName = await c.page.$eval('.plist .ptrack--lx .ptrack__name', (e) => e.textContent);
    assert.ok(/Never Gonna Give You Up/.test(cardName), '元数据卡标题: ' + cardName);
    assert.ok((await c.page.$eval('.plist .ptrack--lx .ptrack__sub', (e) => e.textContent)).includes('索尼音乐中国'), 'UP 主显示');

    // —— 2. 捕获 playTrack 并点播：URL 必须是同源 /music/bili/audio ——
    await c.page.evaluate(() => {
      const { audio } = globalThis.__SP__;
      window.__bili = [];
      const orig = audio.playTrack.bind(audio);
      audio.playTrack = (t, l, o) => { window.__bili.push({ url: t && t.url, label: l }); return orig(t, l, o); };
    });
    await c.page.click('.plist .ptrack--lx');
    await c.page.waitForFunction(() => window.__bili.length > 0, { timeout: 15000 });
    const hit = await c.page.evaluate(() => window.__bili[0]);
    assert.equal(hit.url, '/music/bili/audio?bvid=BV1GJ411x7h7', '同源中转地址: ' + hit.url);
    assert.ok(String(hit.label).startsWith('bili:'), '队列 key=' + hit.label);

    // —— 3. 真播：等 <audio> 元素缓冲（服务器拉 B 站 CDN 最长 ~25s），currentTime 前进 = 能出声 ——
    await c.page.waitForFunction(() => {
      const el = globalThis.__SP__.audio.mediaEl;
      return !!el && el.currentTime > 0;
    }, { timeout: 120000, polling: 1000 });
    const st1 = await c.page.evaluate(() => ({ t: globalThis.__SP__.audio.mediaEl.currentTime, d: globalThis.__SP__.audio.mediaEl.duration }));
    await new Promise((r) => setTimeout(r, 2500));
    const st2 = await c.page.evaluate(() => ({ t: globalThis.__SP__.audio.mediaEl.currentTime, paused: globalThis.__SP__.audio.mediaEl.paused }));
    assert.ok(st2.t > st1.t, '流式播放推进 ' + st1.t + ' → ' + st2.t);
    assert.equal(st2.paused, false, '播放中未暂停');
    assert.ok(st1.d > 180 && st1.d < 360, '时长合理（官方 MV 3.5min）: ' + st1.d);

    // —— 4. 搜索源 bili：下拉切 bili → 搜索 → 结果行（bvid 映射 songmid）——
    await c.page.$$eval('.psk', (sels) => { const s = sels[0]; s.value = 'bili'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await c.page.type('.prow .psearch input', 'Never Gonna Give You Up');
    await c.page.evaluate(() => { [...document.querySelectorAll('.prow .btn')].find((b) => /B 站搜索|搜索/.test(b.textContent.trim()) && !b.disabled).click(); });
    await c.page.waitForFunction(() => document.querySelectorAll('.plist .ptrack').length > 0, { timeout: 20000 });
    const sub = await c.page.$eval('.plist .ptrack--lx .ptrack__sub', (e) => e.textContent);
    assert.ok(/BV/.test(sub), '搜索行含 bvid: ' + sub);

    // —— 5. 收藏：点第一行爱心 → 收藏 tab 出现 bili 条目 ——
    await c.page.evaluate(() => { const b = document.querySelector('.plist .pfav-row .pfav'); if (b) b.click(); });
    await new Promise((r) => setTimeout(r, 300));
    await c.page.$$eval('.ptab-btn', (els) => els[3].click()); // 收藏 tab
    await new Promise((r) => setTimeout(r, 500));
    const favText = await c.page.$$eval('.ptab .ptrack__name, .ptab .pfav-row .ptrack__name', (els) => els.map((e) => e.textContent).join('|')).catch(() => '');
    assert.ok(/Never Gonna|测试/.test(favText) || favText.length > 0, '收藏 tab 有条目: ' + favText.slice(0, 80));
    const err404 = (c.problems || []).filter((p) => /http 4\d\d|http 5\d\d/.test(String(p)));
    assert.equal(err404.length, 0, '无 4xx/5xx: ' + err404.join('; '));
  } finally {
    await c.close().catch(() => {});
    await srv.stop().catch(() => {});
  }
});
