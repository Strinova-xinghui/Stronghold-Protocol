// 只读：列出「参与变形同构体转职」的全部阵营装备，并标注是否可出现在商店
import { getData } from '../server/data.js';
import { isShopItem } from '../server/sim/simdata.js';

const d = getData({ quiet: true });
const ALL = Object.values(d.items || {});
const bondItems = ALL.filter((i) => typeof i.giveBondId === 'string' && i.giveBondId);

// 按阵营分组，只保留普通版（_e_a，可合成/商店）与金版（_e_b，合成产物）
const byBond = {};
for (const it of bondItems) (byBond[it.giveBondId] ||= []).push(it);

const rows = [];
for (const [bond, list] of Object.entries(byBond).sort()) {
  const brec = d.bonds[bond];
  for (const it of list.sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id))) {
    const shopOk = isShopItem(it);
    rows.push({
      阵营: `${brec?.name || bond}(${bond})`,
      装备: it.name,
      阶: it.tier,
      版本: it.isGolden ? '金' : '普通',
      id: it.id,
      商店可出: shopOk ? '✓' : '✗',
      原因: shopOk ? '' : [it.hideInShop ? 'hideInShop' : '', it.shopExcluded ? 'shopExcluded' : ''].filter(Boolean).join('/') || '非商店装备',
    });
  }
}

console.log('=== 参与变形同构体转职的装备全表（共 ' + rows.length + ' 条记录）===');
for (const r of rows) {
  console.log([r.阵营.padEnd(22), r.装备.padEnd(14), 'T' + r.阶, r.版本.padEnd(3), r.商店可出.padEnd(2), r.id.padEnd(24), r.原因].join(' '));
}

console.log('\n=== 汇总：商店可出的（每阵营）===');
const shopRows = rows.filter((r) => r.商店可出 === '✓' && r.版本 === '普通');
const byFaction = {};
for (const r of shopRows) (byFaction[r.阵营] ||= []).push(`${r.装备}(T${r.阶})`);
for (const [f, list] of Object.entries(byFaction).sort()) console.log(`${f.padEnd(22)} ${list.length} 件: ${list.join(', ')}`);
console.log('商店可出的普通装备总数:', shopRows.length);

console.log('\n=== 商店可出的金版（合成产物，不直接出售）===');
const goldShop = rows.filter((r) => r.商店可出 === '✓' && r.版本 === '金');
console.log('数量:', goldShop.length, goldShop.length ? goldShop.map((r) => r.装备).join(', ') : '(无)');
