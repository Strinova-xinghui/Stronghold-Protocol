// monitor 监看 UI 端到端验证（无头浏览器）：造一局 → 打开 monitor → 点监看 → 断言面板渲染出数据
import puppeteer from 'puppeteer-core';
import { TestClient } from '../test/helpers/wsClient.js';

const PORT = process.argv[2] || '24599';
const URL = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

// ① 用 TestClient 造一局（玩家A 建房 + 开局）
const a = await TestClient.connect(`ws://127.0.0.1:${PORT}/ws`);
await a.hello('玩家A');
const created = await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
const state = await a.waitFor('room.state');
const code = state.code || created.code;
await a.request({ t: 'room.addBot' });
await a.request({ t: 'room.ready', ready: true });
await a.request({ t: 'room.start' });
await a.waitFor('m.private');
console.log(`已造局: 房间 ${code}`);

// ② 无头浏览器打开 monitor
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${URL}/monitor`, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise((r) => setTimeout(r, 2500));

const hasBtn = await page.evaluate(() => !!document.querySelector('.mon-btn'));
check('monitor 出现「监看」按钮', hasBtn);

// ③ 点击监看
if (hasBtn) {
  await page.click('.mon-btn');
  await new Promise((r) => setTimeout(r, 3000));
  const watchVisible = await page.evaluate(() => !document.getElementById('watch').classList.contains('hidden'));
  check('监看面板已展开', watchVisible);
  const bodyText = await page.evaluate(() => document.getElementById('watch-body').innerText);
  check('面板渲染出玩家数据', /资金|商店|整备区/.test(bodyText), bodyText.replace(/\n/g, ' | ').slice(0, 90));
  check('含整备区干员条目', /整备区/.test(bodyText));
  check('含商店区块', /商店/.test(bodyText));
  const wsStatus = await page.evaluate(() => document.getElementById('watch-status').textContent);
  check('WebSocket 已连接', wsStatus.includes('已连接'), wsStatus);
}
check('页面无 JS 错误', errors.length === 0, errors.slice(0, 2).join('; '));

await browser.close();
await a.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
