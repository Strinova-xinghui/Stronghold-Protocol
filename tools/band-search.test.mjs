// 策略搜索 (2026-10-08): bandSearchText / bandMatchesQuery (public/js/ui/bandSearch.js) — the strategy draft's
// search bar matches 策略名 / 效果名 / 描述 / 盟约名, display-only. Zero-DOM module: imported directly.
// 运行：node --test tools/band-search.test.mjs（不碰 custom-rules.json，可与其他测试并行）
import test from 'node:test';
import assert from 'node:assert/strict';
import { bandSearchText, bandMatchesQuery } from '../public/js/ui/bandSearch.js';

// fixtures: a strategy with markup in the description (like the real descRaw) and two bonds
const bondName = (id) => ({ bond_lt: '拉特兰', bond_ag: '阿戈尔' }[id] || id);
const B1 = {
  bandId: 'band_pnn',
  name: '潘格尼尼的抉择',
  effectName: '迅捷锋芒',
  descRaw: '<color #12ffab>所有先锋干员</color>的部署费用降低',
  bondIds: ['bond_lt', 'bond_ag'],
};
const B2 = { bandId: 'band_hfl', name: '华法琳的调养', effectName: '医者仁心', descRaw: '目标生命值每损失 1 点，回复速度提升', bondIds: [] };
const B3 = { bandId: 'band_x', name: '无名策略', effectName: null, descRaw: null, bondIds: null };

const texts = new Map([B1, B2, B3].map((b) => [b.bandId, bandSearchText(b, bondName)]));
const matches = (b, q) => bandMatchesQuery(b, q, texts);

test('空查询匹配所有策略', () => {
  for (const b of [B1, B2, B3]) assert.equal(matches(b, ''), true);
});

test('按策略名匹配（子串）', () => {
  assert.equal(matches(B1, '潘格尼尼'), true);
  assert.equal(matches(B2, '华法琳'), true);
  assert.equal(matches(B3, '潘格尼尼'), false);
});

test('按效果名匹配', () => {
  assert.equal(matches(B1, '迅捷锋芒'), true);
  assert.equal(matches(B2, '迅捷'), false);
});

test('按描述匹配（大小写不敏感，标记被剥掉不参与）', () => {
  assert.equal(matches(B1, '部署费用'), true);
  assert.equal(matches(B1, 'color'), false, 'descRaw 的 <color> 标记被剥离，不作为关键词');
  assert.equal(matches(B1, 'COLOR'), false);
  assert.equal(matches(B2, '回复速度'), true);
});

test('按盟约名匹配（经 bondName 解析，bondId 本身不参与）', () => {
  assert.equal(matches(B1, '拉特兰'), true);
  assert.equal(matches(B1, '阿戈尔'), true);
  assert.equal(matches(B2, '拉特兰'), false, '没有盟约的策略不匹配');
  assert.equal(matches(B1, 'bond_lt'), false, 'bondId 原值被 bondName 解析覆盖（真实解析到名字）');
});

test('查询两侧空白被忽略（与屏幕端 trim().toLowerCase() 一致）', () => {
  assert.equal(matches(B1, '  华法琳  '.trim().toLowerCase()), false);
  assert.equal(matches(B1, '潘格尼尼的抉择'), true);
});

test('缺字段的策略（band_x 形态）不炸、只匹配已有字段', () => {
  assert.equal(matches(B3, '无名'), true);
  assert.equal(matches(B3, '阿戈尔'), false);
});

test('texts 缺失时回退到即时计算（bandMatchesQuery 第三参可省）', () => {
  assert.equal(bandMatchesQuery(B1, '拉特兰'), false, '默认 bondName = id → haystack 里是 bond_lt 原值，不是盟约名');
  assert.equal(bandMatchesQuery({ ...B1, bondIds: ['拉特兰'] }, '拉特兰'), true, 'bondIds 直接存名字时默认解析即中');
});

test('bandSearchText 全小写输出', () => {
  const t = bandSearchText({ bandId: 't', name: 'ABC', effectName: 'DeF', descRaw: 'GHI', bondIds: [] }, bondName);
  assert.equal(t, 'abc def ghi ');
});

test('null/畸形输入不炸', () => {
  assert.equal(bandSearchText(null), '');
  assert.equal(bandMatchesQuery(null, ''), true);
  assert.equal(bandMatchesQuery(null, 'x', texts), false);
});
