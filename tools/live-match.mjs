// 建一个真实对局并保持存活（供 UI 验证观战用）。跑完保持 N 秒后退出。
// 用法: node tools/live-match.mjs [port] [keepSeconds]
import { TestClient } from '../test/helpers/wsClient.js';

const port = process.argv[2] || '24599';
const keep = Number(process.argv[3] || 60);
const url = `ws://127.0.0.1:${port}/ws`;

const a = await TestClient.connect(url);
await a.hello('观战验证A');
const created = await a.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
const state = await a.waitFor('room.state');
const code = state.code || created.code;
const b = await TestClient.connect(url);
await b.hello('观战验证B');
await b.request({ t: 'room.join', code });
await b.waitFor('room.state');
await a.request({ t: 'room.ready', ready: true });
await b.request({ t: 'room.ready', ready: true });
await a.request({ t: 'room.start' });
console.log(`房间 ${code} 已开局，保持 ${keep} 秒`);
await new Promise((r) => setTimeout(r, keep * 1000));
await a.close().catch(() => {});
await b.close().catch(() => {});
console.log('已关闭');
process.exitCode = 0;
