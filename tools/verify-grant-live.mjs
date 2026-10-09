// 控制台实时发放（2026-10-09）端到端验证：无头浏览器开 /console → 发放页 → 选对局/玩家 → 搜棋子 → 发放（含精锐/装备/进阶）。
// 前置：需要一个进行中的对局——先跑 node tools/live-match.mjs 24500 120（浏览器断线即随对局消失）。
// 用法: node tools/verify-grant-live.mjs [port]
import puppeteer from 'puppeteer-core';

const PORT = process.argv[2] || '24599';
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new', protocolTimeout: 60000,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|autoplay|AudioContext/i.test(m.text())) errors.push('console: ' + m.text()); });

try {
  await page.goto(`http://127.0.0.1:${PORT}/console`, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1500);

  // ① 切到发放页（懒加载数据）
  await page.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('发放'))?.click());
  let msg = '';
  for (let i = 0; i < 15; i++) {
    msg = await page.$eval('#gMsg', (e) => e.textContent).catch(() => '');
    if (/已载入|没有进行中的对局|载入失败/.test(msg)) break;
    await sleep(1000);
  }
  check('发放页数据已载入', /已载入/.test(msg), msg.slice(0, 60));

  // ② 对局/玩家选择器已填充
  const rooms = await page.$$eval('#gRoom option', (els) => els.map((e) => e.value).filter(Boolean));
  check('对局选择器已填充', rooms.length >= 1, `实际 ${rooms.length}`);
  const players = await page.$$eval('#gPlayer option', (els) => els.map((e) => e.value).filter(Boolean));
  check('玩家选择器已填充', players.length >= 1, `实际 ${players.length}`);

  // ③ 棋子：搜索 → 点选第一张（先验 .sel 生效）→ 勾精锐 → 发放
  const chessCards = await page.$$('#gChessList .gcard');
  check('棋子列表已渲染', chessCards.length > 0, `实际 ${chessCards.length}`);
  await page.evaluate(() => { const i = document.querySelector('#gChessQ'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(500);
  await page.evaluate(() => document.querySelector('#gChessList .gcard')?.click());
  await sleep(400);
  const selOk = await page.$eval('#gChessList .gcard.sel', () => true).catch(() => false);
  check('点选后 .sel 生效', !!selOk);
  await page.click('#gChessElite');                            // 精锐状态
  await sleep(200);
  await page.click('#gGrantChess');
  let grantMsg = '';
  for (let i = 0; i < 10; i++) {
    grantMsg = await page.$eval('#gMsg', (e) => e.textContent).catch(() => '');
    if (/已发放|发放失败/.test(grantMsg)) break;
    await sleep(400);
  }
  check('发放棋子成功（精锐）', /已发放.*✓/.test(grantMsg) || /已发放/.test(grantMsg), grantMsg.slice(0, 80));

  // ④ 装备：搜索 → 点选 → 勾进阶 → 发放
  await page.evaluate(() => { const i = document.querySelector('#gItemQ'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(500);
  await page.evaluate(() => document.querySelector('#gItemList .gcard')?.click());
  await sleep(400);
  await page.click('#gItemElite');                             // 进阶形态
  await sleep(200);
  await page.click('#gGrantItem');
  let itemMsg = '';
  for (let i = 0; i < 10; i++) {
    itemMsg = await page.$eval('#gMsg', (e) => e.textContent).catch(() => '');
    if (/已发放|发放失败/.test(itemMsg)) break;
    await sleep(400);
  }
  check('发放装备成功（进阶）', /已发放/.test(itemMsg), itemMsg.slice(0, 80));

  // ⑤ 发钱：金额 + 勾「同时给左右队友发」→ 每个收件人一条 ✓
  await page.click('#gFundsN', { clickCount: 3 }).catch(() => {});
  await page.evaluate(() => { const i = document.querySelector('#gFundsN'); i.value = '25'; });
  await page.click('#gFundsNb');                               // 同时给左右队友
  await sleep(200);
  await page.click('#gGrantFunds');
  let fundsMsg = '';
  for (let i = 0; i < 10; i++) {
    fundsMsg = await page.$eval('#gMsg', (e) => e.textContent).catch(() => '');
    if (/已发放|发放失败/.test(fundsMsg)) break;
    await sleep(400);
  }
  const fundsHits = (fundsMsg.match(/✓/g) || []).length;
  check('发钱成功（含左右队友）', fundsHits >= 2, fundsMsg.slice(0, 100));

  // ⑥ 独立 API 交叉确认：state 端点仍返回该对局
  const st = await (await fetch(`http://127.0.0.1:${PORT}/console/api/state`)).json();
  check('state API 交叉确认对局仍在', st.ok && st.rooms.length >= 1, `${st.rooms?.length} 房`);

  check('页面无 JS 错误', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exitCode = failed ? 1 : 0;
