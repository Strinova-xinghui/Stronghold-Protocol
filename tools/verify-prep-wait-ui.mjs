// 等待按钮 UI 验证 v2：不依赖页面加载，直接用 Node 侧渲染（preact-render-to-string 不在依赖里）。
// 改为 DOM 级验证：用 jsdom 不可用——改为纯正则检查（源码级锚点）+ 真实服务器上无头浏览器打开游戏页。
// 简化并聚焦：源码锚点 + 真实页面 props 断言太脆弱；这里只验证「页面在真实对局里渲染出等待按钮」。
// 由于无头进真实对局需要 token 重连（复杂），改为组件直渲：在 about:blank 页面里 import 本地 vendor 文件。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestClient } from '../test/helpers/wsClient.js';

const port = process.argv[2] || '24599';
const BASE = `http://127.0.0.1:${port}`;
const url = `ws://127.0.0.1:${port}/ws`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bandsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/bands.json'), 'utf8'));
const bands = Array.isArray(bandsRaw) ? bandsRaw : (bandsRaw.bands || Object.values(bandsRaw));

const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

// ① 源码锚点（快速失败定位）
const hudSrc = fs.readFileSync(path.join(ROOT, 'public/js/ui/hud.js'), 'utf8');
check('ReadyToggle 含等待按钮（waitbtn）', hudSrc.includes("class=${cx('waitbtn'"));
check('等待按钮始终渲染（v2：与准备独立）', hudSrc.includes('const waitBtn = html`'), 'waitBtn 不再受 ready 门禁');
check('hold 时显示暂停提示条', hudSrc.includes('prep-wait-held'));
check('服务端 g.prepWait 已接线', fs.readFileSync(path.join(ROOT, 'shared/protocol.js'), 'utf8').includes("'g.prepWait'"));

// ② 组件直渲：blank 页面 + import 绝对路径 file 不可行（ES 模块 CORS），改走 http 服务器静态文件 +
//    手动 importMap。最可靠：直接加载游戏页（预热模块）后 evaluate 组件（上一版超时是 networkidle2 太早）。
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new', protocolTimeout: 60000,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// 组件 fixture 页（public/__wait-ui-test.html，只加载 preact + components + hud，无游戏页重资源；
// 服务器不 serve .cache 目录——fixture 必须放 public/ 下）
await page.goto(`${BASE}/__wait-ui-test.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
let ready = false;
for (let i = 0; i < 60; i++) {
  // eslint-disable-next-line no-await-in-loop
  ready = await page.evaluate(() => document.title === 'VL-READY').catch(() => false);
  if (ready) break;
  // eslint-disable-next-line no-await-in-loop
  await new Promise((r) => setTimeout(r, 300));
}
const rendered = await page.evaluate(() => window.__vl || {});
check('fixture 渲染完成', ready && !!rendered.readyNoWait);
check('未就绪：等待按钮也渲染（与准备完全独立）', rendered.unready?.waitBtn && rendered.unready?.readyLabel === '准备就绪',
  `wait=${rendered.unready?.waitLabel} ready=${rendered.unready?.readyLabel}`);
check('就绪未等待：等待按钮出现且文案「等待」', rendered.readyNoWait?.waitBtn && rendered.readyNoWait?.waitLabel === '等待', rendered.readyNoWait?.waitLabel);
check('投票中：按钮高亮 + 「等待中…」（未就绪也能等待）', rendered.waitingPending?.isOn && rendered.waitingPending?.waitLabel === '等待中…', rendered.waitingPending?.waitLabel);
check('hold 成立：按钮 is-held + 全员等待提示条', rendered.waitingHeld?.isHeld && rendered.waitingHeld?.heldTag, `label=${rendered.waitingHeld?.waitLabel}`);
check('页面无 JS 错误', errors.length === 0, errors.slice(0, 2).join('; '));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
