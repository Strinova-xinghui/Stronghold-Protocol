// 只读探究：装备的 giveBondId / canGiveBond 分布，以及变形同构体参数
import { getData } from '../server/data.js';
const d = getData({ quiet: true });
const items = Object.values(d.items || {});
console.log('装备总数:', items.length);

console.log('\n=== canGiveBond（变形同构体类）===');
for (const it of items.filter((i) => i.canGiveBond)) {
  console.log(`${it.id}  ${it.name}  tier=${it.tier} upgradeNum=${it.upgradeNum} params=${JSON.stringify(it.params || {})}`);
}

console.log('\n=== 带 giveBondId 的装备（按阵营分组）===');
const byBond = {};
for (const it of items.filter((i) => typeof i.giveBondId === 'string' && i.giveBondId)) {
  (byBond[it.giveBondId] ||= []).push(`${it.name}(T${it.tier}${it.isGolden ? '金' : ''})`);
}
for (const [b, list] of Object.entries(byBond).sort()) {
  const rec = d.bonds[b];
  console.log(`${b.padEnd(14)} ${String(rec?.name).padEnd(6)} ${list.length} 件: ${list.join(', ')}`);
}

console.log('\n=== 商店可出的装备（shopItemsByTier）===');
for (const [t, list] of Object.entries(d.shopItemsByTier || {})) {
  console.log(`T${t}: ${list.length} 件`);
}

console.log('\n=== 装备池 vs 商店池 ===');
console.log('items 里 hideInShop=true 的数量:', items.filter((i) => i.hideInShop).length);
console.log('items 里 shopExcluded=true 的数量:', items.filter((i) => i.shopExcluded).length);
