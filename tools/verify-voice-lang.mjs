// 中日配音热切换 端到端验证（无头浏览器）：setVoiceLang 存在 → URL 改写 → 设置持久化 →
// 真实播放按语言走 /voice/jp|cn/ → 404 回退 CN。假设验证服务器已在 PORT 上运行（无需对局）。
import puppeteer from 'puppeteer-core';

const PORT = process.argv[2] || '24599';
const BASE = `http://127.0.0.1:${PORT}`;
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: 'new',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 30000 });
await new Promise((r) => setTimeout(r, 2000));

// ① 死控件修复：audio.setVoiceLang 存在（上游版 audio.js 无此方法）
const hasMethod = await page.evaluate(async () => {
  const { audio } = await import('/js/audio.js');
  return typeof audio.setVoiceLang === 'function';
});
check('audio.setVoiceLang 已实现（死控件修复）', hasMethod);

// ② 纯函数 voiceLangUrl：cn→jp 改写 / cn 目标不改写 / 非 voice 路径不改写
const pure = await page.evaluate(async () => {
  const { voiceLangUrl } = await import('/js/audio.js');
  const cn = '/assets/audio/voice/cn/char_102_texas/cn_019.mp3';
  return {
    rewrite: voiceLangUrl(cn, 'jp') === '/assets/audio/voice/jp/char_102_texas/cn_019.mp3',
    self: voiceLangUrl(cn, 'cn') === null,
    foreign: voiceLangUrl('/assets/audio/bgm/combat.mp3', 'jp') === null,
    junk: voiceLangUrl(null, 'jp') === null,
  };
});
check('voiceLangUrl cn→jp 改写正确', pure.rewrite);
check('voiceLangUrl cn 目标不改写', pure.self);
check('voiceLangUrl 非 voice 路径不改写', pure.foreign && pure.junk);

// ③ 设置持久化（真实 UI 路径）：按钮走 updateSettings → store → 订阅 → audio.setVoiceLang。
//    默认 cn → 切 jp 落 store + localStorage → 切回 cn。
const persist = await page.evaluate(async () => {
  const { audio } = await import('/js/audio.js');
  const { settingsStore, updateSettings } = await import('/js/ui/settings.js');
  const def = settingsStore.get().voiceLang;
  updateSettings({ voiceLang: 'jp' });
  const afterJp = { audio: audio.voiceLang, store: settingsStore.get().voiceLang,
    ls: (globalThis.localStorage?.getItem('sp.pref.settings') || '').includes('"voiceLang":"jp"') };
  updateSettings({ voiceLang: 'cn' });
  const backCn = audio.voiceLang === 'cn' && settingsStore.get().voiceLang === 'cn';
  audio.setVoiceLang('cn');   // 幂等：同语言重复设置无副作用
  return { def, afterJp, backCn };
});
check(`默认语音语言为 cn（现状行为不变）`, persist.def === 'cn', `got ${persist.def}`);
check('切 jp：audio + settingsStore + localStorage 同步', persist.afterJp.audio === 'jp' && persist.afterJp.store === 'jp' && persist.afterJp.ls,
  JSON.stringify(persist.afterJp));
check('切回 cn 生效且幂等', persist.backCn);

// ④ 真实播放：解锁音频后，jp 模式下干员语音请求 /voice/jp/，cn 模式请求 /voice/cn/
//    （resource timing 记录的是实际发出的请求，不碰播放内部状态；游戏页资源多，默认 250 条
//    buffer 已溢出——先扩容再清空，否则语音请求根本不进 entries）
await page.evaluate(() => { performance.setResourceTimingBufferSize(10000); performance.clearResourceTimings(); });
await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
await new Promise((r) => setTimeout(r, 500));
await page.evaluate(async () => {
  const { audio } = await import('/js/audio.js');
  audio.setVoiceLang('jp');
  window.__vlStartedJp = audio.voice('char_102_texas', 'select');
  await new Promise((r) => setTimeout(r, 1500));
  audio.setVoiceLang('cn');
  window.__vlStartedCn = audio.voice('char_102_texas', 'select');
  await new Promise((r) => setTimeout(r, 1500));
});
await new Promise((r) => setTimeout(r, 800));
const played = await page.evaluate(() => {
  const urls = performance.getEntriesByType('resource').map((e) => e.name);
  return {
    startedJp: window.__vlStartedJp,
    startedCn: window.__vlStartedCn,
    // the audio manager fetches the extension-less /media/ form first (public/js/media.js); the
    // direct /assets/audio/… URL only appears when the media route is unusable
    jp: urls.some((u) => /\/voice\/jp\/char_102_texas\/cn_\d+(\.mp3)?$/.test(u)),
    cn: urls.some((u) => /\/voice\/cn\/char_102_texas\/cn_\d+(\.mp3)?$/.test(u)),
  };
});
check('jp 模式下 voice() 启动成功', played.startedJp === true);
check('jp 模式实际请求了 /voice/jp/ 语音文件', played.jp);
check('cn 模式实际请求了 /voice/cn/ 语音文件', played.cn && played.startedCn === true);

// ⑤ 404 回退：请求一个不存在的 jp 文件，应回退播放清单里的 cn 行（同一 token 窗口内）
const fallback = await page.evaluate(async () => {
  const { audio } = await import('/js/audio.js');
  audio.setVoiceLang('jp');
  const token = ++audio.voiceToken;
  audio._playVoice('/assets/audio/voice/jp/char_102_texas/cn_999_missing.mp3', token, 1,
    '/assets/audio/voice/cn/char_102_texas/cn_021.mp3');
  await new Promise((r) => setTimeout(r, 2500));
  return true;
});
await new Promise((r) => setTimeout(r, 500));
const fallbackUrls = await page.evaluate(() => {
  const urls = performance.getEntriesByType('resource').map((e) => e.name);
  return {
    missing: urls.some((u) => /\/voice\/jp\/char_102_texas\/cn_999_missing(\.mp3)?$/.test(u)),
    cnFallback: urls.some((u) => /\/voice\/cn\/char_102_texas\/cn_021(\.mp3)?$/.test(u)),
  };
});
check('404 回退：先请求 jp 缺失文件、再回退到 cn 行', fallback && fallbackUrls.missing && fallbackUrls.cnFallback,
  JSON.stringify(fallbackUrls));

check('页面无 JS 错误', errors.length === 0, errors.slice(0, 2).join('; '));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
