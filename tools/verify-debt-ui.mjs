// 负债 UI 渲染验证：负数 LP 在 LpTower/队友面板不被截断为 0（v3 修复回归）
import puppeteer from 'puppeteer-core';

const PORT = process.argv[2] || '24599';
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new', protocolTimeout: 60000,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
// 等模块可用
let ready = false;
for (let i = 0; i < 40; i++) {
  // eslint-disable-next-line no-await-in-loop
  ready = await page.evaluate(() => !!document.querySelector('script[type=module]')).catch(() => false);
  if (ready) break;
  // eslint-disable-next-line no-await-in-loop
  await new Promise((r) => setTimeout(r, 300));
}
// 组件级：直接渲染 LpTower 与 rowLp（纯函数），验证负数不被 clamp
const res = await page.evaluate(async () => {
  const { render } = await import('/vendor/preact.module.js');
  const { html } = await import('/js/ui/components.js');
  const { LpTower } = await import('/js/ui/gameComponents.js');
  const { rowLp } = await import('/js/ui/teamPanel.js');
  const el = document.createElement('div');
  document.body.appendChild(el);
  render(html`<${LpTower} value=${-17} size="lg" />`, el);
  const towerText = el.querySelector('.lp__val')?.textContent || '';
  const isDebt = !!el.querySelector('.lp__val--debt');
  // rowLp：负血者 pending 应为 0（不显示扣血预告）
  const rl = rowLp({ playerId: 'pX', lp: -17, alive: true, pendingLp: 5 }, { phase: 'COMBAT' }, null, { cap: 10 });
  return { towerText, isDebt, pending: rl.pending, lp: rl.lp };
});
check('LpTower 显示负数 −17（未被 clamp 为 0）', res.towerText.includes('-17'), `text="${res.towerText}"`);
check('LpTower 负血样式类 lp__val--debt', res.isDebt);
check('rowLp 负血者 pending=0（无扣血预告）', res.pending === 0, `pending=${res.pending}`);
check('rowLp 保留负值 lp=-17', res.lp === -17, `lp=${res.lp}`);
check('页面无 JS 错误', errors.length === 0, errors.slice(0, 2).join('; '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
