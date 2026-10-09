// wait-match-end.mjs — 后台监听对局是否结束（自研 2026-10-09）：轮询 /healthz 直到 matches == 0，退出码 0 =
// 对局已结束（调用方收到后台任务完成回信后触发闪断重启上线）。退出码 3 = 服务器失联；2 = 超时。
// 用法: node tools/wait-match-end.mjs [port] [pollSec] [maxMinutes]
// 注意：必须 UTF-8（node 无 BOM 问题；.ps1 哨兵脚本才有 BOM 坑）。
const port = process.argv[2] || '24500';
const pollSec = Math.max(10, Number(process.argv[3]) || 30);
const maxMin = Math.max(1, Number(process.argv[4]) || 180);
const url = `http://127.0.0.1:${port}/healthz`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deadline = Date.now() + maxMin * 60 * 1000;
let unreachable = 0;
console.log(`监听对局结束：${url} · 每 ${pollSec}s 轮询 · 最长 ${maxMin} 分钟`);
let rounds = 0;
while (Date.now() < deadline) {
  rounds++;
  let h = null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    h = await r.json();
  } catch { h = null; }
  if (!h || !h.ok) {
    unreachable++;
    if (unreachable >= 3) { console.log(`EXIT3 服务器失联（连续 ${unreachable} 次 /healthz 不通）`); process.exitCode = 3; break; }
    console.log(`[${rounds}] /healthz 不通（${unreachable}/3），重试…`);
  } else {
    unreachable = 0;
    const m = Number(h.matches) || 0;
    if (m === 0) { console.log(`EXIT0 对局已结束（matches=0 · 轮询 ${rounds} 次）`); process.exitCode = 0; break; }
    if (rounds % 4 === 1 || rounds === 1) console.log(`[${rounds}] 对局进行中：matches=${m} · 房间 ${h.rooms} · 玩家 ${h.humans}`);
  }
  await sleep(pollSec * 1000);
}
if (process.exitCode == null) { console.log(`EXIT2 超时（${maxMin} 分钟，对局仍未结束）`); process.exitCode = 2; }
