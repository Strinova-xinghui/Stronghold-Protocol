// 策略搜索 (2026-10-08) UI 验证：无头浏览器走真实路径 标题→独立模拟→房间→简报→选策略，
// 验证搜索栏的 过滤 / 计数 / 空态 / 清空。单人房间独立于玩家对局，浏览器关闭即随断线消失。
// 用法: node tools/verify-band-search.mjs [port]
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
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await sleep(2500);

  // 点可见文本（按钮被禁用则跳过）
  const clickText = (sel, text) => page.evaluate((s, t) => {
    const el = [...document.querySelectorAll(s)].find((e) => (e.textContent || '').includes(t) && !e.disabled);
    if (el) { el.click(); return true; } return false;
  }, sel, text);

  // ① 标题页：输入代号 → 开始
  const titleInput = await page.$('.title-login .field__input');
  check('标题页有代号输入框', !!titleInput);
  if (titleInput) await titleInput.type('搜索验证', { delay: 30 });
  await clickText('.title-login button', '开始');
  await sleep(2000);

  // ② 大厅：选「独立模拟」→ 开始独立模拟（按 ModeCard 根类精确选卡片，别选到容器）
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('button.mode-card')].find((e) => (e.textContent || '').includes('独立模拟'));
    if (el) el.click();
  });
  await sleep(500);
  const enteredLobby = await clickText('.create-box button', '独立模拟');
  check('点「开始独立模拟」', enteredLobby);
  await sleep(2500);

  // ③ 房间：开始模拟
  await clickText('button', '开始模拟');
  await sleep(2500);

  // ④ 简报：准备就绪 → 选策略
  const rd = await clickText('button', '准备就绪');
  check('简报页点「准备就绪」', rd);

  // ⑤ 选策略页出现搜索栏
  let bar = null;
  for (let i = 0; i < 20 && !bar; i++) { bar = await page.$('[data-testid="draft-search"]'); if (!bar) await sleep(1000); }
  check('选策略页出现搜索栏', !!bar);

  // ⑥ 计数 = 全部策略
  const count0 = bar ? await page.$eval('[data-testid="draft-search-count"]', (e) => e.textContent) : '';
  const total = Number(String(count0).split('/')[0]);
  check('计数显示全部策略', /^\d+\/\d+$/.test(String(count0)) && total === Number(String(count0).split('/')[1]), `count=${count0}`);

  // ⑦ 输入首张策略名前两字 → 计数减少、网格只剩匹配卡片
  let firstName = null;
  for (let i = 0; i < 15 && !firstName; i++) {
    firstName = await page.$eval('.dband__name', (e) => e.textContent).catch(() => null);
    if (!firstName) await sleep(1000);
  }
  check('策略卡片已渲染', !!firstName);
  const input = await page.$('[data-testid="draft-search"] input');
  check('搜索输入框存在', !!input);
  if (input) {
    await input.type(firstName.slice(0, 2), { delay: 40 });
    await sleep(900);
  }
  const count1 = firstName ? await page.$eval('[data-testid="draft-search-count"]', (e) => e.textContent).catch(() => '') : '';
  check(`输入「${(firstName || '').slice(0, 2)}」后计数减少`, firstName && Number(String(count1).split('/')[0]) < total, `${count0} → ${count1}`);
  const cards1 = await page.$$('.dband');
  check('网格只剩匹配的卡片', firstName && cards1.length === Number(String(count1).split('/')[0]), `实际 ${cards1.length}，计数 ${count1}`);

  // ⑧ 乱关键词 → 空态提示 + 网格无卡片
  if (input) {
    await input.type('不存在的关键词xyz', { delay: 20 });
    await sleep(900);
  }
  const empty = await page.$('[data-testid="draft-search-empty"]');
  check('乱关键词显示空态提示', !!empty);
  const cards2 = await page.$$('.dband');
  check('空态时网格无卡片', cards2.length === 0, `实际 ${cards2.length}`);

  // ⑨ 清空按钮 → 计数复原
  const clearBtn = await page.$('.draft-grid__clear');
  check('有清空按钮', !!clearBtn);
  if (clearBtn) { await clearBtn.click(); await sleep(700); }
  const count3 = await page.$eval('[data-testid="draft-search-count"]', (e) => e.textContent);
  check('清空后计数复原', count3 === count0, `${count1} → ${count3}`);

  // ⑩ 无页面错误
  check('无页面错误', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exitCode = failed ? 1 : 0;
