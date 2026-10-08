import fs from 'node:fs';
import { makeMatch } from '../test/match/harness.js';
import { createRegistry } from '../server/match/effectsMeta.js';
import { resetCustomRules, CUSTOM_RULES_PATH } from '../server/match/customRules.js';
const REG = createRegistry({ log: { warn(){}, error(){}, info(){} } });
const original = fs.readFileSync(CUSTOM_RULES_PATH, 'utf8');
const writeCfg = (o) => { fs.writeFileSync(CUSTOM_RULES_PATH, JSON.stringify(o, null, 2)); resetCustomRules(); };
try {
  writeCfg({ extraRounds: { enabled: true, insertAfter: 13, count: 0, templateRound: 13, curve: 'stretchShape' } });
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 14, registry: REG, fake: true });
  h.start();
  const m = h.m;
  console.log('开局 bossRound:', m.gd.bossRound, '| lastRound:', m.gd.lastRound, '| hiddenRound:', m.gd.hiddenRound);
  h.toPrep(14);
  console.log('toPrep(14) 后 m.round:', m.round, '| bossRound:', m.gd.bossRound, '| _erFloor:', m.gd.extraRoundsFloor);
  console.log('isInsertedRound(14):', m.gd.isInsertedRound(14));
} finally { fs.writeFileSync(CUSTOM_RULES_PATH, original); resetCustomRules(); }
