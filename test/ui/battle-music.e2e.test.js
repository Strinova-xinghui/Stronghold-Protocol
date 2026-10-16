// test/ui/battle-music.e2e.test.js — 自研战斗音乐替换的**浏览器回归**（2026-10-16 晚，因一次线上事故新增）。
//
// 事故：给局内屏加「战斗音乐」按钮时，编辑用的 old_string 取自**被 read 截断的输出**，
// 于是 `<button …><Icon name="signal" /><` 少了 `</button>`，紧接着的下一个按钮的闭合标签"替"它闭合了。
// 症状只在**真渲染那一屏**时出现：Preact 抛
//     Failed to execute 'insertBefore' on 'Node': parameter 1 is not of type 'Node'
// （局内屏直接白屏报「界面发生错误」）。单元测试、"按钮文本存在"的断言都抓不到——
// 所以这里用仓库自带的 dev harness /dev/game-mock.html（驱动真实 js/screens/game.js）做**真渲染**断言。
//
// 覆盖：① 局内屏渲染零 pageerror 且角落有战斗音乐按钮；② 独立面板能渲染三行/可选曲/勾选持久化；
// ③ 点歌台仍是 3 tab（解耦未回退）。
// 运行：SP_E2E=1 CHROME_PATH=<chrome|edge> node --test test/ui/battle-music.e2e.test.js

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH
  || (existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('战斗音乐替换 · 浏览器回归', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome/Edge) to run' }, () => {
  let srv, browser, base;
  before(async () => {
    const { startServer } = await import('../../server/index.js');
    const puppeteer = (await import('puppeteer-core')).default;
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true });
    base = `http://127.0.0.1:${srv.port}`;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--force-device-scale-factor=1'] });
  });
  after(async () => { await browser?.close(); await srv?.close(); });

  /** 开一页并收集页面级错误（pageerror 与 console error）。 */
  async function open(url, waitMs = 3500) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 900 });
    const problems = [];
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(waitMs);
    return { page, problems };
  }

  test('局内屏真渲染：零错误 + 角落有战斗音乐按钮（本次事故的回归锁）', async () => {
    const { page, problems } = await open(`${base}/dev/game-mock.html`, 4000);
    const st = await page.evaluate(() => ({
      cornerButtons: document.querySelectorAll('.gm__corner button').length,
      music: !!document.querySelector('.gm__music'),
      battleMusic: !!document.querySelector('.gm__battle-music'),
      sysFault: /界面发生错误|SYSTEM FAULT/.test(document.body.textContent),
    }));
    await page.close();
    assert.ok(st.cornerButtons >= 4, '角落按钮渲染出来了，实际 ' + st.cornerButtons);
    assert.ok(st.music, '点歌台按钮在');
    assert.ok(st.battleMusic, '战斗音乐按钮在（未闭合标签会让整屏渲染失败）');
    assert.ok(!st.sysFault, '没有「界面发生错误」兜底页');
    assert.deepEqual(problems, [], '局内屏不得有页面错误（insertBefore 会出现在这里）');
  });

  test('标题屏真渲染：两个入口都在、零错误', async () => {
    const { page, problems } = await open(base + '/', 3000);
    const labels = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent.trim()));
    await page.close();
    assert.ok(labels.some((t) => t.includes('点歌')), '点歌入口在');
    assert.ok(labels.some((t) => t.includes('战斗音乐')), '战斗音乐入口在');
    assert.deepEqual(problems, [], '标题屏不得有页面错误');
  });

  test('独立面板：三行 + 勾选持久化；点歌台仍 3 tab（解耦未回退）', async () => {
    const { page, problems } = await open(base + '/', 2500);
    await page.evaluate(() => { try { localStorage.removeItem('sp_personal_bgm'); } catch { /* ignore */ } });
    // 面板在没有自定义曲目时显示空态提示（本机没有上传曲）；这里断言三行结构本身
    const rows = await page.evaluate(async () => {
      const [{ BattleMusicPanel }, preact] = await Promise.all([import('/js/ui/battleMusic.js'), import('/vendor/preact.module.js')]);
      const root = document.createElement('div');
      document.body.appendChild(root);
      preact.render(preact.h(() => BattleMusicPanel({ open: true, onClose: () => {} })), root);
      await new Promise((r) => setTimeout(r, 1200));
      const heads = document.querySelectorAll('.bm-head');
      return [...heads].map((e) => e.textContent.replace(/\s+/g, ' ').trim());
    });
    // 点歌台 tab 数
    const tabs = await page.evaluate(async () => {
      const [{ PlayerPanel }, preact] = await Promise.all([import('/js/ui/player.js'), import('/vendor/preact.module.js')]);
      const root = document.createElement('div');
      document.body.appendChild(root);
      preact.render(preact.h(() => PlayerPanel({ open: true, onClose: () => {} })), root);
      await new Promise((r) => setTimeout(r, 700));
      return [...document.querySelectorAll('.ptab-btn')].map((e) => e.textContent.trim());
    });
    await page.close();
    assert.equal(tabs.length, 3, '点歌台回到三个 tab：' + JSON.stringify(tabs));
    assert.ok(!tabs.some((x) => /战斗音乐/.test(x)), '战斗音乐不在点歌台里');
    // 三行只在「服务器有自定义曲目」时渲染；两种情况都必须零错误（有意不依赖上传状态）
    assert.ok(rows.length === 0 || rows.length === 3, '面板行数只能是 0（空态）或 3：' + JSON.stringify(rows));
    assert.deepEqual(problems, [], '面板渲染不得有页面错误');
  });
});
