// 影子观战端到端验证：服务端帧完整性 + 无头浏览器渲染真实游戏界面
import puppeteer from 'puppeteer-core';
import { TestClient } from '../test/helpers/wsClient.js';

const PORT = process.argv[2] || '24599';
const url = `ws://127.0.0.1:${PORT}/ws`;
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

// ① 玩家 A 建房开局（有真实棋盘数据）
const a = await TestClient.connect(url);
await a.hello('玩家A');
const created = await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
const state = await a.waitFor('room.state');
const code = state.code || created.code;
await a.request({ t: 'room.addBot' });
await a.request({ t: 'room.ready', ready: true });
await a.request({ t: 'room.start' });
const privA = await a.waitFor('m.private');
console.log(`已造局 ${code}, 玩家A=${privA.playerId}`);

// 推进到休整期（PREP）——那里才有棋盘 canvas；策略轮选需要按当前回合轮转
try {
  await a.request({ t: 'g.infoReady' });
  // 策略轮选：等轮到谁就选谁（最多等 3 轮）
  for (let i = 0; i < 3; i++) {
    const pub = await a.waitFor('m.public', (f) => f.phase === 'BAND_DRAFT');
    const turn = pub?.draft?.turnPid;
    const cands = pub?.draft?.candidates || pub?.draft?.bands || [];
    const pick = Array.isArray(cands) && cands[0] ? (typeof cands[0] === 'string' ? cands[0] : cands[0].bandId) : null;
    if (turn === privA.playerId && pick) { await a.request({ t: 'g.band', bandId: pick }); break; }
    await new Promise((r) => setTimeout(r, 800));
  }
  // 等到进入 PREP
  await a.waitFor('m.public', (f) => f.phase === 'PREP', 15000).catch(() => {});
} catch { /* 单人房可能直接跳过轮选 */ }
await new Promise((r) => setTimeout(r, 2000));
const phaseNow = await fetch(`http://127.0.0.1:${PORT}/monitor?json`).then((r) => r.json());
console.log('当前阶段:', phaseNow.rooms[0]?.match?.phase);

// ② 影子客户端订阅，验证帧序列完整性
const s = await TestClient.connect(url);
await s.hello('影子');
const sub = await s.request({ t: 'm.monitor', code, targetPlayerId: privA.playerId });
check('影子订阅成功', sub.t !== 'error', sub.t === 'error' ? sub.code : 'ok');

const monPriv = await s.waitFor('m.private', (f) => f._monitor === true);
check('收到 _monitor 标记的 m.private', !!monPriv, `playerId=${monPriv?.playerId}`);
check('private 含完整字段', !!(monPriv?.shop && Array.isArray(monPriv?.hand) && Array.isArray(monPriv?.board)),
  `shop/hand=${monPriv?.hand?.length}/board=${monPriv?.board?.length}`);

const monPub = await s.waitFor('m.public');
check('收到 m.public（阶段/玩家列表）', !!monPub && Array.isArray(monPub.players), `phase=${monPub?.phase}`);

// ③ 无头浏览器：打开影子入口，验证渲染出真实游戏界面
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new', args: ['--ignore-certificate-errors'],
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
// 容错导航（buildGuard 可能触发一次自动刷新）
let navOk = false;
for (let i = 0; i < 3 && !navOk; i++) {
  try {
    await page.goto(`http://127.0.0.1:${PORT}/?shadow=${code}&as=${privA.playerId}`, { waitUntil: 'domcontentloaded', timeout: 40000 });
    navOk = true;
  } catch (e) {
    if (i === 2) throw e;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
await new Promise((r) => setTimeout(r, 12000));

const info = await page.evaluate(() => {
  const app = document.getElementById('app');
  const canvas = document.querySelectorAll('canvas');
  const txt = app ? app.innerText.slice(0, 200) : '(no app)';
  return { hasCanvas: canvas.length > 0, txt, route: document.body.className };
});
check('页面渲染出真实对局界面', /选择策略|确认本局信息|休整|作战|STRATEGY|BRIEFING|PREP|BAND/.test(info.txt), info.txt.replace(/\|/g, ' ').slice(0, 70));
check('界面显示了被看玩家的名字', info.txt.includes('玩家A') || info.txt.includes(privA.playerId), '');
check('无 JS 错误', errs.length === 0, errs.slice(0, 2).join('; '));

await browser.close();
await a.close();
await s.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
