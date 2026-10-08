// 监控+控制台合并页 UI 验证：导航切换、控制台 iframe 载入、观战页内嵌入（不再新标签）。
// 用法: node tools/verify-monitor-console.mjs [port]
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
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push('console: ' + m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/monitor`, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise((r) => setTimeout(r, 1000));

// ① 三个导航按钮
const navs = await page.$$eval('.nav-btn', (els) => els.map((e) => e.textContent));
check('导航有 3 个标签（监控/规则控制台/观战）', navs.length === 3, navs.join(' | '));

// ② 默认显示监控视图
check('默认显示监控视图', await page.$eval('#view-monitor', (e) => !e.classList.contains('hidden')));
check('默认隐藏控制台视图', await page.$eval('#view-console', (e) => e.classList.contains('hidden')));

// ③ 切到控制台：iframe 载入 /console
await page.evaluate(() => [...document.querySelectorAll('.nav-btn')].find((b) => b.textContent.includes('规则控制台')).click());
await new Promise((r) => setTimeout(r, 2000));
const consoleSrc = await page.$eval('#console-frame', (e) => e.src);
check('切到控制台后 iframe 载入 /console', /\/console$/.test(consoleSrc), consoleSrc);
// iframe 内真的渲染出控制台（跨 frame 检查）
const frames = page.frames();
const cFrame = frames.find((f) => /\/console$/.test(f.url()));
check('控制台 iframe 已渲染', !!cFrame);
if (cFrame) {
  const tabs = await cFrame.$$eval('.tab', (els) => els.length).catch(() => 0);
  check('iframe 内控制台有 7 个规则标签', tabs === 7, `实际 ${tabs}`);
}

// ④ 切到观战：iframe 空载 + 地址栏
await page.evaluate(() => [...document.querySelectorAll('.nav-btn')].find((b) => b.textContent.includes('观战')).click());
await new Promise((r) => setTimeout(r, 500));
check('切到观战视图', await page.$eval('#view-watch', (e) => !e.classList.contains('hidden')));
check('观战视图有地址输入框', !!(await page.$('#watch-url')));
check('观战视图有载入按钮', !!(await page.$('#watch-go')));
check('观战 iframe 有 autoplay 委托（否则没声音）', await page.$eval('#watch-frame', (e) => /autoplay/.test(e.getAttribute('allow') || '')));
check('有「退出观战」按钮', !!(await page.$('#watch-exit')));
check('观战 iframe 存在', !!(await page.$('#watch-frame')));

// ⑤ 模拟点击玩家行的「观战」→ 应填入 iframe 且不再新标签
const hasWatchBtn = await page.$('[data-watch-url]');
if (hasWatchBtn) {
  const before = (await browser.pages()).length;
  await hasWatchBtn.click();
  await new Promise((r) => setTimeout(r, 1500));
  const after = (await browser.pages()).length;
  const wSrc = await page.$eval('#watch-frame', (e) => e.src);
  check('点「观战」在页内 iframe 打开（未新开标签）', after === before && /shadow=/.test(wSrc), `pages ${before}→${after} src=${wSrc.slice(0, 60)}`);
  check('地址栏已填入观战 URL', /shadow=/.test(await page.$eval('#watch-url', (e) => e.value)));
} else {
  console.log('  （无进行中的对局，跳过观战点击测试）');
}

// ⑥ 切走观战会清空 iframe（释放影子 WS 连接）
await page.evaluate(() => [...document.querySelectorAll('.nav-btn')].find((b) => b.textContent.includes('监控')).click());
await new Promise((r) => setTimeout(r, 600));
const wAfter = await page.$eval('#watch-frame', (e) => e.src);
check('切走观战后 iframe 被清空（释放连接）', wAfter === 'about:blank', wAfter);

check('页面无 JS 错误', errors.length === 0, errors.slice(0, 2).join('; '));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
process.exitCode = failed.length ? 1 : 0;
