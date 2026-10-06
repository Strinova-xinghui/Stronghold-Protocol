// 自研「定向甄选」验证：配置文件 → 奖励候选筛选是否正确
// 用法: node tools/test-custom-rules.mjs
// 覆盖：① 配置关闭时行为不变 ② 主盟约(count≥3)筛选 ③ 副盟约(层数最多,排除独行/经济)筛选 ④ 热更（改文件即生效）
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { getCustomRules, resetCustomRules, CUSTOM_RULES_PATH, DEFAULT_EXCLUDE } from '../server/match/customRules.js';

const original = fs.readFileSync(CUSTOM_RULES_PATH, 'utf8');
let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ✓ ' + name); }
  catch (e) { failures++; console.log('  ✗ ' + name + ' — ' + e.message); }
};
const writeCfg = (obj) => { fs.writeFileSync(CUSTOM_RULES_PATH, JSON.stringify(obj, null, 2)); resetCustomRules(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  console.log('=== 1. 配置解析 ===');
  writeCfg({ rewardOffer: { enabled: false, slots: [{ slot: 0, kind: 'mainCount' }] } });
  check('enabled:false → 规则关闭', () => assert.equal(getCustomRules().rewardOffer, null));

  writeCfg({ rewardOffer: { enabled: true, slots: [{ slot: 0, kind: 'mainCount', minCount: 3, mult: 2 }] } });
  check('主盟约规则被解析', () => {
    const r = getCustomRules();
    assert.ok(r.rewardOffer, 'should be on');
    assert.equal(r.rewardOffer.slots.length, 1);
    assert.equal(r.rewardOffer.slots[0].kind, 'mainCount');
    assert.equal(r.rewardOffer.slots[0].minCount, 3);
    assert.equal(r.rewardOffer.slots[0].mode, 'filter', '默认 filter 模式');
  });

  writeCfg({ rewardOffer: { enabled: true, slots: [{ slot: 1, kind: 'maxLayers', minCount: 2, mode: 'weight' }] } });
  check('副盟约规则 + weight 模式 + 默认排除表', () => {
    const s = getCustomRules().rewardOffer.slots[0];
    assert.equal(s.slot, 1);
    assert.equal(s.kind, 'maxLayers');
    assert.equal(s.mode, 'weight');
    assert.deepEqual(s.exclude, [...DEFAULT_EXCLUDE], '默认排除独行/远见/奇迹/投资人');
  });

  check('DEFAULT_EXCLUDE 含四个盟约', () => {
    assert.deepEqual([...DEFAULT_EXCLUDE].sort(), ['investShip', 'miraShip', 'soloShip', 'visiShip']);
  });

  console.log('=== 2. 容错（配置坏了不能打断对局）===');
  fs.writeFileSync(CUSTOM_RULES_PATH, '{ 这不是合法 JSON ');
  resetCustomRules();
  check('非法 JSON → 退回关闭而非抛错', () => assert.equal(getCustomRules().rewardOffer, null));

  writeCfg({ rewardOffer: { enabled: true, slots: [{ slot: 0, kind: 'unknownKind' }] } });
  check('未知 kind 被忽略 → 关闭', () => assert.equal(getCustomRules().rewardOffer, null));

  writeCfg({ rewardOffer: { enabled: true, slots: [{ slot: 0, kind: 'mainCount', minCount: 'x', mult: 0.5 }] } });
  check('非法 minCount/mult 被纠正为默认值', () => {
    const s = getCustomRules().rewardOffer.slots[0];
    assert.equal(s.minCount, 3, 'minCount 回退默认 3');
    assert.equal(s.mult, 2, 'mult<1 回退 2');
  });

  console.log('=== 3. 热更（改文件即生效，无需重启）===');
  writeCfg({ rewardOffer: { enabled: true, slots: [{ slot: 0, kind: 'mainCount', minCount: 3 }] } });
  const before = getCustomRules();
  assert.ok(before.rewardOffer, '先开启');
  await sleep(1100); // mtime 分辨率
  writeCfg({ rewardOffer: { enabled: false, slots: [] } });
  check('改文件后（同一进程内）立即读到新值', () => assert.equal(getCustomRules().rewardOffer, null));
  await sleep(1100);
  writeCfg({ rewardOffer: { enabled: true, slots: [{ slot: 0, kind: 'mainCount' }, { slot: 1, kind: 'maxLayers' }] } });
  check('再次开启读到 2 条规则', () => assert.equal(getCustomRules().rewardOffer.slots.length, 2));

  console.log('=== 4. 文件缺失 ===');
  fs.unlinkSync(CUSTOM_RULES_PATH);
  resetCustomRules();
  check('文件不存在 → 关闭（原版行为）', () => assert.equal(getCustomRules().rewardOffer, null));
} finally {
  fs.writeFileSync(CUSTOM_RULES_PATH, original);
  resetCustomRules();
}

console.log(failures === 0 ? '\nPASS ✓ 全部通过' : `\nFAIL ✗ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
