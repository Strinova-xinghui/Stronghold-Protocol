// 从 assets.json 采样真实资源路径，对比本地与隧道可达性
import fs from 'node:fs';

const assets = JSON.parse(fs.readFileSync('data/assets.json', 'utf8'));
const samples = [];
const push = (p) => { if (typeof p === 'string' && p.startsWith('/')) samples.push(p); };

// chars: avatar / spine
for (const [cid, rec] of Object.entries(assets.chars || {}).slice(0, 5)) {
  push(rec.avatar);
  if (rec.spine?.front?.skel) push(rec.spine.front.skel);
}
// items / ui / enemies 的常见字段
for (const key of ['items', 'ui', 'enemies', 'tokens', 'bands', 'skills']) {
  const obj = assets[key];
  if (!obj) continue;
  const entries = Array.isArray(obj) ? obj : Object.values(obj);
  for (const e of entries.slice(0, 3)) {
    if (typeof e === 'string') push(e);
    else if (e && typeof e === 'object') { push(e.icon); push(e.avatar); push(e.path); push(e.url); }
  }
}
console.log('采样路径数:', samples.length);
fs.writeFileSync('.cache/sample-paths.json', JSON.stringify(samples, null, 2));
samples.slice(0, 12).forEach((s) => console.log('  ' + s));
