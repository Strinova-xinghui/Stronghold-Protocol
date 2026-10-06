// 检查皮肤 spine 资源缺失清单（只读）
import fs from 'node:fs';
const research = JSON.parse(fs.readFileSync('docs/research/08-skins.json', 'utf8'));
const missing = [];
for (const [charId, skinList] of Object.entries(research.skins || {})) {
  for (const s of skinList) {
    const stem = s.stem, bs = s.battleSpine;
    if (!bs) continue;
    for (const side of ['front', 'back']) {
      if (!bs[side]) continue;
      for (const ext of ['skel', 'atlas', 'png']) {
        const f = `public/assets/spine/op/${charId}/${stem}/${side}/${stem}.${ext}`;
        if (!fs.existsSync(f)) missing.push({ charId, stem, side, ext });
      }
    }
  }
}
console.log('缺失文件:', missing.length);
const bySkin = new Map();
for (const m of missing) {
  const k = `${m.charId}/${m.stem}`;
  if (!bySkin.has(k)) bySkin.set(k, []);
  bySkin.get(k).push(`${m.side}.${m.ext}`);
}
for (const [k, v] of bySkin) console.log(`  ${k}: ${v.join(', ')}`);
