// 线上验证：顺延后的 BOSS(18)/隐藏 BOSS(19) 回合必须真的有怪。
// 直接读线上配置 + 用线上代码（同端口进程无关，纯逻辑验证）+ 线上 HTTP 摘要确认。
const PORT = process.argv[2] || '24500';
const base = `http://127.0.0.1:${PORT}`;
let bad = 0;
const ok = (n, cond, d = '') => { if (!cond) bad++; console.log(`${cond ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

// ① 线上健康
const h = await (await fetch(`${base}/healthz`)).json();
ok('线上健康', h.ok === true, `app=${h.app} matches=${h.matches}`);

// ② 线上控制台摘要
const api = await (await fetch(`${base}/console/api`)).json();
ok('控制台摘要含回合编排/对局节奏', /回合编排/.test(api.summary) && /对局节奏/.test(api.summary), api.summary);
const er = api.config.extraRounds;
ok('线上 extraRounds count=4', er.count === 4, `count=${er.count}`);
ok('线上曲线 stretchShape', er.curve === 'stretchShape', er.curve);

// ③ 用线上配置跑一次 GameData/BOSS 波次逻辑（本地同代码）
const { getData } = await import('../server/data.js');
const { GameData } = await import('../server/match/gamedata.js');
const { buildNormalWave, buildBossWave } = await import('../server/match/waves.js');
const gd = new GameData(getData({ quiet: true }), 'mode_multi_normal');
ok('bossRound=18 / hiddenRound=19', gd.bossRound === 18 && gd.hiddenRound === 19, `${gd.bossRound}/${gd.hiddenRound}`);

const rng = () => 0.5;
const factions = [{}, {}, {}];
for (let r = 13; r <= 19; r++) {
  const isBoss = r === gd.bossRound || r === gd.hiddenRound;
  const w = isBoss
    ? buildBossWave(gd, rng, factions, r, { bossId: 'boss_9', solo: false })
    : buildNormalWave(gd, rng, factions, r);
  const n = (w.spawns || []).length;
  ok(`第 ${r} 回合有怪${isBoss ? '（BOSS 战）' : ''}`, n > 0, `spawns=${n} template=${w.templateId}`);
}
const rc19 = gd.roundCfg(19);
ok('第 19 回合标记为隐藏 BOSS', rc19?.isHidden === true);
const rc18 = gd.roundCfg(18);
ok('第 18 回合带主 BOSS 模板', !!rc18?.bossTemplates && Object.keys(rc18.bossTemplates).length > 0,
  Object.keys(rc18 || {}).join(',') && `${Object.keys(rc18.bossTemplates).length} 个模板`);

console.log(bad ? `\n=== 失败 ${bad} 项 ===` : '\n=== 全部通过 ===');
process.exitCode = bad ? 1 : 0;
