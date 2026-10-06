// 只读：区分「参与变形同构体转职的装备」与普通阵营装备
import { getData } from '../server/data.js';
const d = getData({ quiet: true });

// 维式重锤家族 vs 其他 giveBondId 装备
const ALL = Object.values(d.items || {});
const giveBond = ALL.filter((i) => typeof i.giveBondId === 'string' && i.giveBondId);

console.log('=== 全部 giveBondId 装备，逐件看关键字段 ===');
for (const it of giveBond.sort((a, b) => a.id.localeCompare(b.id))) {
  console.log([
    it.id.padEnd(24),
    String(it.name).padEnd(14),
    'T' + it.tier,
    'bond=' + it.giveBondId.padEnd(14),
    'canGiveBond=' + (it.canGiveBond ? 'Y' : 'n'),
    'cat=' + String(it.category).padEnd(12),
    'kind=' + it.kind,
    'upgradeNum=' + it.upgradeNum,
  ].join(' '));
}

console.log('\n=== category 取值分布 ===');
const cats = {};
for (const it of giveBond) (cats[it.category] ||= []).push(it.name);
for (const [c, list] of Object.entries(cats)) console.log(`${c}: ${list.length} 件 — ${list.slice(0, 6).join(', ')}`);

console.log('\n=== 维式重锤家族的完整字段 ===');
for (const it of giveBond.filter((i) => i.name.includes('维式重锤'))) {
  console.log(JSON.stringify({ id: it.id, name: it.name, tier: it.tier, giveBondId: it.giveBondId, category: it.category, kind: it.kind, mergeable: it.mergeable, desc: it.desc }, null, 0));
}

console.log('\n=== 对照：炎国短刀 ===');
for (const it of giveBond.filter((i) => i.name.includes('炎国短刀'))) {
  console.log(JSON.stringify({ id: it.id, name: it.name, tier: it.tier, giveBondId: it.giveBondId, category: it.category, kind: it.kind, mergeable: it.mergeable, desc: it.desc }, null, 0));
}
