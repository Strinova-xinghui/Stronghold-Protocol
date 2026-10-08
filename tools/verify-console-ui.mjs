// 控制台页面 UI 验证：加载 → 表单渲染 → 改值保存 → 状态更新 → 无 JS 错误
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
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(`http://127.0.0.1:${PORT}/console`, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise((r) => setTimeout(r, 1200));

check('页面标题正确', (await page.title()).includes('规则控制台'));
check('5 个标签页渲染', (await page.$$('.tab')).length === 5);
check('状态胶囊显示生效中', /生效中/.test(await page.$eval('#stat', (e) => e.textContent)));
check('三选一表单有候选位规则', (await page.$$('#roSlots .sub')).length >= 1);
check('抽奖表单有回合项', (await page.$$('#rlRounds .sub')).length >= 3, `rounds=${(await page.$$('#rlRounds .sub')).length}`);
check('保存按钮存在', !!(await page.$('#save')));

// 切到抽奖页，改 rolls，保存
await page.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('回合抽奖'))?.click());
await new Promise((r) => setTimeout(r, 300));
const rollsInput = await page.$('input[data-f="roundLottery.rolls"]');
check('抽奖页可见且含 rolls 输入', !!rollsInput && await rollsInput.isIntersectingViewport().catch(() => true));
await page.evaluate(() => { const i = document.querySelector('input[data-f="roundLottery.rolls"]'); i.value = '4'; i.dispatchEvent(new Event('change', { bubbles: true })); });
await page.click('#save');
await new Promise((r) => setTimeout(r, 1500));
const msg = await page.$eval('#msg', (e) => e.textContent);
check('保存后提示成功', /已保存并生效/.test(msg), msg.slice(0, 60));

// 独立读 API 确认 rolls=4
const api = await (await fetch(`http://127.0.0.1:${PORT}/console/api`)).json();
check('API 确认 rolls=4', api.rules?.roundLottery?.rolls === 4, `rolls=${api.rules?.roundLottery?.rolls}`);

// 还原 rolls=2
await page.evaluate(() => { const i = document.querySelector('input[data-f="roundLottery.rolls"]'); i.value = '2'; i.dispatchEvent(new Event('change', { bubbles: true })); });
await page.click('#save');
await new Promise((r) => setTimeout(r, 1200));
const api2 = await (await fetch(`http://127.0.0.1:${PORT}/console/api`)).json();
check('已还原 rolls=2', api2.rules?.roundLottery?.rolls === 2, `rolls=${api2.rules?.roundLottery?.rolls}`);

// 切到原始 JSON 页
await page.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('原始'))?.click());
await new Promise((r) => setTimeout(r, 300));
const raw = await page.$eval('#raw', (e) => e.value);
check('原始 JSON 页显示完整配置', /"rewardOffer"/.test(raw) && /"roundLottery"/.test(raw), `${raw.length} 字符`);

check('页面无 JS 错误', errors.length === 0, errors.slice(0, 2).join('; '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
