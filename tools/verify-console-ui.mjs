// 控制台页面 UI 验证：加载 → 表单渲染 → 改值保存 → 状态更新 → 无 JS 错误
import puppeteer from 'puppeteer-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
check('9 个标签页渲染', (await page.$$('.tab')).length === 9);
check('状态胶囊显示生效中', /生效中/.test(await page.$eval('#stat', (e) => e.textContent)));
check('三选一表单有候选位规则', (await page.$$('#roSlots .sub')).length >= 1);
check('抽奖表单有回合项', (await page.$$('#rlRounds .sub')).length >= 3, `rounds=${(await page.$$('#rlRounds .sub')).length}`);
check('保存按钮存在', !!(await page.$('#save')));
await page.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('回合编排'))?.click());
await new Promise((r) => setTimeout(r, 300));
check('回合编排页有 curve 下拉', !!(await page.$('select[data-f="extraRounds.curve"]')));
check('回合编排页有 count 输入', !!(await page.$('input[data-f="extraRounds.count"]')));
await page.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('对局节奏'))?.click());
await new Promise((r) => setTimeout(r, 300));
check('对局节奏页有 bandDraftMul', !!(await page.$('input[data-f="pacing.bandDraftMul"]')));
check('对局节奏页有 spDraftMul', !!(await page.$('input[data-f="pacing.spDraftMul"]')));
check('对局节奏页有 combatSpeed', !!(await page.$('input[data-f="pacing.combatSpeed"]')));
await page.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('BOSS 血量'))?.click());
await new Promise((r) => setTimeout(r, 300));
check('BOSS 血量页有 mul', !!(await page.$('input[data-f="bossHp.mul"]')));
check('BOSS 血量页有 layerK', !!(await page.$('input[data-f="bossHp.layerK"]')));

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

// 发放页（自研 2026-10-09）：标签渲染 + 懒加载棋子/装备目录（chess.json 约 1.6MB，轮询等列表渲染）
await page.evaluate(() => [...document.querySelectorAll('.tab')].find((t) => t.textContent.includes('发放'))?.click());
let chessCards = [], itemCards = [];
for (let i = 0; i < 20 && (!chessCards.length || !itemCards.length); i++) {
  chessCards = await page.$$('#gChessList .gcard').catch(() => []);
  itemCards = await page.$$('#gItemList .gcard').catch(() => []);
  if (!chessCards.length || !itemCards.length) await sleep(1000);
}
check('发放页有刷新按钮', !!(await page.$('#gRefresh')));
check('发放页有对局选择器', !!(await page.$('#gRoom')));
check('发放页有玩家选择器', !!(await page.$('#gPlayer')));
check('发放页棋子列表已渲染', chessCards.length > 0, `实际 ${chessCards.length}`);
check('发放页装备列表已渲染', itemCards.length > 0, `实际 ${itemCards.length}`);
const gMsgText = await page.$eval('#gMsg', (e) => e.textContent).catch(() => '');
check('发放页数据载入提示', /已载入|没有进行中/.test(gMsgText), gMsgText.slice(0, 60));
check('发放页有精锐/进阶勾选', !!(await page.$('#gChessElite')) && !!(await page.$('#gItemElite')));
check('发放页有数量输入', !!(await page.$('#gChessN')) && !!(await page.$('#gItemN')));

check('页面无 JS 错误', errors.length === 0, errors.slice(0, 2).join('; '));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
