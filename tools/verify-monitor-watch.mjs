// monitor 监看（m.monitor）端到端验证：无席位窥看他人完整 m.private
// 用法: node tools/verify-monitor-watch.mjs [port]
import { TestClient } from '../test/helpers/wsClient.js';

const port = process.argv[2] || '24599';
const url = `ws://127.0.0.1:${port}/ws`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
};

// ① 玩家 A 建房并开局（solo 房不可观战，用 coop）
const a = await TestClient.connect(url);
await a.hello('玩家A');
const created = await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
const state = await a.waitFor('room.state');
const code = state.code || created.code;
check('玩家A 建房', !!code, `房间 ${code}`);

await a.request({ t: 'room.addBot' });          // 加一个 AI 凑够开局条件（或直接 ready）
await a.request({ t: 'room.ready', ready: true });
const started = await a.request({ t: 'room.start' });
check('对局开始', started.t !== 'error', started.t === 'error' ? started.code : 'ok');

// 等 A 收到自己的 m.private（确认对局进入可监看状态）
const privA = await a.waitFor('m.private');
check('玩家A 收到 m.private', !!privA, `playerId=${privA?.playerId}`);

// ② 监看者 M 连接（不入房、不占座位），订阅 A
const m = await TestClient.connect(url);
await m.hello('监看者');
const monReply = await m.request({ t: 'm.monitor', code, targetPlayerId: privA.playerId });
check('监看者订阅成功', monReply.t !== 'error', monReply.t === 'error' ? monReply.code : 'ok');

// ③ 监看者应立即收到 A 的 privateView（addMonitorWatcher 的补发）
const privM = await m.waitFor('m.private', (f) => f._monitor === true);
check('监看者收到 _monitor 标记的 privateView', !!privM, `playerId=${privM?.playerId}`);
check('监看者看到的是被看玩家的数据', privM?.playerId === privA?.playerId, `${privM?.playerId} vs ${privA?.playerId}`);

// ④ 关键：完整字段（装备/整备区/商店）——这就是原生观战看不到的
const hasShop = !!privM?.shop && Array.isArray(privM.shop.slots);
const hasHand = Array.isArray(privM?.hand);
const hasBoard = Array.isArray(privM?.board);
check('含商店 slots', hasShop, `level=${privM?.shop?.level} slots=${privM?.shop?.slots?.length}`);
check('含整备区 hand', hasHand, `hand=${privM?.hand?.length}`);
check('含棋盘 board（装备在其中）', hasBoard, `board=${privM?.board?.length}`);

// ⑤ 房间统计不受影响：监看者不占观战席、不计 humans
const h = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());
check('监看者不占观战席位', h.spectators === 0, `spectators=${h.spectators}`);
check('监看者不计入 humans', h.humans === 1, `humans=${h.humans}（应为 1 = 玩家A）`);

// ⑥ 取消监看
const off = await m.request({ t: 'm.monitor', code, targetPlayerId: null });
check('取消监看', off.t !== 'error', off.t === 'error' ? off.code : 'ok');

// ⑦ 非法目标被拒（协议回复形状: {t:'error', code}）
const bad = await m.request({ t: 'm.monitor', code, targetPlayerId: 'p_nonexistent' });
check('非法目标被拒', bad.t === 'error', bad.t === 'error' ? bad.code : `（未拒绝: ${JSON.stringify(bad)}）`);

// ⑧ 不存在的房间被拒
const badRoom = await m.request({ t: 'm.monitor', code: 'ZZZZ', targetPlayerId: privA.playerId });
check('不存在房间被拒', badRoom.t === 'error', badRoom.t === 'error' ? badRoom.code : `（未拒绝: ${JSON.stringify(badRoom)}）`);

await a.close();
await m.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
process.exit(failed.length ? 1 : 0);
