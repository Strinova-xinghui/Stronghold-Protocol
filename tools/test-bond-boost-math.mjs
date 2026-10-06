// SharedPool.roll 的 bondBoost 权重数学验证（纯 mock，无真实数据依赖）
// 断言: ×M 加成使目标盟约成员的抽中占比 ≈ 基线 × 加成幅度（相对值）
import { SharedPool } from '../server/match/pool.js';

const BONDS = { A1: ['T'], A2: ['T'], A3: ['T'], B1: [], B2: [], B3: [], B4: [], B5: [] };
const gd = { chess: (id) => ({ bonds: BONDS[id] ?? [] }) };

function mockGd() {
  return {
    visibleChess: Object.keys(BONDS),
    poolCopies: () => 10,
    tierOf: () => 1,
    chess: gd.chess,
  };
}

function sample(mult, rolls) {
  const pool = new SharedPool(mockGd(), { banned: [] });
  let seed = 42;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const boost = mult > 1 ? new Map([['T', mult]]) : null;
  let hits = 0;
  for (let i = 0; i < rolls; i++) {
    const id = pool.roll(rng, { bondBoost: boost, gd });
    if (id && id[0] === 'A') hits++;
  }
  return hits / rolls;
}

const R = 50000;
const base = sample(1, R);
const x2 = sample(2, R);
const x4 = sample(4, R);
const p = (x) => (x * 100).toFixed(2) + '%';
// 正确的理论值: A 组 3 名 ×10 份 = 30，B 组 5 名 ×10 = 50。
// ×M 后 A 权重 30M，占比 = 30M/(30M+50): M=2 → 60/110=54.55%，M=4 → 120/170=70.59%
console.log(`基线:   ${p(base)}  (理论 37.50%)`);
console.log(`加成×2: ${p(x2)}  (理论 54.55%)`);
console.log(`加成×4: ${p(x4)}  (理论 70.59%)`);

const d2 = Math.abs(x2 - 60 / 110), d4 = Math.abs(x4 - 120 / 170);
console.log(`偏差: ×2 组 ${(d2 * 100).toFixed(2)}pp, ×4 组 ${(d4 * 100).toFixed(2)}pp (50000 样本，容差 1pp)`);
const ok = d2 < 0.01 && d4 < 0.01;
console.log(ok ? 'PASS ✓ (权重数学正确)' : 'FAIL ✗');
process.exit(ok ? 0 : 1);
