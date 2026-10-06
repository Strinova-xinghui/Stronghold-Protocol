// 只读：列出全部盟约的属性（探究用）
import { getData } from '../server/data.js';
const d = getData({ quiet: true });
console.log('=== 全部盟约 ===');
for (const [id, b] of Object.entries(d.bonds || {})) {
  const core = b.isCore ? 'CORE ' : 'addon';
  const th = JSON.stringify(b.thresholds);
  const mode = b.countMode || 'BOARD';
  const maxc = b.maxCount == null ? '' : ` maxCount=${b.maxCount}`;
  console.log([id.padEnd(14), String(b.name).padEnd(7), core, 'th=' + th, mode + maxc].join('  '));
}
