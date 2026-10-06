// 监控器端到端验证：模拟玩家登录 → 建房 → 加AI → 开局，然后观察 /monitor?json
// 用法: node tools/test-monitor.mjs [port]
import WebSocket from 'ws';

const port = process.argv[2] || '24778';
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
let id = 0;
const pending = new Map();
const send = (t, extra = {}) => new Promise((resolve, reject) => {
  const rid = ++id;
  pending.set(rid, resolve);
  ws.send(JSON.stringify({ t, rid, ...extra }));
});
const timeout = (ms, tag) => setTimeout(() => reject(new Error(`${tag} timeout`)), ms);

ws.on('message', (buf) => {
  const m = JSON.parse(buf.toString());
  if (m.rid && pending.has(m.rid)) { pending.get(m.rid)(m); pending.delete(m.rid); }
});
ws.on('open', async () => {
  try {
    const t1 = timeout(8000, 'hello');
    const hello = await send('hello', { name: '测试博士' });
    clearTimeout(t1);
    if (hello.error) throw new Error('hello refused: ' + JSON.stringify(hello));
    console.log('[1] hello OK, playerId =', hello.playerId);

    const t2 = timeout(8000, 'room.create');
    const room = await send('room.create', { mode: 'coop', difficulty: '标准' });
    clearTimeout(t2);
    if (room.error) throw new Error('create refused: ' + JSON.stringify(room.error));
    console.log('[2] room created:', room.state?.code || room.code || '(see monitor)');

    const t3 = timeout(8000, 'room.addBot');
    const bot = await send('room.addBot');
    clearTimeout(t3);
    console.log('[3] bot added:', bot.error ? JSON.stringify(bot.error) : 'OK');

    const t4 = timeout(8000, 'room.ready');
    await send('room.ready', { ready: true });
    clearTimeout(t4);
    console.log('[4] ready OK (not starting match — lobby view is enough)');

    console.log('\nnow fetch /monitor?json:');
    const r = await fetch(`http://127.0.0.1:${port}/monitor?json`);
    const d = await r.json();
    console.log(JSON.stringify(d, null, 2));
    ws.close();
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
});
ws.on('error', (e) => { console.error('WS error:', e.message); process.exit(1); });
