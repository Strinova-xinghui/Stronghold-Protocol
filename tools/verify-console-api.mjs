// 控制台 API 端到端验证：读 → 改 → 写 → 热更生效 → 非法拒绝 → 恢复
import fs from 'node:fs';
const PORT = process.argv[2] || '24599';
const base = `http://127.0.0.1:${PORT}/console/api`;
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };
const get = async () => (await fetch(base)).json();
const post = async (body, raw = false) => {
  const r = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: raw ? body : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

const original = (await get()).config;

// ① 读回真实配置
const a = await get();
check('GET 返回当前配置', a.ok === true && !!a.config.rewardOffer, `summary=${a.summary}`);

// ② 改一个参数写回 → 热更生效
const mod = JSON.parse(JSON.stringify(original));
mod.roundLottery.rolls = 3;
mod.roundLottery.choices = 4;
mod.prepDebt.cap = 1.2;
const w = await post(mod);
check('POST 保存成功', w.status === 200 && w.body.ok === true, `status=${w.status}`);
check('保存后 rolls=3', w.body.rules?.roundLottery?.rolls === 3, `rolls=${w.body.rules?.roundLottery?.rolls}`);
check('保存后 choices=4', w.body.rules?.roundLottery?.choices === 4);
check('保存后 prepDebt.cap=1.2', w.body.rules?.prepDebt?.cap === 1.2);

// ③ 独立读盘确认真的落盘了（不是只回显）
const disk = JSON.parse(fs.readFileSync('config/custom-rules.json', 'utf8'));
check('磁盘文件已更新', disk.roundLottery.rolls === 3 && disk.prepDebt.cap === 1.2, `disk.rolls=${disk.roundLottery.rolls}`);

// ④ 关闭某规则 → 生效状态变化
const off = JSON.parse(JSON.stringify(original));
off.prepDebt.enabled = false;
const w2 = await post(off);
check('关闭 prepDebt 后 rules.prepDebt=null', w2.body.rules?.prepDebt === null, `prepDebt=${JSON.stringify(w2.body.rules?.prepDebt)}`);
check('关闭后 summary 不含负债', !/负债/.test(w2.body.summary || ''), w2.body.summary);

// ⑤ 非法 JSON 被拒绝（且不写坏文件）
const bad = await post('{ not json', true);
check('非法 JSON → 400 拒绝', bad.status === 400 && bad.body.ok === false, `status=${bad.status} err=${bad.body.error?.slice(0, 40)}`);

// ⑥ 数组 / null 被拒绝
const bad2 = await post([]);
check('数组配置 → 400 拒绝', bad2.status === 400 && bad2.body.ok === false, `err=${bad2.body.error}`);
const bad3 = await post('null', true);
check('null 配置 → 400 拒绝', bad3.status === 400, `err=${bad3.body.error}`);

// ⑦ 拒绝后磁盘仍是上一次成功保存的好配置（对比 off，而不是硬编码值——否则线上/测试服会因残留值不同而假失败）
const disk2 = JSON.parse(fs.readFileSync('config/custom-rules.json', 'utf8'));
check('拒绝后磁盘未被写坏', disk2.roundLottery?.rolls === off.roundLottery.rolls && disk2.prepDebt?.enabled === false,
  `disk.rolls=${disk2.roundLottery?.rolls}（期望 ${off.roundLottery.rolls}）prepDebt.enabled=${disk2.prepDebt?.enabled}`);

// ⑧ 恢复原始配置
const back = await post(original);
check('恢复原配置成功', back.body.ok === true && back.body.rules?.prepDebt?.cap === original.prepDebt.cap, `cap=${back.body.rules?.prepDebt?.cap}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`);
// 不用 process.exit：Windows 上 fetch(undici) 的 keep-alive 连接会让 libuv 在退出时抛
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" 噪音。设 exitCode 让它自然退出。
process.exitCode = failed.length ? 1 : 0;
