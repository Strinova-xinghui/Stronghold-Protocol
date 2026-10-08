// 隐秘核心（顺延后的第 19 回合）真实状态验证。
// 关键：第 18 回合主 BOSS 结算时 endPrep 会调用 lockBossRound(18)——本脚本先复现该状态，
// 再推进到第 19 回合，检查用的是「隐藏 BOSS 模板」而不是主 BOSS 模板，且怪真的生成。
import fs from 'node:fs';
import { makeMatch } from '../test/match/harness.js';
import { createRegistry } from '../server/match/effectsMeta.js';
import { resetCustomRules, CUSTOM_RULES_PATH } from '../server/match/customRules.js';

const REG = createRegistry({ log: { warn() {}, error() {}, info() {} } });
const original = fs.readFileSync(CUSTOM_RULES_PATH, 'utf8');
const writeCfg = (o) => { fs.writeFileSync(CUSTOM_RULES_PATH, JSON.stringify(o, null, 2)); resetCustomRules(); };
let bad = 0;
const ok = (n, cond, d = '') => { if (!cond) bad++; console.log(`${cond ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); };

try {
  const cfg = JSON.parse(original);
  writeCfg(cfg);
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 777, registry: REG, fake: true });
  h.start();
  const m = h.m;

  ok('bossRound=18 / hiddenRound=19', m.gd.bossRound === 18 && m.gd.hiddenRound === 19,
    `${m.gd.bossRound}/${m.gd.hiddenRound}`);
  ok('hiddenBossId 存在', !!m.hiddenBossId, String(m.hiddenBossId));

  // 第 18 回合：主 BOSS（h07 模板）
  h.toPrep(18);
  const bw18 = m.bossWaves || [];
  const n18 = bw18.reduce((s, f) => s + ((f.wave && f.wave.spawns) || []).length, 0);
  ok('第 18 回合主 BOSS 有怪', n18 > 0, `spawns=${n18} template=${bw18[0]?.wave?.templateId}`);
  ok('第 18 回合用主 BOSS 模板（h07）', /h07/.test(bw18[0]?.wave?.templateId || ''), String(bw18[0]?.wave?.templateId));
  ok('roundCfg(18).isHidden=false', m.gd.roundCfg(18)?.isHidden === false);

  // 复现真实状态：主 BOSS 在 18 触发 → endPrep 锁定
  m.gd.lockBossRound(18);
  ok('锁定后 bossRound 仍为 18（不漂移）', m.gd.bossRound === 18, String(m.gd.bossRound));
  ok('锁定后 hiddenRound 仍为 19', m.gd.hiddenRound === 19, String(m.gd.hiddenRound));

  // 推进到第 19 回合（隐秘核心）
  m.startRound(19);
  const bw19 = m.bossWaves || [];
  const n19 = bw19.reduce((s, f) => s + ((f.wave && f.wave.spawns) || []).length, 0);
  const tpl19 = bw19[0]?.wave?.templateId;
  ok('第 19 回合有 BOSS 波次字段', bw19.length > 0, `fields=${bw19.length}`);
  ok('第 19 回合有怪（隐藏 BOSS + 护卫）', n19 > 0, `spawns=${n19}`);
  ok('第 19 回合用**隐藏** BOSS 模板（h08，不是主 BOSS 的 h07）', /h08/.test(tpl19 || ''), String(tpl19));

  const rc19 = m.gd.roundCfg(19);
  ok('roundCfg(19).isHidden=true', rc19?.isHidden === true);
  ok('roundCfg(19) 含真实 hiddenBossId 模板', !!(rc19?.bossTemplates && rc19.bossTemplates[m.hiddenBossId]),
    `hiddenBossId=${m.hiddenBossId} keys=${Object.keys(rc19?.bossTemplates || {}).join(',')}`);
  ok('roundCfg(19) 用的是隐藏模板键（boss_8/9/10）',
    Object.keys(rc19?.bossTemplates || {}).every((k) => ['boss_8', 'boss_9', 'boss_10'].includes(k)),
    Object.keys(rc19?.bossTemplates || {}).join(','));

  const official15 = m.gd.mode.rounds['15'];
  ok('模板表与官方第 15 回合完全一致',
    JSON.stringify(rc19.bossTemplates) === JSON.stringify(official15.bossTemplates));
  ok('时长与官方第 15 回合一致', rc19.levelMaxPlayTime === official15.levelMaxPlayTime,
    `${rc19.levelMaxPlayTime} vs ${official15.levelMaxPlayTime}`);

  ok('每个战场都有怪（无空战场）', bw19.every((f) => ((f.wave && f.wave.spawns) || []).length > 0),
    `空战场=${bw19.filter((f) => !((f.wave && f.wave.spawns) || []).length).length}`);
  ok('滑块/超时沿用官方隐藏 BOSS 配置', rc19.bossOvertimeAfter === official15.bossOvertimeAfter,
    `${rc19.bossOvertimeAfter} vs ${official15.bossOvertimeAfter}`);

  // endPrep(19) 必须走「隐藏」分支（startFinalAssault(true)）而不是主 BOSS 分支
  let hiddenCall = null;
  const origStart = m.startFinalAssault.bind(m);
  m.startFinalAssault = (hid) => { hiddenCall = hid; return origStart(hid); };
  m.phase = 'PREP';
  m.round = 19;
  m.endPrep();
  ok('endPrep(19) 走隐藏分支 startFinalAssault(true)', hiddenCall === true, `hidden=${hiddenCall}`);
} finally {
  fs.writeFileSync(CUSTOM_RULES_PATH, original);
  resetCustomRules();
  console.log(bad ? `\n=== 失败 ${bad} 项 ===` : '\n=== 全部通过 ===');
  process.exitCode = bad ? 1 : 0;
}
